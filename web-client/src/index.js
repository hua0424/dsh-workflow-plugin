/**
 * T1 客户端入口：宿主模块加载器 factory 格式（见 web-client/build.mjs）。
 *
 * 正式接入：root `main` keyed slot 注册全局面板 + `sidebar.panellist` 入口；
 * 无 DOM 注入，不另起服务器，不修改宿主。`layout.selectPanel` 无需客户端注册：
 * 宿主在切换前检查实时 `main` 注册表（packages/client/ui-layout README 与
 * service.ts），侧栏点击/调用 selectPanel 由壳完成。React 由宿主共享实例提供
 * （module-table baseline：react / react-dom / @deepseek-ai/cordis），
 * 本 bundle 不打包第二份 React；React Flow 等非宿主依赖随客户端提供（pending，见 README）。
 *
 * 注册选项形状（keyed 的 key / list 的 id+order+label）以宿主
 * `packages/client/ui-layout` 与 `packages/client/ui-sidebar` 的 SlotMap/contract
 * 及运行期 `cordis_inspect what:"client"` 为准，集成时以生成目录为准复核。
 */
import { WorkflowConfigEditorIcon, WorkflowConfigEditorPanel } from './panel.js'
import { StartWorkflowButton } from './start-modal.js'
import { WorkflowMonitorTab } from './monitor.js'
import { monitorStatusPayload } from './monitor-view.js'
import { callChannel, callEditor, readWorkflowCatalog } from './rpc.js'
import { readModelCatalog } from './model-selector.js'

export const PANEL_KEY = 'workflow-config-editor'

/** #251 运行监控 tab：通道与 tab id（独立于编辑器通道，ADR-0005）。 */
export const MONITOR_RPC_CHANNEL = '/workflow-run-monitor'
export const MONITOR_TAB_ID = 'dsh-workflow:monitor'

/** 对话输入工具区启动按钮注册（session-scoped list，不替换 composer）。 */
export const START_BUTTON_ID = 'dsh-workflow-start'

/** 浏览器侧 Cordis 依赖：slot 注册表、主面板控制器、Connection RPC 通道、命令通道。 */
export const inject = ['slots', 'layout', 'connection', 'remote', 'remote.session', 'remote.commands']

export function apply(ctx) {
  const editorRpc = (endpoint, payload, signal) => callEditor(ctx.connection, endpoint, payload, signal)
  let modelRequest
  const loadModels = () => modelRequest ??= readModelCatalog(ctx.remote).finally(() => { modelRequest = undefined })
  // #178 启动弹窗数据接缝：只读目录拉取（#179 弹窗消费；打开/刷新/取消不执行命令）。
  const loadCatalog = (signal) => readWorkflowCatalog(editorRpc, { signal })
  // #179 原生命令提交：与手写命令同一链路（remote.commands.execute），缺席时拒绝
  // 为可报告的未知结果（调用方保留输入、不自动重试），绝不静默拼写命令。
  const runCommand = (sessionId, line) => ctx.remote?.commands?.execute?.(sessionId, line, [])
    ?? Promise.reject(new Error('当前页面没有可用的命令通道'))
  const injected = () => ({ editorRpc, loadModels, loadCatalog, layout: ctx.layout })

  // #179 对话输入工具区启动按钮（session-scoped list：只占左工具位，不替换 composer，
  // 无 DOM 注入；弹窗归属打开它的 Session，标准会话 props 由宿主按 slot 契约提供）。
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: START_BUTTON_ID, order: 100, label: '启动工作流' },
      (props) => StartWorkflowButton({ ...props, loadCatalog, runCommand }),
    ),
  )

  // 全局主面板（keyed：key 即 sidebar 入口 id）。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_KEY, inject: injected },
      WorkflowConfigEditorPanel,
    ),
  )
  // 侧栏入口图标（list：id 与主面板 key 一致；点击选择由侧栏壳拥有）。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_KEY, order: 200, label: '工作流配置', inject: injected },
      WorkflowConfigEditorIcon,
    ),
  )

  // #251 运行监控 tab：动态注入——等待 better-sidebar 服务出现后注册；未安装
  // better-sidebar 的环境注入永不触发，tab 静默缺席，编辑器面板照常加载。
  // 服务名是 ctx.betterSidebar（ADR-0005 / better-sidebar service.d.ts），
  // 不是包名 'better-sidebar'——写错注入名回调永不触发，tab 不出现（#253 AC3 实证）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['betterSidebar'], (sidebarCtx) => {
      const sidebar = sidebarCtx?.betterSidebar
      if (typeof sidebar?.registerTab !== 'function') return
      // 每次请求带上 tab 收到的 scope.cwd：宿主按会话工作目录解析 workspace，
      // 服务端不再回退 process.cwd（R1 F4）。
      const fetchStatus = (scope) => callChannel(ctx.connection, MONITOR_RPC_CHANNEL, 'status', monitorStatusPayload(scope))
      // better-sidebar 0.28 descriptor 契约：title/component 是必填字段，registerTab 只收
      // 一个 descriptor（旧版 (config, component) 双参写法会被忽略，tab 不出现）。
      sidebar.registerTab({
        id: MONITOR_TAB_ID,
        title: '工作流监控',
        desc: '运行状态、节点进度与子流程下钻',
        component: (props) => WorkflowMonitorTab({ ...props, fetchStatus: () => fetchStatus(props?.scope) }),
      })
    })
  }
}
