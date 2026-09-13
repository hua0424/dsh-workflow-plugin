/**
 * Issue #29 验收：`turn/end` 失败事实 → 可辨识原因分类。
 *
 * 故障注入口径取自 Host 的真实结构（`TurnEndReasonMap`）：
 * - 额度耗尽：`error` + `LlmFailure.code = QUOTA`（harness 规范码），带 `status`；
 * - 模型 4xx：`error` + `INVALID_REQUEST`/`AUTH`/`RATE_LIMIT`；
 * - 轮次截断：`max-tokens`（step 触顶）与 `interrupted`（崩溃孤儿回合）。
 * 用例同时钉住「正常完成路径零噪音」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withTurnEndFailure, turnEndFailure, type TurnEndFact } from '../src/plugin/turn-end.ts'
import { LIMITS } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'

function ev(seq: number, type: string, data: unknown): TurnEndFact {
  return { type, seq, data }
}

function ending(reason: unknown, turn = 2): { events: TurnEndFact[]; end: TurnEndFact } {
  const events = [
    ev(1, 'turn/start', { turn }),
    ev(2, 'user/message', { id: 'u-dispatch' }),
    ev(3, 'turn/end', { turn, reason }),
  ]
  return { events, end: events[2]! }
}

// ---- 纯函数：失败分类 ----

test('#29 额度耗尽：error.code=QUOTA 与 status 原样进入诊断', () => {
  const { events, end } = ending({ kind: 'error', error: { message: 'insufficient balance', code: 'QUOTA', status: 402 } })
  assert.equal(turnEndFailure(events, end),
    'turn-end reason=error code=QUOTA status=402: insufficient balance | turn=2 tools=none')
})

test('#29 模型 4xx：code 分类保留，与额度/截断互不混淆', () => {
  const { events, end } = ending({ kind: 'error', error: { message: 'model rejected the request', code: 'INVALID_REQUEST', status: 400 } })
  const text = turnEndFailure(events, end)!
  assert.match(text, /reason=error code=INVALID_REQUEST status=400/)
  assert.doesNotMatch(text, /QUOTA|max-tokens|aborted/)
})

test('#29 认证/限流 4xx 同样可辨识，且不带 status 时不伪造', () => {
  const auth = ending({ kind: 'error', error: { message: 'bad key', code: 'AUTH' } })
  assert.equal(turnEndFailure(auth.events, auth.end), 'turn-end reason=error code=AUTH: bad key | turn=2 tools=none')
  const rate = ending({ kind: 'error', error: { message: 'slow down', code: 'RATE_LIMIT', status: 429 } })
  assert.match(turnEndFailure(rate.events, rate.end)!, /code=RATE_LIMIT status=429/)
})

test('#29 轮次截断：max-tokens / interrupted 各自成为一种分类', () => {
  const tokens = ending({ kind: 'max-tokens' })
  assert.equal(turnEndFailure(tokens.events, tokens.end), 'turn-end reason=max-tokens | turn=2 tools=none')
  const crashed = ending({ kind: 'interrupted' })
  assert.equal(turnEndFailure(crashed.events, crashed.end), 'turn-end reason=interrupted | turn=2 tools=none')
})

test('#29 取消来源可辨识：hook 带原因文本，其余只给 kind', () => {
  const hook = ending({ kind: 'aborted', reason: { kind: 'hook', reason: 'goal round limit' } })
  assert.equal(turnEndFailure(hook.events, hook.end), 'turn-end reason=aborted cause=hook: goal round limit | turn=2 tools=none')
  const disposed = ending({ kind: 'aborted', reason: { kind: 'disposed' } })
  assert.match(turnEndFailure(disposed.events, disposed.end)!, /cause=disposed/)
})

test('#29 本回合是否产生过工具调用：只数同一个 turn', () => {
  const { events, end } = ending({ kind: 'error', error: { message: 'boom', code: 'SERVER', status: 500 } })
  const withCall = [events[0]!, events[1]!, ev(3, 'tool/call', { turn: 2, step: 1, callId: 'c1', name: 'read', arguments: '{}' }), end]
  assert.match(turnEndFailure(withCall, end)!, /tools=used/)
  const otherTurn = [ev(0, 'tool/call', { turn: 1, step: 1, callId: 'c0', name: 'read', arguments: '{}' }), ...events]
  assert.match(turnEndFailure(otherTurn, end)!, /tools=none/)
})

// ---- 纯函数：正常路径零噪音 + fail-closed ----

test('#29 正常完成路径不产生诊断（成功 turn 零噪音）', () => {
  const { events, end } = ending({ kind: 'completed' })
  assert.equal(turnEndFailure(events, end), undefined)
})

test('#29 畸形 reason/回合定位失败时 fail-closed，不猜分类', () => {
  const noReason = [ev(1, 'turn/start', { turn: 1 }), ev(2, 'turn/end', { turn: 1 })]
  assert.equal(turnEndFailure(noReason, noReason[1]!), undefined)
  const noTurn = [ev(1, 'turn/end', { reason: { kind: 'error' } })]
  assert.equal(turnEndFailure(noTurn, noTurn[0]!), undefined)
  const notEnd = [ev(1, 'turn/start', { turn: 1 })]
  assert.equal(turnEndFailure(notEnd, notEnd[0]!), undefined)
})

test('#29 未知 kind / error 无结构化失败：仍给分类，但标注事实缺失', () => {
  const future = ending({ kind: 'provider-quirk' })
  assert.equal(turnEndFailure(future.events, future.end), 'turn-end reason=provider-quirk | turn=2 tools=none')
  const bare = ending({ kind: 'error' })
  assert.equal(turnEndFailure(bare.events, bare.end), 'turn-end reason=error (no structured failure) | turn=2 tools=none')
  const malformed = ending({ kind: 'error', error: { code: 'QUOTA' } })
  assert.match(turnEndFailure(malformed.events, malformed.end)!, /no structured failure/)
})

test('#29 诊断拼装：基础原因永远完整，只截诊断（含空诊断）', () => {
  const reason = 'actor-turn-ended-without-result'
  assert.equal(withTurnEndFailure(reason, undefined), reason)
  assert.equal(withTurnEndFailure(reason, ''), reason)
  assert.equal(withTurnEndFailure(reason, 'turn-end reason=max-tokens'),
    'actor-turn-ended-without-result | turn-end reason=max-tokens')
  const long = withTurnEndFailure(reason, 'x'.repeat(5000))
  assert.equal(long.length, LIMITS.blockReasonMax)
  assert.match(long, /^actor-turn-ended-without-result \| /)
})

// ---- 引擎：BLOCK 文本带分类；无失败事实时保持原文 ----

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-turn-end-'))
  const store = new StateStore(home)
  const messages: string[] = []
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { messages.push(text); return { messageId: 'actor-message-1' } },
    async sendRoleActor() { throw new Error('not expected') },
    managerSessionSeq() { return 0 },
  }, {
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge-message-1' } },
    async safeToInspect() { return 'safe' as const },
  }, {}, makeStateHost(store))
  engine.cwdResolver = async () => home
  const config = {
    schemaVersion: 'agent-workflow/v2' as const, roles: {}, judgeRole: { persona: 'Read only' },
    workflow: { startNode: 'plan', nodes: { plan: {
      execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } }, onPass: 'END',
    } } },
  }
  return {
    home, store, engine, messages,
    async start() {
      const run = engine.buildInitialRun('manager', 'test', config, 'hash')
      assert.equal((await engine.startRun('ws', run, undefined, 'root request')).ok, true)
      return { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    },
    async row() { return (await store.get('ws'))! },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('#29 Actor 回合无产出时，BLOCK 原因携带额度耗尽分类且 Manager 通知同文', async () => {
  const h = harness()
  try {
    const actor = await h.start()
    const { events, end } = ending({ kind: 'error', error: { message: 'insufficient balance', code: 'QUOTA', status: 402 } })
    const failure = turnEndFailure(events, end)!
    await h.engine.handleTurnEnded('ws', actor, failure)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.blockReason, `actor-turn-ended-without-result | ${failure}`)
    assert.equal(h.messages.at(-1), `Workflow BLOCK: ${blocked.execution.blockReason}\n材料已保存；Manager 可查看 status 后选择恢复目标。`)
    assert.deepEqual((await h.store.events('ws', blocked.execution.executionId)).map(event => event.type), ['entered', 'actor-arranged', 'blocked'])
  } finally { h.close() }
})

test('#29 无失败事实时（正常结束）BLOCK 原因保持原文，成功路径零噪音', async () => {
  const h = harness()
  try {
    const actor = await h.start()
    // Host 订阅点对正常结束的 turn 取不到诊断（turnEndFailure → undefined）。
    const { events, end } = ending({ kind: 'completed' })
    await h.engine.handleTurnEnded('ws', actor, turnEndFailure(events, end))
    const blocked = await h.row()
    assert.equal(blocked.execution.blockReason, 'actor-turn-ended-without-result')
    assert.doesNotMatch(h.messages.at(-1)!, /turn-end reason=/)
  } finally { h.close() }
})

// ---- #24 O1：判定侧（Judge）无产出同样透传底层失败分类 ----

/** 把该节点的手工行推到「已 claim、Judge 已派发待判定」状态。 */
async function driveToJudge(h: ReturnType<typeof harness>) {
  const row = (await h.store.get('ws'))!
  const e = row.execution
  e.phase = 'checking'
  e.claim = { id: 'claim-1', dispatchId: e.dispatch!.id, outcome: 'completed', handoff: 'Actor handoff' }
  e.judge = { id: 'judge-1', sessionId: 'judge', messageId: 'judge-message-1', settled: false, claimId: 'claim-1', inputVersion: e.inputVersion }
  await h.store.updateRow('ws', row.run, row.stateVersion, [
    { execution: e, expectedRevision: row.execution.revision, events: ['claim'] },
  ])
  return { sessionId: 'judge', turnUserMessageIds: new Set(['judge-message-1']) }
}

