import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StateStore, stateDbPath } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { authorizeToolCall } from '../src/tools/authz.ts'
import { EVENT_TYPES, type ClaimCaller, type WorkflowConfig } from '../src/types.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', nodes: {
    plan: { execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } }, onPass: 'review' },
    review: { execution: { type: 'actor-task', role: 'manager', instruction: 'Review' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct review' } }, onPass: 'END' },
  } },
}

// 已确认 seam：真实 Runtime + 临时 SQLite + 受控 Host；第二连接只用于注入SQL故障。
async function fixture(roleReview = false) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-store-safety-'))
  const store = new StateStore(home)
  let message = 0
  const roleDrains: string[] = []
  let raceAdvance = false
  const stateHost = makeStateHost(store)
  const put = stateHost.put
  // F3 探针：在 Role 离开节点的提交点先让另一写入者抢先提交，制造真实 CAS 版本冲突。
  stateHost.put = async (ws, run, expectedVersion, changes) => {
    if (raceAdvance && changes.some(change => change.events.includes('exited'))) {
      raceAdvance = false
      const rival = new StateStore(home)
      try {
        const current = (await rival.get(ws))!
        const drift = structuredClone(current.run)
        drift.modelOverrides.judge = { provider: 'rival', modelId: 'winner' }
        await rival.updateRow(ws, drift, current.stateVersion, [])
      } finally { rival.close() }
    }
    return put(ws, run, expectedVersion, changes)
  }
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: `actor-message-${++message}` } },
    async sendRoleActor() { throw new Error('unexpected Role') },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, role) { return { childId: `role-${role}`, messageId: `actor-message-${++message}` } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge-message-1' } },
    async followupJudge() { return { messageId: `judge-followup-${++message}` } }, async judgeSessionAvailability() { return 'available' as const }, async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {}, async drainRoleActor(run, role) { roleDrains.push(run.roleActors[role]!) }, async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' },
  }, { async run() { throw new Error('unexpected Program') } }, stateHost)
  engine.cwdResolver = async () => home
  const definition = structuredClone(config)
  if (roleReview) {
    definition.roles = { reviewer: { persona: 'Review' }, sibling: { persona: 'Other work' } }
    definition.workflow.nodes.review!.execution = { type: 'actor-task', role: 'reviewer', instruction: 'Review' }
  }
  const run = engine.buildInitialRun('manager', 'test', definition, 'ignored')
  await engine.startRun('ws', run, undefined, 'root request')
  const sql = new DatabaseSync(stateDbPath(home))
  const actor: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
  return { home, store, engine, sql, actor, roleDrains,
    setRaceAdvance(value: boolean) { raceAdvance = value },
    cleanup() { sql.close(); store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('event type constant drives the v9 SQLite CHECK contract', async () => {
  const f = await fixture()
  try {
    const schema = (f.sql.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'node_execution_events'").get() as { sql: string }).sql
    for (const type of EVENT_TYPES) assert.match(schema, new RegExp(`'${type}'`))
    assert.equal((schema.match(/'[^']+'/g) ?? []).length, EVENT_TYPES.length)
  } finally { f.cleanup() }
})

test('callStack token/node drift fails closed and leaves execution and events unchanged', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.get('ws'))!
    const events = await f.store.events('ws', before.execution.executionId)
    const tokenDrift = structuredClone(before.run)
    tokenDrift.callStack[0]!.nodeToken = '47d289be-9c27-44f1-bf54-d230bb60e3ae'
    await assert.rejects(f.store.updateRow('ws', tokenDrift, before.stateVersion, []), /execution\/callStack mismatch/)
    const nodeDrift = structuredClone(before.run)
    nodeDrift.callStack[0]!.nodeId = 'review'
    await assert.rejects(f.store.updateRow('ws', nodeDrift, before.stateVersion, []), /execution\/callStack mismatch/)
    assert.deepEqual(await f.store.get('ws'), before)
    assert.deepEqual(await f.store.events('ws', before.execution.executionId), events)
  } finally { f.cleanup() }
})

test('competing SQLite CAS writers cannot overwrite a winner or cross workspace Run identity', async () => {
  const f = await fixture()
  const second = new StateStore(f.home)
  try {
    assert.equal((await f.engine.startRun('other-ws', f.engine.buildInitialRun('other-manager', 'test', config, 'ignored'), undefined, 'other task')).ok, true)
    const before = (await f.store.get('ws'))!
    const other = (await f.store.get('other-ws'))!
    const firstRun = structuredClone(before.run)
    const secondRun = structuredClone(before.run)
    firstRun.modelOverrides.judge = { provider: 'first', modelId: 'winner-a' }
    secondRun.modelOverrides.judge = { provider: 'second', modelId: 'winner-b' }
    const results = await Promise.allSettled([
      f.store.updateRow('ws', firstRun, before.stateVersion, []),
      second.updateRow('ws', secondRun, before.stateVersion, []),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    const failure = results.find(result => result.status === 'rejected')
    assert.match(String(failure?.status === 'rejected' ? failure.reason : ''), /state version mismatch/)
    const winner = (await f.store.get('ws'))!
    assert.equal(winner.stateVersion, before.stateVersion + 1)
    await assert.rejects(second.updateRow('other-ws', winner.run, other.stateVersion, []), /runId is immutable/)
    assert.deepEqual(await f.store.get('other-ws'), other)
    assert.deepEqual(await f.store.get('ws'), winner)
    assert.equal(await f.store.execution('other-ws', winner.execution.executionId), undefined)
    await assert.rejects(f.store.events('other-ws', winner.execution.executionId), /not in the current run/)
  } finally { second.close(); f.cleanup() }
})

test('Manager controls Role BLOCK, but sibling mapping drift cannot impersonate the current dispatch', async () => {
  const f = await fixture(true)
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan artifact' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    const checking = (await f.store.get('ws'))!
    const judge: ClaimCaller = { sessionId: checking.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)
    await f.engine.handleTurnEnded('ws', judge)
    const role = (await f.store.get('ws'))!
    assert.equal(role.execution.dispatch?.sessionId, 'role-reviewer')
    assert.equal(role.execution.phase, 'working')
    const drift = structuredClone(role.run)
    drift.roleActors.reviewer = 'role-sibling'
    drift.roleActors.sibling = 'role-sibling'
    await f.store.updateRow('ws', drift, role.stateVersion, [])
    const before = (await f.store.get('ws'))!
    const sibling: ClaimCaller = { sessionId: 'role-sibling', turnUserMessageIds: new Set([before.execution.dispatch!.messageId!]) }
    assert.equal((await f.engine.handleBlock('ws', before.execution.nodeToken, 'sibling BLOCK', sibling)).ok, false)
    assert.deepEqual(await f.store.get('ws'), before)
    assert.equal((await f.engine.handleBlock('ws', before.execution.nodeToken, 'Manager pause', { sessionId: 'manager', turnUserMessageIds: new Set() })).ok, true)
    const blocked = (await f.store.get('ws'))!
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.blockReason, 'Manager pause')
    assert.equal(blocked.execution.dispatch?.sessionId, 'role-reviewer')
  } finally { f.cleanup() }
})

// deferred F3 入口 1：drain 先于 state.put，用真实 CAS 冲突固定提交失败时的持久层行为。
test('Role 离开节点的提交遇 CAS 冲突：映射保持原值、会话仍授权、无半提交', async () => {
  const f = await fixture(true)
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan artifact' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    let row = (await f.store.get('ws'))!
    const planJudge: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', planJudge)
    await f.engine.handleTurnEnded('ws', planJudge)
    row = (await f.store.get('ws'))!
    assert.equal(row.execution.dispatch?.sessionId, 'role-reviewer', '缺省 reuse=node 的 Role 已派发')

    const reviewer: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    assert.equal((await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'review artifact' }, reviewer)).ok, true)
    await f.engine.handleTurnEnded('ws', reviewer)
    const before = (await f.store.get('ws'))!
    const history = await f.store.events('ws', before.execution.executionId)
    const judge: ClaimCaller = { sessionId: before.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }

    f.setRaceAdvance(true)
    await assert.rejects(f.engine.handleJudgeClaim('ws', before.execution.nodeToken, 'ACCEPT', 'verified', judge), /state version mismatch/)

    const after = (await f.store.get('ws'))!
    assert.equal(after.run.roleActors.reviewer, 'role-reviewer', '提交失败时映射保持原值（未持久删除）')
    assert.deepEqual(after.execution, before.execution, '无半提交：工作单未推进')
    assert.deepEqual(await f.store.events('ws', before.execution.executionId), history, '无半提交：事件未追加')
    assert.deepEqual(f.roleDrains, ['role-reviewer'], 'drain 先于提交：会话已被释放')
    assert.equal(authorizeToolCall({
      run: after.run, sessionId: 'role-reviewer', knownRoleOfSession: 'reviewer', isJudgeSession: false, toolName: 'node_claim',
    }).allow, true, '映射未删，该会话仍持 workflow 工具授权')

    assert.equal((await f.engine.handleJudgeClaim('ws', after.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true, '冲突后同一 Judge 可重试')
    const completed = (await f.store.get('ws'))!
    assert.equal(completed.run.status, 'completed')
    assert.equal(completed.run.roleActors.reviewer, undefined, '重试提交成功后才删映射')
  } finally { f.cleanup() }
})

test('Manager Actor needs its exact message for claim/BLOCK, and accepted claim prevents later Actor BLOCK', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.get('ws'))!
    for (const ids of [[], ['old-message']]) {
      const caller: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(ids) }
      assert.equal((await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'unbound result' }, caller)).ok, false)
      assert.equal((await f.engine.handleBlock('ws', before.execution.nodeToken, 'unbound BLOCK', caller)).ok, false)
      assert.deepEqual(await f.store.get('ws'), before)
    }
    assert.equal((await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'accepted candidate' }, f.actor)).ok, true)
    const claimed = (await f.store.get('ws'))!
    assert.equal((await f.engine.handleBlock('ws', before.execution.nodeToken, 'late BLOCK', f.actor)).ok, false)
    assert.deepEqual(await f.store.get('ws'), claimed)
  } finally { f.cleanup() }
})

