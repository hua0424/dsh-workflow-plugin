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
import { createMonitorRpcHandler, projectRunStatus, MONITOR_RPC_CHANNEL } from '../src/monitor/rpc.ts'
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
    events: async runId => h.store.runEventsByRunId(runId),
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

async function judgeReject(h: ReturnType<typeof harness>, caller: ClaimCaller, reason: string): Promise<void> {
  const row = (await h.store.get('ws'))!
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'REJECT', reason, caller)).ok, true)
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

// #270 AC-10：根+子流程配置。manager 与普通角色 worker 都未显式设 model（应继承默认路由），
// reviewer 显式模型作对照；call-child 是 child-workflow 节点，s1 是子流程内未执行的 worker。
const modelConfig: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3', roles: { worker: { persona: 'Work' }, reviewer: { persona: 'Review', model: { provider: 'prov', modelId: 'm-review' } } }, judgeRole: { persona: 'Read only' },
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
      execution: { type: 'actor-task', role: 'worker', instruction: 'Sub work' },
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
    // 先确认落库的冻结路由（唯一基准），而不是只比对同一被测函数事后算出的第二份值。
    assert.deepEqual((await h.store.get('ws'))!.run.delegationRoute, { provider: 'mgr', modelId: 'm-manager' })
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
    // 子流程：普通角色 worker（未显式设 model）继承同一冻结默认。
    assert.deepEqual(payload.run!.flows.sub.nodes.find(node => node.id === 's1')!.model, { provider: 'mgr', modelId: 'm-manager' })
    // 角色清单：reviewer 显式路由不被默认覆盖（manager 不在角色清单，其继承路由由节点投影覆盖）。
    const roles = Object.fromEntries(payload.run!.roles.map(role => [role.role, role.model.modelId]))
    assert.equal(roles.reviewer, 'm-review')

    // 同一 payload 经 view-model：summary 为精确 provider/modelId 文本；无工作单节点不虚构 badge。
    const view = monitorViewModel(payload)
    const mainFlow = view.run!.graph.flows.find(flow => flow.id === 'test')!
    assert.equal(mainFlow.decorations.plan.summary, 'mgr/m-manager')
    assert.equal(typeof mainFlow.decorations.plan.badge, 'string', '已执行节点保留执行叠加态')
    assert.equal(mainFlow.decorations.review.summary, 'prov/m-review')
    assert.equal(mainFlow.decorations['call-child'], undefined, '非 Actor 节点无叠加态')
    const subFlow = view.run!.graph.flows.find(flow => flow.id === 'sub')!
    // s1 是「无工作单的 Actor」：只显示生效模型，不因显示模型而伪造执行 badge。
    assert.deepEqual(subFlow.decorations.s1, { summary: 'mgr/m-manager' })
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

// #274 断言辅助：取指定 nodeId/visit 的投影节点。
function nodeOf(payload: Extract<Awaited<ReturnType<ReturnType<typeof handlerOf>>>, { mode: 'run' }>, nodeId: string, visit = 1) {
  const node = payload.run!.nodes.find(item => item.nodeId === nodeId && item.visit === visit)
  assert.ok(node, `missing node ${nodeId}#${visit}`)
  return node
}

