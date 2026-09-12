import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StateStore, stateDbPath } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { authorizeToolCall } from '../src/tools/authz.ts'
import { DISPATCH_TIMEOUTS, DispatchTimeoutError, withTimeout } from '../src/engine/timeouts.ts'
import { withShortTimeouts } from './helpers/timeouts.ts'

const CONFIG = {
  schemaVersion: 'agent-workflow/v2' as const, roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', nodes: { plan: {
    execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
    checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } }, onPass: 'END',
  } } },
}
function configWithWorker(onFail?: string, reuse?: 'node' | 'continuable'): import('../src/types.ts').WorkflowConfig {
  const config = structuredClone(CONFIG) as import('../src/types.ts').WorkflowConfig
  config.roles.worker = { persona: 'Worker', ...(reuse ? { reuse } : {}) }
  config.workflow.nodes.plan.onPass = 'work'
  config.workflow.nodes.work = {
    execution: { type: 'actor-task', role: 'worker', instruction: 'Work' },
    checker: CONFIG.workflow.nodes.plan.checker, onPass: 'END', ...(onFail ? { onFail } : {}),
  }
  return config
}
/**
 * plan(manager) → work(worker) → again(同一个 worker Role)。
 * 显式 `reuse: continuable`：这组用例断言的是整 Run 复用 + 节点边界 compact 的现状
 * （`reuse: node` 的节点级语义见「reuse: node」用例）。
 */
