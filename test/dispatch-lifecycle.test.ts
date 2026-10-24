import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import {
  describeActivationSettlement,
  makeDispatchLifecycle,
  shortRouteLabel,
  type ActivationEndInfo,
  type DispatchCandidate,
  type DispatchLifecycle,
  type DispatchPublication,
} from '../src/plugin/dispatch-lifecycle.ts'

/**
 * Issue #247：Dispatch Lifecycle 观察模块（加深后）的定向回归。
 *
 * 真实 Runtime + 临时 SQLite + 受控 Host（与 runtime-work-order.test.ts 同一接缝）。
 * 受控 Host 在 ensureRoleActor/startJudge 内同步 noteStart，faithfully 模拟宿主
 * `subagent/start` 边（受理返回前到达）；`h.settle` 模拟 index.ts 的 `subagent/end`
 * 监听：先向观察模块报告终态，只有模块给出可消费引用时才转交引擎结算
 * （转交本身的 setImmediate 时序由真实宿主验收覆盖）。
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
/** 推进到 work 节点并派发 worker。 */
async function driveToWorker(h: ReturnType<typeof harness>) {
  await h.start()
  // Judge turn 收尾即推进后继并派发（同 runtime-work-order 用例 402/438 行模式）。
  await h.engine.handleTurnEnded('ws', await acceptCurrent(h))
  const row = await h.row()
  assert.equal(row.execution.dispatch!.sessionId, 'actor-session')
}

/** 受控 harness（接缝同 runtime-work-order.test.ts，另加真实观察模块）。 */
function harness(config: typeof CONFIG = CONFIG, options: {
  /** 在 ensureRoleActor 返回回执前执行，模拟宿主「result 先于身份发布到达」。 */
  onRoleStarted?: (childId: string, lifecycle: DispatchLifecycle) => void
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-dispatch-lifecycle-'))
  const store = new StateStore(home)
  const lifecycle = makeDispatchLifecycle()
  const judges: string[] = []
  const notifies: string[] = []
  const send = (sessionId: string, _text: string) => ({ messageId: `message-${sessionId}` })
  // 世代记录：模拟宿主 start 边（每次到达即推进），区分暖续接（同世代）与冷续接（新世代）。
  const epochs = new Map<string, string>()
  let actorEpoch = 0
  let judgeEpoch = 0
  const noteStart = (sessionId: string, epoch: string) => {
    epochs.set(sessionId, epoch)
    lifecycle.noteStart(sessionId, epoch)
  }
  // sendRoleActor 默认暖续接（同世代、无新 start）；置位后下一次模拟冷续接新世代。
  let coldNextSend = false
  const stateHost = makeStateHost(store)
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { notifies.push(text); return send('manager', text) },
    async sendRoleActor(run, role, text) {
      const sessionId = run.roleActors[role]!
      if (coldNextSend) {
        coldNextSend = false
        noteStart(sessionId, `epoch-actor-${++actorEpoch}`)
      }
      return send(sessionId, text)
    },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) {
      // 宿主 start 边在受理返回前到达：先记世代，再返回回执。
      noteStart('actor-session', `epoch-actor-${++actorEpoch}`)
      options.onRoleStarted?.('actor-session', lifecycle)
      return { ...send('actor-session', text), childId: 'actor-session' }
    },
    async startJudge(_run, input) {
      judges.push(input.judgeSessionId)
      noteStart(input.judgeSessionId, `epoch-${input.judgeSessionId}-${++judgeEpoch}`)
      return { ...send(input.judgeSessionId, 'Judge'), judgeSessionId: input.judgeSessionId }
    },
    async safeToInspect() { return 'safe' },
    async retireJudge() {},
    async drainJudge() {},
    async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async followupJudge(_run, judgeSessionId, _input) {
      // 暖 followup：同 Activation 同世代，无新 start 边；仅确保世代已记录以便对账。
      if (epochs.get(judgeSessionId) === undefined) noteStart(judgeSessionId, `epoch-${judgeSessionId}-${++judgeEpoch}`)
      return send(judgeSessionId, 'Judge followup')
    },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    dispatchLifecycle: lifecycle,
  }, { async run() { throw new Error('T7') } }, stateHost)
  engine.cwdResolver = async () => home
  return {
    home, store, engine, lifecycle, judges, notifies,
    /** 下一次 sendRoleActor 模拟冷续接新世代（暖续接默认同世代）。 */
    coldNextSend() { coldNextSend = true },
    caller: (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) }),
    async start() { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'root request') },
    async row() { return (await store.get('ws'))! },
    epochOf: (sessionId: string) => epochs.get(sessionId),
    /**
     * 模拟 index.ts 的 `subagent/end`：只把终态报告给观察模块；模块能归属时才把
     * 可消费引用交给引擎结算（返回 undefined = 无登记可归属、已暂存等发布）。
     */
    async settle(sessionId: string, end: ActivationEndInfo) {
      const ref = lifecycle.noteEnd(sessionId, end)
      if (ref === undefined) return undefined
      await engine.settleActivation(ref)
      return ref
    },
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
  return { sessionId, epoch: h.epochOf(sessionId)! }
}