test('#274 status：工作单落库的记录事实随投影（派发/claim/判定各自快照，不含 endedAt）', async () => {
  const h = harness()
  try {
    // 冻结默认路由：manager/judge 未显式声明时继承它（与 spawn 同一份 resolveRoleModel）。
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const handler = handlerOf(h)
    const planRow = (await h.store.get('ws'))!
    // 落库：派发记录带实际路由 + 来源阶段（fresh 派发 = primary）。
    assert.deepEqual(planRow.execution.dispatch!.model, { provider: 'mgr', modelId: 'm-manager' })
    assert.equal(planRow.execution.dispatch!.source, 'primary')

    const planPayload = (await handler('status', { cwd: 'ws' })).value as Extract<Awaited<ReturnType<typeof handlerOf>>, { mode: 'run' }>
    const planNode = nodeOf(planPayload, 'plan')
    assert.equal(planNode.dispatch!.dispatched, true)
    assert.deepEqual(planNode.dispatch!.model, { provider: 'mgr', modelId: 'm-manager' }, '投影原样透出派发快照')
    assert.equal(planNode.dispatch!.source, 'primary')
    assert.equal(planNode.judge, undefined, '未安排 Judge 时不虚构判定记录')
    // 相关 AC-11：投影只给展示事实，不带 nodeToken/会话 ID/messageId 等控制凭据。
    assert.deepEqual(Object.keys(planNode.dispatch!).sort(), ['dispatched', 'id', 'model', 'settled', 'source'])

    // Actor 提交后：claim 独立快照（不因判定改写或消失），judge 事实单独记录。
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    const claimedRow = (await h.store.get('ws'))!
    assert.deepEqual(claimedRow.execution.judge!.model, { provider: 'mgr', modelId: 'm-manager' })
    assert.equal(claimedRow.execution.judge!.source, 'primary')
    const claimedPayload = (await handler('status', { cwd: 'ws' })).value as Extract<Awaited<ReturnType<typeof handlerOf>>, { mode: 'run' }>
    const claimedNode = nodeOf(claimedPayload, 'plan')
    assert.equal(claimedNode.claim!.result, 'succeeded', 'claim 结果与交接文本随投影')
    assert.equal(claimedNode.claim!.handoff, 'plan artifact')
    assert.equal(claimedNode.judge!.dispatched, true)
    assert.deepEqual(claimedNode.judge!.model, { provider: 'mgr', modelId: 'm-manager' })
    assert.equal(claimedNode.judge!.source, 'primary')
    assert.deepEqual(Object.keys(claimedNode.judge!).sort(), ['claimId', 'dispatched', 'id', 'model', 'settled', 'source'])
    assert.equal(JSON.stringify(claimedPayload).includes('nodeToken'), false, '投影不含 nodeToken')

    // 判定后：判定结果保留在判定记录上，派发记录本身不被改动。
    const planJudge: ClaimCaller = { sessionId: claimedRow.execution.judge!.sessionId!, turnUserMessageIds: new Set([claimedRow.execution.judge!.messageId!]) }
    await judgeAccept(h, planJudge)
    const judgedPayload = (await handler('status', { cwd: 'ws' })).value as Extract<Awaited<ReturnType<typeof handlerOf>>, { mode: 'run' }>
    const planExited = nodeOf(judgedPayload, 'plan')
    assert.equal(planExited.judge!.judgment, 'ACCEPT', '判定结果落在判定记录上')
    assert.deepEqual(planExited.judge!.model, { provider: 'mgr', modelId: 'm-manager' }, '判定后记录保留模型事实')
    assert.equal(planExited.exitedAt !== undefined, true, '有派发记录时照常取退出时间')
    assert.equal(typeof planExited.judge!.endedAt, 'undefined', '记录事实不含结束时间（AC-02 边界）')
  } finally { h.cleanup() }
})

test('#274 status：旧记录无记录事实时不回填当前配置（未记录 = 未记录）', async () => {
  const h = harness()
  try {
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    // 模拟 #274 之前落库的旧工作单：删掉记录字段但保留其余事实。
    const before = (await h.store.get('ws'))!
    const legacy = structuredClone(before.execution)
    delete legacy.dispatch!.model
    delete legacy.dispatch!.source
    await h.store.updateRow('ws', before.run, before.stateVersion, [{ execution: legacy, expectedRevision: before.execution.revision, events: [] }])
    // 改当前配置也不影响投影（没有记录就不推导）。
    const payload = (await handlerOf(h)('status', { cwd: 'ws' })).value as Extract<Awaited<ReturnType<typeof handlerOf>>, { mode: 'run' }>
    const node = nodeOf(payload, 'plan')
    assert.deepEqual([node.dispatch!.dispatched, node.dispatch!.model, node.dispatch!.source], [true, undefined, undefined])
    const view = monitorViewModel(payload)
    // 视图显式标注未记录/来源未知，不借用图卡的生效模型补值。
    assert.deepEqual([view.currentExecution!.actor!.modelText, view.currentExecution!.actor!.status], ['未记录 · 来源未知', '执行中'])
  } finally { h.cleanup() }
})

