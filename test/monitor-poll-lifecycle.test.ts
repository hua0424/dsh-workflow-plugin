// #261 运行监控刷新恢复与目录隔离：受控生命周期测试。
//
// 为什么要这层 seam：本票的行为都落在 React Hook 的生命周期里（维护态是否继续探测、
// 切目录后旧响应是否被丢弃、重新可见是否只读一次、终态是否能手动刷新出新 Run），
// 纯视图函数测试看不到。这里执行 **真实 bundle**（buildClientBundle 产物：
// 真 WorkflowMonitorTab + 真 useMonitorPolling + 真 callChannel），只把宿主侧换成受控替身：
//   - mini-React：useState/useEffect/useRef/createElement（按 React 语义：deps 变化才跑
//     effect、cleanup 先于新 effect、setState 异步重渲染）；
//   - 假时钟：2s 周期与 15s RPC 超时可精确推进；
//   - 假 document：切换 visibilityState 并派发 visibilitychange；
//   - connection.rpc.call：委派真实 createMonitorRpcHandler + 真 StateStore（临时目录，
//     绝不触碰真实 ~/.dsh），可挂起（hold）响应以复现「旧目录迟到的终态响应」。
//
// 断言只看外部行为：发出的 RPC 载荷、面板文案、周期请求数、监听器数量；
// 不读 Hook 内部变量，也不复制轮询算法（与 test/monitor-rpc.test.ts 的分工：
// 那边验服务端投影，这里验客户端生命周期）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimCaller, WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { createMonitorRpcHandler } from '../src/monitor/rpc.ts'
import { buildClientBundle } from '../web-client/build.mjs'

// ---------------------------------------------------------------------------
// 受控宿主：假 document / 假时钟 / mini-React
// ---------------------------------------------------------------------------

/** bundle 只加载一次（模块级）：它在加载时就捕获 document/setTimeout，故用可重置的共享替身。 */
let bundleFactory: ((require: (id: string) => unknown) => any) | null = null

const documentState = { visibilityState: 'visible', listeners: new Map<string, Set<() => void>>() }

const fakeDocument = {
  get visibilityState() { return documentState.visibilityState },
  addEventListener(type: string, fn: () => void) {
    if (!documentState.listeners.has(type)) documentState.listeners.set(type, new Set())
    documentState.listeners.get(type)!.add(fn)
  },
  removeEventListener(type: string, fn: () => void) {
    documentState.listeners.get(type)?.delete(fn)
  },
}

function resetDocument(): void {
  documentState.visibilityState = 'visible'
  documentState.listeners.clear()
}

function setVisibility(state: 'visible' | 'hidden'): void {
  documentState.visibilityState = state
  for (const fn of [...(documentState.listeners.get('visibilitychange') ?? [])]) fn()
}

function listenerCount(type: string): number {
  return documentState.listeners.get(type)?.size ?? 0
}

/** 每次测试推进自己的时钟；bundle 里捕获的 setTimeout 转发到「当前」时钟。 */
let activeClock: ReturnType<typeof createClock> | null = null

function createClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const api = {
    get now() { return now },
    pending: () => timers.size,
    setTimeout(fn: () => void, ms = 0) {
      const id = ++seq
      timers.set(id, { at: now + Number(ms), fn })
      return id
    },
    clearTimeout(id: unknown) { timers.delete(Number(id)) },
    /** 推进假时间：按到期顺序逐个执行到期定时器，每次之后让微任务链落定。 */
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined
        for (const entry of timers) {
          if (entry[1].at > target) continue
          if (due === undefined || entry[1].at < due[1].at) due = entry
        }
        if (due === undefined) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
        await settle()
      }
      now = target
      await settle()
    },
  }
  return api
}

/** 让挂起的 Promise/微任务链与随后的重渲染全部落定。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

function textOf(node: any): string {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || node.props === undefined) return ''
  if (node.type === 'style' || node.type === 'script') return '' // 样式表不算面板文案
  return textOf(node.props.children)
}

function collect(node: any, predicate: (element: any) => boolean, out: any[] = []): any[] {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out)
    return out
  }
  if (node === null || typeof node !== 'object' || node.props === undefined) return out
  if (predicate(node)) out.push(node)
  collect(node.props.children, predicate, out)
  return out
}

function monitorModule(react: unknown): any {
  if (bundleFactory === null) {
    const loaded: any[] = []
    const fakeWindow = { __ModuleLoader__: { load: (entry: any) => loaded.push(entry) } }
    const setTimeoutForBundle = (fn: () => void, ms?: number) => (activeClock === null ? 0 : activeClock.setTimeout(fn, ms))
    const clearTimeoutForBundle = (id: unknown) => { if (activeClock !== null) activeClock.clearTimeout(id) }
    new Function('window', 'document', 'setTimeout', 'clearTimeout', readFileSync(buildClientBundle(), 'utf8'))(
      fakeWindow,
      fakeDocument,
      setTimeoutForBundle,
      clearTimeoutForBundle,
    )
    assert.equal(loaded.length, 1, 'bundle 必须只注册一个宿主模块')
    bundleFactory = loaded[0].factory
  }
  return bundleFactory!(() => react)
}

/**
 * 挂载真实 WorkflowMonitorTab：hooks 由 mini-React 驱动，每挂载一份模块实例
 * （bundle 的 react 依赖在 factory(require) 时注入）。
 */
