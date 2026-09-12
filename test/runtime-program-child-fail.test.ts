import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type ProgramHost } from '../src/engine/engine.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import type { ClaimCaller, ProgramResult, WorkflowConfig } from '../src/types.ts'

const CHECKER = { checkerId: 'judge.claim-correct', config: { criteria: 'existing criteria' } }

function programConfig(): WorkflowConfig {
  return {
    schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'Read only' },
    workflow: { startNode: 'plan', nodes: {
      plan: { execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' }, checker: CHECKER, onPass: 'program' },
      program: { execution: { type: 'builtin-program', programId: 'github.initialize-milestone', instruction: 'Initialize' }, onPass: 'after', onFail: 'repair' },
      after: { execution: { type: 'actor-task', role: 'manager', instruction: 'Continue' }, checker: CHECKER, onPass: 'END' },
      repair: { execution: { type: 'actor-task', role: 'manager', instruction: 'Repair' }, checker: CHECKER, onPass: 'END' },
    } },
  }
}

function harness(config: WorkflowConfig, programs: ProgramHost) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t7-'))
  let store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const compacts: string[] = []
  let serial = 0
  let actorSerial = 0
  let safe = true
  let activity: 'active' | 'idle' | 'unknown' = 'idle'
  const send = (sessionId: string, text: string) => {
    const messageId = `message-${++serial}`
    messages.push({ sessionId, messageId, text })
    return { messageId }
  }
  const makeEngine = () => {
    const engine = new WorkflowEngine({
      async steerManager(_run, text) { return send('manager', text) },
      async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
      managerSessionSeq() { return 0 },
    }, {
      async ensureRoleActor(_run, role, text) {
        const childId = actorSerial++ === 0 ? `${role}-session` : `${role}-replacement-${actorSerial}`
        return { childId, ...send(childId, text) }
      },
      async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, ...send(input.judgeSessionId, 'judge') } },
      async followupJudge(_run, judgeSessionId) { return send(judgeSessionId, 'judge followup') },
      async judgeSessionAvailability() { return 'available' as const }, async roleSessionAvailability() { return 'available' as const },
      async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {}, async compactRoleActor(_run, role) { compacts.push(role); return { ok: true } }, async safeToInspect() { return safe },
    }, programs, makeStateHost(store))
    engine.cwdResolver = async () => home
    engine.actorActivity = async () => activity
    return engine
  }
  let engine = makeEngine()
  const caller = (dispatch: { sessionId?: string; messageId?: string }): ClaimCaller => ({
    sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]),
  })
  return {
    home, messages, compacts, caller,
    get store() { return store }, get engine() { return engine },
    async start(input = 'root input') { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'ignored'), undefined, input) },
    async row() { return (await store.get('ws'))! },
    reopen() { store.close(); store = new StateStore(home); engine = makeEngine() },
    setSafe(value: boolean) { safe = value }, setActivity(value: 'active' | 'idle' | 'unknown') { activity = value },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

