// #251 客户端监控视图模型纯函数测试 + bundle 动态注入/scope.cwd 注册断言。
// 先例：test/editor-start-modal.test.ts（直接 import web-client 纯 JS + buildClientBundle）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClientBundle } from '../web-client/build.mjs'
import { monitorViewModel, monitorErrorState, monitorPollingContinues, monitorStatusPayload, monitorCallPath, monitorNodeState, initialFollowState, monitorFollowView, selectFlow, resumeFollow, PHASE_LABELS, monitorRecordsView, RECORD_COLUMNS, RECORD_PENDING, RECORD_JUDGE_PENDING, RECORD_NOT_APPLICABLE, RECORD_SCHEDULED, MODEL_MISSING } from '../web-client/src/monitor-view.js'

const STARTED_AT = '2026-10-25T04:00:00.000Z'

const RUN_PAYLOAD = {
  mode: 'run',
  run: {
    runId: 'r1', workflowId: 'test', status: 'running', blockReason: null,
    businessReturn: null, launchPrompt: '启动原文',
    roles: [{ role: 'reviewer', model: { provider: 'prov', modelId: 'm-review' } }],
    flows: {
      test: { startNode: 'plan', returns: ['done'], nodes: [
        { id: 'plan', kind: 'actor-task', role: 'manager', model: { provider: 'prov', modelId: 'm-plan' }, results: { succeeded: { criteria: 'The plan is complete.', target: { node: 'review' } } } },
        { id: 'review', kind: 'actor-task', role: 'reviewer', model: { provider: 'prov', modelId: 'm-review' } },
        { id: 'report', kind: 'builtin-program', programId: 'write-report' },
        { id: 'child', kind: 'child-workflow', childWorkflowId: 'sub', onReturn: { out: { return: 'done' } } },
      ] },
      sub: { startNode: 's1', returns: ['out'], nodes: [{ id: 's1', kind: 'actor-task', role: 'reviewer' }] },
    },
    layout: {
      version: 1,
      main: { plan: { x: 40, y: 40 }, review: { x: 260, y: 40 }, report: { x: 480, y: 40 }, child: { x: 700, y: 40 } },
      children: { sub: { s1: { x: 40, y: 40 } } },
    },
    nodes: [
      { workflowId: 'test', nodeId: 'plan', executionId: 'e1', visit: 1, revision: 3, phase: 'exited', blockReason: null, enteredAt: STARTED_AT, exitedAt: '2026-10-25T04:01:00.000Z', current: false },
      { workflowId: 'test', nodeId: 'review', executionId: 'e2', visit: 2, revision: 1, phase: 'working', blockReason: '等待授权', enteredAt: '2026-10-25T04:01:00.000Z', exitedAt: null, current: true },
      { workflowId: 'test', nodeId: 'report', executionId: 'e3', visit: 3, revision: 1, phase: 'checking', blockReason: '审查超时', enteredAt: '2026-10-25T04:02:00.000Z', exitedAt: null, current: false },
      { workflowId: 'test', nodeId: 'child', executionId: 'e4', visit: 4, revision: 1, phase: 'ready', blockReason: null, enteredAt: '2026-10-25T04:03:00.000Z', exitedAt: null, current: false },
    ],
    callStack: [{ workflowId: 'test', nodeId: 'review', executionId: 'e2' }],
  },
}

test('#251 monitorViewModel：run 投影（信息条/角色模型/节点行/焦点与 BLOCK）', () => {
  const view = monitorViewModel(RUN_PAYLOAD)
  assert.equal(view.mode, 'run')
  assert.equal(view.run.workflowId, 'test')
  assert.equal(view.run.runId, 'r1')
  assert.equal(view.run.statusLabel, '运行中')
  assert.equal(view.run.launchPrompt, '启动原文')
  assert.equal(view.run.startedAt, STARTED_AT)
  assert.equal(view.run.durationLabel, '已运行')
  assert.match(view.run.roles, /reviewer=m-review@prov/)
  // 每节点角色 + 生效模型 + 执行目标（program/child）从冻结图投影。
  assert.deepEqual(view.nodes.map(node => [node.label, node.phaseLabel, node.current, node.blocked, node.role, node.modelText, node.targetText]), [
    ['test / plan', PHASE_LABELS.exited[0], false, false, 'manager', 'prov/m-plan', null],
    ['test / review', PHASE_LABELS.working[0], true, true, 'reviewer', 'prov/m-review', null],
    ['test / report', PHASE_LABELS.checking[0], false, true, null, '', '程序 write-report'],
    ['test / child', PHASE_LABELS.ready[0], false, false, null, '', '子流程 sub'],
  ])
  assert.equal(view.nodes[1].blockReason, '等待授权')
  // F3：引擎 BLOCK 不改 phase，checking 相上的原因同样可见。
  assert.equal(view.nodes[2].blockReason, '审查超时')
})

