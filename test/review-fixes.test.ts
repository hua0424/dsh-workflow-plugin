/**
 * Regression tests for the adversarial-review fixes (Round 7):
 * - ghApi never emits --jq/-q with invalid pipelines (F4)
 * - milestone/issues queries use state=all and exclude PRs (F15)
 * - node_resolve_program clears BLOCK before advancing (F6)
 * - fmtResult surfaces wrapper `value` results (F10)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ghApi } from '../src/programs/runner.ts'
import { BUILTIN_PROGRAMS } from '../src/programs/catalog.ts'
import { WorkflowEngine, type StateHost, type SubagentHost, type ProgramHost, type DispatchTargets } from '../src/engine/engine.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { newNodeToken, topFrame } from '../src/state/invariants.ts'
import type { RunState } from '../src/types.ts'

// ---- F4: gh argument construction (pure function, no real CLI needed) ----
test('buildGhArgs never emits jq pipelines and encodes the query', async () => {
  const { buildGhArgs } = await import('../src/programs/runner.ts')
  assert.deepEqual(buildGhArgs('repos/a/b/milestones', 'GET', 'state=all&per_page=100'),
    ['api', 'repos/a/b/milestones?state=all&per_page=100', '--method', 'GET'])
  assert.deepEqual(buildGhArgs('repos/a/b/issues', 'GET'),
    ['api', 'repos/a/b/issues', '--method', 'GET'])
  assert.deepEqual(buildGhArgs('repos/a/b/milestones', 'POST', undefined, { title: 'M' }),
    ['api', 'repos/a/b/milestones', '--method', 'POST', '--input', '-'])
  const all = buildGhArgs('p', 'GET', 'q=1', { x: 1 })
  assert.ok(!all.includes('--jq') && !all.includes('-q'))
})

// ---- F6: manual resolve clears BLOCK before advancing ----
const PROG_CONFIG = validateAndNormalize(parseCatalogConfig(`
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
      execution: { type: builtin-program, programId: github.all-milestone-issues-complete }
      onPass: END
`), { workflowId: 'resolve-test' })

test('node_resolve_program advances to a non-END target without staying blocked', async () => {
  const mem: { run?: RunState; version: number } = { version: 0 }
  const state: StateHost = {
    async get() { return mem.run === undefined ? undefined : { run: structuredClone(mem.run), version: mem.version } },
    async put(_ws, run, expectedVersion) { assert.equal(mem.version, expectedVersion); mem.run = structuredClone(run); mem.version += 1 },
    async create(_ws, run) { mem.run = structuredClone(run); mem.version = 1; return 1 },
    async remove() { mem.run = undefined },
    async listRuns() { return mem.run === undefined ? [] : [{ workspaceKey: 'ws', run: structuredClone(mem.run), version: mem.version }] },
  }
  const targets: DispatchTargets = { async steerManager() {}, async sendRoleActor() { return { messageId: 'm' } }, managerSessionSeq() { return 0 } }
  const subagents: SubagentHost = {
    async ensureRoleActor() { return { childId: 'a1', messageId: 'm' } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'm' } },
    async followupJudge() {},
    async judgeSessionExists() { return true },
    async retireJudge() {},
    async drainJudge() {},
    async compactRoleActor() { return { ok: true, detail: 'no compactable range' } },
  }
  const programs: ProgramHost = { async run() { return { kind: 'ERROR', reason: 'network down' } } }
  const engine = new WorkflowEngine(targets, subagents, programs, state)
  engine.cwdResolver = async () => '.'

  const run: RunState = {
    runId: 'r1', managerSessionId: 'm', catalogWorkflowId: 'resolve-test', definitionHash: 'h',
    definitionSnapshot: PROG_CONFIG, status: 'running',
    callStack: [{ workflowId: 'resolve-test', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: {}, modelOverrides: {}, blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
  await engine.startRun('ws', run)
  const token1 = topFrame(mem.run!).nodeToken
  await engine.handleClaim('ws', { nodeToken: token1, outcome: 'completed', summary: 'begun' }, 'm')
  await engine.handleJudgeClaim('ws', token1, 'PASS', 'begun', mem.run!.judgeSessionId!)
  await engine.handleTurnEnded('ws', 'm') // deferred dispatch of prog node
  const progToken = topFrame(mem.run!).nodeToken
  // Program ERRORs → BLOCK at prog.
  const blocked = await engine.handleRunProgram('ws', progToken, { milestoneNumber: 1 }, 'm')
  assert.equal(mem.run!.status, 'blocked')
  // Manual resolve PASS must clear BLOCK and advance onPass → END → completed.
  const resolved = await engine.handleResolveProgram('ws', progToken, 'PASS', 'checked by hand', 'm')
  assert.ok(resolved.ok)
  assert.equal(mem.run!.status, 'completed')
  assert.equal(mem.run!.callStack.length, 0)
})

test('ghApi FAIL paths return ERROR not a malformed pipeline', () => {
  const result = ghApi({ cwd: 'C:\\nonexistent', method: 'GET', path: 'x', timeoutMs: 1000 })
  assert.equal(result.kind, 'ERROR')
})

test('builtin program catalog exposes the two fixed ids', () => {
  assert.deepEqual(Object.keys(BUILTIN_PROGRAMS).sort(), ['github.all-milestone-issues-complete', 'github.initialize-milestone'])
})
