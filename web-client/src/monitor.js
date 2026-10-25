/**
 * #251 运行监控右侧栏 tab 组件：可见时每 2s 轮询 status，不可见暂停；
 * RPC 失败显示横幅并保留上一次成功数据，恢复后自动清横幅继续轮询。
 * 只读展示：run 信息条 + 启动 prompt 展开 + 节点列表；无任何控制入口（ADR-0005）。
 */
import { createElement as h, useState, useEffect, useRef } from 'react'
import { monitorViewModel, monitorErrorState } from './monitor-view.js'
import { NodeCanvas } from './graph-canvas.js'
import { EDITOR_STYLES } from './styles.js'

const POLL_INTERVAL_MS = 2000

export const MONITOR_STYLES = `
.wf-monitor { font-size: 13px; color: var(--dsh-text, #ddd); padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.wf-monitor-banner { background: #5c2b2b; color: #ffd9d9; padding: 6px 8px; border-radius: 6px; }
.wf-monitor-status { font-weight: 600; }
.wf-monitor-status.run-blocked { color: #ffb4b4; }
.wf-monitor-status.run-ok { color: #9fdca4; }
.wf-monitor-muted { opacity: 0.7; }
.wf-monitor-prompt { white-space: pre-wrap; background: rgba(128,128,128,0.12); border-radius: 6px; padding: 6px 8px; }
.wf-monitor-nodes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wf-monitor-node { display: flex; gap: 6px; align-items: baseline; padding: 3px 6px; border-radius: 4px; }
.wf-monitor-node.wf-node-current { background: rgba(120,160,255,0.18); }
.wf-node-phase.phase-working { color: #ffd479; }
.wf-node-phase.phase-checking { color: #9fc8ff; }
.wf-node-phase.phase-settling { color: #c9a6ff; }
.wf-node-phase.phase-exited { color: #9fdca4; }
.wf-node-phase.phase-ready { opacity: 0.7; }
.wf-node-block { color: #ffb4b4; }
/* #252 运行图：复用配置编辑器画布样式，只读展示；侧栏里给固定高度并允许缩放/平移。 */
.wf-monitor-graph { display: flex; flex-direction: column; gap: 4px; }
.wf-monitor-graph .wf-editor.wf-monitor-canvas { height: auto; padding: 0; gap: 0; background: transparent; overflow: hidden; }
.wf-monitor-graph .wf-canvas { height: 420px; min-height: 320px; }
.wf-monitor-graph .wf-canvas-help { margin-top: 4px; }
.wf-monitor-flowtabs { display: flex; gap: 4px; flex-wrap: wrap; }
.wf-monitor-flowtabs button { padding: 3px 8px; font-size: 12px; }
.wf-monitor-flowtabs button[aria-selected="true"] { border-color: #3b82f6; color: #1d4ed8; background: #e8efff; }
`

/** 轮询驱动（抽出便于测试）：visible=false 或页面隐藏时暂停。 */
export function useMonitorPolling(fetchStatus, enabled) {
  const [data, setData] = useState(null)
  const [banner, setBanner] = useState('')
  // 轮询不离散：scope.cwd 变化时更新闭包，但不重启 2s 周期（R1 F4）。
  const fetchRef = useRef(fetchStatus)
  useEffect(() => { fetchRef.current = fetchStatus }, [fetchStatus])
  useEffect(() => {
    if (!enabled) return undefined
    let disposed = false
    let timer
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const result = await fetchRef.current()
          if (disposed) return
          if (result?.ok) { setData(result.value); setBanner('') } else { setBanner(prev => monitorErrorState(prev, result?.error?.message ?? String(result?.error?.code ?? 'monitor failed'))) }
        } catch (error) {
          if (!disposed) setBanner(prev => monitorErrorState(prev, String(error)))
        }
      }
      if (!disposed) timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
    tick()
    return () => { disposed = true; clearTimeout(timer) }
  }, [enabled])
  return { data, banner }
}

