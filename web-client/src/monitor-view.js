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

/** status → 中文标签。 */
export const RUN_STATUS_LABELS = {
  running: '运行中',
  blocked: '已阻塞',
  completed: '已完成',
  terminated: '已终止',
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
 * payload（服务端 MonitorRunStatus）→ 视图模型。
 * payload 为 null/undefined（尚无数据）时返回 { mode: 'loading' }。
 * options.now 固定当前时刻（单测可复现）；options.banner 是 RPC 失败横幅。
 */
export function monitorViewModel(payload, options = {}) {
  const banner = typeof options.banner === 'string' ? options.banner : ''
  if (payload === null || payload === undefined || typeof payload !== 'object') return { mode: 'loading', banner }
  if (payload.mode === 'maintenance') {
    return { mode: 'maintenance', reason: payload.maintenance?.reason ?? '状态库处于维护模式', banner }
  }
  if (payload.mode !== 'run' || payload.run === undefined || payload.run === null) return { mode: 'empty', banner }
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
  const lastExitedAt = nodes[nodes.length - 1]?.exitedAt
  const endMs = TERMINAL_RUN_STATUSES.has(run.status) && typeof lastExitedAt === 'string' ? Date.parse(lastExitedAt) : now
  const durationText = Number.isFinite(startedMs) ? elapsedText((Number.isFinite(endMs) ? endMs : now) - startedMs) : null
  return {
    mode: 'run',
    banner,
    run: {
      workflowId: run.workflowId ?? '—',
      runId: run.runId ?? '—',
      statusLabel,
      statusClass,
      startedAt,
      startedAtText: Number.isFinite(startedMs) ? new Date(startedMs).toLocaleString('zh-CN', { hour12: false }) : null,
      durationText,
      durationLabel: TERMINAL_RUN_STATUSES.has(run.status) ? '总耗时' : '已运行',
      blockReason: run.blockReason ?? null,
      businessReturn: run.businessReturn ? `${run.businessReturn.name}` : null,
      launchPrompt: run.launchPrompt ?? '',
      roles,
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

/** better-sidebar TabComponentProps.scope → status payload：只上行会话 cwd（缺席则空载荷）。 */
export function monitorStatusPayload(scope) {
  const cwd = scope?.cwd
  return typeof cwd === 'string' && cwd !== '' ? { cwd } : {}
}
