import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowEngine, type StateHost, type SubagentHost, type ProgramHost, type DispatchTargets } from '../src/engine/engine.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash } from '../src/catalog/validate.ts'
import { newNodeToken, topFrame } from '../src/state/invariants.ts'
import type { RunState, NodeClaim, JudgeResult } from '../src/types.ts'

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
  nextJudgeResult: JudgeResult | undefined
  programResults: Map<string, { kind: 'PASS' | 'FAIL' | 'ERROR'; reason?: string }>
  judgeCalledWith: Array<{ claim: NodeClaim }>
  actorCreated: boolean
}

function makeHarness(): Harness {
  const mem: MemState = { version: 0 }
  const h: Harness = {
    mem,
    engine: undefined as never,
    steers: [],
    actorMessages: [],
    judges: 0,
    nextJudgeResult: { result: 'PASS', reason: 'looks good' },
    programResults: new Map(),
    judgeCalledWith: [],
    actorCreated: false,
  }
  const targets: DispatchTargets = {
    async steerManager(_run, text) { h.steers.push(text) },
    async sendRoleActor(_run, _role, text) { h.actorMessages.push(text) },
  }
  const subagents: SubagentHost = {
    async ensureRoleActor(_run, _role, initialText) {
      h.actorCreated = true
      h.actorMessages.push(initialText)
      return 'actor-child-1'
    },
    async runJudge(_run, input) {
      h.judges += 1
      h.judgeCalledWith.push({ claim: input.claim })
      return h.nextJudgeResult
    },
  }
  const programs: ProgramHost = {
    async run(_run, programId, _params) {
      const r = h.programResults.get(programId) ?? { kind: 'ERROR', reason: 'no stub result' }
      return r
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
  }
}

test('startRun persists and dispatches the root node to the manager', async () => {
  const h = makeHarness()
  const run = initialRun()
  const outcome = await h.engine.startRun('ws', run)
  assert.ok(outcome.ok)
  assert.equal(h.steers.length, 1)
  assert.match(h.steers[0]!, /Plan/)
  assert.equal(h.mem.run!.status, 'running')
})

test('claim with PASS judge advances and defers next dispatch until turn end', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  h.nextJudgeResult = { result: 'PASS', reason: 'planned ok' }
  const outcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.judges, 1)
  assert.equal(topFrame(h.mem.run!).nodeId, 'build')
  assert.equal(h.actorMessages.length, 0)
  await h.engine.handleTurnEnded('ws', MANAGER)
  assert.equal(h.actorMessages.length, 1)
  assert.match(h.actorMessages[0]!, /Build/)
  assert.ok(h.actorCreated)
})

test('claim with FAIL and no onFail edge blocks', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  h.nextJudgeResult = { result: 'FAIL', reason: 'not planned' }
  const outcome = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.match(h.mem.run!.blockReason ?? '', /FAIL/)
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

test('stale judge verdict is discarded when the node moved meanwhile', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const token = topFrame(h.mem.run!).nodeToken
  h.nextJudgeResult = { result: 'PASS', reason: 'ok' }
  const first = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'first' }, MANAGER)
  assert.ok(first.ok)
  const second = await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'late' }, MANAGER)
  assert.ok(!second.ok)
  assert.match(second.reason ?? '', /stale/)
})

test('turn ended without any accepted result blocks the node', async () => {
  const h = makeHarness()
  await h.engine.startRun('ws', initialRun())
  const outcome = await h.engine.handleTurnEnded('ws', MANAGER)
  assert.ok(outcome !== undefined && outcome.ok)
  assert.equal(h.mem.run!.status, 'blocked')
  assert.equal(h.mem.run!.blockReason, 'actor-turn-ended-without-result')
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
  assert.equal(h.steers.length, 2)
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
  h.nextJudgeResult = { result: 'PASS', reason: 'ok' }
  await h.engine.handleClaim('ws', { nodeToken: token, outcome: 'completed', summary: 'planned' }, MANAGER)
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
  })
  return Object.assign(base, { childRun })
}

test('child-workflow pushes a frame and dispatches the child start node', async () => {
  const h = makeChildHarness()
  await h.engine.startRun('ws', h.childRun())
  const beginToken = topFrame(h.mem.run!).nodeToken
  h.nextJudgeResult = { result: 'PASS', reason: 'begun' }
  await h.engine.handleClaim('ws', { nodeToken: beginToken, outcome: 'completed', summary: 'begun' }, MANAGER)
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
  h.nextJudgeResult = { result: 'PASS', reason: 'begun' }
  await h.engine.handleClaim('ws', { nodeToken: beginToken, outcome: 'completed', summary: 'begun' }, MANAGER)
  await h.engine.handleTurnEnded('ws', MANAGER)
  const childToken = topFrame(h.mem.run!).nodeToken
  h.nextJudgeResult = { result: 'PASS', reason: 'child done' }
  const outcome = await h.engine.handleClaim('ws', { nodeToken: childToken, outcome: 'completed', summary: 'done' }, 'actor-child-1')
  assert.ok(outcome.ok)
  assert.equal(h.mem.run!.status, 'completed')
  assert.equal(h.mem.run!.callStack.length, 0)
  // Completion notification is steered to the Manager.
  assert.ok(h.steers.some(t => /已完成/.test(t)), 'manager should get a completion steer')
})