test('BLOCK event failure preserves dispatch qualification; successful BLOCK refuses later claim', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.get('ws'))!
    const events = await f.store.events('ws', before.execution.executionId)
    f.sql.exec("CREATE TRIGGER fail_block BEFORE INSERT ON node_execution_events WHEN NEW.type = 'blocked' BEGIN SELECT RAISE(ABORT, 'injected BLOCK event failure'); END")
    await assert.rejects(f.engine.handleBlock('ws', before.execution.nodeToken, 'need help', f.actor), /injected BLOCK event failure/)
    assert.deepEqual(await f.store.get('ws'), before)
    assert.deepEqual(await f.store.events('ws', before.execution.executionId), events)
    f.sql.exec('DROP TRIGGER fail_block')
    assert.equal((await f.engine.handleBlock('ws', before.execution.nodeToken, 'need help', f.actor)).ok, true)
    const blocked = (await f.store.get('ws'))!
    assert.equal(blocked.run.status, 'blocked')
    assert.equal((await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'late result' }, f.actor)).ok, false)
    assert.equal((await f.engine.handleBlock('ws', before.execution.nodeToken, 'duplicate', f.actor)).ok, false)
    assert.deepEqual(await f.store.get('ws'), blocked)
    assert.equal((await f.store.events('ws', before.execution.executionId)).filter(event => event.type === 'blocked').length, 1)
  } finally { f.cleanup() }
})