function mountMonitor(options: { call: (...args: any[]) => any; props: any }) {
  const slots: any[] = []
  let index = 0
  let tree: any = null
  let props = options.props
  let scheduled = false
  let unmounted = false

  const depsChanged = (deps?: unknown[], previous?: unknown[]): boolean => {
    if (deps === undefined || previous === undefined) return true
    if (deps.length !== previous.length) return true
    return deps.some((value, i) => !Object.is(value, previous[i]))
  }
  const schedule = () => {
    if (scheduled || unmounted) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; render() })
  }
  const setSlotState = (slot: any, next: unknown) => {
    const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next
    if (Object.is(value, slot.value)) return
    slot.value = value
    schedule()
  }

  const react = {
    createElement: (type: unknown, elementProps: any, ...children: any[]) => ({ type, props: { ...(elementProps ?? {}), children } }),
    useState(initial: unknown) {
      const at = index++
      if (slots[at] === undefined) slots[at] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      return [slots[at].value, (next: unknown) => setSlotState(slots[at], next)]
    },
    useRef(initial: unknown) {
      const at = index++
      if (slots[at] === undefined) slots[at] = { kind: 'ref', current: initial }
      return slots[at]
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const at = index++
      if (slots[at] === undefined) slots[at] = { kind: 'effect', fn, deps, previous: undefined, cleanup: undefined }
      else { slots[at].fn = fn; slots[at].deps = deps }
    },
  }

  const bundleModule = monitorModule(react)
  let tab: any = null
  bundleModule.apply({
    connection: { rpc: { call: options.call } },
    slots: {
      inject: (_name: string, callback: () => unknown) => { callback(); return { dispose() {} } },
      register: () => ({ dispose() {} }),
    },
    layout: {},
    remote: {},
    inject: (_deps: string[], callback: (ctx: any) => void) => {
      callback({ betterSidebar: { registerTab: (descriptor: any) => { tab = descriptor } } })
    },
  })
  assert.ok(tab !== null, 'better-sidebar tab 必须注册')

  const Component = tab.component
  const render = () => {
    if (unmounted) return
    index = 0
    tree = Component(props)
    // 与 React 一致：deps 变化才跑 effect，且先 cleanup 再执行；顺序即 hook 调用顺序。
    for (const slot of slots) {
      if (slot?.kind !== 'effect' || !depsChanged(slot.deps, slot.previous)) continue
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = slot.fn()
      slot.previous = slot.deps
    }
  }
  render()

  return {
    get tree() { return tree },
    text: () => textOf(tree),
    find: (predicate: (element: any) => boolean) => collect(tree, predicate)[0] ?? null,
    select: () => collect(tree, element => element.type === 'select')[0] ?? null,
    refreshButton: () => collect(tree, element => element.type === 'button' && element.props.className === 'wf-monitor-refresh')[0] ?? null,
    setProps(next: any) { props = { ...props, ...next }; render() },
    unmount() {
      if (unmounted) return
      unmounted = true
      for (const slot of slots) {
        if (slot?.kind === 'effect' && typeof slot.cleanup === 'function') { slot.cleanup(); slot.cleanup = undefined }
      }
    },
  }
}

/**
 * RPC 桥：记录载荷、可挂起响应（复现迟到的旧响应）、可注入失败信封。
 * #270：`release(predicate, result)` 的单次结果覆盖——只让「这一个挂起的旧请求」以
 * 指定信封（典型是唯一可识别的错误）结束，不搭建通用故障注入框架。
 */
function createBridge(handler: (endpoint: string, payload: any) => Promise<any>) {
  const calls: Array<{ endpoint: string; payload: any }> = []
  const held: Array<{ payload: any; resolve: (result?: unknown) => void }> = []
  let holdPredicate: ((payload: any) => boolean) | null = null
  let failure: any = null
  const call = (_channel: string, endpoint: string, payload: any) => {
    calls.push({ endpoint, payload })
    if (failure !== null) return Promise.resolve(failure)
    if (holdPredicate !== null && holdPredicate(payload)) {
      return new Promise(resolve => {
        held.push({ payload, resolve: (result?: unknown) => { resolve(result !== undefined ? result : handler(endpoint, payload)) } })
      })
    }
    return Promise.resolve(handler(endpoint, payload))
  }
  return {
    calls,
    held,
    call,
    hold(predicate: (payload: any) => boolean) { holdPredicate = predicate },
    release(predicate: (payload: any) => boolean, result?: unknown) {
      const picked = held.filter(entry => predicate(entry.payload))
      for (const entry of picked) {
        held.splice(held.indexOf(entry), 1)
        entry.resolve(result)
      }
      activeClock?.clearTimeout // 保持引用避免未使用告警
      return picked.length
    },
    setFailure(value: any) { failure = value },
  }
}

// ---------------------------------------------------------------------------
// 真实后端：Stub 派发 engine + 临时 SQLite + 真实 status RPC（同 monitor-rpc.test.ts）
// ---------------------------------------------------------------------------

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