test('#24 O1 判定回合无产出时，BLOCK 原因携带 Judge 侧额度耗尽分类且 Manager 通知同文', async () => {
  const h = harness()
  try {
    await h.start()
    const judge = await driveToJudge(h)
    const { events, end } = ending({ kind: 'error', error: { message: 'insufficient balance', code: 'QUOTA', status: 402 } })
    const failure = turnEndFailure(events, end)!
    await h.engine.handleTurnEnded('ws', judge, failure)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.blockReason, `judge turn ended without judge_claim | ${failure}`)
    assert.match(blocked.execution.blockReason, /code=QUOTA status=402/)
    assert.equal(h.messages.at(-1), `Workflow BLOCK: ${blocked.execution.blockReason}\n材料已保存；Manager 可查看 status 后选择恢复目标。`)
  } finally { h.close() }
})

test('#24 O1 判定回合正常结束（无失败事实）时，Judge BLOCK 原因保持原文', async () => {
  const h = harness()
  try {
    await h.start()
    const judge = await driveToJudge(h)
    const { events, end } = ending({ kind: 'completed' })
    await h.engine.handleTurnEnded('ws', judge, turnEndFailure(events, end))
    const blocked = await h.row()
    assert.equal(blocked.execution.blockReason, 'judge turn ended without judge_claim')
    assert.doesNotMatch(h.messages.at(-1)!, /turn-end reason=/)
  } finally { h.close() }
})