test('#274 当前执行卡：投影 → 视图模型（角色/模型来源/状态/终态位置）', async () => {
  const h = harness()
  try {
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const handler = handlerOf(h)
    const running = monitorViewModel((await handler('status', { cwd: 'ws' })).value)
    const card = running.currentExecution!
    assert.equal(card.heading, '当前节点')
    assert.equal(card.active, true)
    assert.deepEqual([card.nodeId, card.workflowLabel, card.visitText], ['plan', '主流程', ''])
    assert.deepEqual([card.phaseLabel, card.phaseClass, card.blocked], ['执行中', 'phase-working', false])
    assert.deepEqual([card.actor!.role, card.actor!.modelText, card.actor!.status], ['manager', 'mgr/m-manager · 首选', '执行中'])
    assert.deepEqual([card.judge!.modelText, card.judge!.status], [null, '未派发'])

    // 推进到 review：卡片跟随栈顶，judge 未派发；节点行带 executionId 供同名节点区分。
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    const row = (await h.store.get('ws'))!
    // plan 判定 ACCEPT → review 派发（messageId 递增为 actor-message-2）。
    const planJudge: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
    await judgeAccept(h, planJudge)
    const reviewRow = (await h.store.get('ws'))!
    assert.equal(reviewRow.execution.nodeId, 'review')
    assert.deepEqual(reviewRow.execution.dispatch!.model, { provider: 'prov', modelId: 'm-review' })
    const review = monitorViewModel((await handler('status', { cwd: 'ws' })).value)
    assert.equal(review.currentExecution!.nodeId, 'review')
    assert.deepEqual([review.currentExecution!.actor!.modelText, review.currentExecution!.actor!.status], ['prov/m-review · 首选', '执行中'])
    assert.equal(review.currentExecution!.judge!.status, '未派发')
    assert.ok(review.nodes.some(node => node.executionId === reviewRow.execution.executionId), '节点行携带 execution 身份')

    // 结束 Run：卡片改为结束位置，活动文案不再冒充正在执行。
    h.engine.handleReset('ws', 'manager')
    const terminated = monitorViewModel((await handler('status', { cwd: 'ws' })).value)
    assert.equal(terminated.currentExecution!.heading, '结束位置')
    assert.equal(terminated.currentExecution!.active, false)
    assert.equal(terminated.currentExecution!.terminalLabel, '已终止')
    assert.equal(terminated.currentExecution!.actor!.status, '已终止')
  } finally { h.cleanup() }
})

test('#274 status：长 handoff 只给有界预览，2 秒轮询 payload 不随历史长度增长', async () => {
  const h = harness()
  try {
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const handler = handlerOf(h)
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    const longHandoff = `结论开头\n${'证据行 '.repeat(80)}`
    await claim(h, manager, 'succeeded', longHandoff)
    const payload = (await handler('status', { cwd: 'ws' })).value as Extract<Awaited<ReturnType<typeof handlerOf>>, { mode: 'run' }>
    const projected = nodeOf(payload, 'plan').claim!.handoff
    assert.ok(projected.startsWith('结论开头'), '保留开头，便于卡片识别')
    assert.ok(projected.length < longHandoff.length, '长文本被截断，不是全量透传')
    assert.match(projected, /…（共 \d+ 字）$/, '截断标记说明原文长度，完整正文归状态库')
  } finally { h.cleanup() }
})
test('#274 R1 status：重派旧轮经 previousDispatch 投影，卡片「上一轮」不覆盖当前轮', async () => {
  const h = harness()
  try {
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    // 引擎在故障切换/换模 resume 覆盖当前派发前留档到 previousDispatch；这里按同一合同落一行。
    const before = (await h.store.get('ws'))!
    const current = structuredClone(before.execution)
    const previous = { ...current.dispatch!, id: 'dispatch-previous', messageId: 'actor-message-0', settled: true, model: { provider: 'backup', modelId: 'backup-model' }, source: 'fallback' as const }
    await h.store.updateRow('ws', before.run, before.stateVersion, [{ execution: { ...current, previousDispatch: previous }, expectedRevision: before.execution.revision, events: [] }])
    const payload = (await handlerOf(h)('status', { cwd: 'ws' })).value as Extract<Awaited<ReturnType<typeof handlerOf>>, { mode: 'run' }>
    const node = nodeOf(payload, 'plan')
    assert.deepEqual(node.previousDispatch, { id: 'dispatch-previous', dispatched: true, settled: true, model: { provider: 'backup', modelId: 'backup-model' }, source: 'fallback' })
    assert.deepEqual(node.dispatch!.model, current.dispatch!.model, '当前轮仍是自己的快照，未被旧轮替换')
    assert.deepEqual(node.dispatch!.source, current.dispatch!.source)
    const card = monitorViewModel(payload).currentExecution!
    assert.equal(card.actor!.previousText, '上一轮 backup/backup-model · 备选')
    assert.notEqual(card.actor!.previousText, card.actor!.modelText, '上一轮与当前轮分开呈现')
  } finally { h.cleanup() }
})

