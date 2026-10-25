// #251 客户端监控视图模型纯函数测试 + bundle 动态注入/scope.cwd 注册断言。
// 先例：test/editor-start-modal.test.ts（直接 import web-client 纯 JS + buildClientBundle）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClientBundle } from '../web-client/build.mjs'
import { monitorViewModel, monitorErrorState, monitorStatusPayload, monitorCallPath, monitorNodeState, initialFollowState, monitorFollowView, selectFlow, resumeFollow, PHASE_LABELS } from '../web-client/src/monitor-view.js'

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
  // 宿主 client bundle 不做 JSX 转译：产物必须是可直接解析的纯 JS（#252 发现 #251 JSX 隐患）。
  assert.doesNotThrow(() => new Function(bundle), 'bundle 必须是可解析的纯 JS')
})
