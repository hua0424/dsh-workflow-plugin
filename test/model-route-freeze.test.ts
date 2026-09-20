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
import { parentAgentOptionsForDelegation, resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { makeStateHost, makeSubagentHost, managerRouteOf, type HostAdapters } from '../src/plugin/host.ts'
import { testParticipants } from './helpers/participants.ts'
import { judgeSpawnPlan, JUDGE_REQUIRED_TOOLS, resolveRoleModel } from '../src/roles/roles.ts'
import { agentOptionsToRoute, routeToAgentOptions, type RunState, type SpawnAgentOptions, type WorkflowConfig } from '../src/types.ts'
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
      { label: 'judge', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined } },
      { label: 'role:worker', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined } },
      { label: 'judge', agentOptions: { provider: 'provider-b', model: 'model-b', reasoningEffort: undefined } },
      { label: 'role:worker', agentOptions: { provider: 'provider-b', model: 'model-b', reasoningEffort: undefined } },
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
      { label: 'judge', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined } },
      { label: 'role:worker', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined } },
    ], '重开后尚未创建的 Role/Judge 使用冻结值')
    // 新 Run 走自己的 Manager 路由，且不改写旧 Run 的冻结值。
    assert.equal(reopened.buildInitialRun('manager-a', 'model-route-freeze', CONFIG, 'hash').delegationRoute, undefined, '新 Run 在 start 前没有路由')
    assert.equal((await startRun(reopened, 'ws-2', 'manager-a')).ok, true)
    await advance(reopened, store, 'ws-2')
    assert.deepEqual(spawns.slice(2), [
      { label: 'judge', agentOptions: { provider: 'provider-drifted', model: 'model-drifted', reasoningEffort: undefined } },
      { label: 'role:worker', agentOptions: { provider: 'provider-drifted', model: 'model-drifted', reasoningEffort: undefined } },
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
  // #149 T1: 显式路由无档位时派发边界带显式 reasoningEffort: undefined 键（清除
  // 同路由继承），而非缺键——strict 断言保留该键存在。
  assert.deepEqual(spawns.map(s => s.agentOptions), [
    { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined },
    { provider: 'provider-b', model: 'model-b', reasoningEffort: undefined },
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
  assert.deepEqual(spawns, [{ label: 'workflow-judge:work', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined } }],
    'Judge 拿本 Run 的冻结值，而不是另一个 Run 的当前 Manager 路由')
})

test('host 侧 compact fallback 使用本 Run 冻结的路由', async () => {
  const managers = new Map<string, Agent>([['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')]])
  const { host, resumes } = realHost(managers)
  const run = { ...hostRun('manager-b', { provider: 'provider-a', modelId: 'model-a' }), roleActors: { worker: 'sess-worker' } }
  assert.deepEqual(await host.compactRoleActor(run, 'worker'), { ok: true, detail: 'no compaction backend; boundary compact skipped' })
  assert.deepEqual(resumes, [{ resumeSessionId: 'sess-worker', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: undefined } }],
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

// ===== #153 T4: workflow_set_role_model 清空思考强度（换模型/同模型），后续派发回落模型默认 =====

test('#153 T4: 换到与 Manager 相同路由：不继承 Manager 显式档位，后续派发回落模型默认', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-t4-same-'))
  const managers = new Map<string, Agent>([['manager-high', effortfulManager('manager-high')]])
  const parent = managers.get('manager-high')!
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager-high', 'model-route-freeze', CONFIG, 'hash'), undefined, 'root request')).ok, true)
    await advance(engine, store, 'ws')
    // 冻结 high 被继承：首个 worker 会话携带 high（即待清除的旧档位）。
    assert.deepEqual(spawns.map(s => s.label), ['judge', 'role:worker'])
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(spawns[1]!.agentOptions), 1).reasoningEffort, 'high')
    const work = (await store.get('ws'))!
    const oldSession = work.run.roleActors.worker!
    const workerCaller = { sessionId: work.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([work.execution.dispatch!.messageId!]) }
    assert.equal((await engine.handleBlock('ws', work.execution.nodeToken, 'switch to the same route to clear effort', workerCaller)).ok, true)
    // 换到与 Manager 相同的路由：override 整体替换为干净路由（不是删除键），
    // 后续派发沿 #150 明确恢复默认语义，不重新继承 Manager effort。
    const set = await engine.handleSetRoleModel('ws', 'worker', 'provider-a', 'model-a', 'manager-high')
    assert.equal(set.ok, true)
    assert.equal(set.message, 'model override saved for worker')
    const afterSet = (await store.get('ws'))!
    assert.deepEqual(afterSet.run.modelOverrides.worker, { provider: 'provider-a', modelId: 'model-a' })
    assert.equal(afterSet.run.roleActors.worker, undefined, '旧 high 会话映射已删')
    assert.equal((await engine.handleResume('ws', afterSet.execution.nodeToken, 'Use the cleared route.', 'manager-high', 'actor')).ok, true)
    const replaced = (await store.get('ws'))!
    assert.notEqual(replaced.run.roleActors.worker, oldSession, '不沿用旧 high 会话')
    const redispatched = spawns[spawns.length - 1]!
    assert.equal(redispatched.label, 'role:worker')
    assert.equal('reasoningEffort' in redispatched.agentOptions!, true, '派发带显式清除键')
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(redispatched.agentOptions), 1).reasoningEffort, undefined,
      '与 Manager 同路由也不重新继承 high：后续实际请求回落模型默认')
    // 同模型再次 set：存活映射仍须退役（仅 override 无 effort 不足以 no-op）。
    const live = (await store.get('ws'))!
    const liveCaller = { sessionId: live.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([live.execution.dispatch!.messageId!]) }
    assert.equal((await engine.handleBlock('ws', live.execution.nodeToken, 'retire the same-model session', liveCaller)).ok, true)
    const again = await engine.handleSetRoleModel('ws', 'worker', 'provider-a', 'model-a', 'manager-high')
    assert.equal(again.ok, true)
    assert.equal(again.message, 'model override saved for worker')
    assert.equal((await store.get('ws'))!.run.roleActors.worker, undefined, 'T4: 同模型 set 有存活映射时仍退役')
    const blockedAgain = (await store.get('ws'))!
    assert.equal((await engine.handleResume('ws', blockedAgain.execution.nodeToken, 'Use the cleared route again.', 'manager-high', 'actor')).ok, true)
    const redispatchedAgain = spawns[spawns.length - 1]!
    assert.equal(redispatchedAgain.label, 'role:worker')
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(redispatchedAgain.agentOptions), 1).reasoningEffort, undefined)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#153 T4: 换到不同模型：原 catalog 显式档位不再生效，后续派发回落模型默认', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-t4-move-'))
  const managers = new Map<string, Agent>([['manager-high', effortfulManager('manager-high')]])
  const parent = managers.get('manager-high')!
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager-high', 'model-route-freeze', EFFORT_CONFIG, 'hash'), undefined, 'root request')).ok, true)
    await advance(engine, store, 'ws')
    // 首个 worker 派发用 catalog 显式档位 low。
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(spawns[1]!.agentOptions), 1).reasoningEffort, 'low')
    const work = (await store.get('ws'))!
    const oldSession = work.run.roleActors.worker!
    const workerCaller = { sessionId: work.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([work.execution.dispatch!.messageId!]) }
    assert.equal((await engine.handleBlock('ws', work.execution.nodeToken, 'move to a different model', workerCaller)).ok, true)
    const set = await engine.handleSetRoleModel('ws', 'worker', 'provider-c', 'model-c', 'manager-high')
    assert.equal(set.ok, true)
    const afterSet = (await store.get('ws'))!
    assert.deepEqual(afterSet.run.modelOverrides.worker, { provider: 'provider-c', modelId: 'model-c' })
    assert.equal(afterSet.run.roleActors.worker, undefined)
    assert.equal((await engine.handleResume('ws', afterSet.execution.nodeToken, 'Use the new model default.', 'manager-high', 'actor')).ok, true)
    const replaced = (await store.get('ws'))!
    assert.notEqual(replaced.run.roleActors.worker, oldSession, '不沿用旧 low 会话')
    const redispatched = spawns[spawns.length - 1]!
    assert.equal(redispatched.label, 'role:worker')
    assert.equal('reasoningEffort' in redispatched.agentOptions!, true, '派发带显式清除键')
    assert.equal(resolveChildAgentOptions(parent, asHostRequested(redispatched.agentOptions), 1).reasoningEffort, undefined,
      '原 catalog low 与 Manager high 都不再生效：后续实际请求使用新模型默认')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