export function WorkflowMonitorTab({ fetchStatus, visible = true }) {
  const { data, banner } = useMonitorPolling(fetchStatus, visible !== false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [activeFlow, setActiveFlow] = useState(null)
  const view = monitorViewModel(data, { banner })
  // 横幅在全部模式（loading/maintenance/empty/run）都渲染：首轮失败必须可见（R1 F5）。
  const bannerEl = view.banner !== ''
    ? h('div', { className: 'wf-monitor-banner' }, `状态刷新失败（保留上次数据）：${view.banner}`)
    : null
  // 宿主 client bundle 不做 JSX 转译：统一 createElement（与 panel.js 同约定）。
  const frame = (...children) => h('div', { className: 'wf-monitor' }, bannerEl, ...children)
  if (view.mode === 'loading') {
    return frame(h('div', { className: 'wf-monitor-muted' }, '正在加载运行状态…'))
  }
  if (view.mode === 'maintenance') {
    return frame(h('div', { className: 'wf-monitor-banner' }, `状态库维护模式：${view.reason}`))
  }
  if (view.mode === 'empty') {
    return frame(h('div', { className: 'wf-monitor-muted' }, '当前 workspace 没有工作流运行记录。'))
  }
  const run = view.run
  const graph = run.graph ?? null
  const flow = graph === null
    ? null
    : graph.flows.find(item => item.id === activeFlow) ?? graph.flows.find(item => item.id === graph.currentFlowId) ?? graph.flows[0] ?? null
  return h('div', { className: 'wf-monitor' },
    bannerEl,
    h('div', null,
      h('span', { className: `wf-monitor-status ${run.statusClass}` }, run.statusLabel),
      run.blockReason ? h('span', { className: 'wf-node-block' }, ` — ${run.blockReason}`) : null,
      run.businessReturn ? h('span', { className: 'wf-monitor-muted' }, ` · 返回：${run.businessReturn}`) : null,
    ),
    h('div', { className: 'wf-monitor-muted' },
      h('div', null, `工作流：${run.workflowId} · Run：${run.runId}`),
      h('div', null, `开始：${run.startedAtText ?? '—'} · ${run.durationLabel}：${run.durationText ?? '—'}`),
    ),
    run.roles !== '' ? h('div', { className: 'wf-monitor-muted' }, `角色模型：${run.roles}`) : null,
    graph !== null && flow !== null ? h('div', { className: 'wf-monitor-graph' },
      h('style', null, EDITOR_STYLES),
      graph.flows.length > 1 ? h('div', { className: 'wf-monitor-flowtabs', role: 'tablist', 'aria-label': '流程切换' },
        ...graph.flows.map(item => h('button', {
          key: item.id, type: 'button', role: 'tab', 'aria-selected': item.id === flow.id, onClick: () => setActiveFlow(item.id),
        }, item.label))) : null,
      h('div', { className: 'wf-editor wf-monitor-canvas' },
        h(NodeCanvas, {
          key: `${run.runId}:${flow.id}`,
          readOnly: true,
          flowId: flow.id === run.workflowId ? null : flow.id,
          def: flow.def,
          positions: flow.positions,
          startNode: flow.def.startNode,
          returns: flow.def.returns,
          decorations: flow.decorations,
        })),
    ) : null,
    h('div', null,
      h('button', { type: 'button', onClick: () => setPromptOpen(open => !open) }, promptOpen ? '收起启动 prompt' : '展开启动 prompt'),
      promptOpen ? h('div', { className: 'wf-monitor-prompt' }, run.launchPrompt) : null,
    ),
    h('ul', { className: 'wf-monitor-nodes' },
      ...view.nodes.map(node => h('li', { key: node.key, className: `wf-monitor-node${node.current ? ' wf-node-current' : ''}` },
        h('span', null, node.label),
        node.role !== null || node.modelText !== ''
          ? h('span', { className: 'wf-monitor-muted' }, [node.role, node.modelText].filter(Boolean).join(' · '))
          : null,
        node.targetText !== null ? h('span', { className: 'wf-monitor-muted' }, node.targetText) : null,
        h('span', { className: `wf-node-phase ${node.phaseClass}` }, node.phaseLabel),
        node.blocked ? h('span', { className: 'wf-node-block' }, `BLOCK：${node.blockReason}`) : null,
      ))),
  )
}
