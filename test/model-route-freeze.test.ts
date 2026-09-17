/**
 * Issue #91: 默认模型路由按 Run 冻结，消除跨 workspace 串用。
 *
 * 已确认 seam：真实 Engine + 临时 SQLite（不触真实 DSH home）+ 受控 Host
 * （捕获真实提交给 `ctx.subagents.startContinuable` 的 agentOptions）。
 * 冻结来源用 DSH 固定版本正式 helper `parentAgentOptionsForDelegation`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { makeStateHost, makeSubagentHost, managerRouteOf, type HostAdapters } from '../src/plugin/host.ts'
import { testParticipants } from './helpers/participants.ts'
import { judgeSpawnPlan, JUDGE_REQUIRED_TOOLS, resolveRoleModel } from '../src/roles/roles.ts'
import { routeToAgentOptions, type RunState, type SpawnAgentOptions, type WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'

const CONFIG: WorkflowConfig = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Worker persona.
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: The plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: The work is complete., target: { return: done } }
`), { workflowId: 'model-route-freeze' })

/** 受控 Manager Agent：正式 helper 无 requestHeader 时回退到 creation options。 */
function managerAgent(sessionId: string, provider: string, model: string): Agent {
  return {
    id: sessionId,
    options: { provider, model },
    session: { id: sessionId, header: {}, requestHeader: () => undefined, snapshotEvents: () => [] },
  } as unknown as Agent
}

interface Spawn {
  label: string
  agentOptions: SpawnAgentOptions | undefined
}

/**
 * #118 D-91-3：替身不再复刻路由优先级——直接消费生产决策函数
 * （`resolveRoleModel` / `judgeSpawnPlan`，即 `makeSubagentHost` 使用的同源），
 * 只负责把每次 spawn 的 agentOptions 记录下来。
 */
function recordingHost(spawns: Spawn[]): SubagentHost & { observeTurnEnd(sessionId: string): void } {
  let serial = 0
  const base = {
    async ensureRoleActor(run: RunState, roleKey: string, _initialText: string) {
      spawns.push({ label: `role:${roleKey}`, agentOptions: routeToAgentOptions(resolveRoleModel(run, roleKey, run.delegationRoute)) })
      return { childId: `child-${++serial}`, messageId: `message-${serial}` }
    },
    async startJudge(run: RunState, input: { judgeSessionId: string }) {
      spawns.push({ label: 'judge', agentOptions: routeToAgentOptions(judgeSpawnPlan(run, run.delegationRoute).agentOptions) })
      return { judgeSessionId: input.judgeSessionId, messageId: `message-${++serial}` }
    },
  }
  return {
    ...base,
    observeTurnEnd() {},
    async followupJudge() { return { messageId: `message-${++serial}` } },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {},
    async drainRoleActor() {}, async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' as const },
  }
}

/** 真实插件形态：一个 Engine 实例 + 一个 Store；workspace 由 state row 区分。 */
function engineFor(store: StateStore, managers: Map<string, Agent>, spawns: Spawn[]): WorkflowEngine {
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: 'manager-message' } },
    async sendRoleActor() { return { messageId: 'role-message' } },
    managerSessionSeq() { return 0 },
  }, recordingHost(spawns), { async run() { throw new Error('no programs') } }, makeStateHost(store))
  engine.cwdResolver = async () => 'cwd'
  // 与生产装配同源（host.ts managerRouteOf），替身不复刻取源语义。
  engine.managerRoute = async managerSessionId => managerRouteOf(managers.get(managerSessionId))
  return engine
}

function startRun(engine: WorkflowEngine, ws: string, managerSessionId: string): Promise<{ ok: boolean; reason?: string }> {
  return engine.startRun(ws, engine.buildInitialRun(managerSessionId, 'model-route-freeze', CONFIG, 'hash'), undefined, 'root request')
}

/**
 * 走完一个节点：Manager claim + turn-end（spawn Judge）→ Judge ACCEPT → 下一节点。
 * 每次 visit 都会新建 Role/Judge，正是 #91 关心的"尚未创建的"对象。
 */
