import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { resolveRoleModel, roleDenyList, judgeDenyList, judgeSpawnPlan, judgeLabel, JUDGE_DEFAULT_DENY, JUDGE_REQUIRED_TOOLS, JUDGE_PROTECTED_TOOLS } from '../src/roles/roles.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState } from '../src/types.ts'

const CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles:
  developer:
    persona: Developer persona.
    model: { provider: p1, modelId: m1 }
    tools: { deny: [edit, write] }
  reviewer:
    persona: Reviewer persona.
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`), { workflowId: 'role-test' })

function makeRun(): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'manager',
    catalogWorkflowId: 'role-test',
    definitionHash: 'hash',
    definitionSnapshot: CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'role-test', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
}

test('role model route resolves: override > def > inherit', () => {
  const run = makeRun()
  assert.deepEqual(resolveRoleModel(run, 'developer'), { provider: 'p1', model: 'm1' })
  assert.deepEqual(resolveRoleModel(run, 'reviewer'), {})
  run.modelOverrides['developer'] = { provider: 'p2', modelId: 'm2' }
  assert.deepEqual(resolveRoleModel(run, 'developer'), { provider: 'p2', model: 'm2' })
})

test('judge route resolves: override > def > inherit', () => {
  const run = makeRun()
  assert.deepEqual(resolveRoleModel(run, 'judge'), {})
  run.modelOverrides['judge'] = { provider: 'p3', modelId: 'm3' }
  assert.deepEqual(resolveRoleModel(run, 'judge'), { provider: 'p3', model: 'm3' })
})

test('role deny list', () => {
  const run = makeRun()
  assert.deepEqual(roleDenyList(run, 'developer'), ['edit', 'write'])
  assert.deepEqual(roleDenyList(run, 'reviewer'), [])
})

test('judge spawn plan: full catalog minus the deny list + persona + route', () => {
  const run = makeRun()
  run.modelOverrides['judge'] = { provider: 'jp', modelId: 'jm' }
  const plan = judgeSpawnPlan(run)
  assert.equal(plan.persona, 'Judge persona.')
  assert.deepEqual(plan.toolFilter.deny, [...JUDGE_DEFAULT_DENY])
  assert.deepEqual(plan.agentOptions, { provider: 'jp', model: 'jm' })
})

test('judge label carries the current node id', () => {
  assert.equal(judgeLabel('implement'), 'workflow-judge:implement')
})

test('judge deny list: defaults + catalog entries, never a required tool', () => {
  const run = makeRun()
  assert.deepEqual(judgeDenyList(run), [...JUDGE_DEFAULT_DENY])
  assert.deepEqual(judgeSpawnPlan(run).toolFilter.deny, judgeDenyList(run))
  // The default list keeps the write/control tools out and the required tools in.
  assert.ok(JUDGE_DEFAULT_DENY.includes('node_claim'))
  assert.ok(JUDGE_DEFAULT_DENY.includes('judge_respawn'))
  for (const required of JUDGE_REQUIRED_TOOLS) assert.equal(JUDGE_DEFAULT_DENY.includes(required), false, required)
  assert.ok(JUDGE_PROTECTED_TOOLS.includes('judge_claim'))
})

test('catalog judgeRole.tools.deny adds to the defaults (duplicates collapse)', () => {
  const run = makeRun()
  const withExtra = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles:
  developer: { persona: D }
judgeRole:
  persona: Judge persona.
  tools: { deny: [edit, node_claim] }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`), { workflowId: 'role-test' })
  run.definitionSnapshot = withExtra
  const deny = judgeDenyList(run)
  assert.ok(deny.includes('edit'))
  assert.equal(deny.filter(name => name === 'node_claim').length, 1)
  assert.deepEqual(judgeSpawnPlan(run).toolFilter.deny, deny)
})

test('catalog rejects denying a protected Judge tool', () => {
  for (const name of JUDGE_PROTECTED_TOOLS) {
    assert.throws(() => parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles:
  developer: { persona: D }
judgeRole:
  persona: Judge persona.
  tools: { deny: [${name}] }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`), /cannot be denied/, name)
  }
})
