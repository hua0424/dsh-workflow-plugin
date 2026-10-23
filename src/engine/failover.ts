/**
 * #235：Role Actor 单备用模型的故障资格判定（纯函数，无宿主依赖）。
 *
 * 纪律：
 * - **按码路由，不解析 message**（`LlmFailure` / `HarnessError` 合同）。判定只用
 *   `turn/end` 结构化失败事实里的 `code` + `status`；没有结构化事实（正常结束、
 *   `aborted`、`max-tokens`、来源不明）一律不切。
 * - **fail-closed**：只有规格明确的四类信号（5xx / 429 非额度语义 / 网络 / 请求
 *   超时）才算合格；认证、额度耗尽、参数非法、上下文超限、空响应、未知码、
 *   工具/存储/插件故障全部不切，保留现行 BLOCK。
 * - 本条判定只回答「故障种类是否值得换模型」；「旧执行是否已安全收口」「恢复
 *   材料是否充分」是引擎侧前提（调用点位于 turn/end 已安全收口分支之后）。
 */
import { LIMITS } from '../types.ts'

/** 本 Run 观测到的模型失败事实（由 `turn/end` 的 `reason.error` 投影，不含 message）。 */
export interface ActorFailureFacts {
  code: string
  status?: number
}

export interface ActorFailureVerdict {
  eligible: boolean
  /** 诊断种类标签（合格=切换原因，不合格=BLOCK 解释）；不是故障码本身。 */
  kind: string
}

/**
 * 明确不因该故障换模型的码（规格「认证/权限/额度/参数/上下文/来源不明不切」的
 * 显式部分）。`QUOTA` / `ACCOUNT_QUOTA` 即使伴随 status=429 也属额度耗尽语义，
 * 换模型只会浪费一次预算，故先于 status 判定拦截。
 */
const INELIGIBLE_CODES: ReadonlyMap<string, string> = new Map([
  ['QUOTA', 'quota-exhausted'],
  ['ACCOUNT_QUOTA', 'quota-exhausted'],
  ['AUTH', 'auth-failed'],
  ['INVALID_CREDENTIAL', 'auth-failed'],
  ['INVALID_REQUEST', 'invalid-request'],
  ['CONTEXT_WINDOW_EXCEEDED', 'context-window'],
  ['IMAGE_OFFLOAD_REQUIRED', 'image-offload'],
])

/** 无 status 时按码认作「上游/网络/超时」的可切换码（宿主 retry 语义里的瞬时家族）。 */
const ELIGIBLE_CODES: ReadonlyMap<string, string> = new Map([
  ['SERVER', 'server-error'],
  ['TIMEOUT', 'request-timeout'],
  ['TRANSPORT', 'network-transport'],
])

/** 故障事实 → 可读诊断串（脱敏：只含码/状态，不含 message 或请求载荷）。 */
export function describeActorFailure(facts: ActorFailureFacts): string {
  return `code=${facts.code}${facts.status === undefined ? '' : ` status=${facts.status}`}`
}

/**
 * 判定一次 Actor 模型失败是否合格切换。`facts` 缺席（无结构化失败）即不合格：
 * 猜错种类地换模型比 BLOCK 更危险。
 */
export function classifyActorFailure(facts: ActorFailureFacts | undefined): ActorFailureVerdict {
  if (facts === undefined) return { eligible: false, kind: 'unstructured' }
  const blocked = INELIGIBLE_CODES.get(facts.code)
  if (blocked !== undefined) return { eligible: false, kind: blocked }
  const { status } = facts
  if (status !== undefined) {
    if (status >= 500 && status <= 599) return { eligible: true, kind: 'server-5xx' }
    // 429 = 限流（非额度耗尽：额度码已在上面拦下）。其余 4xx 与 1xx/2xx/3xx
    // 都不是可切换的瞬时故障。
    if (status === 429) return { eligible: true, kind: 'rate-limited' }
    return { eligible: false, kind: `http-${status}` }
  }
  const eligible = ELIGIBLE_CODES.get(facts.code)
  if (eligible !== undefined) return { eligible: true, kind: eligible }
  // 未知/无状态码：来源不明，fail-closed。
  return { eligible: false, kind: 'unclassified' }
}

/**
 * 切换说明文本（写进 `workflow_set_role_model`/切换事件的同款有界诊断，
 * 同时作为新 Actor 派发正文的 `[模型故障切换]` 段）。不含凭据与请求载荷。
 */
export function failoverNote(input: {
  role: string
  from: string
  to: string
  target: 'primary' | 'fallback'
  facts: ActorFailureFacts
  kind: string
  autoSwitches: number
  exhausted: boolean
}): string {
  const head = `角色 "${input.role}" 的模型路由在 ${describeActorFailure(input.facts)}（${input.kind}）后由宿主终止重试并安全收口；本轮第 ${input.autoSwitches} 次自动切换：${input.from} → ${input.to}（${input.target === 'primary' ? '主模型' : '备用模型'}）。`
  const tail = input.exhausted
    ? '本 Run 该角色已无可用备用路由，再次合格故障将直接 BLOCK（详见下方要求）。'
    : '本 Run 该角色此后保持该路由，不自动回切；如仍需换模型，由 Manager 显式设置后开新一轮（C → 主 → 备用）。'
  return `${head}${tail}`.slice(0, LIMITS.blockReasonMax)
}
