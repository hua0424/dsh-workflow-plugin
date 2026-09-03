import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { WorkflowEngine, type StateHost, type SubagentHost, type ProgramHost, type DispatchTargets } from '../src/engine/engine.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash } from '../src/catalog/validate.ts'
import { newNodeToken, topFrame } from '../src/state/invariants.ts'
import type { RunState, ClaimOutcome } from '../src/types.ts'

const MANAGER = 'manager-session'

/** Two-node config: manager plan → developer build → END. */
const CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles:
  developer: { persona: D }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS when planned. } }
      onPass: build
    build:
      execution: { type: actor-task, role: developer, instruction: Build. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS when built. } }
      onPass: END
`), { workflowId: 'eng-test' })

interface MemState {
  run?: RunState
  version: number
}

function makeStateHost(mem: MemState): StateHost {
  return {
    async get() {
      if (mem.run === undefined) return undefined
      return { run: structuredClone(mem.run), version: mem.version }
    },
    async put(_ws, run, expectedVersion) {
      assert.equal(mem.version, expectedVersion, 'state version mismatch')
      mem.run = structuredClone(run)
      mem.version += 1
    },
    async create(_ws, run) {
      if (mem.run !== undefined && mem.run.status !== 'completed') {
        const err = new Error(`workspace already has a ${mem.run.status} run`)
        err.name = 'StateConflictError'
        throw err
      }
      mem.run = structuredClone(run)
      mem.version = 1
      return 1
    },
    async remove() {
      mem.run = undefined
    },
    async listRuns() {
      return mem.run === undefined ? [] : [{ workspaceKey: 'ws', run: structuredClone(mem.run), version: mem.version }]
    },
  }
}

interface Harness {
  mem: MemState
  engine: WorkflowEngine
  steers: string[]
  actorMessages: string[]
  judges: number
  judgeSessionId: string
  judgeSpawnInputs: Array<{ nodeToken: string; instruction: string; criteria: string; claim: { outcome: ClaimOutcome; summary: string } }>
  judgeFollowups: string[]
  retiredJudges: string[]
  drainedJudges: string[]
  judgeSpawnFailure: Error | undefined
  actorCreated: boolean
  compacts: string[]
  compactResult: { ok: boolean; detail?: string }
}

function makeHarness(): Harness {
  const mem: MemState = { version: 0 }
  const h: Harness = {
    mem,
    engine: undefined as never,
    steers: [],
    actorMessages: [],
    judges: 0,
    judgeSessionId: 'judge-session-1',
    judgeSpawnInputs: [],
    judgeFollowups: [],
    retiredJudges: [],
    drainedJudges: [],
    judgeSpawnFailure: undefined,
    actorCreated: false,
    compacts: [],
    compactResult: { ok: true, detail: 'no compactable range' },
  }
  const targets: DispatchTargets = {
    async steerManager(_run, text) { h.steers.push(text) },
    async sendRoleActor(_run, _role, text) {
      h.actorMessages.push(text)
      return { messageId: `msg-role-${h.actorMessages.length}` }
    },
    managerSessionSeq() { return 0 },
  }
  const subagents: SubagentHost = {
    async ensureRoleActor(_run, _role, initialText) {
      h.actorCreated = true
      h.actorMessages.push(initialText)
      return { childId: 'actor-child-1', messageId: 'msg-actor' }
    },
    async startJudge(_run, input) {
      if (h.judgeSpawnFailure !== undefined) throw h.judgeSpawnFailure
      h.judges += 1
      h.judgeSpawnInputs.push(input)
      return { judgeSessionId: h.judgeSessionId, messageId: 'msg-judge' }
    },
    async followupJudge(_run, _judgeSessionId, text) { h.judgeFollowups.push(text) },
    async retireJudge(_run, judgeSessionId) { h.retiredJudges.push(judgeSessionId) },
    async drainJudge(_run, judgeSessionId) { h.drainedJudges.push(judgeSessionId) },
    async compactRoleActor(_run, roleKey) { h.compacts.push(roleKey); return h.compactResult },
  }
  const programs: ProgramHost = {
    async run(_run, programId, _params) {
      const r = new Map<string, { kind: 'PASS' | 'FAIL' | 'ERROR'; reason?: string }>()
      return r.get(programId) ?? { kind: 'ERROR', reason: 'no stub result' }
    },
  }
  h.engine = new WorkflowEngine(targets, subagents, programs, makeStateHost(mem))
  h.engine.cwdResolver = async () => '/workspace'
  return h
}

function initialRun(): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: MANAGER,
    catalogWorkflowId: 'eng-test',
    definitionHash: computeDefinitionHash(CONFIG),
    definitionSnapshot: CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'eng-test', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
}

test('startRun persists and dispatches the root node to the manager', async () => {
  const h = makeHarness()
  const run = initialRun()
  const outcome = await h.engine.startRun('ws', run)
  assert.ok(outcome.ok)
  assert.equal(h.steers.length, 1)
  assert.match(h.steers[0]!, /Plan/)
  // A3 AC1: actor-task dispatch carries the submission hard constraint.
  assert.match(h.steers[0]!, /\[提交要求\]/)
  assert.match(h.steers[0]!, /node_claim/)
  // A3 AC3: the original instruction is preserved.
  assert.match(h.steers[0]!, /Plan\./)
  assert.equal(h.mem.run!.status, 'running')
})

test('claim spawns a judge, judge_claim PASS advances and defers next dispatch until turn end', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  const claimOutcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  assert.ok(claimOutcome.ok)
  assert.equal(h.judges, 1)
  assert.equal(h.mem.run!.judgeSessionId, 'judge-session-1')
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
  assert.equal(h.mem.run!.status, 'running')
  // Judge submits PASS BEFORE the worker's turn settles (fast-verdict ordering).
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'PASS', 'planned ok', 'judge-session-1')
  assert.ok(verdict.ok)
  assert.equal(topFrame(h.mem.run!).nodeId, 'build')
  assert.equal(h.mem.run!.judgeSessionId, undefined)
  assert.equal(h.mem.run!.pendingClaim, undefined)
  // A1 R11: PASS retires the judge (revoke-only, never a self-drain).
  assert.deepEqual(h.retiredJudges, ['judge-session-1'])
  assert.deepEqual(h.drainedJudges, [])
  assert.equal(h.actorMessages.length, 0)
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.equal(h.actorMessages.length, 1)
  assert.match(h.actorMessages[0]!, /Build/)
  assert.ok(h.actorCreated)
})

test('real ordering: worker turn settles before the verdict — no false BLOCK, dispatch happens (F1/F2)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  // The worker's own turn ends IMMEDIATELY after node_claim (concludeTurn),
  // while the async Judge is still evaluating. This is the production ordering.
  const settled = await h.engine.handleTurnEnded('ws', MANAGER)
  assert.equal(settled, undefined)
  // A3 R2: a turn that DID submit node_claim must not be blocked as
  // "actor-turn-ended-without-result".
  assert.equal(h.mem.run!.status, 'running')
  assert.ok(!h.steers.some(t => /Actor 未提交结果/.test(t)))
  // The late verdict is accepted (run still running) and — because the worker
  // already settled — dispatches the next node IMMEDIATELY (no pendingDispatch
  // stall).
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'PASS', 'planned ok', 'judge-session-1')
  assert.ok(verdict.ok)
  assert.equal(topFrame(h.mem.run!).nodeId, 'build')
  assert.equal(h.actorMessages.length, 1)
  assert.match(h.actorMessages[0]!, /Build/)
})

test('claim with FAIL verdict and no onFail edge blocks', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'FAIL', 'not planned', 'judge-session-1')
  assert.ok(verdict.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.match(h.mem.run!.blockReason ?? '', /FAIL/)
})

test('NEED_CONTEXT verdict blocks and keeps the judge session', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', 'judge-session-1')
  assert.ok(verdict.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'missing repo')
  assert.equal(h.mem.run!.judgeSessionId, 'judge-session-1')
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
})

test('resume in judgment phase with judgeSessionId followups the same judge (A4 AC3)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', 'judge-session-1')
  const outcome = await h.engine.handleResume('ws', token, 'repo is acme/server', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.judgeSessionId, 'judge-session-1')
  assert.equal(h.judgeFollowups.length, 1)
  assert.match(h.judgeFollowups[0]!, /repo is acme\/server/)
  assert.equal(h.judges, 1) // no respawn
})

test('resume in judgment phase without judgeSessionId spawns a fresh judge (A4 AC4)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', 'judge-session-1')
  // Simulate a lost judge session.
  delete h.mem.run!.judgeSessionId
  const outcome = await h.engine.handleResume('ws', token, 'repo is acme/server', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.judgeSessionId, 'judge-session-1')
  assert.equal(h.judges, 2) // respawned
})

test('judge_respawn drains the old judge and spawns a new one (A4 AC5)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', 'judge-session-1')
  const oldJudge = h.mem.run!.judgeSessionId
  const outcome = await h.engine.handleRespawnJudge('ws', token, 'model swap', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.blockReason, null)
  assert.equal(h.mem.run!.judgeSessionId, 'judge-session-1')
  assert.deepEqual(h.drainedJudges, [oldJudge])
  assert.equal(h.judges, 2)
})

test('judge technical fault (spawn failure) blocks with a judge fault detail (A4 AC1)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  h.judgeSpawnFailure = new Error('provider down')
  const outcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.match(h.mem.run!.blockReason ?? '', /judge fault: provider down/)
  assert.ok(h.steers.some(t => /Judge 判定故障/.test(t)))
  // A4 R9: pendingClaim persisted at judgment entry survives the spawn fault.
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
})

test('judge turn ended without judge_claim blocks with a fault detail and KEEPS judgeSessionId (A4 R5)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const outcome = await h.engine.handleJudgeTurnEnded('ws', 'judge-session-1', 'max-tokens')
  assert.ok(outcome !== undefined && outcome.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.match(h.mem.run!.blockReason ?? '', /judge fault: max-tokens/)
  // A4 R5: the engine must NOT auto-clear judgeSessionId — followup stays
  // reachable for the Manager's node_resume decision.
  assert.equal(h.mem.run!.judgeSessionId, 'judge-session-1')
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
  // A4 R8: with judgeSessionId kept, node_resume followups the same judge.
  const resumed = await h.engine.handleResume('ws', token, 'retry with context', MANAGER)
  assert.ok(resumed.ok)
  assert.equal(h.judgeFollowups.length, 1)
  assert.equal(h.judges, 1) // followup, not spawn-rebuild
})

test('stale judge_claim from an old judge session is rejected (A1 AC9)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const stale = await h.engine.handleJudgeClaim('ws', token, 'PASS', 'late', 'some-other-judge')
  assert.ok(!stale.ok)
  assert.match(stale.reason ?? '', /judge session/)
})

test('stale token claims are rejected', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const outcome = await h.engine.handleClaim('ws', { nodeToken: 'stale-token', outcome: 'completed', summary: 'x' }, MANAGER)
  assert.ok(!outcome.ok)
  assert.match(outcome.reason ?? '', /stale/)
})

test('claim from a non-executor is rejected', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  const outcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'x' }, 'actor-child-1')
  assert.ok(!outcome.ok)
  assert.match(outcome.reason ?? '', /executor/)
})

test('claim on non-running run is rejected', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleBlock('ws', token, 'manual block', MANAGER)
  const outcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'x' }, MANAGER)
  assert.ok(!outcome.ok)
  assert.match(outcome.reason ?? '', /blocked|running/)
})

test('second claim on the same token is rejected (judge already spawned)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  const first = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'first' }, MANAGER)
  assert.ok(first.ok)
  const second = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'late' }, MANAGER)
  assert.ok(!second.ok)
  assert.match(second.reason ?? '', /pending/)
})

test('turn ended without any accepted result blocks the node and notifies the manager (A3 AC5)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const outcome = await h.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(outcome !== undefined && outcome.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'actor-turn-ended-without-result')
  assert.ok(h.steers.some(t => /Actor 未提交结果/.test(t)))
})

test('turn ended by a non-executor session is ignored', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const outcome = await h.engine.handleTurnEnded('ws', 'some-helper-session')
  assert.equal(outcome, undefined)
  assert.equal(h.mem.run!.status, 'running')
})

test('resume rotates the token and re-dispatches', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  await h.engine.handleTurnEnded('ws', MANAGER)
  const blockedToken = topFrame(h.mem.run!).nodeToken
  const outcome = await h.engine.handleResume('ws', blockedToken, 'resolved the issue', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.notEqual(topFrame(h.mem.run!).nodeToken, blockedToken)
  assert.equal(h.steers.length, 3)
})

test('resume by a non-manager is rejected', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  await h.engine.handleTurnEnded('ws', MANAGER)
  const blockedToken = topFrame(h.mem.run!).nodeToken
  const outcome = await h.engine.handleResume('ws', blockedToken, 'ctx', 'actor-child-1')
  assert.ok(!outcome.ok)
  assert.match(outcome.reason ?? '', /Manager/)
})

test('restart reconciliation blocks every running row', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  await h.engine.handleRestartReconcile()
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'host-restarted-before-node-result')
})

test('reset removes the row', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  await h.engine.handleReset('ws')
  assert.equal(h.mem.run, undefined)
})

test('role model override is rejected while the role actor turn is active; idle actor is replaced', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'judge-session-1')
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(h.mem.run!.roleActors['developer'] !== undefined)
  // Simulate an ACTIVE actor turn → override rejected.
  h.engine.actorActivity = async () => 'active'
  const rejected = await h.engine.handleSetRoleModel('ws', 'developer', 'p2', 'm2')
  assert.ok(!rejected.ok)
  assert.match(rejected.reason ?? '', /active actor/)
  // Simulate an IDLE actor → override accepted, mapping removed (replacement on next dispatch).
  h.engine.actorActivity = async () => 'idle'
  const accepted = await h.engine.handleSetRoleModel('ws', 'developer', 'p2', 'm2')
  assert.ok(accepted.ok)
  assert.equal(h.mem.run!.roleActors['developer'], undefined)
  assert.deepEqual(h.mem.run!.modelOverrides['developer'], { provider: 'p2', modelId: 'm2' })
  const judgeOverride = await h.engine.handleSetRoleModel('ws', 'judge', 'p3', 'm3')
  assert.ok(judgeOverride.ok)
})

test('node-boundary compact runs before dispatching a fresh role node (A2 AC1)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'judge-session-1')
  // Pre-seed the role mapping so the developer node dispatches to an EXISTING actor.
  h.mem.run!.roleActors['developer'] = 'actor-child-1'
  await h.engine.handleTurnEnded('ws', MANAGER)
  // The developer node dispatches fresh → compact runs once for the existing role actor.
  assert.deepEqual(h.compacts, ['developer'])
})

test('compact failure blocks the node and notifies the Manager (A2 AC5/R4)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'judge-session-1')
  h.mem.run!.roleActors['developer'] = 'actor-child-1'
  h.compactResult = { ok: false, detail: 'compaction busy: agent active' }
  const settled = await h.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(settled !== undefined && settled.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  // Clean single-wrapped reason, not "dispatch-failed: WorkflowError: ...".
  assert.match(h.mem.run!.blockReason ?? '', /^node-boundary compact failed: compaction busy/)
  // A2 R4/AC5: the BLOCK actively steers the Manager with the compact template.
  assert.ok(h.steers.some(t => /Node 边界 compact 失败/.test(t) && /compaction busy/.test(t)))
})

test('same-node resume of a role actor retains the boundary and skips compact (A1 R4/AC5, A2 R6)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'judge-session-1')
  await h.engine.handleTurnEnded('ws', MANAGER)
  // The build node dispatched to the freshly created developer actor.
  const firstBoundary = { ...h.mem.run!.nodeBoundary }
  assert.equal(firstBoundary.executorSessionId, 'actor-child-1')
  assert.equal(firstBoundary.executorDispatchMessageId, 'msg-actor')
  // Actor ends its turn WITHOUT claiming → A3 BLOCK.
  await h.engine.handleTurnEnded('ws', 'actor-child-1')
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'actor-turn-ended-without-result')
  // Manager resumes the SAME node → the followup must NOT reset the boundary
  // (pre-resume actor history stays inside the Judge projection window) and
  // must not compact again (A2 R6).
  const buildToken = topFrame(h.mem.run!).nodeToken
  const resumed = await h.engine.handleResume('ws', buildToken, 'please finish and claim', MANAGER)
  assert.ok(resumed.ok)
  assert.equal(h.actorMessages.length, 2)
  assert.match(h.actorMessages[1]!, /please finish and claim/)
  assert.equal(h.mem.run!.nodeBoundary.dispatchedAt, firstBoundary.dispatchedAt)
  assert.equal(h.mem.run!.nodeBoundary.executorDispatchMessageId, firstBoundary.executorDispatchMessageId)
  assert.equal(h.mem.run!.nodeBoundary.managerFromSeq, firstBoundary.managerFromSeq)
})

test('handoffContext survives NEED_CONTEXT resume token rotation (S3/A4 R9)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', {
    nodeToken: token, outcome: 'completed', summary: 'planned',
    handoffContext: 'repo=acme/server',
  }, MANAGER)
  // Judge needs context → BLOCK → Manager resumes (token rotates) → judge PASS.
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', 'judge-session-1')
  const resumed = await h.engine.handleResume('ws', token, 'repo is acme/server', MANAGER)
  assert.ok(resumed.ok)
  const rotated = topFrame(h.mem.run!).nodeToken
  assert.notEqual(rotated, token)
  const verdict = await h.engine.handleJudgeClaim('ws', rotated, 'PASS', 'ok now', 'judge-session-1')
  assert.ok(verdict.ok)
  // The handoff keyed under the PRE-rotation token must still reach the next
  // node's dispatch message.
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(h.actorMessages.length >= 1)
  assert.match(h.actorMessages[0]!, /repo=acme\/server/)
})

test('first role creation skips compact (A2 AC3)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'judge-session-1')
  // First creation has no existing mapping → ensureRoleActor, no compact.
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.deepEqual(h.compacts, [])
  assert.ok(h.actorCreated)
})

test('builtin-program dispatch does not inject the submission constraint (A3 AC2)', async () => {
  const PROG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Begin. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: run
    run:
      execution: { type: builtin-program, programId: github.initialize-milestone }
      onPass: END
`), { workflowId: 'prog-inject' })
  const h = makeHarness()
  h.mem = { version: 0 }
  const state: StateHost = {
    async get() { return h.mem.run === undefined ? undefined : { run: structuredClone(h.mem.run), version: h.mem.version } },
    async put(_ws, run, expectedVersion) { h.mem.run = structuredClone(run); h.mem.version += 1 },
    async create(_ws, run) { h.mem.run = structuredClone(run); h.mem.version = 1; return 1 },
    async remove() { h.mem.run = undefined },
    async listRuns() { return h.mem.run === undefined ? [] : [{ workspaceKey: 'ws', run: structuredClone(h.mem.run), version: h.mem.version }] },
  }
  const targets: DispatchTargets = {
    async steerManager(_run, text) { h.steers.push(text) },
    async sendRoleActor() { return { messageId: 'm' } },
    managerSessionSeq() { return 0 },
  }
  const subagents: SubagentHost = {
    async ensureRoleActor() { return { childId: 'a', messageId: 'm' } },
    async startJudge() { return { judgeSessionId: 'j', messageId: 'm' } },
    async followupJudge() {},
    async retireJudge() {},
    async drainJudge() {},
    async compactRoleActor() { return { ok: true, detail: 'no compactable range' } },
  }
  const programs: ProgramHost = { async run() { return { kind: 'PASS' } } }
  const engine = new WorkflowEngine(targets, subagents, programs, state)
  engine.cwdResolver = async () => '/workspace'
  const run: RunState = {
    runId: crypto.randomUUID(), managerSessionId: MANAGER, catalogWorkflowId: 'prog-inject', definitionHash: computeDefinitionHash(PROG),
    definitionSnapshot: PROG, status: 'running',
    callStack: [{ workflowId: 'prog-inject', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: {}, modelOverrides: {}, blockReason: null, nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
  await engine.startRun('ws', run)
  // Advance plan → run (builtin-program) via a PASS verdict.
  const token = topFrame(run).nodeToken
  await engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'j')
  await engine.handleTurnEnded('ws', MANAGER)
  // The builtin-program dispatch must not carry the constraint.
  const programSteer = h.steers.find(t => /Run the current builtin program|initialize-milestone/.test(t))
  assert.ok(programSteer !== undefined)
  assert.doesNotMatch(programSteer, /\[提交要求\]/)
})