test('A1 actor 受理后无 turn/end 失败 → 技术 BLOCK 且保留已有材料', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    const before = await h.row()
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error', provider: 'test-provider' })
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /^activation settled without turn\/end: actor role=worker/)
    assert.match(blocked.execution.blockReason!, /stop=error provider=test-provider/)
    assert.equal(blocked.execution.input, 'artifact')
    assert.equal(blocked.execution.claim, undefined)
    assert.equal(blocked.execution.dispatch!.settled, false)
    assert.equal((await h.blockedEvents(blocked.execution.executionId)).length, 1)
    // 去重：重复/逆序到达的终态不再 BLOCK（原登记已释放，终态只进暂存）。
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
    assert.equal((await h.blockedEvents(before.execution.executionId)).length, 1)
  } finally { h.close() }
})

test('A2 activation.result reject 记录失败码 → 终态 BLOCK 携带 code（已脱敏）', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    h.lifecycle.observeResult('actor-session',
      Promise.reject(Object.assign(new Error('boom api_key=sk-xyz-secret'), { code: 'EACT' })))
    await flushMicrotasks()
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
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
    h.lifecycle.observeResult('actor-session', Promise.resolve({ stopReason: 'error' }))
    await flushMicrotasks()
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

/**
 * MF-1：把同一组「result 事实」分别放到身份发布前/后交付，返回可观察 Run 状态。
 * 发布前交付用 ensureRoleActor 的宿主时序钩子（observeResult 发生在引擎 publish 之前）。
 */
async function deliverFact(make: () => Promise<{ stopReason?: string }>, before: boolean) {
  const result = make()
  // 与观察模块并行消费拒绝，避免测试进程留下未处理拒绝告警（模块仍能收到该事实）。
  void result.catch(() => {})
  const h = harness(configWithWorker(), before
    ? { onRoleStarted: (childId, lifecycle) => lifecycle.observeResult(childId, result) }
    : {})
  try {
    await driveToWorker(h)
    if (!before) h.lifecycle.observeResult('actor-session', result)
    await flushMicrotasks()
    const ref = h.lifecycle.noteEnd('actor-session', { runId: h.epochOf('actor-session')!, stopReason: 'error' })
    assert.ok(ref)
    await h.engine.settleActivation(ref)
    const row = await h.row()
    return {
      status: row.run.status,
      phase: row.execution.phase,
      blockReason: row.execution.blockReason ?? null,
      blocked: (await h.blockedEvents(row.execution.executionId)).length,
      claimed: row.execution.claim !== undefined,
    }
  } finally { h.close() }
}

test('MF-1 result 先于/晚于身份发布到达 → 同一组可观察 Run 状态（引擎层等价门闩）', async () => {
  const secret = 'sk-mf1-secret'
  const cases: Array<{
    label: string
    make: () => Promise<{ stopReason?: string }>
    expected: 'running' | 'blocked'
    code?: string
    leak?: string
  }> = [
    { label: 'completed+cleanup-error', make: () => Promise.resolve({ stopReason: 'completed' }), expected: 'running' },
    { label: 'resolve(error)', make: () => Promise.resolve({ stopReason: 'error' }), expected: 'blocked' },
    {
      label: 'reject(EACT)',
      make: () => Promise.reject(Object.assign(new Error(`auth failed ${secret}`), { code: 'EACT' })),
      expected: 'blocked',
      code: 'EACT',
      leak: secret,
    },
  ]
  for (const item of cases) {
    const before = await deliverFact(item.make, true)
    const after = await deliverFact(item.make, false)
    assert.deepEqual(before, after, `${item.label}: 发布前/后必须得到同一可观察状态`)
    if (item.expected === 'running') {
      assert.equal(before.status, 'running', item.label)
      assert.equal(before.blockReason, null, item.label)
      assert.equal(before.blocked, 0, item.label)
    } else {
      assert.equal(before.status, 'blocked', item.label)
      assert.match(before.blockReason ?? '', /^activation settled without turn\/end: actor role=worker/)
      if (item.code !== undefined) assert.match(before.blockReason ?? '', new RegExp(`code=${item.code}`))
      if (item.leak !== undefined) assert.doesNotMatch(before.blockReason ?? '', new RegExp(item.leak))
    }
  }
})

test('MF-2 终态先到、result 微任务随后可见 → 结算不误 BLOCK（completed+cleanup-error）', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    const gate = Promise.withResolvers<{ stopReason?: string }>()
    h.lifecycle.observeResult('actor-session', gate.promise)
    const ref = h.lifecycle.noteEnd('actor-session', { runId: h.epochOf('actor-session')!, stopReason: 'error' })
    assert.ok(ref)
    gate.resolve({ stopReason: 'completed' })
    // 不 flush：consume 必须在同一次结算里先观察已排队的 result 微任务。
    await h.engine.settleActivation(ref)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.ok(row.execution.blockReason == null)
    assert.equal((await h.blockedEvents(row.execution.executionId)).length, 0)
  } finally { h.close() }
})

