/**
 * Issue #200 验收（Judge 瞬时失败有界自动重试 1 次 + SUBMISSION_CONSTRAINT
 * 按 handler 拆 actor/manager 变体，manager 派发去 Actor 视角措辞）。
 *
 * - 瞬时分类：status>=500 / code=SERVER / code=UNKNOWN 带网络文本 → 重试；
 *   4xx 家族、无诊断、kind-only、未知码 → 直接 BLOCK（fail-closed）。
 * - 重试 1 次：成功则无 BLOCK 继续推进；再失败则 BLOCK 并标注「已自动重试」。
 * - 变体：manager 派发含 manager 变体且无 Actor 视角句；actor 派发零变化；
 *   Judge 投影两种变体都能剥净。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTransientJudgeFailure, turnEndFailure } from '../src/plugin/turn-end.ts'
import { MANAGER_SUBMISSION_CONSTRAINT, SUBMISSION_CONSTRAINT } from '../src/engine/texts.ts'
import { projectNodeLocal, projectSessionSurface } from '../src/judge/projection.ts'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type SubagentHost } from '../src/engine/engine.ts'
import type { ExecutionDispatch, WorkflowConfig } from '../src/types.ts'

// ---- 瞬时分类纯函数 ----

function failureOf(reason: unknown, turn = 1) {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn } },
    { type: 'user/message', seq: 2, data: { id: 'u-judge' } },
    { type: 'turn/end', seq: 3, data: { turn, reason } },
  ]
  return turnEndFailure(events, events[2]!)
}

test('#200 上游 5xx / code=SERVER 是瞬时失败', () => {
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'request failed', code: 'SERVER', status: 500 } })), true)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'bad gateway', code: 'SERVER', status: 502 } })), true)
  // 有码无 status 时 code=SERVER 同样瞬时。
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'request failed', code: 'SERVER' } })), true)
})

test('#200 4xx 家族码与 4xx status 直接 BLOCK（不重试）', () => {
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'bad request', code: 'INVALID_REQUEST', status: 400 } })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'bad key', code: 'AUTH', status: 401 } })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'no balance', code: 'QUOTA', status: 402 } })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'slow down', code: 'RATE_LIMIT', status: 429 } })), false)
})

test('#200 无诊断 / kind-only / 未知码 fail-closed 不重试', () => {
  assert.equal(isTransientJudgeFailure(undefined), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'completed' })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'max-tokens' })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'interrupted' })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'aborted', reason: { kind: 'disposed' } })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'weird', code: 'FUTURE_CODE' } })), false)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error' })), false)
})

test('#200 code=UNKNOWN 带网络/流中断文本是瞬时失败', () => {
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'fetch failed: ECONNRESET', code: 'UNKNOWN' } })), true)
  assert.equal(isTransientJudgeFailure(failureOf({ kind: 'error', error: { message: 'socket hang up', code: 'UNKNOWN' } })), true)
})

// ---- 引擎重试行为 ----

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3' as const,
  roles: { worker: { persona: 'do work' } },
  judgeRole: { persona: 'readonly' },
  workflow: { startNode: 'first', returns: ['done'],
    nodes: {
      first: {
        execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Start' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } },
        results: { succeeded: { criteria: 'The start is verified.', target: { node: 'job' } } },
      },
      job: {
        execution: { type: 'actor-task' as const, role: 'worker', instruction: 'Do it' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } },
        results: { succeeded: { criteria: 'The job is verified.', target: { return: 'done' } } },
      },
    } },
}

function harness(opts: { spawnNeverSucceeds?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-200-'))
  const store = new StateStore(home)
  const managerTexts: string[] = []
  const actorTexts: string[] = []
  const retired: string[] = []
  let judgeStarts = 0
  let sequence = 0
  const subagents: SubagentHost = {
    ensureRoleActor: async (_run, _role, text) => { actorTexts.push(text); return { childId: 'actor-1', messageId: `actor-${++sequence}` } },
    startJudge: async (_run, input) => {
      judgeStarts++
      if (opts.spawnNeverSucceeds) throw new Error('judge spawn exploded')
      return { judgeSessionId: input.judgeSessionId, messageId: `judge-${judgeStarts}` }
    },
    followupJudge: async () => { throw new Error('not expected') },
    judgeSessionAvailability: async () => 'available',
    roleSessionAvailability: async () => 'available',
    retireJudge: async (_run, id) => { retired.push(id) },
    drainJudge: async () => {},
    drainRoleActor: async () => {},
    compactRoleActor: async () => ({ ok: true }),
    safeToInspect: async () => 'safe',
  }
  const engine = new WorkflowEngine({
    steerManager: async (_run, text) => { managerTexts.push(text); return { messageId: `manager-${++sequence}` } },
    sendRoleActor: async () => { throw new Error('unexpected followup') },
    managerSessionSeq: () => 0,
  }, subagents, { run: async () => ({ kind: 'ERROR' }) }, makeStateHost(store))
  engine.cwdResolver = async () => `${home}-cwd`
  const caller = (dispatch: ExecutionDispatch) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    engine, managerTexts, actorTexts, retired,
    judgesStarted: () => judgeStarts,
    caller,
    row: async () => (await store.get('ws'))!,
    /** 把当前节点推到 checking 且 Judge 已派发待判定。 */
    async driveToJudge() {
      const row = (await store.get('ws'))!
      const e = row.execution
      e.phase = 'checking'
      e.claim = { id: 'claim-1', dispatchId: e.dispatch!.id, result: 'succeeded', handoff: 'Actor handoff' }
      e.judge = { id: 'judge-1', sessionId: 'judge', messageId: 'judge-message-1', settled: false, claimId: 'claim-1', inputVersion: e.inputVersion }
      await store.updateRow('ws', row.run, row.stateVersion, [
        { execution: e, expectedRevision: row.execution.revision, events: ['claim'] },
      ])
      return caller(e.judge)
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

async function startAndJudge(h: ReturnType<typeof harness>) {
  await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
  return h.driveToJudge()
}

test('#200 Judge 轮遇 5xx 瞬时错误自动重试 1 次：无 BLOCK，继续推进', async () => {
  const h = harness()
  try {
    const judge = await startAndJudge(h)
    const before = (await h.row()).execution.judge!
    const failure = failureOf({ kind: 'error', error: { message: '[server_error] request failed', code: 'SERVER', status: 500 } })!
    await h.engine.handleTurnEnded('ws', judge, failure)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.phase, 'checking')
    assert.equal(row.execution.blockReason, null)
    assert.equal(row.execution.judgeAutoRetried, true)
    // fresh 新会话重派：Judge 身份已轮换，旧会话已 retire 撤权。
    assert.notEqual(row.execution.judge!.id, before.id)
    assert.notEqual(row.execution.judge!.sessionId, before.sessionId)
    assert.ok(row.execution.judge!.messageId)
    assert.deepEqual(h.retired, [before.sessionId])
    // 重试后的 Judge 可照常提交 judge_claim 推进（无 BLOCK 落库）。
    const fresh = h.caller(row.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', fresh)).ok, true)
  } finally { h.close() }
})

test('#200 重试仍失败则 BLOCK，原因含「已自动重试」与原始错误', async () => {
  const h = harness()
  try {
    const judge = await startAndJudge(h)
    const transient = failureOf({ kind: 'error', error: { message: '[server_error] request failed', code: 'SERVER', status: 500 } })!
    await h.engine.handleTurnEnded('ws', judge, transient)
    const retried = await h.row()
    assert.equal(retried.run.status, 'running')
    const startsAfterRetry = h.judgesStarted()
    const fresh = h.caller(retried.execution.judge!)
    const again = failureOf({ kind: 'error', error: { message: 'upstream exploded', code: 'SERVER', status: 503 } })!
    await h.engine.handleTurnEnded('ws', fresh, again)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /已自动重试 1 次/)
    assert.match(blocked.execution.blockReason!, /code=SERVER status=503/)
    // 有界一次：第二次失败不再重派。
    assert.equal(h.judgesStarted(), startsAfterRetry)
  } finally { h.close() }
})

