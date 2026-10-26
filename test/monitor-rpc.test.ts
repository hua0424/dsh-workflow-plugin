// #251 运行监控 status RPC 受控测试：真 engine + SQLite + stub 派发 + 隔离临时
// DSH home（绝不触碰真实 ~/.dsh），覆盖活跃 Run / 无 Run / 终态 Run / 维护诊断态。
// 视图模型纯函数与 bundle 注册断言在 test/monitor-view.test.ts。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimCaller, WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { createMonitorRpcHandler, MONITOR_RPC_CHANNEL } from '../src/monitor/rpc.ts'
import { monitorViewModel, EMPTY_GUIDANCE } from '../web-client/src/monitor-view.js'
import { readRunLayout } from '../src/monitor/layout.ts'
import type { EditorLayout } from '../src/editor/layout.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3', roles: { reviewer: { persona: 'Review', model: { provider: 'prov', modelId: 'm-review' } } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: {
    plan: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
      results: { succeeded: { criteria: 'The plan is complete.', target: { node: 'review' } } },
    },
    review: {
      execution: { type: 'actor-task', role: 'reviewer', instruction: 'Review' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct review' } },
      results: { succeeded: { criteria: 'The review is complete.', target: { return: 'done' } } },
    },
  } } }

// 与 test/actor-tokenless-block.test.ts 同构的最小 harness（stub 派发，零真实会话）。
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-251-'))
  const store = new StateStore(home)
  let message = 0
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: `actor-message-${++message}` } },
    async sendRoleActor(run, role) { return { messageId: `actor-message-${++message}`, childId: run.roleActors[role]! } },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, role) { return { childId: `role-${role}`, messageId: `actor-message-${++message}` } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: `judge-message-${++message}` } },
    async followupJudge() { return { messageId: `judge-followup-${++message}` } },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' },
  }, { async run() { throw new Error('unexpected Program') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  return { home, store, engine, cleanup() { store.close(); rmSync(home, { recursive: true, force: true }) } }
}

/** 显式传 workspace key 形状的 cwd：服务端只按请求上行解析，不再回退 process.cwd。 */
function handlerOf(h: ReturnType<typeof harness>, layout?: EditorLayout) {
  return createMonitorRpcHandler({
    maintenance: () => undefined,
    resolveWorkspace: async cwd => cwd ?? 'ws',
    latest: async workspaceKey => h.store.get(workspaceKey),
    active: async () => h.store.activeRuns(),
    byRunId: async runId => h.store.getByRunId(runId),
    executions: async runId => h.store.runExecutionsByRunId(runId),
    layout: async () => layout,
  })
}

async function claim(h: ReturnType<typeof harness>, caller: ClaimCaller, result: string, handoff: string): Promise<void> {
  assert.equal((await h.engine.handleClaim('ws', { result, handoff }, caller)).ok, true)
  await h.engine.handleTurnEnded('ws', caller)
}

async function judgeAccept(h: ReturnType<typeof harness>, caller: ClaimCaller): Promise<void> {
  const row = (await h.store.get('ws'))!
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', caller)).ok, true)
  await h.engine.handleTurnEnded('ws', caller)
}

// #263：empty 只表示「当前 cwd 无 Run」，不是全库无 Run（其他 workspace 仍可能有活跃 Run）。
test('#254 status：当前 cwd 零 Run → empty 模式（含空活跃清单）', async () => {
  const h = harness()
  try {
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { mode: 'empty', runs: [] })
  } finally { h.cleanup() }
})

