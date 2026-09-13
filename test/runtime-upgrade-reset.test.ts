import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { apply } from '../src/index.ts'
import { isRootCommandAgent, makeDshFlowCommand, type CommandHost } from '../src/commands/dsh-flow.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { StateAccess, StateStore, stateDbPath } from '../src/state/store.ts'
import type { WorkflowConfig } from '../src/types.ts'

const CONFIG: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v2', roles: {}, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', nodes: {
    plan: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
      onPass: 'END',
    },
  } },
}
const ROLE_CONFIG: WorkflowConfig = {
  ...CONFIG,
  roles: { worker: { persona: 'Worker' } },
  workflow: { startNode: 'plan', nodes: {
    plan: { ...CONFIG.workflow.nodes.plan!, onPass: 'work' },
    work: {
      execution: { type: 'actor-task', role: 'worker', instruction: 'Work' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct work' } },
      onPass: 'END',
    },
  } },
}
const SAME_ROLE_CONFIG: WorkflowConfig = {
  ...ROLE_CONFIG,
  // 同一个 Role 跨节点复用（整 Run 复用 + 边界 compact）是 `reuse: continuable` 的语义；
  // 缺省 `reuse: node` 在离开节点时即释放会话（见 runtime-work-order.test.ts 的 node 用例）。
  roles: { worker: { persona: 'Worker', reuse: 'continuable' } },
  workflow: { startNode: 'plan', nodes: {
    plan: { ...ROLE_CONFIG.workflow.nodes.plan!, onPass: 'first' },
    first: { ...ROLE_CONFIG.workflow.nodes.work!, onPass: 'second' },
    second: { ...ROLE_CONFIG.workflow.nodes.work!, onPass: 'END' },
  } },
}
const PROGRAM_CONFIG: WorkflowConfig = {
  ...CONFIG,
  workflow: { startNode: 'plan', nodes: {
    plan: { ...CONFIG.workflow.nodes.plan!, onPass: 'program' },
    program: {
      execution: { type: 'builtin-program', programId: 'github.all-milestone-issues-complete' },
      onPass: 'END',
    },
  } },
}

function resetHarness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t8-reset-'))
  const store = new StateStore(home)
  const messages: string[] = []
  const retired: string[] = []
  let safe = true
  let activity: 'active' | 'idle' | 'unknown' = 'unknown'
  let programEffect: Promise<{ kind: 'PASS'; handoff: string }> | undefined
  const inspected: string[] = []
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { messages.push(text); return { messageId: `manager-${messages.length}` } },
    async sendRoleActor() { return { messageId: 'role-followup' } },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor() { return { childId: 'old-role', messageId: 'role-1' } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge-1' } },
    async followupJudge() { return { messageId: 'judge-followup' } },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge(_run, id) { retired.push(id) },
    async drainJudge() { throw new Error('Reset must not drain external work') },
    async drainRoleActor() { throw new Error('Reset must not drain external work') },
    async compactRoleActor() { return { ok: true } },
    async safeToInspect(id) { inspected.push(id); return safe ? 'safe' : 'unsafe' },
  }, { async run() { if (!programEffect) throw new Error('unexpected Program'); return programEffect } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  engine.actorActivity = async () => activity
  return {
    home, store, engine, messages, retired, inspected,
    setSafety(nextSafe: boolean, nextActivity: typeof activity) { safe = nextSafe; activity = nextActivity },
    setProgramEffect(effect: typeof programEffect) { programEffect = effect },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('Manager Reset terminates the compatible active Run without erasing current work or reporting success', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', CONFIG, 'ignored'), undefined, 'root input')
    const before = (await h.store.get('ws'))!
    const messageCount = h.messages.length

    const outcome = await h.engine.handleReset('ws', 'manager')

    assert.equal(outcome.ok, true)
    const after = (await h.store.get('ws'))!
    assert.equal(after.run.status, 'terminated')
    assert.equal(after.execution.phase, before.execution.phase)
    assert.equal(after.execution.input, 'root input')
    assert.equal(after.execution.dispatch?.id, before.execution.dispatch?.id)
    assert.equal(after.execution.restartPending, false)
    assert.match(after.execution.blockReason ?? '', /terminated; external effects not cancelled/)
    assert.notEqual(after.execution.nodeToken, before.execution.nodeToken)
    assert.equal(after.run.callStack.at(-1)?.nodeToken, after.execution.nodeToken)
    assert.equal(h.messages.length, messageCount, 'Reset does not emit a successful handoff')
    assert.deepEqual((await h.store.events('ws', after.execution.executionId)).map(event => event.type).slice(-1), ['terminated'])
  } finally { h.close() }
})

test('a new Run follows a terminated Run while retained SQLite history stays outside current workflow_status', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('old-manager', 'test', CONFIG, 'ignored'), undefined, 'old input')
    const old = (await h.store.get('ws'))!
    await h.engine.handleReset('ws', 'old-manager')

    const started = await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')

    assert.equal(started.ok, true)
    const current = (await h.store.get('ws'))!
    assert.notEqual(current.run.runId, old.run.runId)
    assert.equal(current.run.managerSessionId, 'new-manager')
    assert.equal(current.execution.input, 'new input')
    assert.equal((await h.store.execution('ws', old.execution.executionId))?.input, 'old input')
    assert.ok((await h.store.events('ws', old.execution.executionId)).some(event => event.type === 'terminated'))
    for (const caller of ['old-manager', 'new-manager']) {
      const history = await h.engine.status('ws', caller, { executionId: old.execution.executionId })
      assert.equal(history.ok, false)
      assert.match(history.reason!, /current Run/)
    }
  } finally { h.close() }
})

