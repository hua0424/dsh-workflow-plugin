/** 真实 v3 配置 + Engine + 临时 SQLite，仅验证受控路由；不运行真实 git/gh、测试器或跨仓合并。 */
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

type WorkflowFile = 'coding-workflow' | 'coding-workflow-single'
const source = (file: WorkflowFile = 'coding-workflow') => readFileSync(new URL(`../docs/example/${file}.yaml`, import.meta.url), 'utf8')

function harness(file: WorkflowFile = 'coding-workflow') {
  const config = validateAndNormalize(parseCatalogConfig(source(file)), { workflowId: file })
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
    engine, row, caller, rootWorkflowId: file,
    async start() {
      const result = await engine.startRun('ws', engine.buildInitialRun('manager', file, config, 'test-config'), undefined, '受控迁移验收')
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
  const initial = await h.row()
  assert.equal(initial.execution.dispatch?.sessionId, 'manager')
  const ready = await h.step(h.rootWorkflowId, 'initialize-and-plan', 'ready')
  assert.equal(ready.execution.workflowId, 'issue-cycle')
  assert.equal(ready.execution.nodeId, 'select-next-issue', '初始化并规划完成后直接选票')
}
async function deliverIssue(h: Harness, rework = false) {
  await h.step('issue-cycle', 'select-next-issue', 'selected')
  await h.step('issue-delivery', 'implement', 'implemented')
  if (rework) {
    await h.step('issue-delivery', 'review', 'changes-required')
    await h.step('issue-delivery', 'implement', 'implemented')
  }
  await h.step('issue-delivery', 'review', 'approved')
  const row = await h.step('issue-delivery', 'complete-issue', 'code-integrated')
  assert.equal(row.execution.workflowId, 'issue-cycle')
  assert.equal(row.execution.nodeId, 'select-next-issue', '单票返回不得提前结束整个流程')
  assert.equal(row.run.status, 'running')
  assert.equal(row.run.businessReturn, undefined, 'code-integrated 不是整个 Milestone 的交付终局')
}

async function verifyAndPublishIntegration(h: Harness) {
  const approved = await h.step(h.rootWorkflowId, 'final-review', 'approved')
  assert.equal(approved.execution.nodeId, 'verify-integration')
  assert.match(approved.execution.dispatch?.sessionId ?? '', /^tester-/)
  const verified = await h.step(h.rootWorkflowId, 'verify-integration', 'passed')
  assert.equal(verified.execution.nodeId, 'publish-integration')
  assert.equal(verified.run.businessReturn, undefined)
  const published = await h.step(h.rootWorkflowId, 'publish-integration', 'published')
  assert.equal(published.execution.nodeId, 'close-milestone')
  assert.equal(published.run.status, 'running')
  assert.equal(published.run.businessReturn, undefined, '发布成功仍须完成远端收尾')
}
async function integrate(h: Harness) {
  const single = h.rootWorkflowId === 'coding-workflow-single'
  const row = await h.step('issue-cycle', 'select-next-issue', single ? 'integration-ready' : 'code-complete')
  assert.equal(row.execution.workflowId, h.rootWorkflowId)
  assert.equal(row.execution.nodeId, single ? 'final-review' : 'prepare-integration', '无下一票仍须父流程准备与集成验收')
  assert.equal(row.run.status, 'running', '主 Issue 尚待集成验收时不可宣布交付')
  if (!single) {
    const prepared = await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready')
    assert.equal(prepared.execution.nodeId, 'final-review')
    assert.equal(prepared.run.businessReturn, undefined)
  }
}

for (const [name, count, rework] of [['简单单票', 1, false], ['多票与父集成验收', 3, false], ['单票返工', 1, true]] as const) {
  test(`#129 ${name}：叶任务结束后仍经过独立集成批准`, async () => {
    const h = harness()
    try {
      await plan(h)
      for (let i = 0; i < count; i++) await deliverIssue(h, rework)
      await integrate(h)
      await verifyAndPublishIntegration(h)
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
    await h.step('coding-workflow', 'final-review', 'changes-required')
    await h.step('coding-workflow', 'plan-remediation', 'planned')
    await deliverIssue(h)
    await integrate(h)
    await verifyAndPublishIntegration(h)
    const row = await h.step('coding-workflow', 'close-milestone', 'delivered')
    assert.equal(row.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('单票批准失效可多次重审，并可转入同票返工，不提前返回父流程', async () => {
  const h = harness()
  try {
    await plan(h)
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    for (let i = 0; i < 2; i++) {
      const approved = await h.step('issue-delivery', 'review', 'approved')
      const stale = await h.step('issue-delivery', 'complete-issue', 'stale-review')
      assert.equal(stale.execution.workflowId, 'issue-delivery')
      assert.equal(stale.execution.nodeId, 'review')
      assert.notEqual(stale.execution.executionId, approved.execution.executionId)
      assert.notEqual(stale.execution.nodeToken, approved.execution.nodeToken)
      assert.equal(stale.run.status, 'running')
      assert.equal(stale.run.businessReturn, undefined)
    }
    await h.step('issue-delivery', 'review', 'changes-required')
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'approved')
    const delivered = await h.step('issue-delivery', 'complete-issue', 'code-integrated')
    assert.equal(delivered.execution.workflowId, 'issue-cycle')
    assert.equal(delivered.execution.nodeId, 'select-next-issue')
    await integrate(h)
    await verifyAndPublishIntegration(h)
    const row = await h.step('coding-workflow', 'close-milestone', 'delivered')
    assert.equal(row.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('发布前批准失效可多次重新准备，发现问题后补票重入并重新批准', async () => {
  const h = harness()
  try {
    await plan(h)
    await deliverIssue(h)
    await integrate(h)
    for (let i = 0; i < 2; i++) {
      await h.step('coding-workflow', 'final-review', 'approved')
      await h.step('coding-workflow', 'verify-integration', 'passed')
      const approved = await h.row()
      const stale = await h.step('coding-workflow', 'publish-integration', 'stale-review')
      assert.equal(stale.execution.workflowId, 'coding-workflow')
      assert.equal(stale.execution.nodeId, 'prepare-integration')
      assert.notEqual(stale.execution.executionId, approved.execution.executionId)
      assert.notEqual(stale.execution.nodeToken, approved.execution.nodeToken)
      assert.equal(stale.run.status, 'running')
      assert.equal(stale.run.businessReturn, undefined)
      await h.step('coding-workflow', 'prepare-integration', 'integration-ready')
    }
    await h.step('coding-workflow', 'final-review', 'changes-required')
    await h.step('coding-workflow', 'plan-remediation', 'planned')
    await deliverIssue(h)
    await integrate(h)
    await verifyAndPublishIntegration(h)
    const row = await h.step('coding-workflow', 'close-milestone', 'delivered')
    assert.equal(row.run.status, 'completed')
    assert.equal(row.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('单票按需独立验证：测试失败回实现，修订漂移回审查，通过后才允许集成代码', async () => {
  const h = harness()
  try {
    await plan(h)
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    const testing = await h.step('issue-delivery', 'review', 'verification-required')
    assert.equal(testing.execution.nodeId, 'verify-issue')
    assert.match(testing.execution.dispatch?.sessionId ?? '', /^tester-/)
    const failed = await h.step('issue-delivery', 'verify-issue', 'changes-required')
    assert.equal(failed.execution.nodeId, 'implement')
    assert.equal(failed.run.businessReturn, undefined)
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'verification-required')
    const stale = await h.step('issue-delivery', 'verify-issue', 'stale-review')
    assert.equal(stale.execution.workflowId, 'issue-delivery')
    assert.equal(stale.execution.nodeId, 'review')
    await h.step('issue-delivery', 'review', 'verification-required')
    const passed = await h.step('issue-delivery', 'verify-issue', 'passed')
    assert.equal(passed.execution.nodeId, 'complete-issue')
    assert.equal(passed.run.businessReturn, undefined)
    const legacyResult = await h.engine.handleClaim('ws', { result: 'delivered', handoff: '代码集成不代表最终交付' }, h.caller(passed.execution.dispatch!))
    assert.equal(legacyResult.ok, false)
    const integrated = await h.step('issue-delivery', 'complete-issue', 'code-integrated')
    assert.equal(integrated.execution.workflowId, 'issue-cycle')
    assert.equal(integrated.execution.nodeId, 'select-next-issue')
    assert.equal(integrated.run.status, 'running')
    assert.equal(integrated.run.businessReturn, undefined)
    await integrate(h)
    await verifyAndPublishIntegration(h)
    const delivered = await h.step('coding-workflow', 'close-milestone', 'delivered')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('集成验证：测试失败补修复票，版本漂移回准备，再经审查与验证才发布', async () => {
  const h = harness()
  try {
    await plan(h)
    await deliverIssue(h)
    await integrate(h)
    await h.step('coding-workflow', 'final-review', 'approved')
    const failed = await h.step('coding-workflow', 'verify-integration', 'changes-required')
    assert.equal(failed.execution.nodeId, 'plan-remediation')
    assert.equal(failed.run.businessReturn, undefined)
    await h.step('coding-workflow', 'plan-remediation', 'planned')
    await deliverIssue(h)
    await integrate(h)
    await h.step('coding-workflow', 'final-review', 'approved')
    const stale = await h.step('coding-workflow', 'verify-integration', 'stale-review')
    assert.equal(stale.execution.workflowId, 'coding-workflow')
    assert.equal(stale.execution.nodeId, 'prepare-integration')
    assert.equal(stale.run.businessReturn, undefined)
    await h.step('coding-workflow', 'prepare-integration', 'integration-ready')
    await verifyAndPublishIntegration(h)
    const delivered = await h.step('coding-workflow', 'close-milestone', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('代码完成只进入集成准备；旧 work-remaining 出口被拒绝，审查漂移重新准备', async () => {
  const h = harness()
  try {
    await plan(h)
    const selecting = await h.row()
    const legacy = await h.engine.handleClaim('ws', { result: 'integration-ready', handoff: '选票不能代替集成准备' }, h.caller(selecting.execution.dispatch!))
    assert.equal(legacy.ok, false)
    const preparing = await h.step('issue-cycle', 'select-next-issue', 'code-complete')
    assert.equal(preparing.execution.workflowId, h.rootWorkflowId)
    assert.equal(preparing.execution.nodeId, 'prepare-integration')
    assert.match(preparing.execution.dispatch?.sessionId ?? '', /^coordinator-/)
    assert.equal(preparing.run.businessReturn, undefined)
    const rejected = await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready', 'REJECT')
    assert.equal(rejected.execution.nodeId, 'prepare-integration')
    assert.equal(rejected.execution.successorId, undefined)
    const obsolete = await h.engine.handleClaim('ws', { result: 'work-remaining', handoff: '集成准备不再重新选票' }, h.caller(rejected.execution.dispatch!))
    assert.equal(obsolete.ok, false)
    const unchanged = await h.row()
    assert.equal(unchanged.execution.executionId, rejected.execution.executionId)
    assert.equal(unchanged.execution.nodeId, 'prepare-integration')
    assert.equal(unchanged.execution.successorId, undefined)
    assert.equal(unchanged.run.businessReturn, undefined)
    await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready')
    const stale = await h.step(h.rootWorkflowId, 'final-review', 'stale-review')
    assert.equal(stale.execution.nodeId, 'prepare-integration')
    assert.equal(stale.run.businessReturn, undefined)
    await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready')
    await verifyAndPublishIntegration(h)
    const delivered = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('published 不是 delivered；发布拒绝不进收尾，收尾拒绝留在收尾且不能重新发布', async () => {
  const h = harness()
  try {
    await plan(h)
    await integrate(h)
    await h.step(h.rootWorkflowId, 'final-review', 'approved')
    const verified = await h.step(h.rootWorkflowId, 'verify-integration', 'passed')
    assert.equal(verified.execution.nodeId, 'publish-integration')
    assert.match(verified.execution.dispatch?.sessionId ?? '', /^coordinator-/)
    const premature = await h.engine.handleClaim('ws', { result: 'delivered', handoff: '发布节点不能宣布终局' }, h.caller(verified.execution.dispatch!))
    assert.equal(premature.ok, false)
    const rejected = await h.step(h.rootWorkflowId, 'publish-integration', 'published', 'REJECT')
    assert.equal(rejected.execution.nodeId, 'publish-integration')
    assert.equal(rejected.execution.successorId, undefined)
    assert.equal(rejected.run.businessReturn, undefined)
    const published = await h.step(h.rootWorkflowId, 'publish-integration', 'published')
    assert.equal(published.execution.nodeId, 'close-milestone')
    assert.equal(published.run.status, 'running')
    assert.equal(published.run.businessReturn, undefined)
    const republish = await h.engine.handleClaim('ws', { result: 'stale-review', handoff: '收尾不能通过旧出口重复发布' }, h.caller(published.execution.dispatch!))
    assert.equal(republish.ok, false)
    const closeRejected = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered', 'REJECT')
    assert.equal(closeRejected.execution.nodeId, 'close-milestone')
    assert.equal(closeRejected.execution.successorId, undefined)
    assert.equal(closeRejected.run.status, 'running')
    assert.equal(closeRejected.run.businessReturn, undefined)
    const delivered = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('single 单票与集成审查通过后完整交付', async () => {
  const h = harness('coding-workflow-single')
  try {
    await plan(h)
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'approved')
    const issue = await h.step('issue-delivery', 'complete-issue', 'delivered')
    assert.equal(issue.execution.workflowId, 'issue-cycle')
    assert.equal(issue.execution.nodeId, 'select-next-issue')
    assert.equal(issue.run.businessReturn, undefined)
    await integrate(h)
    const approved = await h.step(h.rootWorkflowId, 'final-review', 'approved')
    assert.equal(approved.execution.nodeId, 'close-milestone')
    const delivered = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('single 两级合并均拒绝旧 stale-review 出口，执行与派发保持不变', async () => {
  const h = harness('coding-workflow-single')
  const rejectOldResult = async () => {
    const before = await h.row()
    const invalid = await h.engine.handleClaim('ws', { result: 'stale-review', handoff: '受控提交旧结果，不模拟真实合并异常' }, h.caller(before.execution.dispatch!))
    assert.equal(invalid.ok, false)
    const unchanged = await h.row()
    assert.deepEqual(unchanged.execution, before.execution)
    assert.equal(unchanged.execution.successorId, undefined)
    assert.equal(unchanged.run.status, 'running')
    assert.equal(unchanged.run.businessReturn, undefined)
    assert.deepEqual(checkExecutionInvariants(unchanged.run, unchanged.execution), [])
  }
  try {
    await plan(h)
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    const approvedIssue = await h.step('issue-delivery', 'review', 'approved')
    assert.equal(approvedIssue.execution.nodeId, 'complete-issue')
    await rejectOldResult()
    await h.step('issue-delivery', 'complete-issue', 'delivered')
    await integrate(h)
    const approvedIntegration = await h.step(h.rootWorkflowId, 'final-review', 'approved')
    assert.equal(approvedIntegration.execution.nodeId, 'close-milestone')
    await rejectOldResult()
    const delivered = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('single 单票返工和集成补票均重新进入实现与审查，不能提前交付', async () => {
  const h = harness('coding-workflow-single')
  try {
    await plan(h)
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    const rework = await h.step('issue-delivery', 'review', 'changes-required')
    assert.equal(rework.execution.nodeId, 'implement')
    assert.equal(rework.run.businessReturn, undefined)
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'approved')
    await h.step('issue-delivery', 'complete-issue', 'delivered')
    await integrate(h)
    const remediation = await h.step(h.rootWorkflowId, 'final-review', 'changes-required')
    assert.equal(remediation.execution.nodeId, 'plan-remediation')
    assert.equal(remediation.run.businessReturn, undefined)
    const planned = await h.step(h.rootWorkflowId, 'plan-remediation', 'planned')
    assert.equal(planned.execution.workflowId, 'issue-cycle')
    assert.equal(planned.execution.nodeId, 'select-next-issue')
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'approved')
    const repaired = await h.step('issue-delivery', 'complete-issue', 'delivered')
    assert.equal(repaired.execution.nodeId, 'select-next-issue')
    assert.equal(repaired.run.businessReturn, undefined)
    await integrate(h)
    await h.step(h.rootWorkflowId, 'final-review', 'approved')
    const delivered = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
    assert.equal(delivered.run.status, 'completed')
    assert.equal(delivered.run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

test('single 用户取消保留独立 cancelled 终局', async () => {
  const h = harness('coding-workflow-single')
  try {
    await h.start()
    const cancelled = await h.step(h.rootWorkflowId, 'initialize-and-plan', 'cancelled')
    assert.equal(cancelled.run.status, 'completed')
    assert.equal(cancelled.run.businessReturn?.name, 'cancelled')
  } finally { h.close() }
})

test('初始化的旧 planned 结果和 Judge REJECT 都不能跳过规划验收', async () => {
  const h = harness()
  try {
    await h.start()
    const before = await h.row()
    assert.equal(before.execution.nodeId, 'initialize-and-plan')
    assert.equal(before.execution.dispatch?.sessionId, 'manager')
    const invalid = await h.engine.handleClaim('ws', { result: 'planned', handoff: '旧拆票节点结果' }, h.caller(before.execution.dispatch!))
    assert.equal(invalid.ok, false)
    const unchanged = await h.row()
    assert.equal(unchanged.execution.executionId, before.execution.executionId)
    assert.equal(unchanged.execution.successorId, undefined)
    const rejected = await h.step('coding-workflow', 'initialize-and-plan', 'ready', 'REJECT')
    assert.equal(rejected.execution.workflowId, 'coding-workflow')
    assert.equal(rejected.execution.nodeId, 'initialize-and-plan')
    assert.equal(rejected.execution.successorId, undefined)
    assert.equal(rejected.run.businessReturn, undefined)
    const accepted = await h.step('coding-workflow', 'initialize-and-plan', 'ready')
    assert.equal(accepted.execution.workflowId, 'issue-cycle')
    assert.equal(accepted.execution.nodeId, 'select-next-issue')
  } finally { h.close() }
})

test('#129 用户取消有独立终局，不伪装成交付', async () => {
  const h = harness()
  try {
    await h.start()
    const row = await h.step('coding-workflow', 'initialize-and-plan', 'cancelled')
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
    const rejected = await h.step('coding-workflow', 'final-review', 'approved', 'REJECT')
    assert.equal(rejected.execution.nodeId, 'final-review')
    assert.equal(rejected.execution.successorId, undefined)
    assert.equal(rejected.run.businessReturn, undefined)
    await h.step('coding-workflow', 'final-review', 'approved')
    assert.equal((await h.row()).execution.nodeId, 'verify-integration')
    const testRejected = await h.step('coding-workflow', 'verify-integration', 'passed', 'REJECT')
    assert.equal(testRejected.execution.nodeId, 'verify-integration')
    assert.equal(testRejected.execution.successorId, undefined)
    assert.equal(testRejected.run.businessReturn, undefined)
    await h.step('coding-workflow', 'verify-integration', 'passed')
    assert.equal((await h.row()).execution.nodeId, 'publish-integration')
  } finally { h.close() }
})

test('#129 配置拒绝旧协议及不完整 Child 返回映射', () => {
  assert.throws(() => parseCatalogConfig(source().replace('agent-workflow/v3', 'agent-workflow/v2')))
  // 新协议不能因混入旧默认通过边而产生第二条隐含路线。
  assert.throws(() => parseCatalogConfig(source().replace('    initialize-and-plan:', '    initialize-and-plan:\n      onPass: run-issue-cycle')))
  assert.throws(() => validateAndNormalize(parseCatalogConfig(source().replace(/onReturn:\s*\n\s*code-complete:/, 'onReturn:\n        undeclared:'))))
})