async function acceptActor(h: ReturnType<typeof harness>, handoff: string, outcome: 'completed' | 'failed' = 'completed') {
  let row = await h.row()
  const actor = h.caller(row.execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { outcome, handoff }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  row = await h.row()
  const judge = h.caller(row.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  await h.engine.handleTurnEnded('ws', judge)
}

// 已确认 seam：真实 Runtime + 临时 SQLite + 受控 Host Adapter。
function childConfig(): WorkflowConfig {
  return {
    schemaVersion: 'agent-workflow/v2', roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
    workflow: { startNode: 'plan', nodes: {
      plan: { execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' }, checker: CHECKER, onPass: 'call-child' },
      'call-child': { execution: { type: 'child-workflow', workflowId: 'child-a' }, onPass: 'after' },
      after: { execution: { type: 'actor-task', role: 'manager', instruction: 'Continue' }, checker: CHECKER, onPass: 'END' },
    } },
    childWorkflows: { 'child-a': { startNode: 'work', nodes: {
      work: { execution: { type: 'actor-task', role: 'worker', instruction: 'Child work' }, checker: CHECKER, onPass: 'END' },
    } } },
  }
}

// 已确认 seam：真实 Runtime + 临时 SQLite + 受控 Host Adapter。
test('one-level Child atomically returns its final handoff through the parent caller', async () => {
  const h = harness(childConfig(), { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'parent input')
    let row = await h.row()
    assert.equal(row.execution.workflowId, 'child-a')
    assert.equal(row.execution.nodeId, 'work')
    assert.equal(row.execution.input, 'parent input')
    assert.equal(row.run.callStack.length, 2)
    const parentExecutionId = row.run.callStack[0]!.executionId
    assert.ok(parentExecutionId)
    const parentWaiting = (await h.store.execution('ws', parentExecutionId))!
    assert.equal(parentWaiting.phase, 'working')
    assert.equal(parentWaiting.child?.executionId, row.execution.executionId)

    const actor = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'child final artifact' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    row = await h.row()
    const leafExecutionId = row.execution.executionId
    const judge = h.caller(row.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'child verified', judge)).ok, true)
    const returned = await h.row()
    assert.equal(returned.run.callStack.length, 1)
    assert.equal(returned.execution.nodeId, 'after')
    assert.equal(returned.execution.input, 'child final artifact')
    assert.equal(returned.execution.phase, 'ready')
    const parent = (await h.store.execution('ws', parentExecutionId))!
    assert.equal(parent.phase, 'exited')
    assert.equal(parent.child?.result?.terminalExecutionId, leafExecutionId)
    assert.equal(parent.child?.result?.handoff, 'child final artifact')
    await h.engine.handleTurnEnded('ws', judge)
    assert.equal((await h.row()).execution.phase, 'working')
  } finally { h.close() }
})

test('reopen resumes a registered Child caller transition exactly once', async () => {
  const h = harness(childConfig(), { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    let row = await h.row()
    const actor = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'parent input' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    row = await h.row()
    const judge = h.caller(row.execution.judge!)
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified parent', judge)
    const childCaller = await h.row()
    assert.equal(childCaller.execution.nodeId, 'call-child')
    assert.equal(childCaller.execution.phase, 'ready')
    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '恢复已登记的Child调用。', 'manager', 'auto')).ok, true)
    const child = await h.row()
    assert.equal(child.run.callStack.length, 2)
    assert.equal(child.execution.workflowId, 'child-a')
    assert.equal(child.execution.input, 'parent input')
    const parent = (await h.store.execution('ws', blocked.execution.executionId))!
    assert.equal(parent.child?.executionId, child.execution.executionId)
    assert.equal((await h.store.events('ws', parent.executionId)).filter(event => event.type === 'child-entered').length, 1)
  } finally { h.close() }
})

test('reopen resumes the stored Child top without pushing the parent again', async () => {
  const h = harness(childConfig(), { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'parent input')
    const before = await h.row()
    assert.equal(before.run.callStack.length, 2)
    const parentExecutionId = before.run.callStack[0]!.executionId
    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal(blocked.run.callStack.length, 2)
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '重启后核查Child栈顶现场。', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.callStack.length, 2)
    assert.equal(resumed.run.callStack[0]!.executionId, parentExecutionId)
    assert.equal(resumed.run.currentExecutionId, resumed.run.callStack[1]!.executionId)
    assert.equal(resumed.execution.workflowId, 'child-a')
    assert.equal(resumed.execution.input, 'parent input')
  } finally { h.close() }
})

