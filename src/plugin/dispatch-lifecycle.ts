/**
 * Issue #247：Dispatch Lifecycle 观察模块（在 #221 收口基础上的加深）。
 *
 * 受理之后、turn/end 之前失败的派发，session/event 观察永远看不到它。宿主
 * 正式生命周期接口给出终止信号：
 * - 首次派发的 `activation.result`（resolve 且 stopReason 非 completed，或 reject）；
 * - 全部世代的 `subagent/end`（同 Session 不同活动周期按 runId 区分）。
 *
 * 本模块独占「原始观察事实 → 一次可结算的派发终止」这条推理：世代登记、
 * result 挂载与归因、发布窗口内的有界暂存、登记匹配、候选成形与精确失效。
 * 调用者只做两件事——报告它拿到的原始事实（start / result / end / 已发布的
 * 派发身份），以及消费一个不可变候选（或以同一引用释放登记）。调用者不再
 * 自己查世代、回灌缓存、按 Session 猜清理范围，也不再持有可变的观察 Map。
 *
 * 它不持久化、不是授权来源，也不决定工作单如何推进：候选是否仍指向当前
 * 工作单、是否 BLOCK，仍由引擎判定。观察资源有界；完成、替换、失效或插件
 * 卸载时清理。
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

/** 一次已发布派发在模块内形成的不可变候选（引擎只读，判断与原因文本都在此）。 */
export interface DispatchCandidate {
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
  /** 登记时点的最新活动周期；start 边尚未处理时为 undefined。 */
  epochRunId: string | undefined
  claimId?: string
  inputVersion?: number
  /** 已归属到本次登记的终态边（推不出归属时不会形成候选）。 */
  end: ActivationEndInfo
  outcome: 'unknown' | 'completed' | 'failed'
  failureCode?: string
  failureSummary?: string
}

/** 引擎发布一次已受理派发时提供的事实：身份 + 真实会话，不含世代与终态归因。 */
export type DispatchPublication = Omit<DispatchCandidate, 'epochRunId' | 'end' | 'outcome' | 'failureCode' | 'failureSummary'>

/** 待对账观察的引用：只标识「哪个会话的第几次登记」，不携带归因内容。 */
export interface DispatchObservationRef {
  sessionId: string
  registration: number
}

export interface ActivationFailure {
  code?: string
  summary?: string
}

/**
 * 观察模块的对外契约。除 `consume` 外都是同步的事实报告/失效；`consume` 是
 * 唯一把事实变成候选的出口（同一引用可重复消费，直到 `release`）。
 */
export interface DispatchLifecycle {
  /** 记录新世代开始（`subagent/start` 边，必须先于该世代的终态到达）。 */
  noteStart(childId: string, epochRunId: string): void
  /** 挂载首次派发的终止结果观察（成功 resolve / reject 都覆盖；不抛错）。 */
  observeResult(childId: string, result: Promise<{ stopReason?: string }> | undefined): void
  /** 报告终态边：能归属到当前登记则返回待消费引用，否则有界暂存（等发布对账）。 */
  noteEnd(childId: string, end: ActivationEndInfo): DispatchObservationRef | undefined
  /** 登记一次已发布派发；发布窗口内已到的同世代终态随本次登记一并可消费。 */
  publish(fact: DispatchPublication): DispatchObservationRef | undefined
  /** 归属完成后形成的不可变候选；登记已被替换/失效或终态推不出归属时为 undefined。 */
  consume(ref: DispatchObservationRef): Promise<DispatchCandidate | undefined>
  /** 精确失效本次登记（同 registration 才删；替换后的新登记不受影响）。 */
  release(ref: DispatchObservationRef): void
  /** 业务点主动作废观察：给了 dispatchId 时只作废该派发，否则作废该会话的登记。 */
  invalidate(childId: string, dispatchId?: string): void
  /**
   * 释放本插件实例的全部观察资源并关闭模块：此后的迟到回调（旧宿主句柄、
   * 卸载中的异步转交）既不能重新登记，也不能产出候选。
   */
  dispose(): void
}

/** 有界观察上限：发布窗口暂存（配悬浮生存窗口）+ 每会话最近一次 result 归因。 */
const BUFFER_MAX = 64
const BUFFER_TTL_MS = 60_000
const PENDING_MAX = 512
const FAILURE_SUMMARY_MAX = 500