// ---- child-workflow coverage (acceptance D3) ----

const CHILD_CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { worker: { persona: W } }
judgeRole: { persona: J }
workflow:
  startNode: begin
  nodes:
    begin:
      execution: { type: actor-task, role: manager, instruction: Begin. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: call-child
    call-child:
      execution: { type: child-workflow, workflowId: child-a }
      onPass: END
childWorkflows:
  child-a:
    startNode: child-step
    nodes:
      child-step:
        execution: { type: actor-task, role: worker, instruction: Do child work. }
        checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
        onPass: END
`), { workflowId: 'child-test' })

function makeChildHarness(): Harness & { childRun: () => RunState } {
  const base = makeHarness()
  const childRun = (): RunState => ({
    runId: crypto.randomUUID(),
    managerSessionId: MANAGER,
    catalogWorkflowId: 'child-test',
    definitionHash: computeDefinitionHash(CHILD_CONFIG),
    definitionSnapshot: CHILD_CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'child-test', nodeId: 'begin', nodeToken: newNodeToken() }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  })
  return Object.assign(base, { childRun })
}

test('child-workflow pushes a frame and dispatches the child start node', async () => {
  const h = makeChildHarness()
  await h.engine.startRun('ws', h.childRun())
  const beginToken = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: beginToken, outcome: 'completed', summary: 'begun' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', beginToken, 'PASS', 'begun', 'judge-session-1')
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.equal(h.mem.run!.callStack.length, 2)
  assert.equal(topFrame(h.mem.run!).workflowId, 'child-a')
  assert.equal(topFrame(h.mem.run!).nodeId, 'child-step')
  assert.equal(h.actorCreated, true)
})

test('child END pops the frame and treats the parent node as PASS', async () => {
  const h = makeChildHarness()
  await h.engine.startRun('ws', h.childRun())
  const beginToken = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: beginToken, outcome: 'completed', summary: 'begun' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', beginToken, 'PASS', 'begun', 'judge-session-1')
  await h.engine.handleTurnEnded('ws', MANAGER)
  const childToken = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: childToken, outcome: 'completed', summary: 'done' }, 'actor-child-1')
  const outcome = await h.engine.handleJudgeClaim('ws', childToken, 'PASS', 'child done', 'judge-session-1')
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'completed')
  assert.equal(h.mem.run!.callStack.length, 0)
  // Completion notification is steered to the Manager.
  assert.ok(h.steers.some(t => /已完成/.test(t)), 'manager should get a completion steer')
})

// ---- run trace log (issue #2 / PRD workflow-run-logging R1-R4) ----

/** Create a temp catalog dir containing `<workflowId>.yaml`; removed after fn. */
async function withTempCatalog(workflowId: string, fn: (configPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'engine-tracelog-'))
  try {
    const configPath = join(dir, `${workflowId}.yaml`)
    writeFileSync(configPath, 'schemaVersion: agent-workflow/v1\n')
    await fn(configPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Read the single run log file created under the config's sibling directory. */
function readRunLog(configPath: string, workflowId: string): string {
  const dir = join(dirname(configPath), workflowId)
  const files = readdirSync(dir).filter(f => f.endsWith('.txt'))
  assert.equal(files.length, 1, 'exactly one run log file should exist')
  assert.match(files[0]!, /^\d{8}-\d{6}-[0-9a-f-]{8}\.txt$/)
  return readFileSync(join(dir, files[0]!), 'utf8')
}

const TS = '\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\]'

test('startRun creates the trace log and writes the START line (AC1)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    const run = initialRun()
    const outcome = await h.engine.startRun('ws', run, configPath)
    assert.ok(outcome.ok)
    assert.equal(h.mem.run!.status, 'running')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`^${TS} START workflow=eng-test run=${run.runId}\\n`))
  })
})

test('trace log records a PASS routing line (AC2)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'PASS', 'planned ok', 'judge-session-1')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} NODE eng-test/plan PASS -> build\\n`))
  })
})