test('known active work from a terminated Run blocks immediate start while explicit unknown risk may proceed', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('old-manager', 'test', ROLE_CONFIG, 'ignored'), undefined, 'old input')
    const actor = { sessionId: 'old-manager', turnUserMessageIds: new Set(['manager-1']) }
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan handoff' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = (await h.store.get('ws'))!
    const judge = { sessionId: row.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-1']) }
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)
    await h.engine.handleTurnEnded('ws', judge)
    row = (await h.store.get('ws'))!
    assert.equal(row.execution.dispatch?.sessionId, 'old-role')
    await h.engine.handleReset('ws', 'old-manager')

    h.setSafety(false, 'active')
    const denied = await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')
    assert.equal(denied.ok, false)
    assert.match(denied.reason!, /terminated Run.*not safely closed/)
    assert.equal((await h.store.get('ws'))!.run.status, 'terminated')

    h.setSafety(false, 'unknown')
    const allowed = await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')
    assert.equal(allowed.ok, true)
    assert.equal((await h.store.get('ws'))!.run.managerSessionId, 'new-manager')
  } finally { h.close() }
})

test('known active Judge from a terminated Run blocks start and a safely inspected Judge permits it', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('old-manager', 'test', CONFIG, 'ignored'), undefined, 'old input')
    const actor = { sessionId: 'old-manager', turnUserMessageIds: new Set(['manager-1']) }
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'candidate' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    const checking = (await h.store.get('ws'))!
    const oldJudge = { sessionId: checking.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-1']) }
    await h.engine.handleReset('ws', 'old-manager')
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'late old Judge', oldJudge)).ok, false)

    h.setSafety(false, 'idle')
    const denied = await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')
    assert.equal(denied.ok, false)
    assert.match(denied.reason!, /terminated Run.*not safely closed/)

    h.setSafety(true, 'active')
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')).ok, true)
  } finally { h.close() }
})

test('terminated ready Role visit inspects its mapped Actor and unsettled predecessor Judge before new start', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('old-manager', 'test', SAME_ROLE_CONFIG, 'ignored'), undefined, 'old input')
    const manager = { sessionId: 'old-manager', turnUserMessageIds: new Set(['manager-1']) }
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'plan' }, manager)
    await h.engine.handleTurnEnded('ws', manager)
    let row = (await h.store.get('ws'))!
    let judge = { sessionId: row.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-1']) }
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'plan accepted', judge)
    await h.engine.handleTurnEnded('ws', judge)

    const role = { sessionId: 'old-role', turnUserMessageIds: new Set(['role-1']) }
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'first result' }, role)
    await h.engine.handleTurnEnded('ws', role)
    row = (await h.store.get('ws'))!
    judge = { sessionId: row.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-1']) }
    const predecessorJudgeSession = judge.sessionId
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'first accepted', judge)
    row = (await h.store.get('ws'))!
    assert.equal(row.execution.nodeId, 'second')
    assert.equal(row.execution.phase, 'ready')
    assert.equal(row.execution.dispatch, undefined)
    assert.equal(row.run.roleActors.worker, 'old-role')
    assert.ok(row.execution.predecessorId)
    await h.engine.handleReset('ws', 'old-manager')
    h.inspected.length = 0

    h.setSafety(true, 'active')
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')).ok, true)
    assert.deepEqual(new Set(h.inspected), new Set(['old-role', predecessorJudgeSession]))
  } finally { h.close() }
})

