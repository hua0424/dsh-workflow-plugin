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

/** RPC 桥：记录载荷、可挂起响应（复现迟到的旧响应）、可注入失败信封。 */
function createBridge(handler: (endpoint: string, payload: any) => Promise<any>) {
  const calls: Array<{ endpoint: string; payload: any }> = []
  const held: Array<{ payload: any; release: () => void }> = []
  let holdPredicate: ((payload: any) => boolean) | null = null
  let failure: any = null
  const call = (_channel: string, endpoint: string, payload: any) => {
    calls.push({ endpoint, payload })
    if (failure !== null) return Promise.resolve(failure)
    if (holdPredicate !== null && holdPredicate(payload)) {
      return new Promise(resolve => {
        held.push({ payload, release: () => { resolve(handler(endpoint, payload)) } })
      })
    }
    return Promise.resolve(handler(endpoint, payload))
  }
  return {
    calls,
    held,
    call,
    hold(predicate: (payload: any) => boolean) { holdPredicate = predicate },
    release(predicate: (payload: any) => boolean) {
      const picked = held.filter(entry => predicate(entry.payload))
      for (const entry of picked) {
        held.splice(held.indexOf(entry), 1)
        entry.release()
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
  const handler = createMonitorRpcHandler({
    maintenance: () => maintenance,
    resolveWorkspace: async (cwd?: string) => { stateReads += 1; return typeof cwd === 'string' && cwd !== '' ? cwd : 'ws' },
    latest: async workspaceKey => { stateReads += 1; return store.get(workspaceKey) },
    active: async () => { stateReads += 1; return store.activeRuns() },
    byRunId: async runId => { stateReads += 1; return store.getByRunId(runId) },
    executions: async runId => { stateReads += 1; return store.runExecutionsByRunId(runId) },
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
    /** 起一个活跃 Run（stub 派发，真状态库），返回 runId。 */
    async startRun(workspaceKey: string, label = 'run'): Promise<string> {
      assert.equal((await engine.startRun(workspaceKey, engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, label)).ok, true)
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

test('#261 目录切换：旧目录的终态不再挡住新目录的 Run（同根问题）', async () => {
  const w = createWorld()
  try {
    await w.completeRun('ws-a')
    const ui = w.mount({ cwd: 'ws-a' })
    await settle()
    assert.match(ui.text(), /已停止自动轮询/)
    const terminalCalls = w.bridge.calls.length
    await w.tick(6000)
    assert.equal(w.bridge.calls.length, terminalCalls, '终态停周期')

    const bRunId = await w.startRun('ws-b', 'B')
    ui.setProps({ scope: { cwd: 'ws-b' } })
    // 切换当次渲染就读不到旧目录数据（不等 effect 事后擦除）。
    assert.match(ui.text(), /正在加载运行状态/)
    assert.doesNotMatch(ui.text(), /已停止自动轮询/)
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
    assert.doesNotMatch(ui.text(), /已停止自动轮询/, '旧终态响应不得停掉新目录刷新')

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
    assert.match(ui.text(), /已停止自动轮询/)
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
