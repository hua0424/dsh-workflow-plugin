/**
 * Issue #221：派发生命周期终止信号收口。
 *
 * 受理（身份已发布）之后、turn/end 到达之前失败的派发，session/event 观察
 * 永远看不到它。宿主正式生命周期接口给出终止信号：
 * - 首次派发的 `activation.result`（resolve 且 stopReason 非 completed，或 reject）；
 * - 全部世代的 `subagent/end`（同 Session 不同活动周期按 runId 区分）。
 *
 * 本模块只做有界、短生命周期的待对账观察材料：真实身份发布后重新验证并
 * 处理。它不是授权来源，也不是持久化状态的替代。完成、替换、失效或插件
 * 卸载时清理相应观察资源；发布窗口内无法证明来源的信号仍 fail-closed。
 */
import { bounded, redact, shortId } from '../engine/tracelog.ts'
import { LIMITS } from '../types.ts'

/** 宿主 `subagent/end` 边的最小终态（`SubagentRunEndInfo` 的结构子集）。 */
export interface ActivationEndInfo {
  /** 同 Session 下的活动周期 id：区分续派/冷续接的不同世代。 */
  runId: string
  /** 终止原因（completed | aborted | error | max-tokens | refusal）。 */
  stopReason: string
  /** 可确定的 provider；不可获得时为 undefined（调用方记 unknown）。 */
  provider?: string
}

/** 一次已发布派发的待对账条目：不可变 Run/执行/派发身份 + 真实会话身份。 */
export interface TrackedDispatch {
  workspaceKey: string
  runId: string
  executionId: string
  nodeToken: string
  dispatchId: string
  kind: 'actor' | 'judge'
  /** actor 角色名；judge 固定为 'judge'。 */
  roleKey: string
  /** 可确定的路由（provider/model/effort），不可获得时缺席。 */
  route?: string
  sessionId: string
  messageId: string
  /** 发布时刻已知的最新活动周期；start 边尚未处理时为 undefined。 */
  epochRunId: string | undefined
  claimId?: string
  inputVersion?: number
  outcome: 'unknown' | 'completed' | 'failed'
  failureCode?: string
  failureSummary?: string
}

export interface ActivationFailure {
  code?: string
  summary?: string
}

export interface DispatchLifecycleTracker {
  /** 同 Session 当前最新的活动周期（`subagent/start` 同步记录）。 */
  epochOf(childId: string): string | undefined
  /** 记录新世代开始（必须在派发受理返回之后、终态到达之前同步调用）。 */
  noteStart(childId: string, runId: string): void
  /** 记录首次派发 activation.result 的终态（成功 resolve / 失败都覆盖）。 */
  noteResult(childId: string, outcome: 'completed' | 'failed', failure?: ActivationFailure): void
  /**
   * 登记一次已发布派发。条目始终留存（调用方对账后清理）；与本世代匹配的
   * 缓存终态一并返回（调用方立即对账），世代不符的缓存终态直接丢弃
   * （陈旧世代的迟到信号不得影响当前状态）。
   */
  track(entry: TrackedDispatch): ActivationEndInfo | undefined
  /** 暂存尚无条目的终态（身份发布前到达的信号），有界、短 TTL。 */
  bufferEnd(childId: string, end: ActivationEndInfo): void
  peek(childId: string): TrackedDispatch | undefined
  forget(childId: string): void
  clear(): void
}

/** 终态缓存：条目上限 + 存活上限（发布前到达的信号只等一个短窗口）。 */
const BUFFER_MAX = 64
const BUFFER_TTL_MS = 60_000
const PENDING_MAX = 512
const FAILURE_SUMMARY_MAX = 500

interface BufferedEnd extends ActivationEndInfo {
  at: number
}

/**
 * 路由三元件的可读缩写；三者皆无时返回 undefined（调用方记 unknown，
 * 不伪造 provider 或具体阶段）。
 */
export function shortRouteLabel(route: { provider?: string; modelId?: string; reasoningEffort?: string } | undefined): string | undefined {
  if (route === undefined) return undefined
  const parts = [route.provider, route.modelId, route.reasoningEffort]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(part => part !== '')
  return parts.length === 0 ? undefined : parts.join('/')
}