test('plain reset command passes the invoking Agent and compatible mode to CommandHost', async () => {
  const calls: unknown[][] = []
  const host: CommandHost = {
    currentWorkspaceKey: async () => 'ws',
    list: async () => ({ entries: [], diagnostics: [] }),
    start: async () => ({ ok: false }),
    status: async () => ({ ok: false }),
    reset: async (...args: unknown[]) => { calls.push(args); return { ok: true, message: 'terminated' } },
  }
  const agent = { session: { id: 'manager', header: {} } }
  const result = await makeDshFlowCommand(host).handler({ commandId: 'x' as never, agent: agent as never, rawInput: 'reset', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls, [[agent, 'ws', 'compatible']])
})

test('non-Manager and repeated Reset are rejected; restart and late Actor work cannot mutate terminated state', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', CONFIG, 'ignored'), undefined, 'root input')
    const before = (await h.store.get('ws'))!
    assert.equal((await h.engine.handleReset('ws', 'intruder')).ok, false)
    assert.deepEqual(await h.store.get('ws'), before)
    assert.equal((await h.engine.handleReset('ws', 'manager')).ok, true)
    const terminated = (await h.store.get('ws'))!
    assert.equal((await h.engine.handleReset('ws', 'manager')).ok, false)
    await h.engine.handleRestartReconcile()
    assert.deepEqual(await h.store.get('ws'), terminated)
    const late = { sessionId: 'manager', turnUserMessageIds: new Set(['manager-1']) }
    assert.equal((await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'late' }, late)).ok, false)
    assert.deepEqual(await h.store.get('ws'), terminated)
  } finally { h.close() }
})

test('late Program result from a terminated Run cannot advance its replacement Run', async () => {
  const h = resetHarness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('old-manager', 'test', PROGRAM_CONFIG, 'ignored'), undefined, 'old input')
    const actor = { sessionId: 'old-manager', turnUserMessageIds: new Set(['manager-1']) }
    await h.engine.handleClaim('ws', { outcome: 'completed', handoff: 'program input' }, actor)
    await h.engine.handleTurnEnded('ws', actor)
    let row = (await h.store.get('ws'))!
    const judge = { sessionId: row.execution.judge!.sessionId, turnUserMessageIds: new Set(['judge-1']) }
    await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)
    await h.engine.handleTurnEnded('ws', judge)
    row = (await h.store.get('ws'))!
    assert.equal(row.execution.nodeId, 'program')

    let finish!: (result: { kind: 'PASS'; handoff: string }) => void
    h.setProgramEffect(new Promise(resolve => { finish = resolve }))
    const pending = h.engine.handleRunProgram('ws', row.execution.nodeToken, { milestoneNumber: 1 }, 'old-manager')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await h.store.get('ws'))!.execution.phase, 'working')
    await h.engine.handleReset('ws', 'old-manager')
    const started = await h.engine.startRun('ws', h.engine.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new input')
    assert.equal(started.ok, true)
    const replacement = (await h.store.get('ws'))!

    finish({ kind: 'PASS', handoff: 'late old Program result' })
    assert.equal((await pending).ok, false)
    assert.deepEqual(await h.store.get('ws'), replacement)
  } finally { h.close() }
})

