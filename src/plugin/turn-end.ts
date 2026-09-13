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