test('#252 monitorViewModel：运行图模型（节点 decoration/布局/子流程/焦点流程）', () => {
  const graph = monitorViewModel(RUN_PAYLOAD).run.graph
  assert.equal(graph.currentFlowId, 'test')
  assert.deepEqual(graph.flows.map(flow => flow.id), ['test', 'sub'])
  const main = graph.flows[0]
  // 冻结布局坐标随图下发；节点定义保留结果端口/Child 映射。
  assert.deepEqual(main.positions.plan, { x: 40, y: 40 })
  assert.deepEqual(main.def.nodes.plan.results, { succeeded: { criteria: 'The plan is complete.', target: { node: 'review' } } })
  assert.deepEqual(main.def.nodes.child.onReturn, { out: { return: 'done' } })
  // 历史 visit 只装饰最新一次执行；phase + BLOCK 原因 + 焦点合成只读样式。
  assert.equal(main.decorations.plan.badge, PHASE_LABELS.exited[0])
  assert.equal(main.decorations.review.badge, 'BLOCK')
  assert.equal(main.decorations.review.className, 'wf-node-blocked')
  assert.equal(main.decorations.review.detail, '等待授权 · 第 2 次执行')
  assert.equal(main.decorations.review.redo, true)
  assert.equal(main.decorations.plan.redo, false)
  // 子流程单独成图，坐标来自 children 表，无执行时无装饰。
  const sub = graph.flows[1]
  assert.deepEqual(sub.positions.s1, { x: 40, y: 40 })
  assert.deepEqual(sub.decorations, {})
})

test('#262 图卡生效模型：主/子流程、未执行节点同一规则，Program/Child 不伪造', () => {
  const graph = monitorViewModel(RUN_PAYLOAD).run.graph
  const [main, sub] = graph.flows
  // 已执行与未执行节点都取冻结图的「当前生效模型」（不冒充历史实际调用模型）。
  assert.deepEqual(main.def.nodes.plan.execution, { type: 'actor-task', role: 'manager' })
  assert.equal(main.decorations.plan.summary, 'prov/m-plan')
  assert.equal(main.decorations.review.summary, 'prov/m-review')
  // Program/Child 只保留程序/子流程目标，不追加 Actor 模型。
  assert.equal(main.decorations.report?.summary, undefined)
  assert.equal(main.decorations.child?.summary, undefined)
  assert.deepEqual(main.def.nodes.report.execution, { type: 'builtin-program', programId: 'write-report' })
  assert.deepEqual(main.def.nodes.child.execution, { type: 'child-workflow', workflowId: 'sub' })
  // 子流程同一规则；actor 缺 model（旧 payload/harness）时不制造未知 provider，也不臆造状态徽标。
  assert.equal(sub.decorations.s1, undefined)

  const withSubModel = structuredClone(RUN_PAYLOAD)
  withSubModel.run.flows.sub.nodes[0].model = { provider: 'prov', modelId: 'm-sub' }
  const subDecor = monitorViewModel(withSubModel).run.graph.flows[1].decorations.s1
  assert.equal(subDecor.summary, 'prov/m-sub')
  assert.equal(subDecor.badge, undefined)

  // 服务端 override/fallback 的新 payload 到达即替换旧文本；客户端只呈现，不自行推导优先级。
  const overridden = structuredClone(RUN_PAYLOAD)
  overridden.run.flows.test.nodes[1].model = { provider: 'prov2', modelId: 'm-review-b', reasoningEffort: 'high' }
  assert.equal(monitorViewModel(overridden).run.graph.flows[0].decorations.review.summary, 'prov2/m-review-b')

  // provider/modelId 部分缺席：只渲染存在的段，不补假值。
  const partial = structuredClone(RUN_PAYLOAD)
  partial.run.flows.test.nodes[0].model = { modelId: 'm-only' }
  partial.run.flows.test.nodes[1].model = {}
  const partialMain = monitorViewModel(partial).run.graph.flows[0]
  assert.equal(partialMain.decorations.plan.summary, 'm-only')
  assert.equal(partialMain.decorations.review.summary, undefined)
})

test('#253 monitorCallPath：多层调用栈投影为可点击路径，递归同名流程按帧保留', () => {
  const payload = {
    ...RUN_PAYLOAD,
    run: {
      ...RUN_PAYLOAD.run,
      workflowId: 'root',
      flows: {
        root: { startNode: 'manager', returns: ['out'], nodes: [{ id: 'manager', kind: 'actor-task', role: 'manager' }, { id: 'call', kind: 'child-workflow', childWorkflowId: 'sub' }] },
        sub: { startNode: 'worker', returns: ['out'], nodes: [{ id: 'worker', kind: 'actor-task', role: 'worker' }, { id: 'call2', kind: 'child-workflow', childWorkflowId: 'sub' }] },
      },
      callStack: [
        { workflowId: 'root', nodeId: 'call', executionId: 'c1' },
        { workflowId: 'sub', nodeId: 'call2', executionId: 'c2' },
        { workflowId: 'sub', nodeId: 'worker', executionId: 'c3' },
      ],
    },
  }
  const path = monitorCallPath(payload.run)
  assert.deepEqual(path.frames.map(frame => frame.workflowId), ['root', 'sub', 'sub'])
  assert.deepEqual(path.frames.map(frame => frame.label), ['主流程', '子流程 sub', '子流程 sub'])
  assert.deepEqual(path.frames.map(frame => frame.nodeLabel), ['call', 'call2', 'worker（worker）'])
  assert.equal(path.currentWorkflowId, 'sub')
  assert.deepEqual(path.frames.map(frame => frame.executionId), ['c1', 'c2', 'c3'])
  // 空调用栈（终态/旧数据）回退到 run.workflowId 单帧。
  const fallback = monitorCallPath({ ...payload.run, callStack: [] })
  assert.deepEqual(fallback.frames, [])
  assert.equal(fallback.currentWorkflowId, 'root')
})

