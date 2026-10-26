// #276 只读运行图的临时布局与查看状态：共享画布行为检查 + 监控接线（Run/流程 identity 隔离）。
// 共享画布经 bundleSources() 的真实源码 + 最小 React/DOM 桩渲染单个 NodeCanvas；监控接线执行真实
// bundle（buildClientBundle）并断言画布收到的隔离身份与恢复布局入口。两处都不锁定 Hook slot 或源码字符串。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildClientBundle, bundleSources } from '../web-client/build.mjs'

const STARTED_AT = '2026-10-25T04:00:00.000Z'

const FLOW_DEF = {
  startNode: 'plan',
  returns: ['done'],
  nodes: {
    plan: { id: 'plan', kind: 'actor-task', role: 'manager', model: { provider: 'prov', modelId: 'm-plan' }, results: { succeeded: { criteria: 'done', target: { node: 'review' } } } },
    review: { id: 'review', kind: 'actor-task', role: 'reviewer', model: { provider: 'prov', modelId: 'm-review' } },
    child: { id: 'child', kind: 'child-workflow', childWorkflowId: 'sub', onReturn: { out: { return: 'done' } } },
  },
}
const POSITIONS = { plan: { x: 40, y: 40 }, review: { x: 260, y: 40 }, child: { x: 480, y: 40 } }

function textOf(node: any): string {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object' || node.props === undefined) return ''
  if (node.type === 'style' || node.type === 'script') return ''
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

/**
 * 每页一份模块实例：同页卸载重挂共享模块内存（临时布局缓存），重新建页 = 整页刷新后清空。
 * 每次挂载有自己的 hook 槽，模块里的 store 是页面级的，二者刻意分开以贴近真实 React。
 */
function createCanvasPage() {
  const { graphCanvas } = bundleSources()
  const factory = new Function('require', `${graphCanvas}\nreturn { NodeCanvas }`) as (require: any) => any
  let active: any = null
  const react = {
    createElement: (type: unknown, elementProps: any, ...children: any[]) => ({ type, props: { ...(elementProps ?? {}), children } }),
    useState: (initial: unknown) => active.useState(initial),
    useRef: (initial: unknown) => active.useRef(initial),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => active.useEffect(fn, deps),
  }
  const module = factory(() => react)
  return { module, react, setActive: (next: any) => { active = next } }
}

const fakeViewport = () => ({
  clientWidth: 900,
  clientHeight: 420,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  setPointerCapture() {},
  releasePointerCapture() {},
  classList: { add() {}, remove() {} },
})

/**
 * 最小 React 渲染器：只驱动单个 NodeCanvas（hooks 按调用顺序、deps 变化才跑 effect），
 * 以及供它使用的假视口 DOM。断言的是渲染结果与回调，不是内部 hook 槽。
 */
function mountCanvas(page: any, initialProps: any) {
  const hooks: any[] = []
  let index = 0
  let props = initialProps
  let tree: any = null
  let dead = false
  let scheduled = false
  const depsChanged = (deps?: unknown[], previous?: unknown[]) => deps === undefined || previous === undefined
    || deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))
  const schedule = () => {
    if (dead || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; if (!dead) render() })
  }
  const setSlotState = (slot: any, next: unknown) => {
    const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slot.value) : next
    if (Object.is(value, slot.value)) return
    slot.value = value
    schedule()
  }
  const mountReact = {
    useState(initial: unknown) {
      const at = index++
      if (hooks[at] === undefined) hooks[at] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      return [hooks[at].value, (next: unknown) => setSlotState(hooks[at], next)]
    },
    useRef(initial: unknown) {
      const at = index++
      if (hooks[at] === undefined) hooks[at] = { kind: 'ref', current: initial }
      return hooks[at]
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const at = index++
      if (hooks[at] === undefined) hooks[at] = { kind: 'effect', fn, deps, previous: undefined, cleanup: undefined }
      else {
        if (!depsChanged(deps, hooks[at].deps)) return
        if (typeof hooks[at].cleanup === 'function') hooks[at].cleanup()
        hooks[at].fn = fn
        hooks[at].deps = deps
      }
      hooks[at].pending = true
    },
  }
  const attachRefs = (element: any) => {
    if (element === null || typeof element !== 'object' || element.props === undefined) return
    if (element.props.ref !== undefined && element.props.ref !== null) element.props.ref.current = fakeViewport()
    for (const child of element.props.children ?? []) attachRefs(child)
  }
  const runEffects = () => {
    for (const slot of hooks) {
      if (slot?.kind !== 'effect' || slot.pending !== true) continue
      slot.pending = false
      slot.cleanup = slot.fn()
    }
  }
  const render = () => {
    index = 0
    page.setActive(mountReact)
    tree = page.module.NodeCanvas(props)
    attachRefs(tree)
    runEffects()
  }
  render()
  return {
    get tree() { return tree },
    rerender(next: any) { props = next; render() },
    unmount() { dead = true },
  }
}
function nodeStyle(tree: any, nodeId: string) {
  const node = collect(tree, (element) => typeof element.props.className === 'string'
    && element.props.className.includes('wf-node')
    && !element.props.className.includes('wf-node-title')
    && textOf(collect(element, (child) => child.props.className === 'wf-node-title').map((child) => child.props.children).join('').replace(' ★', '')) === nodeId)
  assert.equal(node.length, 1, `目录里应有节点 ${nodeId}`)
  return node[0].props.style
}

