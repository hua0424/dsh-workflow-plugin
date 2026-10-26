/**
 * #251 运行监控右侧栏 tab 组件：可见时每 2s 轮询 status，不可见暂停；
 * RPC 失败显示横幅并保留上一次成功数据，恢复后自动清横幅继续轮询。
 * #261：轮询上下文 = (scope.cwd, 选定 runId)，切目录/切 Run/重新可见都重建周期，
 * 旧上下文的在途响应一律丢弃；终态 Run 停周期，另给只读「刷新状态」入口。
 * 只读展示：run 信息条 + 启动 prompt 展开 + 节点列表；无任何控制入口（ADR-0005）。
 */
import { createElement as h, useState, useEffect, useRef } from 'react'
import { monitorViewModel, monitorErrorState, monitorPollingContinues, initialFollowState, monitorFollowView, selectFlow, resumeFollow, RECORD_COLUMNS } from './monitor-view.js'
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
/* #253 子流程下钻：面包屑导航 + 暂停跟随后的「回到当前节点」入口。 */
.wf-monitor-breadcrumb { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 12px; }
.wf-monitor-breadcrumb button { padding: 2px 6px; font-size: 12px; border: 1px solid transparent; background: transparent; color: inherit; }
.wf-monitor-breadcrumb button.is-current { border-color: #3b82f6; color: #1d4ed8; background: #e8efff; }
.wf-monitor-sep { opacity: 0.6; }
.wf-monitor-return { align-self: flex-start; padding: 3px 8px; font-size: 12px; border-color: #3b82f6; color: #1d4ed8; }
/* #254 多 Run 切换器 / 空态 / 终态提示。 */
.wf-monitor-switcher { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.wf-monitor-switcher select { max-width: 100%; padding: 2px 4px; font-size: 12px; }
.wf-monitor-guidance { background: rgba(128,128,128,0.12); border-radius: 6px; padding: 8px; white-space: pre-wrap; }
.wf-monitor-terminal-note { color: #9fc8ff; font-size: 12px; }
.wf-monitor-maintenance { white-space: pre-wrap; }
/* #261 只读刷新入口：终态停周期后由用户决定何时重新读取。 */
.wf-monitor-toolbar { display: flex; justify-content: flex-end; }
.wf-monitor-refresh { padding: 2px 8px; font-size: 12px; }
/* #274 当前执行卡：图下独立区块，一眼看清谁在干活、用什么模型、来源阶段。 */
.wf-monitor-current { display: flex; flex-direction: column; gap: 4px; background: rgba(128,128,128,0.12); border-left: 3px solid #3b82f6; border-radius: 6px; padding: 8px; }
.wf-monitor-current.is-terminal { border-left-color: #8a8a8a; }
.wf-monitor-card-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.wf-monitor-card-title { font-size: 14px; }
.wf-monitor-card-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.wf-monitor-card-role { min-width: 96px; opacity: 0.85; }
.wf-monitor-card-state { font-weight: 600; }
.wf-monitor-card-terminal { color: #9fc8ff; font-weight: 600; }
/* #275 执行记录表：固定列序，表头吸顶、节点/流程两列吸附左侧，横向滚动不丢失行身份。 */
.wf-monitor-records { display: flex; flex-direction: column; gap: 4px; }
.wf-monitor-records-title { font-weight: 600; font-size: 13px; }
.wf-monitor-records-scroll { overflow: auto; max-height: 360px; border: 1px solid rgba(128,128,128,0.3); border-radius: 6px; }
.wf-record-table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; }
.wf-record-table th, .wf-record-table td { padding: 4px 6px; text-align: left; white-space: nowrap; border-bottom: 1px solid rgba(128,128,128,0.2); }
.wf-record-table thead th { position: sticky; top: 0; z-index: 3; background: Canvas; border-bottom: 1px solid rgba(128,128,128,0.45); }
.wf-record-table .wf-record-sticky-1 { position: sticky; left: 0; z-index: 2; background: Canvas; width: 168px; min-width: 168px; max-width: 168px; overflow: hidden; text-overflow: ellipsis; }
.wf-record-table .wf-record-sticky-2 { position: sticky; left: 168px; z-index: 2; background: Canvas; min-width: 96px; box-shadow: 1px 0 0 rgba(128,128,128,0.35); }
.wf-record-table thead .wf-record-sticky-1, .wf-record-table thead .wf-record-sticky-2 { z-index: 4; }
.wf-record-table tbody .wf-record-sticky-1, .wf-record-table tbody .wf-record-sticky-2 { background: Canvas; }
.wf-record-row.is-blocked td { background: rgba(200,80,80,0.12); }
.wf-record-row.is-current td { background: rgba(120,160,255,0.14); }
.wf-record-toggle { padding: 0 4px; font-size: 11px; border: 1px solid rgba(128,128,128,0.5); background: transparent; color: inherit; margin-right: 4px; }
.wf-record-node { font-weight: 600; }
.wf-record-detail td { background: rgba(128,128,128,0.08); white-space: normal; }
.wf-record-rounds { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
`

/** 轮询上下文键：cwd + 选定 runId 决定一个独立读取周期；用值而非函数身份，重渲染不重启周期（#261）。 */
function pollContextKey(cwd, runId) {
  return `${cwd ?? ''}\u0000${runId ?? ''}`
}

const IDLE_POLL_STATE = { key: null, data: null, banner: '', refreshing: false }

/**
 * 轮询驱动（抽出便于测试），上下文 = (scope.cwd, 选定 runId)：
 * - 可见时每 2s 读取；document 隐藏期间不发请求；终态停周期，运行中/BLOCK/空态/维护态继续。
 * - 上下文变化、tab 隐藏或卸载时旧在途响应一律丢弃：不写数据/横幅，也不启停别人的定时器。
 * - refresh()：只读手动刷新，同上下文在途请求合并；返回活跃/空态/维护态后恢复周期。
 * - 数据与横幅带上下文键：切目录/切 Run 的当次渲染就读不到旧目录数据（不等 effect 擦除）。
 */
export function useMonitorPolling(fetchStatus, options = {}) {
  const enabled = options.enabled !== false
  const cwd = typeof options.cwd === 'string' ? options.cwd : null
  const runId = typeof options.runId === 'string' ? options.runId : null
  const key = pollContextKey(cwd, runId)
  const [state, setState] = useState({ ...IDLE_POLL_STATE, key })
  const fetchRef = useRef(fetchStatus)
  const refreshRef = useRef(null)
  // 每次渲染新建的闭包只更新引用，不参与周期依赖（R1 F4：函数身份不重启轮询）。
  useEffect(() => { fetchRef.current = fetchStatus }, [fetchStatus])
  useEffect(() => {
    if (!enabled) { refreshRef.current = null; return undefined }
    let disposed = false
    let timer
    let busy = false
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const stop = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
    const schedule = () => { stop(); if (!disposed) timer = setTimeout(tick, POLL_INTERVAL_MS) }
    const read = async (manual) => {
      if (disposed) return
      // 同上下文在途刷新合并成一次，不叠加请求；手动点击在结果回来前给按钮即时反馈。
      if (manual) setState(prev => (prev.key === key ? { ...prev, refreshing: true } : prev))
      if (busy) return
      stop()
      busy = true
      let payload
      let errorText = ''
      try {
        const result = await fetchRef.current(runId)
        if (result?.ok) payload = result.value
        else errorText = String(result?.error?.message ?? result?.error?.code ?? 'monitor failed')
      } catch (error) {
        errorText = String(error)
      }
      // 卸载或上下文已切换（本周期被 dispose）：旧响应静默丢弃。
      if (disposed) return
      busy = false
      if (payload !== undefined) {
        setState({ key, data: payload, banner: '', refreshing: false })
        // 终态停周期；其余模式继续（维护态恢复、空态等新 Run 都靠它自愈，见 monitorPollingContinues）。
        if (!monitorPollingContinues(payload)) return
      } else {
        // 失败：只保留同一上下文最后成功数据，横幅提示，下一轮自动重试。
        setState(prev => ({
          key,
          data: prev.key === key ? prev.data : null,
          banner: monitorErrorState(prev.key === key ? prev.banner : '', errorText),
          refreshing: false,
        }))
      }
      schedule()
    }
    const tick = () => {
      if (disposed) return
      // 页面隐藏：不发请求，保留周期让回到可见后自愈（visibilitychange 另外立即读一次）。
      if (hidden()) { schedule(); return }
      void read(false)
    }
    // 重新可见读一次：隐藏期或在途时不叠加；终态上下文的这次读取只是复用同一周期规则。
    const wake = () => { if (disposed || busy || hidden()) return; void read(false) }
    refreshRef.current = () => { if (!disposed) void read(true) }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake)
    void read(false)
    return () => {
      disposed = true
      refreshRef.current = null
      stop()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake)
    }
  }, [enabled, key])
  const current = state.key === key ? state : IDLE_POLL_STATE
  return {
    data: current.data,
    banner: current.banner,
    refreshing: current.refreshing,
    refresh: () => { const invoke = refreshRef.current; if (invoke !== null) invoke() },
  }
}

/** #274 当前执行卡：节点为主标题，Actor/Judge 的模型·来源·状态分行显示；无事实的字段不渲染。 */
function currentCardEl(card) {
  if (card === null || card === undefined) return null
  const row = (name, entry) => h('div', { className: 'wf-monitor-card-row' },
    h('span', { className: 'wf-monitor-card-role' }, name),
    entry.modelText === null || entry.modelText === ''
      ? null
      : h('span', { className: 'wf-monitor-muted', title: entry.modelText }, entry.modelText),
    // #274 重派后的旧轮：另起一段标注「上一轮 …」，当前轮不因此变色/移位。
    entry.previousText === null || entry.previousText === undefined
      ? null
      : h('span', { className: 'wf-monitor-muted wf-monitor-card-prev', title: entry.previousText }, entry.previousText),
    h('span', { className: 'wf-monitor-card-state' }, entry.status))
  return h('div', {
    className: `wf-monitor-current${card.active ? '' : ' is-terminal'}`,
    role: 'region',
    'aria-label': card.heading,
    'data-execution-id': card.executionId ?? '',
  },
  h('div', { className: 'wf-monitor-card-head' },
    h('strong', { className: 'wf-monitor-card-title' }, `${card.heading}：${card.nodeId}`),
    h('span', { className: 'wf-monitor-muted' }, [card.workflowLabel, card.visitText].filter(Boolean).join(' · ')),
    h('span', { className: `wf-node-phase ${card.phaseClass}` }, card.phaseLabel),
    card.active ? null : h('span', { className: 'wf-monitor-card-terminal' }, card.terminalLabel)),
  card.targetText === null ? null : h('div', { className: 'wf-monitor-muted' }, card.targetText),
  card.actor === null ? null : row(`Actor（${card.actor.role ?? '—'}）`, card.actor),
  card.judge === null ? null : row('Judge', card.judge),
  card.blocked ? h('div', { className: 'wf-node-block' }, `BLOCK：${card.blockReason}`) : null)
}

/** #275 执行记录表下钻：同一次进入内的多轮提交/判定、未形成提交的重派与换模时间线。 */
function recordDetailEl(record) {
  const items = []
  if (record.blockReason !== null && record.blockReason !== '') items.push(h('li', { key: 'block', className: 'wf-node-block' }, `BLOCK：${record.blockReason}`))
  for (const round of record.drilldown.rounds) {
    const times = [`提交 ${round.submittedAtText ?? '时间未记录'}`, round.judgedAtText === null ? null : `判定 ${round.judgedAtText}`].filter(Boolean).join(' · ')
    items.push(h('li', { key: round.claimId }, `第 ${round.index} 轮：${round.resultText} · ${round.statusText} · ${times} · Actor ${round.actorModelText} · Judge ${round.judgeModelText}`))
  }
  if (record.drilldown.pending !== undefined) items.push(h('li', { key: 'pending' }, `第 ${record.drilldown.pending.index} 轮：${record.drilldown.pending.statusText} · Actor ${record.drilldown.pending.actorModelText}`))
  for (const [index, attempt] of record.drilldown.abandoned.entries()) {
    items.push(h('li', { key: `abandoned-${index}`, className: 'wf-monitor-muted' }, `未形成提交的派发：${attempt.reasonText} · ${attempt.modelText}${attempt.atText === null ? '' : ` · ${attempt.atText}`}`))
  }
  for (const [index, switchEvent] of record.drilldown.switches.entries()) {
    items.push(h('li', { key: `switch-${index}`, className: 'wf-monitor-muted' }, `${switchEvent.roleText}${switchEvent.atText === null ? '' : `：${switchEvent.atText}`}`))
  }
  return h('ul', { className: 'wf-record-rounds' }, ...items)
}

/** #275 执行记录表：每次进入一行，同一次进入的多轮事实收在行下钻里。 */
function recordsEl(records, openKey, onToggle) {
  if (!Array.isArray(records) || records.length === 0) return null
  const cell = (record, name) => {
    if (name === '节点名称') {
      const expanded = openKey === record.key
      return h('td', { key: name, className: 'wf-record-sticky-1' },
        h('button', {
          type: 'button',
          className: 'wf-record-toggle',
          'aria-expanded': expanded ? 'true' : 'false',
          'aria-label': `${expanded ? '收起' : '展开'} ${record.nodeLabel} 的提交/判定明细`,
          onClick: () => onToggle(record.key),
        }, expanded ? '▾' : '▸'),
        h('span', { className: 'wf-record-node', title: record.nodeId }, record.nodeLabel),
        record.visitText !== '' ? h('span', { className: 'wf-monitor-muted' }, ` ${record.visitText}`) : null)
    }
    if (name === '所属流程') return h('td', { key: name, className: 'wf-record-sticky-2', title: record.workflowLabel }, record.flowText)
    if (name === '运行情况') {
      return h('td', { key: name },
        record.outcomeText,
        record.roundCountText === null ? null : h('span', { className: 'wf-monitor-muted' }, ` · ${record.roundCountText}`),
        record.waitingText === null ? null : h('span', { className: 'wf-monitor-muted' }, ` · ${record.waitingText}`))
    }
    if (name === '进入时间') return h('td', { key: name }, record.enteredAtText ?? '—')
    if (name === '提交结果时间') return h('td', { key: name }, record.submittedAtText)
    if (name === '提交判定时间') return h('td', { key: name }, record.judgedAtText)
    if (name === 'Actor 模型') return h('td', { key: name, title: record.actorModelText }, record.actorModelText)
    return h('td', { key: name, title: record.judgeModelText }, record.judgeModelText)
  }
  return h('section', { className: 'wf-monitor-records', 'aria-label': '执行记录' },
    h('div', { className: 'wf-monitor-records-title' }, `执行记录（${records.length} 次进入）`),
    h('div', { className: 'wf-monitor-records-scroll' },
      h('table', { className: 'wf-record-table' },
        h('thead', null,
          h('tr', null, ...RECORD_COLUMNS.map((name, index) => h('th', {
            key: name,
            scope: 'col',
            className: index === 0 ? 'wf-record-sticky-1' : index === 1 ? 'wf-record-sticky-2' : '',
          }, name)))),
        h('tbody', null,
          ...records.flatMap(record => {
            const expanded = openKey === record.key
            const row = h('tr', {
              key: record.key,
              className: `wf-record-row${record.blocked ? ' is-blocked' : ''}${record.current === true ? ' is-current' : ''}`,
            }, ...RECORD_COLUMNS.map(name => cell(record, name)))
            if (!expanded) return [row]
            return [row, h('tr', { key: `${record.key}:detail`, className: 'wf-record-detail' },
              h('td', { colSpan: RECORD_COLUMNS.length }, recordDetailEl(record)))]
          })))),
  )
}

export function WorkflowMonitorTab({ fetchStatus, visible = true, scope }) {
  // 目录只来自 tab scope.cwd；缺席/空串不回退宿主 process.cwd（R1 F4）。
  const cwd = typeof scope?.cwd === 'string' && scope.cwd !== '' ? scope.cwd : null
  // 选择与目录绑在一起：cwd 变化即回到「当前目录（默认）」，不等 effect 事后纠正（#261）。
  const [selection, setSelection] = useState({ cwd, runId: null })
  const selectedRunId = selection.cwd === cwd ? selection.runId : null
  const [promptOpen, setPromptOpen] = useState(false)
  const [follow, setFollow] = useState(initialFollowState)
  // #275 执行记录表下钻：一次只展开一行；Run 变化时收起（行 key 含 runId 之外的身份，显式重置更稳）。
  const [openRecord, setOpenRecord] = useState(null)
  // 维护态继续探测、终态停周期、只读手动刷新都在 hook 里（#261）。
  const { data, banner, refreshing, refresh } = useMonitorPolling(
    runId => fetchStatus(runId),
    { enabled: visible !== false, cwd, runId: selectedRunId },
  )
  const view = monitorViewModel(data, { banner })
  const returnedRunId = view.mode === 'run' || view.mode === 'terminal' ? view.run.runId : null
  // 实际返回的 Run 变化（新 Run / 切目录 / 刷新到别的 Run）：跟随与手动流程选择回到默认。
  useEffect(() => { setFollow(initialFollowState()) }, [returnedRunId, cwd])
  // 换 Run/换目录时收起旧 Run 的下钻，避免同名节点行在新 Run 里意外展开。
  useEffect(() => { setOpenRecord(null) }, [returnedRunId, cwd])
  // 选中的 Run 失效/回退到 cwd 默认：清掉选择，避免切换器值悬空（loading/维护态下保留选择）。
  const selectionLost = selectedRunId !== null && view.mode !== 'loading' && view.mode !== 'maintenance'
    && !view.runs.some(ref => ref.runId === selectedRunId)
  useEffect(() => { if (selectionLost) setSelection({ cwd, runId: null }) }, [selectionLost, cwd])
  // 横幅在全部模式（loading/maintenance/empty/run）都渲染：首轮失败必须可见（R1 F5）。
  const bannerEl = view.banner !== ''
    ? h('div', { className: 'wf-monitor-banner' }, `状态刷新失败（保留上次数据）：${view.banner}`)
    : null
  // 宿主 client bundle 不做 JSX 转译：统一 createElement（与 panel.js 同约定）。
  // better-sidebar 的 descriptor 不支持 styles 字段，样式随组件内联注入。
  const styleEl = h('style', null, MONITOR_STYLES)
  // 只读「刷新状态」：每个模式都可用；终态停周期后这是发现同目录新 Run 的唯一入口（#261）。
  const refreshEl = h('div', { className: 'wf-monitor-toolbar' },
    h('button', {
      type: 'button',
      className: 'wf-monitor-refresh',
      disabled: refreshing,
      'aria-busy': refreshing ? 'true' : 'false',
      title: '只读刷新：重新读取当前目录的运行状态，不启动也不停止 Run',
      onClick: () => refresh(),
    }, refreshing ? '正在刷新…' : '刷新状态'))
  const frame = (...children) => h('div', { className: 'wf-monitor' }, styleEl, bannerEl, refreshEl, ...children)
  // #254 切换器：默认「当前目录」，另列全部活跃 Run（跨 workspace）；选中项变化即重置轮询/跟随。
  const switcher = view.runs.length === 0 ? null : h('label', { className: 'wf-monitor-switcher' },
    '运行：',
    h('select', {
      value: selectedRunId ?? '',
      onChange: event => setSelection({ cwd, runId: event.target.value === '' ? null : event.target.value }),
      'aria-label': '切换运行',
    },
    h('option', { value: '' }, '当前目录（默认）'),
    ...view.runs.map(ref => h('option', { key: ref.runId, value: ref.runId }, `${ref.label} · ${ref.statusLabel}`))))
  if (view.mode === 'loading') {
    return frame(h('div', { className: 'wf-monitor-muted' }, '正在加载运行状态…'))
  }
  if (view.mode === 'maintenance') {
    return frame(h('div', { className: 'wf-monitor-banner wf-monitor-maintenance' }, `状态库维护模式：\n${view.reason}`))
  }
  if (view.mode === 'empty') {
    return frame(
      switcher,
      h('div', { className: 'wf-monitor-guidance' }, view.guidance ?? '当前目录没有工作流运行记录。'),
    )
  }
  const run = view.run
  const graph = run.graph ?? null
  const currentFlowId = graph?.currentFlowId ?? run.workflowId
  const followView = monitorFollowView(follow, currentFlowId)
  const callPath = graph?.callPath ?? { frames: [] }
  const flow = graph === null
    ? null
    : graph.flows.find(item => item.id === followView.activeFlowId) ?? graph.flows.find(item => item.id === currentFlowId) ?? graph.flows[0] ?? null
  return h('div', { className: 'wf-monitor' },
    styleEl,
    bannerEl,
    refreshEl,
    switcher,
    h('div', null,
      h('span', { className: `wf-monitor-status ${run.statusClass}` }, run.statusLabel),
      run.blockReason ? h('span', { className: 'wf-node-block' }, ` — ${run.blockReason}`) : null,
      run.businessReturn ? h('span', { className: 'wf-monitor-muted' }, ` · 返回：${run.businessReturn}`) : null,
    ),
    // 终态提示在视图模型顶层（view.terminalNote），历史上误读 run.terminalNote 导致从不渲染（#261 修正）。
    view.terminalNote ? h('div', { className: 'wf-monitor-muted' }, view.terminalNote) : null,
    h('div', { className: 'wf-monitor-muted' },
      h('div', null, `工作流：${run.workflowId} · Run：${run.runId}`),
      h('div', null, `开始：${run.startedAtText ?? '—'} · ${run.durationLabel}：${run.durationText ?? '—'}`),
    ),
    run.roles !== '' ? h('div', { className: 'wf-monitor-muted' }, `角色模型：${run.roles}`) : null,
    graph !== null && flow !== null ? h('div', { className: 'wf-monitor-graph' },
      h('style', null, EDITOR_STYLES),
      callPath.frames.length > 1 ? h('div', { className: 'wf-monitor-breadcrumb', role: 'navigation', 'aria-label': '流程路径' },
        ...callPath.frames.flatMap((frame, index) => [
          index > 0 ? h('span', { key: `sep-${index}`, className: 'wf-monitor-sep', 'aria-hidden': 'true' }, '›') : null,
          h('button', {
            key: `crumb-${index}`,
            type: 'button',
            className: frame.workflowId === flow.id ? 'is-current' : '',
            title: `调用节点 ${frame.nodeLabel}`,
            onClick: () => setFollow(selectFlow(follow, frame.workflowId, currentFlowId)),
          }, frame.label),
        ])) : null,
      graph.flows.length > 1 ? h('div', { className: 'wf-monitor-flowtabs', role: 'tablist', 'aria-label': '流程切换' },
        ...graph.flows.map(item => h('button', {
          key: item.id, type: 'button', role: 'tab', 'aria-selected': item.id === flow.id, onClick: () => setFollow(selectFlow(follow, item.id, currentFlowId)),
        }, item.label))) : null,
      followView.showReturn ? h('button', { type: 'button', className: 'wf-monitor-return', onClick: () => setFollow(resumeFollow()) }, '回到当前节点') : null,
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
          // AC1：点击子流程节点直接下钻；普通节点点击不改变跟随状态。
          onSelectNode: (nodeId) => {
            // 画布 NodeDef 的子流程目标在 execution.workflowId（graphOf 归一化），不是 childWorkflowId。
            const execution = flow.def.nodes?.[nodeId]?.execution
            const child = execution?.type === 'child-workflow' ? execution.workflowId : undefined
            if (child && graph.flows.some(item => item.id === child)) setFollow(selectFlow(follow, child, currentFlowId))
          },
        })),
    ) : null,
    // #274 当前执行卡：图下独立区块，始终指向当前（或结束）工作单；与选中/流程切换无关。
    currentCardEl(view.currentExecution),
    // #275 执行记录表：每次进入一行；多轮提交/判定、未形成提交的重派与换模收在行下钻。
    recordsEl(view.records, openRecord, key => setOpenRecord(current => (current === key ? null : key))),
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
        node.visit > 1 ? h('span', { className: 'wf-monitor-muted' }, `第${node.visit}次`) : null,
        node.blocked ? h('span', { className: 'wf-node-block' }, `BLOCK：${node.blockReason}`) : null,
      ))),
  )
}
