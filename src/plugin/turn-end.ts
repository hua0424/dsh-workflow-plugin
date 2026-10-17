/**
 * Issue #29：把 Host 的 `turn/end` 原因变成工作流可读的失败诊断。
 *
 * 引擎原先只观测到「turn 结束且无 claim」，于是 BLOCK 原因永远是
 * `actor-turn-ended-without-result`——额度耗尽、模型 4xx、轮次截断在 Manager
 * 眼里长得一模一样，只能靠换模型盲试。`turn/end` 的 `reason` 本来就带着
 * 结构化失败事实（`error` 是 verbatim 的 `LlmFailure`：message/code/status），
 * 这里只做投影：把该事实 + 本回合是否有过工具调用压成有界诊断串。
 *
 * 关键纪律：**只有非正常结束才产生诊断**。`completed` 是正常路径（含
 * 「turn 结束但没提交 claim」——那是 Actor 自己的问题，不是模型故障），不能
 * 借这里往 blockReason 里塞噪音（验收：正常完成路径无回归）。
 *
 * 纯函数；未知/畸形的 `reason` 一律 fail-closed 成 `unknown`，绝不猜。
 */
import { LIMITS } from '../types.ts'

/** Minimal session-log event shape (DSH `SessionEvent` satisfies it). */
export interface TurnEndFact {
  type: string
  seq: number
  data: unknown
}

function dataOf(event: TurnEndFact): Record<string, unknown> | undefined {
  if (typeof event.data !== 'object' || event.data === null) return undefined
  return event.data as Record<string, unknown>
}

/** `error.reason` 的取消来源；`hook` 带自由文本原因，其余只有 kind。 */
function cancelCauseText(reason: unknown): string {
  if (typeof reason !== 'object' || reason === null) return 'unknown'
  const cause = reason as Record<string, unknown>
  const kind = typeof cause.kind === 'string' ? cause.kind : 'unknown'
  return kind === 'hook' && typeof cause.reason === 'string' && cause.reason.trim() !== ''
    ? `${kind}: ${cause.reason}`
    : kind
}

/**
 * `error` 载荷里我们真正要透传的字段。`code` 原样带出（harness 的稳定机器
 * 路由码：`QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `INVALID_REQUEST` / `AUTH` /
 * `RATE_LIMIT` / `SERVER` / `EMPTY_RESPONSE` …）——**按码路由，不解析 message**，
 * 这正是 `HarnessError` 的合同；未知码也不改写，只把缺失兜成 `UNKNOWN`。
 */
function errorFact(value: unknown): { message: string; code: string; status?: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const failure = value as Record<string, unknown>
  if (typeof failure.message !== 'string' || failure.message === '') return undefined
  return {
    message: failure.message,
    code: typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'UNKNOWN',
    ...(typeof failure.status === 'number' ? { status: failure.status } : {}),
  }
}

/** 该回合是否产生过工具调用——区分「一条路都没走」与「走了一半静默结束」。 */
function turnUsedTools(events: ReadonlyArray<TurnEndFact>, turn: number): boolean {
  return events.some(event => event.type === 'tool/call' && dataOf(event)?.['turn'] === turn)
}

/**
 * 非正常结束的回合诊断文本；正常结束（`completed`）或无法定位回合时返回 undefined。
 * `end` 必须是 `endedTurnUserMessageIds` 已经认过的那个 `turn/end`。
 */
export function turnEndFailure(events: ReadonlyArray<TurnEndFact>, end: TurnEndFact): string | undefined {
  if (end.type !== 'turn/end') return undefined
  const data = dataOf(end)
  const turn = data?.['turn']
  const reason = data?.['reason']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return undefined
  if (typeof reason !== 'object' || reason === null) return undefined
  const fields = reason as Record<string, unknown>
  const kind = fields.kind
  if (typeof kind !== 'string' || kind === 'completed') return undefined

  const tail = `turn=${turn} tools=${turnUsedTools(events, turn) ? 'used' : 'none'}`
  if (kind === 'aborted') return `turn-end reason=aborted cause=${cancelCauseText(fields.reason)} | ${tail}`
  if (kind !== 'error') return `turn-end reason=${kind} | ${tail}`
  const fact = errorFact(fields.error)
  if (fact === undefined) return `turn-end reason=error (no structured failure) | ${tail}`
  const status = fact.status === undefined ? '' : ` status=${fact.status}`
  return `turn-end reason=error code=${fact.code}${status}: ${fact.message} | ${tail}`
}

/**
 * Issue #200：Judge 瞬时失败分类——只有明确的瞬时信号才值得自动重试 1 次。
 * - status >= 500 / code=SERVER → 瞬时（上游 5xx）。
 * - status 4xx / 4xx 家族码（INVALID_REQUEST / AUTH / QUOTA / RATE_LIMIT /
 *   CONTEXT_WINDOW_EXCEEDED）→ 非瞬时，直接 BLOCK，重试无意义。
 * - error 文本带网络/流中断痕迹（code=UNKNOWN 等无明确码时）→ 瞬时。
 * - 其余（正常结束无诊断、kind-only 如 aborted/max-tokens/interrupted、未知码、
 *   无结构化失败）→ 一律 fail-closed 不重试：猜错种类的重试比 BLOCK 更危险
 *   （如 aborted 是取消意图，重试会违背调用方）。
 */
export function isTransientJudgeFailure(failure: string | undefined): boolean {
  if (failure === undefined || failure === '') return false
  const status = /status=(\d+)/.exec(failure)
  if (status) {
    const code = Number(status[1])
    if (code >= 500) return true
    // 有明确 status 且 < 500：一律非瞬时（4xx 家族与其它非 5xx 同理）。
    return false
  }
  const errCode = /code=([A-Z_]+)/.exec(failure)
  if (errCode) {
    if (errCode[1] === 'SERVER') return true
    if (['INVALID_REQUEST', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'CONTEXT_WINDOW_EXCEEDED'].includes(errCode[1]!)) return false
    // 未知码 fail-closed：不猜。
    if (/network|fetch|ECONN|EPIPE|ETIMEDOUT|socket|stream|interrupt/i.test(failure)) return true
    return false
  }
  // 无 status、无 code：kind-only（如 aborted/max-tokens/interrupted）或无结构化
  // 失败——无消息文本可分类，一律 fail-closed 不重试。
  return false
}

/**
 * 追加诊断并压到 `blockReason` 的持久化上限内。诊断本身可能来自 provider 的
 * 自由文本，因此**先截诊断**再拼基础原因：基础原因必须永远完整可见。
 */
export function withTurnEndFailure(reason: string, failure: string | undefined): string {
  if (failure === undefined || failure === '') return reason.slice(0, LIMITS.blockReasonMax)
  const marker = ' | '
  const budget = LIMITS.blockReasonMax - reason.length - marker.length
  if (budget <= 0) return reason.slice(0, LIMITS.blockReasonMax)
  return `${reason}${marker}${failure.slice(0, budget)}`
}