// #270 AC-06/AC-07：含子流程的配置。根流程当前节点在 plan，子流程 sub 可经 tab 下钻，
// 用于验证「手动流程选择」只在实际返回的 Run 变化 / cwd 变化时重置。
const childConfig: WorkflowConfig = {
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

function createWorld() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-261-lifecycle-'))
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
  const clock = createClock()
  activeClock = clock
  resetDocument()

  let maintenance: any = undefined
  let stateReads = 0
  // #270 AC-05：依赖 seam——让某个 Run 既查无也不在活跃清单（不动真实历史数据）。
  const hiddenRuns = new Set<string>()
  const handler = createMonitorRpcHandler({
    maintenance: () => maintenance,
    resolveWorkspace: async (cwd?: string) => { stateReads += 1; return typeof cwd === 'string' && cwd !== '' ? cwd : 'ws' },
    latest: async workspaceKey => { stateReads += 1; return store.get(workspaceKey) },
    active: async () => { stateReads += 1; return (await store.activeRuns()).filter(row => !hiddenRuns.has(row.run.runId)) },
    byRunId: async runId => { stateReads += 1; return hiddenRuns.has(runId) ? undefined : store.getByRunId(runId) },
    executions: async runId => { stateReads += 1; return store.runExecutionsByRunId(runId) },
    // #275 执行记录表：事件回放事实随投影一起读（只读）。
    events: async runId => { stateReads += 1; return store.runEventsByRunId(runId) },
    layout: async () => undefined,
  })
  const bridge = createBridge((endpoint, payload) => handler(endpoint, payload))

  const claim = async (workspaceKey: string, caller: ClaimCaller, result: string, handoff: string) => {
    assert.equal((await engine.handleClaim(workspaceKey, { result, handoff }, caller)).ok, true)
    await engine.handleTurnEnded(workspaceKey, caller)
  }
  const judgeAccept = async (workspaceKey: string, caller: ClaimCaller) => {
    const row = (await store.get(workspaceKey))!
    assert.equal((await engine.handleJudgeClaim(workspaceKey, row.execution.nodeToken, 'ACCEPT', 'verified', caller)).ok, true)
    await engine.handleTurnEnded(workspaceKey, caller)
  }

  return {
    store,
    engine,
    clock,
    bridge,
    get stateReads() { return stateReads },
    get documentListeners() { return listenerCount('visibilitychange') },
    setMaintenance(value: any) { maintenance = value },
    setVisibility,
    /** #270 AC-05：让 Run 查无且不在活跃清单（依赖 seam，非删除）。 */
    hideRun(runId: string) { hiddenRuns.add(runId) },
    /** 起一个活跃 Run（stub 派发，真状态库），返回 runId。 */
    async startRun(workspaceKey: string, label = 'run', definition: WorkflowConfig = config): Promise<string> {
      assert.equal((await engine.startRun(workspaceKey, engine.buildInitialRun('manager', 'test', definition, 'hash'), undefined, label)).ok, true)
      return (await store.get(workspaceKey))!.run.runId
    },
    /** 把该 workspace 的 Run 推进到 completed（终态）。 */
    async completeRun(workspaceKey: string): Promise<string> {
      assert.equal((await engine.startRun(workspaceKey, engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '终态')).ok, true)
      let row = (await store.get(workspaceKey))!
      await claim(workspaceKey, { sessionId: 'manager', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }, 'succeeded', 'plan artifact')
      row = (await store.get(workspaceKey))!
      await judgeAccept(workspaceKey, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
      row = (await store.get(workspaceKey))!
      await claim(workspaceKey, { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }, 'succeeded', 'review artifact')
      row = (await store.get(workspaceKey))!
      await judgeAccept(workspaceKey, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
      row = (await store.get(workspaceKey))!
      assert.equal(row.run.status, 'completed')
      return row.run.runId
    },
    mount(scope: any, visible = true) {
      return mountMonitor({ call: bridge.call, props: { scope, visible } })
    },
    tick: (ms = 2000) => clock.advance(ms),
    cleanup() {
      activeClock = null
      resetDocument()
      store.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 验收：票面 10 项断言的外部行为
// ---------------------------------------------------------------------------

test('#261 维护态：继续按周期探测，状态库恢复后自愈（不重挂载）', async () => {
  const w = createWorld()
  try {
    await w.startRun('ws-a', 'A')
    w.setMaintenance({ kind: 'incompatible', reason: '状态库升级中' })
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), /状态库维护模式/)
    assert.match(ui.text(), /状态库升级中/)
    assert.ok(ui.refreshButton() !== null, '维护态也提供只读刷新入口')
    assert.equal(w.bridge.calls.length, 1)
    assert.equal(w.stateReads, 0, '维护态短路，不触碰状态库')

    // I-3 旧行为：维护态返回后不再排下一轮 → 永远停在维护视图。
    await w.tick(2000)
    await w.tick(2000)
    assert.equal(w.bridge.calls.length, 3, '维护态按可见性继续探测')
    assert.equal(w.stateReads, 0)

    // 运维恢复状态库：下一轮自动回到运行视图，无需重挂载。
    w.setMaintenance(undefined)
    await w.tick(2000)
    assert.match(ui.text(), /运行中/)
    assert.doesNotMatch(ui.text(), /状态库维护模式/)
    assert.ok(w.stateReads > 0, '维护解除后恢复正常读取')
  } finally { w.cleanup() }
})

test('#282 顶部两行摘要 + 运行详情默认收起：信息不减，纵向占用减少', async () => {
  const w = createWorld()
  try {
    const runId = await w.completeRun('ws-a')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    const text = ui.text()
    assert.match(text, /已完成/)
    assert.match(text, /返回：/, '业务返回值仍在摘要首行')
    assert.match(text, /自动刷新已停止/, '终态提示保留')
    assert.match(text, /总耗时/, '总耗时可读')
    // 摘要固定两行：首行状态/业务返回/终态提示，次行工作流名 + 耗时。
    const summary = ui.find((element: any) => element.props.className === 'wf-monitor-summary')
    assert.ok(summary !== null, '存在两行摘要容器')
    const rows = collect(summary, (element: any) => element.props.className?.startsWith?.('wf-monitor-summary-row'))
    assert.equal(rows.length, 2, '摘要只占两行')
    assert.match(textOf(rows[0]), /已完成/)
    assert.match(textOf(rows[0]), /自动刷新已停止/, '终态提示与状态同排，不再独占一段')
    assert.match(textOf(rows[1]), /总耗时/)
    // 运行详情：原生 details 默认收起，完整 Run ID / 开始时间 / 角色配置（非实际派发）都在里面。
    const details = ui.find((element: any) => element.type === 'details')
    assert.ok(details !== null, '运行详情使用原生 details')
    assert.notEqual(details!.props.open, true, '默认收起')
    const detailText = textOf(details)
    assert.match(detailText, /运行详情/)
    assert.match(detailText, new RegExp(`Run：${runId}`))
    assert.match(detailText, /开始：/)
    assert.match(detailText, /运行角色配置（非实际派发）：/)
    // 刷新入口仍在标题区工具栏里（终态才发现新 Run 的唯一入口），与 Run 选择同排。
    const toolbar = ui.find((element: any) => element.props.className === 'wf-monitor-toolbar')
    assert.ok(toolbar !== null, '工具栏存在')
    assert.equal(collect(toolbar, (element: any) => element.props.className === 'wf-monitor-refresh').length, 1)
  } finally { w.cleanup() }
})

test('#261 目录切换：旧目录的终态不再挡住新目录的 Run（同根问题）', async () => {
  const w = createWorld()
  try {
    await w.completeRun('ws-a')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), /自动刷新已停止/)
    const terminalCalls = w.bridge.calls.length
    await w.tick(6000)
    assert.equal(w.bridge.calls.length, terminalCalls, '终态停周期')

    const bRunId = await w.startRun('ws-b', 'B')
    ui.setProps({ scope: { cwd: 'ws-b' } })
    // 切换当次渲染就读不到旧目录数据（不等 effect 事后擦除）。
    assert.match(ui.text(), /正在加载运行状态/)
    assert.doesNotMatch(ui.text(), /自动刷新已停止/)
    assert.ok(ui.refreshButton() !== null, '加载态也提供只读刷新入口')
    await settle()
    assert.match(ui.text(), new RegExp(bRunId))
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-b')

    const before = w.bridge.calls.length
    await w.tick(2000)
    assert.equal(w.bridge.calls.length, before + 1, '新目录重建 2s 周期')
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-b')
  } finally { w.cleanup() }
})

test('#261 旧目录迟到的终态响应：不得覆盖新目录数据，也不得停掉新目录刷新（I-5）', async () => {
  const w = createWorld()
  try {
    await w.completeRun('ws-a')
    const bRunId = await w.startRun('ws-b', 'B')
    w.bridge.hold(payload => payload.cwd === 'ws-a')
    const ui = w.mount({ cwd: 'ws-a' })
    assert.equal(w.bridge.held.length, 1, 'A 的首个响应被挂起')

    ui.setProps({ scope: { cwd: 'ws-b' } })
    await settle()
    assert.match(ui.text(), new RegExp(bRunId))
    assert.equal(w.bridge.held.length, 1, 'B 的请求不被挂起')

    // A 的终态响应现在才回来：属于已失效上下文，丢弃。
    assert.equal(w.bridge.release(payload => payload.cwd === 'ws-a'), 1)
    await settle()
    assert.match(ui.text(), new RegExp(bRunId), '不被旧目录响应覆盖')
    assert.doesNotMatch(ui.text(), /自动刷新已停止/, '旧终态响应不得停掉新目录刷新')

    const before = w.bridge.calls.length
    await w.tick(2000)
    assert.ok(w.bridge.calls.length > before, '新目录周期仍在继续')
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-b')
  } finally { w.cleanup() }
})

test('#261 可见性：文档隐藏不发请求，恢复可见只读一次；tab 隐藏/恢复同理且监听器随生命周期', async () => {
  const w = createWorld()
  try {
    await w.startRun('ws-a')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.equal(w.bridge.calls.length, 1)
    assert.equal(w.documentListeners, 1, '挂载注册一个 visibilitychange 监听')

    setVisibility('hidden')
    await settle()
    assert.equal(w.bridge.calls.length, 1, '隐藏时的事件不触发读取')
    await w.tick(4000)
    assert.equal(w.bridge.calls.length, 1, '隐藏期间不发新请求')

    // 同步重复的可见事件合并成一次读取（不叠加）。
    setVisibility('visible')
    setVisibility('visible')
    await settle()
    assert.equal(w.bridge.calls.length, 2, '恢复可见只读一次')

    // tab 不可见：停止周期（enabled=false）；恢复可见立即读一次。
    const before = w.bridge.calls.length
    ui.setProps({ visible: false })
    await settle()
    await w.tick(4000)
    assert.equal(w.bridge.calls.length, before, 'tab 不可见不发请求')
    assert.equal(w.documentListeners, 0, '停用期间摘掉监听')
    ui.setProps({ visible: true })
    await settle()
    assert.equal(w.bridge.calls.length, before + 1, 'tab 重新可见读取一次')
    assert.equal(w.documentListeners, 1)

    ui.unmount()
    assert.equal(w.documentListeners, 0, '卸载清理监听器')
  } finally { w.cleanup() }
})

test('#261 终态手动刷新：只读、在途合并、能发现同目录新 Run 并恢复周期', async () => {
  const w = createWorld()
  try {
    await w.completeRun('ws-a')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), /自动刷新已停止/)
    assert.match(ui.text(), /刷新状态/)
    const terminalCalls = w.bridge.calls.length

    // 终态后同目录起新 Run：不自动发现（Out of Scope：不引入无操作自动发现）。
    const newRunId = await w.startRun('ws-a', 'second')
    await w.tick(6000)
    assert.equal(w.bridge.calls.length, terminalCalls, '终态不排周期')

    const button = ui.refreshButton()
    assert.ok(button !== null)
    assert.equal(button!.props.disabled, false)
    assert.match(String(button!.props.title), /只读/)

    // 挂起刷新响应，观察在途期间的按钮反馈与重复点击合并。
    w.bridge.hold(() => true)
    button!.props.onClick({})
    await settle()
    assert.equal(w.bridge.calls.length, terminalCalls + 1, '手动刷新只发一次请求')
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-a')
    const busyButton = ui.refreshButton()
    assert.equal(busyButton!.props.disabled, true, '在途刷新禁用重复触发')
    assert.match(ui.text(), /正在刷新/)
    busyButton!.props.onClick({})
    await settle()
    assert.equal(w.bridge.calls.length, terminalCalls + 1, '在途重复刷新合并')

    assert.equal(w.bridge.release(() => true), 1)
    await settle()
    assert.match(ui.text(), new RegExp(newRunId), '刷新发现同目录新 Run')
    assert.match(ui.text(), /运行中/)

    // 刷新返回活跃 Run → 周期恢复（维护/空态/活跃同理，终态仍不排）。
    const before = w.bridge.calls.length
    await w.tick(2000)
    assert.ok(w.bridge.calls.length > before, '刷新后恢复自动周期')
  } finally { w.cleanup() }
})

