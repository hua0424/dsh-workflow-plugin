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

function makeStateHost(mem: MemState, shouldFailPut?: () => boolean): StateHost {
  return {
    async get() {
      if (mem.run === undefined) return undefined
      return { run: structuredClone(mem.run), version: mem.version }
    },
    async put(_ws, run, expectedVersion) {
      // A3 review S4 fault injection: a persistence failure AFTER the trace
      // write makes the at-least-once crash seam observable in tests.
      if (shouldFailPut?.()) throw new Error('disk full (injected)')
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
  judgeSpawnInputs: Array<{ nodeToken: string; instruction: string; criteria: string; claim: { outcome: ClaimOutcome; summary: string }; judgeSessionId: string }>
  judgeFollowups: string[]
  retiredJudges: string[]
  drainedJudges: string[]
  judgeSpawnFailure: Error | undefined
  judgeSpawnGate: Promise<void> | undefined
  releaseJudgeSpawn: () => void
  judgeSessionExists: (id: string) => Promise<boolean>
  actorCreated: boolean
  compacts: string[]
  compactResult: { ok: boolean; detail?: string }
  /** A3: scriptable program outcomes by programId (default: ERROR no stub result). */
  programResults: Map<string, { kind: 'PASS' | 'FAIL' | 'ERROR'; reason?: string }>
  /** A3 review S4: throw from the Manager steer (dispatch failure injection). */
  steerFailure: Error | undefined
  /** A3 review S4: next N state.put calls throw (crash-seam injection). */
  failNextPuts: number
}

function makeHarness(memArg?: MemState): Harness {
  const mem: MemState = memArg ?? { version: 0 }
  const h: Harness = {
    mem,
    engine: undefined as never,
    steers: [],
    actorMessages: [],
    judges: 0,
    judgeSpawnInputs: [],
    judgeFollowups: [],
    retiredJudges: [],
    drainedJudges: [],
    judgeSpawnFailure: undefined,
    judgeSpawnGate: undefined,
    releaseJudgeSpawn: () => {},
    judgeSessionExists: async () => true,
    actorCreated: false,
    compacts: [],
    compactResult: { ok: true, detail: 'no compactable range' },
    programResults: new Map(),
    steerFailure: undefined,
    failNextPuts: 0,
  }
  const targets: DispatchTargets = {
    async steerManager(_run, text) {
      if (h.steerFailure !== undefined) throw h.steerFailure
      h.steers.push(text)
    },
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
      h.judgeSpawnInputs.push(input)
      if (h.judgeSpawnGate !== undefined) await h.judgeSpawnGate
      if (h.judgeSpawnFailure !== undefined) throw h.judgeSpawnFailure
      h.judges += 1
      // The host adapter MUST adopt the Engine-reserved child id (P1): State
      // already names this Judge before the child can run.
      return { judgeSessionId: input.judgeSessionId, messageId: 'msg-judge' }
    },
    async followupJudge(_run, _judgeSessionId, text) { h.judgeFollowups.push(text) },
    async judgeSessionExists(id) { return h.judgeSessionExists(id) },
    async retireJudge(_run, judgeSessionId) { h.retiredJudges.push(judgeSessionId) },
    async drainJudge(_run, judgeSessionId) { h.drainedJudges.push(judgeSessionId) },
    async compactRoleActor(_run, roleKey) { h.compacts.push(roleKey); return h.compactResult },
  }
  const programs: ProgramHost = {
    async run(_run, programId, _params) {
      return h.programResults.get(programId) ?? { kind: 'ERROR', reason: 'no stub result' }
    },
  }
  h.engine = new WorkflowEngine(targets, subagents, programs, makeStateHost(mem, () => {
    if (h.failNextPuts > 0) { h.failNextPuts -= 1; return true }
    return false
  }))
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

const reservedJudgeId = (h: Harness) => h.judgeSpawnInputs.at(-1)!.judgeSessionId

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
  const claimOutcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned', handoffContext: 'repo=acme/server' }, MANAGER)
  assert.ok(claimOutcome.ok)
  assert.equal(h.judges, 1)
  const judgeSessionId = h.judgeSpawnInputs[0]!.judgeSessionId
  assert.equal(h.mem.run!.judgeSessionId, judgeSessionId)
  // A4 R10: the claim is persisted with its handoff; A1 R7: the Judge packet
  // itself still receives only outcome/summary, not the handoff text.
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned', handoffContext: 'repo=acme/server' })
  assert.deepEqual(h.judgeSpawnInputs[0]!.claim, { outcome: 'completed', summary: 'planned' })
  assert.equal(h.mem.run!.status, 'running')
  // Judge submits PASS BEFORE the worker's turn settles (fast-verdict ordering).
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'PASS', 'planned ok', judgeSessionId)
  assert.ok(verdict.ok)
  assert.equal(topFrame(h.mem.run!).nodeId, 'build')
  assert.equal(h.mem.run!.judgeSessionId, undefined)
  assert.equal(h.mem.run!.pendingClaim, undefined)
  // A1 R11: PASS retires the judge (revoke-only, never a self-drain).
  assert.deepEqual(h.retiredJudges, [judgeSessionId])
  assert.deepEqual(h.drainedJudges, [])
  assert.equal(h.actorMessages.length, 0)
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.equal(h.actorMessages.length, 1)
  assert.match(h.actorMessages[0]!, /Build/)
  assert.match(h.actorMessages[0]!, /repo=acme\/server/)
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
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'PASS', 'planned ok', reservedJudgeId(h))
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
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'FAIL', 'not planned', reservedJudgeId(h))
  assert.ok(verdict.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.match(h.mem.run!.blockReason ?? '', /FAIL/)
})