test('#251 status：活跃 Run → 完整只读投影（节点/角色模型/图/启动 prompt/BLOCK）', async () => {
  const h = harness()
  try {
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const handler = handlerOf(h)
    const active = await handler('status', { cwd: 'ws' })
    assert.equal(active.ok, true)
    const payload = active.value as Extract<typeof active.value, { mode: 'run' }>
    assert.equal(payload.mode, 'run')
    assert.equal(payload.run!.status, 'running')
    assert.equal(payload.run!.workflowId, 'test')
    assert.equal(payload.run!.launchPrompt, '受控启动请求')
    // #254：活跃清单带 workspace 标识（当前 Run 也在其中，默认选中）。
    assert.deepEqual(payload.runs, [{ runId: payload.run!.runId, workspaceKey: 'ws', workflowId: 'test', status: 'running' }])
    // 节点按 visit 升序；首个工作单 working、当前焦点在 plan。
    assert.equal(payload.run!.nodes.length, 1)
    assert.deepEqual([payload.run!.nodes[0].nodeId, payload.run!.nodes[0].phase, payload.run!.nodes[0].current], ['plan', 'working', true])
    // #253 调用栈投影：根流程单帧，供客户端面包屑/自动跟随定位（不含 nodeToken）。
    const launched = (await h.store.get('ws'))!
    assert.deepEqual(payload.run!.callStack, [{ workflowId: 'test', nodeId: 'plan', executionId: launched.execution.executionId }])
    // 冻结图结构：根流程两节点 + 生效模型（manager 继承路由，reviewer 显式声明）。
    const flow = payload.run!.flows['test']
    assert.deepEqual(flow.nodes.map(node => [node.id, node.kind, node.role]), [['plan', 'actor-task', 'manager'], ['review', 'actor-task', 'reviewer']])
    assert.equal(flow.nodes.find(node => node.id === 'review')!.model!.modelId, 'm-review')
    const roles = Object.fromEntries(payload.run!.roles.map(role => [role.role, role.model.modelId]))
    assert.equal(roles['reviewer'], 'm-review')
    assert.ok('judge' in roles, '角色清单含 judge')

    // 推进到 review working 后：节点两个，栈顶焦点切到 review。
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    const afterPlan = (await h.store.get('ws'))!
    const planJudge: ClaimCaller = { sessionId: afterPlan.execution.judge!.sessionId!, turnUserMessageIds: new Set([afterPlan.execution.judge!.messageId!]) }
    await judgeAccept(h, planJudge)
    let row = (await h.store.get('ws'))!
    assert.equal(row.execution.nodeId, 'review')
    const reviewer: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    await claim(h, reviewer, 'succeeded', 'review artifact')
    const afterReview = await handler('status', { cwd: 'ws' })
    assert.equal(afterReview.ok, true)
    const checking = afterReview.value as Extract<typeof afterReview.value, { mode: 'run' }>
    assert.deepEqual(checking.run!.nodes.map(node => [node.visit, node.nodeId, node.phase, node.current]), [[1, 'plan', 'exited', false], [2, 'review', 'checking', true]])
    // 未知 endpoint 与非法 payload 明确拒绝。
    assert.equal((await handler('reset', {})).ok, false)
    assert.equal((await handler('status', { cwd: 42 })).ok, false)
  } finally { h.cleanup() }
})

test('#252 status：布局坐标随 payload 返回（缺失补网格）且不改写输入', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    const layout: EditorLayout = { version: 1, main: { plan: { x: 10, y: 20 } }, children: {} }
    const before = JSON.parse(JSON.stringify(layout)) as EditorLayout
    const result = await handlerOf(h, layout)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    assert.deepEqual(payload.run!.layout.main.plan, { x: 10, y: 20 })
    // 缺失的 review 按网格第 2 位补位（fillMissingPositions 只改副本）。
    assert.deepEqual(payload.run!.layout.main.review, { x: 260, y: 40 })
    assert.deepEqual(layout, before, '输入布局对象不被原地补位改写')
    // 结果端口随图返回，供只读画布绘制结果端口与连线。
    const plan = payload.run!.flows.test.nodes.find(node => node.id === 'plan')!
    assert.deepEqual(plan.results, { succeeded: { criteria: 'The plan is complete.', target: { node: 'review' } } })
  } finally { h.cleanup() }
})

test('#262 status→视图投影：图卡生效模型来自服务端投影，缺路由不虚构', async () => {
  const h = harness()
  try {
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    const main = monitorViewModel(payload).run!.graph.flows.find(flow => flow.id === 'test')!
    // reviewer 显式声明模型：画布装饰文本直接用服务端算出的 provider/modelId。
    assert.equal(main.decorations.review.summary, 'prov/m-review')
    // manager 继承默认路由：本 harness 无冻结路由 → 服务端投影为空对象，
    // 客户端安全降级（不制造 unknown/假 provider），已执行节点的状态徽标照常。
    assert.deepEqual(payload.run!.flows.test.nodes.find(node => node.id === 'plan')!.model, {})
    assert.equal(main.decorations.plan.summary, undefined)
    assert.equal(typeof main.decorations.plan.badge, 'string')
  } finally { h.cleanup() }
})

