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
      // #262：Actor 卡直接展示服务端算出的「当前生效模型」（只呈现，不重算 primary/manual/fallback）；
      // 未执行节点同样有值，Program/Child 不伪造模型，缺字段由 modelTextOf 降级为空。
      const modelText = node.kind === 'actor-task' ? modelTextOf(node.model) : ''
      if (state !== null || modelText !== '') {
        decorations[node.id] = modelText === '' ? state : { ...(state ?? {}), summary: modelText }
      }
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

/**
 * Run 引用 → 切换器选项（workspace 短标签 + 流程 + 状态）。只保留实际渲染的
 * 字段：#263 删除了无人消费的 selected/workspaceKey 输出（选中态由组件受控
 * selectedRunId 决定，workspaceKey 只作为 workspaceLabel 的输入）。
 */
function runRefView(ref) {
  const workspace = workspaceLabel(ref?.workspaceKey)
  const workflowId = typeof ref?.workflowId === 'string' ? ref.workflowId : '—'
  return {
    runId: ref?.runId ?? '',
    workflowId,
    status: ref?.status ?? '',
    statusLabel: RUN_STATUS_LABELS[ref?.status] ?? String(ref?.status ?? ''),
    label: `${workspace} · ${workflowId}`,
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
 * 该 payload 是否还要继续自动轮询（#261 统一口径，组件与 Hook 共用一份判断）。
 * 只有终态 Run 停周期：运行中/BLOCK/空态/维护态都在可见时按 2s 继续探测——
 * 维护态是运维临时状态，继续探测才能在状态库恢复后自动回到正常视图；
 * 终态 Run 由「刷新状态」手动读取（不引入自动发现）。
 */
export function monitorPollingContinues(payload) {
  const run = payload?.run
  if (run === undefined || run === null) return true
  return run.terminal !== true && !TERMINAL_RUN_STATUSES.has(run.status)
}

/** #274 路由来源中文标签；缺来源 = 来源未知（不从当前配置推导）。 */
export const ROUTE_SOURCE_LABELS = { primary: '首选', fallback: '备选', manual: '人工指定' }

const SOURCE_UNKNOWN = '来源未知'
/** #274/#275 无可靠记录时的统一文案（不按当前配置/当前时刻猜补）。 */
export const MODEL_MISSING = '未记录'

/** 派发事实 → 「模型 · 来源」；未采集时显式未记录/来源未知，绝不用当前配置补值。 */
function dispatchModelText(facts) {
  const modelText = modelTextOf(facts?.model)
  return `${modelText === '' ? MODEL_MISSING : modelText} · ${ROUTE_SOURCE_LABELS[facts?.source] ?? SOURCE_UNKNOWN}`
}

/**
 * 状态文案 + 是否「正在发生」：终态 Run 只替换活动文案，已收口/未派发的如实保留。
 * 活动性跟着事实（派发/claim/判定）走，不靠中文标签集合，文案改名也不会静默失效。
 */
function actorStatusOf(node) {
  if (node.dispatch === undefined || node.dispatch === null) return { text: '未派发', active: false }
  if (node.dispatch.dispatched !== true) return { text: '已安排派发未确认', active: false }
  if (node.claim !== undefined && node.claim !== null) return { text: '已提交结果', active: false }
  return node.dispatch.settled === true ? { text: '待提交', active: true } : { text: '执行中', active: true }
}

function judgeStatusOf(node) {
  if (node.claim === undefined || node.claim === null) return { text: '未派发', active: false }
  if (node.judge === undefined || node.judge === null) {
    return node.dispatch?.settled === false ? { text: '等待 Actor 收口', active: true } : { text: '待派发', active: true }
  }
  if (node.judge.dispatched !== true) return { text: '已安排派发未确认', active: false }
  if (node.judge.judgment !== undefined) return { text: `已判定：${node.judge.judgment}`, active: false }
  return { text: '待判定', active: true }
}

/** 程序/子流程节点的目标文案（当前卡与记录表共用一份）。 */
function targetTextOf(def) {
  if (def?.kind === 'builtin-program') return `程序 ${def.programId ?? '?'}`
  if (def?.kind === 'child-workflow') return `子流程 ${def.childWorkflowId ?? '?'}`
  return null
}

/**
 * #274 当前执行卡（纯函数）：独立于「选中详情/流程选择」，始终指向调用栈栈顶的
 * 当前工作单（终态取最后一个工作单作为结束位置）。模型与来源只读工作单落库的
 * 派发快照，不按当前配置重算；Run 已结束时活动文案改成终态标签，不冒充正在执行。
 */
export function currentExecutionView(run, ctx = {}) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : []
  const node = nodes.find(item => item.current === true) ?? nodes[nodes.length - 1] ?? null
  if (node === null) return null
  const flows = run?.flows ?? {}
  const def = flows[node.workflowId]?.nodes?.find(candidate => candidate.id === node.nodeId) ?? null
  const kind = def?.kind ?? 'actor-task'
  const terminal = ctx.terminal === true
  const [phaseLabel, phaseClass] = phaseOf(node.phase)
  const blocked = typeof node.blockReason === 'string' && node.blockReason !== ''
  // 终态：活动相文案换成 Run 终态标签（终止位置可查，但不冒充活跃执行）。
  const endLabel = ctx.statusLabel ?? (run?.status === 'completed' ? '已完成' : '已终止')
  const settle = status => (terminal && status.active ? endLabel : status.text)
  const visit = typeof node.visit === 'number' ? node.visit : 1
  const actorTask = kind === 'actor-task'
  const targetText = targetTextOf(def)
  return {
    heading: terminal ? '结束位置' : '当前节点',
    active: !terminal,
    terminalLabel: terminal ? endLabel : null,
    executionId: node.executionId ?? null,
    workflowId: node.workflowId,
    nodeId: node.nodeId,
    workflowLabel: node.workflowId === run?.workflowId ? '主流程' : `子流程 ${node.workflowId}`,
    visitText: visit > 1 ? `第 ${visit} 次` : '',
    phaseLabel,
    phaseClass,
    blocked,
    blockReason: node.blockReason ?? null,
    targetText,
    actor: actorTask
      ? {
        role: def?.role ?? null,
        modelText: node.dispatch === undefined || node.dispatch === null ? null : dispatchModelText(node.dispatch),
        // 同一工作单重派过（故障切换/换模 resume）时，旧轮另有留档：显式标「上一轮」，不冒充当前。
        previousText: node.previousDispatch === undefined || node.previousDispatch === null
          ? null
          : `上一轮 ${dispatchModelText(node.previousDispatch)}`,
        status: settle(actorStatusOf(node)),
      }
      : null,
    judge: actorTask
      ? {
        modelText: node.judge === undefined || node.judge === null ? null : dispatchModelText(node.judge),
        status: settle(judgeStatusOf(node)),
      }
      : null,
  }
}

/** #275 执行记录表列顺序（固定列序；「所属流程」靠左、节点列固定由 CSS 处理）。 */
export const RECORD_COLUMNS = ['节点名称', '所属流程', '运行情况', '进入时间', '提交结果时间', '提交判定时间', 'Actor 模型', 'Judge 模型']
/** #275 缺失值口径（与设计文档 §5.3 一致；不按当前配置/当前时刻猜补）。 */
export const RECORD_PENDING = '待提交'
export const RECORD_JUDGE_PENDING = '待判定'
export const RECORD_NOT_DISPATCHED = '未派发'
export const RECORD_SCHEDULED = '已安排派发未确认'
export const RECORD_NOT_APPLICABLE = '不适用'
/** 判定等待超过该时长只在视图标注「较久」，不宣称失败（真实卡片/表格共用口径）。 */
const RECORD_SLOW_MS = 120_000

function timeText(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : null
}

function judgmentLabelOf(result) {
  if (result === 'ACCEPT') return '通过'
  if (result === 'REJECT') return '不通过'
  if (result === 'NEED_CONTEXT') return '需补充'
  return result ?? '—'
}

function roundModelText(dispatch) {
  if (dispatch === undefined || dispatch === null) return MODEL_MISSING
  return dispatchModelText(dispatch)
}

/**
 * #275 执行记录表（纯函数）：一行 = 一次进入节点的工作单（不把多次进入合并成一行）；
 * 同一次进入内的多轮提交/判定放在该行的下钻里，按 claimId 配对、按事件时间给时间，
 * 绝不跨轮借模型/时间，也绝不用当前配置冒充历史。无事件留档的旧记录显式「未记录」。
 */
export function monitorRecordsView(run, ctx = {}) {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : []
  const flows = run?.flows ?? {}
  const rootWorkflowId = run?.workflowId
  const terminal = ctx.terminal === true
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now()
  return nodes.map(node => {
    const def = flows[node.workflowId]?.nodes?.find(candidate => candidate.id === node.nodeId) ?? null
    const [phaseLabel] = phaseOf(node.phase)
    const history = node.history ?? {}
    const rounds = (Array.isArray(history.rounds) ? history.rounds : []).map((round, index) => {
      const judgment = round.judgment ?? null
      return {
        index: index + 1,
        claimId: round.claimId,
        result: round.result,
        resultText: `提交「${round.result}」`,
        statusText: judgment === null ? RECORD_JUDGE_PENDING : `判定${judgmentLabelOf(judgment.result)}`,
        judgmentResult: judgment?.result ?? null,
        submittedAt: typeof round.submittedAt === 'string' ? round.submittedAt : null,
        submittedAtText: timeText(round.submittedAt),
        judgedAtText: judgment === null ? null : timeText(judgment.at),
        actorModelText: roundModelText(round.actor),
        judgeModelText: judgment === null ? RECORD_JUDGE_PENDING : roundModelText(judgment.judge),
      }
    })
    const pending = history.pending ?? null
    const abandoned = Array.isArray(history.abandoned) ? history.abandoned : []
    const switches = Array.isArray(history.switches) ? history.switches : []
    const last = rounds.at(-1) ?? null
    const ended = typeof node.exitedAt === 'string'
    const blocked = typeof node.blockReason === 'string' && node.blockReason !== ''
    // 最新一轮的「等待中」派生自提交时间（不新增持久化字段，不宣称失败）。
    const waitingMs = !terminal && last !== null && last.judgmentResult === null && last.submittedAtText !== null
      ? now - Date.parse(last.submittedAt)
      : Number.NaN
    const waitingText = Number.isFinite(waitingMs) && waitingMs >= RECORD_SLOW_MS
      ? `已判定等待 ${elapsedText(waitingMs)}`
      : null
    const pendingRound = pending === null ? null : {
      index: rounds.length + 1,
      statusText: pending.dispatched === true ? RECORD_PENDING : RECORD_SCHEDULED,
      actorModelText: roundModelText(pending),
    }
    // 无事件回放（旧记录）时只用工作单上仍保留的当前事实做定性，时间/历史模型显式「未记录」。
    const claimed = node.claim !== undefined && node.claim !== null
    const judged = node.judgment !== undefined && node.judgment !== null
    const judgeArranged = node.judge !== undefined && node.judge !== null
    const outcomeText = blocked
      ? '阻塞'
      : ended
        ? '已结束'
        : last === null
          ? !claimed
            ? (pending !== null && pending.dispatched !== true
              ? RECORD_SCHEDULED
              : node.dispatch === undefined || node.dispatch === null ? phaseLabel : RECORD_PENDING)
            : judged ? `判定${judgmentLabelOf(node.judgment.result)}` : '待判定'
          : last.judgmentResult === null ? '待判定' : `判定${judgmentLabelOf(last.judgmentResult)}`
    return {
      key: `${node.workflowId}/${node.nodeId}#${node.visit}`,
      executionId: node.executionId ?? null,
      workflowId: node.workflowId,
      nodeId: node.nodeId,
      // 节点名称：节点 id（有角色时附角色），表格与画布可交叉核对。
      nodeLabel: def?.role === undefined || def?.role === null ? node.nodeId : `${node.nodeId}（${def.role}）`,
      flowText: node.workflowId === rootWorkflowId ? '主流程' : `子流程 ${node.workflowId}`,
      workflowLabel: node.workflowId,
      visit: node.visit,
      current: node.current === true,
      visitText: typeof node.visit === 'number' && node.visit > 1 ? `第 ${node.visit} 次` : '',
      phaseLabel,
      blocked,
      blockReason: node.blockReason ?? null,
      outcomeText,
      roundCountText: rounds.length > 0 ? `共 ${rounds.length} 轮` : null,
      enteredAtText: timeText(node.enteredAt),
      // 无事件回放：有 claim/判定事实但时间不可还原 → 未记录；还没提交才是待提交。
      submittedAtText: last === null ? (claimed ? MODEL_MISSING : RECORD_PENDING) : last.submittedAtText,
      judgedAtText: last === null
        ? (judged ? MODEL_MISSING : judgeArranged ? RECORD_JUDGE_PENDING : RECORD_NOT_APPLICABLE)
        : last.judgedAtText ?? RECORD_JUDGE_PENDING,
      // 旧记录（无事件回放）：已提交/已安排但无派发事实可还原 → 未记录，不拿当前配置填。
      actorModelText: last !== null
        ? last.actorModelText
        : (node.dispatch !== undefined && node.dispatch !== null ? roundModelText(node.dispatch) : RECORD_NOT_DISPATCHED),
      judgeModelText: last !== null
        ? last.judgeModelText
        : (node.judge !== undefined && node.judge !== null ? roundModelText(node.judge) : RECORD_NOT_APPLICABLE),
      waitingText,
      drilldown: {
        rounds,
        ...(pendingRound === null ? {} : { pending: pendingRound }),
        // 未形成提交的派发（故障切换/超时重派/被覆盖的旧轮）：有时间给时间，未知显式「时间未记录」。
        abandoned: abandoned.map(attempt => ({
          atText: timeText(attempt.at),
          modelText: roundModelText(attempt.dispatch),
          reasonText: attempt.at === null ? '时间未记录' : '未形成提交',
        })),
        // 角色只在事件能证明时显示（Judge 侧有差分）；证明不了就只报「换模」，不猜是谁。
        switches: switches.map(switchEvent => ({ atText: timeText(switchEvent.at), roleText: switchEvent.role === 'judge' ? 'Judge 换模' : switchEvent.role === 'actor' ? 'Actor 换模' : '换模' })),
      },
    }
  })
}

/**
 * payload（服务端 MonitorRunStatus）→ 视图模型（#254 起区分 run/terminal/empty）。
 * payload 为 null/undefined（尚无数据）时返回 { mode: 'loading' }。
 * options.now 固定当前时刻（单测可复现）；options.banner 是 RPC 失败横幅。
 * polling=false 只剩终态 Run 一种（#261）：维护态同样继续探测，状态库恢复后自愈；
 * 终态由只读「刷新状态」手动读取。是否继续的判定见 monitorPollingContinues。
 */
export function monitorViewModel(payload, options = {}) {
  const banner = typeof options.banner === 'string' ? options.banner : ''
  if (payload === null || payload === undefined || typeof payload !== 'object') return { mode: 'loading', banner, polling: true, runs: [] }
  if (payload.mode === 'maintenance') {
    // 维护态继续按可见性探测（#261）：否则运维恢复状态库后面板永远停在维护视图。
    return { mode: 'maintenance', reason: payload.maintenance?.reason ?? '状态库处于维护模式', banner, polling: true, runs: [] }
  }
  const payloadRuns = Array.isArray(payload.runs) ? payload.runs : []
  const runs = payloadRuns.map(ref => runRefView(ref))
  // 选中的 Run 可能已离开活跃清单（终态）：补一个选项，避免切换器值悬空。
  if (payload.run !== undefined && payload.run !== null && !runs.some(ref => ref.runId === payload.run.runId)) {
    runs.push(runRefView(payload.run))
  }
  const base = { banner, runs }
  if (payload.run === undefined || payload.run === null) {
    return { ...base, mode: 'empty', polling: true, guidance: EMPTY_GUIDANCE }
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
  const terminal = !monitorPollingContinues(payload)
  const lastExitedAt = nodes[nodes.length - 1]?.exitedAt
  const endMs = terminal && typeof lastExitedAt === 'string' ? Date.parse(lastExitedAt) : now
  const durationText = Number.isFinite(startedMs) ? elapsedText((Number.isFinite(endMs) ? endMs : now) - startedMs) : null
  return {
    ...base,
    mode: terminal ? 'terminal' : 'run',
    polling: !terminal,
    terminalNote: terminal ? '该 Run 已结束，已停止自动轮询；点击「刷新状态」可查看最新状态。' : null,
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
    // #274：当前执行卡独立于选中详情/流程选择，始终指向当前（或结束）工作单。
    currentExecution: currentExecutionView(run, { terminal, statusLabel }),
    // #275：执行记录表（每次进入一行；多轮提交/判定在下钻里）。
    records: monitorRecordsView(run, { terminal, now }),
    nodes: nodes.map(node => {
      const [phaseLabel, phaseClass] = phaseOf(node.phase)
      const def = run.flows?.[node.workflowId]?.nodes?.find(candidate => candidate.id === node.nodeId)
      const targetText = targetTextOf(def)
      return {
        key: `${node.workflowId}/${node.nodeId}#${node.visit}`,
        executionId: node.executionId ?? null,
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