test('E 执行 completed 仅清理失败 → 不 BLOCK、不撤销，只清登记', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    h.lifecycle.observeResult('actor-session', Promise.resolve({ stopReason: 'completed' }))
    await flushMicrotasks()
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.ok(row.execution.blockReason == null)
    assert.equal((await h.blockedEvents(row.execution.executionId)).length, 0)
    // 登记已释放：同一世代终态不再可归属。
    assert.equal(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
  } finally { h.close() }
})

test('B1 身份发布前到达的终态缓存 → 发布时对账 BLOCK', async () => {
  const h = harness(configWithWorker())
  try {
    await h.start()
    const planJudge = await acceptCurrent(h)
    // 终态先到（work 尚未派发、尚无登记）：暂存。
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
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
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-0', stopReason: 'error' }), undefined)
    await h.engine.handleTurnEnded('ws', planJudge)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.ok(row.execution.blockReason == null)
    // 新世代的终态仍可归属（陈旧缓存没有污染登记）。
    assert.notEqual(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
  } finally { h.close() }
})

test('C2 陈旧世代的迟到终态 → 忽略并保留当前登记', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-0', stopReason: 'error' }), undefined)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.notEqual(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
  } finally { h.close() }
})

test('C3/C4 无登记录入的会话终态（替换/终止/伪身份）→ 只暂存，不影响当前状态', async () => {
  const h = harness()
  try {
    await h.start()
    await h.engine.drive('ws')
    const version = (await h.row()).stateVersion
    assert.equal(await h.settle('ghost-session', { runId: 'epoch-x', stopReason: 'error' }), undefined)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.stateVersion, version)
  } finally { h.close() }
})

test('D 正常 completed 终态 → 不 BLOCK，只清登记', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'completed' })
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-1', stopReason: 'completed' }), undefined)
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
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.notEqual(row.execution.claim, undefined)
    assert.notEqual(row.execution.judge, undefined)
  } finally { h.close() }
})

