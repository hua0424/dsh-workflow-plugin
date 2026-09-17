/**
 * Core domain types for agent-workflow/v3 (named node results, exit contracts
 * and explicit workflow returns). Pure data types only — no Cordis imports,
 * testable without the host.
 *
 * v3 取代 v2 的 outcome(completed/failed)+onPass/onFail 双语义：节点声明有限
 * 命名结果，每个结果带自己的验收条件与静态目标；流程声明非空 `returns`，到达
 * 终局时显式产生业务返回。不保留 v2 兼容层。
 */

export const SCHEMA_VERSION = 'agent-workflow/v3' as const
export const STATE_FORMAT_VERSION = 'agent-workflow-state/v10' as const
/** SQLite `PRAGMA user_version` of the current state format (single source). */
export const STATE_USER_VERSION = 10 as const
export const CATALOG_DIR_NAME = 'workflows' as const
export const STATE_DB_NAME = 'state.sqlite3' as const

/** Reserved role keys that must never appear in `roles`. */
export const RESERVED_ROLE_KEYS = ['manager', 'judge'] as const

/**
 * #60: Role 会话复用粒度。`node` = 节点级复用（离开节点即 drain + 撤权），
 * `continuable` = 旧行为（复用 continuable 会话、跨节点边界 compact）。
 */
export const ROLE_REUSE_MODES = ['node', 'continuable'] as const

export type RoleReuseMode = (typeof ROLE_REUSE_MODES)[number]

/**
 * #60: `reuse` 的缺省是 `node`。catalog 归一化（写进 definitionSnapshot）与
 * 运行期读取共用这一个缺省源，避免两处各写一个默认值而漂移。
 */
export function roleReuseMode(role: RoleDefinition | undefined): RoleReuseMode {
  return role?.reuse ?? 'node'
}

/** Allowed workflow-id / role-key / node-id filename grammar. */
export const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** Length bounds from the design. */
export const LIMITS = {
  criteriaMin: 1,
  criteriaMax: 8000,
  reasonMin: 1,
  reasonMax: 2000,
  handoffMax: 8000,
  resolutionMin: 1,
  resolutionMax: 8000,
  blockReasonMax: 4000,
  /** A1 D3: model-route component caps (characters, after trim). */
  providerMax: 64,
  modelIdMax: 128,
  programParametersMax: 8000,
} as const

export interface RoleModel {
  provider: string
  modelId: string
}

/**
 * 只知部分的模型路由：调用方为 Role、Judge 或冻结默认值提供其中任一（或两个）
 * 分量，解析时由下一个来源补齐缺口。
 */
export type DelegationRoute = Partial<RoleModel>

/**
 * #118 D-91-1：DSH spawn/resume 边界的 agentOptions 形状——宿主 API 说 `model`，
 * 领域事实说 `modelId`。两个方向各只保留**一个**命名交界函数（下方），除此之外
 * 全仓库统一以 `DelegationRoute` 表达模型路由，不再出现散落的条件展开转换。
 */
export interface SpawnAgentOptions {
  provider?: string
  model?: string
}

/** 唯一的 modelId→model 交界：路由 → DSH agentOptions；两个分量都缺即 undefined（宿主继承）。 */
export function routeToAgentOptions(route: DelegationRoute | undefined): SpawnAgentOptions | undefined {
  if (route === undefined || (route.provider === undefined && route.modelId === undefined)) return undefined
  return { provider: route.provider, model: route.modelId }
}

/** 唯一的 model→modelId 交界：DSH agentOptions → 冻结进 Run row 的路由。 */
export function agentOptionsToRoute(options: SpawnAgentOptions): DelegationRoute {
  const route: DelegationRoute = {}
  if (options.provider !== undefined) route.provider = options.provider
  if (options.model !== undefined) route.modelId = options.model
  return route
}

/**
 * Issue #41：catalog def 层 → 角色 route 的共享单源（`'judge'` 固定取
 * judgeRole，其余取 roles[roleKey]）。`checkCatalogProviders`、start 前置
 * 检查与 `resolveRoleModel` 的 def 分支三方共用；签名不依赖 RunState。
 */
