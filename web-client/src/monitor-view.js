/**
 * #251 运行监控视图模型（纯函数，可单测）：服务端 status payload → 渲染所需的
 * 展示形状（run 信息条、启动 prompt 展开、节点列表行）。不做任何 IO/状态。
 * RPC 失败时的行为也在这里定为纯逻辑：横幅显示错误、数据沿用上一次成功结果
 * （monitorErrorState），恢复由组件在下一次成功轮询时清掉横幅。
 *
 * 所有模式都携带 banner：首轮就失败时 loading/empty 也必须看得到错误，
 * 不能永远停在「正在加载」（R1 F5）。
 */

/** phase → 中文标签与样式类。 */
export const PHASE_LABELS = {
  ready: ['就绪', 'phase-ready'],
  working: ['执行中', 'phase-working'],
  checking: ['审查中', 'phase-checking'],
  settling: ['结算中', 'phase-settling'],
  exited: ['已完成', 'phase-exited'],
}

/**
 * 单个工作单 → 画布节点叠加态（#252）：BLOCK 原因优先（引擎可能停在任一时相），
 * 其次是当前焦点、终态完成、其余按 phase。无工作单返回 null（节点未运行）。
 */
export function monitorNodeState(execution) {
  if (execution === null || execution === undefined) return null
  const [phaseLabel, phaseClass] = phaseOf(execution.phase)
  const visit = typeof execution.visit === 'number' ? execution.visit : 1
  const redo = visit > 1
  const redoDetail = redo ? `第 ${visit} 次执行` : ''
  const blocked = typeof execution.blockReason === 'string' && execution.blockReason !== ''
  if (blocked) return { className: 'wf-node-blocked', badge: 'BLOCK', detail: [execution.blockReason, redoDetail].filter(Boolean).join(' · '), phaseClass, visit, redo }
  if (execution.current === true) return { className: 'wf-node-current', badge: '当前', detail: redoDetail, phaseClass, visit, redo }
  if (execution.phase === 'exited') return { className: 'wf-node-completed', badge: phaseLabel, detail: redoDetail, phaseClass, visit, redo }
  return { className: `wf-node-${execution.phase}`, badge: phaseLabel, detail: redoDetail, phaseClass, visit, redo }
}

/**
 * callStack → 当前路径 + 多层 breadcrumb（#253）：栈底为根流程、栈顶为当前节点。
 * 每帧给出流程标签与调用节点标签；递归调用同一 workflowId 时按帧序保留层级，
 * 不靠 workflowId 去重（同名子流程可多层）。
 */
export function monitorCallPath(run) {
  const rootWorkflowId = run?.workflowId
  const flows = run?.flows ?? {}
  const frames = Array.isArray(run?.callStack) ? run.callStack : []
  const path = frames.map(frame => {
    const flow = flows[frame.workflowId]
    const node = flow?.nodes?.find(candidate => candidate.id === frame.nodeId)
    return {
      workflowId: frame.workflowId,
      nodeId: frame.nodeId,
      executionId: frame.executionId,
      label: frame.workflowId === rootWorkflowId ? '主流程' : `子流程 ${frame.workflowId}`,
      nodeLabel: node?.role === undefined ? frame.nodeId : `${frame.nodeId}（${node.role}）`,
    }
  })
  return {
    frames: path,
    currentWorkflowId: path.at(-1)?.workflowId ?? rootWorkflowId ?? null,
    currentFrame: path.at(-1) ?? null,
  }
}

/**
 * 自动跟随状态机（#253）纯函数：following 始终显示当前节点所在流程；用户手动
 * 切换 flow 后 paused 并记住 manualFlowId（「回到当前节点」可见）；恢复后回到
 * following。组件只保存 state，activeFlowId 每次由当前节点派生。
 */
export function initialFollowState() {
  return { mode: 'following', manualFlowId: null }
}

/** 派生当前应显示的流程与「回到当前节点」入口；paused 时手动流程优先。 */
export function monitorFollowView(state, currentFlowId) {
  const paused = state?.mode === 'paused' && typeof state.manualFlowId === 'string'
  const activeFlowId = paused ? state.manualFlowId : currentFlowId
  return {
    mode: paused ? 'paused' : 'following',
    activeFlowId,
    showReturn: paused && activeFlowId !== currentFlowId,
  }
}

/** 用户点选流程：选中当前流程视为继续跟随，选其他流程则暂停跟随。 */
export function selectFlow(state, flowId, currentFlowId) {
  if (flowId === currentFlowId) return initialFollowState()
  return { mode: 'paused', manualFlowId: flowId }
}

/** 「回到当前节点」：恢复自动跟随。 */
export function resumeFollow() {
  return initialFollowState()
}

const EMPTY_LAYOUT = { version: 1, main: {}, children: {} }