function nodeElement(tree: any, nodeId: string) {
  const node = collect(tree, (element) => typeof element.props.className === 'string'
    && element.props.className.includes('wf-node')
    && !element.props.className.includes('wf-node-title')
    && textOf(collect(element, (child) => child.props.className === 'wf-node-title').map((child) => child.props.children).join('').replace(' ★', '')) === nodeId)[0]
  return node
}

function titleButton(tree: any, nodeId: string) {
  return collect(nodeElement(tree, nodeId), (element) => element.props.className === 'wf-node-title')[0]
}

function pointer(overrides: any = {}) {
  return {
    button: 0,
    pointerId: 7,
    clientX: 0,
    clientY: 0,
    currentTarget: { setPointerCapture() {} },
    ...overrides,
  }
}

function drag(ui: any, nodeId: string, dx: number, dy: number) {
  const button = titleButton(ui.tree, nodeId)
  const start = button.props.onPointerDown(pointer({ clientX: 100, clientY: 100 }))
  button.props.onPointerMove(pointer({ clientX: 100 + dx, clientY: 100 + dy }))
  button.props.onPointerUp(pointer())
  return { button, start }
}

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

const canvasProps = (overrides: any = {}) => ({
  readOnly: true,
  viewKey: 'r1:test',
  flowId: null,
  def: FLOW_DEF,
  positions: POSITIONS,
  startNode: 'plan',
  returns: ['done'],
  decorations: {},
  ...overrides,
})

test('#276 共享画布：只读拖动只改本页临时位置，点击/下钻与「不可编辑」边界不变', async () => {
  const moves: any[] = []
  const selects: any[] = []
  const portStarts: any[] = []
  const page = createCanvasPage()
  const ui = mountCanvas(page, canvasProps({ onMove: (...args: any[]) => moves.push(args), onSelectNode: (id: string) => selects.push(id), onPortStart: (...args: any[]) => portStarts.push(args) }))
  assert.deepEqual(nodeStyle(ui.tree, 'review'), { left: '260px', top: '40px' })
  const edgePath = () => collect(ui.tree, (element) => element.props.className === 'wf-edge-line')[0].props.d
  const pathBefore = edgePath()
  // 拖动：临时位置随指针移动，松手后保持；不回调 onMove（不写布局、不进撤销栈）。
  drag(ui, 'review', 120, 60)
  await settle()
  assert.deepEqual(nodeStyle(ui.tree, 'review'), { left: '380px', top: '100px' })
  assert.deepEqual(moves, [], '只读临时拖动不能写回布局')
  // 连线端点跟随新位置（plan → review 的终点落到 380/122），几何不错位。
  const pathAfter = edgePath()
  assert.notEqual(pathAfter, pathBefore)
  assert.match(pathAfter, /H 380$/)
  assert.match(pathAfter, /V 122/)
  // 「适应视图」只调整查看范围，不撤销节点临时位置。
  collect(ui.tree, (element) => element.type === 'button' && textOf(element) === '适应画布')[0].props.onClick()
  await settle()
  assert.deepEqual(nodeStyle(ui.tree, 'review'), { left: '380px', top: '100px' }, '适应视图不撤销临时位置')
  // 拖动后的一次 click 被吞掉，不误触发选择/下钻；普通点击仍可选中（点击落在节点容器上，标题按钮只负责拖动）。
  nodeElement(ui.tree, 'review').props.onClick()
  assert.deepEqual(selects, [])
  nodeElement(ui.tree, 'plan').props.onClick()
  assert.deepEqual(selects, ['plan'])
  // 结构编辑仍关闭：端口点击无效、没有连线/保存入口。
  const port = collect(ui.tree, (element) => typeof element.props.className === 'string' && element.props.className.split(' ')[0] === 'wf-port')[0]
  port.props.onClick({ stopPropagation() {} })
  assert.deepEqual(portStarts, [])
  assert.equal(collect(ui.tree, (element) => element.props.className === 'wf-wire').length, 0)
  const saveButtons = collect(ui.tree, (element) => element.type === 'button' && /保存/.test(textOf(element)))
  assert.deepEqual(saveButtons, [], '只读运行图没有保存入口')
  assert.match(textOf(ui.tree), /不保存/)
  // 可调整位置与可编辑结构是两个能力：帮助文案说明临时调整与恢复入口。
  assert.match(textOf(ui.tree), /临时调整位置/)
})

