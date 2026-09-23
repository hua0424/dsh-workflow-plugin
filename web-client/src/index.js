/**
 * T1 客户端入口：宿主模块加载器 factory 格式（见 web-client/build.mjs）。
 *
 * 正式接入：root `main` keyed slot 注册全局面板 + `sidebar.panellist` 入口；
 * 无 DOM 注入，不另起服务器，不修改宿主。React 由宿主共享实例提供
 * （module-table baseline：react / react-dom / @deepseek-ai/cordis），
 * 本 bundle 不打包第二份 React；React Flow 等非宿主依赖随客户端提供（pending，见 README）。
 *
 * 注册选项形状（keyed 的 key / list 的 id+order+label）以宿主
 * `packages/client/ui-layout` 与 `packages/client/ui-sidebar` 的 SlotMap/contract
 * 及运行期 `cordis_inspect what:"client"` 为准，集成时以生成目录为准复核。
 */
import { WorkflowConfigEditorIcon, WorkflowConfigEditorPanel } from './panel.js'
import { callEditor } from './rpc.js'

export const PANEL_KEY = 'workflow-config-editor'

/** 浏览器侧 Cordis 依赖：slot 注册表、主面板控制器、Connection RPC 通道。 */
export const inject = ['slots', 'layout', 'connection']

export function apply(ctx) {
  const editorRpc = (endpoint, payload, signal) => callEditor(ctx.connection, endpoint, payload, signal)
  const injected = () => ({ editorRpc })

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
}