function configWithReusedWorker(reuse: 'node' | 'continuable' = 'continuable'): import('../src/types.ts').WorkflowConfig {
  const config = configWithWorker(undefined, reuse)
  config.workflow.nodes.work!.onPass = 'again'
  config.workflow.nodes.again = { ...config.workflow.nodes.work!, onPass: 'END' }
  return config
}
function harness(config: import('../src/types.ts').WorkflowConfig = CONFIG) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t3-'))
  const store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judges: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  const followups: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  const drains: string[] = []
  const roleDrains: string[] = []
  const compacts: string[] = []
  const lifecycle: string[] = []
  const puts: Array<{ roleActors: Record<string, string>; events: string[] }> = []
  let roleDrainFailure: Error | undefined
  let roleSerial = 0
  let safe = true
  const unsafeSessions = new Set<string>()
  let compactOutcome: { ok: boolean; detail?: string } = { ok: true }
  let compactGate: Promise<void> | undefined
  let compactEntered: (() => void) | undefined
  let boundaryPersistGate: Promise<void> | undefined
  let boundaryPersistEntered: (() => void) | undefined
  let roleSendFailure: Error | undefined
  let followupFailure: Error | undefined
  let drainFailure: Error | undefined
  let drainGate: Promise<void> | undefined
  let drainEntered: (() => void) | undefined
  let safetyGate: Promise<void> | undefined
  let gatedSession = ''
  const send = (sessionId: string, text: string) => {
    const messageId = `message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text }); return { messageId }
  }
  const stateHost = makeStateHost(store)
  const put = stateHost.put
  stateHost.put = async (ws, run, expectedVersion, changes) => {
    await put(ws, run, expectedVersion, changes)
    puts.push({ roleActors: structuredClone(run.roleActors), events: changes.flatMap(change => change.events) })
    const gate = boundaryPersistGate
    if (gate && changes.some(change => change.events.length === 0 && change.execution.roleBoundaryPrepared
      && change.execution.dispatch?.messageId === undefined)) {
      boundaryPersistGate = undefined
      boundaryPersistEntered?.()
      await gate
    }
  }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(run, role, text) { lifecycle.push(`send:${role}`); if (roleSendFailure) throw roleSendFailure; return send(run.roleActors[role]!, text) },
    managerSessionSeq() { return 0 },
  }, {
    // 每次 fresh spawn 都是新 child：节点级复用（reuse: node）的「再次进入节点」必须可区分。
    async ensureRoleActor(_run, _role, text) { const childId = roleSerial++ === 0 ? 'worker-session' : `worker-session-${roleSerial}`; return { ...send(childId, text), childId } },
    async startJudge(_run, input) { judges.push(input); return { ...send(input.judgeSessionId, 'Judge'), judgeSessionId: input.judgeSessionId } },
    async safeToInspect(sessionId) { lifecycle.push(`safe:${sessionId}`); if (safetyGate && gatedSession === sessionId) await safetyGate; return safe && !unsafeSessions.has(sessionId) },
    async retireJudge() {}, async drainJudge(_run, judgeSessionId) { drains.push(judgeSessionId); drainEntered?.(); if (drainGate) await drainGate; if (drainFailure) throw drainFailure },
    async drainRoleActor(run, role) { roleDrains.push(run.roleActors[role]!); lifecycle.push(`drain:${role}`); if (roleDrainFailure) throw roleDrainFailure },
    async compactRoleActor(_run, role) { compacts.push(role); lifecycle.push(`compact:${role}`); compactEntered?.(); if (compactGate) await compactGate; return compactOutcome },
    async followupJudge(_run, judgeSessionId, input) { followups.push(input); if (followupFailure) throw followupFailure; return send(judgeSessionId, 'Judge followup') },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
  }, { async run() { throw new Error('T7') } }, stateHost)
  engine.cwdResolver = async () => home
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    home, store, engine, messages, judges, followups, drains, roleDrains, compacts, lifecycle, puts, caller,
    setSafe(value: boolean) { safe = value },
    setSessionUnsafe(sessionId: string, value: boolean) { if (value) unsafeSessions.add(sessionId); else unsafeSessions.delete(sessionId) },
    setCompactOutcome(value: { ok: boolean; detail?: string }) { compactOutcome = value },
    setCompactGate(gate: Promise<void> | undefined, onEntered?: () => void) { compactGate = gate; compactEntered = onEntered },
    setBoundaryPersistGate(gate: Promise<void> | undefined, onEntered?: () => void) { boundaryPersistGate = gate; boundaryPersistEntered = onEntered },
    setRoleSendFailure(error: Error | undefined) { roleSendFailure = error },
    setRoleDrainFailure(error: Error | undefined) { roleDrainFailure = error },
    setFollowupFailure(error: Error | undefined) { followupFailure = error },
    setDrainFailure(error: Error | undefined) { drainFailure = error },
    setDrainGate(gate: Promise<void> | undefined, onEntered?: () => void) { drainGate = gate; drainEntered = onEntered },
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

async function acceptCurrent(h: ReturnType<typeof harness>, handoff = 'artifact', outcome: 'completed' | 'failed' = 'completed') {
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { outcome, handoff }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  const row = await h.row()
  const judge = h.caller(row.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  return judge
}

test('actor dispatch excludes criteria but keeps handoff, instruction and submission constraint', async () => {
  const h = harness()
  try {
    await h.start()
    const prompt = h.messages.at(-1)!.text
    assert.match(prompt, /\[handoff\]\nroot request/)
    assert.match(prompt, /\[instruction\]\nPlan/)
    assert.match(prompt, /\[提交要求\]/)
    assert.doesNotMatch(prompt, /\[criteria\]/)
    assert.doesNotMatch(prompt, /Correct plan/)
    // criteria 仍冻结进 Judge packet，不随派发瘦身丢失。
    assert.equal(h.judges.length, 0)
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    assert.equal(h.judges.at(-1)!.criteria, 'Correct plan')
  } finally { h.close() }
})

test('END final handoff persists; a retired read-only Judge missing end does not lock workspace', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'final artifact' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const checking = await h.row()
    assert.equal(h.judges.length, 1)
    // #44 P2：packet 不再携带工作单 input/instruction，判据锚定 criteria。
    assert.ok(!('input' in h.judges[0]!))
    assert.ok(!('instruction' in h.judges[0]!))
    assert.equal(h.judges[0]!.criteria, 'Correct plan')
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
  const h = harness(configWithWorker('work', 'continuable'))
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
    h.lifecycle.length = 0
    await h.engine.handleTurnEnded('ws', judge)
    const current = await h.row()
    assert.equal(current.execution.dispatch?.sessionId, 'worker-session')
    assert.deepEqual(h.compacts, ['worker'])
    assert.deepEqual(h.lifecycle, [`safe:${judge.sessionId}`, 'safe:worker-session', 'compact:worker', 'send:worker'])
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'stale' }, oldCaller)).ok, false)
    await h.engine.handleTurnEnded('ws', oldCaller)
    assert.equal((await h.row()).run.status, 'running')
    assert.equal((await h.row()).execution.phase, 'working')
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'final repaired artifact'))
    assert.equal((await h.row()).run.status, 'completed')
  } finally { h.close() }
})

test('same-execution Role correction reuses its Session without node-boundary compact', async () => {
  const h = harness(configWithWorker())
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const before = await h.row()
    assert.deepEqual(before.run.roleActors, { worker: 'worker-session' })
    assert.deepEqual(h.compacts, [], 'first Role use and Manager work do not compact')
    const actor = h.caller(before.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const checking = await h.row()
    const sentBefore = h.messages.filter(message => message.sessionId === 'worker-session').length
    await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'REJECT', 'fix the evidence', h.caller(checking.execution.judge!))
    const corrected = await h.row()
    assert.equal(corrected.execution.executionId, before.execution.executionId)
    assert.equal(corrected.execution.dispatch?.sessionId, 'worker-session')
    assert.notEqual(corrected.execution.dispatch?.id, before.execution.dispatch?.id)
    assert.deepEqual(h.compacts, [])
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore + 1)
  } finally { h.close() }
})

test('reuse: node（缺省）：节点内修正复用同一会话且无边界 compact；离开节点 drain + 删映射，回边重入拿到全新会话', async () => {
  const h = harness(configWithWorker('work'))
  try {
    await h.start()
    assert.equal((await h.row()).run.definitionSnapshot.roles.worker!.reuse, 'node', '省略 reuse 即 node')
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const first = await h.row()
    assert.equal(first.execution.nodeId, 'work')
    assert.equal(first.execution.dispatch?.sessionId, 'worker-session')
    assert.equal(first.execution.roleBoundaryPrepared, true, 'node 级复用的访问没有跨节点上下文需要 compact')
    assert.deepEqual(h.compacts, [])

    const actor = h.caller(first.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'first candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', 'fix the evidence', h.caller(row.execution.judge!))
    row = await h.row()
    assert.equal(row.execution.executionId, first.execution.executionId)
    assert.equal(row.execution.dispatch?.sessionId, 'worker-session', 'REJECT 重做轮复用同一会话')
    assert.deepEqual(h.compacts, [], '节点内修正不触发边界 compact')
    assert.deepEqual(h.roleDrains, [], '节点未推进，会话不释放')

    const judge = await acceptCurrent(h, 'needs rework', 'failed')
    const advanced = await h.row()
    assert.deepEqual(h.roleDrains, ['worker-session'], '离开节点先 drain 会话')
    assert.equal(advanced.run.roleActors.worker, undefined, '映射随推进删除，旧会话就此失权')
    assert.equal(advanced.execution.nodeId, 'work')
    assert.equal(advanced.execution.visit, first.execution.visit + 1, 'onFail 回边重入同一节点')
    assert.deepEqual(h.puts.filter(entry => entry.events.includes('entered')).at(-1)!.roleActors, {},
      '删映射与节点推进在同一次 state.put 原子完成')
    assert.equal(authorizeToolCall({
      run: advanced.run, sessionId: 'worker-session', knownRoleOfSession: 'worker', isJudgeSession: false, toolName: 'node_claim',
    }).allow, false, '旧会话随映射删除失去 workflow 工具授权')

    await h.engine.handleTurnEnded('ws', judge)
    row = await h.row()
    assert.equal(row.run.roleActors.worker, 'worker-session-2', '再次进入节点 fresh spawn')
    assert.equal(row.execution.dispatch?.sessionId, 'worker-session-2')
    assert.deepEqual(h.compacts, [])
    assert.deepEqual(h.roleDrains, ['worker-session'], '只释放离开节点的那一个会话')
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'stale' }, actor)).ok, false)
  } finally { h.close() }
})

test('reuse: node：drain 失败降级为仅撤权，节点照常推进且映射照常删除', async () => {
  const h = harness(configWithReusedWorker('node'))
  try {
    h.setRoleDrainFailure(new Error('drain unavailable'))
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const first = await h.row()
    assert.equal(first.execution.nodeId, 'work')
    assert.equal(first.execution.dispatch?.sessionId, 'worker-session')
    const judge = await acceptCurrent(h, 'work done')
    const advanced = await h.row()
    assert.equal(advanced.run.status, 'running')
    assert.equal(advanced.execution.nodeId, 'again')
    assert.deepEqual(h.roleDrains, ['worker-session'], 'drain 仍被尝试')
    assert.equal(advanced.run.roleActors.worker, undefined, 'drain 失败也照常删映射（降级仅撤权）')
    await h.engine.handleTurnEnded('ws', judge)
    const current = await h.row()
    assert.equal(current.execution.dispatch?.sessionId, 'worker-session-2', '跨节点不继承旧会话')
    assert.deepEqual(h.compacts, [], 'node 级复用全程无边界 compact')
  } finally { h.close() }
})

test('node-boundary compact failure BLOCKs the new visit and resume retries the mandatory compact before dispatch', async () => {
  const h = harness(configWithWorker('work', 'continuable'))
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const firstWorkerJudge = await acceptCurrent(h, 'worker handoff', 'failed')
    h.setCompactOutcome({ ok: false, detail: 'compaction busy: maintenance raced' })
    const sentBefore = h.messages.filter(message => message.sessionId === 'worker-session').length
    await h.engine.handleTurnEnded('ws', firstWorkerJudge)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'working')
    assert.equal(blocked.execution.roleBoundaryPrepared, false)
    assert.equal(blocked.execution.input, 'worker handoff')
    assert.equal(blocked.execution.dispatch?.sessionId, 'worker-session')
    assert.equal(blocked.execution.dispatch?.messageId, undefined)
    assert.match(blocked.execution.blockReason!, /node-boundary compact failed: compaction busy/)
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore)

    h.setCompactOutcome({ ok: true })
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Retry the required Node-boundary compact.', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.ok(resumed.execution.dispatch?.messageId)
    assert.deepEqual(h.compacts, ['worker', 'worker'])
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore + 1)
  } finally { h.close() }
})

test('compact success is persisted before Queue so send failure resume does not compact the new visit twice', async () => {
  const h = harness(configWithWorker('work', 'continuable'))
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const firstWorkerJudge = await acceptCurrent(h, 'worker handoff', 'failed')
    h.setRoleSendFailure(new Error('Queue acceptance unknown'))
    const sentBefore = h.messages.filter(message => message.sessionId === 'worker-session').length
    await h.engine.handleTurnEnded('ws', firstWorkerJudge)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.roleBoundaryPrepared, true)
    assert.equal(blocked.execution.dispatch?.messageId, undefined)
    assert.match(blocked.execution.blockReason!, /Queue acceptance unknown/)
    assert.deepEqual(h.compacts, ['worker'])
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore)

    h.setRoleSendFailure(undefined)
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Retry Queue after checking the prior acceptance.', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.ok(resumed.execution.dispatch?.messageId)
    assert.deepEqual(h.compacts, ['worker'], 'the persisted boundary fact prevents a second compact')
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore + 1)
  } finally { h.close() }
})

test('a concurrent BLOCK after boundary preparation persists prevents the stale Host Queue send', async () => {
  const h = harness(configWithWorker('work', 'continuable'))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const firstWorkerJudge = await acceptCurrent(h, 'worker handoff', 'failed')
    h.setBoundaryPersistGate(release.promise, entered.resolve)
    const sentBefore = h.messages.filter(message => message.sessionId === 'worker-session').length
    const pending = h.engine.handleTurnEnded('ws', firstWorkerJudge)
    await entered.promise
    const prepared = await h.row()
    assert.equal(prepared.execution.roleBoundaryPrepared, true)
    assert.equal((await h.engine.handleBlock('ws', prepared.execution.nodeToken, 'stop after boundary preparation', {
      sessionId: 'manager', turnUserMessageIds: new Set(),
    })).ok, true)
    release.resolve(); await pending
    assert.equal((await h.row()).run.status, 'blocked')
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore)
  } finally { release.resolve(); h.close() }
})

test('a concurrent BLOCK while compact awaits prevents the stale new-visit dispatch', async () => {
  const h = harness(configWithWorker('work', 'continuable'))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const firstWorkerJudge = await acceptCurrent(h, 'worker handoff', 'failed')
    h.setCompactGate(release.promise, entered.resolve)
    const sentBefore = h.messages.filter(message => message.sessionId === 'worker-session').length
    const pending = h.engine.handleTurnEnded('ws', firstWorkerJudge)
    await entered.promise
    const arranged = await h.row()
    assert.equal((await h.engine.handleBlock('ws', arranged.execution.nodeToken, 'stop while compacting', {
      sessionId: 'manager', turnUserMessageIds: new Set(),
    })).ok, true)
    release.resolve(); await pending
    assert.equal((await h.row()).run.status, 'blocked')
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, sentBefore)
  } finally { release.resolve(); h.close() }
})

test('REJECT keeps one execution and binds the corrected claim to a fresh Judge turn', async () => {
  const h = harness()
  try {
    await h.start()
    const first = await h.row()
    const executionId = first.execution.executionId
    const actor1 = h.caller(first.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'failed', handoff: 'first candidate' }, actor1)
    await h.engine.handleTurnEnded('ws', actor1)
    const checking1 = await h.row()
    const claim1 = checking1.execution.claim!
    const judge1Dispatch = checking1.execution.judge!
    const judge1 = h.caller(judge1Dispatch)

    assert.equal((await h.engine.handleJudgeClaim('ws', checking1.execution.nodeToken, 'REJECT', 'criteria requires the missing test', judge1)).ok, true)
    const correcting = await h.row()
    assert.equal(correcting.execution.executionId, executionId)
    assert.equal(correcting.execution.phase, 'working')
    assert.equal(correcting.execution.claim, undefined)
    assert.equal(correcting.execution.previousClaim?.id, claim1.id)
    assert.equal(correcting.execution.judgment?.claimId, claim1.id)
    assert.equal(correcting.execution.judgment?.judgeDispatchId, judge1Dispatch.id)
    assert.equal(correcting.execution.judgment?.inputVersion, judge1Dispatch.inputVersion)
    assert.match(h.messages.at(-1)!.text, /criteria requires the missing test/)
    assert.match(h.messages.at(-1)!.text, /first candidate/)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking1.execution.nodeToken, 'ACCEPT', 'late old result', judge1)).ok, false)

    const actor2 = h.caller(correcting.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'corrected candidate' }, actor2)
    await h.engine.handleTurnEnded('ws', actor2)
    const checking2 = await h.row()
    assert.notEqual(checking2.execution.claim?.id, claim1.id)
    assert.notEqual(checking2.execution.judge?.id, judge1Dispatch.id)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking2.execution.nodeToken, 'ACCEPT', 'criteria now satisfied', h.caller(checking2.execution.judge!))).ok, true)

    const completed = await h.row()
    assert.equal(completed.execution.executionId, executionId)
    assert.equal(completed.execution.claim?.handoff, 'corrected candidate')
    const events = await h.store.events('ws', executionId)
    assert.equal(events.filter(event => event.type === 'claim').length, 2)
    assert.equal(events.filter(event => event.type === 'judgment').length, 2)
    const rejected = events.find(event => event.type === 'judgment' && event.snapshot.judgment?.result === 'REJECT')!
    assert.equal(rejected.snapshot.previousClaim?.id, claim1.id)
    assert.equal(rejected.snapshot.judgment?.judgeDispatchId, judge1Dispatch.id)
  } finally { h.close() }
})

test('Manager return after a later Judge no-result keeps only that claim as current correction material', async () => {
  const h = harness()
  try {
    await h.start()
    const executionId = (await h.row()).execution.executionId
    const actor1 = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim one' }, actor1)
    await h.engine.handleTurnEnded('ws', actor1)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', 'claim one misses existing criteria', h.caller(row.execution.judge!))

    row = await h.row()
    const actor2 = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim two awaiting Judge' }, actor2)
    await h.engine.handleTurnEnded('ws', actor2)
    row = await h.row()
    await h.engine.handleTurnEnded('ws', h.caller(row.execution.judge!))
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')

    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager returns claim two for another check.', 'manager', 'actor')).ok, true)
    const returned = await h.row()
    assert.equal(returned.execution.executionId, executionId)
    assert.equal(returned.execution.previousClaim?.handoff, 'claim two awaiting Judge')
    assert.equal(returned.execution.previousJudge, undefined)
    assert.equal(returned.execution.judgment, undefined)
    assert.match(h.messages.at(-1)!.text, /claim two awaiting Judge/)
    assert.match(h.messages.at(-1)!.text, /Manager returns claim two for another check/)
    const events = await h.store.events('ws', executionId)
    assert.ok(events.some(event => event.type === 'judgment' && event.snapshot.judgment?.result === 'REJECT' && event.snapshot.previousClaim?.handoff === 'claim one'))

    const actor3 = h.caller(returned.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim three' }, actor3)
    await h.engine.handleTurnEnded('ws', actor3)
    row = await h.row()
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified claim three', h.caller(row.execution.judge!))).ok, true)
  } finally { h.close() }
})

test('Actor return after claim2 Judge preparation fault drops unrelated claim1 feedback pair', async () => {
  const h = harness()
  try {
    await h.start()
    const executionId = (await h.row()).execution.executionId
    const actor1 = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim one' }, actor1)
    await h.engine.handleTurnEnded('ws', actor1)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', 'claim one rejected', h.caller(row.execution.judge!))

    row = await h.row()
    const actor2 = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim two after preparation fault' }, actor2)
    h.engine.cwdResolver = async () => { throw new Error('Judge cwd unavailable') }
    await h.engine.handleTurnEnded('ws', actor2)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.judge, undefined)
    assert.equal(blocked.execution.judgment?.claimId, blocked.execution.previousClaim?.id)

    h.engine.cwdResolver = async () => h.home
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager returns claim two after Judge preparation failed.', 'manager', 'actor')).ok, true)
    const returned = await h.row()
    assert.equal(returned.execution.executionId, executionId)
    assert.equal(returned.execution.previousClaim?.handoff, 'claim two after preparation fault')
    assert.equal(returned.execution.previousJudge, undefined)
    assert.equal(returned.execution.judgment, undefined)
    assert.deepEqual(h.drains, [], 'unrelated claim1 Judge history is not drained')
    assert.match(h.messages.at(-1)!.text, /claim two after preparation fault/)
    assert.ok((await h.store.events('ws', executionId)).some(event => event.type === 'judgment' && event.snapshot.previousClaim?.handoff === 'claim one'))

    const actor3 = h.caller(returned.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim three' }, actor3)
    await h.engine.handleTurnEnded('ws', actor3)
    row = await h.row()
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'claim three verified', h.caller(row.execution.judge!))).ok, true)
  } finally { h.close() }
})

test('NEED_CONTEXT keeps the claim and Manager context creates a fresh bound Judge turn', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate needing context' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const checking = await h.row()
    const claim = checking.execution.claim!
    const judge1Dispatch = checking.execution.judge!
    const judge1 = h.caller(judge1Dispatch)

    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'NEED_CONTEXT', 'need the approved ticket decision', judge1)).ok, true)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'checking')
    assert.equal(blocked.execution.claim?.id, claim.id)
    assert.equal(blocked.execution.previousClaim, undefined)
    assert.equal(blocked.execution.judgment?.result, 'NEED_CONTEXT')
    assert.deepEqual((await h.store.events('ws', blocked.execution.executionId)).slice(-2).map(event => event.type), ['judgment', 'blocked'])

    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Ticket explicitly approves this behavior.', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.equal(resumed.execution.claim?.id, claim.id)
    assert.equal(resumed.execution.input, 'root request')
    assert.equal(resumed.execution.inputVersion, judge1Dispatch.inputVersion + 1)
    assert.equal(resumed.execution.judge?.sessionId, judge1Dispatch.sessionId)
    assert.notEqual(resumed.execution.judge?.id, judge1Dispatch.id)
    assert.notEqual(resumed.execution.judge?.messageId, judge1Dispatch.messageId)
    assert.equal(resumed.execution.resolution?.context, 'Ticket explicitly approves this behavior.')
    assert.equal(h.followups.at(-1)?.managerContext, 'Ticket explicitly approves this behavior.')
    const roleSummary = await h.engine.status('ws', 'worker-session')
    assert.equal(roleSummary.ok, true)
    assert.equal('resolution' in roleSummary.status.execution, false)
    assert.equal('dispatch' in roleSummary.status.execution, false)
    assert.equal('previousClaim' in roleSummary.status.execution, false)
    assert.doesNotMatch(JSON.stringify(roleSummary.status), /Ticket explicitly approves this behavior/)
    const managerHistory = await h.engine.status('ws', 'manager', { executionId: resumed.execution.executionId, after: 0, limit: 50 })
    assert.match(JSON.stringify(managerHistory.status), /Ticket explicitly approves this behavior/)
    assert.match(JSON.stringify(managerHistory.status), /candidate needing context/)
    assert.equal(h.judges.length, 1)
    assert.equal(h.followups.length, 1)
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', 'late old input', judge1)).ok, false)
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', 'verified with context', h.caller(resumed.execution.judge!))).ok, true)
  } finally { h.close() }
})

test('Manager context and claim survive a failed Judge followup delivery', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'durable candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    const oldJudge = h.caller(row.execution.judge!)
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need durable clarification', oldJudge)
    row = await h.row()
    h.setFollowupFailure(new Error('queue unavailable'))
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, 'This complete clarification must survive delivery failure.', 'manager', 'judge')).ok, true)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.claim?.handoff, 'durable candidate')
    assert.equal(blocked.execution.resolution?.context, 'This complete clarification must survive delivery failure.')
    assert.match(blocked.execution.blockReason!, /queue unavailable/)
    assert.equal((await h.engine.handleJudgeClaim('ws', blocked.execution.nodeToken, 'ACCEPT', 'late old input', oldJudge)).ok, false)
    const types = (await h.store.events('ws', blocked.execution.executionId)).map(event => event.type)
    assert.deepEqual(types.slice(-4), ['manager-context', 'resumed', 'judge-arranged', 'blocked'])
  } finally { h.close() }
})

test('NEED_CONTEXT supplement followed by REJECT preserves context through Actor correction and recheck', async () => {
  const h = harness()
  try {
    await h.start()
    const actor1 = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate one' }, actor1)
    await h.engine.handleTurnEnded('ws', actor1)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need policy decision', h.caller(row.execution.judge!))
    row = await h.row()
    await h.engine.handleResume('ws', row.execution.nodeToken, 'Policy permits the change but requires test evidence.', 'manager', 'judge')
    row = await h.row()
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', 'existing criteria still lacks test evidence', h.caller(row.execution.judge!))).ok, true)
    const correcting = await h.row()
    assert.equal(correcting.execution.resolution?.inputVersion, correcting.execution.inputVersion)
    assert.match(h.messages.at(-1)!.text, /Policy permits the change/)
    assert.match(h.messages.at(-1)!.text, /existing criteria still lacks test evidence/)
    const actor2 = h.caller(correcting.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate two with tests' }, actor2)
    await h.engine.handleTurnEnded('ws', actor2)
    row = await h.row()
    assert.equal(h.judges.at(-1)?.managerContext, 'Policy permits the change but requires test evidence.')
    assert.equal(h.judges.at(-1)?.previousFeedback?.result, 'REJECT')
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', h.caller(row.execution.judge!))).ok, true)
  } finally { h.close() }
})

test('Manager can return NEED_CONTEXT work to Actor with the exact feedback and old claim', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim needing another look' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'cannot reconcile the repository fact', h.caller(row.execution.judge!))
    row = await h.row()
    const oldJudge = structuredClone(row.execution.judge)!
    const events = await h.store.events('ws', row.execution.executionId)
    h.setDrainFailure(new Error('NEED_CONTEXT Judge still active'))
    const failed = await h.engine.handleResume('ws', row.execution.nodeToken, 'Recheck the named file and report the discrepancy.', 'manager', 'actor')
    assert.equal(failed.ok, false)
    assert.match(failed.reason!, /NEED_CONTEXT Judge still active/)
    assert.deepEqual(await h.row(), row)
    assert.deepEqual(await h.store.events('ws', row.execution.executionId), events)
    h.setDrainFailure(undefined)
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, 'Recheck the named file and report the discrepancy.', 'manager', 'actor')).ok, true)
    assert.deepEqual(h.drains, [oldJudge.sessionId, oldJudge.sessionId])
    const returned = await h.row()
    assert.equal(returned.execution.phase, 'working')
    assert.equal(returned.execution.claim, undefined)
    assert.equal(returned.execution.previousClaim?.handoff, 'claim needing another look')
    const prompt = h.messages.at(-1)!.text
    assert.match(prompt, /NEED_CONTEXT/)
    assert.match(prompt, /cannot reconcile the repository fact/)
    assert.match(prompt, /claim needing another look/)
    assert.match(prompt, /Recheck the named file and report the discrepancy/)
  } finally { h.close() }
})

test('judge_respawn replaces the Judge but keeps claim, NEED_CONTEXT question, and Manager resolution', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need scope', h.caller(row.execution.judge!))
    row = await h.row()
    await h.engine.handleResume('ws', row.execution.nodeToken, 'Approved scope is complete and authoritative.', 'manager', 'judge')
    row = await h.row()
    const oldFollowup = h.caller(row.execution.judge!)
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need independent fresh review', oldFollowup)
    const blocked = await h.row()
    const claimId = blocked.execution.claim!.id
    const oldSession = blocked.execution.judge!.sessionId

    assert.equal((await h.engine.handleRespawnJudge('ws', blocked.execution.nodeToken, 'fresh independent review', 'manager')).ok, true)
    const respawned = await h.row()
    assert.equal(respawned.run.status, 'running')
    assert.equal(respawned.execution.claim?.id, claimId)
    assert.notEqual(respawned.execution.judge?.sessionId, oldSession)
    assert.equal(h.judges.length, 2)
    assert.equal(h.followups.length, 1)
    const packet = h.judges.at(-1)!
    assert.equal(packet.claim.handoff, 'candidate')
    assert.equal(packet.previousFeedback?.result, 'NEED_CONTEXT')
    assert.equal(packet.previousFeedback?.reason, 'need independent fresh review')
    assert.equal(packet.managerContext, 'Approved scope is complete and authoritative.')
    assert.equal(respawned.execution.resolution?.decision, 'fresh independent review')
    assert.deepEqual(h.drains, [oldSession])
    assert.equal((await h.engine.handleJudgeClaim('ws', respawned.execution.nodeToken, 'ACCEPT', 'stale followup', oldFollowup)).ok, false)
    assert.equal((await h.engine.handleJudgeClaim('ws', respawned.execution.nodeToken, 'ACCEPT', 'fresh review verified', h.caller(respawned.execution.judge!))).ok, true)
    h.store.close()
    const reopened = new StateStore(h.home)
    try {
      const events = await reopened.events('ws', respawned.execution.executionId)
      assert.equal(events.find(event => event.type === 'judge-respawned')?.snapshot.resolution?.decision, 'fresh independent review')
    } finally { reopened.close() }
  } finally { h.close() }
})

test('Judge drain failure BLOCKs before fresh spawn and preserves respawn materials for retry', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'durable candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need scope', h.caller(row.execution.judge!))
    row = await h.row()
    await h.engine.handleResume('ws', row.execution.nodeToken, 'Approved context survives drain failure.', 'manager', 'judge')
    row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need fresh Judge', h.caller(row.execution.judge!))
    row = await h.row()
    const spawnsBefore = h.judges.length
    const oldJudge = structuredClone(row.execution.judge)
    const eventsBefore = await h.store.events('ws', row.execution.executionId)
    h.engine.cwdResolver = async () => { throw new Error('cwd unavailable') }
    const cwdFailed = await h.engine.handleRespawnJudge('ws', row.execution.nodeToken, 'replace unavailable Judge', 'manager')
    assert.equal(cwdFailed.ok, false)
    assert.match(cwdFailed.reason!, /cwd unavailable/)
    assert.deepEqual(await h.row(), row)
    assert.equal(h.drains.length, 0)
    h.engine.cwdResolver = async () => h.home
    h.setDrainFailure(new Error('host drain rejected'))
    const failed = await h.engine.handleRespawnJudge('ws', row.execution.nodeToken, 'replace unavailable Judge', 'manager')
    assert.equal(failed.ok, false)
    assert.match(failed.reason!, /host drain rejected/)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.claim?.handoff, 'durable candidate')
    assert.equal(blocked.execution.resolution?.context, 'Approved context survives drain failure.')
    assert.deepEqual(blocked.execution.judge, oldJudge, 'failed drain retains the same Judge identity for retry')
    assert.equal(h.judges.length, spawnsBefore, 'fresh Judge must not spawn after failed drain')
    assert.deepEqual(await h.store.events('ws', blocked.execution.executionId), eventsBefore)

    h.setDrainFailure(undefined)
    assert.equal((await h.engine.handleRespawnJudge('ws', blocked.execution.nodeToken, 'retry replacement', 'manager')).ok, true)
    assert.deepEqual(h.drains.slice(-2), [oldJudge!.sessionId, oldJudge!.sessionId])
    assert.equal(h.judges.length, spawnsBefore + 1)
    assert.equal((await h.row()).execution.resolution?.decision, 'retry replacement')
  } finally { h.close() }
})

test('Judge drain CAS rejects a stale Actor resume after a concurrent state winner', async () => {
  const h = harness()
  const gate = Promise.withResolvers<void>()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate held by old Judge' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    h.setSafe(false)
    await h.engine.handleTurnEnded('ws', h.caller(row.execution.judge!))
    const blocked = await h.row()
    const messagesBefore = h.messages.length
    const drainStarted = Promise.withResolvers<void>()
    h.setDrainGate(gate.promise, drainStarted.resolve)

    const pending = h.engine.handleResume('ws', blocked.execution.nodeToken, 'This stale resume must not dispatch.', 'manager', 'actor')
    await drainStarted.promise
    await h.store.updateRow('ws', blocked.run, blocked.stateVersion, [])
    const winner = await h.row()
    const winnerEvents = await h.store.events('ws', winner.execution.executionId)
    gate.resolve()
    const outcome = await pending
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason!, /stale actor resume/)
    assert.deepEqual(await h.row(), winner)
    assert.deepEqual(await h.store.events('ws', winner.execution.executionId), winnerEvents)
    assert.equal((await h.row()).execution.resolution, undefined)
    assert.equal(h.messages.length, messagesBefore)
    assert.equal(h.judges.length, 1)
  } finally { gate.resolve(); h.close() }
})

test('Actor-target resume drains an unjudged unsafe Judge before returning its claim', async () => {
  const h = harness()
  try {
    await h.start()
    const executionId = (await h.row()).execution.executionId
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim returned from unsafe Judge' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    const oldJudge = structuredClone(row.execution.judge)!
    h.setSafe(false)
    await h.engine.handleTurnEnded('ws', h.caller(oldJudge))
    const blocked = await h.row()

    h.setDrainFailure(new Error('unsafe Judge drain failed'))
    const failed = await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager returns the claim to Actor.', 'manager', 'actor')
    assert.equal(failed.ok, false)
    assert.deepEqual(await h.row(), blocked)
    assert.equal(h.messages.filter(message => message.text.includes('Manager returns the claim to Actor.')).length, 0)

    h.setDrainFailure(undefined)
    h.setSafe(true)
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager returns the claim to Actor.', 'manager', 'actor')).ok, true)
    row = await h.row()
    assert.equal(row.execution.executionId, executionId)
    assert.equal(row.execution.previousClaim?.handoff, 'claim returned from unsafe Judge')
    assert.equal(row.execution.previousJudge, undefined)
    assert.equal(row.execution.judgment, undefined)
    assert.deepEqual(h.drains, [oldJudge.sessionId, oldJudge.sessionId])
    assert.match(h.messages.at(-1)!.text, /claim returned from unsafe Judge/)
    assert.match(h.messages.at(-1)!.text, /Manager returns the claim to Actor/)
  } finally { h.close() }
})

test('Judge-target resume drains an unjudged old Judge before fresh spawn and retries the same identity', async () => {
  const h = harness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate awaiting verdict' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    const oldJudge = structuredClone(row.execution.judge)!
    const oldCaller = h.caller(oldJudge)
    h.setSafe(false)
    await h.engine.handleTurnEnded('ws', oldCaller)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.judgment, undefined)

    h.setDrainFailure(new Error('old Judge still active'))
    const failed = await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Retry judgment after the old activity stops.', 'manager', 'judge')
    assert.equal(failed.ok, false)
    assert.match(failed.reason!, /old Judge still active/)
    assert.deepEqual(await h.row(), blocked)
    assert.equal(h.judges.length, 1)
    assert.equal(h.followups.length, 0)

    h.setDrainFailure(undefined)
    h.setSafe(true)
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Retry judgment after the old activity stops.', 'manager', 'judge')).ok, true)
    row = await h.row()
    assert.deepEqual(h.drains, [oldJudge.sessionId, oldJudge.sessionId])
    assert.notEqual(row.execution.judge?.sessionId, oldJudge.sessionId)
    assert.equal(h.judges.length, 2)
    assert.equal(h.followups.length, 0)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'late old Judge', oldCaller)).ok, false)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'fresh Judge verified', h.caller(row.execution.judge!))).ok, true)
  } finally { h.close() }
})

test('Actor-target resume does not compact or redispatch while the blocked Role turn is unsafe', async () => {
  const config = structuredClone(CONFIG) as import('../src/types.ts').WorkflowConfig
  config.workflow.nodes.plan.onPass = 'work'
  config.workflow.nodes.work = {
    execution: { type: 'actor-task', role: 'worker', instruction: 'Work' },
    checker: CONFIG.workflow.nodes.plan.checker, onPass: 'END',
  }
  const h = harness(config)
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h, 'plan ready'))
    const working = await h.row()
    const actor = h.caller(working.execution.dispatch!)
    assert.equal((await h.engine.handleBlock('ws', working.execution.nodeToken, 'Judge feedback conflicts with repository facts', actor)).ok, true)
    const blocked = await h.row()
    const workerMessages = h.messages.filter(message => message.sessionId === 'worker-session').length
    h.setSafe(false)
    h.engine.actorActivity = async () => 'idle'
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager asks Actor to preserve evidence and wait for safe continuation.', 'manager', 'actor')).ok, false)
    const stillBlocked = await h.row()
    assert.equal(stillBlocked.run.status, 'blocked')
    assert.equal(stillBlocked.execution.blockReason, blocked.execution.blockReason)
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, workerMessages)
    h.setSafe(true)
    assert.equal((await h.engine.handleResume('ws', stillBlocked.execution.nodeToken, 'The prior turn is now verified idle; continue the same work.', 'manager', 'actor')).ok, true)
    assert.equal(h.messages.filter(message => message.sessionId === 'worker-session').length, workerMessages + 1)
    assert.deepEqual(h.compacts, [], 'same-execution resume never performs Node-boundary compact')
    assert.deepEqual(h.roleDrains, [], '同节点 resume 不离开节点，会话不释放')
  } finally { h.close() }
})

test('workflow_status history is Manager-only and pages retained Run events by stable sequence', async () => {
  const h = harness()
  try {
    await h.start()
    const row = await h.row()
    const executionId = row.execution.executionId
    const runId = row.run.runId
    const denied = await h.engine.status('ws', 'worker-session', { executionId, after: 0, limit: 1 })
    assert.equal(denied.ok, false)
    const first = await h.engine.status('ws', 'manager', { executionId, after: 0, limit: 1 })
    assert.equal(first.ok, true)
    assert.deepEqual(first.status.history.events.map((event: { sequence: number }) => event.sequence), [1])
    assert.equal(first.status.history.nextAfter, 1)
    const second = await h.engine.status('ws', 'manager', { executionId, after: first.status.history.nextAfter, limit: 1 })
    assert.deepEqual(second.status.history.events.map((event: { sequence: number }) => event.sequence), [2])
    const empty = await h.engine.status('ws', 'manager', { executionId, after: 999, limit: 50 })
    assert.deepEqual(empty.status.history.events, [])
    assert.equal(empty.status.history.nextAfter, null)
    const summary = await h.engine.status('ws', 'worker-session')
    assert.equal(summary.ok, true)
    assert.equal(summary.status.execution.executionId, executionId)
    await acceptCurrent(h, 'first run complete')
    assert.equal((await h.start()).ok, true)
    const retained = await h.store.events('ws', executionId, 0, 50)
    assert.ok(retained.length > 0, 'retained SQLite history remains directly inspectable for maintenance')
    const crossRun = await h.engine.status('ws', 'manager', { executionId, after: 0, limit: 50 })
    assert.equal(crossRun.ok, false)
    assert.match(crossRun.reason!, /current Run/)
    assert.notEqual((await h.row()).run.runId, runId)
  } finally { h.close() }
})

test('resume refuses a ready successor whose predecessor Judge is not safely settled', async () => {
  const config = structuredClone(CONFIG) as import('../src/types.ts').WorkflowConfig
  config.workflow.nodes.plan.onPass = 'work'
  config.workflow.nodes.work = {
    execution: { type: 'actor-task', role: 'worker', instruction: 'Work' },
    checker: CONFIG.workflow.nodes.plan.checker, onPass: 'END',
  }
  const h = harness(config)
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan ready' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    const judge = h.caller(row.execution.judge!)
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)
    h.setSafe(false)
    await h.engine.handleTurnEnded('ws', judge)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'ready')
    assert.ok(blocked.execution.predecessorId)
    const outcome = await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Try to continue without settled predecessor.', 'manager', 'auto')
    assert.equal(outcome.ok, false)
    assert.match(outcome.reason!, /predecessor Judge.*not safely settled/)
    assert.deepEqual(await h.row(), blocked)
  } finally { h.close() }
})

test('a block while Role safety check waits prevents subsequent compact and dispatch', async () => {
  const h = harness(configWithReusedWorker())
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

/** 走到跨节点复用 worker 会话的那次派发；返回的 Judge caller 结算后会触发它。 */
async function reachReusedWorkerDispatch(h: ReturnType<typeof harness>) {
  await h.start()
  await h.engine.handleTurnEnded('ws', await acceptCurrent(h))
  const judge = await acceptCurrent(h)
  assert.equal((await h.row()).execution.nodeId, 'again')
  return judge
}

test('#21 F2: a cold reused Role Session dispatches without a dispatch fault', async () => {
  const h = harness(configWithReusedWorker())
  try {
    const judge = await reachReusedWorkerDispatch(h)
    // 冷置：存储层可读但无存活进程（活动不可观测）——与 resume 路径同等安全。
    h.setSessionUnsafe('worker-session', true)
    h.engine.actorActivity = async () => 'unknown'
    await h.engine.handleTurnEnded('ws', judge)
    const current = await h.row()
    assert.equal(current.run.status, 'running')
    assert.equal(current.execution.blockReason, null)
    assert.equal(current.execution.dispatch?.sessionId, 'worker-session')
    assert.deepEqual(h.compacts, ['worker'], 'the cold reuse still runs its node-boundary compact')
    assert.equal(h.messages.at(-1)?.sessionId, 'worker-session')
  } finally { h.close() }
})

test('#21 F2: a Session with observable activity still BLOCKs the reuse dispatch', async () => {
  const h = harness(configWithReusedWorker())
  try {
    const judge = await reachReusedWorkerDispatch(h)
    h.setSessionUnsafe('worker-session', true)
    h.engine.actorActivity = async () => 'idle'
    await h.engine.handleTurnEnded('ws', judge)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /previous Role execution is not safely closed/)
    assert.deepEqual(h.compacts, [], 'the fault is raised before compact/send')
  } finally { h.close() }
})

test('#21 F1: every dispatch-path seam timeout BLOCKs with its stage name instead of hanging the Manager turn', async () => {
  // 真实超时机制产出的 detail（Host 侧 cold/compact 链的返回值形状）。
  const compactTimeout = await withTimeout(new Promise<never>(() => {}), 7, 'compactNow').then(() => '', error => (error as Error).message)
  const coldTimeout = await withTimeout(new Promise<never>(() => {}), 7, 'coldMaterialize').then(() => '', error => (error as Error).message)
  const seams: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ['whenIdle', h => h.setSafetyGate('worker-session', new Promise<never>(() => {}))],
    ['compactNow', h => h.setCompactOutcome({ ok: false, detail: compactTimeout })],
    ['send', h => h.setRoleSendFailure(new DispatchTimeoutError('send', DISPATCH_TIMEOUTS.send))],
    // #32 D-003：冷物化（agents.resume）挂起此前只有 Host 层用例；引擎层必须
    // 在有限时间内 BLOCK 且 blockReason 带阶段名（Host 侧真实 resume 挂起的
    // 超时由 test/host-compact.test.ts 的 coldMaterialize 用例覆盖）。
    ['coldMaterialize', h => h.setCompactOutcome({ ok: false, detail: `cold materialize failed: ${coldTimeout}` })],
  ]
  await withShortTimeouts({ whenIdle: 20 }, async () => {
    for (const [stage, inject] of seams) {
      const h = harness(configWithReusedWorker())
      try {
        const judge = await reachReusedWorkerDispatch(h)
        inject(h)
        await h.engine.handleTurnEnded('ws', judge)
        const blocked = await h.row()
        assert.equal(blocked.run.status, 'blocked', stage)
        assert.equal(blocked.execution.phase, 'working', stage)
        assert.match(blocked.execution.blockReason!, new RegExp(`timeout after \\d+ms at stage "${stage}"`))
      } finally { h.close() }
    }
  })
})

function recoveryHarness(config: import('../src/types.ts').WorkflowConfig = CONFIG) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t6-'))
  let store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judgeStarts: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  const judgeFollowups: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  const ensuredActors: string[] = []
  const drains: string[] = []
  let drainFailure: Error | undefined
  let judgeFollowupFailure: Error | undefined
  let safe = true
  let safetyGate: Promise<void> | undefined
  let activity: 'active' | 'idle' | 'unknown' = 'unknown'
  let roleAvailability: import('../src/engine/engine.ts').SessionAvailability = 'available'
  let judgeAvailability: import('../src/engine/engine.ts').SessionAvailability = 'available'
  let failManagerSendAfterAccept = false
  let actorSerial = 0
  const send = (sessionId: string, text: string) => {
    const messageId = `recovery-message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text })
    return { messageId }
  }
  const makeEngine = () => {
    const next = new WorkflowEngine({
      async steerManager(_run, text) {
        const sent = send('manager', text)
        if (failManagerSendAfterAccept) throw new Error('Queue accepted but acknowledgement was lost')
        return sent
      },
      async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
      managerSessionSeq() { return 0 },
    }, {
      async ensureRoleActor(_run, _role, text) {
        const childId = actorSerial++ === 0 ? 'worker-session' : `worker-replacement-${actorSerial}`
        ensuredActors.push(childId)
        return { childId, ...send(childId, text) }
      },
      async startJudge(_run, input) {
        judgeStarts.push(input)
        return { judgeSessionId: input.judgeSessionId, ...send(input.judgeSessionId, 'Judge') }
      },
      async followupJudge(_run, judgeSessionId, input) {
        judgeFollowups.push(input)
        if (judgeFollowupFailure) throw judgeFollowupFailure
        return send(judgeSessionId, 'Judge followup')
      },
      async judgeSessionAvailability() { return judgeAvailability },
      async roleSessionAvailability() { return roleAvailability },
      async retireJudge() {},
      async drainJudge(_run, judgeSessionId) { drains.push(judgeSessionId); if (drainFailure) throw drainFailure },
      async drainRoleActor() {},
      async compactRoleActor() { return { ok: true } },
      async safeToInspect() { if (safetyGate) await safetyGate; return safe },
    }, { async run() { throw new Error('T7') } }, makeStateHost(store))
    next.cwdResolver = async () => home
    next.actorActivity = async () => activity
    return next
  }
  let engine = makeEngine()
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    home, messages, judgeStarts, judgeFollowups, ensuredActors, drains, caller,
    get engine() { return engine },
    get store() { return store },
    setSafe(value: boolean) { safe = value },
    setSafetyGate(gate: Promise<void> | undefined) { safetyGate = gate },
    setActivity(value: 'active' | 'idle' | 'unknown') { activity = value },
    setRoleAvailability(value: import('../src/engine/engine.ts').SessionAvailability) { roleAvailability = value },
    setJudgeAvailability(value: import('../src/engine/engine.ts').SessionAvailability) { judgeAvailability = value },
    setDrainFailure(value: Error | undefined) { drainFailure = value },
    setJudgeFollowupFailure(value: Error | undefined) { judgeFollowupFailure = value },
    setManagerSendAfterAcceptFailure(value: boolean) { failManagerSendAfterAccept = value },
    async row() { return (await store.get('ws'))! },
    async start() { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'root request') },
    reopen() { store.close(); store = new StateStore(home); engine = makeEngine() },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

