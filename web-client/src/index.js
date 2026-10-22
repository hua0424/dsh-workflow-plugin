/**
 * T1 客户端入口：宿主模块加载器 factory 格式（见 web-client/build.mjs）。
 *
 * 正式接入：`settings.section` list 注册设置页一页「工作流配置」（#219 起入口从侧栏
 * 图标 + root 全局面板迁入设置页）；无 DOM 注入，不另起服务器，不修改宿主。React 由
 * 宿主共享实例提供（module-table baseline：react / react-dom / @deepseek-ai/cordis），
 * 本 bundle 不打包第二份 React；React Flow 等非宿主依赖随客户端提供（pending，见 README）。
 *
 * 注册选项形状（list 的 id+order+label）以宿主 `packages/client/ui-settings` 的
 * `contract/slots.ts`（settings.section：kind list / scope root / id/order/label）
 * 及运行期 `cordis_inspect what:"client"` 为准，集成时以生成目录为准复核。
 */
import { WorkflowConfigEditorPanel } from './panel.js'
import { StartWorkflowButton } from './start-modal.js'
import { callEditor, readWorkflowCatalog } from './rpc.js'
import { readModelCatalog } from './model-selector.js'

export const PANEL_KEY = 'workflow-config-editor'

/** 对话输入工具区启动按钮注册（session-scoped list，不替换 composer）。 */
export const START_BUTTON_ID = 'dsh-workflow-start'

/** 设置导航位置：宿主现有 section 为 account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20)，配置编辑器放后段。 */
export const SETTINGS_SECTION_ORDER = 50

/** 浏览器侧 Cordis 依赖：slot 注册表、Connection RPC 通道、命令通道。 */
export const inject = ['slots', 'connection', 'remote', 'remote.session', 'remote.commands']

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
  const injected = () => ({ editorRpc, loadModels, loadCatalog })

  // #179 对话输入工具区启动按钮（session-scoped list：只占左工具位，不替换 composer，
  // 无 DOM 注入；弹窗归属打开它的 Session，标准会话 props 由宿主按 slot 契约提供）。
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: START_BUTTON_ID, order: 100, label: '启动工作流' },
      (props) => StartWorkflowButton({ ...props, loadCatalog, runCommand }),
    ),
  )

  // #219 设置页入口：宿主 ui-settings 的设置外壳渲染导航与关闭，本插件只注册一页内容
  // （list：id 沿用旧面板 key，order 放导航后段）。
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: PANEL_KEY, order: SETTINGS_SECTION_ORDER, label: '工作流配置', inject: injected },
      WorkflowConfigEditorPanel,
    ),
  )
}