export function readRoleDefModel(
  config: Pick<WorkflowConfig, 'roles' | 'judgeRole'>,
  roleKey: 'judge' | string,
): RoleModel | undefined {
  return roleKey === 'judge' ? config.judgeRole.model : config.roles[roleKey]?.model
}

/**
 * A1 D3: the single trim-then-normalize rule for model routes, shared by the
 * catalog schema caps and `handleSetRoleModel`. Empty-after-trim or
 * over-limit components are rejected with the limit in the message; the
 * returned values are the trim results actually stored.
 */
export function normalizeModelRoute(provider: string, modelId: string): RoleModel {
  const p = provider.trim()
  const m = modelId.trim()
  if (p === '') throw new WorkflowError(`provider must be 1..${LIMITS.providerMax} characters after trim`)
  if (p.length > LIMITS.providerMax) throw new WorkflowError(`provider must be at most ${LIMITS.providerMax} characters after trim (got ${p.length})`)
  if (m === '') throw new WorkflowError(`modelId must be 1..${LIMITS.modelIdMax} characters after trim`)
  if (m.length > LIMITS.modelIdMax) throw new WorkflowError(`modelId must be at most ${LIMITS.modelIdMax} characters after trim (got ${m.length})`)
  return { provider: p, modelId: m }
}

export interface RoleDefinition {
  persona: string
  model?: RoleModel
  tools?: { deny: string[] }
  /**
   * #60: 会话复用粒度。省略时归一化为 `node`。manager 不使用该字段
   * （`manager` 是保留 roleKey，禁止出现在 `roles` 中）。
   */
  reuse?: RoleReuseMode
}

export interface JudgeRoleDefinition {
  persona: string
  model?: RoleModel
  /** Extra tool names to hide from the Judge, on top of the plugin default deny list. */
  tools?: { deny: string[] }
}

export type ActorTaskExecution = {
  type: 'actor-task'
  role: string
  instruction: string
}

export type BuiltinProgramExecution = {
  type: 'builtin-program'
  programId: string
  instruction?: string
  config?: Record<string, unknown>
}

export type ChildWorkflowExecution = {
  type: 'child-workflow'
  workflowId: string
}

export type Execution = ActorTaskExecution | BuiltinProgramExecution | ChildWorkflowExecution

export interface CheckerRef {
  checkerId: string
  config: Record<string, unknown>
}

/**
 * 统一 Target（v3）：恰好一个字段。`node` 指向本流程内的节点，`return` 指向
 * 本流程声明的返回名。没有裸字符串 END、没有默认路由、没有通配映射。
 */
export type Target = { node: string } | { return: string }

/** 一个节点的命名结果：非空验收条件 + 一个静态目标。 */
export interface ResultDef {
  criteria: string
  target: Target
}

/**
 * Program 节点的结果键是执行协议固定的 PASS/FAIL（不是业务结果名）。这是静态
 * 校验与 schema 共用的单源。
 */
export const PROGRAM_RESULT_NAMES = ['PASS', 'FAIL'] as const

export interface ActorTaskNode {
  execution: ActorTaskExecution
  checker: CheckerRef
  /** 必填非空；单出口节点也显式声明，不隐含任何结果。 */
  results: Record<string, ResultDef>
}

export interface BuiltinProgramNode {
  execution: BuiltinProgramExecution
  /** Program 的 PASS/FAIL 沿用统一 Target（ERROR 不路由，交 Manager 事实确认）。 */
  results: Record<string, ResultDef>
}

export interface ChildWorkflowNode {
  execution: ChildWorkflowExecution
  /** 键集合必须与被调用流程的 `returns` 精确相等；值为本层 Target（可重命名并继续返回）。 */
  onReturn: Record<string, Target>
}

export type NodeDef = ActorTaskNode | BuiltinProgramNode | ChildWorkflowNode