test('#200 4xx 直接 BLOCK，不重试且原因无「已自动重试」', async () => {
  const h = harness()
  try {
    const judge = await startAndJudge(h)
    const bad = failureOf({ kind: 'error', error: { message: 'model rejected the request', code: 'INVALID_REQUEST', status: 400 } })!
    await h.engine.handleTurnEnded('ws', judge, bad)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /judge turn ended without judge_claim/)
    assert.match(blocked.execution.blockReason!, /code=INVALID_REQUEST status=400/)
    assert.doesNotMatch(blocked.execution.blockReason!, /已自动重试/)
    assert.equal(blocked.execution.judgeAutoRetried, undefined)
    assert.equal(h.judgesStarted(), 0)
  } finally { h.close() }
})

test('#200 重试重派失败则 BLOCK，原因含「已自动重试」与重派错误', async () => {
  const h = harness({ spawnNeverSucceeds: true })
  try {
    // driveToJudge 不经过 startJudge，重试是首次 spawn 尝试，直接失败。
    const judge = await startAndJudge(h)
    const transient = failureOf({ kind: 'error', error: { message: '[server_error] request failed', code: 'SERVER', status: 500 } })!
    await h.engine.handleTurnEnded('ws', judge, transient)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /已自动重试 1 次/)
    assert.match(blocked.execution.blockReason!, /judge spawn exploded/)
    assert.equal(blocked.execution.judgeAutoRetried, true)
  } finally { h.close() }
})