test('#261 显式选定 Run：跨 workspace 选择在轮询/刷新间保持，cwd 变化回到当前目录默认', async () => {
  const w = createWorld()
  try {
    const aRunId = await w.startRun('ws-a', 'A')
    const bRunId = await w.startRun('ws-b', 'B')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), new RegExp(aRunId))
    assert.equal(ui.select()!.props.value, '')

    // 跨 workspace 选定 B：载荷带 cwd（tab scope）+ 显式 runId。
    ui.select()!.props.onChange({ target: { value: bRunId } })
    await settle()
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-a')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId)
    assert.match(ui.text(), new RegExp(bRunId))

    // 周期轮询与只读刷新都保持显式选择。
    await w.tick(2000)
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId, '轮询保持显式选择')
    ui.refreshButton()!.props.onClick({})
    await settle()
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId, '刷新保持显式选择')

    // cwd 变化 → 回到「当前目录（默认）」，旧选择不跨目录复用。
    ui.setProps({ scope: { cwd: 'ws-b' } })
    await settle()
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-b')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, undefined, 'cwd 变化清掉旧选择')
    assert.equal(ui.select()!.props.value, '')
    assert.match(ui.text(), new RegExp(bRunId))
  } finally { w.cleanup() }
})

test('#261 空态：继续轮询发现新 Run；失败横幅保留同上下文数据并在恢复后清除', async () => {
  const w = createWorld()
  try {
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), /dsh-flow start/)
    assert.ok(ui.refreshButton() !== null, '空态也提供只读刷新入口')

    w.bridge.setFailure({ ok: false, error: { code: 'monitor/busy', message: '状态库忙' } })
    await w.tick(2000)
    assert.match(ui.text(), /状态刷新失败/)
    assert.match(ui.text(), /状态库忙/)

    // 恢复 + 新 Run：空态自愈并清横幅。
    w.bridge.setFailure(null)
    const runId = await w.startRun('ws-a')
    await w.tick(2000)
    assert.doesNotMatch(ui.text(), /状态刷新失败/)
    assert.match(ui.text(), new RegExp(runId))

    // 有数据时再失败：保留同上下文最后成功数据，只加横幅。
    w.bridge.setFailure({ ok: false, error: { code: 'monitor/busy', message: '又忙了' } })
    await w.tick(2000)
    assert.match(ui.text(), /又忙了/)
    assert.match(ui.text(), new RegExp(runId), '失败保留上一次成功数据')
  } finally { w.cleanup() }
})

