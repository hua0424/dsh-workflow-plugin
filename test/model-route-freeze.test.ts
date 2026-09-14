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
import { WorkflowEngine, type SubagentHost } from '../src/engine/engine.ts'
import { makeStateHost, makeSubagentHost, type HostAdapters } from '../src/plugin/host.ts'
import { StateStore } from '../src/state/store.ts'
import type { RunState, WorkflowConfig } from '../src/types.ts'

const CONFIG: WorkflowConfig = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles:
  worker:
    persona: Worker persona.
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: work
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`), { workflowId: 'model-route-freeze' })

/** 受控 Manager Agent：正式 helper 无 requestHeader 时回退到 creation options。 */
function managerAgent(sessionId: string, provider: string, model: string): Agent {
  return {
    id: sessionId,
    options: { provider, model },
    session: { id: sessionId, header: {}, requestHeader: () => undefined },
  } as unknown as Agent
}

interface Spawn {
  label: string
  agentOptions: { provider?: string; model?: string } | undefined
}

/** 记录每次真实 spawn 的 label 与 agentOptions。 */
function recordingHost(managers: Map<string, Agent>, spawns: Spawn[]): SubagentHost & { observeTurnEnd(sessionId: string): void } {
  let serial = 0
  const base = {
    async ensureRoleActor(run: RunState, roleKey: string, _initialText: string) {
      spawns.push({ label: `role:${roleKey}`, agentOptions: routeFor(run, managers) })
      return { childId: `child-${++serial}`, messageId: `message-${serial}` }
    },
    async startJudge(run: RunState, input: { judgeSessionId: string }) {
      spawns.push({ label: 'judge', agentOptions: routeFor(run, managers) })
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

/**
 * 复刻正式 host 的默认路由优先级：modelOverrides > 显式 Role/Judge 配置 >
 * 本 Run 冻结默认值 > host 继承。这里只断言"默认值来自哪个 Run"。
 */
function routeFor(run: RunState, managers: Map<string, Agent>): { provider?: string; model?: string } | undefined {
  const frozen = run.delegationRoute
  if (frozen !== undefined) return { provider: frozen.provider, model: frozen.modelId }
  const manager = managers.get(run.managerSessionId)
  if (manager === undefined) return undefined
  const options = parentAgentOptionsForDelegation(manager)
  return { provider: options.provider, model: options.model }
}

/** 真实插件形态：一个 Engine 实例 + 一个 Store；workspace 由 state row 区分。 */
function engineFor(store: StateStore, managers: Map<string, Agent>, spawns: Spawn[]): WorkflowEngine {
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: 'manager-message' } },
    async sendRoleActor() { return { messageId: 'role-message' } },
    managerSessionSeq() { return 0 },
  }, recordingHost(managers, spawns), { async run() { throw new Error('no programs') } }, makeStateHost(store))
  engine.cwdResolver = async () => 'cwd'
  engine.managerRoute = async (managerSessionId: string) => {
    const manager = managers.get(managerSessionId)
    if (manager === undefined) return {}
    const options = parentAgentOptionsForDelegation(manager)
    return { provider: options.provider, model: options.model }
  }
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
  assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff: `${ws} artifact` }, caller)).ok, true)
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

test('host 侧 spawn 使用本 Run 冻结的路由（不读其他 Run 的当前 Manager）', async () => {
  const spawns: Array<{ childId: string; agentOptions: unknown }> = []
  const starts: Array<{ label: string; childId: string }> = []
  const queue: HostPromptDeliverer = {
    async [deliverSubagentPrompt]() { return MessageId('dispatch-queued') },
  }
  const subagents = {
    queue,
    starts,
    async startContinuable(spec: { label: string; request: { agentOptions?: unknown } }) {
      starts.push({ label: spec.label, childId: 'unused' })
      spawns.push({ childId: spec.label, agentOptions: spec.request.agentOptions })
      return { childId: 'child-1', messageId: 'message-1' }
    },
    async drainContinuableChildren() {},
  }
  const managers = new Map<string, Agent>([
    ['manager-a', managerAgent('manager-a', 'provider-a', 'model-a')],
    ['manager-b', managerAgent('manager-b', 'provider-b', 'model-b')],
  ])
  const adapters: HostAdapters = {
    ctx: { subagents, tools: { schemas: () => [] }, jobs: { onJobDone: () => () => {} }, effect: () => {} } as unknown as Context,
    managerAgentOf: run => managers.get(run.managerSessionId),
    cwdOfManager: async () => undefined,
    registerJudgeSession: () => {}, revokeJudgeSession: () => {}, registerRoleActorSession: () => {},
  }
  // 第三个参数即"当前 Manager 的实时路由"：本 Run 已冻结时必须不参与决策。
  const host = makeSubagentHost(adapters, () => ({ provider: 'provider-b', model: 'model-b' }))
  const runA: RunState = {
    runId: 'run-a', managerSessionId: 'manager-a', catalogWorkflowId: 'model-route-freeze',
    definitionHash: 'hash', definitionSnapshot: CONFIG, status: 'running',
    callStack: [{ workflowId: 'model-route-freeze', nodeId: 'work', nodeToken: crypto.randomUUID(), executionId: 'execution-a' }],
    roleActors: {}, modelOverrides: {}, blockReason: null, currentExecutionId: 'execution-a',
    delegationRoute: { provider: 'provider-a', modelId: 'model-a' },
  }
  const runB: RunState = { ...runA, runId: 'run-b', managerSessionId: 'manager-b', delegationRoute: { provider: 'provider-b', modelId: 'model-b' } }
  await host.ensureRoleActor(runA, 'worker', 'first dispatch')
  await host.ensureRoleActor(runB, 'worker', 'first dispatch')
  assert.deepEqual(spawns.map(s => s.agentOptions), [
    { provider: 'provider-a', model: 'model-a' },
    { provider: 'provider-b', model: 'model-b' },
  ])
})