test('trace log records a FAIL routing line to onFail (AC3), and FAIL -> BLOCK without one', async () => {
  const FAIL_CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: try
  nodes:
    try:
      execution: { type: actor-task, role: manager, instruction: Try. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
      onFail: retry
    retry:
      execution: { type: actor-task, role: manager, instruction: Retry. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`), { workflowId: 'fail-test' })
  const failRun = (): RunState => ({
    runId: crypto.randomUUID(),
    managerSessionId: MANAGER,
    catalogWorkflowId: 'fail-test',
    definitionHash: computeDefinitionHash(FAIL_CONFIG),
    definitionSnapshot: FAIL_CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'fail-test', nodeId: 'try', nodeToken: newNodeToken() }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  })
  // FAIL with an onFail edge routes to the retry node.
  await withTempCatalog('fail-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', failRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'failed', summary: 'failed' }, MANAGER)
    const outcome = await h.engine.handleJudgeClaim('ws', token, 'FAIL', 'not good', 'judge-session-1')
    assert.ok(outcome.ok)
    assert.equal(topFrame(h.mem.run!).nodeId, 'retry')
    const log = readRunLog(configPath, 'fail-test')
    assert.match(log, new RegExp(`${TS} NODE fail-test/try FAIL -> retry\\n`))
  })
  // FAIL without an onFail edge BLOCKs and is logged as FAIL -> BLOCK.
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'failed', summary: 'failed' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'FAIL', 'not planned', 'judge-session-1')
    assert.equal(h.mem.run!.status, 'blocked')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} NODE eng-test/plan FAIL -> BLOCK\\n`))
  })
})

