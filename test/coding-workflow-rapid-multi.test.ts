/** 多仓单 Issue：真实配置、Engine 与临时 SQLite；只验证受控路由，不运行模型、git、gh 或部署。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { checkExecutionInvariants } from '../src/state/invariants.ts'

const workflowId = 'coding-workflow-rapid-multi'

function harness() {
  const source = readFileSync(new URL('../docs/example/coding-workflow-rapid-multi.yaml', import.meta.url), 'utf8')
  const config = validateAndNormalize(parseCatalogConfig(source), { workflowId })
  const home = mkdtempSync(join(tmpdir(), `${workflowId}-`))
  const store = new StateStore(home)
  let serial = 0
  const send = () => ({ messageId: `message-${++serial}` })
  const engine = new WorkflowEngine({
    async steerManager() { return send() },
    async sendRoleActor() { return send() },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, role) { return { ...send(), childId: `${role}-${serial}` } },
    async startJudge(_run, input) { return { ...send(), judgeSessionId: input.judgeSessionId } },
    async followupJudge() { return send() },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async safeToInspect() { return 'safe' as const },
    async retireJudge() {},
    async drainJudge() {},
    async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
  }, { async run() { throw new Error('敏捷多仓配置不应包含 Program') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  const row = async () => (await store.get('ws'))!
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({
    sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]),
  })
  return {
    engine, row, caller,
    async start() {
      const result = await engine.startRun('ws', engine.buildInitialRun('manager', workflowId, config, 'test-config'), undefined, '受控多仓单 Issue 路由验收')
      assert.equal(result.ok, true)
    },
    async step(nodeId: string, result: string, judgment: 'ACCEPT' | 'REJECT' = 'ACCEPT') {
      const current = await row()
      assert.equal(current.execution.workflowId, workflowId)
      assert.equal(current.execution.nodeId, nodeId)
      const actor = caller(current.execution.dispatch!)
      const claimed = await engine.handleClaim('ws', { result, handoff: `${nodeId}: 受控证据` }, actor)
      assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.reason)
      await engine.handleTurnEnded('ws', actor)
      const pending = await row()
      const judge = caller(pending.execution.judge!)
      const judged = await engine.handleJudgeClaim('ws', pending.execution.nodeToken, judgment, '受控判定', judge)
      assert.equal(judged.ok, true)
      await engine.handleTurnEnded('ws', judge)
      const next = await row()
      assert.deepEqual(checkExecutionInvariants(next.run, next.execution), [])
      return next
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

type Harness = ReturnType<typeof harness>
async function implement(h: Harness) {
  await h.start()
  assert.equal((await h.row()).execution.dispatch?.sessionId, 'manager')
  await h.step('initialize', 'ready')
  await h.step('implement', 'implemented')
}

test('rapid-multi 主链：审查、合并、集成验证通过后才返回 delivered', async () => {
  const h = harness()
  try {
    await implement(h)
    const approved = await h.step('review', 'approved')
    assert.equal(approved.execution.nodeId, 'merge')
    assert.match(approved.execution.dispatch?.sessionId ?? '', /^coordinator-/)
    assert.equal(approved.run.businessReturn, undefined)
    const merged = await h.step('merge', 'merged')
    assert.equal(merged.execution.nodeId, 'verify')
    assert.match(merged.execution.dispatch?.sessionId ?? '', /^tester-/)
    assert.equal(merged.run.status, 'running')
    assert.equal(merged.run.businessReturn, undefined)
    const delivered = await h.step('verify', 'passed')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid-multi 审查与合并后集成测试返工均重新经过实现、审查、合并、验证', async () => {
  const h = harness()
  try {
    await implement(h)
    const reviewRework = await h.step('review', 'changes-required')
    assert.equal(reviewRework.execution.nodeId, 'implement')
    assert.equal(reviewRework.run.businessReturn, undefined)
    const firstImplement = reviewRework.execution
    await h.step('implement', 'implemented')
    await h.step('review', 'approved')
    await h.step('merge', 'merged')
    // 受控路由不执行 Git；新修复 PR 和完整版本组合由 Actor/Judge 按合同核验。
    const testRework = await h.step('verify', 'changes-required')
    assert.equal(testRework.execution.nodeId, 'implement')
    assert.notEqual(testRework.execution.executionId, firstImplement.executionId)
    assert.notEqual(testRework.execution.nodeToken, firstImplement.nodeToken)
    assert.equal(testRework.run.status, 'running')
    assert.equal(testRework.run.businessReturn, undefined)
    await h.step('implement', 'implemented')
    await h.step('review', 'approved')
    await h.step('merge', 'merged')
    const delivered = await h.step('verify', 'passed')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

for (const node of ['review', 'merge'] as const) {
  test(`rapid-multi ${node} 候选失效或合并冲突返回实现，重审重合并后才能验收`, async () => {
    const h = harness()
    try {
      await implement(h)
      if (node === 'merge') await h.step('review', 'approved')
      const before = await h.row()
      // 只验证结果路由；实际冲突、部分合并与版本事实由 Actor/Judge 按合同核验。
      const stale = await h.step(node, 'stale-review')
      assert.equal(stale.execution.nodeId, 'implement')
      assert.notEqual(stale.execution.executionId, before.execution.executionId)
      assert.notEqual(stale.execution.nodeToken, before.execution.nodeToken)
      assert.equal(stale.run.status, 'running')
      assert.equal(stale.run.businessReturn, undefined)
      await h.step('implement', 'implemented')
      await h.step('review', 'approved')
      await h.step('merge', 'merged')
      const delivered = await h.step('verify', 'passed')
      assert.equal(delivered.run.businessReturn?.name, 'delivered')
    } finally { h.close() }
  })
}

test('rapid-multi 旧验证出口与 merge.delivered 均非法，不能跳过合并后集成测试', async () => {
  const h = harness()
  try {
    await implement(h)
    for (const [node, invalidResults, validResult] of [
      ['review', ['verification-required', 'delivered'], 'approved'],
      ['merge', ['verification-required', 'delivered'], 'merged'],
      ['verify', ['stale-review', 'approved'], 'passed'],
    ] as const) {
      for (const result of invalidResults) {
        const before = await h.row()
        assert.equal(before.execution.nodeId, node)
        const invalid = await h.engine.handleClaim('ws', { result, handoff: '旧出口或其他节点结果不可使用' }, h.caller(before.execution.dispatch!))
        assert.equal(invalid.ok, false)
        const after = await h.row()
        assert.equal(after.execution.executionId, before.execution.executionId)
        assert.equal(after.execution.claim, undefined)
        assert.equal(after.run.businessReturn, undefined)
      }
      await h.step(node, validResult)
    }
    assert.equal((await h.row()).run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid-multi Judge REJECT 留在当前节点，不能跳过审查、合并或集成验收', async () => {
  const h = harness()
  try {
    await implement(h)
    for (const [node, result] of [['review', 'approved'], ['merge', 'merged'], ['verify', 'passed']] as const) {
      const rejected = await h.step(node, result, 'REJECT')
      assert.equal(rejected.execution.nodeId, node)
      assert.equal(rejected.execution.successorId, undefined)
      assert.equal(rejected.run.status, 'running')
      assert.equal(rejected.run.businessReturn, undefined)
      await h.step(node, result)
    }
    const delivered = await h.row()
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})