/**
 * NodeDef 的类型交界（单点）：判别键是嵌套的 `execution.type`（`results` 同时
 * 存在于 Actor 与 Program 上，不能单独作判别属性），而 TypeScript 不会因嵌套
 * 判别键收窄整对象——因此**只在这三个 helper 内**做一次收窄断言，其余代码一律
 * 通过这些 helper 取用，不再散落 `as`。
 */
export function isActorTaskNode(node: NodeDef): node is ActorTaskNode {
  return node.execution.type === 'actor-task'
}

/** 结果映射：Actor/Program 共用，Child 返回 undefined（它的裁决名是被调用流程的返回名）。 */
export function nodeResults(node: NodeDef): Record<string, ResultDef> | undefined {
  return isActorTaskNode(node) || node.execution.type === 'builtin-program'
    ? (node as ActorTaskNode | BuiltinProgramNode).results
    : undefined
}

/** actor-task 节点的 checker 引用；其它执行类型返回 undefined。 */
export function nodeChecker(node: NodeDef): CheckerRef | undefined {
  return isActorTaskNode(node) ? node.checker : undefined
}

/** Child caller 的返回映射；非 child-workflow 节点返回 undefined。 */
export function nodeOnReturn(node: NodeDef): Record<string, Target> | undefined {
  return node.execution.type === 'child-workflow' ? (node as ChildWorkflowNode).onReturn : undefined
}

export interface WorkflowDef {
  startNode: string
  /** 非空且不重复的返回名；Root 的返回即 Run 的业务终局。 */
  returns: string[]
  nodes: Record<string, NodeDef>
}

/** Normalized full catalog file contents (definition snapshot). */
export interface WorkflowConfig {
  schemaVersion: typeof SCHEMA_VERSION
  roles: Record<string, RoleDefinition>
  judgeRole: JudgeRoleDefinition
  workflow: WorkflowDef
  childWorkflows?: Record<string, WorkflowDef>
}

/**
 * 已确认的流程业务返回：返回名 + 终局来源 executionId。handoff 不在这里镜像，
 * 始终从终局工作单自己的材料（claim / Program result / Child result）读取。
 */
export interface RunReturn {
  name: string
  source: string
}

export type RunStatus = 'running' | 'blocked' | 'completed' | 'terminated'

/**
 * The precise local cursor for one Node's context isolation (A1 R2). Built when
 * the Node is actually dispatched (A1 R1); timestamps only order, cursors only
 * filter (A1 R3).
 */
export interface NodeContextBoundary {
  /** Unix epoch ms when the Node was actually dispatched. */
  dispatchedAt: number
  /** Manager Session next-seq at the dispatch boundary. */
  managerFromSeq: number
  /** Non-manager executor Session id for this Node, when one exists. */
  executorSessionId?: string
  /** The dispatch message id returned by startContinuable/followup (A1 R2). */
  executorDispatchMessageId?: string
}

/**
 * Judge confirmation protocol (v3): the Judge only CONFIRMS whether the
 * Actor's claim is trustworthy — ACCEPT/REJECT/NEED_CONTEXT. The routing target
 * comes from the Actor's chosen `result`, never from the Judge's verdict; the
 * Judge never picks or re-picks a business result.
 */
export type JudgeVerdict = 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT'

export interface CallFrame {
  workflowId: string
  nodeId: string
  nodeToken: string
  executionId: string
}

export interface ModelOverride {
  provider: string
  modelId: string
}