test('#276 共享画布：卸载重挂保留、切回同 Run/流程恢复、整页刷新清除、恢复布局只重置当前流程', async () => {
  const page = createCanvasPage()
  const first = mountCanvas(page, canvasProps())
  drag(first, 'review', 100, 40)
  await settle()
  assert.deepEqual(nodeStyle(first.tree, 'review'), { left: '360px', top: '80px' })
  // 缩放也属于页面内存里的查看状态：与节点位置一起恢复。
  const surface = () => collect(first.tree, (element) => element.props.className === 'wf-canvas-surface')[0].props.style.transform
  const beforeZoom = surface()
  const zoomIn = collect(first.tree, (element) => element.props['aria-label'] === '放大画布')[0]
  zoomIn.props.onClick()
  await settle()
  const afterZoom = surface()
  assert.notEqual(afterZoom, beforeZoom, '缩放按钮改变视野')
  first.unmount()
  // 同页重新挂载（收起/重开侧栏、切换流程后返回）：同一 viewKey 恢复临时位置与缩放。
  const second = mountCanvas(page, canvasProps())
  assert.deepEqual(nodeStyle(second.tree, 'review'), { left: '360px', top: '80px' })
  assert.equal(collect(second.tree, (element) => element.props.className === 'wf-canvas-surface')[0].props.style.transform, afterZoom, '重挂后恢复同一缩放')
  // 其他 Run（同 workflowId/节点名）不共享；不同流程也各自隔离。
  const otherRun = mountCanvas(page, canvasProps({ viewKey: 'r2:test' }))
  assert.deepEqual(nodeStyle(otherRun.tree, 'review'), { left: '260px', top: '40px' })
  const otherFlow = mountCanvas(page, canvasProps({ viewKey: 'r1:sub' }))
  assert.deepEqual(nodeStyle(otherFlow.tree, 'review'), { left: '260px', top: '40px' })
  // 恢复布局只重置当前流程：仿真 r1:test 的信号，r1:sub 的调整保留。
  drag(otherFlow, 'review', 40, 0)
  await settle()
  const resetApplied = mountCanvas(page, canvasProps({ resetSignal: 0 }))
  assert.deepEqual(nodeStyle(resetApplied.tree, 'review'), { left: '360px', top: '80px' })
  resetApplied.rerender(canvasProps({ resetSignal: 1 }))
  await settle()
  assert.deepEqual(nodeStyle(resetApplied.tree, 'review'), { left: '260px', top: '40px' }, '恢复布局回到原布局坐标')
  const stillMoved = mountCanvas(page, canvasProps({ viewKey: 'r1:sub' }))
  assert.deepEqual(nodeStyle(stillMoved.tree, 'review'), { left: '300px', top: '40px' }, '其他流程的临时布局不受影响')
  // 整页刷新 = 重新求值模块（新的页面内存）：临时状态清空，回到原布局。
  const fresh = mountCanvas(createCanvasPage(), canvasProps())
  assert.deepEqual(nodeStyle(fresh.tree, 'review'), { left: '260px', top: '40px' })
})