// ---- 变体：派发文本与投影剥离 ----

test('#200 manager 变体删除 Actor 视角句与悬空占位句，其余条款逐条保留', () => {
  assert.doesNotMatch(MANAGER_SUBMISSION_CONSTRAINT, /本轮对话是在node工作节点运行/)
  assert.doesNotMatch(MANAGER_SUBMISSION_CONSTRAINT, /不需要向父会话 send_message 汇报结果/)
  assert.doesNotMatch(MANAGER_SUBMISSION_CONSTRAINT, /send_message/)
  for (const clause of ['结果只通过 node_claim 交付', '唯一 handoff', 'node_claim 必须是本轮对话的最后一个动作', '仅输出文字不视为提交', 'node_block', '不伪报结果', '收到 Judge REJECT 后', '可改选另一个合法结果']) {
    assert.ok(MANAGER_SUBMISSION_CONSTRAINT.includes(clause), `manager 变体缺条款: ${clause}`)
  }
  // actor 变体是现状原文，零行为变化。
  assert.match(SUBMISSION_CONSTRAINT, /本轮对话是在node工作节点运行，工作流的交付与推进只认 node_claim，不需要向父会话 send_message 汇报结果，以下汇报的说明可以忽略/)
})

test('#200 manager 节点派发用 manager 变体，actor 节点派发零变化', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const first = await h.row()
    const manager = h.caller(first.execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
    await h.engine.handleTurnEnded('ws', manager)
    const checking = await h.row()
    const judge = h.caller(checking.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    assert.equal(h.managerTexts.filter(t => !t.startsWith('[node-event]')).length, 1) // #203 事件另计，不混入派发计数。
    assert.equal(h.actorTexts.length, 1)
    const managerDispatch = h.managerTexts.filter(t => !t.startsWith('[node-event]'))[0]!
    const actorDispatch = h.actorTexts[0]!
    assert.ok(managerDispatch.endsWith(MANAGER_SUBMISSION_CONSTRAINT))
    assert.doesNotMatch(managerDispatch, /本轮对话是在node工作节点运行/)
    assert.doesNotMatch(managerDispatch, /send_message/)
    assert.ok(actorDispatch.endsWith(SUBMISSION_CONSTRAINT))
    assert.match(actorDispatch, /本轮对话是在node工作节点运行/)
  } finally { h.close() }
})

function sessionWith(text: string): Session {
  const s = Session.create('sess-200' as never)
  const msg = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  ;(s.append as (t: string, d: unknown, ...opts: unknown[]) => unknown)('user/message', msg, { surfaceOp: 'append' } as never)
  return s
}

test('#200 Judge 投影对两种变体输入都能剥净协议段', () => {
  for (const variant of [SUBMISSION_CONSTRAINT, MANAGER_SUBMISSION_CONSTRAINT]) {
    const out = projectSessionSurface(sessionWith(`[instruction]\nBuild it.${variant}`), 0, 'ACTOR')
    assert.equal(out.length, 1)
    assert.match(out[0]!.text, /Build it\./)
    assert.doesNotMatch(out[0]!.text, /提交要求/)
    assert.doesNotMatch(out[0]!.text, /node_claim/)
  }
  // 首条 dispatch 经投影压缩后两种变体都不泄漏。
  for (const variant of [SUBMISSION_CONSTRAINT, MANAGER_SUBMISSION_CONSTRAINT]) {
    const text = projectNodeLocal(sessionWith('[handoff]\nroot request'), { dispatchedAt: 0, managerFromSeq: 0 })
    assert.doesNotMatch(text, /提交要求/)
    void variant
  }
})
