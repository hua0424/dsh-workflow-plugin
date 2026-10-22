/**
 * Issue #214 验收：节点事件 judgment 摘要 + 引用取全文。
 *
 * - Judge persona 强制结论前置（reason 首行 = 判定结果 + 一句话结论 +
 *   REJECT/NEED_CONTEXT 下一步动作，证据后置）。
 * - node-event 的 judgment 改为「verdict + ≤200 字符摘要（语义词边界截断）+
 *   judgmentRef（executionId/visit）」，并标注 current/historical；有 claim
 *   无对齐判定时显示 pending，不再沿用旧判定。
 * - `workflow_status` 的 judgment 区分当前判定 / 历史判定 / 待判定（state 字段），
 *   判定携带所针对的 claimId、visit 与 judgmentRef；全文经现有 history 分页按
 *   executionId 取事件 snapshot（不新增参数/工具）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type SubagentHost } from '../src/engine/engine.ts'
import type { ExecutionDispatch, WorkflowConfig } from '../src/types.ts'
import { renderJudgePrompt } from '../src/judge/checker.ts'

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

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-214-'))
  const store = new StateStore(home)
  const managerTexts: string[] = []
  const actorTexts: string[] = []
  let sequence = 0
  const subagents: SubagentHost = {
    ensureRoleActor: async (_run, _role, text) => { actorTexts.push(text); return { childId: 'actor-1', messageId: `actor-${++sequence}` } },
    startJudge: async (_run, input) => ({ judgeSessionId: input.judgeSessionId, messageId: `judge-${++sequence}` }),
    followupJudge: async () => { throw new Error('not expected') },
    judgeSessionAvailability: async () => 'available',
    roleSessionAvailability: async () => 'available',
    retireJudge: async () => {},
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
  const events = () => managerTexts.filter(text => text.startsWith('[node-event]'))
  return {
    engine, managerTexts, actorTexts, caller, events, store,
    row: async () => (await store.get('ws'))!,
    statusJudgment: async () => {
      const res = await engine.status('ws') as { ok: boolean; status?: { execution: { judgment: null | { state: string; [key: string]: unknown } } } }
      assert.equal(res.ok, true)
      return res.status!.execution.judgment
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('#214 Judge persona 强制结论前置：reason 首行格式约束', () => {
  const text = renderJudgePrompt({
    nodeToken: 'token', criteria: 'verified', result: 'succeeded', resultCriteria: 'ok',
    workerHandoff: 'done', workspaceCwd: '/ws', transcript: '',
  })
  assert.match(text, /第一行/)
  assert.match(text, /下一步动作/)
  assert.match(text, /REJECT.*修法方向|修法方向.*REJECT/)
  assert.match(text, /NEED_CONTEXT.*补充|补充.*NEED_CONTEXT/)
  assert.match(text, /后置/)
})

test('#214 node-event：ACCEPT 判定带 ≤200 摘要与引用（current，语义词边界）', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const executionId = (await h.row()).execution.executionId
    const manager = h.caller((await h.row()).execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
    await h.engine.handleTurnEnded('ws', manager)
    const checking = await h.row()
    // 待判定时通知显示 pending，不沿用旧判定。
    assert.match(h.events().at(-1)!, /judgment=pending/)
    assert.equal(await h.statusJudgment().then(judgment => (judgment as { state: string }).state), 'pending')
    const longReason = `ACCEPT结论：实现完整，已自测通过。 ${Array(150).fill('word').join(' ')}`
    assert.ok(longReason.length > 500)
    const judge = h.caller(checking.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', longReason, judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    const exited = h.events().find(text => text.includes('phase=exited'))!
    assert.match(exited, /judgment=ACCEPT ACCEPT结论/)
    const parsed = exited.match(/judgment=ACCEPT ([^()\n]*) \((current) ref=(\S+) visit=(\d+)\)/)
    assert.ok(parsed, 'judgment 段应为 verdict + 摘要 + (current ref=<executionId> visit=<n>)')
    const [, summary, state, ref, visit] = parsed
    assert.equal(state, 'current')
    assert.ok(summary.length <= 200, `摘要应 ≤200 字符，实际 ${summary.length}`)
    assert.ok(summary.endsWith('word'), '摘要应在词边界截断，不切碎单词')
    assert.equal(ref, executionId)
    assert.equal(visit, '1')
    // 全文仍可经 history 分页按 judgmentRef.executionId 取回。
    const history = await h.engine.status('ws', 'manager', { executionId: ref, after: 0, limit: 50 }) as
      { ok: boolean; status?: { history: { events: Array<{ type: string; snapshot: { judgment?: { reason: string } } }> } } }
    assert.equal(history.ok, true)
    const judged = history.status!.history.events.find(event => event.type === 'judgment' && event.snapshot.judgment?.reason === longReason)
    assert.ok(judged, 'history 事件 snapshot 应含完整判定全文')
  } finally { h.close() }
})

test('#214 待判定不沿用旧判定：REJECT 后新 claim 显示 pending，历史可追溯', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const executionId = (await h.row()).execution.executionId
    const actor1 = h.caller((await h.row()).execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'first candidate' }, actor1)).ok, true)
    await h.engine.handleTurnEnded('ws', actor1)
    const checking1 = await h.row()
    const claim1Id = checking1.execution.claim!.id
    const rejectReason = `REJECT结论首行：缺少单测，请补 node --test 用例。 ${Array(100).fill('detail').join(' ')}`
    assert.equal((await h.engine.handleJudgeClaim('ws', checking1.execution.nodeToken, 'REJECT', rejectReason, h.caller(checking1.execution.judge!))).ok, true)
    // REJECT 回到 ready：status 显示历史判定（携带 claimId 与 judgmentRef）。
    const historical = await h.statusJudgment() as { state: string; result: string; summary: string; claimId: string; visit: number; judgmentRef: { executionId: string; visit: number } }
    assert.equal(historical.state, 'historical')
    assert.equal(historical.result, 'REJECT')
    assert.equal(historical.claimId, claim1Id)
    assert.equal(historical.visit, 1)
    assert.equal(historical.judgmentRef.executionId, executionId)
    assert.ok(historical.summary.length <= 200)
    assert.match(h.events().at(-1)!, /judgment=REJECT REJECT结论首行.*\(historical ref=/)
    // 新 claim 待判期间：通知与 status 均为 pending，不再显示旧 REJECT。
    const correcting = await h.row()
    const actor2 = h.caller(correcting.execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'corrected candidate' }, actor2)).ok, true)
    await h.engine.handleTurnEnded('ws', actor2)
    const checkingEvent = h.events().at(-1)!
    assert.match(checkingEvent, /judgment=pending/)
    assert.doesNotMatch(checkingEvent, /REJECT/)
    const pending = await h.statusJudgment() as { state: string; claimId: string }
    assert.equal(pending.state, 'pending')
    assert.equal(pending.claimId, (await h.row()).execution.claim!.id)
    assert.notEqual(pending.claimId, claim1Id)
    // 历史 REJECT 全文仍可经 judgmentRef 取回。
    const history = await h.engine.status('ws', 'manager', { executionId, after: 0, limit: 50 }) as
      { ok: boolean; status?: { history: { events: Array<{ type: string; snapshot: { judgment?: { reason: string; result: string } } }> } } }
    assert.equal(history.ok, true)
    assert.ok(history.status!.history.events.some(event => event.type === 'judgment' && event.snapshot.judgment?.result === 'REJECT' && event.snapshot.judgment?.reason === rejectReason))
  } finally { h.close() }
})

test('#214 NEED_CONTEXT 是当前判定：status state=current，BLOCK 通知带引用', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const executionId = (await h.row()).execution.executionId
    const manager = h.caller((await h.row()).execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
    await h.engine.handleTurnEnded('ws', manager)
    const checking = await h.row()
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'NEED_CONTEXT', 'Manager 请补充缺失的验收上下文。', h.caller(checking.execution.judge!))).ok, true)
    const current = await h.statusJudgment() as { state: string; result: string; summary: string; judgmentRef: { executionId: string; visit: number } }
    assert.equal(current.state, 'current')
    assert.equal(current.result, 'NEED_CONTEXT')
    assert.equal(current.judgmentRef.executionId, executionId)
    const block = h.managerTexts.at(-1)!
    assert.ok(block.startsWith('[node-event]'))
    assert.match(block, /judgment=NEED_CONTEXT Manager 请补充缺失的验收上下文。 \(current ref=/)
  } finally { h.close() }
})