test('ACCEPT and successor entered failure commits neither work order nor events; exact Judge can retry once', async () => {
  const f = await fixture()
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan artifact' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    const before = (await f.store.get('ws'))!
    const history = await f.store.events('ws', before.execution.executionId)
    const caller: ClaimCaller = { sessionId: before.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }
    f.sql.exec("CREATE TRIGGER fail_entered BEFORE INSERT ON node_execution_events WHEN NEW.type = 'entered' BEGIN SELECT RAISE(ABORT, 'injected successor event failure'); END")
    await assert.rejects(f.engine.handleJudgeClaim('ws', before.execution.nodeToken, 'ACCEPT', 'verified', caller), /injected successor event failure/)
    assert.deepEqual(await f.store.get('ws'), before)
    assert.deepEqual(await f.store.events('ws', before.execution.executionId), history)
    f.sql.exec('DROP TRIGGER fail_entered')
    assert.equal((await f.engine.handleJudgeClaim('ws', before.execution.nodeToken, 'ACCEPT', 'verified', caller)).ok, true)
    assert.equal((await f.engine.handleJudgeClaim('ws', before.execution.nodeToken, 'ACCEPT', 'duplicate', caller)).ok, false)
    const after = (await f.store.get('ws'))!
    assert.equal(after.execution.nodeId, 'review')
    assert.equal(after.execution.input, 'plan artifact')
    assert.equal(after.execution.revision, 1)
    assert.equal(after.execution.predecessorId, before.execution.executionId)
    const predecessor = (await f.store.execution('ws', before.execution.executionId))!
    assert.equal(predecessor.phase, 'exited')
    assert.equal(predecessor.successorId, after.execution.executionId)
    assert.equal(predecessor.judgment?.result, 'ACCEPT')
    const events = await f.store.events('ws', before.execution.executionId)
    assert.deepEqual(events.slice(-2).map(event => event.type), ['judgment', 'exited'])
    assert.deepEqual((await f.store.events('ws', after.execution.executionId)).map(event => event.type), ['entered'])
    await f.engine.handleTurnEnded('ws', caller)
    assert.equal((await f.store.get('ws'))!.execution.phase, 'working')
  } finally { f.cleanup() }
})