test('NEED_CONTEXT verdict blocks and keeps the judge session', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const verdict = await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  assert.ok(verdict.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'missing repo')
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
})

test('resume in judgment phase with judgeSessionId followups the same judge (A4 AC3)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  const outcome = await h.engine.handleResume('ws', token, 'repo is acme/server', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
  assert.equal(h.judgeFollowups.length, 1)
  assert.match(h.judgeFollowups[0]!, /repo is acme\/server/)
  assert.equal(h.judges, 1) // no respawn
})

test('resume in judgment phase without judgeSessionId spawns a fresh judge (A4 AC4)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  // Simulate a lost judge session.
  delete h.mem.run!.judgeSessionId
  const outcome = await h.engine.handleResume('ws', token, 'repo is acme/server', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
  assert.equal(h.judges, 2) // respawned
})

test('judge_respawn drains the old judge and spawns a new one (A4 AC5)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  const oldJudge = h.mem.run!.judgeSessionId
  const outcome = await h.engine.handleRespawnJudge('ws', token, 'model swap', MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.blockReason, null)
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
  assert.deepEqual(h.drainedJudges, [oldJudge])
  assert.equal(h.judges, 2)
})

test('judge_respawn preparation failure leaves the old blocked Judge mapping untouched', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  const oldJudge = h.mem.run!.judgeSessionId
  const drainsBefore = h.drainedJudges.length
  h.engine.cwdResolver = async () => { throw new Error('cwd unavailable') }

  await assert.rejects(
    h.engine.handleRespawnJudge('ws', token, 'retry', MANAGER),
    /cwd unavailable/,
  )
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.judgeSessionId, oldJudge)
  assert.equal(h.drainedJudges.length, drainsBefore)
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
  assert.ok(h.steers.some(t => /没有可 followup 的 Judge/.test(t)))
  // A4 R9: pendingClaim persisted at judgment entry survives the spawn fault.
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
  // A4 R4/R8: the reserved id belongs to a child that was never successfully
  // admitted; clear it so node_resume takes the spawn-rebuild branch rather
  // than trying to followup a Judge that does not exist.
  assert.equal(h.mem.run!.judgeSessionId, undefined)
})

test('spawn failure clears the never-admitted reserved Judge id so node_resume rebuilds (A4 R4/R8)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  h.judgeSpawnFailure = new Error('provider down')
  const failed = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  assert.ok(failed.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.judgeSessionId, undefined)
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })

  h.judgeSpawnFailure = undefined
  const resumed = await h.engine.handleResume('ws', token, 'spawn again', MANAGER)
  assert.ok(resumed.ok)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.judges, 1)
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
})

test('judge turn ended without judge_claim blocks with a fault detail and KEEPS judgeSessionId (A4 R5)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const outcome = await h.engine.handleJudgeTurnEnded('ws', reservedJudgeId(h), 'max-tokens')
  assert.ok(outcome !== undefined && outcome.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.match(h.mem.run!.blockReason ?? '', /judge fault: max-tokens/)
  // A4 R5: the engine must NOT auto-clear judgeSessionId — followup stays
  // reachable for the Manager's node_resume decision.
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned' })
  // A4 R8: with judgeSessionId kept, node_resume followups the same judge.
  const resumed = await h.engine.handleResume('ws', token, 'retry with context', MANAGER)
  assert.ok(resumed.ok)
  assert.equal(h.judgeFollowups.length, 1)
  assert.equal(h.judges, 1) // followup, not spawn-rebuild
})