type RunPayload = Extract<Awaited<ReturnType<ReturnType<typeof handlerOf>>>, { mode: 'run' }>

test('#275 status：多轮提交/判定 history 按 claim 配对、事件时间与重派事实独立', async () => {
  const h = harness()
  try {
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const handler = handlerOf(h)
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'first attempt')
    let row = (await h.store.get('ws'))!
    const judge1: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
    await judgeReject(h, judge1, '缺少证据')

    // REJECT 后引擎自动重派：新一轮 Actor 派发已安排、尚未提交（待提交那一轮）。
    row = (await h.store.get('ws'))!
    const waiting = nodeOf((await handler('status', { cwd: 'ws' })).value as RunPayload, 'plan')
    assert.equal(waiting.history!.rounds.length, 1, '已提交的只有第一轮')
    assert.equal(waiting.history!.rounds[0].judgment!.result, 'REJECT')
    assert.equal(waiting.history!.pending!.id, row.execution.dispatch!.id, '待提交轮次来自新派发')
    assert.equal(waiting.history!.pending!.model!.modelId, 'm-manager', '待提交轮次带自己的实际模型')
    assert.equal(waiting.history!.pending!.source, 'primary')
    assert.deepEqual(waiting.history!.abandoned, [], '重派被提交前不算放弃')

    // 第二轮提交 + ACCEPT：两轮各自的事实都能取到。
    const manager2: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    await claim(h, manager2, 'succeeded', 'second attempt')
    row = (await h.store.get('ws'))!
    const judge2: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
    await judgeAccept(h, judge2)
    const judged = nodeOf((await handler('status', { cwd: 'ws' })).value as RunPayload, 'plan')
    const history = judged.history!
    assert.equal(history.rounds.length, 2)
    assert.deepEqual(history.rounds.map(round => round.result), ['succeeded', 'succeeded'])
    assert.notEqual(history.rounds[0].claimId, history.rounds[1].claimId, '每轮独立 claim')
    assert.deepEqual(history.rounds.map(round => round.judgment!.result), ['REJECT', 'ACCEPT'], '判定按 claimId 配对，不跨轮')
    assert.notEqual(history.rounds[0].actor!.id, history.rounds[1].actor!.id, '每轮自己的派发事实')
    assert.deepEqual([history.rounds[0].actor!.model!.modelId, history.rounds[1].actor!.model!.modelId], ['m-manager', 'm-manager'])
    assert.ok(Date.parse(history.rounds[1].submittedAt) >= Date.parse(history.rounds[0].submittedAt), '提交时间来自各自事件')
    assert.ok(Date.parse(history.rounds[0].judgment!.at) <= Date.parse(history.rounds[1].submittedAt), '第一轮判定时间早于第二轮提交')
    assert.equal(history.pending, undefined, '最新一轮已提交，不再待提交')
    assert.deepEqual(history.abandoned, [])
    assert.equal(judged.claim!.id, history.rounds[1].claimId, '当前 claim 与最新一轮一致')
    assert.equal(JSON.stringify(history).includes('endedAt'), false, '历史事实不带结束时间')

    // 回放确定性：重复读取与事件输入顺序都不影响 history。
    const executions = await h.store.runExecutionsByRunId(row.run.runId)
    const events = await h.store.runEventsByRunId(row.run.runId)
    const replayed = projectRunStatus(row, executions, undefined, undefined, [], [...events].reverse())
    assert.deepEqual(replayed.run!.nodes[0].history, history)
    assert.deepEqual(projectRunStatus(row, executions, undefined, undefined, [], events).run!.nodes[0].history, history)
  } finally { h.cleanup() }
})