test('nested Child unwinds one final handoff, keeps one top, and reuses the Root Role mapping', async () => {
  const config = childConfig()
  // 跨 child 边界的会话复用 + 边界 compact 是 `reuse: continuable` 的语义；缺省 node 见
  // runtime-work-order.test.ts 的「reuse: node」用例。
  config.roles.worker = { persona: 'Worker', reuse: 'continuable' }
  config.workflow.nodes.after = { execution: { type: 'actor-task', role: 'worker', instruction: 'Use child output' }, checker: CHECKER, onPass: 'END' }
  config.childWorkflows!['child-a'] = { startNode: 'call-inner', nodes: {
    'call-inner': { execution: { type: 'child-workflow', workflowId: 'child-b' }, onPass: 'END' },
  } }
  config.childWorkflows!['child-b'] = { startNode: 'work', nodes: {
    work: { execution: { type: 'actor-task', role: 'worker', instruction: 'Nested work' }, checker: CHECKER, onPass: 'END' },
  } }
  const h = harness(config, { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'nested parent input')
    let row = await h.row()
    assert.equal(row.run.callStack.length, 3)
    assert.equal(row.execution.workflowId, 'child-b')
    assert.equal(row.execution.input, 'nested parent input')
    assert.equal(row.run.currentExecutionId, row.run.callStack.at(-1)!.executionId)
    const outerCallerId = row.run.callStack[0]!.executionId
    const innerCallerId = row.run.callStack[1]!.executionId
    const leafId = row.execution.executionId
    const actor = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'deep child artifact' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    row = await h.row()
    const judge = h.caller(row.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified nested child', judge)).ok, true)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'duplicate nested child', judge)).ok, false)
    const returned = await h.row()
    assert.equal(returned.run.callStack.length, 1)
    assert.equal(returned.execution.nodeId, 'after')
    assert.equal(returned.execution.input, 'deep child artifact')
    for (const callerId of [outerCallerId, innerCallerId]) {
      const caller = (await h.store.execution('ws', callerId))!
      assert.equal(caller.phase, 'exited')
      assert.deepEqual(caller.child?.result, { terminalExecutionId: leafId, handoff: 'deep child artifact' })
    }
    assert.deepEqual(returned.run.roleActors, { worker: 'worker-session' })
    assert.equal((await h.store.list()).length, 1)
    await h.engine.handleTurnEnded('ws', judge)
    const after = await h.row()
    assert.equal(after.execution.phase, 'working')
    assert.equal(after.execution.dispatch?.sessionId, 'worker-session')
    assert.deepEqual(h.compacts, ['worker'])
  } finally { h.close() }
})

test('accepted Actor FAIL without onFail reopens the same execution instead of rejudging the old claim', async () => {
  const h = harness({
    schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'Read only' },
    workflow: { startNode: 'plan', nodes: {
      plan: { execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' }, checker: CHECKER, onPass: 'END' },
    } },
  }, { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    let row = await h.row()
    const visit = row.execution.visit
    const executionId = row.execution.executionId
    const oldActor = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'failed', handoff: 'failed with preserved evidence' }, oldActor)
    await h.engine.handleTurnEnded('ws', oldActor)
    row = await h.row()
    const oldJudge = h.caller(row.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'failure is accurate', oldJudge)).ok, true)
    let blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'settling')
    assert.equal(blocked.execution.claim?.handoff, 'failed with preserved evidence')
    assert.equal(blocked.execution.judgment?.result, 'ACCEPT')
    h.reopen()
    await h.engine.handleRestartReconcile()
    blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager fixed the external cause; reopen the work.', 'manager', 'actor')).ok, true)
    const reopened = await h.row()
    assert.equal(reopened.execution.executionId, executionId)
    assert.equal(reopened.execution.visit, visit)
    assert.equal(reopened.execution.phase, 'working')
    assert.equal(reopened.execution.claim, undefined)
    assert.equal(reopened.execution.judgment, undefined)
    assert.equal(reopened.execution.previousClaim?.handoff, 'failed with preserved evidence')
    assert.match(h.messages.at(-1)!.text, /failed with preserved evidence/)
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'late old claim' }, oldActor)).ok, false)
    assert.equal((await h.engine.handleJudgeClaim('ws', reopened.execution.nodeToken, 'ACCEPT', 'late old judgment', oldJudge)).ok, false)
  } finally { h.close() }
})