test('#252 status：平铺布局经真实读取进入 payload（与编辑器同路径）', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    mkdirSync(join(h.home, 'workflows'), { recursive: true })
    writeFileSync(join(h.home, 'workflows', 'test.layout.json'), JSON.stringify({ version: 1, main: { plan: { x: 7, y: 8 } }, children: {} }))
    const handler = createMonitorRpcHandler({
      maintenance: () => undefined,
      resolveWorkspace: async cwd => cwd ?? 'ws',
      latest: async workspaceKey => h.store.get(workspaceKey),
      active: async () => h.store.activeRuns(),
      byRunId: async runId => h.store.getByRunId(runId),
      executions: async runId => h.store.runExecutionsByRunId(runId),
      layout: async workflowId => readRunLayout(h.home, workflowId),
    })
    const result = await handler('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    assert.deepEqual(payload.run!.layout.main.plan, { x: 7, y: 8 }, '平铺布局被 status 读到')
  } finally { h.cleanup() }
})

test('#252 status：启动后变更配置对象/磁盘 YAML，冻结图不变（AC4）', async () => {
  const h = harness()
  try {
    const launched = structuredClone(config)
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', launched, 'hash'), undefined, '受控启动请求')).ok, true)
    const first = await handlerOf(h)('status', { cwd: 'ws' })
    const payload = first.value as Extract<typeof first.value, { mode: 'run' }>
    const frozenFlows = structuredClone(payload.run!.flows)
    // 启动后深改内存配置：结果目标、角色模型、节点清单都应只影响后续启动的 Run。
    launched.workflow.nodes.plan.results.succeeded.target = { return: 'done' }
    launched.roles.reviewer.model!.modelId = 'm-mutated'
    launched.workflow.nodes.extra = { execution: { type: 'actor-task', role: 'reviewer', instruction: 'x' }, checker: { checkerId: 'judge.claim-correct', config: { criteria: 'x' } }, results: { succeeded: { criteria: 'x', target: { return: 'done' } } } }
    // 启动后改写磁盘 YAML：status 只读 Run 的冻结快照，不重新加载 catalog。
    mkdirSync(join(h.home, 'workflows'), { recursive: true })
    writeFileSync(join(h.home, 'workflows', 'test.yaml'), 'schemaVersion: agent-workflow/v3\nworkflow:\n  startNode: extra\n')
    const second = await handlerOf(h)('status', { cwd: 'ws' })
    const after = second.value as Extract<typeof second.value, { mode: 'run' }>
    assert.deepEqual(after.run!.flows, frozenFlows, 'flows 与启动时冻结快照一致')
    assert.equal(after.run!.roles.find(role => role.role === 'reviewer')!.model.modelId, 'm-review')
  } finally { h.cleanup() }
})

test('#251 status：BLOCK 原因透出（run 级 + 节点级）', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    const afterPlan = (await h.store.get('ws'))!
    const planJudge: ClaimCaller = { sessionId: afterPlan.execution.judge!.sessionId!, turnUserMessageIds: new Set([afterPlan.execution.judge!.messageId!]) }
    await judgeAccept(h, planJudge)
    const row = (await h.store.get('ws'))!
    const reviewer: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    assert.equal((await h.engine.handleBlock('ws', undefined, '等待授权', reviewer)).ok, true)
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    assert.equal(payload.run!.status, 'blocked')
    // BLOCK 原因记录在工作单上（run.blockReason 只在终止等路径写入）；投影按节点透出。
    const blockedNode = payload.run!.nodes.find(node => node.current)
    assert.equal(blockedNode!.blockReason, '等待授权')
  } finally { h.cleanup() }
})

test('#251 status：终态 Run → completed + 业务返回', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    let row = (await h.store.get('ws'))!
    await judgeAccept(h, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
    row = (await h.store.get('ws'))!
    await claim(h, { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }, 'succeeded', 'review artifact')
    row = (await h.store.get('ws'))!
    await judgeAccept(h, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
    row = (await h.store.get('ws'))!
    assert.equal(row.run.status, 'completed')
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    assert.equal(payload.run!.status, 'completed')
    assert.equal(payload.run!.terminal, true)
    // #254：终态 Run 不在活跃清单；投影仍返回完整终态图（客户端展示并停轮询）。
    assert.deepEqual(payload.runs, [])
    assert.deepEqual(payload.run!.businessReturn, { name: 'done', source: row.execution.executionId })
    assert.deepEqual(payload.run!.nodes.map(node => [node.visit, node.phase]), [[1, 'exited'], [2, 'exited']])
    assert.deepEqual(payload.run!.callStack, [], '终态 Run 调用栈为空')
  } finally { h.cleanup() }
})

