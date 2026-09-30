/**
 * #179 启动提交纯函数（无 React 依赖，可单测）：
 * 命令组装、可用性闸门、原生命令结果分类。
 *
 * 与服务端同源的语义：
 * - workflow-id 形状 `[a-z][a-z0-9-]*`（src/commands/dsh-flow.ts `start` 分支）；
 * - prompt 空白归一化≈服务端 `rest.join(' ')`（多空白折叠，不承诺多行排版原样）；
 * - prompt 上限 8000 = engine.startRun 的 root input 上限（handoffMax）。
 */

export const START_PROMPT_MAX_CHARS = 8000

const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9-]*$/

export function normalizeStartPrompt(prompt) {
  return String(prompt ?? '').trim().split(/\s+/).filter((part) => part !== '').join(' ')
}

/**
 * 组装原生命令文本：展示的 `.yaml` 后缀不进入参数；空 prompt 沿用命令现有语义。
 * @returns {{ok:true,line:string}|{ok:false,reason:string}} 超限/非法选择明确拒绝。
 */
export function startCommandLineOf(workflowId, prompt) {
  if (typeof workflowId !== 'string' || !WORKFLOW_ID_PATTERN.test(workflowId)) {
    return { ok: false, reason: `工作流选择无效（${String(workflowId)}）：请重新选择有效配置` }
  }
  const extra = normalizeStartPrompt(prompt)
  if (extra.length > START_PROMPT_MAX_CHARS) {
    return { ok: false, reason: `启动 prompt 超过 ${START_PROMPT_MAX_CHARS} 字符上限（当前 ${extra.length}）：请缩短后重试` }
  }
  return { ok: true, line: extra === '' ? `/dsh-flow start ${workflowId}` : `/dsh-flow start ${workflowId} ${extra}` }
}

/**
 * 启动可用性闸门（按钮禁用 + 确认前重判共用）：运行中、提交中、子会话、
 * 无 workspace、已移除均禁用；实际权限仍由服务端命令链路判定。
 */
export function canStartWorkflow({ session, inputPhase, hasWorkspace }) {
  if (session === undefined || session === null) return { ok: false, reason: '当前没有可用会话' }
  if (session.removed) return { ok: false, reason: '当前会话已移除' }
  if (session.subagent !== null && session.subagent !== undefined) return { ok: false, reason: '子会话不能通过启动按钮启动工作流' }
  if (session.running) return { ok: false, reason: '会话运行中：请等待当前任务结束后再启动' }
  if (inputPhase === 'submitting' || inputPhase === 'adjudicating') return { ok: false, reason: '正在提交消息：请等待提交落定后再启动' }
  if (!hasWorkspace) return { ok: false, reason: '当前会话没有 workspace，无法启动工作流' }
  return { ok: true }
}

/**
 * 原生命令提交（与手写命令同一链路，`remote.commands.execute`）：
 * 只有传输成功且内层 result 为 success 才算成功；传输失败/抛错一律归为
 * 未知结果（指引先查状态、不自动重试）；内层 error 与未知命令保留输入。
 *
 * @param runCommand `(sessionId, line) => Promise<{ok,value?,error?}>`（可拒绝）。
 */
export async function executeStartWorkflow({ runCommand, sessionId, line }) {
  let res
  try {
    res = await runCommand(sessionId, line)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'unknown', message: `启动结果未知（${detail}）：请先通过 /dsh-flow status 查看工作流状态，确认后再决定是否重试，不要自动重试` }
  }
  if (res === null || typeof res !== 'object' || res.ok !== true) {
    const error = res?.error ?? {}
    const detail = typeof error.message === 'string' && error.message !== ''
      ? `${error.message}（${String(error.code ?? 'unknown')}）`
      : String(error.code ?? 'unknown')
    return { kind: 'unknown', message: `启动结果未知（${detail}）：请先通过 /dsh-flow status 查看工作流状态，确认后再决定是否重试，不要自动重试` }
  }
  const inner = res.value?.result
  if (inner === undefined || inner === null) {
    return { kind: 'command-error', message: '未知命令（服务端未识别启动命令）：已保留选择与输入，请检查后重试' }
  }
  if (inner.kind !== 'success') {
    return { kind: 'command-error', message: `启动失败：${inner.text ?? '未知错误'}` }
  }
  return { kind: 'success' }
}