export function makeDispatchLifecycleTracker(): DispatchLifecycleTracker {
  /** childId → 当前最新活动周期 runId。 */
  const epochs = new Map<string, string>()
  /** sessionId → 待对账的已发布派发。 */
  const pending = new Map<string, TrackedDispatch>()
  /** sessionId → 身份发布前到达的终态。 */
  const buffered = new Map<string, BufferedEnd>()

  const sweepBuffer = (now: number): void => {
    for (const [key, value] of buffered) {
      if (now - value.at > BUFFER_TTL_MS) buffered.delete(key)
    }
    while (buffered.size > BUFFER_MAX) {
      const oldest = buffered.keys().next()
      if (oldest.done) break
      buffered.delete(oldest.value)
    }
  }

  return {
    epochOf: childId => epochs.get(childId),
    noteStart(childId, runId) {
      if (epochs.size >= PENDING_MAX && !epochs.has(childId)) {
        const oldest = epochs.keys().next()
        if (!oldest.done) epochs.delete(oldest.value)
      }
      epochs.set(childId, runId)
    },
    noteResult(childId, outcome, failure) {
      const entry = pending.get(childId)
      if (entry === undefined) return
      entry.outcome = outcome
      if (failure !== undefined) {
        if (typeof failure.code === 'string' && failure.code.trim() !== '') entry.failureCode = failure.code.trim().slice(0, 120)
        if (typeof failure.summary === 'string' && failure.summary !== '') entry.failureSummary = failure.summary.slice(0, FAILURE_SUMMARY_MAX)
      }
    },
    track(entry) {
      const now = Date.now()
      sweepBuffer(now)
      if (pending.size >= PENDING_MAX && !pending.has(entry.sessionId)) {
        const oldest = pending.keys().next()
        if (!oldest.done) pending.delete(oldest.value)
      }
      pending.set(entry.sessionId, entry)
      const prior = buffered.get(entry.sessionId)
      if (prior === undefined) return undefined
      buffered.delete(entry.sessionId)
      if (entry.epochRunId !== undefined && prior.runId === entry.epochRunId) return { runId: prior.runId, stopReason: prior.stopReason, provider: prior.provider }
      return undefined
    },
    bufferEnd(childId, end) {
      sweepBuffer(Date.now())
      buffered.set(childId, { ...end, at: Date.now() })
      while (buffered.size > BUFFER_MAX) {
        const oldest = buffered.keys().next()
        if (oldest.done) break
        buffered.delete(oldest.value)
      }
    },
    peek: childId => pending.get(childId),
    forget(childId) {
      pending.delete(childId)
    },
    clear() {
      epochs.clear()
      pending.clear()
      buffered.clear()
    },
  }
}

/**
 * 首次派发 activation.result 的观察：成功 resolve 且 stopReason 为 completed
 * 记完成；resolve 非 completed 或 reject 记失败。不抛错（观察失败不得影响派发）。
 */
export function observeActivationResult(
  tracker: DispatchLifecycleTracker | undefined,
  childId: string,
  result: Promise<{ stopReason?: string }> | undefined,
): void {
  if (tracker === undefined || result === undefined || typeof result.then !== 'function') return
  result.then(
    resolved => {
      tracker.noteResult(childId, resolved?.stopReason === 'completed' ? 'completed' : 'failed')
    },
    error => {
      const code = (error as { code?: unknown } | null | undefined)?.code
      tracker.noteResult(childId, 'failed', {
        ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
        summary: error instanceof Error ? error.message : String(error),
      })
    },
  )
}

/**
 * 技术故障 BLOCK 原因：基础原因（角色/派发关联、适用阶段、可确定的路由、
 * 观察阶段、错误码/状态码）在前；有界、脱敏后的失败摘要只追加在后，截断前
 * 基础原因完整。不可获得的值记 unknown，不伪造 provider 错误或具体阶段。
 */
export function describeActivationSettlement(entry: TrackedDispatch, end: ActivationEndInfo): string {
  const phase = entry.kind === 'actor' ? 'working' : 'checking'
  const base = `activation settled without turn/end: ${entry.kind} role=${entry.roleKey}`
    + ` session=${shortId(entry.sessionId)} msg=${shortId(entry.messageId)}`
    + ` phase=${phase} stop=${end.stopReason} provider=${end.provider ?? 'unknown'} route=${entry.route ?? 'unknown'}`
  const code = entry.failureCode !== undefined ? ` code=${redact(entry.failureCode)}` : ''
  const failure = entry.failureSummary !== undefined && entry.failureSummary !== ''
    ? ` failure=${redact(bounded(entry.failureSummary, FAILURE_SUMMARY_MAX))}`
    : ''
  return `${base}${code}${failure}`.slice(0, LIMITS.blockReasonMax)
}