// ---------------------------------------------------------------------------
// #270 回归契约：同一 cwd 内的旧响应/旧终态/旧选择隔离，流程跟随的重置边界
// ---------------------------------------------------------------------------

function flowTabs(ui: any): any[] {
  return collect(ui.tree, (element: any) => element.type === 'button' && element.props.role === 'tab')
}

function tabOf(ui: any, label: string): any {
  const tab = flowTabs(ui).find(candidate => textOf(candidate) === label)
  assert.ok(tab !== undefined, `流程 tab「${label}」必须存在`)
  return tab
}

function returnEntry(ui: any): any {
  return collect(ui.tree, (element: any) => element.type === 'button' && element.props.className === 'wf-monitor-return')[0] ?? null
}

/** 切换器全部选项值（第一个恒为「当前目录（默认）」的空串）。 */
function optionValues(ui: any): string[] {
  return ui.select()!.props.children.map((option: any) => option.props.value)
}

/**
 * AC-01/AC-02/AC-04 共用现场：同一 cwd 的终态 A → 显式选定 A → 起新 B
 * → 一次只读刷新（响应仍是显式 A，但选项里已有 B）。
 */
async function staleTerminalSetup() {
  const w = createWorld()
  const aRunId = await w.completeRun('ws-a')
  const ui = w.mount({ cwd: 'ws-a' })
  await settle()
  assert.deepEqual(optionValues(ui), ['', aRunId], '终态 A 补位成真实选项')
  ui.select()!.props.onChange({ target: { value: aRunId } })
  await settle()
  assert.equal(ui.select()!.props.value, aRunId, '显式选定旧终态 A')

  const bRunId = await w.startRun('ws-a', 'B')
  ui.refreshButton()!.props.onClick({})
  await settle()
  assert.deepEqual(optionValues(ui), ['', bRunId, aRunId], '刷新后 B 进入选项，选中项仍是 A')
  return { w, ui, aRunId, bRunId }
}

test('#270 AC-01 同 cwd 迟到的旧 Run 响应不覆盖新 Run，且刷新周期以 B 成功为唯一起点', async () => {
  const { w, ui, aRunId, bRunId } = await staleTerminalSetup()
  try {
    // 挂起携带 A runId 的手动刷新（真实 handler 会返回 A 的终态）。
    w.bridge.hold(payload => payload.runId === aRunId)
    ui.refreshButton()!.props.onClick({})
    await settle()
    assert.equal(w.bridge.held.length, 1, 'A 的刷新响应被挂起')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, aRunId)

    // 切换器选 B：请求由 A runId 切为 B runId，B 成功显示。
    ui.select()!.props.onChange({ target: { value: bRunId } })
    await settle()
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-a', 'cwd 全程不变')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId)
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))
    assert.equal(w.bridge.held.length, 1, 'B 的请求不被挂起')

    // 释放 A：属于已失效上下文，丢弃。
    assert.equal(w.bridge.release(payload => payload.runId === aRunId), 1)
    await settle()
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`), 'A 响应不覆盖 B')
    assert.doesNotMatch(ui.text(), /自动刷新已停止/, 'A 的终态不改变 B 的刷新状态')

    // 周期以 B 成功为起点：1999ms 无请求，再 1ms 恰好一笔，下一轮仍只一笔。
    const afterB = w.bridge.calls.length
    await w.tick(1999)
    assert.equal(w.bridge.calls.length, afterB, '1999ms 内无新增请求')
    await w.tick(1)
    assert.equal(w.bridge.calls.length, afterB + 1, '满 2000ms 恰好一笔')
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-a')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId)
    await w.tick(2000)
    assert.equal(w.bridge.calls.length, afterB + 2, '下一轮仍仅一笔（不叠加第二个周期）')
  } finally { w.cleanup() }
})

test('#270 AC-02 同 cwd 迟到的旧 Run 错误信封不产生横幅、不改变新 Run 状态', async () => {
  const { w, ui, aRunId, bRunId } = await staleTerminalSetup()
  try {
    w.bridge.hold(payload => payload.runId === aRunId)
    ui.refreshButton()!.props.onClick({})
    await settle()
    assert.equal(w.bridge.held.length, 1)

    ui.select()!.props.onChange({ target: { value: bRunId } })
    await settle()
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))

    // 唯一可识别的错误信封只交付那个挂起的 A 请求。
    const staleError = { ok: false, error: { code: 'monitor/stale-a', message: '旧 Run 迟到的读取失败' } }
    assert.equal(w.bridge.release(payload => payload.runId === aRunId, staleError), 1)
    await settle()
    assert.doesNotMatch(ui.text(), /状态刷新失败/, '旧实体的迟到错误不产生横幅')
    assert.doesNotMatch(ui.text(), /旧 Run 迟到的读取失败/)
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`), 'B 的数据与状态不受影响')
    assert.match(ui.text(), /运行中/)

    // 同 AC-01 的 1999ms/1ms 边界：迟到的旧错误不额外排程；B 的周期仍是唯一一笔。
    const before = w.bridge.calls.length
    await w.tick(1999)
    assert.equal(w.bridge.calls.length, before, '1999ms 内无新增请求')
    await w.tick(1)
    assert.equal(w.bridge.calls.length, before + 1, '满 2000ms 恰好一笔 B 请求')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId)
  } finally { w.cleanup() }
})

