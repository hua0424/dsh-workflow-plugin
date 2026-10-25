/**
 * #251 运行监控视图模型（纯函数，可单测）：服务端 status payload → 渲染所需的
 * 展示形状（run 信息条、启动 prompt 展开、节点列表行）。不做任何 IO/状态。
 * RPC 失败时的行为也在这里定为纯逻辑：横幅显示错误、数据沿用上一次成功结果
 * （monitorErrorState），恢复由组件在下一次成功轮询时清掉横幅。
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

/**
 * payload（服务端 MonitorRunStatus）→ 视图模型。
 * payload 为 null/undefined（尚无数据）时返回 { mode: 'loading' }。
 */
export function monitorViewModel(payload) {
  if (payload === null || payload === undefined || typeof payload !== 'object') return { mode: 'loading' }
  if (payload.mode === 'maintenance') {
    return { mode: 'maintenance', reason: payload.maintenance?.reason ?? '状态库处于维护模式' }
  }
  if (payload.mode !== 'run' || payload.run === undefined || payload.run === null) return { mode: 'empty' }
  const run = payload.run
  const [statusLabel, statusClass] = run.status === 'blocked' ? ['已阻塞', 'run-blocked'] : [RUN_STATUS_LABELS[run.status] ?? String(run.status), 'run-ok']
  const roles = (run.roles ?? [])
    .map(role => `${role.role}=${role.model?.modelId ?? '?'}${role.model?.provider ? `@${role.model.provider}` : ''}`)
    .join('、')
  return {
    mode: 'run',
    run: {
      statusLabel,
      statusClass,
      blockReason: run.blockReason ?? null,
      businessReturn: run.businessReturn ? `${run.businessReturn.name}` : null,
      launchPrompt: run.launchPrompt ?? '',
      roles,
    },
    nodes: (run.nodes ?? []).map(node => {
      const [phaseLabel, phaseClass] = phaseOf(node.phase)
      return {
        key: `${node.workflowId}/${node.nodeId}#${node.visit}`,
        label: `${node.workflowId} / ${node.nodeId}`,
        visit: node.visit,
        phaseLabel,
        phaseClass,
        blocked: node.phase === 'working' && typeof node.blockReason === 'string' && node.blockReason !== '',
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