test('Store rejects mutable input/snapshot and BLOCK retains the workspace slot', async () => {
  const f = await fixture()
  try {
    const row = (await f.store.get('ws'))!
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: { ...row.execution, input: 'silently replaced' }, expectedRevision: row.execution.revision, events: [] }]), /input is immutable/)
    const emptyResolution = structuredClone(row.execution)
    emptyResolution.resolution = { target: 'actor', inputVersion: emptyResolution.inputVersion }
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: emptyResolution, expectedRevision: row.execution.revision, events: [] }]), /resolution requires context or decision/)
    const staleResolution = structuredClone(row.execution)
    staleResolution.resolution = { target: 'actor', context: 'stale', inputVersion: staleResolution.inputVersion + 1 }
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: staleResolution, expectedRevision: row.execution.revision, events: [] }]), /resolution input version mismatch/)
    const altered = structuredClone(row.run)
    altered.definitionSnapshot.judgeRole.persona = 'Changed during run'
    await assert.rejects(f.store.updateRow('ws', altered, row.stateVersion, []), /definitionSnapshot is immutable/)
    assert.deepEqual(await f.store.get('ws'), row)
    assert.equal((await f.engine.handleBlock('ws', row.execution.nodeToken, 'need Manager decision', f.actor)).ok, true)
    const blocked = (await f.store.get('ws'))!
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.input, 'root request')
    assert.equal((await f.engine.startRun('ws', f.engine.buildInitialRun('manager', 'test', config, 'ignored'), undefined, 'new task')).ok, false)
    assert.deepEqual(await f.store.get('ws'), blocked)
    const invalid = structuredClone(blocked.run)
    invalid.definitionHash = 'invalid hash'
    f.sql.prepare('UPDATE runs SET snapshot_json = ? WHERE run_id = ?').run(JSON.stringify(invalid), invalid.runId)
    await assert.rejects(f.store.get('ws'), /definitionSnapshot hash mismatch/)
  } finally { f.cleanup() }
})