test('F1 Judge 无 turn/end 失败 → 直接 BLOCK，不做第二次自动重试', async () => {
  const h = harness()
  try {
    const { sessionId, epoch } = await driveToJudge(h)
    await h.settle(sessionId, { runId: epoch, stopReason: 'error', provider: 'test-provider' })
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
    assert.equal(await h.settle(first.sessionId, { runId: first.epoch, stopReason: 'error' }), undefined)
    assert.equal((await h.row()).run.status, 'running')
    assert.equal(h.judges.length, 2)
    // 新 Judge 第二次 turn/end 瞬时失败：预算已用完 → BLOCK。
    const secondCaller = { sessionId: secondSession, turnUserMessageIds: new Set([`message-${secondSession}`]) }
    await h.engine.handleTurnEnded('ws', secondCaller, 'status=503 Service Unavailable')
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

test('观察模块：世代、发布窗口对账、消费/释放与有界清理', async () => {
  const lifecycle = makeDispatchLifecycle()
  const publication = (sessionId: string, over: Partial<DispatchPublication> = {}): DispatchPublication => ({
    workspaceKey: 'ws', runId: 'run', executionId: 'e', nodeToken: 't', dispatchId: `d-${sessionId}`,
    kind: 'actor', roleKey: 'worker', sessionId, messageId: `m-${sessionId}`, ...over,
  })
  // 无登记时终态暂存；发布时世代匹配 → 立即返回可消费引用。
  lifecycle.noteStart('c1', 'run-1')
  assert.equal(lifecycle.noteEnd('c1', { runId: 'run-1', stopReason: 'error' }), undefined)
  const ref = lifecycle.publish(publication('c1'))
  assert.notEqual(ref, undefined)
  const candidate = await lifecycle.consume(ref!)
  assert.equal(candidate?.sessionId, 'c1')
  assert.equal(candidate?.epochRunId, 'run-1')
  assert.deepEqual(candidate?.end, { runId: 'run-1', stopReason: 'error' })
  assert.equal(candidate?.outcome, 'unknown')
  // 同一引用可重复消费，直到 release。
  assert.deepEqual(await lifecycle.consume(ref!), candidate)
  lifecycle.release(ref!)
  assert.equal(await lifecycle.consume(ref!), undefined)
  // 陈旧世代的暂存终态在发布时丢弃。
  lifecycle.noteStart('c2', 'run-2')
  lifecycle.noteEnd('c2', { runId: 'run-1', stopReason: 'error' })
  assert.equal(lifecycle.publish(publication('c2')), undefined, '陈旧世代的暂存终态不认领')
  // 无暂存时发布不产生引用。
  assert.equal(lifecycle.publish(publication('c3')), undefined)
  // 无 start（世代未知）时，暂存终态与 result 都不能被认领。
  lifecycle.noteEnd('c4', { runId: 'run-4', stopReason: 'error' })
  assert.equal(lifecycle.publish(publication('c4')), undefined, '世代未知的暂存终态不认领')
  lifecycle.observeResult('c4', Promise.resolve({ stopReason: 'completed' }))
  await flushMicrotasks()
  const c4ref = lifecycle.noteEnd('c4', { runId: 'run-4', stopReason: 'error' })
  assert.notEqual(c4ref, undefined)
  assert.equal((await lifecycle.consume(c4ref!))?.outcome, 'unknown', '世代未知的 result 不认领')
  // 无 start 且在发布前挂载的 result 同样不能认领。
  lifecycle.noteEnd('c5', { runId: 'run-5', stopReason: 'error' })
  lifecycle.observeResult('c5', Promise.resolve({ stopReason: 'error' }))
  await flushMicrotasks()
  assert.equal(lifecycle.publish(publication('c5')), undefined)
  const c5ref = lifecycle.noteEnd('c5', { runId: 'run-5', stopReason: 'error' })
  assert.notEqual(c5ref, undefined)
  assert.equal((await lifecycle.consume(c5ref!))?.outcome, 'unknown')
  // invalidate：dispatchId 不符时保留登记，符合时精确作废。
  lifecycle.publish(publication('c3', { dispatchId: 'd-keep' }))
  lifecycle.invalidate('c3', 'd-other')
  assert.notEqual(lifecycle.noteEnd('c3', { runId: 'run-1', stopReason: 'error' }), undefined)
  lifecycle.invalidate('c3', 'd-keep')
  assert.equal(await lifecycle.consume({ sessionId: 'c3', registration: 6 }), undefined, '被作废的登记不再产出候选')
  assert.equal(lifecycle.noteEnd('c3', { runId: 'run-1', stopReason: 'error' }), undefined, '登记已删除，迟到终态只能暂存')
  // 暂存有界：超出上限的最旧信号被淘汰（发布时匹配不到）。
  lifecycle.noteStart('c0', 'run-0')
  lifecycle.noteEnd('c0', { runId: 'run-0', stopReason: 'error' })
  for (let i = 1; i <= 64; i++) lifecycle.noteEnd(`cx-${i}`, { runId: `run-x-${i}`, stopReason: 'error' })
  assert.equal(lifecycle.publish(publication('c0')), undefined)
})

test('观察模块：result 归因（失败码/摘要、completed、跨世代丢弃）', async () => {
  const lifecycle = makeDispatchLifecycle()
  const publication = (sessionId: string): DispatchPublication => ({
    workspaceKey: 'ws', runId: 'run', executionId: 'e', nodeToken: 't', dispatchId: `d-${sessionId}`,
    kind: 'actor', roleKey: 'worker', sessionId, messageId: `m-${sessionId}`,
  })
  lifecycle.noteStart('r1', 'run-1')
  lifecycle.observeResult('r1', Promise.reject(Object.assign(new Error('boom'), { code: 'EACT' })))
  await flushMicrotasks()
  assert.equal(lifecycle.publish(publication('r1')), undefined)
  const ref = lifecycle.noteEnd('r1', { runId: 'run-1', stopReason: 'error' })!
  const failed = await lifecycle.consume(ref)
  assert.equal(failed?.outcome, 'failed')
  assert.equal(failed?.failureCode, 'EACT')
  assert.equal(failed?.failureSummary, 'boom')
  // completed 归一化：同世代挂载的 result 归因到该登记。
  lifecycle.noteStart('r2', 'run-1')
  lifecycle.observeResult('r2', Promise.resolve({ stopReason: 'completed' }))
  await flushMicrotasks()
  lifecycle.publish(publication('r2'))
  const completedRef = lifecycle.noteEnd('r2', { runId: 'run-1', stopReason: 'error' })!
  assert.equal((await lifecycle.consume(completedRef))?.outcome, 'completed')
  // 跨世代：result 在 run-1 挂载，登记已推进到 run-2 → outcome 保持 unknown。
  lifecycle.noteStart('r3', 'run-1')
  lifecycle.observeResult('r3', Promise.resolve({ stopReason: 'completed' }))
  await flushMicrotasks()
  lifecycle.noteStart('r3', 'run-2')
  lifecycle.publish(publication('r3'))
  const r3ref = lifecycle.noteEnd('r3', { runId: 'run-2', stopReason: 'error' })!
  assert.equal((await lifecycle.consume(r3ref))?.outcome, 'unknown')
})

test('观察模块：dispose 后迟到回调不能重新登记或输出候选', async () => {
  const lifecycle = makeDispatchLifecycle()
  const publication = (sessionId: string): DispatchPublication => ({
    workspaceKey: 'ws', runId: 'run', executionId: 'e', nodeToken: 't', dispatchId: `d-${sessionId}`,
    kind: 'actor', roleKey: 'worker', sessionId, messageId: `m-${sessionId}`,
  })
  lifecycle.noteStart('z1', 'run-1')
  lifecycle.publish(publication('z1'))
  const ref = lifecycle.noteEnd('z1', { runId: 'run-1', stopReason: 'error' })
  assert.notEqual(ref, undefined)
  // dispose 前挂载、dispose 后才 resolve 的 result：不得重新登记观察资源。
  const late = Promise.withResolvers<{ stopReason?: string }>()
  lifecycle.observeResult('z3', late.promise)
  lifecycle.dispose()
  // 已发布登记不再可结算；迟到终态也不能产出引用。
  assert.equal(await lifecycle.consume(ref!), undefined)
  assert.equal(lifecycle.noteEnd('z1', { runId: 'run-1', stopReason: 'error' }), undefined)
  // 卸载后的 start/result/publish/end 全部无效果。
  lifecycle.noteStart('z2', 'run-2')
  lifecycle.observeResult('z2', Promise.resolve({ stopReason: 'completed' }))
  await flushMicrotasks()
  assert.equal(lifecycle.publish(publication('z2')), undefined)
  assert.equal(lifecycle.noteEnd('z2', { runId: 'run-2', stopReason: 'error' }), undefined)
  // 观察私有 Map 的写入：dispose 后 resolve 不得新增 outcomes 条目。
  const originalSet = Map.prototype.set
  let writes = 0
  Map.prototype.set = function <K, V>(this: Map<K, V>, key: K, value: V): Map<K, V> {
    if (key === 'z3') writes += 1
    return originalSet.call(this, key, value)
  }
  try {
    late.resolve({ stopReason: 'completed' })
    await flushMicrotasks()
  } finally {
    Map.prototype.set = originalSet
  }
  assert.equal(writes, 0, 'dispose 后 resolve 不得重新登记 outcome')
})

test('观察模块：发布窗口暂存的终态 60 秒后过期（边界仍有效）', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] })
  const lifecycle = makeDispatchLifecycle()
  const publication = (sessionId: string): DispatchPublication => ({
    workspaceKey: 'ws', runId: 'run', executionId: 'e', nodeToken: 't', dispatchId: `d-${sessionId}`,
    kind: 'actor', roleKey: 'worker', sessionId, messageId: `m-${sessionId}`,
  })
  lifecycle.noteStart('b1', 'run-1')
  lifecycle.noteEnd('b1', { runId: 'run-1', stopReason: 'error' })
  t.mock.timers.tick(60_000)
  assert.notEqual(lifecycle.publish(publication('b1')), undefined, '正好 60 秒仍在对账窗口内')
  lifecycle.noteStart('b2', 'run-2')
  lifecycle.noteEnd('b2', { runId: 'run-2', stopReason: 'error' })
  t.mock.timers.tick(60_001)
  assert.equal(lifecycle.publish(publication('b2')), undefined, '超过 TTL 的暂存不再参与发布对账')
  t.mock.timers.reset()
})

