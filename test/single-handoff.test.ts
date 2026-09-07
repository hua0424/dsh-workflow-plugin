import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import type { WorkflowConfig } from '../src/types.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'readonly' },
  workflow: { startNode: 'first', nodes: {
    first: { execution: { type: 'actor-task', role: 'manager', instruction: 'First' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } }, onPass: 'last', onFail: 'last' },
    last: { execution: { type: 'actor-task', role: 'manager', instruction: 'Last' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } }, onPass: 'END' },
  } },
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'handoff-t2-'))
  let store = new StateStore(home)
  const messages: string[] = []
  const packets: JudgeSpawnInput[] = []
  const followups: string[] = []
  const caller = { sessionId: 'manager', turnUserMessageIds: new Set<string>() }
  const subagents: SubagentHost = {
    ensureRoleActor: async () => { throw new Error('unexpected role') },
    startJudge: async (_run, input) => { packets.push(structuredClone(input)); return { judgeSessionId: input.judgeSessionId, messageId: 'judge-msg' } },
    followupJudge: async (_run, _id, text) => { followups.push(text) },
    judgeSessionExists: async () => false,
    retireJudge: async () => {}, drainJudge: async () => {}, compactRoleActor: async () => ({ ok: true }),
  }
  function engine() {
    const value = new WorkflowEngine({
      steerManager: async (_run, text) => { messages.push(text); const messageId = `msg-${messages.length}`; caller.turnUserMessageIds.add(messageId); return { messageId } },
      sendRoleActor: async () => { throw new Error('unexpected role') }, managerSessionSeq: () => 0,
    }, subagents, { run: async () => ({ kind: 'ERROR' }) }, makeStateHost(store))
    value.cwdResolver = async () => home
    return value
  }
  return {
    engine: engine(), caller, messages, packets, followups,
    row: () => store.get('ws'),
    reopen: () => { store.close(); store = new StateStore(home); return engine() },
    close: () => { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('T2: invalid runtime claims do not persist or consume the dispatch', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    for (const outcome of ['completed', 'failed'] as const) {
      for (const handoff of ['', '  ', 'x'.repeat(8001)]) {
        assert.equal((await h.engine.handleClaim('ws', { outcome, handoff }, h.caller)).ok, false)
      }
    }
    assert.equal(h.packets.length, 0)
    assert.equal((await h.row())!.run.pendingClaim, undefined)
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: '  valid  ' }, h.caller)).ok, true)
    assert.deepEqual(h.packets[0]!.claim, { outcome: 'completed', handoff: 'valid' })
  } finally { h.close() }
})

test('T2: NEED_CONTEXT followup and restart rebuild judge the same failed handoff', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const claim = { outcome: 'failed' as const, handoff: '失败证据 report.md；修复位置 src/x.ts' }
    await h.engine.handleClaim('ws', claim, h.caller)
    let row = (await h.row())!
    await h.engine.handleJudgeClaim('ws', row.run.callStack[0]!.nodeToken, 'NEED_CONTEXT', 'need context', row.run.judgeSessionId!)
    await h.engine.handleResume('ws', row.run.callStack[0]!.nodeToken, '核验补充', 'manager')
    assert.ok(h.followups[0]!.includes(claim.handoff))
    assert.ok(h.followups[0]!.includes('failed'))
    const restarted = h.reopen()
    await restarted.handleRestartReconcile()
    row = (await h.row())!
    await restarted.handleResume('ws', row.run.callStack[0]!.nodeToken, '恢复核验', 'manager')
    assert.deepEqual(h.packets.at(-1)!.claim, claim)
    row = (await h.row())!
    await restarted.handleJudgeClaim('ws', row.run.callStack[0]!.nodeToken, 'ACCEPT', 'confirmed failed', row.run.judgeSessionId!)
    assert.ok(h.messages.at(-1)!.includes(`[handoff]\n${claim.handoff}\n\n[instruction]`))
  } finally { h.close() }
})

test('T2: correction and explicit Judge respawn keep the full single claim', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const previousClaim = { outcome: 'completed' as const, handoff: '旧交付 evidence-old.md' }
    await h.engine.handleClaim('ws', previousClaim, h.caller)
    let row = (await h.row())!
    await h.engine.handleTurnEnded('ws', 'manager')
    await h.engine.handleJudgeClaim('ws', row.run.callStack[0]!.nodeToken, 'REJECT', '核验依据缺失', row.run.judgeSessionId!)
    assert.ok(h.messages.at(-1)!.includes(`handoff: ${previousClaim.handoff}`))
    const claim = { outcome: 'completed' as const, handoff: '更正交付 evidence-new.md' }
    await h.engine.handleClaim('ws', claim, h.caller)
    assert.deepEqual(h.packets.at(-1)!.claim, claim)
    assert.deepEqual(h.packets.at(-1)!.previousRejection?.previousClaim, previousClaim)
    row = (await h.row())!
    await h.engine.handleJudgeClaim('ws', row.run.callStack[0]!.nodeToken, 'NEED_CONTEXT', 'need facts', row.run.judgeSessionId!)
    await h.engine.handleRespawnJudge('ws', row.run.callStack[0]!.nodeToken, 'recheck', 'manager')
    assert.deepEqual(h.packets.at(-1)!.claim, claim)
    assert.deepEqual(h.packets.at(-1)!.previousRejection?.previousClaim, previousClaim)
  } finally { h.close() }
})

test('T2: accepted handoff is identical in Judge, successor and durable END result', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const handoff = '产物 artifacts/result.md；核验通过；保留约束 $& {criteria}'
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff }, h.caller)).ok, true)
    assert.deepEqual(h.packets[0]!.claim, { outcome: 'completed', handoff })
    let row = (await h.row())!
    assert.deepEqual(row.run.pendingClaim, { outcome: 'completed', handoff })
    const status = (await h.engine.status('ws')).status
    assert.notEqual(typeof status, 'string')
    if (typeof status !== 'string') assert.equal(status.handoffPreview, handoff)
    await h.engine.handleTurnEnded('ws', 'manager')
    await h.engine.handleJudgeClaim('ws', row.run.callStack[0]!.nodeToken, 'ACCEPT', 'verified', row.run.judgeSessionId!)
    assert.ok(h.messages.at(-1)!.includes(`[handoff]\n${handoff}\n\n[instruction]`))
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: '最终交付 final.md' }, h.caller)
    row = (await h.row())!
    await h.engine.handleTurnEnded('ws', 'manager')
    await h.engine.handleJudgeClaim('ws', row.run.callStack[0]!.nodeToken, 'ACCEPT', 'verified', row.run.judgeSessionId!)
    assert.equal((await h.row())!.run.finalHandoff, '最终交付 final.md')
    assert.ok(h.messages.at(-1)!.includes('最终交付 final.md'))
    const restarted = h.reopen()
    assert.equal((await h.row())!.run.finalHandoff, '最终交付 final.md')
    const finalStatus = (await restarted.status('ws')).status
    assert.notEqual(typeof finalStatus, 'string')
    if (typeof finalStatus !== 'string') assert.equal(finalStatus.finalHandoff, '最终交付 final.md')
    await restarted.startRun('ws', restarted.buildInitialRun('manager', 'test', config, 'new-hash'))
    assert.equal((await h.row())!.run.finalHandoff, undefined)
  } finally { h.close() }
})