test('incompatible v8 store enters maintenance and root-authorized cutover preserves a readable backup before v9 initialization', async () => {
  const h = resetHarness()
  let access: StateAccess | undefined
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', CONFIG, 'ignored'), undefined, 'legacy input')
    h.store.close()
    const legacy = new DatabaseSync(stateDbPath(h.home))
    legacy.exec("UPDATE runs SET format_version = 'agent-workflow-state/v8'; PRAGMA user_version = 8")
    legacy.close()

    access = new StateAccess(h.home)
    const diagnostic = access.maintenanceDiagnostic()
    assert.equal(diagnostic?.kind, 'incompatible')
    assert.equal(diagnostic?.userVersion, 8)
    assert.match(diagnostic?.reason ?? '', /incompatible state format/)
    assert.throws(() => access!.current(), /maintenance mode/)

    const cutover = await access.archiveIncompatible(async (source, destination, options) => {
      const writer = new DatabaseSync(stateDbPath(h.home))
      try {
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; BEGIN; UPDATE node_executions SET snapshot_json = json_set(snapshot_json, '$.input', 'WAL committed sentinel'); COMMIT")
        assert.ok(existsSync(`${stateDbPath(h.home)}-wal`))
        return options === undefined ? await sqliteBackup(source, destination) : await sqliteBackup(source, destination, options)
      } finally { writer.close() }
    })
    assert.ok(existsSync(cutover.backupPath))
    const backup = new DatabaseSync(cutover.backupPath, { readOnly: true })
    try {
      assert.equal((backup.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8)
      assert.equal((backup.prepare('SELECT snapshot_json FROM node_executions LIMIT 1').get() as { snapshot_json: string }).snapshot_json.includes('WAL committed sentinel'), true)
    } finally { backup.close() }
    assert.equal(access.maintenanceDiagnostic(), undefined)
    assert.equal((await access.current().list()).length, 0)
    const recovered = new WorkflowEngine({
      async steerManager() { return { messageId: 'recovered-manager' } },
      async sendRoleActor() { throw new Error('unexpected Role') }, managerSessionSeq() { return 0 },
    }, {
      async ensureRoleActor() { throw new Error('unexpected Role') },
      async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge' } },
      async followupJudge() { return { messageId: 'judge' } },
      async judgeSessionAvailability() { return 'available' as const }, async roleSessionAvailability() { return 'available' as const },
      async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {}, async compactRoleActor() { return { ok: true } }, async safeToInspect() { return 'safe' },
    }, { async run() { throw new Error('unexpected Program') } }, makeStateHost(() => access!.current()))
    assert.equal((await recovered.startRun('new-ws', recovered.buildInitialRun('new-manager', 'test', CONFIG, 'ignored'), undefined, 'new after cutover')).ok, true)
    const fresh = new DatabaseSync(stateDbPath(h.home), { readOnly: true })
    try { assert.equal((fresh.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9) }
    finally { fresh.close() }
  } finally {
    access?.close()
    h.close()
  }
})

test('incompatible backup failure leaves the source bytes and maintenance state unchanged', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t8-backup-failure-'))
  let access: StateAccess | undefined
  try {
    new StateStore(home).close()
    const raw = new DatabaseSync(stateDbPath(home))
    raw.exec('PRAGMA user_version = 8')
    raw.close()
    const before = readFileSync(stateDbPath(home))
    access = new StateAccess(home)

    await assert.rejects(access.archiveIncompatible(async () => { throw new Error('injected backup failure') }), /backup failed.*original store unchanged/)

    assert.deepEqual(readFileSync(stateDbPath(home)), before)
    assert.equal(access.maintenanceDiagnostic()?.userVersion, 8)
    assert.throws(() => access!.current(), /maintenance mode/)
    assert.equal(readdirSync(join(home, 'workflows')).some(name => name.includes('.backup-') || name.includes('.archive-')), false)
  } finally { access?.close(); rmSync(home, { recursive: true, force: true }) }
})

test('corrupt SQLite bytes stay diagnosable and are preserved as the raw backup before empty v9 cutover', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t8-corrupt-'))
  const bytes = Buffer.from('not a sqlite database\0old active bytes')
  mkdirSync(join(home, 'workflows'))
  writeFileSync(stateDbPath(home), bytes)
  const access = new StateAccess(home)
  try {
    const diagnostic = access.maintenanceDiagnostic()
    assert.equal(diagnostic?.kind, 'corrupt')
    assert.match(diagnostic?.reason ?? '', /not a database|unreadable/i)

    const cutover = await access.archiveIncompatible()

    assert.equal(cutover.backupPath, cutover.archivePath)
    assert.deepEqual(readFileSync(join(cutover.backupPath, 'state.sqlite3')), bytes)
    assert.equal(access.maintenanceDiagnostic(), undefined)
    assert.equal((await access.current().list()).length, 0)
  } finally { access.close(); rmSync(home, { recursive: true, force: true }) }
})