test('R1-1a Role 暖续接经 sendRoleActor 真实二派受理后无 turn/end 失败 → 技术 BLOCK（outcome=unknown）', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    const first = await h.row()
    const firstDispatchId = first.execution.dispatch!.id
    // 首派失败 → BLOCK（outcome=unknown + end error 的第一例）。
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error', provider: 'test-provider' })
    const blockedOnce = await h.row()
    assert.equal(blockedOnce.run.status, 'blocked')
    assert.equal((await h.blockedEvents(blockedOnce.execution.executionId)).length, 1)
    // Manager 恢复交还 Actor：同一 Session 暖续接（不推进世代），真实二派经 sendRoleActor。
    const resumed = await h.engine.handleResume('ws', blockedOnce.execution.nodeToken, '现场已核查，继续同一会话。', 'manager', 'actor')
    assert.equal(resumed.ok, true)
    const redispatched = await h.row()
    assert.equal(redispatched.run.status, 'running')
    assert.notEqual(redispatched.execution.nodeToken, blockedOnce.execution.nodeToken)
    assert.notEqual(redispatched.execution.dispatch!.id, firstDispatchId)
    assert.equal(redispatched.execution.dispatch!.sessionId, 'actor-session')
    // 续接派发无 result 句柄：outcome 保持 unknown、世代仍是暖续接世代，等待 end 结算。
    const ref = h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-1', stopReason: 'error', provider: 'test-provider' })
    assert.notEqual(ref, undefined)
    const candidate = await h.lifecycle.consume(ref!)
    assert.equal(candidate?.outcome, 'unknown')
    assert.equal(candidate?.epochRunId, 'epoch-actor-1')
    // 续接派发受理后无 turn/end 失败 → 再次技术 BLOCK，材料保留、单次有效结算。
    await h.engine.settleActivation(ref!)
    const blockedTwice = await h.row()
    assert.equal(blockedTwice.run.status, 'blocked')
    assert.match(blockedTwice.execution.blockReason!, /^activation settled without turn\/end: actor role=worker/)
    assert.match(blockedTwice.execution.blockReason!, /stop=error provider=test-provider/)
    assert.equal(blockedTwice.execution.claim, undefined)
    assert.equal(blockedTwice.execution.dispatch!.settled, false)
    assert.equal((await h.blockedEvents(blockedTwice.execution.executionId)).length, 2)
    // 重复终态不再结算（登记已释放，只进暂存）。
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
    assert.equal((await h.blockedEvents(first.execution.executionId)).length, 2)
  } finally { h.close() }
})