test('stale judge spawn is drained when the run changes during materialization (A1 R11)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  // Hold the Judge admission after the Engine has already persisted its
  // reserved id, then invalidate the row through the non-queued reset path.
  h.judgeSpawnGate = new Promise<void>(resolve => { h.releaseJudgeSpawn = resolve })
  const claimPromise = h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(h.mem.run!.judgeSessionId, undefined)
  await h.engine.handleReset('ws')
  h.releaseJudgeSpawn()
  const outcome = await claimPromise
  assert.ok(!outcome.ok)
  assert.match(outcome.reason ?? '', /stale judge spawn/)
  assert.deepEqual(h.drainedJudges, [reservedJudgeId(h)])
})

test('failed stale respawn cannot block a replacement run', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))

  h.judgeSpawnGate = new Promise<void>(resolve => { h.releaseJudgeSpawn = resolve })
  const respawnPromise = h.engine.handleRespawnJudge('ws', token, 'model swap', MANAGER)
  await new Promise(resolve => setImmediate(resolve))
  h.judgeSpawnFailure = new Error('provider failed late')
  await h.engine.handleReset('ws')
  const replacement = initialRun()
  replacement.runId = crypto.randomUUID()
  await h.engine.startRun('ws', replacement)
  const replacementRunId = h.mem.run!.runId
  h.releaseJudgeSpawn()

  const outcome = await respawnPromise
  assert.ok(!outcome.ok)
  assert.match(outcome.reason ?? '', /stale judge respawn/)
  assert.equal(h.mem.run!.runId, replacementRunId)
  assert.equal(h.mem.run!.status, 'running')
  assert.equal(h.mem.run!.blockReason, null)
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

test('restart reconciliation clears a reserved Judge id whose Session never materialized', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const reserved = h.mem.run!.judgeSessionId
  assert.ok(reserved !== undefined)
  // Host crash before admission: the id exists in State but no Session exists.
  h.judgeSessionExists = async () => false
  await h.engine.handleRestartReconcile()
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'host-restarted-before-node-result')
  assert.equal(h.mem.run!.judgeSessionId, undefined)
  // node_resume must now rebuild a Judge instead of following up the phantom.
  const resumed = await h.engine.handleResume('ws', token, 'rebuild after restart', MANAGER)
  assert.ok(resumed.ok)
  assert.equal(h.mem.run!.judgeSessionId, reservedJudgeId(h))
  assert.notEqual(h.mem.run!.judgeSessionId, reserved)
})

test('restart reconciliation keeps an existing Judge session id', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  const reserved = h.mem.run!.judgeSessionId
  assert.ok(reserved !== undefined)
  await h.engine.handleRestartReconcile()
  assert.equal(h.mem.run!.judgeSessionId, reserved)
})

test('restart reconciliation contains a row conflict and continues with later workspaces', async () => {
  const runA = initialRun()
  const runB = initialRun()
  runB.runId = crypto.randomUUID()
  const rows = new Map<string, { run: RunState; version: number }>([
    ['a', { run: structuredClone(runA), version: 1 }],
    ['b', { run: structuredClone(runB), version: 1 }],
  ])
  const state: StateHost = {
    async get(key) {
      const row = rows.get(key)
      return row === undefined ? undefined : { run: structuredClone(row.run), version: row.version }
    },
    async put(key, run, expectedVersion) {
      if (key === 'a') throw new Error('simulated StateVersionError')
      const row = rows.get(key)!
      assert.equal(row.version, expectedVersion)
      rows.set(key, { run: structuredClone(run), version: expectedVersion + 1 })
    },
    async create(key, run) { rows.set(key, { run: structuredClone(run), version: 1 }); return 1 },
    async remove(key) { rows.delete(key) },
    async listRuns() {
      return [...rows].map(([workspaceKey, row]) => ({ workspaceKey, run: structuredClone(row.run), version: row.version }))
    },
  }
  const subagents: SubagentHost = {
    async ensureRoleActor() { return { childId: 'a', messageId: 'm' } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'm' } },
    async followupJudge() {},
    async judgeSessionExists() { return true },
    async retireJudge() {},
    async drainJudge() {},
    async compactRoleActor() { return { ok: true } },
  }
  const engine = new WorkflowEngine(
    { async steerManager() {}, async sendRoleActor() { return { messageId: 'm' } }, managerSessionSeq() { return 0 } },
    subagents,
    { async run() { return { kind: 'ERROR', reason: 'unused' } } },
    state,
  )

  await engine.handleRestartReconcile()
  assert.equal(rows.get('a')!.run.status, 'running', 'conflicted row is left to its winning writer')
  assert.equal(rows.get('b')!.run.status, 'blocked', 'later row is still reconciled')
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
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', reservedJudgeId(h))
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
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', reservedJudgeId(h))
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
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', reservedJudgeId(h))
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
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', reservedJudgeId(h))
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
  // A4 R10: the handoff is persisted inside pendingClaim (方案 2) — visible
  // even while the judgment is pending.
  assert.deepEqual(h.mem.run!.pendingClaim, { outcome: 'completed', summary: 'planned', handoffContext: 'repo=acme/server' })
  // Judge needs context → BLOCK → Manager resumes (token rotates) → judge PASS.
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  const resumed = await h.engine.handleResume('ws', token, 'repo is acme/server', MANAGER)
  assert.ok(resumed.ok)
  const rotated = topFrame(h.mem.run!).nodeToken
  assert.notEqual(rotated, token)
  const verdict = await h.engine.handleJudgeClaim('ws', rotated, 'PASS', 'ok now', reservedJudgeId(h))
  assert.ok(verdict.ok)
  // The handoff keyed under the PRE-rotation token must still reach the next
  // node's dispatch message.
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(h.actorMessages.length >= 1)
  assert.match(h.actorMessages[0]!, /repo=acme\/server/)
  // A4 R9/R10: the verdict cleared pendingClaim (handoff included).
  assert.equal(h.mem.run!.pendingClaim, undefined)
})