test('#253 自动跟随状态机：默认跟随当前流程，手动切换暂停并可恢复', () => {
  const initial = initialFollowState()
  assert.deepEqual(initial, { mode: 'following', manualFlowId: null })
  assert.deepEqual(monitorFollowView(initial, 'sub'), { mode: 'following', activeFlowId: 'sub', showReturn: false })
  const paused = selectFlow(initial, 'root', 'sub')
  assert.deepEqual(paused, { mode: 'paused', manualFlowId: 'root' })
  assert.deepEqual(monitorFollowView(paused, 'sub'), { mode: 'paused', activeFlowId: 'root', showReturn: true })
  // 手动停留的流程再次成为当前流程：跟随当前，不再显示返回入口。
  assert.deepEqual(monitorFollowView(paused, 'root'), { mode: 'paused', activeFlowId: 'root', showReturn: false })
  // 点选当前流程 = 恢复跟随；恢复后继续跟随新当前流程。
  assert.deepEqual(selectFlow(paused, 'root', 'root'), initial)
  assert.deepEqual(monitorFollowView(resumeFollow(), 'grand'), { mode: 'following', activeFlowId: 'grand', showReturn: false })
})

test('#253 重做 visit：第二次及以上标记 redo 并展示「第 N 次执行」', () => {
  const first = monitorNodeState({ workflowId: 'test', nodeId: 'plan', executionId: 'e1', visit: 1, revision: 1, phase: 'exited', blockReason: null, enteredAt: STARTED_AT, exitedAt: null, current: false })
  assert.equal(first.redo, false)
  assert.equal(first.detail, '')
  const redo = monitorNodeState({ workflowId: 'test', nodeId: 'review', executionId: 'e2', visit: 3, revision: 1, phase: 'working', blockReason: null, enteredAt: STARTED_AT, exitedAt: null, current: true })
  assert.equal(redo.redo, true)
  assert.equal(redo.detail, '第 3 次执行')
  assert.equal(redo.className, 'wf-node-current')
  assert.equal(redo.phaseClass, 'phase-working')
})

test('#254 monitorViewModel：活跃 Run 切换器（#263 已删除 recent 摘要链）', () => {
  const refA = { runId: 'r1', workspaceKey: 'D:/ws/alpha', workflowId: 'test', status: 'running' }
  const refB = { runId: 'r2', workspaceKey: 'D:\\ws\\beta', workflowId: 'other', status: 'blocked' }
  const view = monitorViewModel({ ...RUN_PAYLOAD, runs: [refA, refB] })
  assert.equal(view.mode, 'run')
  assert.equal(view.polling, true)
  assert.deepEqual(view.runs.map(ref => [ref.runId, ref.label, ref.statusLabel]), [
    ['r1', 'alpha · test', '运行中'],
    ['r2', 'beta · other', '已阻塞'],
  ])
  // #263：selected/workspaceKey/workspaceLabel 没有消费者（选中态由组件受控），视图不再输出；recent 摘要整链已删。
  for (const ref of view.runs) {
    assert.deepEqual(Object.keys(ref).sort(), ['label', 'runId', 'status', 'statusLabel', 'workflowId'])
  }
  assert.equal('recent' in view, false)
  // 当前 Run 不在活跃清单时补一项，避免切换器值悬空（选中态仍由组件决定）。
  const picked = monitorViewModel({ ...RUN_PAYLOAD, runs: [refB] })
  assert.deepEqual(picked.runs.map(ref => ref.runId), ['r2', 'r1'])
  assert.equal('recent' in picked, false)
})

test('#254 monitorViewModel：终态 Run 停止轮询并展示终态图', () => {
  const done = monitorViewModel({ ...RUN_PAYLOAD, runs: [], run: { ...RUN_PAYLOAD.run, status: 'completed' } })
  assert.equal(done.mode, 'terminal')
  assert.equal(done.polling, false)
  // #261：终态文案明确「停止自动轮询 + 可手动刷新」，与只读刷新入口一致。
  assert.match(done.terminalNote, /停止自动轮询/)
  assert.match(done.terminalNote, /刷新状态/)
  assert.equal(done.run.graph.flows.length, 2)
  // #254：终态 Run 不在活跃清单，作为当前 Run 补进切换器选项（#263：不再有 recent 字段）。
  assert.deepEqual(done.runs.map(ref => [ref.runId, ref.statusLabel]), [['r1', '已完成']])
})

