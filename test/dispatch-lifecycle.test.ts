import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import {
  makeDispatchLifecycleTracker,
  observeActivationResult,
  describeActivationSettlement,
  shortRouteLabel,
  type TrackedDispatch,
} from '../src/plugin/dispatch-lifecycle.ts'

/**
 * Issue #221：派发生命周期终止信号收口的定向回归。
 *
 * 真实 Runtime + 临时 SQLite + 受控 Host（与 runtime-work-order.test.ts 同一接缝）。
 * 受控 Host 在 ensureRoleActor/startJudge 内同步 noteStart， faithfully 模拟宿主
 * `subagent/start` 边（受理返回前到达）；各用例直接调用
 * `engine.handleActivationSettled`，模拟 index.ts 的 `subagent/end` 监听经
 * setImmediate 转交的终态（转交本身的时序由真实宿主验收覆盖）。
 */
const CONFIG = {
  schemaVersion: 'agent-workflow/v3' as const, roles: { worker: { persona: 'Worker' } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: { plan: {
    execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
    checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
    results: { succeeded: { criteria: 'The plan is complete.', target: { return: 'done' } } },
  } } },
}

/**
 * v3 迁移期配置辅助（同 runtime-work-order.test.ts）：plan(manager) → work(worker)，
 * actor 待对账条目只对非 manager 角色存在（manager 节点走 steer，无 Activation）。
 */
type LegacyNode = {
  execution: { type: 'actor-task'; role: string; instruction: string }
  checker: { checkerId: string; config: { criteria: string } }
  onPass?: string
  onFail?: string
}
type Tracked = import('../src/types.ts').WorkflowConfig & { __actor: Record<string, LegacyNode> }
const track = (config: import('../src/types.ts').WorkflowConfig): Tracked => {
  const tracked = config as Tracked
  tracked.__actor = {}
  for (const [nodeId, node] of Object.entries(config.workflow.nodes)) {
    if (node.execution.type !== 'child-workflow') tracked.__actor[nodeId] = { ...node } as unknown as LegacyNode
  }
  return tracked
}
const targetV3 = (name: string, returns: string[]): import('../src/types.ts').Target =>
  name === 'END' ? { return: returns[0] ?? 'done' } : { node: name }
const compile = (config: Tracked): import('../src/types.ts').WorkflowConfig => {
  const returns = config.workflow.returns
  for (const [nodeId, legacy] of Object.entries(config.__actor)) {
    const node = config.workflow.nodes[nodeId]
    if (!node || node.execution.type === 'child-workflow') continue
    if (legacy.onPass === undefined) continue
    node.results = {
      succeeded: { criteria: 'The node concluded successfully.', target: targetV3(legacy.onPass, returns) },
      ...(legacy.onFail === undefined ? {} : { failed: { criteria: 'The node could not conclude successfully.', target: targetV3(legacy.onFail, returns) } }),
    }
  }
  delete (config as { __actor?: unknown }).__actor
  return config
}
const legacyNodes = (config: Tracked): Record<string, LegacyNode> => config.__actor
function configWithWorker(onFail = 'work'): import('../src/types.ts').WorkflowConfig {
  const config = track(structuredClone(CONFIG) as import('../src/types.ts').WorkflowConfig)
  config.roles.worker = { persona: 'Worker' }
  legacyNodes(config)['plan']!.onPass = 'work'
  legacyNodes(config)['work'] = {
    execution: { type: 'actor-task', role: 'worker', instruction: 'Work' },
    checker: CONFIG.workflow.nodes.plan.checker,
    onPass: 'END',
    onFail,
  } as LegacyNode
  config.workflow.nodes.work = { execution: legacyNodes(config)['work']!.execution, checker: legacyNodes(config)['work']!.checker } as never
  return compile(config)
}
const resultOf = (outcome: 'completed' | 'failed'): string => outcome === 'completed' ? 'succeeded' : 'failed'
async function acceptCurrent(h: ReturnType<typeof harness>, handoff = 'artifact', outcome: 'completed' | 'failed' = 'completed') {
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { result: resultOf(outcome), handoff }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  const row = await h.row()
  const judge = h.caller(row.execution.judge!)
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  return judge
}
/** 推进到 work 节点并派发 worker，进入待对账 covered 的 actor Activation 路径。 */
async function driveToWorker(h: ReturnType<typeof harness>) {
  await h.start()
  // Judge turn 收尾即推进后继并派发（同 runtime-work-order 用例 402/438 行模式）。
  await h.engine.handleTurnEnded('ws', await acceptCurrent(h))
  const row = await h.row()
  assert.equal(row.execution.dispatch!.sessionId, 'actor-session')
}