test('incompatible reset flag is strict and only root command Agents qualify for cutover', async () => {
  const calls: unknown[][] = []
  const host: CommandHost = {
    currentWorkspaceKey: async () => 'ws', list: async () => ({ entries: [], diagnostics: [] }),
    start: async () => ({ ok: false }), status: async () => ({ ok: false }),
    reset: async (...args: unknown[]) => { calls.push(args); return { ok: true } },
  }
  const root = { session: { id: 'root', header: {} } }
  const child = { session: { id: 'child', header: { parentSession: 'root' } } }
  const forgedOriginRoot = { session: { id: 'forged-origin', header: { origin: 'subagent' } } }
  const forgedDepthRoot = { session: { id: 'forged-depth', header: { delegationDepth: 1 } } }
  const command = makeDshFlowCommand(host)
  assert.equal((await command.handler({ commandId: 'x' as never, agent: root as never, rawInput: 'reset --incompatible-store', attachments: [], signal: new AbortController().signal })).kind, 'success')
  assert.deepEqual(calls, [[root, 'ws', 'incompatible-store']])
  assert.equal((await command.handler({ commandId: 'x' as never, agent: root as never, rawInput: 'reset --incompatible-store extra', attachments: [], signal: new AbortController().signal })).kind, 'error')
  assert.equal(calls.length, 1)
  assert.equal(isRootCommandAgent(root as never), true)
  assert.equal(isRootCommandAgent(child as never), false)
  assert.equal(isRootCommandAgent(forgedOriginRoot as never), false)
  assert.equal(isRootCommandAgent(forgedDepthRoot as never), false)
})

test('plugin apply stays active on an incompatible store and only root plus explicit flag performs whole-store cutover', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t8-apply-'))
  const previousHome = process.env.DSH_HOME
  const cleanups: Array<() => void> = []
  let command: CommandDefinition | undefined
  try {
    new StateStore(home).close()
    const raw = new DatabaseSync(stateDbPath(home))
    raw.exec('PRAGMA user_version = 8')
    raw.close()
    process.env.DSH_HOME = home
    const ctx = {
      effect(register: () => void | (() => void)) { const cleanup = register(); if (cleanup) cleanups.push(cleanup) },
      get() { return undefined },
      on() {},
      logger: { warn() {} },
      commands: { register(definition: CommandDefinition) { command = definition; return () => {} } },
      tools: { register() { return () => {} }, schemas() { return [] } },
      jobs: { onJobDone() { return () => {} }, list() { return [] } },
      agents: { get() { return undefined }, list() { return [] }, currentInitiator() { return undefined } },
      subagents: {}, compaction: {}, sessions: {},
    }

    assert.doesNotThrow(() => apply(ctx as never))
    assert.ok(command)
    const invoke = (agent: unknown, rawInput: string) => command!.handler({ commandId: 'x' as never, agent: agent as never, rawInput, attachments: [], signal: new AbortController().signal })
    const root = { session: { id: 'root', header: {} as { cwd?: string } } }
    const child = { session: { id: 'child', header: { parentSession: 'root' } } }
    const forgedOriginRoot = { session: { id: 'forged-origin', header: { origin: 'subagent' } } }
    const forgedDepthRoot = { session: { id: 'forged-depth', header: { delegationDepth: 1 } } }
    for (const input of ['status', 'list']) {
      const result = await invoke(root, input)
      assert.match(result.text ?? '', /maintenance mode|--incompatible-store/)
    }
    assert.match((await invoke(root, 'reset')).text ?? '', /没有 workspace cwd/)
    for (const denied of [child, forgedOriginRoot, forgedDepthRoot]) {
      assert.equal((await invoke(denied, 'reset --incompatible-store')).kind, 'error')
    }
    const unchanged = new DatabaseSync(stateDbPath(home), { readOnly: true })
    try { assert.equal((unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8) }
    finally { unchanged.close() }

    const cutover = await invoke(root, 'reset --incompatible-store')
    assert.equal(cutover.kind, 'success')
    assert.match(cutover.text ?? '', /backed up.*empty v9.*External effects were not cancelled/i)
    root.session.header.cwd = home
    const status = await invoke(root, 'status')
    assert.equal(status.kind, 'success')
    assert.match(status.text ?? '', /no active run/)
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
