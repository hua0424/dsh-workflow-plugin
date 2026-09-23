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
  const approved = await h.step('issue-delivery', 'review', 'approved')
  assert.equal(approved.execution.nodeId, 'merge-issue')
  const merged = await h.step('issue-delivery', 'merge-issue', 'merged')
  assert.equal(merged.execution.nodeId, 'verify-issue')
  assert.match(merged.execution.dispatch?.sessionId ?? '', /^tester-/)
  assert.equal(merged.run.businessReturn, undefined)
  const verified = await h.step('issue-delivery', 'verify-issue', 'passed')
  assert.equal(verified.execution.workflowId, 'issue-cycle')
  assert.equal(verified.execution.nodeId, 'select-next-issue', '单票验收完成后才允许选下一票')
  assert.equal(verified.run.status, 'running')
  assert.equal(verified.run.businessReturn, undefined, '单票完成不是整个 Milestone 的交付终局')
}

async function verifyAndMergeIntegration(h: Harness) {
  const approved = await h.step(h.rootWorkflowId, 'final-review', 'approved')
  assert.equal(approved.execution.nodeId, 'verify-integration')
  assert.match(approved.execution.dispatch?.sessionId ?? '', /^tester-/)
  const verified = await h.step(h.rootWorkflowId, 'verify-integration', 'passed')
  assert.equal(verified.execution.nodeId, 'merge-integration')
  assert.equal(verified.run.businessReturn, undefined)
  const merged = await h.step(h.rootWorkflowId, 'merge-integration', 'merged')
  assert.equal(merged.execution.nodeId, 'close-milestone')
  assert.equal(merged.run.status, 'running')
  assert.equal(merged.run.businessReturn, undefined, '基线合并成功仍须完成远端收尾')
}
async function integrate(h: Harness) {
  const single = h.rootWorkflowId === 'coding-workflow-single'
  const row = await h.step('issue-cycle', 'select-next-issue', single ? 'integration-ready' : 'issues-complete')
  assert.equal(row.execution.workflowId, h.rootWorkflowId)
  assert.equal(row.execution.nodeId, single ? 'final-review' : 'prepare-integration')
  assert.equal(row.run.status, 'running', '主 Issue 尚待整体验收时不可宣布交付')
  if (!single) {
    const prepared = await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready')
    assert.equal(prepared.execution.nodeId, 'final-review')
    assert.equal(prepared.run.businessReturn, undefined)
  }
}

for (const [name, count, rework] of [['两票完整交付', 2, false], ['审查返工', 1, true]] as const) {
  test(`多仓 ${name}：逐票合并并验证，再经整体审查验证合入基线`, async () => {
    const h = harness()
    try {
      await plan(h)
      for (let i = 0; i < count; i++) await deliverIssue(h, rework)
      await integrate(h)
      await verifyAndMergeIntegration(h)
      const row = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
      assert.equal(row.run.status, 'completed')
      assert.equal(row.run.businessReturn?.name, 'delivered')
    } finally { h.close() }
  })
}