test('legacy state fails closed without creating empty replacement tables or changing original data', () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-legacy-safety-'))
  mkdirSync(join(home, 'workflows'))
  const sql = new DatabaseSync(stateDbPath(home))
  try {
    sql.exec("CREATE TABLE workflow_state (snapshot_json TEXT); INSERT INTO workflow_state VALUES ('old active materials')")
    assert.throws(() => new StateStore(home), /legacy workflow_state contains data/)
    assert.deepEqual(sql.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name), ['workflow_state'])
    assert.equal(sql.prepare('SELECT snapshot_json FROM workflow_state').get()!.snapshot_json, 'old active materials')
  } finally { sql.close(); rmSync(home, { recursive: true, force: true }) }
})

test('Store rejects previousJudge without a historical judgment', async () => {
  const f = await fixture()
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'returned claim' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    let row = (await f.store.get('ws'))!
    const oldJudge = structuredClone(row.execution.judge)!
    const judge: ClaimCaller = { sessionId: oldJudge.sessionId, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleTurnEnded('ws', judge)
    row = (await f.store.get('ws'))!
    assert.equal((await f.engine.handleResume('ws', row.execution.nodeToken, 'Return unjudged claim to Actor.', 'manager', 'actor')).ok, true)
    row = (await f.store.get('ws'))!
    assert.equal(row.execution.judgment, undefined)
    assert.equal(row.execution.previousJudge, undefined)

    const wrongClaim = structuredClone(row.execution)
    wrongClaim.previousJudge = { ...oldJudge, claimId: 'forged-claim' }
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: wrongClaim, expectedRevision: row.execution.revision, events: [] }]), /previous Judge requires a historical judgment/)
    const wrongSession = structuredClone(row.execution)
    wrongSession.previousJudge = { ...oldJudge, claimId: row.execution.previousClaim!.id, sessionId: '' }
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: wrongSession, expectedRevision: row.execution.revision, events: [] }]))
    assert.deepEqual(await f.store.get('ws'), row)
  } finally { f.cleanup() }
})

test('Store and event reads reject forged historical Judge dispatch or Session identity', async () => {
  const f = await fixture()
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'claim one' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    let row = (await f.store.get('ws'))!
    const judge: ClaimCaller = { sessionId: row.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', 'missing existing criterion', judge)
    row = (await f.store.get('ws'))!
    assert.equal(row.execution.previousClaim?.handoff, 'claim one')
    assert.equal(row.execution.judgment?.judgeDispatchId, row.execution.previousJudge?.id)
    assert.equal(row.execution.judgment?.judgeSessionId, row.execution.previousJudge?.sessionId)

    for (const field of ['id', 'sessionId'] as const) {
      const forged = structuredClone(row.execution)
      forged.previousJudge![field] = `forged-${field}`
      await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{
        execution: forged, expectedRevision: row.execution.revision, events: [],
      }]), /historical judgment\/Judge mismatch/)
    }
    assert.deepEqual(await f.store.get('ws'), row)
    const events = await f.store.events('ws', row.execution.executionId)
    const judgmentEvent = events.find(event => event.type === 'judgment' && event.snapshot.judgment?.result === 'REJECT')!
    assert.equal(judgmentEvent.snapshot.previousJudge?.id, judgmentEvent.snapshot.judgment?.judgeDispatchId)
    const forgedSnapshot = structuredClone(judgmentEvent.snapshot)
    forgedSnapshot.previousJudge!.sessionId = 'forged-event-session'
    f.sql.prepare('UPDATE node_execution_events SET snapshot_json = ? WHERE execution_id = ? AND sequence = ?')
      .run(JSON.stringify(forgedSnapshot), judgmentEvent.executionId, judgmentEvent.sequence)
    await assert.rejects(f.store.events('ws', row.execution.executionId), /historical judgment\/Judge mismatch/)
  } finally { f.cleanup() }
})

