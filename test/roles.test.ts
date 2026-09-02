import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { resolveRoleModel, roleDenyList, judgeSpawnPlan, judgeResultFromStructured, JUDGE_ALLOW } from '../src/roles/roles.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState } from '../src/types.ts'

const CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
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
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
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

test('judge spawn plan: fixed allow-list + persona + route', () => {
  const run = makeRun()
  run.modelOverrides['judge'] = { provider: 'jp', modelId: 'jm' }
  const plan = judgeSpawnPlan(run)
  assert.equal(plan.persona, 'Judge persona.')
  assert.deepEqual(plan.toolFilter.allow, JUDGE_ALLOW)
  assert.deepEqual(plan.agentOptions, { provider: 'jp', model: 'jm' })
})

test('judge allow-list contains exactly the fixed read-only tools', () => {
  assert.deepEqual([...JUDGE_ALLOW].sort(), ['glob', 'grep', 'read', 'read_image', 'workflow_inspect_git', 'workflow_inspect_github'].sort())
})

test('judgeResultFromStructured validates the strict output protocol', () => {
  assert.deepEqual(judgeResultFromStructured({ result: 'PASS', reason: 'ok' }), { result: 'PASS', reason: 'ok' })
  assert.equal(judgeResultFromStructured({ result: 'MAYBE', reason: 'x' }), undefined)
  assert.equal(judgeResultFromStructured({ result: 'PASS' }), undefined)
  assert.equal(judgeResultFromStructured({ result: 'PASS', reason: '  ' }), undefined)
  assert.equal(judgeResultFromStructured({ result: 'PASS', reason: 'x'.repeat(2001) }), undefined)
  assert.equal(judgeResultFromStructured(null), undefined)
})