test('handoffContext survives a host-restart-equivalent: a fresh engine over durable state (方案 2)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', {
    nodeToken: token, outcome: 'completed', summary: 'planned',
    handoffContext: 'repo=acme/server',
  }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'missing repo', reservedJudgeId(h))
  // "Restart": build a brand-new engine over the SAME durable state (no
  // in-memory dispatch book, no handoffByToken — the old map is gone).
  const h2 = makeHarness()
  h2.mem = h.mem
  h2.engine = new WorkflowEngine(
    {
      async steerManager(_run, text) { h2.steers.push(text) },
      async sendRoleActor(_run, _role, text) { h2.actorMessages.push(text); return { messageId: `m-${h2.actorMessages.length}` } },
      managerSessionSeq() { return 0 },
    },
    {
      async ensureRoleActor(_run, _role, initialText) { h2.actorCreated = true; h2.actorMessages.push(initialText); return { childId: 'actor-child-1', messageId: 'msg-actor' } },
      async startJudge() { h2.judges += 1; return { judgeSessionId: reservedJudgeId(h), messageId: 'msg-judge' } },
      async followupJudge() {},
      async judgeSessionExists() { return true },
      async retireJudge() {},
      async drainJudge() {},
      async compactRoleActor() { return { ok: true, detail: 'cold-resume skip' } },
    },
    { async run() { return { kind: 'ERROR', reason: 'unused' } } },
    makeStateHost(h2.mem),
  )
  h2.engine.cwdResolver = async () => '/workspace'
  const blockedToken = topFrame(h2.mem.run!).nodeToken
  const resumed = await h2.engine.handleResume('ws', blockedToken, 'repo is acme/server', MANAGER)
  assert.ok(resumed.ok)
  const rotated = topFrame(h2.mem.run!).nodeToken
  const verdict = await h2.engine.handleJudgeClaim('ws', rotated, 'PASS', 'ok now', reservedJudgeId(h))
  assert.ok(verdict.ok)
  // The handoff persisted in pendingClaim survives the engine restart and
  // reaches the next node's dispatch.
  await h2.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(h2.actorMessages.length >= 1)
  assert.match(h2.actorMessages[0]!, /repo=acme\/server/)
})

test('first role creation skips compact (A2 AC3)', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', reservedJudgeId(h))
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
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'm' } },
    async followupJudge() {},
    async judgeSessionExists() { return true },
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
  await engine.handleJudgeClaim('ws', token, 'PASS', 'ok', h.mem.run!.judgeSessionId!)
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
  await h.engine.handleJudgeClaim('ws', beginToken, 'PASS', 'begun', reservedJudgeId(h))
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
  await h.engine.handleJudgeClaim('ws', beginToken, 'PASS', 'begun', reservedJudgeId(h))
  await h.engine.handleTurnEnded('ws', MANAGER)
  const childToken = topFrame(h.mem.run!).nodeToken
  await h.engine.handleClaim('ws', { nodeToken: childToken, outcome: 'completed', summary: 'done' }, 'actor-child-1')
  const outcome = await h.engine.handleJudgeClaim('ws', childToken, 'PASS', 'child done', reservedJudgeId(h))
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'completed')
  assert.equal(h.mem.run!.callStack.length, 0)
  // Completion notification is steered to the Manager.
  assert.ok(h.steers.some(t => /已完成/.test(t)), 'manager should get a completion steer')
})