test('model override safely replaces one blocked Role once and leaves Judge replacement explicit', async () => {
  const h = harness(childConfig(), { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'parent input')
    let row = await h.row()
    const oldActor = h.caller(row.execution.dispatch!)
    const activeBefore = structuredClone(row)
    h.setSafe(true)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'early-provider', 'early-model', 'manager')).ok, false)
    assert.deepEqual(await h.row(), activeBefore)
    assert.equal((await h.engine.handleBlock('ws', row.execution.nodeToken, 'replace this blocked Role', oldActor)).ok, true)
    row = await h.row()
    h.setSafe(false)
    h.setActivity('active')
    const denied = await h.engine.handleSetRoleModel('ws', 'worker', ' next-provider ', ' next-model ', 'manager')
    assert.equal(denied.ok, false)
    assert.equal((await h.row()).run.roleActors.worker, 'worker-session')

    h.setSafe(false)
    h.setActivity('unknown')
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', ' next-provider ', ' next-model ', 'manager')).ok, true)
    row = await h.row()
    assert.deepEqual(row.run.modelOverrides.worker, { provider: 'next-provider', modelId: 'next-model' })
    assert.equal(row.run.roleActors.worker, undefined)
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, 'Use the replacement Role.', 'manager', 'actor')).ok, true)
    const replacement = await h.row()
    assert.equal(replacement.execution.dispatch?.sessionId, 'worker-replacement-2')
    assert.equal(replacement.run.roleActors.worker, 'worker-replacement-2')
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'late old Role' }, oldActor)).ok, false)

    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'next-provider', 'next-model', 'manager')).ok, true)
    assert.equal((await h.row()).run.roleActors.worker, 'worker-replacement-2', 'same override is idempotent and does not replace again')
    const beforeJudgeOverride = await h.row()
    assert.equal((await h.engine.handleSetRoleModel('ws', 'judge', 'judge-provider', 'judge-model', 'manager')).ok, true)
    const judgeOverride = await h.row()
    assert.deepEqual(judgeOverride.run.modelOverrides.judge, { provider: 'judge-provider', modelId: 'judge-model' })
    assert.deepEqual(judgeOverride.execution.dispatch, beforeJudgeOverride.execution.dispatch)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'ghost', 'p', 'm', 'manager')).ok, false)
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'not-manager')).ok, false)
  } finally { h.close() }
})