test('#276 共享画布：轮询数据更新不重置临时位置；配置编辑器拖动/保存路径保持可写', async () => {
  const page = createCanvasPage()
  const ui = mountCanvas(page, canvasProps())
  drag(ui, 'review', 60, 20)
  await settle()
  const moved = nodeStyle(ui.tree, 'review')
  // 轮询只更新装饰/模型等数据，位置由页面内存决定，不被 payload 重置。
  ui.rerender(canvasProps({ decorations: { review: { badge: 'BLOCK', className: 'wf-node-blocked', detail: '等待授权' } } }))
  await settle()
  assert.deepEqual(nodeStyle(ui.tree, 'review'), moved)
  assert.equal(textOf(ui.tree).includes('等待授权'), true)
  // 编辑器（无 viewKey）行为不变：拖动写回布局，且不会把临时布局带进监控缓存。
  const saved: any[] = []
  const editor = mountCanvas(page, { readOnly: false, flowId: 'test', def: FLOW_DEF, positions: POSITIONS, startNode: 'plan', returns: ['done'], onMove: (...args: any[]) => saved.push(args) })
  drag(editor, 'review', 50, 10)
  await settle()
  assert.deepEqual(saved, [['test', 'review', { x: 310, y: 50 }]])
  assert.deepEqual(nodeStyle(editor.tree, 'review'), { left: '260px', top: '40px' }, '编辑器位置由外部布局决定，不在拖动时就地生效')
  const monitorAfterEditor = mountCanvas(page, canvasProps({ viewKey: 'r1:test2' }))
  assert.deepEqual(nodeStyle(monitorAfterEditor.tree, 'review'), { left: '260px', top: '40px' })
})

/** 只跑真实 bundle 的 tab 组件（不递归渲染子组件），断言画布接线与入口。 */
function loadMonitorPage() {
  const loaded: any[] = []
  const fakeWindow = { __ModuleLoader__: { load: (entry: any) => loaded.push(entry) } }
  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({ style: {}, appendChild() {}, append() {} }),
    body: { appendChild() {} },
  } as any
  new Function('window', 'document', 'setTimeout', 'clearTimeout', readFileSync(buildClientBundle(), 'utf8'))(
    fakeWindow,
    fakeDocument,
    // 本测试只验证接线与身份：周期定时器不外跑，避免测试进程被 2s 轮询挂住。
    () => 0,
    () => {},
  )
  assert.equal(loaded.length, 1)
  return loaded[0].factory
}

const PAYLOAD = {
  mode: 'run',
  run: {
    runId: 'r1', workflowId: 'test', status: 'running', blockReason: null, businessReturn: null, launchPrompt: '启动原文',
    roles: [{ role: 'reviewer', model: { provider: 'prov', modelId: 'm-review' } }],
    flows: {
      test: { startNode: 'plan', returns: ['done'], nodes: [
        { id: 'plan', kind: 'actor-task', role: 'manager', model: { provider: 'prov', modelId: 'm-plan' }, results: { succeeded: { criteria: 'done', target: { node: 'review' } } } },
        { id: 'review', kind: 'actor-task', role: 'reviewer', model: { provider: 'prov', modelId: 'm-review' } },
        { id: 'child', kind: 'child-workflow', childWorkflowId: 'sub', onReturn: { out: { return: 'done' } } },
      ] },
      sub: { startNode: 's1', returns: ['out'], nodes: [{ id: 's1', kind: 'actor-task', role: 'reviewer' }] },
    },
    layout: { version: 1, main: POSITIONS, children: { sub: { s1: { x: 40, y: 40 } } } },
    nodes: [{ workflowId: 'test', nodeId: 'plan', executionId: 'e1', visit: 1, revision: 1, phase: 'working', blockReason: null, enteredAt: STARTED_AT, exitedAt: null, current: true }],
    callStack: [{ workflowId: 'test', nodeId: 'plan', executionId: 'e1' }],
  },
}