test('#263 status：同 cwd 旧终态→新 Run —— 默认读新 Run，显式旧 runId 仍复盘完整终态（completed/terminated）', async () => {
  const h = harness()
  type RunView = {
    run: {
      runId: string
      status: string
      terminal: boolean
      businessReturn: { name: string } | null
      nodes: Array<{ phase: string }>
      callStack: unknown[]
    }
  }
  try {
    const handler = handlerOf(h)
    const view = async (payload: Record<string, unknown>) => (await handler('status', payload)).value as RunView
    const start = async (label: string) => assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, label)).ok, true)

    // completed 结局：走完 plan/review 两个节点。
    await start('old completed')
    await claim(h, { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }, 'succeeded', 'plan artifact')
    let row = (await h.store.get('ws'))!
    await judgeAccept(h, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
    row = (await h.store.get('ws'))!
    await claim(h, { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }, 'succeeded', 'review artifact')
    row = (await h.store.get('ws'))!
    await judgeAccept(h, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
    const completedId = (await h.store.get('ws'))!.run.runId

    // 同 cwd 起新 Run：latest 语义不变（任意状态的最新 Run），默认读新 Run。
    await start('new after completed')
    const currentId = (await h.store.get('ws'))!.run.runId
    assert.notEqual(currentId, completedId, '同 cwd 已有新 Run')
    const fallback = await view({ cwd: 'ws' })
    assert.equal(fallback.run.runId, currentId, '默认读新 Run，不回退历史')
    assert.equal(fallback.run.terminal, false)
    // 显式旧 runId：不依赖 recent 摘要也返回完整终态（terminal/业务返回/节点/调用栈）。
    const oldCompleted = await view({ cwd: 'ws', runId: completedId })
    assert.equal(oldCompleted.run.runId, completedId)
    assert.equal(oldCompleted.run.status, 'completed')
    assert.equal(oldCompleted.run.terminal, true)
    assert.equal(oldCompleted.run.businessReturn!.name, 'done')
    assert.deepEqual(oldCompleted.run.nodes.map(node => node.phase), ['exited', 'exited'])
    assert.deepEqual(oldCompleted.run.callStack, [])

    // terminated 结局：reset 终止当前 Run，同 cwd 再起新 Run，旧 Run 仍可经 runId 复盘（无业务返回）。
    // #270 AC-12 前置：reset 前经 status 投影捕获非空停止栈（禁止空对空通过）。
    const beforeReset = await view({ cwd: 'ws' })
    const stoppedFrames = structuredClone(beforeReset.run.callStack)
    assert.ok(stoppedFrames.length > 0, '#270 AC-12 前置：reset 前调用栈非空')
    assert.equal((await h.engine.handleReset('ws', true)).ok, true)
    const terminatedRow = (await h.store.get('ws'))!
    assert.equal(terminatedRow.run.status, 'terminated')
    await start('new after terminated')
    const newestId = (await h.store.get('ws'))!.run.runId
    const newest = await view({ cwd: 'ws' })
    assert.equal(newest.run.runId, newestId, '终止后默认仍读新 Run')
    const oldTerminated = await view({ cwd: 'ws', runId: terminatedRow.run.runId })
    assert.equal(oldTerminated.run.runId, terminatedRow.run.runId)
    assert.equal(oldTerminated.run.status, 'terminated')
    assert.equal(oldTerminated.run.terminal, true)
    assert.equal(oldTerminated.run.businessReturn, null)
    assert.equal(oldTerminated.run.nodes.length, 1)
    // #270 AC-12：terminated 返回原停止位置的有序帧，帧仅 workflowId/nodeId/executionId 三字段（无 nodeToken）。
    assert.deepEqual(oldTerminated.run.callStack, stoppedFrames, 'terminated 复盘原停止位置的有序帧')
    for (const frame of oldTerminated.run.callStack) {
      assert.deepEqual(Object.keys(frame as object).sort(), ['executionId', 'nodeId', 'workflowId'], '帧字段恰为三，无 nodeToken')
    }
  } finally { h.cleanup() }
})