async function advance(engine: WorkflowEngine, store: StateStore, ws: string): Promise<void> {
  const row = (await store.get(ws))!
  const caller = { sessionId: row.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: `${ws} artifact` }, caller)).ok, true)
  await engine.handleTurnEnded(ws, caller)
  const checking = (await store.get(ws))!
  assert.equal(checking.execution.phase, 'checking', `${ws} should be waiting for its Judge`)
  const judge = { sessionId: checking.execution.judge!.sessionId!, turnUserMessageIds: new Set([checking.execution.judge!.messageId!]) }
  // Judge turn 的安全结算由其 turn/end 观察者登记（受控 Host 无该观察者，这里等价补上）：
  // 未结算的 Judge 后继不会被安排，这条前置也必须真实存在。
  checking.execution.judge!.settled = true
  await store.updateRow(ws, checking.run, checking.stateVersion, [{ execution: checking.execution, expectedRevision: checking.execution.revision, events: [] }])
  assert.equal((await engine.handleJudgeClaim(ws, checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  await engine.drive(ws)
}

// #91 核心：A start → B start → A claim/turn-end。共享 Engine 的实例级默认路由
// 会被 B 覆盖，A 的新 Role/新 Judge 于是拿到 B 的 provider/model。
test('两个 workspace 交错 start：每个 Run 的默认路由只来自自己的 Manager', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-freeze-'))
  const managers = new Map<string, Agent>([
    ['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')],
    ['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')],
  ])
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await startRun(engine, 'ws-a', 'manager-a')).ok, true)
    assert.equal((await startRun(engine, 'ws-b', 'manager-b')).ok, true, 'B start 时 A 仍在运行')
    await advance(engine, store, 'ws-a')
    await advance(engine, store, 'ws-b')
    assert.deepEqual(spawns, [
      { label: 'judge', agentOptions: { provider: 'provider-a', model: 'model-a' } },
      { label: 'role:worker', agentOptions: { provider: 'provider-a', model: 'model-a' } },
      { label: 'judge', agentOptions: { provider: 'provider-b', model: 'model-b' } },
      { label: 'role:worker', agentOptions: { provider: 'provider-b', model: 'model-b' } },
    ], 'B start 后 A 的新 Judge / 新 Role 必须仍用 A 的冻结路由')
    const a = (await store.get('ws-a'))!.run
    const b = (await store.get('ws-b'))!.run
    assert.deepEqual(a.delegationRoute, { provider: 'provider-a', modelId: 'model-a' })
    assert.deepEqual(b.delegationRoute, { provider: 'provider-b', modelId: 'model-b' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('Store 关闭重开（host 重启）后，新 Engine 仍用本 Run 的冻结值', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-freeze-restart-'))
  const managers = new Map<string, Agent>([['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')]])
  const spawns: Spawn[] = []
  const firstStore = new StateStore(home)
  try {
    assert.equal((await startRun(engineFor(firstStore, managers, spawns), 'ws', 'manager-a')).ok, true)
  } finally { firstStore.close() }
  const store = new StateStore(home)
  try {
    const reopened = engineFor(store, managers, spawns)
    assert.deepEqual((await store.get('ws'))!.run.delegationRoute, { provider: 'provider-a', modelId: 'model-a' }, '冻结值随 Run 持久化')
    // Manager 的实时路由在重启后漂移：本 Run 只认自己的冻结事实。
    managers.set('manager-a', managerAgent('manager-a', 'provider-drifted', 'model-drifted'))
    await advance(reopened, store, 'ws')
    assert.deepEqual(spawns, [
      { label: 'judge', agentOptions: { provider: 'provider-a', model: 'model-a' } },
      { label: 'role:worker', agentOptions: { provider: 'provider-a', model: 'model-a' } },
    ], '重开后尚未创建的 Role/Judge 使用冻结值')
    // 新 Run 走自己的 Manager 路由，且不改写旧 Run 的冻结值。
    assert.equal(reopened.buildInitialRun('manager-a', 'model-route-freeze', CONFIG, 'hash').delegationRoute, undefined, '新 Run 在 start 前没有路由')
    assert.equal((await startRun(reopened, 'ws-2', 'manager-a')).ok, true)
    await advance(reopened, store, 'ws-2')
    assert.deepEqual(spawns.slice(2), [
      { label: 'judge', agentOptions: { provider: 'provider-drifted', model: 'model-drifted' } },
      { label: 'role:worker', agentOptions: { provider: 'provider-drifted', model: 'model-drifted' } },
    ], '新 Run 用自己的 Manager 当前路由（漂移后即漂移值）')
    assert.deepEqual((await store.get('ws'))!.run.delegationRoute, { provider: 'provider-a', modelId: 'model-a' }, '旧 Run 的冻结值不被新 Run 改写')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('旧 Run 无冻结信息时不借其他 Run 的值；无法解析时 fail-closed 交给 host 继承', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-freeze-legacy-'))
  const managers = new Map<string, Agent>([['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')]])
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    // 模拟旧 v9 Run：state JSON 里没有 delegationRoute。
    const legacy = { ...engine.buildInitialRun('manager-a', 'model-route-freeze', CONFIG, 'hash') }
    delete (legacy as { delegationRoute?: unknown }).delegationRoute
    assert.equal((await engine.startRun('ws-legacy', legacy, undefined, 'root request')).ok, true)
    await advance(engine, store, 'ws-legacy')
    assert.deepEqual(spawns, [
      { label: 'judge', agentOptions: undefined },
      { label: 'role:worker', agentOptions: undefined },
    ], 'unknown manager 不猜值：不借 ws-b 的路由，留给 host 的正式继承语义')
    assert.equal((await store.get('ws-legacy'))!.run.delegationRoute, undefined)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('冻结是启动期事实：随 Run 创建一起持久化，运行期不可改写', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-freeze-immutable-'))
  const managers = new Map<string, Agent>([['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')]])
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await startRun(engine, 'ws', 'manager-a')).ok, true)
    // 冻结必须早于 state.create：startRun 返回时还没有任何 claim/put，持久化行里
    // 就已经是冻结值——把冻结挪到 create 之后，首次新建会话前 Store 里就没有它。
    const row = (await store.get('ws'))!
    assert.deepEqual(row.run.delegationRoute, { provider: 'provider-a', modelId: 'model-a' }, '冻结值必须与 Run 创建同时落库')
    // 与 definitionSnapshot 同级：运行期改写被拒。
    const altered = structuredClone(row.run)
    altered.delegationRoute = { provider: 'provider-b', modelId: 'model-b' }
    await assert.rejects(store.updateRow('ws', altered, row.stateVersion, []), /delegationRoute is immutable/)
    assert.deepEqual((await store.get('ws'))!.run.delegationRoute, { provider: 'provider-a', modelId: 'model-a' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('正式 helper：requestHeader.config 与创建 options 不同时以 header 为准', () => {
  const agent = {
    id: 'manager',
    options: { provider: 'created-provider', model: 'created-model', maxTokens: 4096 },
    session: { id: 'manager', requestHeader: () => ({ config: { provider: 'header-provider', model: 'header-model', reasoningEffort: 'high' } }) },
  } as unknown as Agent
  const options = parentAgentOptionsForDelegation(agent)
  assert.equal(options.provider, 'header-provider')
  assert.equal(options.model, 'header-model')
  assert.equal(options.reasoningEffort, 'high')
})

/** host 级用例的 Run：`delegationRoute` 缺省即模拟旧 v9 Run。 */
function hostRun(managerSessionId: string, delegationRoute?: RunState['delegationRoute']): RunState {
  return {
    runId: `run-${managerSessionId}`, managerSessionId, catalogWorkflowId: 'model-route-freeze',
    definitionHash: 'hash', definitionSnapshot: CONFIG, status: 'running',
    callStack: [{ workflowId: 'model-route-freeze', nodeId: 'work', nodeToken: crypto.randomUUID(), executionId: 'execution' }],
    roleActors: {}, modelOverrides: {}, blockReason: null, currentExecutionId: 'execution',
    ...(delegationRoute === undefined ? {} : { delegationRoute }),
  }
}

function judgeInput(run: RunState, judgeSessionId: string): JudgeSpawnInput {
  return {
    nodeToken: run.callStack[0]!.nodeToken, criteria: 'PASS.',
    boundary: { dispatchedAt: 0, managerFromSeq: 0 }, claim: { result: 'succeeded', handoff: 'candidate' },
    cwd: '.', judgeSessionId,
  }
}

/**
 * 真实 `makeSubagentHost` 的受控 ctx：捕获 spawn（`startContinuable`）与 compact
 * fallback（`agents.resume`）边界实际收到的 agentOptions，并让 Judge spawn 的
 * fail-closed 工具面断言可以通过。#118 D-91-2：host 无 legacyRoute 兜底。
 */
function realHost(
  managers: Map<string, Agent>,
  options: { judgeSessionId?: string } = {},
): {
  host: ReturnType<typeof makeSubagentHost>
  spawns: Array<{ label: string; agentOptions: SpawnAgentOptions | undefined }>
  resumes: Array<{ resumeSessionId: string; agentOptions: unknown }>
} {
  const judgeSessionId = options.judgeSessionId ?? 'judge-child'
  const spawns: Array<{ label: string; agentOptions: SpawnAgentOptions | undefined }> = []
  const resumes: Array<{ resumeSessionId: string; agentOptions: unknown }> = []
  const visible = JUDGE_REQUIRED_TOOLS.map(name => ({ name }))
  const judgeChild = { id: judgeSessionId, ctx: { tools: { schemas: () => visible } } } as unknown as Agent
  const queue: HostPromptDeliverer = {
    async [deliverSubagentPrompt]() { return MessageId('dispatch-queued') },
  }
  const ctx = {
    subagents: {
      queue,
      async startContinuable(spec: { label: string; childId?: unknown; request: { agentOptions?: { provider?: string; model?: string } } }) {
        spawns.push({ label: spec.label, agentOptions: spec.request.agentOptions })
        return { childId: spec.childId === undefined ? 'child-1' : String(spec.childId), messageId: 'message-1' }
      },
      async drainContinuableChildren() {},
    },
    agents: {
      get: (id: unknown) => (String(id) === judgeSessionId ? judgeChild : undefined),
      resume: async (call: { resumeSessionId: unknown; agentOptions?: unknown }) => {
        resumes.push({ resumeSessionId: String(call.resumeSessionId), agentOptions: call.agentOptions })
        return { agent: { id: String(call.resumeSessionId) } as unknown as Agent, dispose: async () => {} }
      },
    },
    tools: { schemas: () => visible },
    get: () => undefined,
    logger: { warn: () => {} },
    jobs: { onJobDone: () => () => {} },
    effect: () => {},
  } as unknown as Context
  const adapters: HostAdapters = {
    ctx,
    managerAgentOf: run => managers.get(run.managerSessionId),
    registerJudgeSession: () => {}, revokeJudgeSession: () => {}, registerRoleActorSession: () => {},
  }
  return { host: makeSubagentHost(adapters, testParticipants(ctx)), spawns, resumes }
}

test('host 侧 Role 派发使用本 Run 冻结的路由', async () => {
  const managers = new Map<string, Agent>([
    ['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')],
    ['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')],
  ])
  const { host, spawns } = realHost(managers)
  await host.ensureRoleActor(hostRun('manager-a', { provider: 'provider-a', modelId: 'model-a' }), 'worker', 'first dispatch')
  await host.ensureRoleActor(hostRun('manager-b', { provider: 'provider-b', modelId: 'model-b' }), 'worker', 'first dispatch')
  assert.deepEqual(spawns.map(s => s.agentOptions), [
    { provider: 'provider-a', model: 'model-a' },
    { provider: 'provider-b', model: 'model-b' },
  ])
})

test('host 侧 Judge spawn 使用本 Run 冻结的路由', async () => {
  const managers = new Map<string, Agent>([
    ['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')],
    ['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')],
  ])
  const { host, spawns } = realHost(managers, { judgeSessionId: 'judge-a' })
  const run = hostRun('manager-a', { provider: 'provider-a', modelId: 'model-a' })
  assert.deepEqual(await host.startJudge(run, judgeInput(run, 'judge-a')), { judgeSessionId: 'judge-a', messageId: 'message-1' })
  assert.deepEqual(spawns, [{ label: 'workflow-judge:work', agentOptions: { provider: 'provider-a', model: 'model-a' } }],
    'Judge 拿本 Run 的冻结值，而不是另一个 Run 的当前 Manager 路由')
})