test('#270 AC-03 卸载时丢弃在途响应：监听器/定时器归零，之后不再发请求', async () => {
  const w = createWorld()
  try {
    await w.startRun('ws-a')
    w.bridge.hold(() => true)
    const ui = w.mount({ cwd: 'ws-a' })
    assert.equal(w.bridge.held.length, 1, '首轮请求在途')
    assert.equal(w.documentListeners, 1)
    assert.equal(w.clock.pending(), 1, '在途请求持有 15s RPC 超时定时器')

    ui.unmount()
    assert.equal(w.documentListeners, 0, '卸载后监听器立即为零')

    const before = w.bridge.calls.length
    await w.tick(1000) // 仍在 15s 超时之前
    assert.equal(w.bridge.calls.length, before)

    assert.equal(w.bridge.release(() => true), 1)
    await settle()
    assert.equal(w.clock.pending(), 0, '卸载后释放并落定：无残留定时器')

    await w.tick(20000) // 越过 15s 超时窗口
    assert.ok(w.clock.now >= 20000, '假时钟已越过 15s 超时窗口')
    assert.equal(w.bridge.calls.length, before, '卸载后不再有新 status 请求')
    assert.equal(w.documentListeners, 0, '不重新注册监听器')
  } finally { w.cleanup() }
})

test('#270 AC-04 显式旧终态保持：刷新仍读 A、显示 A，B 只作为选项出现且不恢复周期', async () => {
  const { w, ui, aRunId, bRunId } = await staleTerminalSetup()
  try {
    // 最近一次刷新就是「显示旧终态 A 时点刷新」：请求携带 A runId。
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, aRunId, '刷新仍携带旧终态 A 的 runId')
    assert.equal(ui.select()!.props.value, aRunId, '选择器 value 仍为 A')
    assert.match(ui.text(), new RegExp(`Run：${aRunId}`), 'Run 信息区仍显示 A')
    assert.doesNotMatch(ui.text(), new RegExp(`Run：${bRunId}`))
    // B 确实在选项里（不靠断言「整棵文本不含 B」）。
    assert.deepEqual(optionValues(ui), ['', bRunId, aRunId])
    assert.match(ui.text(), /自动刷新已停止/, '仍是终态上下文')

    const before = w.bridge.calls.length
    await w.tick(6000)
    assert.equal(w.bridge.calls.length, before, '终态上下文不因 B 存在而恢复周期')
    assert.equal(ui.select()!.props.value, aRunId)
  } finally { w.cleanup() }
})

test('#270 AC-05 显式 Run 在 loading/维护态保持，失效后回退默认并清掉选择', async () => {
  const w = createWorld()
  try {
    const aRunId = await w.startRun('ws-a', 'A')
    const bRunId = await w.startRun('ws-b', 'B')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), new RegExp(`Run：${aRunId}`))

    // 挂起首轮响应制造 loading：选择不被重置、不额外发默认选择请求。
    w.bridge.hold(payload => payload.runId === bRunId)
    const beforeSelect = w.bridge.calls.length
    // 选的是「有效 B」：B 必须真实出现在切换器选项里，否则后续断言不能区分真选择与直接注入。
    assert.ok(optionValues(ui).includes(bRunId), 'B 已在切换器选项中')
    ui.select()!.props.onChange({ target: { value: bRunId } })
    await settle()
    assert.match(ui.text(), /正在加载运行状态/)
    assert.equal(w.bridge.calls.length, beforeSelect + 1, 'loading 不额外发出默认选择请求')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId)
    assert.equal(w.bridge.release(payload => payload.runId === bRunId), 1)
    w.bridge.hold(() => false) // 只挂起这一次首轮响应
    await settle()
    assert.equal(ui.select()!.props.value, bRunId, '显式选择保持')
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))

    // 维护态：保留选择、按周期继续读，不落回默认。
    w.setMaintenance({ kind: 'incompatible', reason: '状态库升级中' })
    let beforeTick = w.bridge.calls.length
    await w.tick(2000)
    assert.equal(w.bridge.calls.length, beforeTick + 1)
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId, '维护态不额外发默认选择请求')
    assert.match(ui.text(), /状态库维护模式/)

    // 恢复后仍请求并显示 B。
    w.setMaintenance(undefined)
    beforeTick = w.bridge.calls.length
    await w.tick(2000)
    assert.equal(w.bridge.calls.length, beforeTick + 1)
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, bRunId)
    assert.equal(ui.select()!.props.value, bRunId)
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))

    // 依赖 seam 让 B 查无且不在活跃清单：真实 handler 回退 cwd 默认 A。
    w.hideRun(bRunId)
    beforeTick = w.bridge.calls.length
    await w.tick(2000)
    await settle()
    const afterFallback = w.bridge.calls.slice(beforeTick)
    assert.ok(afterFallback.some(call => call.payload.runId === bRunId), '先发出仍带 B runId 的请求')
    assert.ok(afterFallback.some(call => call.payload.runId === undefined), '清掉选择后确实发出不带 runId 的默认请求')
    assert.equal(ui.select()!.props.value, '', '选择器回到「当前目录（默认）」')
    assert.match(ui.text(), new RegExp(`Run：${aRunId}`), '回退显示 cwd 默认 A')
  } finally { w.cleanup() }
})

test('#270 AC-06 实际返回的 Run 变化才重置手动流程跟随', async () => {
  const w = createWorld()
  try {
    const aRunId = await w.startRun('ws-a', 'A', childConfig)
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.equal(flowTabs(ui).length, 2, '根流程 + 子流程两个 tab')
    tabOf(ui, '子流程 sub').props.onClick({})
    await settle()
    assert.equal(tabOf(ui, '子流程 sub').props['aria-selected'], true)
    assert.ok(returnEntry(ui) !== null, '手动下钻后出现「回到当前节点」')

    // 同一 Run 的普通刷新：不重置跟随。
    ui.refreshButton()!.props.onClick({})
    await settle()
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, undefined)
    assert.equal(tabOf(ui, '子流程 sub').props['aria-selected'], true, '同一 Run 刷新不重置跟随')
    assert.ok(returnEntry(ui) !== null)

    // 结束 A、同 cwd 起 B：默认请求返回 B → 跟随重置为 B 的当前流程。
    assert.equal((await w.engine.handleReset('ws-a', true)).ok, true)
    const bRunId = await w.startRun('ws-a', 'B', childConfig)
    assert.notEqual(bRunId, aRunId)
    const before = w.bridge.calls.length
    ui.refreshButton()!.props.onClick({})
    await settle()
    assert.equal(w.bridge.calls.length, before + 1)
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, undefined, '默认请求（无显式 runId）返回新 Run')
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))
    assert.equal(tabOf(ui, '主流程').props['aria-selected'], true, '跟随重置回当前流程')
    assert.equal(tabOf(ui, '子流程 sub').props['aria-selected'], false, '手动子流程不再选中（B 同名子流程确实存在）')
    assert.equal(returnEntry(ui), null, '重置后不再显示「回到当前节点」')
  } finally { w.cleanup() }
})

