/** 轻量单任务：真实配置、Engine 与临时 SQLite；结果受控，不运行模型、git 或 gh。 */
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

const workflowId = 'coding-workflow-rapid'

function harness() {
  const source = readFileSync(new URL('../docs/example/coding-workflow-rapid.yaml', import.meta.url), 'utf8')
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
  }, { async run() { throw new Error('轻量配置不应包含 Program') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  const row = async () => (await store.get('ws'))!
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({
    sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]),
  })
  return {
    engine, row, caller,
    async start() {
      const result = await engine.startRun('ws', engine.buildInitialRun('manager', workflowId, config, 'test-config'), undefined, '受控轻量流程验收')
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
  await h.step('initialize', 'ready')
  await h.step('implement', 'implemented')
}

test('rapid 单 Issue：必须实现、审查批准、合并后才返回 delivered', async () => {
  const h = harness()
  try {
    await implement(h)
    const approved = await h.step('review', 'approved')
    assert.equal(approved.execution.nodeId, 'merge')
    assert.equal(approved.run.status, 'running')
    assert.equal(approved.run.businessReturn, undefined)
    const completed = await h.step('merge', 'delivered')
    assert.equal(completed.run.status, 'completed')
    assert.equal(completed.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid 必修项返回实现，重新审查批准后才能合并', async () => {
  const h = harness()
  try {
    await implement(h)
    const rework = await h.step('review', 'changes-required')
    assert.equal(rework.execution.nodeId, 'implement')
    assert.equal(rework.run.businessReturn, undefined)
    await h.step('implement', 'implemented')
    await h.step('review', 'approved')
    const completed = await h.step('merge', 'delivered')
    assert.equal(completed.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid 批准修订漂移：stale-review 回审查，补查可返工，必须重新批准', async () => {
  const h = harness()
  try {
    await implement(h)
    await h.step('review', 'approved')
    const stale = await h.step('merge', 'stale-review')
    assert.equal(stale.execution.nodeId, 'review')
    assert.equal(stale.run.status, 'running')
    assert.equal(stale.run.businessReturn, undefined)
    // 受控结果仅验证路由；base/head 是否漂移由真实 Actor/Judge 按合同判断。
    await h.step('review', 'changes-required')
    await h.step('implement', 'implemented')
    await h.step('review', 'approved')
    await h.step('merge', 'stale-review')
    await h.step('review', 'approved')
    const completed = await h.step('merge', 'delivered')
    assert.equal(completed.run.status, 'completed')
    assert.equal(completed.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('rapid 未声明结果与 Judge REJECT 均不能绕过批准或提前结束', async () => {
  const h = harness()
  try {
    await implement(h)
    const before = await h.row()
    const invalid = await h.engine.handleClaim('ws', { result: 'delivered', handoff: '试图绕过合并' }, h.caller(before.execution.dispatch!))
    assert.equal(invalid.ok, false)
    assert.equal((await h.row()).execution.executionId, before.execution.executionId)
    const rejectedReview = await h.step('review', 'approved', 'REJECT')
    assert.equal(rejectedReview.execution.nodeId, 'review')
    assert.equal(rejectedReview.execution.successorId, undefined)
    assert.equal(rejectedReview.run.businessReturn, undefined)
    await h.step('review', 'approved')
    const rejectedMerge = await h.step('merge', 'delivered', 'REJECT')
    assert.equal(rejectedMerge.execution.nodeId, 'merge')
    assert.equal(rejectedMerge.run.status, 'running')
    assert.equal(rejectedMerge.execution.successorId, undefined)
    assert.equal(rejectedMerge.run.businessReturn, undefined)
    const completed = await h.step('merge', 'delivered')
    assert.equal(completed.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})
