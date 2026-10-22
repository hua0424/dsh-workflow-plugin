// #212 补充覆盖：已提交实现（eb7f699）的正/反/Manager 路径见
// test/runtime-store-safety.test.ts（tokenless 两组）与 test/tools.test.ts
// （nodeToken 省略透传）；本文件只补四处未覆盖边界：
// ① tokenless BLOCK 后 Manager resume 照常轮换 token 并重派发；
// ② 已 BLOCK 的 Run 不再接受第二次 tokenless BLOCK；
// ③ Manager 无 token 在 Role 节点上被拒（不削弱代次隔离）。
// ④ 已 settled dispatch 的无 token BLOCK 被拒（session 血统命中亦拒绝）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimCaller, WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3', roles: {}, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: {
    plan: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
      results: { succeeded: { criteria: 'The plan is complete.', target: { node: 'review' } } },
    },
    review: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Review' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct review' } },
      results: { succeeded: { criteria: 'The review is complete.', target: { return: 'done' } } },
    },
  } } }

// 与 runtime-store-safety.test.ts fixture(true) 同构的最小 harness：
// plan(manager) → review(reviewer)，Role 重派发走 sendRoleActor（映射已存在时）。
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-212-'))
  const store = new StateStore(home)
  let message = 0
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: `actor-message-${++message}` } },
    async sendRoleActor(run, role) { return { messageId: `actor-message-${++message}`, childId: run.roleActors[role]! } },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, role) { return { childId: `role-${role}`, messageId: `actor-message-${++message}` } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge-message-1' } },
    async followupJudge() { return { messageId: `judge-followup-${++message}` } },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' },
  }, { async run() { throw new Error('unexpected Program') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  return { home, store, engine, cleanup() { store.close(); rmSync(home, { recursive: true, force: true }) } }
}

/** 前进到 review（reviewer）节点的 working 派发，返回当时的行与调用方。 */
async function atReviewer(h: ReturnType<typeof harness>) {
  const definition = structuredClone(config)
  definition.roles = { reviewer: { persona: 'Review' } }
  definition.workflow.nodes.review!.execution = { type: 'actor-task', role: 'reviewer', instruction: 'Review' }
  await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', definition, 'ignored'), undefined, 'root request')
  const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
  assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'plan artifact' }, manager)).ok, true)
  await h.engine.handleTurnEnded('ws', manager)
  let row = (await h.store.get('ws'))!
  const planJudge: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', planJudge)).ok, true)
  await h.engine.handleTurnEnded('ws', planJudge)
  row = (await h.store.get('ws'))!
  assert.equal(row.execution.phase, 'working')
  assert.equal(row.execution.dispatch?.sessionId, 'role-reviewer')
  const reviewer: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
  return { row, reviewer }
}

test('#212 tokenless BLOCK 后 Manager resume 照常轮换 token 并重派发', async () => {
  const h = harness()
  try {
    const { row, reviewer } = await atReviewer(h)
    const oldToken = row.execution.nodeToken
    const oldMessage = row.execution.dispatch!.messageId
    assert.equal((await h.engine.handleBlock('ws', undefined, '等授权', reviewer)).ok, true)
    const blocked = (await h.store.get('ws'))!
    assert.equal(blocked.run.status, 'blocked')
    const resumed = await h.engine.handleResume('ws', blocked.execution.nodeToken, '授权已到位，继续执行', 'manager', 'actor')
    assert.equal(resumed.ok, true)
    const after = (await h.store.get('ws'))!
    assert.equal(after.run.status, 'running')
    assert.equal(after.execution.phase, 'working')
    assert.notEqual(after.execution.nodeToken, oldToken)
    // 同一 worker 会话的新派发：旧 lease（旧 messageId）作废。
    assert.equal(after.execution.dispatch?.sessionId, 'role-reviewer')
    assert.notEqual(after.execution.dispatch?.messageId, oldMessage)
  } finally { h.cleanup() }
})

test('#212 已 BLOCK 的 Run 不再接受第二次 tokenless BLOCK', async () => {
  const h = harness()
  try {
    const { reviewer } = await atReviewer(h)
    assert.equal((await h.engine.handleBlock('ws', undefined, '首次阻塞', reviewer)).ok, true)
    const blocked = (await h.store.get('ws'))!
    // 同一 Actor 再次无 token BLOCK：Run 已非 running → 拒绝，原原因保留。
    assert.equal((await h.engine.handleBlock('ws', undefined, '再次阻塞', reviewer)).ok, false)
    const row = (await h.store.get('ws'))!
    assert.equal(row.run.status, 'blocked')
    assert.equal(row.execution.blockReason, '首次阻塞')
    assert.deepEqual(row, blocked)
  } finally { h.cleanup() }
})

test('#212 已 settled dispatch 的无 token BLOCK 被拒且零写入', async () => {
  const h = harness()
  try {
    const { row } = await atReviewer(h)
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.claim, undefined)
    // 注入已 settled：working 期 + 无 pending claim 保持不变，仅 settled 翻转；
    // caller 经 sessionUserMessageIds 血统命中 matches（turn 集为空），
    // 仅靠 engine.ts gate 的 `e.dispatch?.settled` 项拒绝。
    const settledExec = structuredClone(row.execution)
    settledExec.dispatch!.settled = true
    const base = (await h.store.get('ws'))!
    await h.store.updateRow('ws', structuredClone(base.run), base.stateVersion, [{ execution: settledExec, expectedRevision: settledExec.revision, events: [] }])
    const injected = (await h.store.get('ws'))!
    assert.equal(injected.execution.phase, 'working')
    assert.equal(injected.execution.claim, undefined)
    assert.equal(injected.execution.dispatch?.settled, true)
    const viaSessionLineage: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set<string>(), sessionUserMessageIds: new Set([injected.execution.dispatch!.messageId!]) }
    assert.equal((await h.engine.handleBlock('ws', undefined, 'settled 后阻塞', viaSessionLineage)).ok, false)
    assert.deepEqual(await h.store.get('ws'), injected, '拒绝路径不产生任何状态写入')
  } finally { h.cleanup() }
})

test('#212 Manager 无 token 在 Role 节点上被拒（不削弱代次隔离）', async () => {
  const h = harness()
  try {
    await atReviewer(h)
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    assert.equal((await h.engine.handleBlock('ws', undefined, 'Manager 越权阻塞', manager)).ok, false)
    const row = (await h.store.get('ws'))!
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.blockReason, null)
  } finally { h.cleanup() }
})