test('trace log covers child push/pop routing with owning workflow ids (AC2)', async () => {
  await withTempCatalog('child-test', async (configPath) => {
    const h = makeChildHarness()
    await h.engine.startRun('ws', h.childRun(), configPath)
    const beginToken = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: beginToken, outcome: 'completed', summary: 'begun' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', beginToken, 'PASS', 'begun', 'judge-session-1')
    await h.engine.handleTurnEnded('ws', MANAGER)
    let log = readRunLog(configPath, 'child-test')
    assert.match(log, new RegExp(`${TS} NODE child-test/begin PASS -> call-child\\n`))
    assert.match(log, new RegExp(`${TS} NODE child-test/call-child PUSH -> child-a\\n`))
    const childToken = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: childToken, outcome: 'completed', summary: 'done' }, 'actor-child-1')
    await h.engine.handleJudgeClaim('ws', childToken, 'PASS', 'child done', 'judge-session-1')
    log = readRunLog(configPath, 'child-test')
    assert.match(log, new RegExp(`${TS} NODE child-a/child-step PASS -> END\\n`))
    assert.match(log, new RegExp(`${TS} NODE child-test/call-child PASS -> END\\n`))
  })
})

test('log creation/append failure never breaks run startup or routing (AC4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-tracelog-blocked-'))
  try {
    const configPath = join(dir, 'eng-test.yaml')
    writeFileSync(configPath, '')
    // A regular FILE where the log directory must be created → mkdir fails.
    writeFileSync(join(dir, 'eng-test'), 'i block the log directory')
    const h = makeHarness()
    const outcome = await h.engine.startRun('ws', initialRun(), configPath)
    assert.ok(outcome.ok)
    assert.equal(h.mem.run!.status, 'running')
    assert.equal(h.steers.length, 1)
    // Routing still advances with no log file attached.
    const token = topFrame(h.mem.run!).nodeToken
    const claim = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'x' }, MANAGER)
    assert.ok(claim.ok)
    await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', 'judge-session-1')
    assert.equal(topFrame(h.mem.run!).nodeId, 'build')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