async function acceptRecoveryCurrent(h: ReturnType<typeof recoveryHarness>, handoff: string) {
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  const checking = await h.row()
  const judge = h.caller(checking.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  return judge
}

// T6 seam stays the same: actual Runtime + closed/reopened SQLite + controlled Host.
test('working without an interrupted event reopens into recoverable BLOCK and resumes through the normal driver', async () => {
  const h = recoveryHarness()
  try {
    await h.start()
    const before = await h.row()
    const oldActor = h.caller(before.execution.dispatch!)
    assert.equal((await h.store.events('ws', before.execution.executionId)).some(event => event.type === 'blocked'), false)

    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.phase, 'working')
    assert.equal(blocked.execution.input, 'root request')
    assert.match(blocked.execution.blockReason!, /host restarted/)

    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '外因已处理，先核对现场再继续。', 'manager', 'auto')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.notEqual(resumed.execution.dispatch?.id, before.execution.dispatch?.id)
    assert.match(h.messages.at(-1)!.text, /之前中断，请先检查实际完成情况；已完成勿重复副作用，未完继续；不确定\/缺权限BLOCK/)
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'late old work' }, oldActor)).ok, false)

    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: '现场核验后完成' }, h.caller(resumed.execution.dispatch!))
    await h.engine.handleTurnEnded('ws', h.caller(resumed.execution.dispatch!))
    const checking = await h.row()
    await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', '只读核验通过', h.caller(checking.execution.judge!))
    assert.equal((await h.row()).run.status, 'completed')
  } finally { h.close() }
})