test('host 侧 compact fallback 使用本 Run 冻结的路由', async () => {
  const managers = new Map<string, Agent>([['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')]])
  const { host, resumes } = realHost(managers)
  const run = { ...hostRun('manager-b', { provider: 'provider-a', modelId: 'model-a' }), roleActors: { worker: 'sess-worker' } }
  assert.deepEqual(await host.compactRoleActor(run, 'worker'), { ok: true, detail: 'no compaction backend; boundary compact skipped' })
  assert.deepEqual(resumes, [{ resumeSessionId: 'sess-worker', agentOptions: { provider: 'provider-a', model: 'model-a' } }],
    'cold compact 的 resume 走本 Run 冻结值')
})

test('旧 Run（无冻结值）+ 两个 Run 的 Manager 都在场：派发与 compact 都不借别人的路由', async () => {
  const managers = new Map<string, Agent>([
    ['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')],
    ['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')],
  ])
  const { host, spawns, resumes } = realHost(managers, { judgeSessionId: 'judge-legacy' })
  const legacy = hostRun('manager-a')
  assert.equal(legacy.delegationRoute, undefined)
  await host.ensureRoleActor(legacy, 'worker', 'first dispatch')
  await host.startJudge(legacy, judgeInput(legacy, 'judge-legacy'))
  assert.deepEqual(spawns.map(s => s.agentOptions), [undefined, undefined],
    '旧 Run 不注入路由：交回宿主 spawn 的继承语义，绝不借在场 manager-b 的值')
  assert.deepEqual(await host.compactRoleActor({ ...legacy, roleActors: { worker: 'sess-worker' } }, 'worker'),
    { ok: true, detail: 'no compaction backend; boundary compact skipped' })
  assert.deepEqual(resumes, [{ resumeSessionId: 'sess-worker', agentOptions: undefined }], '旧 Run 的 compact fallback 保持不注入')
})
