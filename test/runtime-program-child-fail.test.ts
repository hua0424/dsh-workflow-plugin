import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type ProgramHost } from '../src/engine/engine.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import type { ClaimCaller, ProgramResult, Target, WorkflowConfig } from '../src/types.ts'

const CHECKER = { checkerId: 'judge.claim-correct', config: { criteria: 'existing criteria' } }
const RETURNS = ['planned', 'repaired']
const target = (name: string): Target => (RETURNS.includes(name) ? { return: name } : { node: name })

function actorNode(role: string, instruction: string, onPass: string) {
  return {
    execution: { type: 'actor-task' as const, role, instruction },
    checker: CHECKER,
    results: { succeeded: { criteria: `${instruction} is complete.`, target: target(onPass) } },
  }
}

/**
 * Program 节点在 v3 用执行协议固定的 PASS/FAIL 结果 + 统一 Target（可继续到节点或
 * 显式返回流程结果）；ERROR 不配置路由，交 Manager 事实确认。
 */
function programConfig(): WorkflowConfig {
  const config: WorkflowConfig = {
    schemaVersion: 'agent-workflow/v3', roles: {}, judgeRole: { persona: 'Read only' },
    workflow: {
      startNode: 'plan', returns: [...RETURNS],
      nodes: {
        plan: actorNode('manager', 'Plan', 'program'),
        program: {
          execution: { type: 'builtin-program', programId: 'github.initialize-milestone', instruction: 'Initialize' },
          results: {
            PASS: { criteria: 'The program reported success.', target: { node: 'after' } },
            FAIL: { criteria: 'The program reported failure.', target: { node: 'repair' } },
          },
        },
        after: actorNode('manager', 'Continue', 'planned'),
        repair: actorNode('manager', 'Repair', 'repaired'),
      },
    },
  }
  return validateAndNormalize(config, { workflowId: 'test' })
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
      async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {}, async compactRoleActor(_run, role) { compacts.push(role); return { ok: true } }, async safeToInspect() { return safe ? 'safe' : 'unsafe' },
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

async function acceptActor(h: ReturnType<typeof harness>, handoff: string, result = 'succeeded') {
  let row = await h.row()
  const actor = h.caller(row.execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { result, handoff }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  row = await h.row()
  const judge = h.caller(row.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  await h.engine.handleTurnEnded('ws', judge)
}

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
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
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
      async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {}, async compactRoleActor() { return { ok: true } }, async safeToInspect() { return 'safe' },
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

test('Program FAIL routes its explicit handoff through the FAIL result target without a Judge', async () => {
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

test('#130: an accepted Actor result completes the Root with its business return name, not as a generic success', async () => {
  const config = programConfig()
  config.workflow.nodes.plan = {
    execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
    checker: CHECKER,
    results: {
      succeeded: { criteria: 'The plan is complete.', target: { return: 'planned' } },
      cancelled: { criteria: 'The work was cancelled after review.', target: { return: 'repaired' } },
    },
  }
  delete config.workflow.nodes.program
  delete config.workflow.nodes.after
  delete config.workflow.nodes.repair
  const h = harness(validateAndNormalize(config, { workflowId: 'test' }), { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'user cancelled after review', 'cancelled')
    const row = await h.row()
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.callStack, [])
    assert.equal(row.execution.claim?.result, 'cancelled')
    assert.equal(row.execution.claim?.handoff, 'user cancelled after review')
    assert.equal(row.execution.judgment?.result, 'ACCEPT')
    // 终局只记业务返回名与来源；handoff 仍从终局工作单读取
    assert.deepEqual(row.run.businessReturn, { name: 'repaired', source: row.execution.executionId })
    assert.deepEqual(row.execution.returned, { kind: 'return', name: 'repaired', source: row.execution.executionId })
    const terminal = h.messages.at(-1)!.text
    assert.match(terminal, /业务终局：repaired/)
    assert.match(terminal, /节点结果：cancelled/)
    assert.match(terminal, /user cancelled after review/)
    assert.doesNotMatch(terminal, /已完成（run/)
  } finally { h.close() }
})

test('builtin FAIL→return completes the root without a Judge (#17)', async () => {
  const config = programConfig()
  config.workflow.nodes.program = {
    execution: { type: 'builtin-program', programId: 'github.initialize-milestone' },
    results: {
      PASS: { criteria: 'The program reported success.', target: { return: 'planned' } },
      FAIL: { criteria: 'The program reported failure.', target: { return: 'repaired' } },
    },
  }
  delete config.workflow.nodes.after
  delete config.workflow.nodes.repair
  const h = harness(validateAndNormalize(config, { workflowId: 'test' }), { async run() { return { kind: 'FAIL', reason: 'milestone is closed', handoff: 'cancelled: no work to do' } } })
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
    assert.deepEqual(row.run.businessReturn, { name: 'repaired', source: row.execution.executionId })
    const terminal = h.messages.at(-1)!.text
    assert.match(terminal, /业务终局：repaired/)
    assert.match(terminal, /cancelled: no work to do/)
    const status = await h.engine.status('ws', 'manager')
    assert.equal(status.status.finalHandoffPreview, 'cancelled: no work to do')
    assert.deepEqual(status.status.businessReturn, { name: 'repaired', source: row.execution.executionId })
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

test('model override safely replaces one blocked Role once and leaves Judge replacement explicit', async () => {
  // 后继已登记且带 Role 映射的现场（Child 调用层的同类现场由 v3-child-returns.test.ts 覆盖）。
  const config: WorkflowConfig = {
    schemaVersion: 'agent-workflow/v3', roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
    workflow: {
      startNode: 'plan', returns: ['planned'],
      nodes: { plan: actorNode('manager', 'Plan', 'work'), work: actorNode('worker', 'Work', 'planned') },
    },
  }
  const h = harness(validateAndNormalize(config, { workflowId: 'test' }), { async run() { throw new Error('unexpected Program') } })
  try {
    await h.start()
    await acceptActor(h, 'parent input')
    let row = await h.row()
    assert.equal(row.execution.nodeId, 'work')
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
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'late old Role' }, oldActor)).ok, false)

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

test('terminal Program exposes its effective final handoff and business return through status', async () => {
  const programDefinition = programConfig()
  programDefinition.workflow.nodes.program = {
    execution: { type: 'builtin-program', programId: 'github.initialize-milestone' },
    results: {
      PASS: { criteria: 'The program reported success.', target: { return: 'planned' } },
      FAIL: { criteria: 'The program reported failure.', target: { return: 'repaired' } },
    },
  }
  delete programDefinition.workflow.nodes.after
  delete programDefinition.workflow.nodes.repair
  const program = harness(validateAndNormalize(programDefinition, { workflowId: 'test' }), { async run() { return { kind: 'PASS', handoff: 'program final artifact' } } })
  try {
    await program.start()
    await acceptActor(program, 'approved plan')
    const row = await program.row()
    await program.engine.handleRunProgram('ws', row.execution.nodeToken, { title: 'M7', branchName: 'feature/t7' }, 'manager')
    const status = await program.engine.status('ws', 'manager')
    assert.equal(status.status.finalHandoffPreview, 'program final artifact')
    assert.equal(status.status.businessReturn?.name, 'planned')
  } finally { program.close() }
})