test('#251 status：cwd 原样透传，缺省不猜宿主 process.cwd（F4）', async () => {
  const seen: Array<string | undefined> = []
  const handler = createMonitorRpcHandler({
    maintenance: () => undefined,
    resolveWorkspace: async cwd => { seen.push(cwd); return cwd },
    latest: async key => { seen.push(key); return undefined },
    active: async () => [],
    byRunId: async runId => { seen.push(runId); return undefined },
    executions: async runId => { seen.push(runId); return [] },
    layout: async () => undefined,
  })
  assert.deepEqual(await handler('status', {}), { ok: true, value: { mode: 'empty', runs: [] } })
  assert.deepEqual(await handler('status', { cwd: 'D:/ws' }), { ok: true, value: { mode: 'empty', runs: [] } })
  // 缺省 cwd 只解析为 undefined，不回退 process.cwd；显式 cwd 用于解析与默认 Run（#263 已无 recent 额外读）。
  assert.deepEqual(seen, [undefined, 'D:/ws', 'D:/ws'])
})

test('#254 status：活跃清单跨 workspace + runId 切换 + 失效回退', async () => {
  const h = harness()
  try {
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'A')).ok, true)
    assert.equal((await h.engine.startRun('ws2', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'B')).ok, true)
    const rowA = (await h.store.get('ws'))!
    const rowB = (await h.store.get('ws2'))!
    const handler = handlerOf(h)
    const first = await handler('status', { cwd: 'ws' })
    const payload = first.value as Extract<typeof first.value, { mode: 'run' }>
    assert.equal(payload.run!.runId, rowA.run.runId, '默认选中当前 cwd 的 Run')
    assert.deepEqual(payload.runs.map(ref => ref.runId).sort(), [rowA.run.runId, rowB.run.runId].sort())
    assert.ok(payload.runs.every(ref => typeof ref.workspaceKey === 'string' && ref.workspaceKey !== ''), '每条活跃 Run 带 workspace 标识')
    const picked = (await handler('status', { cwd: 'ws', runId: rowB.run.runId })).value as Extract<typeof first.value, { mode: 'run' }>
    assert.equal(picked.run!.runId, rowB.run.runId, 'runId 可跨 workspace 选择')
    assert.equal(picked.run!.workspaceKey, 'ws2')
    const fallback = (await handler('status', { cwd: 'ws', runId: 'missing' })).value as Extract<typeof first.value, { mode: 'run' }>
    assert.equal(fallback.run!.runId, rowA.run.runId, '失效 runId 回退 cwd 默认 Run')
  } finally { h.cleanup() }
})

test('#251 status：维护诊断短路，不触碰状态库', async () => {
  const touched: string[] = []
  const handler = createMonitorRpcHandler({
    maintenance: () => ({ kind: 'incompatible', path: '/tmp/state.sqlite3', userVersion: 1, tables: ['runs'], reason: 'incompatible state format (user_version=1); original data retained' }),
    resolveWorkspace: async () => { touched.push('resolve'); return undefined },
    latest: async () => { touched.push('latest'); return undefined },
    active: async () => { touched.push('active'); return [] },
    byRunId: async () => { touched.push('byRunId'); return undefined },
    executions: async () => { touched.push('executions'); return [] },
    layout: async () => { touched.push('layout'); return undefined },
  })
  const result = await handler('status', {})
  assert.equal(result.ok, true)
  const payload = result.value as Extract<typeof result.value, { mode: 'maintenance' }>
  assert.equal(payload.mode, 'maintenance')
  assert.equal(payload.maintenance!.kind, 'incompatible')
  assert.match(payload.maintenance!.reason, /incompatible state format/)
  assert.deepEqual(touched, [])
  // 通道名与编辑器通道分离（ADR-0005：独立通道）。
  assert.notEqual(MONITOR_RPC_CHANNEL, '/workflow-config-editor')
})