test('a dispatch that may have been delivered without an acknowledgement gets a new qualification and recovery warning', async () => {
  const h = recoveryHarness()
  try {
    h.setManagerSendAfterAcceptFailure(true)
    await h.start()
    const uncertain = await h.row()
    assert.equal(uncertain.run.status, 'blocked')
    assert.equal(uncertain.execution.phase, 'working')
    assert.equal(uncertain.execution.dispatch?.messageId, undefined)
    const oldDispatchId = uncertain.execution.dispatch!.id

    h.setManagerSendAfterAcceptFailure(false)
    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '消息可能已送达；先检查现场再提交。', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.notEqual(resumed.execution.dispatch?.id, oldDispatchId)
    assert.ok(resumed.execution.dispatch?.messageId)
    assert.match(h.messages.at(-1)!.text, /已完成勿重复副作用/)
  } finally { h.close() }
})

async function enterRecoveryWorker(h: ReturnType<typeof recoveryHarness>) {
  await h.start()
  const rootJudge = await acceptRecoveryCurrent(h, 'manager handoff')
  await h.engine.handleTurnEnded('ws', rootJudge)
  const worker = await h.row()
  assert.equal(worker.execution.nodeId, 'work')
  assert.equal(worker.execution.phase, 'working')
  return worker
}