test('#261 monitorPollingContinues：只有终态 Run 停周期，空态/维护态/活跃 Run 继续', () => {
  assert.equal(monitorPollingContinues(undefined), true)
  assert.equal(monitorPollingContinues({ mode: 'empty', runs: [] }), true)
  assert.equal(monitorPollingContinues({ mode: 'maintenance', maintenance: { kind: 'corrupt', reason: 'x' } }), true)
  assert.equal(monitorPollingContinues({ mode: 'run', run: { runId: 'r1', status: 'running' } }), true)
  assert.equal(monitorPollingContinues({ mode: 'run', run: { runId: 'r1', status: 'blocked' } }), true)
  assert.equal(monitorPollingContinues({ mode: 'run', run: { runId: 'r1', status: 'completed' } }), false)
  assert.equal(monitorPollingContinues({ mode: 'run', run: { runId: 'r1', status: 'terminated' } }), false)
  // 视图模型的 polling 与该判定同源（不出现两套规则）。
  const blocked = monitorViewModel({ ...RUN_PAYLOAD, run: { ...RUN_PAYLOAD.run, status: 'blocked' } })
  assert.equal(blocked.polling, true)
})

test('#254 monitorViewModel：空态三形态（无 Run 引导 / 维护态 / 加载中）', () => {
  const empty = monitorViewModel({ mode: 'empty', runs: [] })
  assert.equal(empty.mode, 'empty')
  // R1 F2：空态继续轮询（外部启动新 Run 后自动出现）。
  assert.equal(empty.polling, true)
  assert.match(empty.guidance, /dsh-flow start/)
  assert.deepEqual(empty.runs, [])
  assert.equal('recent' in empty, false)
  const maintenance = monitorViewModel({ mode: 'maintenance', maintenance: { kind: 'incompatible', reason: '版本不兼容' }, runs: [] })
  assert.equal(maintenance.mode, 'maintenance')
  // #261：维护态继续探测，运维恢复状态库后自动回到正常视图（此前完全停请求，只能重挂载自愈）。
  assert.equal(maintenance.polling, true)
  assert.match(maintenance.reason, /版本不兼容/)
  assert.equal(monitorViewModel(undefined).mode, 'loading')
})

test('#254 monitorStatusPayload：切换器 runId 随 cwd 上行，空串/非字符串不上行', () => {
  assert.deepEqual(monitorStatusPayload({ cwd: 'D:/ws' }, 'r2'), { cwd: 'D:/ws', runId: 'r2' })
  assert.deepEqual(monitorStatusPayload(undefined, 'r2'), { runId: 'r2' })
  assert.deepEqual(monitorStatusPayload({ cwd: 'D:/ws' }, ''), { cwd: 'D:/ws' })
  assert.deepEqual(monitorStatusPayload({ cwd: 'D:/ws' }, 42), { cwd: 'D:/ws' })
})

test('#251 monitorViewModel：empty / maintenance / 加载中 / blocked 状态', () => {
  assert.equal(monitorViewModel(undefined).mode, 'loading')
  assert.equal(monitorViewModel({ mode: 'empty' }).mode, 'empty')
  const maintenance = monitorViewModel({ mode: 'maintenance', maintenance: { kind: 'corrupt', reason: '库损坏' } })
  assert.equal(maintenance.mode, 'maintenance')
  assert.equal(maintenance.reason, '库损坏')
  const blocked = monitorViewModel({ ...RUN_PAYLOAD, run: { ...RUN_PAYLOAD.run, status: 'blocked', blockReason: '等用户' } })
  assert.equal(blocked.run.statusLabel, '已阻塞')
  assert.equal(blocked.run.statusClass, 'run-blocked')
  assert.equal(blocked.run.blockReason, '等用户')
  const done = monitorViewModel({ ...RUN_PAYLOAD, run: { ...RUN_PAYLOAD.run, status: 'completed', businessReturn: { name: 'done', source: 'e2' } } })
  assert.equal(done.run.businessReturn, 'done')
})

test('#251 monitorViewModel：开始时间/时长（终态用最后退出时刻，运行中用 now）', () => {
  const start = Date.parse(STARTED_AT)
  const running = monitorViewModel(RUN_PAYLOAD, { now: start + 5 * 60_000 + 30_000 })
  assert.equal(running.run.durationText, '5分30秒')
  assert.equal(running.run.durationLabel, '已运行')
  assert.match(running.run.startedAtText, /2026/)

  const completedPayload = {
    ...RUN_PAYLOAD,
    run: { ...RUN_PAYLOAD.run, status: 'completed', nodes: [
      ...RUN_PAYLOAD.run.nodes.slice(0, 1),
      { workflowId: 'test', nodeId: 'review', executionId: 'e2', visit: 2, revision: 1, phase: 'exited', blockReason: null, enteredAt: '2026-10-25T04:01:00.000Z', exitedAt: '2026-10-25T05:00:00.000Z', current: false },
    ] },
  }
  const done = monitorViewModel(completedPayload, { now: start + 99 * 3600_000 })
  assert.equal(done.run.durationText, '1小时0分')
  assert.equal(done.run.durationLabel, '总耗时')
  // 时间字段不可解析时只丢时长/本地时间文案，不伪造数据。
  const unparsed = monitorViewModel({ ...RUN_PAYLOAD, run: { ...RUN_PAYLOAD.run, nodes: [{ ...RUN_PAYLOAD.run.nodes[0], enteredAt: 't1' }] } })
  assert.equal(unparsed.run.startedAt, 't1')
  assert.equal(unparsed.run.startedAtText, null)
  assert.equal(unparsed.run.durationText, null)
})

