import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeToolCall } from '../src/tools/authz.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState } from '../src/types.ts'

const CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles:
  developer: { persona: D }
  reviewer: { persona: R }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`), { workflowId: 'authz-test' })

function makeRun(): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'manager-session',
    catalogWorkflowId: 'authz-test',
    definitionHash: 'h',
    definitionSnapshot: CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'authz-test', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: { developer: 'actor-dev', reviewer: 'actor-rev' },
    modelOverrides: {},
    blockReason: null,
  }
}

test('manager may call every workflow tool', () => {
  const run = makeRun()
  for (const tool of ['node_claim', 'node_block', 'node_resume', 'node_run_program', 'node_resolve_program', 'workflow_set_role_model', 'workflow_status', 'workflow_inspect_git', 'workflow_inspect_github']) {
    const d = authorizeToolCall({ run, sessionId: 'manager-session', knownRoleOfSession: undefined, isJudgeSession: false, toolName: tool })
    assert.deepEqual(d, { allow: true, kind: 'manager' }, tool)
  }
})

test('role actor may call only claim/block/status', () => {
  const run = makeRun()
  for (const tool of ['node_claim', 'node_block', 'workflow_status']) {
    const d = authorizeToolCall({ run, sessionId: 'actor-dev', knownRoleOfSession: 'developer', isJudgeSession: false, toolName: tool })
    assert.deepEqual(d, { allow: true, kind: 'role', roleKey: 'developer' }, tool)
  }
  for (const tool of ['node_resume', 'node_run_program', 'node_resolve_program', 'workflow_set_role_model', 'workflow_inspect_git']) {
    const d = authorizeToolCall({ run, sessionId: 'actor-dev', knownRoleOfSession: 'developer', isJudgeSession: false, toolName: tool })
    assert.equal(d.allow, false, tool)
  }
})

test('cold-resumed actor (no live mapping) still resolves from roleActors table', () => {
  const run = makeRun()
  const d = authorizeToolCall({ run, sessionId: 'actor-rev', knownRoleOfSession: undefined, isJudgeSession: false, toolName: 'node_claim' })
  assert.deepEqual(d, { allow: true, kind: 'role', roleKey: 'reviewer' })
})

test('unknown session is rejected', () => {
  const run = makeRun()
  const d = authorizeToolCall({ run, sessionId: 'intruder', knownRoleOfSession: undefined, isJudgeSession: false, toolName: 'node_claim' })
  assert.equal(d.allow, false)
})

test('judge sessions may call only the two inspection wrappers', () => {
  const run = makeRun()
  for (const tool of ['workflow_inspect_git', 'workflow_inspect_github']) {
    const d = authorizeToolCall({ run, sessionId: 'judge-1', knownRoleOfSession: undefined, isJudgeSession: true, toolName: tool })
    assert.deepEqual(d, { allow: true, kind: 'judge' }, tool)
  }
  for (const tool of ['node_claim', 'node_block', 'workflow_status', 'node_resume', 'node_run_program', 'node_resolve_program', 'workflow_set_role_model']) {
    const d = authorizeToolCall({ run, sessionId: 'judge-1', knownRoleOfSession: undefined, isJudgeSession: true, toolName: tool })
    assert.equal(d.allow, false, tool)
  }
})

test('an actor id not present in roleActors is rejected even with a live mapping', () => {
  const run = makeRun()
  const d = authorizeToolCall({ run, sessionId: 'actor-stale', knownRoleOfSession: 'developer', isJudgeSession: false, toolName: 'node_claim' })
  assert.equal(d.allow, false)
})