test('Manager recovery allows unknown cold Role only after explicit resume, but known unsafe idle stays BLOCKed', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    const before = await enterRecoveryWorker(h)
    h.reopen()
    await h.engine.handleRestartReconcile()
    let blocked = await h.row()
    h.setSafe(false)
    h.setActivity('idle')
    const denied = await h.engine.handleResume('ws', blocked.execution.nodeToken, '仍有Host可见活动，不能接手。', 'manager', 'actor')
    assert.equal(denied.ok, false)
    assert.match(denied.reason!, /not safely closed/)
    assert.equal((await h.row()).execution.dispatch?.id, before.execution.dispatch?.id)

    h.setActivity('unknown')
    blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '已人工核查旧Role无冲突，可冷接手。', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.status, 'running')
    assert.equal(resumed.execution.dispatch?.sessionId, 'worker-session')
    assert.notEqual(resumed.execution.dispatch?.id, before.execution.dispatch?.id)
  } finally { h.close() }
})

test('#21 F1: a hanging Role probe during node_resume fails with the stage name and keeps the Run BLOCKed', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    await withShortTimeouts({ whenIdle: 20 }, async () => {
      await enterRecoveryWorker(h)
      h.reopen()
      await h.engine.handleRestartReconcile()
      const blocked = await h.row()
      assert.equal(blocked.run.status, 'blocked')
      h.setSafe(false)
      h.setActivity('unknown')
      h.setSafetyGate(new Promise<never>(() => {}))
      await assert.rejects(
        h.engine.handleResume('ws', blocked.execution.nodeToken, '旧 Role 现场需要人工核验，先探针再决定。', 'manager', 'actor'),
        /timeout after 20ms at stage "whenIdle"/)
      const after = await h.row()
      assert.equal(after.run.status, 'blocked', 'a timed-out probe changes nothing and never hangs the Manager turn')
      assert.equal(after.execution.dispatch?.id, blocked.execution.dispatch?.id)
      assert.equal(after.stateVersion, blocked.stateVersion)
    })
  } finally { h.close() }
})

