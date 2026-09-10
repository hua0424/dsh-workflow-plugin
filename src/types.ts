/**
 * Core domain types for agent-workflow/v2 (A1: claim admission + judge
 * confirmation). Pure data types only — no Cordis imports, testable without
 * the host.
 */

export const SCHEMA_VERSION = 'agent-workflow/v2' as const
export const STATE_FORMAT_VERSION = 'agent-workflow-state/v9' as const
export const STATE_TABLE_NAME = 'runs' as const
export const CATALOG_DIR_NAME = 'workflows' as const
export const STATE_DB_NAME = 'state.sqlite3' as const

/** Reserved role keys that must never appear in `roles`. */
export const RESERVED_ROLE_KEYS = ['manager', 'judge'] as const

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

export type EndTarget = 'END'

export interface ActorTaskNode {
  execution: ActorTaskExecution
  checker: CheckerRef
  onPass: string
  onFail?: string
}

export interface BuiltinProgramNode {
  execution: BuiltinProgramExecution
  onPass: string
  onFail?: string
}

export interface ChildWorkflowNode {
  execution: ChildWorkflowExecution
  onPass: string
}

export type NodeDef = ActorTaskNode | BuiltinProgramNode | ChildWorkflowNode

export interface WorkflowDef {
  startNode: string
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
 * Judge confirmation protocol (A1 v2): the Judge only CONFIRMS whether the
 * Actor's claim is trustworthy — ACCEPT/REJECT. The Graph verdict (PASS/FAIL)
 * is derived from the Actor's claim outcome, never from the Judge result.
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

/** Claim outcome a worker may submit. */
export type ClaimOutcome = 'completed' | 'failed'

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

/** A worker's completion claim. No nodeToken (A1 AC2): admission binds the
 * claim to the current dispatch lease, so the claim carries only its payload. */
export interface NodeClaim {
  outcome: ClaimOutcome
  handoff: string
}

/** 工具与 Runtime 共用同一交付合同；失败不产生部分 claim。 */
export function normalizeNodeClaim(claim: NodeClaim): NodeClaim {
  if (Object.keys(claim).some(key => key !== 'outcome' && key !== 'handoff')) {
    throw new WorkflowError('node_claim only accepts outcome and handoff; summary/handoffContext are not supported')
  }
  if (claim.outcome !== 'completed' && claim.outcome !== 'failed') throw new WorkflowError('invalid claim outcome')
  if (typeof claim.handoff !== 'string' || claim.handoff.trim() === '') throw new WorkflowError('handoff is required')
  const handoff = claim.handoff.trim()
  if (handoff.length > LIMITS.handoffMax) throw new WorkflowError(`handoff must be at most ${LIMITS.handoffMax} characters after trim`)
  return { outcome: claim.outcome, handoff }
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