/** Run只管位置/控制/固定Snapshot/Role映射；节点材料属于NodeExecution。 */
export interface RunState {
  runId: string
  managerSessionId: string
  catalogWorkflowId: string
  definitionHash: string
  definitionSnapshot: WorkflowConfig
  status: RunStatus
  callStack: CallFrame[]
  roleActors: Record<string, string>
  modelOverrides: Record<string, ModelOverride>
  blockReason: string | null
  /** 当前 visit；completed 时仍指向终局工作单，最终交付从该工作单读取。 */
  currentExecutionId: string
  /**
   * Absolute path of this run's trace log file (A3). Persisted so events
   * after a host restart (restart-reconcile BLOCK, post-restart resume)
   * still append to the SAME file; absent for pre-A3 rows (logging no-ops).
   * The trace log itself remains a derived artifact — this path is metadata,
   * never workflow state.
   */
  traceLogPath?: string
  /**
   * #91: 本 Run 启动时冻结的默认模型路由（来源=Manager 的
   * `parentAgentOptionsForDelegation` 语义：最新 request header 优先、创建
   * options 兜底）。Role/Judge 未显式配模型时从这里解析默认路由，不再读
   * Engine 实例级共享值——既不会跨 workspace 串用，也能在 Store 重开后稳定。
   * 旧 Run 无该字段：不推测原始值，fresh 派发交回宿主
   * `resolveChildAgentOptions` 的继承语义（仍只从本 Run 自己的 Manager 解析）。
   */
  delegationRoute?: DelegationRoute
  /**
   * 已确认的业务终局（v3）：只在 completed 时存在，名字取自 Root 的 `returns`。
   * terminated/reset 不制造业务返回；handoff 仍只存在于终局工作单材料。
   */
  businessReturn?: RunReturn
}

/** 派发意图先存；messageId 只由真实 Host 返回，不能由模型填写。 */
export interface ExecutionDispatch {
  id: string
  sessionId?: string
  messageId?: string
  settled: boolean
}

export interface ExecutionClaim extends NodeClaim {
  id: string
  dispatchId: string
}

export interface ExecutionJudge extends ExecutionDispatch {
  sessionId: string
  claimId: string
  inputVersion: number
}

/** 最新 Judge 判定/反馈；保留 claim/Judge/input 关联，只有 ACCEPT 可交接。 */
export interface ExecutionJudgment extends JudgeResult {
  claimId: string
  judgeDispatchId: string
  judgeSessionId: string
  inputVersion: number
}

export type ResumeTarget = 'auto' | 'actor' | 'judge'

/** 当前完整补充/恢复材料；后续补充替换它，旧值由 events 保留。 */
export interface ExecutionResolution {
  target: Exclude<ResumeTarget, 'auto'> | 'child'
  /** 每次 node_resume 提供的完整当前补充；respawn 不伪造补充。 */
  context?: string
  /** 最近一次 Manager 恢复/重建决定，供事件解释，不作为新 criteria。 */
  decision?: string
  /** Judge 恢复沿普通 driver 续接持久 Session 或重新创建。 */
  judgeMode?: 'followup' | 'fresh'
  judgeSessionId?: string
  inputVersion: number
}

export interface ExecutionProgram {
  id: string
  parameters: Record<string, unknown>
  result?:
    | { kind: 'PASS' | 'FAIL'; handoff: string; reason?: string }
    | { kind: 'ERROR'; reason: string }
}

export interface ExecutionChild {
  workflowId: string
  executionId: string
  /**
   * 子流程已结算的终局：`terminalExecutionId` 是子流程内实际裁决终局的那张工作单
   * （两层及以上连续返回时指向下一层 caller，形成可追溯的来源链）；handoff 是原文。
   */
  result?: { terminalExecutionId: string; handoff: string }
}

/** 一次 Graph visit 的唯一当前材料。revision 与派发/claim/Program 身份互不替代。 */
export interface NodeExecution {
  executionId: string
  runId: string
  workflowId: string
  nodeId: string
  nodeToken: string
  visit: number
  revision: number
  input: string
  phase: 'ready' | 'working' | 'checking' | 'settling' | 'exited'
  /** 当前 visit 的 Role 边界 compact 已完成或无需执行；Host Queue 前持久化。 */
  roleBoundaryPrepared: boolean
  /** Host 重启已观察到；Manager resume 消费该标记，不依赖中断事件是否存在。 */
  restartPending: boolean
  predecessorId?: string
  successorId?: string
  boundary?: NodeContextBoundary
  dispatch?: ExecutionDispatch
  claim?: ExecutionClaim
  /** REJECT/显式退回后保留的已失效旧 claim；不授予当前提交资格。 */
  previousClaim?: ExecutionClaim
  judge?: ExecutionJudge
  /** 最近被替换的 Judge 身份；只保留一代，完整历史由 events 保存。 */
  previousJudge?: ExecutionJudge
  judgment?: ExecutionJudgment
  resolution?: ExecutionResolution
  program?: ExecutionProgram
  child?: ExecutionChild
  /**
   * v3：本工作单退出时实际裁决的终局名。`result` = 节点结果名（机构内节点退出），
   * `return` = 流程返回名（本流程正常结束；Root 时即 Run 的业务终局）。这是
   * status/通知/trace 解释终局的单源，不再另存一份可漂移的终局文本。
   */
  returned?: { kind: 'result' | 'return'; name: string; source: string }
  inputVersion: number
  blockReason: string | null
  enteredAt: string
  exitedAt?: string
}