// #270 AC-10：根+子流程配置。manager 未显式设 model（继承默认路由），reviewer 显式，
// call-child 是无工作单的 child-workflow 节点，s1 是子流程 manager 节点。
const modelConfig: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3', roles: { reviewer: { persona: 'Review', model: { provider: 'prov', modelId: 'm-review' } } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: {
    plan: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
      results: { succeeded: { criteria: 'The plan is complete.', target: { node: 'call-child' } } },
    },
    'call-child': {
      execution: { type: 'child-workflow', workflowId: 'sub' },
      onReturn: { out: { node: 'review' } },
    },
    review: {
      execution: { type: 'actor-task', role: 'reviewer', instruction: 'Review' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct review' } },
      results: { succeeded: { criteria: 'The review is complete.', target: { return: 'done' } } },
    },
  } },
  childWorkflows: { sub: { startNode: 's1', returns: ['out'], nodes: {
    s1: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Sub work' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct sub work' } },
      results: { succeeded: { criteria: 'The sub work is complete.', target: { return: 'out' } } },
    },
  } } },
}

test('#270 AC-10 默认模型继承正例：冻结 managerRoute 投影到根/子流程，显式路由不被覆盖', async () => {
  const h = harness()
  try {
    // 启动前注入非空默认路由（#223 语义：由宿主装配决定，engine seam 可覆盖）。
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', modelConfig, 'hash'), undefined, '受控启动请求')).ok, true)
    // 启动后改默认路由：投影必须读启动时冻结的值。
    h.engine.managerRoute = async () => ({ provider: 'mut', model: 'm-mutated' })
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>

    // 根流程：plan（未显式设 model 的 manager）继承冻结默认路由。
    const main = payload.run!.flows.test
    assert.deepEqual(main.nodes.find(node => node.id === 'plan')!.model, { provider: 'mgr', modelId: 'm-manager' })
    // 显式路由不被默认覆盖。
    assert.deepEqual(main.nodes.find(node => node.id === 'review')!.model, { provider: 'prov', modelId: 'm-review' })
    // 无工作单的 child-workflow 节点：不虚构模型（无 model 键）。
    const callChild = main.nodes.find(node => node.id === 'call-child')!
    assert.equal(callChild.kind, 'child-workflow')
    assert.equal(callChild.childWorkflowId, 'sub')
    assert.equal(callChild.model, undefined)
    // 子流程：s1 同为 manager，继承同一冻结默认。
    assert.deepEqual(payload.run!.flows.sub.nodes.find(node => node.id === 's1')!.model, { provider: 'mgr', modelId: 'm-manager' })
    // 角色清单：reviewer 显式路由不被默认覆盖（manager 不在角色清单，其继承路由由节点投影覆盖）。
    const roles = Object.fromEntries(payload.run!.roles.map(role => [role.role, role.model.modelId]))
    assert.equal(roles.reviewer, 'm-review')

    // 同一 payload 经 view-model：summary 为精确 provider/modelId 文本；无工作单节点不虚构 badge。
    const view = monitorViewModel(payload)
    const mainFlow = view.run!.graph.flows.find(flow => flow.id === 'test')!
    assert.equal(mainFlow.decorations.plan.summary, 'mgr/m-manager')
    assert.equal(mainFlow.decorations.review.summary, 'prov/m-review')
    assert.equal(mainFlow.decorations['call-child'], undefined, '无工作单节点无叠加态（不虚构 badge/summary）')
    const subFlow = view.run!.graph.flows.find(flow => flow.id === 'sub')!
    assert.equal(subFlow.decorations.s1.summary, 'mgr/m-manager')
  } finally { h.cleanup() }
})

test('#270 AC-11 空 cwd + 跨目录活跃 Run：mode=empty，视图保留选项与启动引导', async () => {
  const h = harness()
  try {
    assert.equal((await h.engine.startRun('ws2', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, 'B')).ok, true)
    const otherRunId = (await h.store.get('ws2'))!.run.runId
    const result = await handlerOf(h)('status', { cwd: 'ws-empty' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'empty' }>
    assert.equal(payload.mode, 'empty')
    assert.equal(payload.run, undefined)
    assert.deepEqual(payload.runs, [{ runId: otherRunId, workspaceKey: 'ws2', workflowId: 'test', status: 'running' }])

    const view = monitorViewModel(payload)
    assert.equal(view.mode, 'empty')
    assert.equal(view.polling, true, '空态继续轮询')
    assert.equal(view.guidance, EMPTY_GUIDANCE, '保留启动引导')
    assert.deepEqual(view.runs, [{ runId: otherRunId, workflowId: 'test', status: 'running', statusLabel: '运行中', label: `ws2 · test` }])
  } finally { h.cleanup() }
})