test('R1-1b Role 冷续接经 sendRoleActor 真实二派新世代受理后无 turn/end 失败 → 技术 BLOCK', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    const blockedOnce = await h.row()
    assert.equal(blockedOnce.run.status, 'blocked')
    // 下一次 sendRoleActor 模拟冷续接：新 Activation 新 runId。
    h.coldNextSend()
    const resumed = await h.engine.handleResume('ws', blockedOnce.execution.nodeToken, '旧会话已冷恢复，续接新世代。', 'manager', 'actor')
    assert.equal(resumed.ok, true)
    const redispatched = await h.row()
    assert.equal(redispatched.run.status, 'running')
    // 新世代登记：旧世代终态不再可归属，新世代终态可归属。
    assert.equal(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
    // 新世代受理后无 turn/end 失败 → BLOCK；旧世代迟到信号不得误命中（见 R1-4a）。
    await h.settle('actor-session', { runId: 'epoch-actor-2', stopReason: 'error', provider: 'test-provider' })
    const blockedTwice = await h.row()
    assert.equal(blockedTwice.run.status, 'blocked')
    assert.match(blockedTwice.execution.blockReason!, /^activation settled without turn\/end: actor role=worker/)
    assert.equal(blockedTwice.execution.claim, undefined)
    assert.equal(blockedTwice.execution.input, 'artifact')
  } finally { h.close() }
})

test('R1-2 Judge followup 真实二派受理后无 turn/end 失败 → 直接 BLOCK，不做第二次自动重试', async () => {
  const h = harness()
  try {
    const first = await driveToJudge(h)
    const before = await h.row()
    const claimId = before.execution.claim!.id
    const inputVersion = before.execution.inputVersion
    const oldToken = before.execution.nodeToken
    const oldCaller = { sessionId: first.sessionId, turnUserMessageIds: new Set([`message-${first.sessionId}`]) }
    assert.equal((await h.engine.handleJudgeClaim('ws', oldToken, 'NEED_CONTEXT', 'need facts', oldCaller)).ok, true)
    assert.equal((await h.row()).run.status, 'blocked')
    // Manager 补证后恢复 Judge：同 Judge 会话 followup（同一分支符合同 claim/inputVersion 续接）。
    const resumed = await h.engine.handleResume('ws', (await h.row()).execution.nodeToken, '补充事实已核实，续接原 Judge。', 'manager', 'judge')
    assert.equal(resumed.ok, true)
    const following = await h.row()
    assert.equal(following.run.status, 'running')
    assert.equal(following.execution.judge!.sessionId, first.sessionId)
    assert.equal(h.judges.length, 1)
    // followup 派发经真实 followupJudge 登记：claim/inputVersion 守卫随行，无 result 句柄。
    const ref = h.lifecycle.noteEnd(first.sessionId, { runId: first.epoch, stopReason: 'error', provider: 'test-provider' })
    assert.notEqual(ref, undefined)
    const tracked = await h.lifecycle.consume(ref!)
    assert.equal(tracked?.claimId, claimId)
    assert.equal(tracked?.inputVersion, inputVersion + 1)
    assert.equal(tracked?.outcome, 'unknown')
    // 旧 token 已失效：守卫拒绝迟到提交。
    assert.equal((await h.engine.handleJudgeClaim('ws', oldToken, 'ACCEPT', 'late old token', oldCaller)).ok, false)
    // followup 受理后无 turn/end 失败 → 直接 BLOCK，不消耗第二次自动重试。
    await h.engine.settleActivation(ref!)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.match(blocked.execution.blockReason!, /^activation settled without turn\/end: judge/)
    assert.equal(blocked.execution.judgeAutoRetried, undefined)
    assert.equal(h.judges.length, 1)
    // 重复终态不再结算。
    const eventsBefore = (await h.blockedEvents(blocked.execution.executionId)).length
    assert.equal(await h.settle(first.sessionId, { runId: first.epoch, stopReason: 'error' }), undefined)
    assert.equal((await h.blockedEvents(blocked.execution.executionId)).length, eventsBefore)
  } finally { h.close() }
})

