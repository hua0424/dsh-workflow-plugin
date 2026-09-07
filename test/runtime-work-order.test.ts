import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StateStore, stateDbPath } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'

const CONFIG = {
  schemaVersion: 'agent-workflow/v2' as const, roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', nodes: { plan: {
    execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
    checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } }, onPass: 'END',
  } } },
}
function harness(config: import('../src/types.ts').WorkflowConfig = CONFIG) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t3-'))
  const store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judges: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  const compacts: string[] = []
  let safe = true
  let safetyGate: Promise<void> | undefined
  let gatedSession = ''
  const send = (sessionId: string, text: string) => {
    const messageId = `message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text }); return { messageId }
  }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(_run, _role, text) { return send('worker-session', text) },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) { return { ...send('worker-session', text), childId: 'worker-session' } },
    async startJudge(_run, input) { judges.push(input); return { ...send(input.judgeSessionId, 'Judge'), judgeSessionId: input.judgeSessionId } },
    async safeToInspect(sessionId) { if (safetyGate && gatedSession === sessionId) await safetyGate; return safe },
    async retireJudge() {}, async drainJudge() { throw new Error('must not self-drain') },
    async compactRoleActor(_run, role) { compacts.push(role); return { ok: true } },
    async followupJudge() { throw new Error('T6') }, async judgeSessionExists() { return true },
  }, { async run() { throw new Error('T7') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    home, store, engine, messages, judges, compacts, caller,
    setSafe(value: boolean) { safe = value },
    setSafetyGate(sessionId: string, gate: Promise<void> | undefined) { gatedSession = sessionId; safetyGate = gate },
    async start() { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'root request') },
    async row() { return (await store.get('ws'))! },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

// 已确认 seam：真实 Runtime + 临时 SQLite + 受控 Host；每次只携带真实派发 ID。
test('start persists root input before dispatch; claim waits for its Actor tail', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t3-'))
  const store = new StateStore(home)
  const judges: unknown[] = []
  let persistedInput: unknown
  const engine = new WorkflowEngine({
    async steerManager() {
      persistedInput = (await store.get('ws'))?.execution?.input
      return { messageId: 'actor-message-1' }
    },
    async sendRoleActor() { throw new Error('not expected') },
    managerSessionSeq() { return 0 },
  }, {
    async startJudge(_run, input) { judges.push(input); return { judgeSessionId: input.judgeSessionId, messageId: 'judge-message-1' } },
  }, {}, makeStateHost(store))
  engine.cwdResolver = async () => home
  try {
    const run = engine.buildInitialRun('manager', 'test', {
      schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'Read only' },
      workflow: { startNode: 'plan', nodes: { plan: {
        execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } }, onPass: 'END',
      } } },
    }, 'hash')
    assert.equal((await engine.startRun('ws', run, undefined, 'root request')).ok, true)
    assert.equal(persistedInput, 'root request')
    assert.equal((await engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan artifact' }, {
      sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']),
    })).ok, true)
    assert.equal((await store.get('ws'))?.execution?.phase, 'checking')
    assert.equal(judges.length, 0)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('Judge cwd preparation failure BLOCKs durably without losing the accepted claim', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'saved artifact' }, actor)
    const before = await h.row()
    h.engine.cwdResolver = async () => { throw new Error('manager session has no cwd') }
    await h.engine.handleTurnEnded('ws', actor)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'checking')
    assert.deepEqual(blocked.execution.claim, before.execution.claim)
    assert.equal(blocked.execution.input, 'root request')
    assert.match(blocked.execution.blockReason!, /manager session has no cwd/)
    assert.equal(blocked.execution.judge, undefined)
    assert.equal(h.judges.length, 0)
    assert.equal((await h.store.events('ws', blocked.execution.executionId)).at(-1)?.type, 'blocked')
    await h.engine.handleTurnEnded('ws', actor)
    assert.equal((await h.row()).stateVersion, blocked.stateVersion)
  } finally { h.close() }
})

test('late cwd preparation failure cannot BLOCK a newer Judge arrangement', async () => {
  const h = harness()
  let fail!: (error: Error) => void
  let entered!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'saved artifact' }, actor)
    h.engine.cwdResolver = () => { entered(); return new Promise((_resolve, reject) => { fail = reject }) }
    const stale = h.engine.handleTurnEnded('ws', actor)
    await preparing
    h.engine.cwdResolver = async () => h.home
    await h.engine.drive('ws')
    const newer = await h.row()
    assert.ok(newer.execution.judge?.messageId)
    fail(new Error('old resolver failure'))
    await stale
    assert.deepEqual(await h.row(), newer)
    assert.equal(h.judges.length, 1)
    assert.equal((await h.store.events('ws', newer.execution.executionId)).some(event => event.type === 'blocked'), false)
  } finally { fail?.(new Error('cleanup')); h.close() }
})

test('failed Judge arrangement transaction BLOCKs against the last committed identity', async () => {
  const h = harness()
  const faults = new DatabaseSync(stateDbPath(h.home))
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'saved artifact' }, actor)
    const before = await h.row()
    faults.exec(`CREATE TRIGGER reject_judge_arranged BEFORE INSERT ON node_execution_events
      WHEN NEW.type = 'judge-arranged' BEGIN SELECT RAISE(ABORT, 'injected Judge arrangement failure'); END`)
    await h.engine.handleTurnEnded('ws', actor)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'checking')
    assert.deepEqual(blocked.execution.claim, before.execution.claim)
    assert.equal(blocked.execution.judge, undefined)
    assert.equal(h.judges.length, 0)
    assert.match(blocked.execution.blockReason!, /injected Judge arrangement failure/)
    assert.deepEqual((await h.store.events('ws', blocked.execution.executionId)).map(event => event.type), ['entered', 'actor-arranged', 'claim', 'blocked'])
  } finally { faults.close(); h.close() }
})

test('failed Actor arrangement transaction leaves visible ready BLOCK without dispatch', async () => {
  const h = harness()
  const faults = new DatabaseSync(stateDbPath(h.home))
  try {
    faults.exec(`CREATE TRIGGER reject_actor_arranged BEFORE INSERT ON node_execution_events
      WHEN NEW.type = 'actor-arranged' BEGIN SELECT RAISE(ABORT, 'injected Actor arrangement failure'); END`)
    await h.start()
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'ready')
    assert.equal(blocked.execution.input, 'root request')
    assert.equal(blocked.execution.dispatch, undefined)
    assert.equal(blocked.execution.claim, undefined)
    assert.equal(h.judges.length, 0)
    assert.match(blocked.execution.blockReason!, /injected Actor arrangement failure/)
    assert.equal(h.messages.length, 1)
    assert.match(h.messages[0].text, /^Workflow BLOCK:/) // 只有通知，无Actor工作派发。
    assert.deepEqual((await h.store.events('ws', blocked.execution.executionId)).map(event => event.type), ['entered', 'blocked'])
  } finally { faults.close(); h.close() }
})

async function acceptCurrent(h: ReturnType<typeof harness>, handoff = 'artifact') {
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  const row = await h.row()
  const judge = h.caller(row.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  return judge
}

test('END final handoff persists; a retired read-only Judge missing end does not lock workspace', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'final artifact' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const checking = await h.row()
    assert.equal(h.judges.length, 1)
    assert.equal(h.judges[0].input, 'root request')
    const judge = h.caller(checking.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
    const completed = await h.row()
    assert.equal(completed.run.status, 'completed')
    assert.equal(completed.execution.claim?.handoff, 'final artifact')
    assert.equal('finalHandoff' in completed.run, false)
    h.setSafe(false) // 已安全收口的Actor不再写；已撤权只读Judge不是新的业务锁。
    assert.equal((await h.start()).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    assert.equal((await h.row()).run.status, 'running')
  } finally { h.close() }
})

test('work order transitions retain best-effort redacted trace without using it as state', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', CONFIG, 'hash'), join(h.home, 'test.yaml'))
    await acceptCurrent(h, 'artifact\npassword=hidden-value')
    const row = await h.row()
    assert.ok(row.run.traceLogPath)
    const trace = readFileSync(row.run.traceLogPath, 'utf8')
    for (const type of ['START', 'CLAIM', 'JUDGE', 'ROUTE']) assert.match(trace, new RegExp(` ${type} `))
    assert.equal(trace.includes('hidden-value'), false)
    assert.equal(row.execution.claim?.handoff, 'artifact\npassword=hidden-value')
  } finally { h.close() }
})

test('Actor tail and stale turn-end cannot start a Judge; interrupt acceptance is not settlement', async () => {
  const h = harness()
  try {
    await h.start()
    const caller = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'written artifact' }, caller)
    await h.engine.handleTurnEnded('ws', { sessionId: 'manager', turnUserMessageIds: new Set(['old-turn-message']) })
    assert.equal(h.judges.length, 0)
    h.setSafe(false) // Known write tail still running, even if interrupt was accepted.
    await h.engine.handleTurnEnded('ws', caller)
    assert.equal(h.judges.length, 0)
    assert.equal((await h.row()).execution.phase, 'checking')
    assert.equal((await h.row()).run.status, 'blocked')
    assert.equal((await h.row()).execution.claim?.handoff, 'written artifact')
  } finally { h.close() }
})

test('same Role across visits reuses Session and compacts; old dispatch cannot claim current visit', async () => {
  const config = structuredClone(CONFIG) as import('../src/types.ts').WorkflowConfig
  config.workflow.nodes.plan.onPass = 'work'
  config.workflow.nodes.work = { execution: { type: 'actor-task', role: 'worker', instruction: 'Work' }, checker: CONFIG.workflow.nodes.plan.checker, onPass: 'END', onFail: 'work' }
  const h = harness(config)
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'root handoff'))
    const first = await h.row()
    const oldCaller = h.caller(first.execution.dispatch!)
    assert.equal(first.execution.input, 'root handoff')
    await h.engine.handleClaim('ws', { outcome: 'failed', handoff: 'repair this artifact' }, oldCaller)
    await h.engine.handleTurnEnded('ws', oldCaller)
    const checking = await h.row()
    const judge = h.caller(checking.execution.judge!)
    await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'honest failure', judge)
    const successor = await h.row()
    assert.notEqual(successor.execution.executionId, first.execution.executionId)
    assert.equal(successor.execution.nodeId, first.execution.nodeId)
    assert.equal(successor.execution.input, 'repair this artifact')
    assert.equal(successor.execution.phase, 'ready')
    await h.engine.handleTurnEnded('ws', judge)
    const current = await h.row()
    assert.equal(current.execution.dispatch?.sessionId, 'worker-session')
    assert.deepEqual(h.compacts, ['worker'])
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'stale' }, oldCaller)).ok, false)
    await h.engine.handleTurnEnded('ws', oldCaller)
    assert.equal((await h.row()).run.status, 'running')
    assert.equal((await h.row()).execution.phase, 'working')
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'final repaired artifact'))
    assert.equal((await h.row()).run.status, 'completed')
  } finally { h.close() }
})

test('a block while Role safety check waits prevents subsequent compact and dispatch', async () => {
  const config = structuredClone(CONFIG) as import('../src/types.ts').WorkflowConfig
  const worker = { execution: { type: 'actor-task' as const, role: 'worker', instruction: 'Work' }, checker: CONFIG.workflow.nodes.plan.checker, onPass: 'again' }
  config.workflow.nodes.plan.onPass = 'work'
  config.workflow.nodes.work = worker
  config.workflow.nodes.again = { ...worker, onPass: 'END' }
  const h = harness(config)
  let release!: () => void
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h))
    const judge = await acceptCurrent(h)
    h.setSafetyGate('worker-session', new Promise(resolve => { release = resolve }))
    const pending = h.engine.handleTurnEnded('ws', judge)
    // Allow the native async get/put chain to reach its deliberately gated safety probe.
    await new Promise(resolve => setImmediate(resolve))
    const arranged = await h.row()
    assert.equal(arranged.execution.phase, 'working')
    assert.equal((await h.engine.handleBlock('ws', arranged.execution.nodeToken, 'stop now', {
      sessionId: 'manager', turnUserMessageIds: new Set(),
    })).ok, true)
    release(); await pending
    assert.deepEqual(h.compacts, [], 'external return must revalidate before the next side effect')
  } finally { release?.(); h.close() }
})