test('#251 monitorViewModel：RPC 失败横幅在所有模式可见（F5）', () => {
  for (const payload of [undefined, { mode: 'empty' }, { mode: 'maintenance', maintenance: { kind: 'corrupt', reason: '库损坏' } }, RUN_PAYLOAD]) {
    const view = monitorViewModel(payload, { banner: '网络断开' })
    assert.equal(view.banner, '网络断开')
  }
  assert.equal(monitorViewModel(undefined, { banner: '' }).banner, '')
})

test('#251 monitorStatusPayload：tab scope.cwd 上行，缺席/空串不上行（F4）', () => {
  assert.deepEqual(monitorStatusPayload({ sessionId: 's1', cwd: 'D:/ws' }), { cwd: 'D:/ws' })
  assert.deepEqual(monitorStatusPayload({ cwd: '' }), {})
  assert.deepEqual(monitorStatusPayload({}), {})
  assert.deepEqual(monitorStatusPayload(undefined), {})
  assert.deepEqual(monitorStatusPayload({ cwd: 42 }), {})
})

test('#251 monitorErrorState：横幅保留语义（新错误覆盖，空错误保留旧值）', () => {
  assert.equal(monitorErrorState('', '网络断开'), '网络断开')
  assert.equal(monitorErrorState('旧错误', ''), '旧错误')
  assert.equal(monitorErrorState('旧错误', '新错误'), '新错误')
})