test('Store rejects invalid current and same-claim historical REJECT verdict positions', async () => {
  const f = await fixture()
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    let row = (await f.store.get('ws'))!
    const judge: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need context', judge)
    row = (await f.store.get('ws'))!
    const wrongSession = structuredClone(row.execution)
    wrongSession.judgment!.judgeSessionId = 'forged-judge-session'
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{
      execution: wrongSession, expectedRevision: row.execution.revision, events: [],
    }]), /judgment dispatch\/session mismatch/)
    const currentReject = structuredClone(row.execution)
    currentReject.judgment!.result = 'REJECT'
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{
      execution: currentReject, expectedRevision: row.execution.revision, events: [],
    }]), /REJECT cannot be a current judgment/)
    assert.deepEqual(await f.store.get('ws'), row)

    assert.equal((await f.engine.handleResume('ws', row.execution.nodeToken, 'Supply context for another judgment turn.', 'manager', 'judge')).ok, true)
    const historical = (await f.store.get('ws'))!
    assert.equal(historical.execution.judgment?.result, 'NEED_CONTEXT')
    assert.equal(historical.execution.judgment?.claimId, historical.execution.claim?.id)
    const historicalReject = structuredClone(historical.execution)
    historicalReject.judgment!.result = 'REJECT'
    await assert.rejects(f.store.updateRow('ws', historical.run, historical.stateVersion, [{
      execution: historicalReject, expectedRevision: historical.execution.revision, events: [],
    }]), /historical REJECT must target previous claim/)
    assert.deepEqual(await f.store.get('ws'), historical)
  } finally { f.cleanup() }
})

test('Store binds Judge followup mode to the exact historical NEED_CONTEXT Judge Session', async () => {
  const f = await fixture()
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    let row = (await f.store.get('ws'))!
    const judge: ClaimCaller = { sessionId: row.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need exact context', judge)
    row = (await f.store.get('ws'))!
    await f.engine.handleResume('ws', row.execution.nodeToken, 'authoritative context', 'manager', 'judge')
    row = (await f.store.get('ws'))!
    assert.equal(row.execution.resolution?.judgeMode, 'followup')
    assert.equal(row.execution.resolution?.judgeSessionId, row.execution.previousJudge?.sessionId)

    const wrongSession = structuredClone(row.execution)
    wrongSession.resolution!.judgeSessionId = 'forged-followup-session'
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: wrongSession, expectedRevision: row.execution.revision, events: [] }]), /Judge followup.*historical/)
    const missingMode = structuredClone(row.execution)
    delete missingMode.resolution!.judgeMode
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: missingMode, expectedRevision: row.execution.revision, events: [] }]), /recovery mode/)
    const freshWithSession = structuredClone(row.execution)
    freshWithSession.resolution!.judgeMode = 'fresh'
    await assert.rejects(f.store.updateRow('ws', row.run, row.stateVersion, [{ execution: freshWithSession, expectedRevision: row.execution.revision, events: [] }]), /followup requires exactly one Session/)
    assert.deepEqual(await f.store.get('ws'), row)
  } finally { f.cleanup() }
})

test('failed respawn arrangement keeps the old Judge identity and reports failure', async () => {
  const f = await fixture()
  try {
    await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, f.actor)
    await f.engine.handleTurnEnded('ws', f.actor)
    let row = (await f.store.get('ws'))!
    const judge: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set(['judge-message-1']) }
    await f.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'need replacement', judge)
    row = (await f.store.get('ws'))!
    const events = await f.store.events('ws', row.execution.executionId)
    f.sql.exec("CREATE TRIGGER fail_respawn BEFORE INSERT ON node_execution_events WHEN NEW.type = 'judge-respawned' BEGIN SELECT RAISE(ABORT, 'injected respawn arrangement failure'); END")
    const failed = await f.engine.handleRespawnJudge('ws', row.execution.nodeToken, 'replace Judge', 'manager')
    assert.equal(failed.ok, false)
    assert.match(failed.reason!, /injected respawn arrangement failure/)
    assert.deepEqual(await f.store.get('ws'), row)
    assert.deepEqual(await f.store.events('ws', row.execution.executionId), events)
    f.sql.exec('DROP TRIGGER fail_respawn')
    assert.equal((await f.engine.handleRespawnJudge('ws', row.execution.nodeToken, 'retry replacement', 'manager')).ok, true)
  } finally { f.cleanup() }
})