test('#270 AC-07 cwd 变化重置手动流程跟随（同名子流程不沿用旧选择）', async () => {
  const w = createWorld()
  try {
    await w.startRun('ws-a', 'A', childConfig)
    const bRunId = await w.startRun('ws-b', 'B', childConfig)
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    tabOf(ui, '子流程 sub').props.onClick({})
    await settle()
    assert.ok(returnEntry(ui) !== null)

    ui.setProps({ scope: { cwd: 'ws-b' } })
    await settle()
    assert.equal(w.bridge.calls.at(-1)!.payload.cwd, 'ws-b')
    assert.equal(w.bridge.calls.at(-1)!.payload.runId, undefined, 'cwd 变化不携带旧目录的选择/流程')
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))
    assert.equal(tabOf(ui, '主流程').props['aria-selected'], true, '跟随 B 的当前流程')
    assert.equal(tabOf(ui, '子流程 sub').props['aria-selected'], false, '旧手动子流程不沿用（B 同名子流程确实存在）')
    assert.equal(returnEntry(ui), null)
  } finally { w.cleanup() }
})

test('#270 AC-08 跨目录切换当次隔离错误与数据（不残留旧目录横幅）', async () => {
  const w = createWorld()
  try {
    const aRunId = await w.startRun('ws-a', 'A')
    const bRunId = await w.startRun('ws-b', 'B')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), new RegExp(`Run：${aRunId}`))

    w.bridge.setFailure({ ok: false, error: { code: 'monitor/busy-a', message: 'A 目录专属错误' } })
    await w.tick(2000)
    assert.match(ui.text(), /A 目录专属错误/)
    assert.match(ui.text(), new RegExp(`Run：${aRunId}`), '失败保留同上下文数据')

    w.bridge.setFailure(null)
    w.bridge.hold(payload => payload.cwd === 'ws-b')
    ui.setProps({ scope: { cwd: 'ws-b' } })
    // 不 await、不释放：切换当次渲染就必须只剩加载态。
    assert.match(ui.text(), /正在加载运行状态/)
    assert.doesNotMatch(ui.text(), new RegExp(aRunId), 'A 的运行数据当次不可见')
    assert.doesNotMatch(ui.text(), /A 目录专属错误/, 'A 的错误横幅当次不再显示')
    assert.doesNotMatch(ui.text(), /状态刷新失败/)

    assert.equal(w.bridge.held.length, 1)
    assert.equal(w.bridge.release(payload => payload.cwd === 'ws-b'), 1)
    await settle()
    assert.match(ui.text(), new RegExp(`Run：${bRunId}`))
    assert.doesNotMatch(ui.text(), /状态刷新失败/)
  } finally { w.cleanup() }
})

test('#270 AC-09 同 cwd 维护态→空态→Run：无需重挂载，每步都自愈', async () => {
  const w = createWorld()
  try {
    w.setMaintenance({ kind: 'incompatible', reason: '状态库升级中' })
    const ui = w.mount({ cwd: 'ws-empty' })
    await settle()
    assert.match(ui.text(), /状态库维护模式/)
    assert.doesNotMatch(ui.text(), /dsh-flow start/, '维护态不展示空态引导')

    w.setMaintenance(undefined)
    await w.tick(2000)
    assert.doesNotMatch(ui.text(), /状态库维护模式/)
    assert.match(ui.text(), /dsh-flow start/, '恢复后先进入空态引导')

    const runId = await w.startRun('ws-empty')
    await w.tick(2000)
    assert.doesNotMatch(ui.text(), /dsh-flow start/)
    assert.match(ui.text(), new RegExp(`Run：${runId}`), '空态继续探测后直接发现新 Run')
  } finally { w.cleanup() }
})

test('#274 当前执行卡：真实 engine→status RPC→bundle 渲染（活动 + 终态结束位置）', async () => {
  const w = createWorld()
  try {
    // 注入冻结默认路由：投影只显示落库事实，不看当前配置。
    w.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    await w.startRun('ws-a', 'card')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    const text = ui.text()
    assert.match(text, /当前节点：plan/)
    assert.match(text, /Actor（manager）/)
    assert.match(text, /mgr\/m-manager · 首选/, '活动卡显示派发时的模型与来源')
    assert.match(text, /Judge/)
    assert.match(text, /未派发/, 'Actor 未提交前 Judge 显示未派发')
    assert.doesNotMatch(text, /结束位置/, '活跃 Run 不显示结束位置')
  } finally { w.cleanup() }

  const terminal = createWorld()
  try {
    await terminal.completeRun('ws-a')
    const ui = terminal.mount({ cwd: 'ws-a' })
    await settle()
    const text = ui.text()
    assert.match(text, /结束位置：review/, '终态 Run 的卡指向最后一个工作单')
    assert.match(text, /已判定：ACCEPT/, '判定结果来自判定记录')
    assert.doesNotMatch(text, /当前节点：/, '终态不再冒充当前执行')
  } finally { terminal.cleanup() }
})