/** 受控 harness（接缝同 runtime-work-order.test.ts，另加待对账 tracker）。 */
function harness(config: typeof CONFIG = CONFIG) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-dispatch-lifecycle-'))
  const store = new StateStore(home)
  const tracker = makeDispatchLifecycleTracker()
  const judges: string[] = []
  const send = (sessionId: string, _text: string) => ({ messageId: `message-${sessionId}` })
  const stateHost = makeStateHost(store)
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) {
      // 宿主 start 边在受理返回前到达：先记世代，再返回回执。
      tracker.noteStart('actor-session', 'epoch-actor-1')
      return { ...send('actor-session', text), childId: 'actor-session' }
    },
    async startJudge(_run, input) {
      judges.push(input.judgeSessionId)
      tracker.noteStart(input.judgeSessionId, `epoch-${input.judgeSessionId}`)
      return { ...send(input.judgeSessionId, 'Judge'), judgeSessionId: input.judgeSessionId }
    },
    async safeToInspect() { return 'safe' },
    async retireJudge() {},
    async drainJudge() {},
    async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async followupJudge(_run, judgeSessionId, _input) { return send(judgeSessionId, 'Judge followup') },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    dispatchLifecycle: tracker,
  }, { async run() { throw new Error('T7') } }, stateHost)
  engine.cwdResolver = async () => home
  return {
    home, store, engine, tracker, judges,
    caller: (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) }),
    async start() { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'root request') },
    async row() { return (await store.get('ws'))! },
    blockedEvents: async (executionId: string) => (await store.events('ws', executionId)).filter(event => event.type === 'blocked'),
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

const flushMicrotasks = async () => { await new Promise(resolve => setImmediate(resolve)) }
/** 进入 checking 并安排 Judge，返回 Judge 会话与世代。 */
async function driveToJudge(h: ReturnType<typeof harness>) {
  await h.start()
  const actor = h.caller((await h.row()).execution.dispatch!)
  assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'saved artifact' }, actor)).ok, true)
  await h.engine.handleTurnEnded('ws', actor)
  await h.engine.drive('ws')
  const row = await h.row()
  assert.equal(row.execution.phase, 'checking')
  const sessionId = row.execution.judge!.sessionId
  return { sessionId, epoch: h.tracker.epochOf(sessionId)! }
}

test('A1 actor 受理后无 turn/end 失败 → 技术 BLOCK 且保留已有材料', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    const before = await h.row()
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error', provider: 'test-provider' })
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /^activation settled without turn\/end: actor role=worker/)
    assert.match(blocked.execution.blockReason!, /stop=error provider=test-provider/)
    assert.equal(blocked.execution.input, 'artifact')
    assert.equal(blocked.execution.claim, undefined)
    assert.equal(blocked.execution.dispatch!.settled, false)
    assert.equal((await h.blockedEvents(blocked.execution.executionId)).length, 1)
    // C1 去重：重复/逆序到达的终态不再 BLOCK。
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.blockedEvents(before.execution.executionId)).length, 1)
    assert.equal(h.tracker.peek('actor-session'), undefined)
  } finally { h.close() }
})

test('A2 activation.result reject 记录失败码 → 终态 BLOCK 携带 code（已脱敏）', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    observeActivationResult(h.tracker, 'actor-session',
      Promise.reject(Object.assign(new Error('boom api_key=sk-xyz-secret'), { code: 'EACT' })))
    await flushMicrotasks()
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /code=EACT/)
    assert.doesNotMatch(blocked.execution.blockReason!, /sk-xyz-secret/)
  } finally { h.close() }
})

