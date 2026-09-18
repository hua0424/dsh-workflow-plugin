/**
 * Issue #22：角色模型热更新对既有 Judge 会话的生效语义。
 *
 * 实测事故（run 753b9cb2）：`workflow_set_role_model` 覆盖 Judge 模型后，
 * `node_resume` 仍复用绑定旧路由的 Judge 会话再次失败，必须显式
 * `judge_respawn` 才生效。选定行为：resume 在偏好 followup 前比对会话创建
 * 时的绑定路由快照（`ExecutionJudge.model`），已过期则自动走 fresh（释放旧
 * 会话 + 新路由 spawn），与 Role Actor“覆盖即删映射”一致。
 *
 * 真实 Engine + 临时 SQLite + 受控 Host（与 runtime-work-order.test.ts 的
 * recoveryHarness 同 seam，本文件只取 NEED_CONTEXT→resume 所需最小面）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'

const CONFIG = {
  schemaVersion: 'agent-workflow/v3' as const, roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: { plan: {
    execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
    checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
    results: { succeeded: { criteria: 'The plan is complete.', target: { return: 'done' } } },
  } } },
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-judge-model-'))
  const store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judgeStarts: string[] = []
  const judgeFollowups: string[] = []
  const drains: string[] = []
  const send = (sessionId: string, _text: string) => {
    const messageId = `judge-model-message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text: 'Judge' })
    return { messageId }
  }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) { return { childId: 'worker-session', ...send('worker-session', text) } },
    async startJudge(_run, input) { judgeStarts.push(input.judgeSessionId); return { judgeSessionId: input.judgeSessionId, ...send(input.judgeSessionId, 'Judge') } },
    async followupJudge(_run, judgeSessionId, input) { judgeFollowups.push(judgeSessionId); return send(judgeSessionId, input.claim.handoff) },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {},
    async drainJudge(_run, judgeSessionId) { drains.push(judgeSessionId) },
    async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' as const },
  }, { async run() { throw new Error('no programs') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  engine.actorActivity = async () => 'unknown'
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    home, judgeStarts, judgeFollowups, drains, caller,
    get engine() { return engine },
    get store() { return store },
    async row() { return (await store.get('ws'))! },
    async start() { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', CONFIG, 'hash'), undefined, 'root request') },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

/** 走到 NEED_CONTEXT BLOCK：claim → turn-end（spawn Judge）→ Judge NEED_CONTEXT。 */
async function blockNeedContext(h: ReturnType<typeof harness>) {
  await h.start()
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'claim awaiting context' }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  const checking = await h.row()
  assert.equal(checking.execution.phase, 'checking')
  const oldJudge = structuredClone(checking.execution.judge)!
  // 新建 Judge 会话记录创建时的绑定路由（此处无 override，即 Run 冻结值）。
  assert.deepEqual(oldJudge.model, (await h.row()).run.delegationRoute ?? {})
  assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'NEED_CONTEXT', '旧模型额度耗尽，需要Manager处理', h.caller(oldJudge))).ok, true)
  assert.equal((await h.row()).run.status, 'blocked')
  return oldJudge
}

test('#22：Judge 模型热更新后 resume 自动走 fresh，不再复用绑定旧路由的会话', async () => {
  const h = harness()
  try {
    const oldJudge = await blockNeedContext(h)
    const blocked = await h.row()
    // 旧模型额度耗尽 → 热更新为新模型（BLOCK 态允许 judge override）。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'new-provider', 'new-model', 'manager')).ok, true)
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '已换新模型，重判。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.equal(resumed.execution.resolution?.judgeMode, 'fresh')
    assert.notEqual(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.deepEqual(resumed.execution.judge?.model, { provider: 'new-provider', modelId: 'new-model' })
    // 旧会话已释放，且没有 followup 派发（事故里的"再次派发失败"不再发生）。
    assert.deepEqual(h.drains, [oldJudge.sessionId])
    assert.equal(h.judgeFollowups.length, 0)
    assert.equal(h.judgeStarts.length, 2)
    // claim 与 Judge 反馈保留在新 Judge 材料上。
    assert.equal(resumed.execution.claim?.handoff, 'claim awaiting context')
    assert.equal(resumed.execution.previousJudge?.sessionId, oldJudge.sessionId)
    // 新 Judge 可照常判定。
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', '新模型核验通过', h.caller(resumed.execution.judge!))).ok, true)
    assert.equal((await h.row()).run.status, 'completed')
  } finally { h.close() }
})

test('#22 对照：无模型变更时 resume 仍 followup 复用原 Judge 会话', async () => {
  const h = harness()
  try {
    const oldJudge = await blockNeedContext(h)
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '补充事实已核实，续接原Judge。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.resolution?.judgeMode, 'followup')
    assert.equal(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.equal(h.judgeFollowups.length, 1)
    assert.equal(h.judgeStarts.length, 1)
    assert.deepEqual(h.drains, [], 'followup 不释放原会话')
  } finally { h.close() }
})