test('actor resume rechecks a settled Role dispatch and rejects a newly active Session', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    await enterRecoveryWorker(h)
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim awaiting a Judge' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = await h.row()
    await h.engine.handleTurnEnded('ws', h.caller(row.execution.judge!))
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.equal(row.execution.dispatch?.settled, true)
    h.setSafe(false)
    h.setActivity('active')
    const denied = await h.engine.handleResume('ws', row.execution.nodeToken, '旧Role被其它turn重新激活，不能退回Actor。', 'manager', 'actor')
    assert.equal(denied.ok, false)
    assert.match(denied.reason!, /not safely closed/)
    assert.deepEqual(await h.row(), row)
  } finally { h.close() }
})

test('a failed Role persistence probe cannot replace a still-live unsafe Actor', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    const before = await enterRecoveryWorker(h)
    h.reopen()
    await h.engine.handleRestartReconcile()
    h.setRoleAvailability('missing')
    h.setSafe(false)
    h.setActivity('active')
    const blocked = await h.row()
    const denied = await h.engine.handleResume('ws', blocked.execution.nodeToken, 'persistence读取失败但旧Actor仍active。', 'manager', 'actor')
    assert.equal(denied.ok, false)
    const unchanged = await h.row()
    assert.equal(unchanged.run.roleActors.worker, 'worker-session')
    assert.equal(unchanged.execution.dispatch?.id, before.execution.dispatch?.id)
    assert.deepEqual(h.ensuredActors, ['worker-session'])
  } finally { h.close() }
})