test('A3 activation.result resolve 非 completed → 终态 BLOCK', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    observeActivationResult(h.tracker, 'actor-session', Promise.resolve({ stopReason: 'error' }))
    await flushMicrotasks()
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

test('E 执行 completed 仅清理失败 → 不 BLOCK、不撤销，只清条目', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    observeActivationResult(h.tracker, 'actor-session', Promise.resolve({ stopReason: 'completed' }))
    await flushMicrotasks()
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.ok(row.execution.blockReason == null)
    assert.equal(h.tracker.peek('actor-session'), undefined)
    assert.equal((await h.blockedEvents(row.execution.executionId)).length, 0)
  } finally { h.close() }
})

test('B1 身份发布前到达的终态缓存 → 发布时对账 BLOCK', async () => {
  const h = harness(configWithWorker())
  try {
    await h.start()
    const planJudge = await acceptCurrent(h)
    // 终态先到（work 尚未派发、尚无条目）：缓存。
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'running')
    // 身份发布时对账：终态与新世代匹配 → BLOCK。
    await h.engine.handleTurnEnded('ws', planJudge)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /^activation settled without turn\/end: actor/)
  } finally { h.close() }
})

test('B2 陈旧世代的缓存终态 → 发布时丢弃，不 BLOCK', async () => {
  const h = harness(configWithWorker())
  try {
    await h.start()
    const planJudge = await acceptCurrent(h)
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-0', stopReason: 'error' })
    await h.engine.handleTurnEnded('ws', planJudge)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.ok(row.execution.blockReason == null)
    assert.equal(h.tracker.peek('actor-session')?.epochRunId, 'epoch-actor-1')
  } finally { h.close() }
})

test('C2 陈旧世代的迟到终态 → 忽略并保留当前条目', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-0', stopReason: 'error' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.notEqual(h.tracker.peek('actor-session'), undefined)
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

test('C3/C4 身份不符（替换/终止/伪造条目）→ 作废，不影响当前状态', async () => {
  const h = harness()
  try {
    await h.start()
    await h.engine.drive('ws')
    const version = (await h.row()).stateVersion
    // 伪造条目：executionId 对不上当前执行。
    h.tracker.track({
      workspaceKey: 'ws', runId: 'run-nope', executionId: 'exec-nope', nodeToken: 'token-nope',
      dispatchId: 'd-nope', kind: 'actor', roleKey: 'worker', sessionId: 'ghost-session',
      messageId: 'message-ghost', epochRunId: undefined, outcome: 'unknown',
    } satisfies TrackedDispatch)
    await h.engine.handleActivationSettled('ws', 'ghost-session', { runId: 'epoch-x', stopReason: 'error' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.stateVersion, version)
    assert.equal(h.tracker.peek('ghost-session'), undefined)
  } finally { h.close() }
})

test('D 正常 completed 终态 → 不 BLOCK，只清条目', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'completed' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(h.tracker.peek('actor-session'), undefined)
  } finally { h.close() }
})

test('D2 claim 已接受后 actor 终态到达 → 不撤销，Judge 结算继续', async () => {
  const h = harness(configWithWorker())
  try {
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h))
    const worker = h.caller((await h.row()).execution.dispatch!)
    await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'work artifact' }, worker)
    await h.engine.handleTurnEnded('ws', worker)
    await h.engine.drive('ws')
    const judged = await h.row()
    const sessionId = judged.execution.judge!.sessionId
    assert.notEqual(sessionId, 'actor-session')
    await h.engine.handleActivationSettled('ws', 'actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.notEqual(row.execution.claim, undefined)
    assert.notEqual(row.execution.judge, undefined)
    assert.equal(h.tracker.peek('actor-session'), undefined)
  } finally { h.close() }
})

test('F1 Judge 无 turn/end 失败 → 直接 BLOCK，不做第二次自动重试', async () => {
  const h = harness()
  try {
    const { sessionId, epoch } = await driveToJudge(h)
    await h.engine.handleActivationSettled('ws', sessionId, { runId: epoch, stopReason: 'error', provider: 'test-provider' })
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /^activation settled without turn\/end: judge/)
    assert.equal(blocked.execution.judgeAutoRetried, undefined)
    assert.equal(h.judges.length, 1)
  } finally { h.close() }
})