// ---- run trace log (issue #2 / PRD workflow-run-logging R1-R4; A3 PRD
// docs/prd/20260903-workflow-hardening/a3-workflow-trace-observability.md) ----

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
const TOK = '[0-9a-f]{8}'

test('startRun creates the trace log and writes the START line with fmt=2 (AC1)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    const run = initialRun()
    const outcome = await h.engine.startRun('ws', run, configPath)
    assert.ok(outcome.ok)
    assert.equal(h.mem.run!.status, 'running')
    // A3: the log path is durable on the row, so later events (any engine
    // instance reading this row) reach the same file.
    const dirFiles = readdirSync(join(dirname(configPath), 'eng-test')).filter(f => f.endsWith('.txt'))
    assert.equal(h.mem.run!.traceLogPath, join(dirname(configPath), 'eng-test', dirFiles[0]!))
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`^${TS} START workflow=eng-test run=${run.runId} fmt=2\\n`))
  })
})

test('accepted claim and judge verdict produce CLAIM + JUDGE + ROUTE lines (AC1/AC3)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned', handoffContext: 'notes for build' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'PASS', 'planned ok', reservedJudgeId(h))
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} CLAIM workflow=eng-test node=plan token=${TOK} role=manager outcome=completed summary="planned" handoff="notes for build"\\n`))
    assert.match(log, new RegExp(`${TS} JUDGE workflow=eng-test node=plan token=${TOK} result=PASS reason="planned ok" judge=${TOK}\\n`))
    assert.match(log, new RegExp(`${TS} ROUTE workflow=eng-test node=plan token=${TOK} result=PASS target=build\\n`))
  })
})

test('CLAIM free text is JSON-escaped onto one line and bounded at protocol max (AC9)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    // Multi-line + quotes + backslash must stay a single escaped line.
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'failed', summary: 'line1\n"quoted" \\ done' }, MANAGER)
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} CLAIM workflow=eng-test node=plan token=${TOK} role=manager outcome=failed summary="line1\\\\n\\\\"quoted\\\\" \\\\\\\\ done" handoff=null\\n`))
    // A stale duplicate claim must not add a second CLAIM (AC2: only accepted claims).
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'stale' }, MANAGER)
    assert.equal(readRunLog(configPath, 'eng-test').split('\n').filter(l => l.includes('CLAIM')).length, 1)
  })
})

test('over-bound claim fields are truncated at the protocol max on one line (AC9)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    // Engine called directly (past the tool validation) with oversized text.
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'z'.repeat(4200) }, MANAGER)
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`summary="${'z'.repeat(4000)}…\\[truncated\\]"`))
    assert.doesNotMatch(log, /z{4001}/)
  })
})

test('FAIL routes to onFail, and FAIL -> BLOCK emits ROUTE + BLOCK source=judge (AC5)', async () => {
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
    const outcome = await h.engine.handleJudgeClaim('ws', token, 'FAIL', 'not good', reservedJudgeId(h))
    assert.ok(outcome.ok)
    assert.equal(topFrame(h.mem.run!).nodeId, 'retry')
    const log = readRunLog(configPath, 'fail-test')
    assert.match(log, new RegExp(`${TS} ROUTE workflow=fail-test node=try token=${TOK} result=FAIL target=retry\\n`))
  })
  // FAIL without an onFail edge BLOCKs: ROUTE target=BLOCK + BLOCK source=judge.
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'failed', summary: 'failed' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'FAIL', 'not planned', reservedJudgeId(h))
    assert.equal(h.mem.run!.status, 'blocked')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} ROUTE workflow=eng-test node=plan token=${TOK} result=FAIL target=BLOCK\\n`))
    assert.match(log, new RegExp(`${TS} BLOCK workflow=eng-test node=plan token=${TOK} source=judge reason="checker FAIL: not planned and no onFail edge"\\n`))
  })
})

test('JUDGE NEED_CONTEXT emits JUDGE + BLOCK source=judge, then RESUME target=judge (AC4-correction base/AC5/AC6)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'need repo link', reservedJudgeId(h))
    assert.equal(h.mem.run!.status, 'blocked')
    let log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} JUDGE workflow=eng-test node=plan token=${TOK} result=NEED_CONTEXT reason="need repo link" judge=${TOK}\\n`))
    assert.match(log, new RegExp(`${TS} BLOCK workflow=eng-test node=plan token=${TOK} source=judge reason="need repo link"\\n`))
    // Manager resumes the judgment phase → followup the SAME judge.
    const resumed = await h.engine.handleResume('ws', token, 'repo is github.com/x/y', MANAGER)
    assert.ok(resumed.ok)
    log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} RESUME workflow=eng-test node=plan oldToken=${TOK} newToken=${TOK} target=judge context="repo is github.com/x/y"\\n`))
  })
})

test('node_block by the Manager emits BLOCK source=manager; actor-path resume emits RESUME target=actor (AC5/AC6)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleBlock('ws', token, 'waiting on external review', MANAGER)
    assert.equal(h.mem.run!.status, 'blocked')
    let log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} BLOCK workflow=eng-test node=plan token=${TOK} source=manager reason="waiting on external review"\\n`))
    const resumed = await h.engine.handleResume('ws', token, 'review done, continue', MANAGER)
    assert.ok(resumed.ok)
    log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} RESUME workflow=eng-test node=plan oldToken=${TOK} newToken=${TOK} target=actor context="review done, continue"\\n`))
  })
})

test('actor turn ending without a result emits BLOCK source=actor (AC5: no 52-minute silence)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    await h.engine.handleTurnEnded('ws', MANAGER)
    assert.equal(h.mem.run!.status, 'blocked')
    assert.equal(h.mem.run!.blockReason, 'actor-turn-ended-without-result')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} BLOCK workflow=eng-test node=plan token=${TOK} source=actor reason="actor-turn-ended-without-result"\\n`))
  })
})