test('missing Role Session is replaced in the resume transaction and correction reuses it without compact', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    const before = await enterRecoveryWorker(h)
    const oldActor = h.caller(before.execution.dispatch!)
    h.reopen()
    await h.engine.handleRestartReconcile()
    h.setRoleAvailability('missing')
    h.setSafe(false)
    h.setActivity('unknown')
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '持久Session确认不存在，改由replacement核查。', 'manager', 'actor')).ok, true)
    let row = await h.row()
    assert.equal(row.execution.executionId, before.execution.executionId)
    assert.equal(row.run.roleActors.worker, 'worker-replacement-2')
    assert.equal(row.execution.dispatch?.sessionId, 'worker-replacement-2')
    assert.equal(row.execution.roleBoundaryPrepared, true)
    const replacementPrompt = h.messages.at(-1)!.text
    assert.match(replacementPrompt, /manager handoff/)
    assert.match(replacementPrompt, /\[instruction\]\nWork/)
    assert.doesNotMatch(replacementPrompt, /\[criteria\]/)
    assert.match(replacementPrompt, /持久Session确认不存在/)
    assert.match(replacementPrompt, /已完成勿重复副作用/)
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'old Role late claim' }, oldActor)).ok, false)

    const replacement = h.caller(row.execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'replacement candidate' }, replacement)
    h.setSafe(true)
    await h.engine.handleTurnEnded('ws', replacement)
    row = await h.row()
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', '需要补充核验证据', h.caller(row.execution.judge!))
    row = await h.row()
    assert.equal(row.execution.dispatch?.sessionId, 'worker-replacement-2')
    assert.equal(row.execution.roleBoundaryPrepared, true)
    assert.deepEqual(h.ensuredActors, ['worker-session', 'worker-replacement-2'])
    assert.match(h.messages.at(-1)!.text, /replacement candidate/)
  } finally { h.close() }
})

test('checking recovery keeps a settled claim and follows up the available unjudged Judge identity', async () => {
  const h = recoveryHarness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'durable candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const before = await h.row()
    const oldJudge = structuredClone(before.execution.judge)!

    h.reopen()
    h.setSafe(false)
    h.setActivity('unknown')
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '重启后继续只读核验。', 'manager', 'auto')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.claim?.id, before.execution.claim?.id)
    assert.equal(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.notEqual(resumed.execution.judge?.id, oldJudge.id)
    assert.notEqual(resumed.execution.judge?.messageId, oldJudge.messageId)
    assert.equal(resumed.execution.previousJudge, undefined)
    assert.equal(h.judgeFollowups.length, 1)
    assert.equal(h.judgeStarts.length, 1)
    assert.equal(h.judgeFollowups.at(-1)!.claim.handoff, 'durable candidate')
    assert.equal(h.judgeFollowups.at(-1)!.managerContext, '重启后继续只读核验。')
    assert.equal(h.judgeFollowups.at(-1)!.recovery, true)
    assert.ok((await h.store.events('ws', resumed.execution.executionId)).some(event => event.type === 'judge-arranged' && event.snapshot.judge?.id === resumed.execution.judge?.id))
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', 'late old turn', h.caller(oldJudge))).ok, false)
  } finally { h.close() }
})

test('checking recovery preserves an unjudged Judge when persistence availability is unknown', async () => {
  const h = recoveryHarness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate under uncertain persistence' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const oldJudge = structuredClone((await h.row()).execution.judge)!
    h.reopen()
    h.setJudgeAvailability('unknown')
    h.setSafe(false)
    h.setActivity('unknown')
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '持久层不可读但无已知冲突，冷续接原Judge。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.notEqual(resumed.execution.judge?.id, oldJudge.id)
    assert.equal(resumed.execution.previousJudge, undefined)
    assert.equal(h.judgeStarts.length, 1)
    assert.equal(h.judgeFollowups.length, 1)
    assert.equal((await h.engine.handleJudgeClaim('ws', resumed.execution.nodeToken, 'ACCEPT', 'late old turn', h.caller(oldJudge))).ok, false)
  } finally { h.close() }
})

test('checking recovery respawns a fresh Judge only when the durable Judge Session is missing', async () => {
  const h = recoveryHarness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate for replacement Judge' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const oldJudge = structuredClone((await h.row()).execution.judge)!

    h.reopen()
    h.setJudgeAvailability('missing')
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '旧Judge Session不存在，重建只读Judge。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.notEqual(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.equal(h.judgeFollowups.length, 0)
    assert.equal(h.judgeStarts.length, 2)
    assert.equal(h.judgeStarts.at(-1)!.claim.handoff, 'candidate for replacement Judge')
    assert.equal(h.judgeStarts.at(-1)!.recovery, true)
  } finally { h.close() }
})

test('checking with an unsettled Actor defaults auto recovery back to Actor and keeps the old claim as previous material', async () => {
  const h = recoveryHarness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'possibly completed before interruption' }, actor)
    const claim = structuredClone((await h.row()).execution.claim)!
    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '默认交还Actor核查并重新claim。', 'manager', 'auto')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.phase, 'working')
    assert.equal(resumed.execution.claim, undefined)
    assert.equal(resumed.execution.previousClaim?.id, claim.id)
    assert.match(h.messages.at(-1)!.text, /root request/)
    assert.match(h.messages.at(-1)!.text, /\[instruction\]\nPlan/)
    assert.doesNotMatch(h.messages.at(-1)!.text, /\[criteria\]/)
    assert.match(h.messages.at(-1)!.text, /possibly completed before interruption/)
    assert.match(h.messages.at(-1)!.text, /默认交还Actor核查并重新claim/)
    assert.match(h.messages.at(-1)!.text, /之前中断/)
  } finally { h.close() }
})

test('explicit Judge recovery keeps an unsettled Manager claim without treating the current Manager turn as the old turn', async () => {
  const h = recoveryHarness()
  try {
    await h.start()
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'Manager claim retained' }, actor)
    const claimId = (await h.row()).execution.claim!.id
    h.reopen()
    h.setSafe(false)
    h.setActivity('active')
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, 'Manager确认自己的旧turn已中断，直接交Judge。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.claim?.id, claimId)
    assert.equal(resumed.execution.dispatch?.settled, true)
    assert.ok(resumed.execution.judge?.messageId)
  } finally { h.close() }
})