test('#276 监控接线：画布按 Run+流程拿隔离身份，恢复布局入口不换身份、不重新挂载', async () => {
  const factory = loadMonitorPage()
  const render = (() => {
    const hooks: any[] = []
    let index = 0
    let tree: any = null
    let dead = false
    const depsChanged = (deps?: unknown[], previous?: unknown[]) => deps === undefined || previous === undefined
      || deps.length !== previous.length || deps.some((value, i) => !Object.is(value, previous[i]))
    const schedule = () => queueMicrotask(() => { if (!dead) draw() })
    const react = {
      createElement: (type: unknown, elementProps: any, ...children: any[]) => ({ type, props: { ...(elementProps ?? {}), children } }),
      useState(initial: unknown) {
        const at = index++
        if (hooks[at] === undefined) hooks[at] = { kind: 'state', value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
        return [hooks[at].value, (next: unknown) => { const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(hooks[at].value) : next; if (Object.is(value, hooks[at].value)) return; hooks[at].value = value; schedule() }]
      },
      useRef(initial: unknown) {
        const at = index++
        if (hooks[at] === undefined) hooks[at] = { kind: 'ref', current: initial }
        return hooks[at]
      },
      useEffect(fn: () => void | (() => void), deps?: unknown[]) {
        const at = index++
        if (hooks[at] === undefined) hooks[at] = { kind: 'effect', fn, deps, previous: undefined, cleanup: undefined }
        else {
          if (!depsChanged(deps, hooks[at].deps)) return
          if (typeof hooks[at].cleanup === 'function') hooks[at].cleanup()
          hooks[at].fn = fn
          hooks[at].deps = deps
        }
        hooks[at].pending = true
      },
    }
    const bundleModule = factory(() => react)
    let tab: any = null
    bundleModule.apply({
      connection: { rpc: { call: async () => ({ ok: true, value: PAYLOAD }) } },
      slots: { inject: (_name: string, callback: () => unknown) => { callback(); return { dispose() {} } }, register: () => ({ dispose() {} }) },
      layout: {}, remote: {},
      inject: (_deps: string[], callback: (ctx: any) => void) => callback({ betterSidebar: { registerTab: (descriptor: any) => { tab = descriptor } } }),
    })
    const draw = () => {
      index = 0
      tree = tab.component({})
      for (const slot of hooks) {
        if (slot?.kind !== 'effect' || slot.pending !== true) continue
        slot.pending = false
        slot.cleanup = slot.fn()
      }
    }
    return {
      get tree() { return tree },
      draw,
      pump: () => { if (!dead) draw() },
      unmount() { dead = true },
    }
  })()
  // 首帧（loading）→ 轮询返回后重绘。
  await settle()
  render.pump()
  await settle()
  const canvases = () => collect(render.tree, (element) => typeof element.type === 'function' && element.props?.viewKey !== undefined)
  assert.equal(canvases().length, 1)
  assert.equal(canvases()[0].props.viewKey, 'r1:test')
  assert.equal(canvases()[0].props.readOnly, true)
  assert.equal(canvases()[0].props.resetSignal, 0)
  const resetButton = collect(render.tree, (element) => typeof element.props.className === 'string' && element.props.className === 'wf-monitor-reset-layout')[0]
  assert.ok(resetButton, '监控图上有恢复布局入口')
  assert.match(textOf(resetButton), /恢复布局/)
  // 流程切换：同一 Run 的子流程用子流程身份，不沿用主流程身份。
  const subTab = collect(render.tree, (element) => element.props?.role === 'tab' && textOf(element).includes('sub'))[0]
  assert.ok(subTab, '子流程 tab 可见')
  subTab.props.onClick()
  await settle()
  render.pump()
  await settle()
  assert.equal(canvases()[0].props.viewKey, 'r1:sub')
  // 恢复布局：只递增重置信号，身份不变（仍是同一 Run+流程）。
  resetButton.props.onClick()
  await settle()
  render.pump()
  await settle()
  assert.equal(canvases()[0].props.viewKey, 'r1:sub')
  assert.equal(canvases()[0].props.resetSignal, 1)
  render.unmount()
})