test('terminal Program and Child expose their effective final handoff through status', async () => {
  const programDefinition = programConfig()
  programDefinition.workflow.nodes.program!.onPass = 'END'
  delete programDefinition.workflow.nodes.after
  const program = harness(programDefinition, { async run() { return { kind: 'PASS', handoff: 'program final artifact' } } })
  try {
    await program.start()
    await acceptActor(program, 'approved plan')
    const row = await program.row()
    await program.engine.handleRunProgram('ws', row.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')
    const status = await program.engine.status('ws', 'manager')
    assert.equal(status.status.finalHandoffPreview, 'program final artifact')
  } finally { program.close() }

  const childDefinition = childConfig()
  childDefinition.workflow.nodes['call-child']!.onPass = 'END'
  delete childDefinition.workflow.nodes.after
  const child = harness(childDefinition, { async run() { throw new Error('unexpected Program') } })
  try {
    await child.start()
    await acceptActor(child, 'parent input')
    let row = await child.row()
    const actor = child.caller(row.execution.dispatch!)
    await child.engine.handleClaim('ws', { outcome: 'completed', handoff: 'child final artifact' }, actor)
    await child.engine.handleTurnEnded('ws', actor)
    row = await child.row()
    await child.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified child', child.caller(row.execution.judge!))
    const status = await child.engine.status('ws', 'manager')
    assert.equal(status.status.finalHandoffPreview, 'child final artifact')
  } finally { child.close() }
})

test('Program parameters persist before effect and explicit bounded handoff becomes successor input', async () => {
  let inspected: Awaited<ReturnType<StateStore['get']>>
  let h!: ReturnType<typeof harness>
  const programs: ProgramHost = {
    async run(): Promise<ProgramResult> {
      inspected = await h.store.get('ws')
      return { kind: 'PASS', handoff: 'milestone #7 on branch feature/t7', details: { mustNotBecomeInput: true } }
    },
  }
  h = harness(programConfig(), programs)
  try {
    assert.equal((await h.start()).ok, true)
    await acceptActor(h, 'approved plan')
    const program = await h.row()
    assert.equal(program.execution.nodeId, 'program')
    const outcome = await h.engine.handleRunProgram('ws', program.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')
    assert.equal(outcome.ok, true)
    assert.deepEqual(inspected!.execution.program?.parameters, { title: 'M7', branchName: 'feature/t7' })
    const after = await h.row()
    assert.equal(after.execution.nodeId, 'after')
    assert.equal(after.execution.phase, 'working')
    assert.ok(after.execution.dispatch?.messageId)
    assert.equal(after.execution.input, 'milestone #7 on branch feature/t7')
    assert.doesNotMatch(after.execution.input, /mustNotBecomeInput/)
    assert.deepEqual((await h.store.events('ws', program.execution.executionId)).slice(-2).map(event => event.type), ['program-result', 'exited'])
    h.store.close()
    const reopened = new StateStore(h.home)
    try {
      const durable = (await reopened.get('ws'))!
      assert.equal(durable.execution.input, 'milestone #7 on branch feature/t7')
      assert.equal((await reopened.execution('ws', program.execution.executionId))?.program?.result?.kind, 'PASS')
    } finally { reopened.close() }
  } finally { h.close() }
})

test('Program without a new handoff passes through input and never stringifies details', async () => {
  const h = harness(programConfig(), { async run() { return { kind: 'PASS', details: { opaque: 'must-not-leak' } } } })
  try {
    await h.start('original root input')
    await acceptActor(h, 'approved plan')
    const program = await h.row()
    assert.equal((await h.engine.handleRunProgram('ws', program.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')).ok, true)
    const after = await h.row()
    assert.equal(after.execution.input, 'approved plan')
    assert.doesNotMatch(after.execution.input, /opaque|must-not-leak/)
  } finally { h.close() }
})

test('Program ERROR retains parameters across reopen and manual resolution routes once with audited reason', async () => {
  const h = harness(programConfig(), { async run() { return { kind: 'ERROR', reason: 'remote response was uncertain' } } })
  try {
    await h.start()
    await acceptActor(h, 'approved plan')
    let row = await h.row()
    assert.equal((await h.engine.handleRunProgram('ws', row.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')).ok, true)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.equal(row.execution.phase, 'settling')
    assert.deepEqual(row.execution.program?.parameters, { title: 'M7', branchName: 'feature/t7' })
    assert.deepEqual(row.execution.program?.result, { kind: 'ERROR', reason: 'remote response was uncertain' })
    h.store.close()
    const reopened = new StateStore(h.home)
    const engine = new WorkflowEngine({
      async steerManager() { return { messageId: 'manual-next' } }, async sendRoleActor() { return { messageId: 'unused' } }, managerSessionSeq() { return 0 },
    }, {
      async ensureRoleActor() { return { childId: 'unused', messageId: 'unused' } },
      async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge' } }, async followupJudge() { return { messageId: 'followup' } },
      async judgeSessionAvailability() { return 'available' }, async roleSessionAvailability() { return 'available' },
      async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {}, async compactRoleActor() { return { ok: true } }, async safeToInspect() { return true },
    }, { async run() { throw new Error('manual resolution must not run Program') } }, makeStateHost(reopened))
    engine.cwdResolver = async () => h.home
    try {
      row = (await reopened.get('ws'))!
      const resolved = await engine.handleResolveProgram('ws', row.execution.nodeToken, 'PASS', 'Manager verified milestone and branch', 'manager')
      assert.equal(resolved.ok, true)
      const after = (await reopened.get('ws'))!
      assert.equal(after.execution.nodeId, 'after')
      assert.equal(after.execution.input, 'approved plan')
      const previous = await reopened.execution('ws', row.execution.executionId)
      assert.equal(previous?.program?.result?.reason, 'Manager verified milestone and branch')
      assert.equal((await engine.handleResolveProgram('ws', row.execution.nodeToken, 'PASS', 'duplicate', 'manager')).ok, false)
    } finally { reopened.close() }
  } finally { h.close() }
})

test('Program FAIL routes its explicit handoff through onFail without a Judge', async () => {
  const h = harness(programConfig(), { async run() { return { kind: 'FAIL', reason: 'milestone is closed', handoff: 'repair milestone #7' } } })
  try {
    await h.start()
    await acceptActor(h, 'approved plan')
    const program = await h.row()
    const judgesBefore = h.messages.filter(message => message.text === 'judge').length
    assert.equal((await h.engine.handleRunProgram('ws', program.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')).ok, true)
    const repair = await h.row()
    assert.equal(repair.execution.nodeId, 'repair')
    assert.equal(repair.execution.input, 'repair milestone #7')
    assert.equal(h.messages.filter(message => message.text === 'judge').length, judgesBefore)
  } finally { h.close() }
})

test('Program FAIL without onFail retains its result in settling BLOCK', async () => {
  const config = programConfig()
  const program = config.workflow.nodes.program!
  delete (program as { onFail?: string }).onFail
  delete config.workflow.nodes.repair
  const h = harness(config, { async run() { return { kind: 'FAIL', reason: 'milestone is closed', handoff: 'repair milestone #7' } } })
  try {
    await h.start()
    await acceptActor(h, 'approved plan')
    const before = await h.row()
    assert.equal((await h.engine.handleRunProgram('ws', before.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')).ok, true)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.executionId, before.execution.executionId)
    assert.equal(blocked.execution.phase, 'settling')
    assert.deepEqual(blocked.execution.program?.result, { kind: 'FAIL', reason: 'milestone is closed', handoff: 'repair milestone #7' })
    assert.equal(blocked.execution.successorId, undefined)
  } finally { h.close() }
})

test('accepted Actor failed→END completes the root with failed-terminal wording (#17)', async () => {
  const h = harness({
    schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'Read only' },
    workflow: { startNode: 'plan', nodes: {
      plan: { execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' }, checker: CHECKER, onPass: 'END', onFail: 'END' },
    } },
  }, { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'user cancelled after review', 'failed')
    const row = await h.row()
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.callStack, [])
    assert.equal(row.execution.claim?.handoff, 'user cancelled after review')
    assert.equal(row.execution.judgment?.result, 'ACCEPT')
    const terminal = h.messages.at(-1)!.text
    assert.match(terminal, /以失败结果结束/)
    assert.match(terminal, /FAIL→END/)
    assert.match(terminal, /user cancelled after review/)
    assert.doesNotMatch(terminal, /已完成（run/)
  } finally { h.close() }
})

test('builtin FAIL→END completes the root without a Judge (#17)', async () => {
  const config = programConfig()
  config.workflow.nodes.program!.onFail = 'END'
  delete config.workflow.nodes.repair
  const h = harness(config, { async run() { return { kind: 'FAIL', reason: 'milestone is closed', handoff: 'cancelled: no work to do' } } })
  try {
    await h.start()
    await acceptActor(h, 'approved plan')
    const program = await h.row()
    const judgesBefore = h.messages.filter(message => message.text === 'judge').length
    assert.equal((await h.engine.handleRunProgram('ws', program.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')).ok, true)
    const row = await h.row()
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.callStack, [])
    assert.equal(h.messages.filter(message => message.text === 'judge').length, judgesBefore)
    const terminal = h.messages.at(-1)!.text
    assert.match(terminal, /以失败结果结束/)
    assert.match(terminal, /cancelled: no work to do/)
    const status = await h.engine.status('ws', 'manager')
    assert.equal(status.status.finalHandoffPreview, 'cancelled: no work to do')
  } finally { h.close() }
})

test('nested Child failed→END returns to the parent onPass with the child handoff (#17)', async () => {
  const config = childConfig()
  config.childWorkflows!['child-a'] = { startNode: 'work', nodes: {
    work: { execution: { type: 'actor-task', role: 'worker', instruction: 'Child work' }, checker: CHECKER, onPass: 'nowhere', onFail: 'END' },
  } }
  // 子图自带一条悬空 onPass 目标时校验仍应拒绝：未知目标不可用 END 绕过。
  assert.throws(() => validateAndNormalize(structuredClone(config), { workflowId: 'test' }), /does not exist/)
  config.childWorkflows!['child-a'] = { startNode: 'work', nodes: {
    work: { execution: { type: 'actor-task', role: 'worker', instruction: 'Child work' }, checker: CHECKER, onPass: 'END', onFail: 'END' },
  } }
  const h = harness(config, { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'parent input')
    let row = await h.row()
    assert.equal(row.execution.workflowId, 'child-a')
    assert.equal(row.run.callStack.length, 2)
    const parentExecutionId = row.run.callStack[0]!.executionId
    // 子流程内 FAIL 被 ACCEPT 后走 onFail→END：pop 回父 onPass，不把 failed 传播成父失败。
    // 注：acceptActor 内已含 handleTurnEnded（与既有单层 Child 测试一致），后继已派发为 working。
    let childRow = await h.row()
    const childActor = h.caller(childRow.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'failed', handoff: 'no deliverable issues remain' }, childActor)
    await h.engine.handleTurnEnded('ws', childActor)
    childRow = await h.row()
    const childJudge = h.caller(childRow.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', childRow.execution.nodeToken, 'ACCEPT', 'honest failure', childJudge)).ok, true)
    const returned = await h.row()
    assert.equal(returned.run.callStack.length, 1)
    assert.equal(returned.execution.nodeId, 'after')
    assert.equal(returned.execution.input, 'no deliverable issues remain')
    assert.equal(returned.execution.phase, 'ready')
    assert.equal(returned.run.status, 'running')
    const parent = (await h.store.execution('ws', parentExecutionId))!
    assert.equal(parent.phase, 'exited')
    assert.equal(parent.child?.result?.handoff, 'no deliverable issues remain')
    await h.engine.handleTurnEnded('ws', childJudge)
    assert.equal((await h.row()).execution.phase, 'working')
  } finally { h.close() }
})

test('explicit Program retry rotates invocation identity and ignores the late first result', async () => {
  const first = Promise.withResolvers<ProgramResult>()
  const entered = Promise.withResolvers<void>()
  let calls = 0
  const h = harness(programConfig(), {
    async run() {
      if (++calls === 1) { entered.resolve(); return first.promise }
      return { kind: 'PASS', handoff: 'retry result' }
    },
  })
  try {
    await h.start()
    await acceptActor(h, 'approved plan')
    let row = await h.row()
    const firstCall = h.engine.handleRunProgram('ws', row.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')
    await entered.promise
    row = await h.row()
    const firstId = row.execution.program!.id
    assert.equal((await h.engine.handleBlock('ws', row.execution.nodeToken, 'Manager verified the first effect remains uncertain', { sessionId: 'manager', turnUserMessageIds: new Set() })).ok, true)
    row = await h.row()
    assert.equal((await h.engine.handleRunProgram('ws', row.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')).ok, true)
    const afterRetry = await h.row()
    assert.equal(afterRetry.execution.nodeId, 'after')
    const programExecution = (await h.store.execution('ws', row.execution.executionId))!
    assert.notEqual(programExecution.program?.id, firstId)
    assert.equal(programExecution.program?.result?.kind, 'PASS')
    first.resolve({ kind: 'PASS', handoff: 'late first result' })
    assert.equal((await firstCall).ok, false)
    assert.equal((await h.row()).execution.input, 'retry result')
    const events = await h.store.events('ws', programExecution.executionId)
    assert.equal(events.filter(event => event.type === 'program-arranged').length, 2)
    assert.equal(events.filter(event => event.type === 'program-result').length, 1)
  } finally { first.resolve({ kind: 'ERROR', reason: 'cleanup' }); h.close() }
})