export const EVENT_TYPES = ['entered', 'actor-arranged', 'claim', 'judge-arranged', 'judgment', 'exited', 'blocked', 'manager-context', 'resumed', 'judge-respawned', 'interrupted', 'program-ready', 'program-arranged', 'program-result', 'program-resolved', 'child-entered', 'child-returned', 'model-changed', 'terminated'] as const
export type NodeExecutionEventType = typeof EVENT_TYPES[number]

export interface NodeExecutionEvent {
  executionId: string
  sequence: number
  type: NodeExecutionEventType
  at: string
  snapshot: NodeExecution
}

/** 一个短事务可同时保存前驱、后继及所有对应关键快照。 */
export interface ExecutionChange {
  execution: NodeExecution
  expectedRevision: number | null
  events: NodeExecutionEventType[]
}

export interface StateRow {
  workspaceKey: string
  formatVersion: typeof STATE_FORMAT_VERSION
  stateVersion: number
  run: RunState
  execution: NodeExecution
  updatedAt: string
}

/**
 * A1 R3: who is calling node_claim / node_block — the calling session plus a
 * snapshot of the CURRENT turn's user/message ids (taken by the tool layer
 * from the caller's session log BEFORE enqueuing the mutation; ids only grow
 * within a turn, so the snapshot is stable for the admission decision).
 */
export interface ClaimCaller {
  sessionId: string
  turnUserMessageIds: ReadonlySet<string>
}

/**
 * A worker's claim: ONE named node result plus the single handoff. No
 * nodeToken (A1 AC2): admission binds the claim to the current dispatch lease.
 * The result name is only meaningful inside the frozen node's declared results;
 * the runtime enumerates and validates it before any state is written.
 */
export interface NodeClaim {
  result: string
  handoff: string
}

/** 工具与 Runtime 共用同一交付合同；失败不产生部分 claim。 */
export function normalizeNodeClaim(claim: { result?: unknown; handoff?: unknown }): NodeClaim {
  if (Object.keys(claim).some(key => key !== 'result' && key !== 'handoff')) {
    throw new WorkflowError('node_claim only accepts result and handoff; outcome/summary/handoffContext are not supported')
  }
  if (typeof claim.result !== 'string' || !ID_PATTERN.test(claim.result)) {
    throw new WorkflowError('node_claim result must be a declared lowercase result name')
  }
  if (typeof claim.handoff !== 'string' || claim.handoff.trim() === '') throw new WorkflowError('handoff is required')
  const handoff = claim.handoff.trim()
  if (handoff.length > LIMITS.handoffMax) throw new WorkflowError(`handoff must be at most ${LIMITS.handoffMax} characters after trim`)
  return { result: claim.result, handoff }
}

/** Judge decision submitted through the `judge_claim` protocol (A1 R9). */
export interface JudgeResult {
  result: JudgeVerdict
  reason: string
}

/** Builtin program terminal outcome. */
export type ProgramResult =
  | { kind: 'PASS'; handoff?: string; details?: unknown }
  | { kind: 'FAIL'; reason?: string; handoff?: string; details?: unknown }
  | { kind: 'ERROR'; reason: string; details?: unknown }

/** Tool-facing result codes surfaced as tool error text. */
export class WorkflowError extends Error {
  readonly code: string
  constructor(message: string, code = 'WORKFLOW') {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}