test('v3 three-table state is rejected without physical or logical mutation', () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-v3-safety-'))
  mkdirSync(join(home, 'workflows'))
  const path = stateDbPath(home)
  const raw = new DatabaseSync(path)
  try {
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE, workspace_key TEXT NOT NULL,
        format_version TEXT NOT NULL, state_version INTEGER NOT NULL CHECK(state_version > 0),
        status TEXT NOT NULL CHECK(status IN ('running', 'blocked', 'completed')), current_execution_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id, current_execution_id) REFERENCES node_executions(run_id, execution_id) DEFERRABLE INITIALLY DEFERRED
      ) STRICT;
      CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_key) WHERE status IN ('running', 'blocked');
      CREATE INDEX workspace_runs ON runs(workspace_key, sequence DESC);
      CREATE TABLE node_executions (
        execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), visit INTEGER NOT NULL CHECK(visit > 0),
        revision INTEGER NOT NULL CHECK(revision > 0), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        UNIQUE(run_id, execution_id), UNIQUE(run_id, visit)
      ) STRICT;
      CREATE TABLE node_execution_events (
        execution_id TEXT NOT NULL REFERENCES node_executions(execution_id), sequence INTEGER NOT NULL CHECK(sequence > 0),
        type TEXT NOT NULL CHECK(type IN ('entered', 'actor-arranged', 'claim', 'judge-arranged', 'judgment', 'exited', 'blocked')),
        at TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), PRIMARY KEY(execution_id, sequence)
      ) STRICT;
      PRAGMA user_version = 3;
      INSERT INTO runs (run_id, workspace_key, format_version, state_version, status, current_execution_id, snapshot_json, updated_at)
        VALUES ('v3-run', 'v3-workspace', 'agent-workflow-state/v3', 7, 'blocked', 'v3-execution', '{"sentinel":"run"}', 'old-time');
      INSERT INTO node_executions (execution_id, run_id, visit, revision, snapshot_json)
        VALUES ('v3-execution', 'v3-run', 1, 4, '{"sentinel":"execution"}');
      INSERT INTO node_execution_events (execution_id, sequence, type, at, snapshot_json)
        VALUES ('v3-execution', 1, 'blocked', 'old-time', '{"sentinel":"event"}');
    `)
  } finally { raw.close() }
  const snapshot = () => {
    const db = new DatabaseSync(path)
    try {
      return {
        version: db.prepare('PRAGMA user_version').get(),
        schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY type, name").all(),
        runs: db.prepare('SELECT * FROM runs ORDER BY sequence').all(),
        executions: db.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
        events: db.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
      }
    } finally { db.close() }
  }
  try {
    const before = snapshot()
    const hashBefore = createHash('sha256').update(readFileSync(path)).digest('hex')
    assert.throws(() => new StateStore(home), /incompatible state format/)
    assert.deepEqual(snapshot(), before)
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hashBefore)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('v4 three-table state is rejected without changing its rows or version', async () => {
  const f = await fixture()
  try {
    f.store.close()
    f.sql.exec("UPDATE runs SET format_version = 'agent-workflow-state/v4'; PRAGMA user_version = 4")
    const before = {
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }
    assert.throws(() => new StateStore(f.home), /incompatible state format/)
    assert.deepEqual({
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }, before)
  } finally { f.cleanup() }
})

test('v5 state without the Role boundary fact is rejected without changing its rows or version', async () => {
  const f = await fixture()
  try {
    f.store.close()
    f.sql.exec(`
      UPDATE runs SET format_version = 'agent-workflow-state/v5';
      UPDATE node_executions SET snapshot_json = json_remove(snapshot_json, '$.roleBoundaryPrepared');
      UPDATE node_execution_events SET snapshot_json = json_remove(snapshot_json, '$.roleBoundaryPrepared');
      PRAGMA user_version = 5;
    `)
    const before = {
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }
    assert.throws(() => new StateStore(f.home), /incompatible state format/)
    assert.deepEqual({
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }, before)
  } finally { f.cleanup() }
})

test('v6 state without restart and Judge recovery facts is rejected without changing its rows or version', async () => {
  const f = await fixture()
  try {
    f.store.close()
    f.sql.exec(`
      UPDATE runs SET format_version = 'agent-workflow-state/v6';
      UPDATE node_executions SET snapshot_json = json_remove(snapshot_json, '$.restartPending', '$.resolution.judgeMode', '$.resolution.judgeSessionId');
      UPDATE node_execution_events SET snapshot_json = json_remove(snapshot_json, '$.restartPending', '$.resolution.judgeMode', '$.resolution.judgeSessionId');
      PRAGMA user_version = 6;
    `)
    const before = {
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }
    assert.throws(() => new StateStore(f.home), /incompatible state format/)
    assert.deepEqual({
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }, before)
  } finally { f.cleanup() }
})

test('v7-shaped rows without CallFrame execution identity are rejected unchanged', async () => {
  const f = await fixture()
  try {
    f.store.close()
    f.sql.exec(`
      UPDATE runs SET format_version = 'agent-workflow-state/v7', snapshot_json = json_remove(snapshot_json, '$.callStack[0].executionId');
      PRAGMA user_version = 7;
    `)
    const before = {
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }
    assert.throws(() => new StateStore(f.home), /incompatible state format/)
    assert.deepEqual({
      version: f.sql.prepare('PRAGMA user_version').get(),
      runs: f.sql.prepare('SELECT * FROM runs ORDER BY sequence').all(),
      executions: f.sql.prepare('SELECT * FROM node_executions ORDER BY execution_id').all(),
      events: f.sql.prepare('SELECT * FROM node_execution_events ORDER BY execution_id, sequence').all(),
    }, before)
  } finally { f.cleanup() }
})

test('claim event failure rolls back current work; original dispatch retries and survives SQLite reopen', async () => {
  const f = await fixture()
  try {
    const before = (await f.store.get('ws'))!
    const events = await f.store.events('ws', before.execution.executionId)
    f.sql.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON node_execution_events WHEN NEW.type = 'claim' BEGIN SELECT RAISE(ABORT, 'injected claim event failure'); END")
    await assert.rejects(f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan artifact' }, f.actor), /injected claim event failure/)
    assert.deepEqual(await f.store.get('ws'), before)
    assert.deepEqual(await f.store.events('ws', before.execution.executionId), events)
    f.sql.exec('DROP TRIGGER fail_claim')
    assert.equal((await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan artifact' }, f.actor)).ok, true)
    assert.equal((await f.engine.handleClaim('ws', { outcome: 'completed', handoff: 'duplicate artifact' }, f.actor)).ok, false)
    f.store.close()
    const reopened = new StateStore(f.home)
    try {
      const row = (await reopened.get('ws'))!
      assert.equal(row.execution.input, 'root request')
      assert.equal(row.execution.claim?.handoff, 'plan artifact')
      assert.equal(row.execution.phase, 'checking')
      const history = await reopened.events('ws', row.execution.executionId)
      assert.equal(history.filter(event => event.type === 'claim').length, 1)
      assert.equal(history.at(-1)?.snapshot.claim?.handoff, 'plan artifact')
      assert.deepEqual((await reopened.events('ws', row.execution.executionId, history[0]!.sequence, 1)).map(event => event.sequence), [2])
    } finally { reopened.close() }
  } finally { f.cleanup() }
})
