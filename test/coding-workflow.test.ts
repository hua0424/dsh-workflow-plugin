/** #129：真实 v3 配置 + Engine + 临时 SQLite，模型判定受控；不运行真实 git/gh。 */
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

const source = () => readFileSync(new URL('../docs/example/coding-workflow.yaml', import.meta.url), 'utf8')

function harness() {
  const config = validateAndNormalize(parseCatalogConfig(source()), { workflowId: 'coding-workflow' })
  const home = mkdtempSync(join(tmpdir(), 'coding-workflow-'))
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
  }, { async run() { throw new Error('配置不应包含 Program') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  const row = async () => (await store.get('ws'))!
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({
    sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]),
  })
  return {
    engine, row, caller,
    async start() {
      const result = await engine.startRun('ws', engine.buildInitialRun('manager', 'coding-workflow', config, 'test-config'), undefined, '受控迁移验收')
      assert.equal(result.ok, true)
    },
    async step(workflowId: string, nodeId: string, result: string, judgment: 'ACCEPT' | 'REJECT' = 'ACCEPT') {
      const current = await row()
      assert.equal(current.execution.workflowId, workflowId)
      assert.equal(current.execution.nodeId, nodeId)
      const actor = caller(current.execution.dispatch!)
      const claimed = await engine.handleClaim('ws', { result, handoff: `${workflowId}/${nodeId}: 受控证据` }, actor)
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
async function plan(h: Harness) {
  await h.start()
  await h.step('coding-workflow', 'grilling', 'ready')
  await h.step('coding-workflow', 'need-tickets', 'planned')
}
async function deliverIssue(h: Harness, rework = false) {
  await h.step('issue-cycle', 'select-next-issue', 'selected')
  await h.step('issue-delivery', 'implement', 'implemented')
  await h.step('issue-delivery', 'review', 'reviewed')
  if (rework) {
    await h.step('issue-delivery', 'decide-pr', 'changes-required')
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'reviewed')
  }
  await h.step('issue-delivery', 'decide-pr', 'approved')
  const row = await h.step('issue-delivery', 'complete-issue', 'delivered')
  assert.equal(row.execution.workflowId, 'issue-cycle')
  assert.equal(row.execution.nodeId, 'select-next-issue', '单票返回不得提前结束整个流程')
}
async function integrate(h: Harness) {
  const row = await h.step('issue-cycle', 'select-next-issue', 'exhausted')
  assert.equal(row.execution.nodeId, 'integrate-milestone', '无下一票仍须父流程集成验收')
  assert.equal(row.run.status, 'running', '主 Issue 尚待集成验收时不可宣布交付')
  await h.step('coding-workflow', 'integrate-milestone', 'prepared')
  await h.step('coding-workflow', 'final-review', 'reviewed')
}

for (const [name, count, rework] of [['简单单票', 1, false], ['多票与父集成验收', 3, false], ['单票返工', 1, true]] as const) {
  test(`#129 ${name}：叶任务结束后仍经过独立集成批准`, async () => {
    const h = harness()
    try {
      await plan(h)
      for (let i = 0; i < count; i++) await deliverIssue(h, rework)
      await integrate(h)
      await h.step('coding-workflow', 'decide-pr', 'approved')
      const row = await h.step('coding-workflow', 'close-milestone', 'delivered')
      assert.equal(row.run.status, 'completed')
      assert.equal(row.run.businessReturn?.name, 'delivered')
    } finally { h.close() }
  })
}

test('#129 集成返工：补票重新进入循环，重新审查批准才交付', async () => {
  const h = harness()
  try {
    await plan(h)
    await deliverIssue(h)
    await integrate(h)
    await h.step('coding-workflow', 'decide-pr', 'changes-required')
    await h.step('coding-workflow', 'plan-remediation', 'planned')
    await deliverIssue(h)
    await integrate(h)
    await h.step('coding-workflow', 'decide-pr', 'approved')
    const row = await h.step('coding-workflow', 'close-milestone', 'delivered')
    assert.equal(row.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('#129 用户取消有独立终局，不伪装成交付', async () => {
  const h = harness()
  try {
    await h.start()
    const row = await h.step('coding-workflow', 'grilling', 'cancelled')
    assert.equal(row.run.status, 'completed')
    assert.equal(row.run.businessReturn?.name, 'cancelled')
  } finally { h.close() }
})

test('#129 无下一票仍进入集成；未知结果和 Judge REJECT 不能绕过批准', async () => {
  const h = harness()
  try {
    await plan(h)
    await integrate(h)
    const before = await h.row()
    const invalid = await h.engine.handleClaim('ws', { result: 'skipped', handoff: '单票无需批准' }, h.caller(before.execution.dispatch!))
    assert.equal(invalid.ok, false)
    assert.equal((await h.row()).execution.executionId, before.execution.executionId)
    const rejected = await h.step('coding-workflow', 'decide-pr', 'approved', 'REJECT')
    assert.equal(rejected.execution.nodeId, 'decide-pr')
    assert.equal(rejected.execution.successorId, undefined)
    assert.equal(rejected.run.businessReturn, undefined)
    await h.step('coding-workflow', 'decide-pr', 'approved')
    assert.equal((await h.row()).execution.nodeId, 'close-milestone')
  } finally { h.close() }
})

test('#129 配置拒绝旧协议及不完整 Child 返回映射', () => {
  assert.throws(() => parseCatalogConfig(source().replace('agent-workflow/v3', 'agent-workflow/v2')))
  // 新协议不能因混入旧默认通过边而产生第二条隐含路线。
  assert.throws(() => parseCatalogConfig(source().replace('    grilling:', '    grilling:\n      onPass: need-tickets')))
  assert.throws(() => validateAndNormalize(parseCatalogConfig(source().replace(/onReturn:\s*\n\s*exhausted:/, 'onReturn:\n        undeclared:'))))
})