test('explicit Judge recovery rejects known-unsafe Role activity but accepts Manager-confirmed unknown and keeps its claim', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    await enterRecoveryWorker(h)
    const actor = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'Role claim retained for Judge' }, actor)
    const claimId = (await h.row()).execution.claim!.id
    h.reopen()
    await h.engine.handleRestartReconcile()
    let blocked = await h.row()
    h.setSafe(false)
    h.setActivity('active')
    const denied = await h.engine.handleResume('ws', blocked.execution.nodeToken, '旧Role仍可见active，不能启动Judge。', 'manager', 'judge')
    assert.equal(denied.ok, false)
    assert.equal((await h.row()).execution.dispatch?.settled, false)

    h.setActivity('unknown')
    blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '已核查外因，旧Role无可见冲突，保留claim交Judge。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.claim?.id, claimId)
    assert.equal(resumed.execution.dispatch?.settled, true)
    assert.ok(resumed.execution.judge?.messageId)
  } finally { h.close() }
})

async function blockRecoveryNeedContext(h: ReturnType<typeof recoveryHarness>) {
  await h.start()
  const actor = h.caller((await h.row()).execution.dispatch!)
  await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim awaiting context' }, actor)
  await h.engine.handleTurnEnded('ws', actor)
  const checking = await h.row()
  const oldJudge = structuredClone(checking.execution.judge)!
  await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'NEED_CONTEXT', '需要Manager提供只读事实', h.caller(oldJudge))
  return oldJudge
}

test('an already-BLOCKed NEED_CONTEXT run is marked across restart and cold-follows the existing Judge after Manager confirmation', async () => {
  const h = recoveryHarness()
  try {
    const oldJudge = await blockRecoveryNeedContext(h)
    const before = await h.row()
    assert.equal(before.run.status, 'blocked')
    h.reopen()
    h.setSafe(false)
    h.setActivity('unknown')
    await h.engine.handleRestartReconcile()
    let blocked = await h.row()
    assert.equal(blocked.execution.restartPending, true)
    assert.equal(blocked.execution.blockReason, before.execution.blockReason)
    const status = await h.engine.status('ws', 'manager')
    assert.equal(status.status.execution.restartPending, true)
    assert.equal((await h.store.events('ws', blocked.execution.executionId)).at(-1)?.type, 'interrupted')
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '补充事实已核实，冷续接原Judge。', 'manager', 'judge')).ok, true)
    blocked = await h.row()
    assert.equal(blocked.execution.restartPending, false)
    assert.equal(blocked.execution.judge?.sessionId, oldJudge.sessionId)
    assert.equal(h.judgeFollowups.length, 1)
    assert.equal(h.judgeFollowups[0]!.previousFeedback?.reason, '需要Manager提供只读事实')
  } finally { h.close() }
})

test('an already-BLOCKed NEED_CONTEXT run rebuilds a missing Judge but preserves its claim and feedback', async () => {
  const h = recoveryHarness()
  try {
    const oldJudge = await blockRecoveryNeedContext(h)
    const claimId = (await h.row()).execution.claim!.id
    h.reopen()
    h.setJudgeAvailability('missing')
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    const startsBefore = h.judgeStarts.length
    h.setDrainFailure(new Error('old Judge drain failed'))
    const failed = await h.engine.handleResume('ws', blocked.execution.nodeToken, '原Judge不存在，按保存材料重建。', 'manager', 'judge')
    assert.equal(failed.ok, false)
    assert.deepEqual(await h.row(), blocked)
    assert.equal(h.judgeStarts.length, startsBefore)
    h.setDrainFailure(undefined)
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '原Judge不存在，按保存材料重建。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.deepEqual(h.drains.slice(-2), [oldJudge.sessionId, oldJudge.sessionId])
    assert.equal(resumed.execution.claim?.id, claimId)
    assert.notEqual(resumed.execution.judge?.sessionId, oldJudge.sessionId)
    assert.equal(h.judgeStarts.at(-1)!.previousFeedback?.reason, '需要Manager提供只读事实')
    assert.equal(h.judgeStarts.at(-1)!.managerContext, '原Judge不存在，按保存材料重建。')
  } finally { h.close() }
})

test('restart after an uncertain Judge followup preserves the Session but rotates the unjudged dispatch', async () => {
  const h = recoveryHarness()
  try {
    await blockRecoveryNeedContext(h)
    let blocked = await h.row()
    h.setJudgeFollowupFailure(new Error('Judge Queue acknowledgement lost'))
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '首次补充已保存。', 'manager', 'judge')).ok, true)
    const uncertain = await h.row()
    assert.equal(uncertain.run.status, 'blocked')
    assert.ok(uncertain.execution.judge)
    assert.equal(uncertain.execution.judge?.messageId, undefined)
    const uncertainJudge = structuredClone(uncertain.execution.judge)!

    h.setJudgeFollowupFailure(undefined)
    h.reopen()
    await h.engine.handleRestartReconcile()
    blocked = await h.row()
    const startsBefore = h.judgeStarts.length
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '确认旧turn无已知冲突，续接原Judge Session重新只读核验。', 'manager', 'judge')).ok, true)
    const resumed = await h.row()
    assert.equal(h.judgeStarts.length, startsBefore)
    assert.equal(resumed.execution.judge?.sessionId, uncertainJudge.sessionId)
    assert.notEqual(resumed.execution.judge?.id, uncertainJudge.id)
    assert.equal(h.judgeFollowups.at(-1)!.previousFeedback?.reason, '需要Manager提供只读事实')
    assert.equal(h.drains.includes(uncertainJudge.sessionId), false)
  } finally { h.close() }
})

test('restart recovery settles only an exited ACCEPT predecessor Judge and continues the registered successor', async () => {
  const h = recoveryHarness(configWithWorker())
  try {
    await h.start()
    const oldJudgeCaller = await acceptRecoveryCurrent(h, 'accepted predecessor handoff')
    const successor = await h.row()
    const predecessor = await h.store.execution('ws', successor.execution.predecessorId!)
    assert.equal(successor.execution.phase, 'ready')
    assert.equal(predecessor?.phase, 'exited')
    assert.equal(predecessor?.judgment?.result, 'ACCEPT')
    assert.equal(predecessor?.judge?.settled, false)

    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '重启已确认只读前驱Judge撤权，继续已登记后继。', 'manager', 'auto')).ok, true)
    const resumed = await h.row()
    const settledPredecessor = await h.store.execution('ws', blocked.execution.predecessorId!)
    assert.equal(resumed.execution.executionId, successor.execution.executionId)
    assert.equal(resumed.execution.phase, 'working')
    assert.equal(resumed.execution.input, 'accepted predecessor handoff')
    assert.equal(settledPredecessor?.judge?.settled, true)
    assert.equal(h.judgeStarts.length, 1, 'predecessor is not judged again')
    await h.engine.handleTurnEnded('ws', oldJudgeCaller)
    assert.equal((await h.row()).run.status, 'running')
  } finally { h.close() }
})

test('restart reconciliation contains one workspace CAS failure and continues the remaining workspaces', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t6-reconcile-'))
  const store = new StateStore(home)
  const base = makeStateHost(store)
  const subagents = {
    async ensureRoleActor() { throw new Error('unexpected Role') },
    async startJudge(_run: never, input: import('../src/engine/engine.ts').JudgeSpawnInput) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge' } },
    async followupJudge() { return { messageId: 'followup' } },
    async judgeSessionAvailability() { return 'missing' as const }, async roleSessionAvailability() { return 'missing' as const },
    async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {}, async compactRoleActor() { return { ok: true } }, async safeToInspect() { return true },
  }
  const targets = {
    async steerManager() { return { messageId: crypto.randomUUID() } },
    async sendRoleActor() { throw new Error('unexpected Role') }, managerSessionSeq() { return 0 },
  }
  const starter = new WorkflowEngine(targets, subagents, { async run() { throw new Error('T7') } }, base)
  try {
    await starter.startRun('ws-a', starter.buildInitialRun('manager-a', 'test', CONFIG, 'hash'), undefined, 'a')
    await starter.startRun('ws-b', starter.buildInitialRun('manager-b', 'test', CONFIG, 'hash'), undefined, 'b')
    let failed = false
    const conflicted = { ...base, async put(ws: string, run: import('../src/types.ts').RunState, version: number, changes: import('../src/types.ts').ExecutionChange[]) {
      if (ws === 'ws-a' && !failed) { failed = true; throw new Error('injected reconcile conflict') }
      return base.put(ws, run, version, changes)
    } }
    const restarted = new WorkflowEngine(targets, subagents, { async run() { throw new Error('T7') } }, conflicted)
    await restarted.handleRestartReconcile()
    assert.equal((await store.get('ws-a'))!.run.status, 'running')
    assert.equal((await store.get('ws-b'))!.run.status, 'blocked')
    assert.equal((await store.get('ws-b'))!.execution.restartPending, true)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})