test('judge_respawn emits RESPAWN with the fresh judge prefix (AC6)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'unclear', reservedJudgeId(h))
    const respawned = await h.engine.handleRespawnJudge('ws', token, 'judge model stuck in a loop', MANAGER)
    assert.ok(respawned.ok)
    const newJudge = h.mem.run!.judgeSessionId!
    assert.notEqual(newJudge, undefined)
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} RESPAWN workflow=eng-test node=plan token=${TOK} judge=${newJudge.slice(0, 8)} reason="judge model stuck in a loop"\\n`))
  })
})

test('trace log covers child PUSH/POP with explicit pairing (AC7)', async () => {
  await withTempCatalog('child-test', async (configPath) => {
    const h = makeChildHarness()
    await h.engine.startRun('ws', h.childRun(), configPath)
    const beginToken = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: beginToken, outcome: 'completed', summary: 'begun' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', beginToken, 'PASS', 'begun', reservedJudgeId(h))
    await h.engine.handleTurnEnded('ws', MANAGER)
    let log = readRunLog(configPath, 'child-test')
    assert.match(log, new RegExp(`${TS} ROUTE workflow=child-test node=begin token=${TOK} result=PASS target=call-child\\n`))
    assert.match(log, new RegExp(`${TS} PUSH parent=child-test/call-child token=${TOK} child=child-a\\n`))
    const childToken = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: childToken, outcome: 'completed', summary: 'done' }, 'actor-child-1')
    await h.engine.handleJudgeClaim('ws', childToken, 'PASS', 'child done', reservedJudgeId(h))
    log = readRunLog(configPath, 'child-test')
    assert.match(log, new RegExp(`${TS} ROUTE workflow=child-a node=child-step token=${TOK} result=PASS target=END\\n`))
    assert.match(log, new RegExp(`${TS} POP child=child-a result=PASS parent=child-test/call-child token=${TOK}\\n`))
    assert.match(log, new RegExp(`${TS} ROUTE workflow=child-test node=call-child token=${TOK} result=PASS target=END\\n`))
  })
})

test('builtin program outcomes emit PROGRAM (+BLOCK on ERROR) and RESOLVE on manual fix (AC8/AC6)', async () => {
  const PROG_TRACE_CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Begin. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: prog
    prog:
      execution: { type: builtin-program, programId: github.initialize-milestone }
      onPass: END
`), { workflowId: 'prog-test' })
  await withTempCatalog('prog-test', async (configPath) => {
    const h = makeHarness()
    const run: RunState = {
      runId: crypto.randomUUID(),
      managerSessionId: MANAGER,
      catalogWorkflowId: 'prog-test',
      definitionHash: computeDefinitionHash(PROG_TRACE_CONFIG),
      definitionSnapshot: PROG_TRACE_CONFIG,
      status: 'running',
      callStack: [{ workflowId: 'prog-test', nodeId: 'plan', nodeToken: newNodeToken() }],
      roleActors: {}, modelOverrides: {}, blockReason: null,
      nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
    }
    await h.engine.startRun('ws', run, configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'begun' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'PASS', 'begun', reservedJudgeId(h))
    await h.engine.handleTurnEnded('ws', MANAGER)
    const progToken = topFrame(h.mem.run!).nodeToken
    // ERROR → PROGRAM + BLOCK source=program.
    await h.engine.handleRunProgram('ws', progToken, {}, MANAGER)
    assert.equal(h.mem.run!.status, 'blocked')
    let log = readRunLog(configPath, 'prog-test')
    assert.match(log, new RegExp(`${TS} PROGRAM workflow=prog-test node=prog token=${TOK} program=github.initialize-milestone result=ERROR reason="no stub result"\\n`))
    assert.match(log, new RegExp(`${TS} BLOCK workflow=prog-test node=prog token=${TOK} source=program reason="program github.initialize-milestone ERROR: no stub result"\\n`))
    // Manual resolve PASS → RESOLVE + ROUTE to END.
    await h.engine.handleResolveProgram('ws', progToken, 'PASS', 'verified milestone exists', MANAGER)
    log = readRunLog(configPath, 'prog-test')
    assert.match(log, new RegExp(`${TS} RESOLVE workflow=prog-test node=prog token=${TOK} result=PASS reason="verified milestone exists"\\n`))
    assert.match(log, new RegExp(`${TS} ROUTE workflow=prog-test node=prog token=${TOK} result=PASS target=END\\n`))
  })
})