test('单票合并后集成测试失败留在当前票，新修复轮不能提前选下一票', async () => {
  const h = harness()
  try {
    await plan(h)
    const firstImplement = await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'approved')
    await h.step('issue-delivery', 'merge-issue', 'merged')
    const failed = await h.step('issue-delivery', 'verify-issue', 'changes-required')
    assert.equal(failed.execution.workflowId, 'issue-delivery')
    assert.equal(failed.execution.nodeId, 'implement')
    assert.notEqual(failed.execution.executionId, firstImplement.execution.executionId)
    assert.notEqual(failed.execution.nodeToken, firstImplement.execution.nodeToken)
    assert.equal(failed.run.businessReturn, undefined)
    await h.step('issue-delivery', 'implement', 'implemented')
    await h.step('issue-delivery', 'review', 'approved')
    await h.step('issue-delivery', 'merge-issue', 'merged')
    const verified = await h.step('issue-delivery', 'verify-issue', 'passed')
    assert.equal(verified.execution.workflowId, 'issue-cycle')
    assert.equal(verified.execution.nodeId, 'select-next-issue')
    await integrate(h)
    await verifyAndMergeIntegration(h)
    assert.equal((await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')).run.businessReturn?.name, 'delivered')
  } finally { h.close() }
})

for (const node of ['review', 'merge-issue'] as const) {
  test(`单票 ${node} 候选失效回实现重组，再次审查合并并测试`, async () => {
    const h = harness()
    try {
      await plan(h)
      await h.step('issue-cycle', 'select-next-issue', 'selected')
      await h.step('issue-delivery', 'implement', 'implemented')
      if (node === 'merge-issue') await h.step('issue-delivery', 'review', 'approved')
      const stale = await h.step('issue-delivery', node, 'stale-review')
      assert.equal(stale.execution.nodeId, 'implement')
      assert.equal(stale.run.businessReturn, undefined)
      await h.step('issue-delivery', 'implement', 'implemented')
      await h.step('issue-delivery', 'review', 'approved')
      await h.step('issue-delivery', 'merge-issue', 'merged')
      assert.equal((await h.step('issue-delivery', 'verify-issue', 'passed')).execution.nodeId, 'select-next-issue')
    } finally { h.close() }
  })
}

for (const node of ['prepare-integration', 'final-review', 'verify-integration'] as const) {
  test(`整体 ${node} 发现问题：规划 Bug 票重入循环，再次整体验收后合入基线`, async () => {
    const h = harness()
    try {
      await plan(h)
      await deliverIssue(h)
      await h.step('issue-cycle', 'select-next-issue', 'issues-complete')
      if (node !== 'prepare-integration') await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready')
      if (node === 'verify-integration') await h.step(h.rootWorkflowId, 'final-review', 'approved')
      const failed = await h.step(h.rootWorkflowId, node, 'changes-required')
      assert.equal(failed.execution.nodeId, 'plan-remediation')
      assert.equal(failed.run.businessReturn, undefined)
      const planned = await h.step(h.rootWorkflowId, 'plan-remediation', 'planned')
      assert.equal(planned.execution.workflowId, 'issue-cycle')
      assert.equal(planned.execution.nodeId, 'select-next-issue')
      // 实际新建 Bug 及已完成票状态由 Actor/Judge 核验；此处仅检查重新入循环。
      await deliverIssue(h)
      await integrate(h)
      await verifyAndMergeIntegration(h)
      const delivered = await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')
      assert.equal(delivered.run.status, 'completed')
      assert.equal(delivered.run.businessReturn?.name, 'delivered')
    } finally { h.close() }
  })
}

for (const node of ['final-review', 'verify-integration', 'merge-integration'] as const) {
  test(`整体 ${node} 批准失效重新准备，不跳过整体验证`, async () => {
    const h = harness()
    try {
      await plan(h)
      await integrate(h)
      if (node !== 'final-review') await h.step(h.rootWorkflowId, 'final-review', 'approved')
      if (node === 'merge-integration') await h.step(h.rootWorkflowId, 'verify-integration', 'passed')
      const stale = await h.step(h.rootWorkflowId, node, 'stale-review')
      assert.equal(stale.execution.nodeId, 'prepare-integration')
      assert.equal(stale.run.businessReturn, undefined)
      await h.step(h.rootWorkflowId, 'prepare-integration', 'integration-ready')
      await verifyAndMergeIntegration(h)
      assert.equal((await h.step(h.rootWorkflowId, 'close-milestone', 'delivered')).run.businessReturn?.name, 'delivered')
    } finally { h.close() }
  })
}

test('旧跳过出口均拒绝，Judge REJECT 不能推进单票或整体流程', async () => {
  const h = harness()
  const reject = async (results: string[]) => {
    const before = await h.row()
    for (const result of results) {
      const invalid = await h.engine.handleClaim('ws', { result, handoff: '旧结果不能绕过验收' }, h.caller(before.execution.dispatch!))
      assert.equal(invalid.ok, false)
      assert.deepEqual((await h.row()).execution, before.execution)
    }
    assert.equal((await h.row()).run.businessReturn, undefined)
  }
  const acceptAfterRejection = async (workflow: string, node: string, result: string) => {
    const rejected = await h.step(workflow, node, result, 'REJECT')
    assert.equal(rejected.execution.nodeId, node)
    assert.equal(rejected.execution.successorId, undefined)
    assert.equal(rejected.run.businessReturn, undefined)
    await h.step(workflow, node, result)
  }
  try {
    await plan(h)
    await reject(['code-complete', 'integration-ready'])
    await h.step('issue-cycle', 'select-next-issue', 'selected')
    await h.step('issue-delivery', 'implement', 'implemented')
    await reject(['verification-required'])
    await acceptAfterRejection('issue-delivery', 'review', 'approved')
    await reject(['code-integrated', 'delivered'])
    await acceptAfterRejection('issue-delivery', 'merge-issue', 'merged')
    await reject(['stale-review', 'delivered'])
    await acceptAfterRejection('issue-delivery', 'verify-issue', 'passed')
    await integrate(h)
    await acceptAfterRejection(h.rootWorkflowId, 'final-review', 'approved')
    await acceptAfterRejection(h.rootWorkflowId, 'verify-integration', 'passed')
    await reject(['published', 'verification-required', 'delivered'])
    await acceptAfterRejection(h.rootWorkflowId, 'merge-integration', 'merged')
    await reject(['stale-review'])
    await acceptAfterRejection(h.rootWorkflowId, 'close-milestone', 'delivered')
    assert.equal((await h.row()).run.businessReturn?.name, 'delivered')
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

test('多仓配置拒绝旧协议及两层不完整 Child 返回映射', () => {
  assert.throws(() => parseCatalogConfig(source().replace('agent-workflow/v3', 'agent-workflow/v2')))
  assert.throws(() => parseCatalogConfig(source().replace('    initialize-and-plan:', '    initialize-and-plan:\n      onPass: run-issue-cycle')))
  for (const result of ['issues-complete', 'issue-completed']) {
    const changed = source().replace(new RegExp(String.raw`onReturn:\s*\n\s*${result}:`), 'onReturn:\n        undeclared:')
    assert.notEqual(changed, source(), `必须实际替换 ${result} 映射`)
    assert.throws(() => validateAndNormalize(parseCatalogConfig(changed)))
  }
})

test('多仓关键合同：验收才关票、整体失败新 Bug、禁止生产操作', () => {
  const config = parseCatalogConfig(source())
  const delivery = config.childWorkflows!['issue-delivery']!
  assert.match(delivery.nodes['verify-issue']!.results!.passed!.criteria, /验收通过[\s\S]*当前票已关闭/)
  assert.match(delivery.nodes['verify-issue']!.results!['changes-required']!.criteria, /当前票仍开放[\s\S]*新 PR/)
  assert.match(config.workflow.nodes['plan-remediation']!.results!.planned!.criteria, /新 Bug[\s\S]*关闭原票未被重开或追加/)
  assert.match(config.actorCommonPersona!, /禁止生产部署、生产配置和生产数据操作/)
  assert.equal(config.workflow.nodes['verify-publication'], undefined)
})