test('F2 turn/end 瞬时失败重试后，旧 Judge 终态不干扰；第二次失败才 BLOCK', async () => {
  const h = harness()
  try {
    const first = await driveToJudge(h)
    const firstCaller = { sessionId: first.sessionId, turnUserMessageIds: new Set([`message-${first.sessionId}`]) }
    await h.engine.handleTurnEnded('ws', firstCaller, 'status=503 Service Unavailable')
    const retried = await h.row()
    assert.equal(retried.run.status, 'running')
    assert.equal(h.judges.length, 2)
    const secondSession = retried.execution.judge!.sessionId
    assert.notEqual(secondSession, first.sessionId)
    // 旧 Judge 终态（旧世代）：已替换 → 忽略，不 BLOCK、不重试。
    await h.engine.handleActivationSettled('ws', first.sessionId, { runId: first.epoch, stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'running')
    assert.equal(h.judges.length, 2)
    // 新 Judge 第二次 turn/end 瞬时失败：预算已用完 → BLOCK。
    const secondCaller = { sessionId: secondSession, turnUserMessageIds: new Set([`message-${secondSession}`]) }
    await h.engine.handleTurnEnded('ws', secondCaller, 'status=503 Service Unavailable')
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

test('tracker：世代记录、缓存对账与有界清理', async () => {
  const tracker = makeDispatchLifecycleTracker()
  assert.equal(tracker.epochOf('c1'), undefined)
  tracker.noteStart('c1', 'run-1')
  assert.equal(tracker.epochOf('c1'), 'run-1')
  // 无条目终态先缓存；track 时世代匹配则返回对账。
  tracker.bufferEnd('c1', { runId: 'run-1', stopReason: 'error' })
  const entry: TrackedDispatch = {
    workspaceKey: 'ws', runId: 'r', executionId: 'e', nodeToken: 't', dispatchId: 'd',
    kind: 'actor', roleKey: 'worker', sessionId: 'c1', messageId: 'm1',
    epochRunId: 'run-1', outcome: 'unknown',
  }
  assert.deepEqual(tracker.track(entry), { runId: 'run-1', stopReason: 'error', provider: undefined })
  // 消费缓存终态的那次 track 同样留存条目（引擎随即对账并清理）。
  assert.equal(tracker.peek('c1'), entry)
  tracker.noteResult('ghost', 'failed')
  tracker.forget('c1')
  assert.equal(tracker.peek('c1'), undefined)
  // 缓存有界：超出上限的最旧信号被淘汰。
  tracker.bufferEnd('c0', { runId: 'run-0', stopReason: 'error' })
  for (let i = 1; i <= 64; i++) tracker.bufferEnd(`cx-${i}`, { runId: `run-x-${i}`, stopReason: 'error' })
  const probe: TrackedDispatch = { ...entry, sessionId: 'c0', epochRunId: 'run-0' }
  assert.equal(tracker.track(probe), undefined)
  tracker.clear()
  assert.equal(tracker.epochOf('c1'), undefined)
})

test('describeActivationSettlement：基础原因在前、失败摘要脱敏有界', async () => {
  const entry: TrackedDispatch = {
    workspaceKey: 'ws', runId: 'r', executionId: 'e', nodeToken: 't', dispatchId: 'd-abcdef-123456',
    kind: 'judge', roleKey: 'judge', sessionId: 'session-abcdef-123456', messageId: 'message-abcdef-123456',
    epochRunId: 'run-1', outcome: 'failed', failureCode: 'EACT', failureSummary: 'boom api_key=sk-live-secret-value',
  }
  const reason = describeActivationSettlement(entry, { runId: 'run-1', stopReason: 'error' })
  assert.ok(reason.startsWith('activation settled without turn/end: judge role=judge'))
  assert.match(reason, /phase=checking/)
  assert.match(reason, /provider=unknown route=unknown/)
  assert.match(reason, /code=EACT/)
  assert.doesNotMatch(reason, /sk-live-secret-value/)
  assert.ok(reason.length <= 4000)
  assert.equal(shortRouteLabel(undefined), undefined)
  assert.equal(shortRouteLabel({}), undefined)
  assert.equal(shortRouteLabel({ provider: 'p', modelId: 'm', reasoningEffort: '  ' }), 'p/m')
})