test('model override emits MODEL with ids only (AC6/AC10)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const outcome = await h.engine.handleSetRoleModel('ws', 'judge', 'deepseek', 'glm-4.7', MANAGER)
    assert.ok(outcome.ok)
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} MODEL workflow=eng-test role=judge provider=deepseek model=glm-4.7\\n`))
  })
})

test('host-restart reconcile emits BLOCK source=restart into the SAME log via the durable traceLogPath (AC5/AC6)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    // A FRESH engine over the same durable state = post-restart process.
    const h2 = makeHarness(h.mem)
    await h2.engine.handleRestartReconcile()
    assert.equal(h.mem.run!.status, 'blocked')
    assert.equal(h.mem.run!.blockReason, 'host-restarted-before-node-result')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} BLOCK workflow=eng-test node=plan token=${TOK} source=restart reason="host-restarted-before-node-result"\\n`))
  })
})

test('log creation/append failure never breaks run startup or routing, and warns once (AC11/§10)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-tracelog-blocked-'))
  try {
    const configPath = join(dir, 'eng-test.yaml')
    writeFileSync(configPath, '')
    // A regular FILE where the log directory must be created → mkdir fails.
    writeFileSync(join(dir, 'eng-test'), 'i block the log directory')
    const h = makeHarness()
    const warnings: string[] = []
    h.engine.traceWarn = (m) => { warnings.push(m) }
    const outcome = await h.engine.startRun('ws', initialRun(), configPath)
    assert.ok(outcome.ok)
    assert.equal(h.mem.run!.status, 'running')
    assert.equal(h.mem.run!.traceLogPath, undefined, 'no trace path persists on the row')
    assert.equal(h.steers.length, 1)
    assert.equal(warnings.length, 1, 'creation failure warns exactly once')
    assert.match(warnings[0]!, /trace log creation failed/)
    // Routing still advances with no log file attached.
    const token = topFrame(h.mem.run!).nodeToken
    const claim = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'x' }, MANAGER)
    assert.ok(claim.ok)
    await h.engine.handleJudgeClaim('ws', token, 'PASS', 'ok', reservedJudgeId(h))
    assert.equal(topFrame(h.mem.run!).nodeId, 'build')
    // No further warnings (no spam loop).
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---- A3 review fixes (S1 injection / AC10 credential fixture / S4 crash seam) ----

test('untrusted raw identifier values cannot inject extra log lines (A3 review S1 / AC9)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    // A provider id starting with a quote and containing a newline tried to
    // pass the old prefix heuristic as "already escaped".
    const outcome = await h.engine.handleSetRoleModel('ws', 'judge', '"evil\nINJECTED model=m', 'real-model', MANAGER)
    assert.ok(outcome.ok)
    const log = readRunLog(configPath, 'eng-test')
    // Single MODEL line, JSON-quoted; no forged second event line.
    assert.match(log, /MODEL workflow=eng-test role=judge provider="\\"evil\\nINJECTED model=m" model=real-model\n/)
    assert.ok(!/\nINJECTED/.test(log), 'no injected line')
    assert.equal(log.split('\n').filter(l => l.includes('MODEL')).length, 1)
  })
})