// ===== #149 T1: reasoningEffort 派发（显式档位 / 模型默认回落 / 继承保留）=====

/** 宿主请求 options 位：插件交界输出直喂宿主正式决议函数（运行期类型擦除后即字符串）。 */
function asHostRequested(options: SpawnAgentOptions | undefined): Parameters<typeof resolveChildAgentOptions>[1] {
  return options as unknown as Parameters<typeof resolveChildAgentOptions>[1]
}

/** 与 Manager 同路由且带显式档位的父会话（header config 拥有 provider/model/reasoningEffort）。 */
function effortfulManager(sessionId: string): Agent {
  return {
    id: sessionId,
    options: { provider: 'provider-a', model: 'model-a' },
    session: {
      id: sessionId, header: {},
      requestHeader: () => ({ config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } }),
      snapshotEvents: () => [],
    },
  } as unknown as Agent
}

test('#149 T1: 交界往返无损；显式路由无档位带显式 undefined 键', () => {
  // 显式档位在两个命名交界函数之间往返无损。
  assert.deepEqual(routeToAgentOptions({ provider: 'p', modelId: 'm', reasoningEffort: 'high' }),
    { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(agentOptionsToRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' }),
    { provider: 'p', modelId: 'm', reasoningEffort: 'high' })
  // 显式路由无档位：带显式 reasoningEffort: undefined 键——宿主对同路由子会话
  // 会保留父 effort，只有显式键能经展开覆盖清除它；缺键不等于恢复默认。
  const cleared = routeToAgentOptions({ provider: 'p', modelId: 'm' })
  assert.equal('reasoningEffort' in cleared!, true, '必须带显式键')
  assert.equal(cleared!.reasoningEffort, undefined)
  // 冻结不收录缺席分量（经 SQLite JSON 往返干净）；整体缺席即 undefined（宿主继承）。
  assert.deepEqual(agentOptionsToRoute({ provider: 'p', model: 'm' }), { provider: 'p', modelId: 'm' })
  assert.equal(routeToAgentOptions(undefined), undefined)
  assert.equal(routeToAgentOptions({}), undefined)
})

test('#149 T1: 显式 model 省略 effort 实际使用模型默认（含与 Manager 同路由）', () => {
  const parent = effortfulManager('manager-high')
  // 插件交界输出（显式 model P/M，无 effort）直喂宿主正式决议函数：有效请求无档位。
  const resolved = resolveChildAgentOptions(parent, asHostRequested(routeToAgentOptions({ provider: 'provider-a', modelId: 'model-a' })), 1)
  assert.equal(resolved.reasoningEffort, undefined, '有效请求无档位：回落模型默认，而非继承 high')
  // 机制注记：显式 undefined 键经宿主展开保留（值为 undefined，下游 `!== undefined`
  // / `??` 一律按缺席处理）；基线 pin 0.1.5-rc.2，宿主升级改展开语义时此处先响。
  assert.equal('reasoningEffort' in resolved, true, '显式清除键到达宿主决议函数')
  // 反证（非空断言）：同样路由若缺键，宿主会保留父 high——证明显式键才是清除动作。
  const omitted = resolveChildAgentOptions(parent, asHostRequested({ provider: 'provider-a', model: 'model-a' }), 1)
  assert.equal(omitted.reasoningEffort, 'high', '缺键在同路由下继承父档位，故必须显式清除')
  // 变体路由：宿主的路由变化分支本就自动清除，插件输出同样有效。
  const moved = resolveChildAgentOptions(parent, asHostRequested(routeToAgentOptions({ provider: 'p2', modelId: 'm2' })), 1)
  assert.equal(moved.reasoningEffort, undefined)
  // 显式档位无损。
  const explicit = resolveChildAgentOptions(parent, asHostRequested(routeToAgentOptions({ provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'low' })), 1)
  assert.equal(explicit.reasoningEffort, 'low')
  // 完全未配 model：保留既有继承行为（high）。
  const inherited = resolveChildAgentOptions(parent, asHostRequested(routeToAgentOptions(undefined)), 1)
  assert.equal(inherited.reasoningEffort, 'high')
})

test('#149 T1: Judge 与 Role 同等支持显式档位与同路由回落', () => {
  const parent = effortfulManager('manager-high')
  const frozen = { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' } as const
  // Judge 显式档位：同一交界无损，有效请求即该值。
  const judgeCfg = structuredClone(CONFIG)
  judgeCfg.judgeRole.model = { provider: 'jp', modelId: 'jm', reasoningEffort: 'high' }
  const judgeRun = { ...hostRun('manager-high', frozen), definitionSnapshot: judgeCfg }
  const plan = judgeSpawnPlan(judgeRun, judgeRun.delegationRoute)
  assert.deepEqual(plan.agentOptions, { provider: 'jp', modelId: 'jm', reasoningEffort: 'high' })
  assert.equal(resolveChildAgentOptions(parent, asHostRequested(routeToAgentOptions(plan.agentOptions)), 1).reasoningEffort, 'high')
  // Judge 与 Manager 同路由但省略档位：有效请求回落模型默认（Judge 同等支持）。
  const sameCfg = structuredClone(CONFIG)
  sameCfg.judgeRole.model = { provider: 'provider-a', modelId: 'model-a' }
  const sameRun = { ...hostRun('manager-high', frozen), definitionSnapshot: sameCfg }
  const sameRequested = routeToAgentOptions(judgeSpawnPlan(sameRun, sameRun.delegationRoute).agentOptions)
  assert.equal('reasoningEffort' in sameRequested!, true, 'Judge 同路由省略档位同样带显式清除键')
  assert.equal(resolveChildAgentOptions(parent, asHostRequested(sameRequested), 1).reasoningEffort, undefined,
    'Judge 有效请求回落模型默认')
  // Role 同路由省略档位：经 resolveRoleModel 同一路径回落（Role 侧全链路）。
  const roleCfg = structuredClone(CONFIG)
  roleCfg.roles['worker'] = { persona: 'Worker persona.', model: { provider: 'provider-a', modelId: 'model-a' } }
  const roleRun = { ...hostRun('manager-high', frozen), definitionSnapshot: roleCfg }
  const roleRequested = routeToAgentOptions(resolveRoleModel(roleRun, 'worker', roleRun.delegationRoute))
  assert.equal(resolveChildAgentOptions(parent, asHostRequested(roleRequested), 1).reasoningEffort, undefined,
    'Role 有效请求回落模型默认')
})

/** #149 T1 端到端：冻结携带档位 → Role/Judge 派发 → 快照落库和关库重开。 */
const EFFORT_CONFIG: WorkflowConfig = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Worker persona.
    model: { provider: provider-b, modelId: model-b, reasoningEffort: low }
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

test('#149 T1: 冻结携带档位，Role/Judge 派发与快照落库和关库重开', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-route-effort-'))
  const managers = new Map<string, Agent>([['manager-high', effortfulManager('manager-high')]])
  const spawns: Spawn[] = []
  const store = new StateStore(home)
  const engine = engineFor(store, managers, spawns)
  try {
    assert.equal((await engine.startRun('ws-effort',
      engine.buildInitialRun('manager-high', 'model-route-freeze', EFFORT_CONFIG, 'hash'), undefined, 'root request')).ok, true)
    // 冻结值携带 Manager 档位（未配 model 的 Judge 沿继承拿到 high）。
    assert.deepEqual((await store.get('ws-effort'))!.run.delegationRoute,
      { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' })
    await advance(engine, store, 'ws-effort')
    assert.deepEqual(spawns, [
      { label: 'judge', agentOptions: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
      { label: 'role:worker', agentOptions: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'low' } },
    ], 'Judge 继承冻结档位 high；Role 用显式档位 low')
    // 带档位的 Judge 快照可落库（Judge 属于已 ACCEPT 的前驱 plan execution）。
    const workRow = (await store.get('ws-effort'))!
    const planExec = (await store.execution('ws-effort', workRow.execution.predecessorId!))!
    assert.deepEqual(planExec.judge!.model,
      { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' })
    // previousJudge 与 Judge 共用同一严格路由 schema：在当前 work execution 上
    // 安排一次历史 NEED_CONTEXT 交接，带档位的历史 Judge 同样可落库。
    const current = structuredClone(workRow.execution)
    current.inputVersion = 2
    current.phase = 'checking'
    current.claim = { id: 'claim-work-1', dispatchId: current.dispatch!.id, result: 'succeeded', handoff: 'work candidate' }
    current.judge = {
      id: 'judge-work-2', sessionId: 'judge-work-fresh', claimId: 'claim-work-1',
      inputVersion: 2, settled: false,
      model: { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' },
    }
    current.previousJudge = {
      id: 'judge-work-1', sessionId: 'judge-work-old', claimId: 'claim-work-1',
      inputVersion: 1, settled: true,
      model: { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' },
    }
    current.judgment = {
      result: 'NEED_CONTEXT', reason: 'need more context', claimId: 'claim-work-1',
      judgeDispatchId: 'judge-work-1', judgeSessionId: 'judge-work-old', inputVersion: 1,
    }
    await store.updateRow('ws-effort', workRow.run, workRow.stateVersion,
      [{ execution: current, expectedRevision: current.revision, events: [] }])
    assert.deepEqual((await store.get('ws-effort'))!.execution.previousJudge!.model,
      { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' })
  } finally { store.close() }
  // 关库重开：冻结路由与 Judge/previousJudge 快照稳定。
  const reopened = new StateStore(home)
  try {
    const row = (await reopened.get('ws-effort'))!
    assert.deepEqual(row.run.delegationRoute,
      { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' })
    assert.deepEqual(row.execution.judge!.model,
      { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' })
    assert.deepEqual(row.execution.previousJudge!.model,
      { provider: 'provider-a', modelId: 'model-a', reasoningEffort: 'high' })
  } finally { reopened.close(); rmSync(home, { recursive: true, force: true }) }
})