test('#251 client bundle：动态注入注册 better-sidebar tab（不写静态 inject 导出）', async () => {
  const outFile = buildClientBundle()
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(outFile, 'utf8')
  // 动态注入：等待 betterSidebar 服务后注册监控 tab；静态 inject 数组不含该服务。
  assert.match(bundle, /inject\(\['betterSidebar'\]/)
  assert.match(bundle, /dsh-workflow:monitor/)
  assert.match(bundle, /workflow-run-monitor/)
  assert.match(bundle, /registerTab/)
  // AC3 实证：better-sidebar 0.28 只认单 descriptor，title/component 必填（旧双参写法 tab 不出现）。
  assert.match(bundle, /title: '工作流监控'/)
  assert.match(bundle, /description: '运行状态、节点进度与子流程下钻'/)
  assert.match(bundle, /component: \(props\) => WorkflowMonitorTab/)
  // scope.cwd 经 monitorStatusPayload 上行，服务端不再猜 process.cwd。
  assert.match(bundle, /monitorStatusPayload/)
  // #253 下钻/跟随的纯函数必须进入 __monitorView 模块表，否则运行时 "is not a function"。
  assert.match(bundle, /monitorFollowView, selectFlow, resumeFollow/)
  assert.match(bundle, /scope\?\.cwd/)
  // #253 AC3 实证：__rpc 模块表必须导出 callChannel（漏导出时监控请求全失败）。
  assert.match(bundle, /return \{ EDITOR_RPC_CHANNEL, callChannel, callEditor/)
  // 保留编辑器通道静态注册（未装 better-sidebar 时配置编辑器照常）。
  assert.match(bundle, /PANEL_KEY/)
  // #252 画布复用：NodeCanvas 与编辑器样式打进同一个 bundle（监控不重复实现画布）。
  assert.match(bundle, /__graphCanvas/)
  assert.match(bundle, /function NodeCanvas/)
  assert.match(bundle, /wf-node-blocked/)
  // #253 子流程下钻：调用栈路径 + 跟随状态机 + 回到当前节点入口打进 bundle。
  assert.match(bundle, /monitorCallPath/)
  assert.match(bundle, /monitorFollowView/)
  assert.match(bundle, /selectFlow/)
  assert.match(bundle, /回到当前节点/)
  assert.match(bundle, /wf-node-redo/)
  // #254 切换器/空态：Run 切换选项、终态停轮询文案、空态引导打进 bundle。
  assert.match(bundle, /当前目录（默认）/)
  assert.match(bundle, /该 Run 已结束/)
  assert.match(bundle, /dsh-flow start/)
  assert.match(bundle, /fetchStatus = \(scope, runId\)/)
  // #261 刷新恢复与目录隔离：统一停轮询判定、只读刷新入口、可见性监听、上下文键隔离打进 bundle。
  assert.match(bundle, /monitorPollingContinues/)
  assert.doesNotMatch(bundle, /payload\?\.mode !== 'maintenance' && payload\?\.run\?\.terminal !== true/)
  assert.match(bundle, /刷新状态/)
  assert.match(bundle, /正在刷新/)
  assert.match(bundle, /visibilitychange/)
  assert.match(bundle, /pollContextKey/)
  assert.match(bundle, /useMonitorPolling\(\s*runId => fetchStatus\(runId\)/)
  // #262 图卡生效模型：装饰文本接在现有类型摘要行后，完整值走 title（行高/几何不变）。
  assert.match(bundle, /decoration\?\.summary/)
  assert.match(bundle, /className: 'wf-node-type', title: typeText/)
  // #263：recent 摘要链（视图输出 + 空态渲染）与画布 displayPoint 等价别名已删，不留在产物里。
  assert.doesNotMatch(bundle, /recent/)
  assert.doesNotMatch(bundle, /displayPoint/)
  assert.match(bundle, /point\(/)
  // 宿主 client bundle 不做 JSX 转译：产物必须是可直接解析的纯 JS（#252 发现 #251 JSX 隐患）。
  assert.doesNotThrow(() => new Function(bundle), 'bundle 必须是可解析的纯 JS')
})

// #274 当前执行卡：只读派发/claim/判定快照；缺事实显式未记录，终态不冒充活动执行。
test('#274 currentExecutionView：Actor/Judge 模型·来源·状态 + 节点/流程/visit/BLOCK', () => {
  const payload = structuredClone(RUN_PAYLOAD)
  Object.assign(payload.run.nodes[1], {
    dispatch: { id: 'd2', dispatched: true, settled: false, model: { provider: 'prov', modelId: 'm-review' }, source: 'fallback' },
    claim: { id: 'c2', result: 'succeeded', handoff: 'review artifact' },
    judge: { id: 'j2', claimId: 'c2', dispatched: true, settled: false, model: { provider: 'prov', modelId: 'm-judge' }, source: 'primary' },
  })
  const view = monitorViewModel(payload)
  const card = view.currentExecution
  assert.deepEqual([card.heading, card.active, card.nodeId, card.workflowLabel, card.visitText], ['当前节点', true, 'review', '主流程', '第 2 次'])
  assert.deepEqual([card.phaseLabel, card.blocked, card.blockReason], [PHASE_LABELS.working[0], true, '等待授权'])
  // AC-03：模型按「模型 · 来源」显示，来源来自派发快照（fallback → 备选）。
  assert.deepEqual([card.actor.role, card.actor.modelText, card.actor.status], ['reviewer', 'prov/m-review · 备选', '已提交结果'])
  // claim 已提交 → Judge 已安排：判定前显示待判定，不提前写结论。
  assert.deepEqual([card.judge.modelText, card.judge.status], ['prov/m-judge · 首选', '待判定'])
  assert.equal(card.executionId, 'e2')
  assert.equal(view.nodes[1].executionId, 'e2', '节点行携带 execution 身份，同名节点可分')
  // 判定结果只写判定记录本身。
  payload.run.nodes[1].judge.judgment = 'REJECT'
  assert.equal(monitorViewModel(payload).currentExecution.judge.status, '已判定：REJECT')
})

test('#274 currentExecutionView：派发/判定相边界与缺事实文案（未记录/来源未知/未派发/等待收口）', () => {
  const payload = structuredClone(RUN_PAYLOAD)
  const review = payload.run.nodes[1]
  // 只有派发、无模型/来源记录：显式未记录，不按当前配置补值。
  review.dispatch = { id: 'd2', dispatched: true, settled: false }
  let card = monitorViewModel(payload).currentExecution
  assert.deepEqual([card.actor.modelText, card.actor.status], ['未记录 · 来源未知', '执行中'])
  assert.deepEqual([card.judge.modelText, card.judge.status], [null, '未派发'])
  // 已安排未确认：dispatch 存在但 messageId 尚未回填。
  review.dispatch = { id: 'd2', dispatched: false, settled: false }
  assert.equal(monitorViewModel(payload).currentExecution.actor.status, '已安排派发未确认')
  // claim 已提交而 Judge 未安排、Actor 未收口 → 等待 Actor 收口。
  review.dispatch = { id: 'd2', dispatched: true, settled: false }
  review.claim = { id: 'c2', result: 'succeeded', handoff: 'h' }
  assert.equal(monitorViewModel(payload).currentExecution.judge.status, '等待 Actor 收口')
  // Actor 已收口但 Judge 未安排 → 待派发。
  review.dispatch = { id: 'd2', dispatched: true, settled: true }
  assert.equal(monitorViewModel(payload).currentExecution.judge.status, '待派发')
  // Judge 已安排未确认。
  review.judge = { id: 'j2', claimId: 'c2', dispatched: false, settled: false }
  assert.equal(monitorViewModel(payload).currentExecution.judge.status, '已安排派发未确认')
})

test('#274 currentExecutionView：Program/Child/子流程卡与终态结束位置', () => {
  // Program 节点为当前：不伪造 Actor/Judge 行，目标明确，BLOCK 原因可见。
  const program = structuredClone(RUN_PAYLOAD)
  program.run.nodes[2].current = true
  program.run.nodes[1].current = false
  const programCard = monitorViewModel(program).currentExecution
  assert.deepEqual([programCard.nodeId, programCard.targetText], ['report', '程序 write-report'])
  assert.deepEqual([programCard.actor, programCard.judge], [null, null])
  assert.equal(programCard.blocked, true)
  // 子流程工作单：流程标注为子流程，不误标主流程。
  const child = structuredClone(RUN_PAYLOAD)
  child.run.nodes.push({ workflowId: 'sub', nodeId: 's1', executionId: 'e5', visit: 1, revision: 1, phase: 'working', blockReason: null, enteredAt: STARTED_AT, exitedAt: null, current: true })
  child.run.nodes[1].current = false
  const childCard = monitorViewModel(child).currentExecution
  assert.deepEqual([childCard.nodeId, childCard.workflowLabel, childCard.actor.role], ['s1', '子流程 sub', 'reviewer'])
  // 终态：图下卡改为结束位置，活动文案换成 Run 终态标签（不冒充正在执行）。
  const terminated = structuredClone(RUN_PAYLOAD)
  terminated.run.status = 'terminated'
  terminated.run.terminal = true
  terminated.run.nodes[1].dispatch = { id: 'd2', dispatched: true, settled: false }
  const endCard = monitorViewModel(terminated).currentExecution
  assert.deepEqual([endCard.heading, endCard.active, endCard.terminalLabel], ['结束位置', false, '已终止'])
  assert.equal(endCard.actor.status, '已终止', '停在 working 相的旧状态不冒充正在执行')
  // 从未派发的节点仍如实显示未派发（不属活动文案）。
  terminated.run.nodes[1].dispatch = undefined
  assert.equal(monitorViewModel(terminated).currentExecution.actor.status, '未派发')
})
// #275 执行记录表：每次进入一行、列序固定、多轮提交/判定下钻按 claim 配对。
test('#275 monitorRecordsView：列序/一行一次进入/多轮模型与时间/缺失值口径', () => {
  const payload = structuredClone(RUN_PAYLOAD)
  payload.run.status = 'completed'
  payload.run.terminal = true
  payload.run.nodes = [
    {
      workflowId: 'test', nodeId: 'plan', executionId: 'e1', visit: 1, revision: 5, phase: 'exited', blockReason: null,
      enteredAt: '2026-10-25T04:00:00.000Z', exitedAt: '2026-10-25T04:10:00.000Z', current: false,
      dispatch: { id: 'd2', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-plan-b' }, source: 'fallback' },
      claim: { id: 'c2', result: 'succeeded', handoff: 'h' },
      judge: { id: 'j2', claimId: 'c2', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-judge-b' }, source: 'fallback', judgment: 'ACCEPT' },
      history: {
        rounds: [
          {
            claimId: 'c1', result: 'succeeded', submittedAt: '2026-10-25T04:02:00.000Z',
            actor: { id: 'd1', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-plan-a' }, source: 'primary' },
            judgment: { result: 'REJECT', at: '2026-10-25T04:03:00.000Z', judge: { id: 'j1', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-judge-a' }, source: 'primary' } },
          },
          {
            claimId: 'c2', result: 'succeeded', submittedAt: '2026-10-25T04:05:00.000Z',
            actor: { id: 'd2', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-plan-b' }, source: 'fallback' },
            judgment: { result: 'ACCEPT', at: '2026-10-25T04:06:00.000Z', judge: { id: 'j2', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-judge-b' }, source: 'fallback' } },
          },
        ],
        abandoned: [{ at: '2026-10-25T04:01:30.000Z', dispatch: { id: 'd0', dispatched: true, settled: true, model: { provider: 'prov', modelId: 'm-plan-fail' }, source: 'primary' } }],
        switches: [{ at: '2026-10-25T04:04:00.000Z', role: 'actor' }, { at: '2026-10-25T04:04:30.000Z', role: null }],
      },
    },
    {
      workflowId: 'test', nodeId: 'review', executionId: 'e2', visit: 2, revision: 1, phase: 'working', blockReason: null,
      enteredAt: '2026-10-25T04:05:30.000Z', exitedAt: null, current: true,
      // 已安排但派发尚未确认：live dispatch 保留派发意图与路由快照。
      dispatch: { id: 'd3', dispatched: false, settled: false, model: { provider: 'prov', modelId: 'm-review' }, source: 'manual' },
      history: {
        rounds: [],
        pending: { id: 'd3', dispatched: false, settled: false, model: { provider: 'prov', modelId: 'm-review' }, source: 'manual' },
        abandoned: [], switches: [],
      },
    },
    {
      workflowId: 'sub', nodeId: 's1', executionId: 'e4', visit: 1, revision: 1, phase: 'checking', blockReason: null,
      enteredAt: '2026-10-25T04:06:00.000Z', exitedAt: null, current: false,
      dispatch: { id: 'd9', dispatched: true, settled: false, model: { provider: 'prov', modelId: 'm-sub' }, source: 'primary' },
      claim: { id: 'c9', result: 'succeeded', handoff: 'h' },
      judge: { id: 'j9', claimId: 'c9', dispatched: true, settled: false, model: { provider: 'prov', modelId: 'm-judge9' }, source: 'manual' },
    },
  ]
  const records = monitorRecordsView(payload.run, { now: Date.parse('2026-10-25T04:07:00.000Z'), terminal: true })
  assert.deepEqual(RECORD_COLUMNS, ['节点名称', '所属流程', '运行情况', '进入时间', '提交结果时间', '提交判定时间', 'Actor 模型', 'Judge 模型'], '列序固定：所属流程靠左、时间在模型之前')
  assert.equal(records.length, 3, '一行 = 一次进入（子流程节点单独成行）')
  const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false })
  const [plan, review, sub] = records
  assert.deepEqual([plan.nodeLabel, plan.flowText, plan.current], ['plan（manager）', '主流程', false])
  assert.deepEqual([plan.outcomeText, plan.roundCountText, plan.roundCountText], ['已结束', '共 2 轮', '共 2 轮'])
  // 主行取最新一轮的时间/模型；第二轮是备选模型，第一轮的事实留在下钻里。
  assert.deepEqual([plan.submittedAtText, plan.judgedAtText], [time('2026-10-25T04:05:00.000Z'), time('2026-10-25T04:06:00.000Z')])
  assert.deepEqual([plan.actorModelText, plan.judgeModelText], ['prov/m-plan-b · 备选', 'prov/m-judge-b · 备选'])
  assert.deepEqual(plan.drilldown.rounds.map(round => [round.index, round.resultText, round.statusText]), [
    [1, '提交「succeeded」', '判定不通过'],
    [2, '提交「succeeded」', '判定通过'],
  ])
  assert.deepEqual(plan.drilldown.rounds.map(round => [round.actorModelText, round.judgeModelText]), [
    ['prov/m-plan-a · 首选', 'prov/m-judge-a · 首选'],
    ['prov/m-plan-b · 备选', 'prov/m-judge-b · 备选'],
  ], '每轮模型来自该轮派发快照，不跨轮借值')
  assert.deepEqual(plan.drilldown.abandoned.map(item => [item.reasonText, item.modelText]), [['未形成提交', 'prov/m-plan-fail · 首选']])
  assert.deepEqual(plan.drilldown.switches.map(item => item.roleText), ['Actor 换模', '换模'], '角色证明不了时只报换模，不猜')
  assert.equal(JSON.stringify(plan.drilldown).includes('endedAt'), false, '历史事实不带结束时间')
  // 待提交那一轮：已安排未确认 + 自己的实际模型，不把上一轮判定时间当成新轮提交时间。
  assert.deepEqual([review.outcomeText, review.submittedAtText, review.judgedAtText], [RECORD_SCHEDULED, RECORD_PENDING, RECORD_NOT_APPLICABLE])
  assert.equal(review.actorModelText, 'prov/m-review · 人工指定')
  assert.deepEqual(review.drilldown.pending.statusText, RECORD_SCHEDULED)
  // 旧记录（无事件回放）：时间未记录，模型只取工作单派发快照。
  assert.deepEqual([sub.outcomeText, sub.submittedAtText, sub.judgedAtText], ['待判定', MODEL_MISSING, RECORD_JUDGE_PENDING])
  assert.deepEqual([sub.actorModelText, sub.judgeModelText], ['prov/m-sub · 首选', 'prov/m-judge9 · 人工指定'])
  // 视图模型统一出口：run/terminal 模式带 records，且与纯函数一致。
  assert.deepEqual(monitorViewModel(payload, { now: Date.parse('2026-10-25T04:07:00.000Z') }).records, monitorRecordsView(payload.run, { now: Date.parse('2026-10-25T04:07:00.000Z'), terminal: true }))
})

test('#275 monitorRecordsView：自环/回边新进入各自成行，等待时长按读取时刻派生', () => {
  const payload = structuredClone(RUN_PAYLOAD)
  payload.run.nodes = [
    {
      workflowId: 'test', nodeId: 'plan', executionId: 'e1', visit: 1, revision: 9, phase: 'exited', blockReason: null,
      enteredAt: '2026-10-25T04:00:00.000Z', exitedAt: '2026-10-25T04:04:00.000Z', current: false,
      history: { rounds: [{ claimId: 'c1', result: 'succeeded', submittedAt: '2026-10-25T04:01:00.000Z', judgment: { result: 'REJECT', at: '2026-10-25T04:02:00.000Z' } }], abandoned: [], switches: [] },
    },
    {
      workflowId: 'test', nodeId: 'plan', executionId: 'e2', visit: 2, revision: 2, phase: 'working', blockReason: null,
      enteredAt: '2026-10-25T04:03:00.000Z', exitedAt: null, current: true,
      history: { rounds: [{ claimId: 'c2', result: 'succeeded', submittedAt: '2026-10-25T04:04:00.000Z' }], abandoned: [], switches: [] },
    },
  ]
  const records = monitorRecordsView(payload.run, { now: Date.parse('2026-10-25T04:06:10.000Z') })
  assert.deepEqual(records.map(record => [record.key, record.visitText]), [['test/plan#1', ''], ['test/plan#2', '第 2 次']], '同节点两次进入 → 两行，不合并')
  assert.notEqual(records[0].key, records[1].key)
  // 等待时长只在读取时按 claim 时间派生（130s），不宣称判定失败；不显示结束时间。
  assert.equal(records[1].waitingText, '已判定等待 2分10秒')
  assert.equal(records[0].waitingText, null, '已判定/已结束的行不显示等待')
  // 终态读取不再派生等待时长。
  assert.equal(monitorRecordsView(payload.run, { now: Date.parse('2026-10-25T05:00:00.000Z'), terminal: true })[1].waitingText, null)
})