test('credential-like text is redacted at the trace boundary (A3 AC10 fixture)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    // Claim summary carrying credential-shaped provider text.
    await h.engine.handleClaim('ws', {
      nodeToken: token,
      outcome: 'failed',
      summary: 'provider replied 401 for sk-abc123XYZ789def456ghi; Authorization: Bearer tokABCDEF0123456789',
    }, MANAGER)
    let log = readRunLog(configPath, 'eng-test')
    assert.ok(!log.includes('sk-abc123XYZ789def456ghi'), 'api-key-shaped text redacted')
    assert.ok(!log.includes('tokABCDEF0123456789'), 'bearer token redacted')
    assert.match(log, /summary="provider replied 401 for \[redacted\]; Authorization: \[redacted\]"/)
    // Dispatch-failure BLOCK with credential-shaped error text is redacted too.
    const h2 = makeHarness()
    h2.steerFailure = new Error('provider api_key=SUPERSECRETKEY12345 rejected')
    const outcome = await h2.engine.startRun('ws2', initialRun(), configPath)
    assert.ok(outcome.ok)
    assert.equal(h2.mem.run!.status, 'blocked')
    log = readFileSync(h2.mem.run!.traceLogPath!, 'utf8')
    assert.ok(!log.includes('SUPERSECRETKEY12345'), 'block reason redacted')
    assert.match(log, /source=dispatch reason="dispatch-failed: Error: provider api_key=\[redacted\] rejected"/)
  })
})

test('crash seam: CLAIM is written BEFORE persistence — at-least-once with a distinguishable orphan (A3 review S4 / PRD §10)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    // The acceptance put fails (host crash stand-in): the validated claim was
    // already traced, so the log holds an orphan CLAIM line while State never
    // accepted the claim. Declared semantics: at-least-once; the token prefix
    // distinguishes the orphan and State/Git/GitHub stay authoritative.
    h.failNextPuts = 1
    await assert.rejects(h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'orphan claim' }, MANAGER), /disk full/)
    assert.equal(h.mem.run!.pendingClaim, undefined, 'state never accepted the claim')
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} CLAIM workflow=eng-test node=plan token=${TOK} role=manager outcome=completed summary="orphan claim" handoff=null\\n`))
    // No JUDGE/ROUTE follows the orphan.
    assert.ok(!log.includes('JUDGE'), 'orphan CLAIM has no verdict')
  })
})

test('crash seam: RESPAWN is written BEFORE persistence — at-least-once like CLAIM (A3 review round 2 / PRD §10)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const token = topFrame(h.mem.run!).nodeToken
    await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
    await h.engine.handleJudgeClaim('ws', token, 'NEED_CONTEXT', 'unclear', reservedJudgeId(h))
    assert.equal(h.mem.run!.status, 'blocked')
    const oldJudge = h.mem.run!.judgeSessionId!
    // The respawn persistence put fails (host crash stand-in): the rebuild
    // was already traced, so the log holds an orphan RESPAWN while State
    // keeps the old blocked run + old judge (at-least-once; State wins).
    h.failNextPuts = 1
    await assert.rejects(h.engine.handleRespawnJudge('ws', token, 'rebuild', MANAGER), /disk full/)
    assert.equal(h.mem.run!.status, 'blocked', 'state never accepted the respawn')
    assert.equal(h.mem.run!.judgeSessionId, oldJudge)
    const log = readRunLog(configPath, 'eng-test')
    assert.match(log, new RegExp(`${TS} RESPAWN workflow=eng-test node=plan token=${TOK} judge=${TOK} reason="rebuild"\\n`))
  })
})

test('conflicted startRun leaves NO orphan trace file (A3 review round 2: common conflict path is clean)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    // Second start on the same workspace: the pre-check rejects BEFORE any
    // trace artifact — still exactly one log file, no orphan START.
    const again = await h.engine.startRun('ws', initialRun(), configPath)
    assert.ok(!again.ok)
    assert.match(again.ok ? '' : again.reason, /already has a running run/)
    const files = readdirSync(join(dirname(configPath), 'eng-test')).filter(f => f.endsWith('.txt'))
    assert.equal(files.length, 1, 'no orphan log file for the rejected start')
  })
})

test('credential-shaped raw identifiers (provider/model) are redacted too (A3 review round 2 / AC10)', async () => {
  await withTempCatalog('eng-test', async (configPath) => {
    const h = makeHarness()
    await h.engine.startRun('ws', initialRun(), configPath)
    const outcome = await h.engine.handleSetRoleModel('ws', 'judge', 'sk-liveSECRET123456', 'normal-model', MANAGER)
    assert.ok(outcome.ok)
    const log = readRunLog(configPath, 'eng-test')
    assert.ok(!log.includes('sk-liveSECRET123456'), 'credential-shaped provider id redacted')
    assert.match(log, /MODEL workflow=eng-test role=judge provider=\[redacted\] model=normal-model\n/)
  })
})
