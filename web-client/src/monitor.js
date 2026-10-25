/**
 * #251 运行监控右侧栏 tab 组件：可见时每 2s 轮询 status，不可见暂停；
 * RPC 失败显示横幅并保留上一次成功数据，恢复后自动清横幅继续轮询。
 * 只读展示：run 信息条 + 启动 prompt 展开 + 节点列表；无任何控制入口（ADR-0005）。
 */
import { useState, useEffect } from 'react'
import { monitorViewModel, monitorErrorState } from './monitor-view.js'

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
`

/** 轮询驱动（抽出便于测试）：visible=false 或页面隐藏时暂停。 */
export function useMonitorPolling(fetchStatus, enabled) {
  const [data, setData] = useState(null)
  const [banner, setBanner] = useState('')
  useEffect(() => {
    if (!enabled) return undefined
    let disposed = false
    let timer
    const tick = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const result = await fetchStatus()
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
  const view = monitorViewModel(data)
  if (view.mode === 'loading') return <div className="wf-monitor">正在加载运行状态…</div>
  if (view.mode === 'maintenance') {
    return <div className="wf-monitor"><div className="wf-monitor-banner">状态库维护模式：{view.reason}</div></div>
  }
  if (view.mode === 'empty') return <div className="wf-monitor"><div className="wf-monitor-muted">当前 workspace 没有工作流运行记录。</div></div>
  const run = view.run
  return (
    <div className="wf-monitor">
      {banner !== '' && <div className="wf-monitor-banner">状态刷新失败（保留上次数据）：{banner}</div>}
      <div>
        <span className={`wf-monitor-status ${run.statusClass}`}>{run.statusLabel}</span>
        {run.blockReason && <span className="wf-node-block"> — {run.blockReason}</span>}
        {run.businessReturn && <span className="wf-monitor-muted"> · 返回：{run.businessReturn}</span>}
      </div>
      {run.roles !== '' && <div className="wf-monitor-muted">角色模型：{run.roles}</div>}
      <div>
        <button type="button" onClick={() => setPromptOpen(open => !open)}>
          {promptOpen ? '收起启动 prompt' : '展开启动 prompt'}
        </button>
        {promptOpen && <div className="wf-monitor-prompt">{run.launchPrompt}</div>}
      </div>
      <ul className="wf-monitor-nodes">
        {view.nodes.map(node => (
          <li key={node.key} className={`wf-monitor-node${node.current ? ' wf-node-current' : ''}`}>
            <span>{node.label}</span>
            <span className={`wf-node-phase ${node.phaseClass}`}>{node.phaseLabel}</span>
            {node.blocked && <span className="wf-node-block">{node.blockReason}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