test('#275 执行记录表：真实 engine→status RPC→bundle 渲染列/行与多轮下钻', async () => {
  const w = createWorld()
  try {
    w.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    await w.startRun('ws-a', 'records')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()

    // 活跃当前节点由上方当前执行卡承载，主表不重复占一行。
    let text = ui.text()
    assert.match(text, /当前节点：plan/)
    assert.match(text, /未派发/, 'Judge 未派发与 #274 口径一致')
    assert.doesNotMatch(text, /执行记录（/, '当前执行不在主表重复占一行')

    const rejectRound = async () => {
      const row = (await w.store.get('ws-a'))!
      const caller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
      assert.equal((await w.engine.handleJudgeClaim('ws-a', row.execution.nodeToken, 'REJECT', 'needs work', caller)).ok, true)
      await w.engine.handleTurnEnded('ws-a', caller)
    }
    const claimRound = async (caller: ClaimCaller, handoff: string) => {
      const row = (await w.store.get('ws-a'))!
      const turn: ClaimCaller = { sessionId: caller.sessionId, turnUserMessageIds: new Set([row.execution.dispatch?.messageId ?? ('continuation-' + row.execution.executionId)]) }
      assert.equal((await w.engine.handleClaim('ws-a', { result: 'succeeded', handoff }, turn)).ok, true)
      await w.engine.handleTurnEnded('ws-a', turn)
    }
    const acceptRound = async () => {
      const row = (await w.store.get('ws-a'))!
      const caller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
      assert.equal((await w.engine.handleJudgeClaim('ws-a', row.execution.nodeToken, 'ACCEPT', 'ok', caller)).ok, true)
      await w.engine.handleTurnEnded('ws-a', caller)
    }

    // 同一次进入里的多轮：Actor A 提交 → Judge REJECT → 自动重派仍待提交 → 再提交 → ACCEPT。
    await claimRound({ sessionId: 'manager', turnUserMessageIds: new Set() }, 'plan v1')
    await rejectRound()
    w.tick(2000)
    await settle()
    assert.doesNotMatch(ui.text(), /执行记录（/, '当前轮仍在当前卡，不提前占主表一行')
    await claimRound({ sessionId: 'manager', turnUserMessageIds: new Set() }, 'plan v2')
    await acceptRound()
    w.tick(2000)
    await settle()
    text = ui.text()
    assert.match(text, /执行记录（1 次进入）/, '一次进入 = 一行（多轮不新增主行）')
    for (const column of ['节点名称', '所属流程', '运行情况', '进入时间', '提交结果时间', '提交判定时间', 'Actor 模型', 'Judge 模型']) {
      assert.match(text, new RegExp(column), `表头列：${column}`)
    }
    assert.match(text, /plan（manager）/)
    assert.match(text, /主流程/)
    assert.match(text, /mgr\/m-manager · 首选/, 'Actor 模型来自派发快照')
    const scroll = ui.find((el: any) => el.props?.className === 'wf-monitor-records-scroll')
    assert.equal(collect(scroll?.props?.children, el => el.type === 'table')[0]?.props?.className, 'wf-record-table', '表格在可滚动容器内，表头/前两列用系统色固定在滚动容器外')
    const header = ui.find((el: any) => el.type === 'th' && el.props?.className === 'wf-record-sticky-1')
    assert.equal(header?.props?.scope, 'col')
    const toggle = ui.find((el: any) => el.props?.className === 'wf-record-toggle')
    assert.equal(toggle?.props?.['aria-expanded'], 'false')
    assert.match(String(toggle?.props?.['aria-label']), /展开/)
    assert.match(text, /共 2 轮/, '拒绝后同一次进入轮次累计')
    toggle.props.onClick()
    await settle()
    text = ui.text()
    assert.match(text, /第 1 轮：提交「succeeded」 · 判定不通过/, '下钻显示每轮提交与判定')
    assert.match(text, /第 2 轮：提交「succeeded」/, '第二轮取自己的提交时间')
    assert.match(text, /Actor mgr\/m-manager · 首选/, '每轮模型来自该轮派发快照')

    // review 通过 → Run 终态：末次记录保留，当前卡不再冒充当前执行。
    const reviewDispatch = (await w.store.get('ws-a'))!.execution.dispatch!
    await claimRound({ sessionId: reviewDispatch.sessionId!, turnUserMessageIds: new Set() }, 'review ok')
    const reviewJudge = async () => {
      const row = (await w.store.get('ws-a'))!
      return { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
    }
    const accept = await reviewJudge()
    assert.equal((await w.engine.handleJudgeClaim('ws-a', (await w.store.get('ws-a'))!.execution.nodeToken, 'ACCEPT', 'ok', accept)).ok, true)
    await w.engine.handleTurnEnded('ws-a', accept)
    w.tick(2000)
    await settle()
    text = ui.text()
    assert.match(text, /执行记录（2 次进入）/, '终态后两次进入都保留在表中')
    assert.match(text, /review/)
    assert.doesNotMatch(text, /第 2 次进入/, '线性流第 2 个节点 visit=2 但首次进入：不显示为第 2 次进入')
  } finally { w.cleanup() }
})

test('#275 执行记录表：等待子流程的父节点仍成行，主/子流程路径可分', async () => {
  const w = createWorld()
  try {
    w.engine.managerRoute = async () => ({ provider: 'mgr', model: 'm-manager' })
    await w.startRun('ws-a', 'child', childConfig)
    let row = (await w.store.get('ws-a'))!
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    assert.equal((await w.engine.handleClaim('ws-a', { result: 'succeeded', handoff: 'plan ok' }, manager)).ok, true)
    await w.engine.handleTurnEnded('ws-a', manager)
    row = (await w.store.get('ws-a'))!
    const judge: ClaimCaller = { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) }
    assert.equal((await w.engine.handleJudgeClaim('ws-a', row.execution.nodeToken, 'ACCEPT', 'ok', judge)).ok, true)
    await w.engine.handleTurnEnded('ws-a', judge)
    // 已下钻到子流程：父节点 call-child 等待子流程，子流程 s1 已进入。
    row = (await w.store.get('ws-a'))!
    assert.deepEqual(row.run.callStack.map(frame => frame.workflowId), ['test', 'sub'])

    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    const text = ui.text()
    assert.match(text, /执行记录（2 次进入）/, '已结束的 plan 与等待子流程的 call-child 都成行（当前子流程节点只在当前卡）')
    assert.match(text, /call-child/)
    assert.match(text, /子流程 sub/)
    assert.match(text, /执行中/, '等待子流程的父节点不画成成功')
    assert.match(text, /不适用/, '子流程节点行没有 Actor 提交/判定与模型派发：相关列不适用（R1 F-01）')
  } finally { w.cleanup() }
})
