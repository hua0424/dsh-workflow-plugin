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

test('rapid-multi 直接路径：实现、批准、合并后才返回 delivered', async () => {
  const h = harness()
  try {
    await implement(h)
    const approved = await h.step('review', 'approved')
    assert.equal(approved.execution.nodeId, 'merge')
    assert.match(approved.execution.dispatch?.sessionId ?? '', /^coordinator-/)
    assert.equal(approved.run.status, 'running')
    assert.equal(approved.run.businessReturn, undefined)
    const delivered = await h.step('merge', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid-multi 条件验证：审查要求独立 tester 时，通过验证才进入合并', async () => {
  const h = harness()
  try {
    await implement(h)
    const testing = await h.step('review', 'verification-required')
    assert.equal(testing.execution.nodeId, 'verify')
    assert.match(testing.execution.dispatch?.sessionId ?? '', /^tester-/)
    assert.equal(testing.run.businessReturn, undefined)
    const passed = await h.step('verify', 'passed')
    assert.equal(passed.execution.nodeId, 'merge')
    assert.equal(passed.run.businessReturn, undefined)
    const delivered = await h.step('merge', 'delivered')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid-multi 发布后需要验收时回到 verify，通过后返回 merge 完成收尾', async () => {
  const h = harness()
  try {
    await implement(h)
    await h.step('review', 'approved')
    // 本测试只覆盖回边；真实发布事实与 verificationStage 由 Actor/Judge 核验。
    const testing = await h.step('merge', 'verification-required')
    assert.equal(testing.execution.nodeId, 'verify')
    assert.match(testing.execution.dispatch?.sessionId ?? '', /^tester-/)
    assert.equal(testing.run.status, 'running')
    assert.equal(testing.run.businessReturn, undefined)
    const passed = await h.step('verify', 'passed')
    assert.equal(passed.execution.nodeId, 'merge')
    assert.equal(passed.run.businessReturn, undefined)
    const delivered = await h.step('merge', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid-multi 审查或验证必修项均返回实现，重新批准与验证后交付', async () => {
  const h = harness()
  try {
    await implement(h)
    const reviewRework = await h.step('review', 'changes-required')
    assert.equal(reviewRework.execution.nodeId, 'implement')
    assert.equal(reviewRework.run.businessReturn, undefined)
    await h.step('implement', 'implemented')
    await h.step('review', 'verification-required')
    const testRework = await h.step('verify', 'changes-required')
    assert.equal(testRework.execution.nodeId, 'implement')
    assert.equal(testRework.run.businessReturn, undefined)
    await h.step('implement', 'implemented')
    await h.step('review', 'verification-required')
    await h.step('verify', 'passed')
    const delivered = await h.step('merge', 'delivered')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

for (const node of ['review', 'verify', 'merge'] as const) {
  test(`rapid-multi ${node} 漂移必须返回实现重组候选，重新审查后才交付`, async () => {
    const h = harness()
    try {
      await implement(h)
      if (node === 'verify') await h.step('review', 'verification-required')
      if (node === 'merge') await h.step('review', 'approved')
      const before = await h.row()
      // 只验证结果路由；实际漂移、部分合并及候选树由 Actor/Judge 按合同核验。
      const stale = await h.step(node, 'stale-review')
      assert.equal(stale.execution.nodeId, 'implement')
      assert.notEqual(stale.execution.executionId, before.execution.executionId)
      assert.notEqual(stale.execution.nodeToken, before.execution.nodeToken)
      assert.equal(stale.run.status, 'running')
      assert.equal(stale.run.businessReturn, undefined)
      await h.step('implement', 'implemented')
      await h.step('review', 'verification-required')
      await h.step('verify', 'passed')
      const delivered = await h.step('merge', 'delivered')
      assert.equal(delivered.run.businessReturn?.name, 'delivered')
    } finally { h.close() }
  })
}

test('rapid-multi 非法结果与 Judge REJECT 不能绕过验证；合并拒绝留在 merge 重试', async () => {
  const h = harness()
  try {
    await implement(h)
    const reviewing = await h.row()
    const invalidReview = await h.engine.handleClaim('ws', { result: 'delivered', handoff: '不能绕过验证与合并' }, h.caller(reviewing.execution.dispatch!))
    assert.equal(invalidReview.ok, false)
    const reviewRejected = await h.step('review', 'verification-required', 'REJECT')
    assert.equal(reviewRejected.execution.nodeId, 'review')
    assert.equal(reviewRejected.execution.successorId, undefined)
    await h.step('review', 'verification-required')
    const testing = await h.row()
    const invalidTest = await h.engine.handleClaim('ws', { result: 'approved', handoff: 'tester 不能替代审查或宣布交付' }, h.caller(testing.execution.dispatch!))
    assert.equal(invalidTest.ok, false)
    const testRejected = await h.step('verify', 'passed', 'REJECT')
    assert.equal(testRejected.execution.nodeId, 'verify')
    assert.equal(testRejected.execution.successorId, undefined)
    assert.equal(testRejected.run.businessReturn, undefined)
    await h.step('verify', 'passed')
    const mergeRejected = await h.step('merge', 'delivered', 'REJECT')
    assert.equal(mergeRejected.execution.nodeId, 'merge')
    assert.equal(mergeRejected.execution.successorId, undefined)
    assert.equal(mergeRejected.run.status, 'running')
    assert.equal(mergeRejected.run.businessReturn, undefined)
    const delivered = await h.step('merge', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})