/**
 * run 投影 → 画布模型（#252）：每个流程一份 def（nodes 为对象，NodeCanvas 形状）
 * + 坐标（服务端布局；缺失由画布按网格补位）+ 每节点最新 visit 的叠加态。
 * 当前焦点所在流程作为默认显示流程。
 */
function graphOf(run) {
  const latest = new Map()
  for (const node of run.nodes ?? []) {
    const key = `${node.workflowId}/${node.nodeId}`
    const previous = latest.get(key)
    if (previous === undefined || node.visit > previous.visit) latest.set(key, node)
  }
  const callPath = monitorCallPath(run)
  const layout = run.layout ?? EMPTY_LAYOUT
  const flows = Object.entries(run.flows ?? {}).map(([id, flow]) => {
    const nodes = {}
    const decorations = {}
    for (const node of flow.nodes ?? []) {
      const execution = { type: node.kind }
      if (node.role !== undefined) execution.role = node.role
      if (node.programId !== undefined) execution.programId = node.programId
      if (node.childWorkflowId !== undefined) execution.workflowId = node.childWorkflowId
      nodes[node.id] = { execution, results: node.results, onReturn: node.onReturn }
      const state = monitorNodeState(latest.get(`${id}/${node.id}`))
      if (state !== null) decorations[node.id] = state
    }
    const positions = id === run.workflowId ? layout.main ?? {} : layout.children?.[id] ?? {}
    return {
      id,
      label: id === run.workflowId ? '主流程' : `子流程 ${id}`,
      def: { startNode: flow.startNode, returns: flow.returns ?? [], nodes },
      positions,
      decorations,
    }
  })
  const currentFlowId = callPath.currentWorkflowId ?? (run.nodes ?? []).find(node => node.current === true)?.workflowId ?? run.workflowId
  return { layout, flows, currentFlowId, callPath }
}

/** status → 中文标签。 */
export const RUN_STATUS_LABELS = {
  running: '运行中',
  blocked: '已阻塞',
  completed: '已完成',
  terminated: '已终止',
}

/** 空态引导（#254）：当前目录没有任何 Run 时告诉用户如何启动。 */
export const EMPTY_GUIDANCE = '当前目录没有工作流运行记录。在会话中执行 /dsh-flow start <workflowId> 启动工作流。'

/** workspace key → 短标签（路径最后一段；兼容 Windows 反斜杠）。 */
export function workspaceLabel(workspaceKey) {
  if (typeof workspaceKey !== 'string' || workspaceKey === '') return '未知目录'
  const parts = workspaceKey.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.at(-1) ?? workspaceKey
}

/** Run 引用 → 切换器选项（workspace 标识 + 流程 + 状态）。 */
function runRefView(ref, selectedRunId) {
  const workspace = workspaceLabel(ref?.workspaceKey)
  const workflowId = typeof ref?.workflowId === 'string' ? ref.workflowId : '—'
  return {
    runId: ref?.runId ?? '',
    workspaceKey: ref?.workspaceKey ?? '',
    workspaceLabel: workspace,
    workflowId,
    status: ref?.status ?? '',
    statusLabel: RUN_STATUS_LABELS[ref?.status] ?? String(ref?.status ?? ''),
    label: `${workspace} · ${workflowId}`,
    selected: ref?.runId === selectedRunId,
  }
}

function phaseOf(phase) {
  const entry = PHASE_LABELS[phase]
  return entry === undefined ? [String(phase), 'phase-ready'] : entry
}

/** 角色生效模型：provider/modelId 可能各自缺席，缺席段不渲染。 */
function modelTextOf(model) {
  const provider = typeof model?.provider === 'string' ? model.provider : ''
  const modelId = typeof model?.modelId === 'string' ? model.modelId : ''
  if (modelId === '') return provider
  return provider === '' ? modelId : `${provider}/${modelId}`
}