interface BufferedEnd extends ActivationEndInfo {
  at: number
}

/** 一次已发布登记的待对账状态：不可变的发布事实 + 可能已归属的终态边。 */
interface Registration {
  registration: number
  fact: DispatchPublication
  epochRunId: string | undefined
  end?: ActivationEndInfo
}

/** result 观察终态：挂载时点的世代 + 失败证据（按会话保存最近一次）。 */
interface ResultObservation {
  epoch: string | undefined
  outcome: 'completed' | 'failed'
  failureCode?: string
  failureSummary?: string
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

export function makeDispatchLifecycle(): DispatchLifecycle {
  /** childId → 当前最新活动周期 runId。 */
  const epochs = new Map<string, string>()
  /** sessionId → 当前已发布的登记（同一会话同时只有一个可结算的派发）。 */
  const pending = new Map<string, Registration>()
  /** sessionId → 身份发布前到达的终态边。 */
  const buffered = new Map<string, BufferedEnd>()
  /**
   * sessionId → 最近一次 result 观察终态（按挂载世代归因）。
   *
   * 不设 TTL：挂载世代就是 result 所属的 residency epoch，必须活过「结果先到、
   * 身份发布后到」的发布窗口，否则会丢失规格要求等价交付的事实。寿命由三件事
   * 封顶——每会话只留最近一条、至多 BUFFER_MAX 个会话、随覆盖/驱逐/dispose
   * 释放；条目只含标量，不持有会话或宿主对象。
   */
  const outcomes = new Map<string, ResultObservation>()
  /** 卸载后关闭：迟到回调不得再登记或产出候选。 */
  let disposed = false
  let registrations = 0

  const dropOldest = (map: Map<string, unknown>, max: number, keep: string): void => {
    if (map.size < max || map.has(keep)) return
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }

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

  /**
   * 只有能证明同世代归属的 result 终态才可认领：世代未知（登记或挂载时点缺
   * start）与世代不符一样无法证明，按规格「未知归属不得误绑定」丢弃。
   */
  const attributable = (entry: Registration): ResultObservation | undefined => {
    const observed = outcomes.get(entry.fact.sessionId)
    if (observed === undefined) return undefined
    if (entry.epochRunId === undefined || observed.epoch !== entry.epochRunId) return undefined
    return observed
  }

  const ref = (entry: Registration): DispatchObservationRef => ({ sessionId: entry.fact.sessionId, registration: entry.registration })

  /** 暂存尚无身份可归属的终态边（有界、短 TTL，只等一次发布）。 */
  const buffer = (childId: string, end: ActivationEndInfo): void => {
    sweepBuffer(Date.now())
    buffered.set(childId, { ...end, at: Date.now() })
    while (buffered.size > BUFFER_MAX) {
      const oldest = buffered.keys().next()
      if (oldest.done) break
      buffered.delete(oldest.value)
    }
  }

  return {
    noteStart(childId, epochRunId) {
      if (disposed) return
      dropOldest(epochs, PENDING_MAX, childId)
      epochs.set(childId, epochRunId)
    },
    observeResult(childId, result) {
      if (disposed) return
      if (result === undefined || typeof result.then !== 'function') return
      // 挂载时点的世代：迟到的旧世代 result 不得贴到之后发布的新登记上。
      const epoch = epochs.get(childId)
      const record = (outcome: 'completed' | 'failed', failure?: ActivationFailure): void => {
        // 卸载后晚到的 resolve/reject 不得重新登记观察资源。
        if (disposed) return
        dropOldest(outcomes, BUFFER_MAX, childId)
        outcomes.set(childId, {
          epoch,
          outcome,
          ...(failure?.code !== undefined ? { failureCode: failure.code } : {}),
          ...(failure?.summary !== undefined ? { failureSummary: failure.summary } : {}),
        })
      }
      result.then(
        resolved => {
          record(resolved?.stopReason === 'completed' ? 'completed' : 'failed')
        },
        error => {
          const code = (error as { code?: unknown } | null | undefined)?.code
          const text = typeof code === 'string' || typeof code === 'number' ? String(code).trim() : ''
          record('failed', {
            ...(text !== '' ? { code: text.slice(0, 120) } : {}),
            summary: error instanceof Error ? error.message : String(error),
          })
        },
      )
    },
    noteEnd(childId, end) {
      if (disposed) return undefined
      const entry = pending.get(childId)
      if (entry === undefined) {
        // 发布窗口内到达：有界暂存，等身份发布时对账。
        buffer(childId, end)
        return undefined
      }
      if (entry.epochRunId !== undefined && entry.epochRunId !== end.runId) {
        if (end.runId === epochs.get(childId)) {
          // 结束属于更新的世代：旧登记作废，缓存该信号等新身份发布时对账。
          pending.delete(childId)
          buffer(childId, end)
        }
        // 陈旧世代的迟到信号：忽略，保留当前登记。
        return undefined
      }
      entry.end = { runId: end.runId, stopReason: end.stopReason, ...(end.provider === undefined ? {} : { provider: end.provider }) }
      return ref(entry)
    },
    publish(fact) {
      if (disposed) return undefined
      sweepBuffer(Date.now())
      dropOldest(pending, PENDING_MAX, fact.sessionId)
      registrations += 1
      const entry: Registration = { registration: registrations, fact, epochRunId: epochs.get(fact.sessionId) }
      pending.set(fact.sessionId, entry)
      const prior = buffered.get(fact.sessionId)
      if (prior === undefined) return undefined
      buffered.delete(fact.sessionId)
      // 无法证明世代归属（发布时无 start 或世代不符）的缓存终态直接丢弃；只有
      // 同世代的终态才让候选立即可消费。
      if (entry.epochRunId === undefined || prior.runId !== entry.epochRunId) return undefined
      entry.end = { runId: prior.runId, stopReason: prior.stopReason, ...(prior.provider === undefined ? {} : { provider: prior.provider }) }
      return ref(entry)
    },
    async consume(observation) {
      if (disposed) return undefined
      // 宿主终结偏序是「发布 end → resolve result」：先让已排队的 result 微任务
      // 被观察，再成形候选，使「end 先到、result 随后」与「result 先到」得到
      // 同一组事实（不等待整个 result，候选只在消费时点成形一次）。
      await Promise.resolve()
      const entry = pending.get(observation.sessionId)
      if (entry === undefined || entry.registration !== observation.registration) return undefined
      const end = entry.end
      if (end === undefined) return undefined
      const observed = attributable(entry)
      return {
        ...entry.fact,
        epochRunId: entry.epochRunId,
        end,
        outcome: observed?.outcome ?? 'unknown',
        ...(observed?.failureCode !== undefined ? { failureCode: observed.failureCode } : {}),
        ...(observed?.failureSummary !== undefined ? { failureSummary: observed.failureSummary } : {}),
      }
    },
    release(observation) {
      if (disposed) return
      const entry = pending.get(observation.sessionId)
      if (entry?.registration === observation.registration) pending.delete(observation.sessionId)
    },
    invalidate(childId, dispatchId) {
      if (disposed) return
      const entry = pending.get(childId)
      if (entry === undefined) return
      if (dispatchId !== undefined && entry.fact.dispatchId !== dispatchId) return
      pending.delete(childId)
    },
    dispose() {
      disposed = true
      epochs.clear()
      pending.clear()
      buffered.clear()
      outcomes.clear()
    },
  }
}

/**
 * 技术故障 BLOCK 原因：基础原因（角色/派发关联、适用阶段、可确定的路由、
 * 观察阶段、错误码/状态码）在前；有界、脱敏后的失败摘要只追加在后，截断前
 * 基础原因完整。不可获得的值记 unknown，不伪造 provider 错误或具体阶段。
 */
export function describeActivationSettlement(candidate: DispatchCandidate): string {
  const phase = candidate.kind === 'actor' ? 'working' : 'checking'
  const base = `activation settled without turn/end: ${candidate.kind} role=${candidate.roleKey}`
    + ` session=${shortId(candidate.sessionId)} msg=${shortId(candidate.messageId)}`
    + ` phase=${phase} stop=${candidate.end.stopReason} provider=${candidate.end.provider ?? 'unknown'} route=${candidate.route ?? 'unknown'}`
  const code = candidate.failureCode !== undefined ? ` code=${redact(candidate.failureCode)}` : ''
  const failure = candidate.failureSummary !== undefined && candidate.failureSummary !== ''
    ? ` failure=${redact(bounded(candidate.failureSummary, FAILURE_SUMMARY_MAX))}`
    : ''
  return `${base}${code}${failure}`.slice(0, LIMITS.blockReasonMax)
}