test('R1-3 已有 Session 续接窗口：end 先于发布缓冲 → 发布时对账 BLOCK 且不误命中 claim', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'blocked')
    // 续接世代的终态先到（尚无登记）：暂存等待发布对账。
    h.lifecycle.noteStart('actor-session', 'epoch-actor-2')
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-2', stopReason: 'error', provider: 'test-provider' }), undefined)
    assert.equal((await h.row()).run.status, 'blocked')
    // Manager 恢复触发续接二派（暖发送保持 epoch-actor-2）：发布时对账命中缓存 → BLOCK。
    const resumed = await h.engine.handleResume('ws', (await h.row()).execution.nodeToken, '现场已核查，续接已有会话。', 'manager', 'actor')
    assert.equal(resumed.ok, true)
    const reconciled = await h.row()
    assert.equal(reconciled.run.status, 'blocked')
    assert.match(reconciled.execution.blockReason!, /^activation settled without turn\/end: actor role=worker/)
    assert.match(reconciled.execution.blockReason!, /stop=error provider=test-provider/)
    // 未误命中 claim：续接窗口内无 claim 被创建或撤销，输入材料完整保留。
    assert.equal(reconciled.execution.claim, undefined)
    assert.equal(reconciled.execution.input, 'artifact')
  } finally { h.close() }
})

test('R1-4a resume 新 nodeToken 后旧派发终态到达 → 忽略，新派发仍可结算', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    const blockedOnce = await h.row()
    assert.equal(blockedOnce.run.status, 'blocked')
    const eventsAfterFirst = (await h.blockedEvents(blockedOnce.execution.executionId)).length
    assert.equal(eventsAfterFirst, 1)
    // 冷续接产生新世代/新 nodeToken/新派发。
    h.coldNextSend()
    assert.equal((await h.engine.handleResume('ws', blockedOnce.execution.nodeToken, '旧世代已确认关闭，冷续接。', 'manager', 'actor')).ok, true)
    const redispatched = await h.row()
    assert.equal(redispatched.run.status, 'running')
    assert.notEqual(redispatched.execution.nodeToken, blockedOnce.execution.nodeToken)
    // 旧世代迟到终态 → 忽略：仍 running、新登记保留、无重复结算、无回滚。
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
    const stillRunning = await h.row()
    assert.equal(stillRunning.run.status, 'running')
    assert.notEqual(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-2', stopReason: 'error' }), undefined)
    assert.equal((await h.blockedEvents(stillRunning.execution.executionId)).length, eventsAfterFirst)
    // 新世代终态仍可结算：证明旧信号没有消费新登记。
    await h.settle('actor-session', { runId: 'epoch-actor-2', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'blocked')
  } finally { h.close() }
})

test('R1-4b reset/新 Run 后旧通知到达 → 忽略，新 Run 不受影响', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    const oldRun = (await h.row()).run.runId
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' })
    assert.equal((await h.row()).run.status, 'blocked')
    assert.equal((await h.engine.handleReset('ws', true)).ok, true)
    assert.equal((await h.row()).run.status, 'terminated')
    // 新 Run：同 workspace 重新开始，派发新世代（计数器推进 → epoch-actor-2）。
    await h.start()
    await h.engine.handleTurnEnded('ws', await acceptCurrent(h))
    const fresh = await h.row()
    assert.notEqual(fresh.run.runId, oldRun)
    assert.equal(fresh.run.status, 'running')
    assert.equal(fresh.execution.dispatch!.sessionId, 'actor-session')
    // 旧 Run 的迟到终态（旧世代）→ 忽略：新 Run 仍 running、新登记保留。
    assert.equal(await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error' }), undefined)
    const unaffected = await h.row()
    assert.equal(unaffected.run.status, 'running')
    assert.equal(unaffected.run.runId, fresh.run.runId)
    assert.notEqual(h.lifecycle.noteEnd('actor-session', { runId: 'epoch-actor-2', stopReason: 'error' }), undefined)
    // 新 Run 仍可正常 claim：旧信号没有污染新派发。
    const worker = h.caller(unaffected.execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'fresh artifact' }, worker)).ok, true)
  } finally { h.close() }
})

