import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import type { ExecutionDispatch, WorkflowConfig } from '../src/types.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'readonly' },
  workflow: { startNode: 'first', nodes: {
    first: { execution: { type: 'actor-task', role: 'manager', instruction: 'First' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } }, onPass: 'last', onFail: 'last' },
    last: { execution: { type: 'actor-task', role: 'manager', instruction: 'Last' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } }, onPass: 'END' },
  } },
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'handoff-t4-'))
  let store = new StateStore(home)
  let sequence = 0
  const messages: Array<{ id: string; text: string }> = []
  const packets: JudgeSpawnInput[] = []
  const followups: JudgeSpawnInput[] = []
  const subagents: SubagentHost = {
    ensureRoleActor: async () => { throw new Error('unexpected role') },
    startJudge: async (_run, input) => { packets.push(structuredClone(input)); return { judgeSessionId: input.judgeSessionId, messageId: `judge-${++sequence}` } },
    followupJudge: async (_run, _id, input) => { followups.push(structuredClone(input)); return { messageId: `judge-followup-${++sequence}` } },
    judgeSessionExists: async () => true,
    retireJudge: async () => {}, drainJudge: async () => {}, compactRoleActor: async () => ({ ok: true }), safeToInspect: async () => true,
  }
  function engine() {
    const value = new WorkflowEngine({
      steerManager: async (_run, text) => { const sent = { id: `actor-${++sequence}`, text }; messages.push(sent); return { messageId: sent.id } },
      sendRoleActor: async () => { throw new Error('unexpected role') }, managerSessionSeq: () => 0,
    }, subagents, { run: async () => ({ kind: 'ERROR' }) }, makeStateHost(store))
    value.cwdResolver = async () => home
    return value
  }
  const caller = (dispatch: ExecutionDispatch) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    engine: engine(), messages, packets, followups, caller,
    row: async () => (await store.get('ws'))!,
    reopen: () => { store.close(); store = new StateStore(home); return engine() },
    close: () => { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

async function claimAndStartJudge(h: ReturnType<typeof harness>, claim: { outcome: 'completed' | 'failed'; handoff: string }) {
  const before = await h.row()
  const actor = h.caller(before.execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', claim, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  return h.row()
}

async function acceptAndAdvance(h: ReturnType<typeof harness>, reason = 'verified') {
  const checking = await h.row()
  const judge = h.caller(checking.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', reason, judge)).ok, true)
  await h.engine.handleTurnEnded('ws', judge)
}

test('T2: invalid runtime claims do not persist or consume the dispatch', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const initial = await h.row()
    const caller = h.caller(initial.execution.dispatch!)
    for (const outcome of ['completed', 'failed'] as const) {
      for (const handoff of ['', '  ', 'x'.repeat(8001)]) assert.equal((await h.engine.handleClaim('ws', { outcome, handoff }, caller)).ok, false)
    }
    assert.equal(h.packets.length, 0)
    assert.equal((await h.row()).execution.claim, undefined)
    await claimAndStartJudge(h, { outcome: 'completed', handoff: '  valid  ' })
    assert.deepEqual(h.packets[0]!.claim, { outcome: 'completed', handoff: 'valid' })
  } finally { h.close() }
})

test('T4: NEED_CONTEXT followup and restart respawn judge the same failed handoff', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const claim = { outcome: 'failed' as const, handoff: '失败证据 report.md；修复位置 src/x.ts' }
    let row = await claimAndStartJudge(h, claim)
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need context', h.caller(row.execution.judge!))
    row = await h.row()
    await h.engine.handleResume('ws', row.execution.nodeToken, '核验补充', 'manager', 'judge')
    assert.deepEqual(h.followups[0]!.claim, claim)
    assert.equal(h.followups[0]!.managerContext, '核验补充')

    const restarted = h.reopen()
    await restarted.handleRestartReconcile()
    row = await h.row()
    assert.equal((await restarted.handleRespawnJudge('ws', row.execution.nodeToken, 'host restart rebuild', 'manager')).ok, true)
    assert.deepEqual(h.packets.at(-1)!.claim, claim)
    assert.equal(h.packets.at(-1)!.managerContext, '核验补充')
    row = await h.row()
    assert.equal((await restarted.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'confirmed failed', h.caller(row.execution.judge!))).ok, true)
    await restarted.handleTurnEnded('ws', h.caller(row.execution.judge!))
    assert.equal((await h.row()).execution.input, claim.handoff)
  } finally { h.close() }
})

test('T4: correction and explicit Judge respawn keep the full single claim', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const previousClaim = { outcome: 'completed' as const, handoff: '旧交付 evidence-old.md' }
    let row = await claimAndStartJudge(h, previousClaim)
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', '核验依据缺失', h.caller(row.execution.judge!))
    assert.ok(h.messages.at(-1)!.text.includes(`handoff: ${previousClaim.handoff}`))
    const claim = { outcome: 'completed' as const, handoff: '更正交付 evidence-new.md' }
    row = await claimAndStartJudge(h, claim)
    assert.deepEqual(h.packets.at(-1)!.claim, claim)
    assert.deepEqual(h.packets.at(-1)!.previousFeedback?.claim, previousClaim)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need facts', h.caller(row.execution.judge!))).ok, true)
    row = await h.row()
    assert.equal((await h.engine.handleRespawnJudge('ws', row.execution.nodeToken, 'recheck', 'manager')).ok, true)
    assert.deepEqual(h.packets.at(-1)!.claim, claim)
    assert.equal(h.packets.at(-1)!.previousFeedback?.result, 'NEED_CONTEXT')
  } finally { h.close() }
})

test('T2: accepted handoff is identical in Judge, successor and durable END result', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const handoff = '产物 artifacts/result.md；核验通过；保留约束 $& {criteria}'
    await claimAndStartJudge(h, { outcome: 'completed', handoff })
    assert.deepEqual(h.packets[0]!.claim, { outcome: 'completed', handoff })
    let status = (await h.engine.status('ws', 'manager')).status
    assert.notEqual(typeof status, 'string')
    if (typeof status !== 'string' && status && 'handoffPreview' in status) assert.equal(status.handoffPreview, handoff)
    await acceptAndAdvance(h)
    assert.equal((await h.row()).execution.input, handoff)

    await claimAndStartJudge(h, { outcome: 'completed', handoff: '最终交付 final.md' })
    const checking = await h.row()
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', h.caller(checking.execution.judge!))).ok, true)
    assert.equal((await h.row()).execution.claim?.handoff, '最终交付 final.md')
    assert.ok(h.messages.at(-1)!.text.includes('最终交付 final.md'))
    const restarted = h.reopen()
    assert.equal((await h.row()).execution.claim?.handoff, '最终交付 final.md')
    status = (await restarted.status('ws', 'manager')).status
    assert.notEqual(typeof status, 'string')
    if (typeof status !== 'string' && status && 'finalHandoffPreview' in status) assert.equal(status.finalHandoffPreview, '最终交付 final.md')
  } finally { h.close() }
})