test('#275 status：旧行无事件回放时 history 缺省，不回填当前配置', async () => {
  const h = harness()
  try {
    h.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    // 已提交但无事件回放（旧记录/旧宿主）：轮次事实不可还原，投影不虚构。
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'legacy artifact')
    // 不带 events 依赖 = 旧记录/旧宿主：多轮事实不可还原，投影不虚构。
    const legacyHandler = createMonitorRpcHandler({
      maintenance: () => undefined,
      resolveWorkspace: async cwd => cwd ?? 'ws',
      latest: async workspaceKey => h.store.get(workspaceKey),
      active: async () => h.store.activeRuns(),
      byRunId: async runId => h.store.getByRunId(runId),
      executions: async runId => h.store.runExecutionsByRunId(runId),
      layout: async () => undefined,
    })
    const node = nodeOf((await legacyHandler('status', { cwd: 'ws' })).value as RunPayload, 'plan')
    assert.equal(node.history, undefined, '无事件 → 无多轮历史（不伪造轮次/时间）')
    assert.ok(node.claim !== undefined, '旧行仍保留 #274 的当前 claim 事实')
    const view = monitorViewModel((await legacyHandler('status', { cwd: 'ws' })).value)
    const record = view.records.find(item => item.nodeId === 'plan')!
    assert.deepEqual([record.submittedAtText, record.judgedAtText], ['未记录', '待判定'], '无事件回放：提交时间不可还原显式未记录，不被当成待提交')
    assert.deepEqual([record.actorModelText, record.judgeModelText], ['mgr/m-manager · 首选', 'mgr/m-manager · 首选'], '模型取工作单派发快照，不拿当前配置补')
  } finally { h.cleanup() }
})
test('#275 status：换模角色只在事件能证明时给出（Judge 侧差分），其余留空不猜', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'artifact')
    const row = (await h.store.get('ws'))!
    const base = (await h.store.runExecutionsByRunId(row.run.runId))[0]!
    const at = (minute: number) => `2026-10-25T04:${String(minute).padStart(2, '0')}:00.000Z`
    const eventsOf = (snapshot: typeof base) => [
      { executionId: base.executionId, sequence: 1, type: 'claim' as const, at: at(0), snapshot: base },
      { executionId: base.executionId, sequence: 2, type: 'model-changed' as const, at: at(1), snapshot },
    ]
    const switchesOf = (snapshot: typeof base) => {
      const projection = projectRunStatus(row, [base], undefined, undefined, [], eventsOf(snapshot))
      return projection.run!.nodes[0]!.history!.switches
    }
    // Judge 侧模型差分：能证明是 Judge 换模。
    const judgeSwitched = { ...base, judge: { ...(base.judge!), model: { provider: 'prov', modelId: 'm-judge-x' } } }
    assert.deepEqual(switchesOf(judgeSwitched), [{ at: at(1), role: 'judge' }])
    // Actor 重新派发（id 变化）：能证明是 Actor 换模。
    const actorSwitched = { ...base, dispatch: { ...(base.dispatch!), id: 'd-new' } }
    assert.deepEqual(switchesOf(actorSwitched), [{ at: at(1), role: 'actor' }])
    // 快照无差分（人工换模只写 Run 行，事件里看不到新路由）：角色留空，不按当前配置猜。
    assert.deepEqual(switchesOf(base), [{ at: at(1), role: null }])
  } finally { h.cleanup() }
})