test('R1-5a 诊断未知字段记 unknown，不伪造 provider 与失败阶段', async () => {
  const candidate: DispatchCandidate = {
    workspaceKey: 'ws', runId: 'r', executionId: 'e', nodeToken: 't', dispatchId: 'd',
    kind: 'actor', roleKey: 'worker', sessionId: 's', messageId: 'm',
    epochRunId: undefined, end: { runId: 'other', stopReason: 'mystery-stage' }, outcome: 'unknown',
  }
  const reason = describeActivationSettlement(candidate)
  assert.ok(reason.startsWith('activation settled without turn/end: actor role=worker'))
  assert.match(reason, /phase=working/)
  assert.match(reason, /stop=mystery-stage/)
  assert.match(reason, /provider=unknown route=unknown/)
  assert.doesNotMatch(reason, /code=/)
  assert.doesNotMatch(reason, /failure=/)
})

test('R1-5b 超长失败摘要截断：基础原因在前、有界脱敏', async () => {
  const baseEntry: DispatchCandidate = {
    workspaceKey: 'ws', runId: 'r', executionId: 'e', nodeToken: 't', dispatchId: 'd',
    kind: 'actor', roleKey: 'worker', sessionId: 's', messageId: 'm',
    epochRunId: 'run-1', end: { runId: 'run-1', stopReason: 'error' }, outcome: 'failed',
    failureSummary: `ok-prefix ${'x'.repeat(8000)} api_key=sk-live-should-be-redacted`,
  }
  const reason = describeActivationSettlement(baseEntry)
  assert.ok(reason.startsWith('activation settled without turn/end: actor role=worker'))
  assert.ok(reason.length <= 4000)
  assert.doesNotMatch(reason, /sk-live-should-be-redacted/)
  // 截断仍保留基础原因的可识别前缀（角色/阶段/停止原因）。
  assert.match(reason, /phase=working stop=error/)
})

test('R1-5c Manager 可见通道携带同一有界脱敏原因：通知 + status + blocked 事件', async () => {
  const h = harness(configWithWorker())
  try {
    await driveToWorker(h)
    const longSecret = `boom api_key=sk-live-channel-check ${'y'.repeat(6000)}`
    h.lifecycle.observeResult('actor-session', Promise.reject(Object.assign(new Error(longSecret), { code: 'EACT' })))
    await flushMicrotasks()
    await h.settle('actor-session', { runId: 'epoch-actor-1', stopReason: 'error', provider: 'test-provider' })
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    const reason = blocked.execution.blockReason!
    assert.ok(reason.startsWith('activation settled without turn/end: actor role=worker'))
    assert.ok(reason.length <= 4000)
    assert.doesNotMatch(reason, /sk-live-channel-check/)
    assert.match(reason, /code=EACT/)
    // Manager 通知正文携带同一原因（含 Workflow BLOCK 前缀与结构化事件首部）。
    const lastNotify = h.notifies.at(-1)!
    assert.match(lastNotify, /Workflow BLOCK: activation settled without turn\/end: actor role=worker/)
    assert.doesNotMatch(lastNotify, /sk-live-channel-check/)
    // workflow_status 对 Manager 可见同一有界脱敏原因。
    const status = await h.engine.status('ws', 'manager')
    assert.equal(status.ok, true)
    assert.equal(status.status.blockReason, reason)
    // blocked 事件快照同样有界脱敏且基础原因完整。
    const blockedSnapshots = await h.blockedEvents(blocked.execution.executionId)
    assert.ok(blockedSnapshots.length >= 1)
    assert.equal(blockedSnapshots.at(-1)!.snapshot.blockReason, reason)
  } finally { h.close() }
})

test('describeActivationSettlement：基础原因在前、失败摘要脱敏有界', async () => {
  const candidate: DispatchCandidate = {
    workspaceKey: 'ws', runId: 'r', executionId: 'e', nodeToken: 't', dispatchId: 'd-abcdef-123456',
    kind: 'judge', roleKey: 'judge', sessionId: 'session-abcdef-123456', messageId: 'message-abcdef-123456',
    epochRunId: 'run-1', end: { runId: 'run-1', stopReason: 'error' }, outcome: 'failed',
    failureCode: 'EACT', failureSummary: 'boom api_key=sk-live-secret-value',
  }
  const reason = describeActivationSettlement(candidate)
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