/** 毫秒 → 人类可读时长（小时级省略秒，分钟级保留秒）。 */
function elapsedText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}小时${minutes}分`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

const TERMINAL_RUN_STATUSES = new Set(['completed', 'terminated'])

/**
 * payload（服务端 MonitorRunStatus）→ 视图模型（#254 起区分 run/terminal/empty）。
 * payload 为 null/undefined（尚无数据）时返回 { mode: 'loading' }。
 * options.now 固定当前时刻（单测可复现）；options.banner 是 RPC 失败横幅；
 * options.selectedRunId 是切换器选中的 Run（缺省 = 当前 cwd 默认 Run）。
 * polling=false 的模式（terminal/empty/maintenance）由组件停止轮询。
 */
export function monitorViewModel(payload, options = {}) {
  const banner = typeof options.banner === 'string' ? options.banner : ''
  if (payload === null || payload === undefined || typeof payload !== 'object') return { mode: 'loading', banner, polling: true, runs: [], recent: null }
  if (payload.mode === 'maintenance') {
    return { mode: 'maintenance', reason: payload.maintenance?.reason ?? '状态库处于维护模式', banner, polling: false, runs: [], recent: null }
  }
  const payloadRuns = Array.isArray(payload.runs) ? payload.runs : []
  const recent = payload.recent === null || payload.recent === undefined ? null : runRefView(payload.recent, null)
  const selectedRunId = typeof options.selectedRunId === 'string' ? options.selectedRunId : payload.run?.runId ?? null
  const runs = payloadRuns.map(ref => runRefView(ref, selectedRunId))
  // 选中的 Run 可能已离开活跃清单（终态）：补一个选项，避免切换器值悬空。
  if (payload.run !== undefined && payload.run !== null && !runs.some(ref => ref.runId === payload.run.runId)) {
    runs.push(runRefView({ ...payload.run, workspaceKey: payload.run.workspaceKey }, selectedRunId))
  }
  const base = { banner, runs, recent, selectedRunId }
  if (payload.run === undefined || payload.run === null) {
    return { ...base, mode: 'empty', polling: false, guidance: EMPTY_GUIDANCE }
  }
  const run = payload.run
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const [statusLabel, statusClass] = run.status === 'blocked' ? ['已阻塞', 'run-blocked'] : [RUN_STATUS_LABELS[run.status] ?? String(run.status), 'run-ok']
  const roles = (run.roles ?? [])
    .map(role => `${role.role}=${role.model?.modelId ?? '?'}${role.model?.provider ? `@${role.model.provider}` : ''}`)
    .join('、')
  const nodes = run.nodes ?? []
  // 开始时间取首个工作单的进入时刻（不新增持久化字段）；终态用最后工作单的退出时刻。
  const startedAt = typeof nodes[0]?.enteredAt === 'string' ? nodes[0].enteredAt : null
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt)
  const terminal = run.terminal === true || TERMINAL_RUN_STATUSES.has(run.status)
  const lastExitedAt = nodes[nodes.length - 1]?.exitedAt
  const endMs = terminal && typeof lastExitedAt === 'string' ? Date.parse(lastExitedAt) : now
  const durationText = Number.isFinite(startedMs) ? elapsedText((Number.isFinite(endMs) ? endMs : now) - startedMs) : null
  return {
    ...base,
    mode: terminal ? 'terminal' : 'run',
    polling: !terminal,
    terminalNote: terminal ? '该 Run 已结束，已停止轮询（展示冻结终态图）。' : null,
    run: {
      workflowId: run.workflowId ?? '—',
      runId: run.runId ?? '—',
      workspaceKey: run.workspaceKey ?? '',
      statusLabel,
      statusClass,
      startedAt,
      startedAtText: Number.isFinite(startedMs) ? new Date(startedMs).toLocaleString('zh-CN', { hour12: false }) : null,
      durationText,
      durationLabel: terminal ? '总耗时' : '已运行',
      blockReason: run.blockReason ?? null,
      businessReturn: run.businessReturn ? `${run.businessReturn.name}` : null,
      launchPrompt: run.launchPrompt ?? '',
      roles,
      graph: graphOf(run),
    },
    nodes: nodes.map(node => {
      const [phaseLabel, phaseClass] = phaseOf(node.phase)
      const def = run.flows?.[node.workflowId]?.nodes?.find(candidate => candidate.id === node.nodeId)
      const targetText = def?.kind === 'builtin-program'
        ? `程序 ${def.programId ?? '?'}`
        : def?.kind === 'child-workflow' ? `子流程 ${def.childWorkflowId ?? '?'}` : null
      return {
        key: `${node.workflowId}/${node.nodeId}#${node.visit}`,
        label: `${node.workflowId} / ${node.nodeId}`,
        visit: node.visit,
        phaseLabel,
        phaseClass,
        role: def?.role ?? null,
        modelText: modelTextOf(def?.model),
        targetText,
        // BLOCK 不改 phase（引擎可能停在 working/checking 等任一时相）：有原因即展示。
        blocked: typeof node.blockReason === 'string' && node.blockReason !== '',
        blockReason: node.blockReason ?? null,
        current: node.current === true,
      }
    }),
  }
}

/** RPC 失败：保留旧数据，只更新横幅文案（横幅空串 = 无错误）。 */
export function monitorErrorState(banner, errorText) {
  return typeof errorText === 'string' && errorText !== '' ? errorText : banner
}

/** better-sidebar TabComponentProps.scope + 切换器选中 Run → status payload。 */
export function monitorStatusPayload(scope, runId) {
  const cwd = scope?.cwd
  const payload = typeof cwd === 'string' && cwd !== '' ? { cwd } : {}
  if (typeof runId === 'string' && runId !== '') payload.runId = runId
  return payload
}
