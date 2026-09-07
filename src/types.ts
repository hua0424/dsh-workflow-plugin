/**
 * Core domain types for agent-workflow/v2 (A1: claim admission + judge
 * confirmation). Pure data types only — no Cordis imports, testable without
 * the host.
 */

export const SCHEMA_VERSION = 'agent-workflow/v2' as const
export const STATE_FORMAT_VERSION = 'agent-workflow-state/v2' as const
export const STATE_TABLE_NAME = 'workflow_state' as const
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

export type RunStatus = 'running' | 'blocked' | 'completed'

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
}

export interface ModelOverride {
  provider: string
  modelId: string
}

/**
 * The minimal persistent runtime state (design §5). Serialized as
 * `snapshot_json.definitionSnapshot`-sibling fields on the state row.
 */
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
  /** Current Node's precise context boundary (A1 R2/R4). */
  nodeBoundary: NodeContextBoundary
  /** Current active/pending Judge session id for this Node (A1/A4). */
  judgeSessionId?: string
  /** 判定阶段唯一候选交付；首次、返工和 Judge 重建共用。 */
  pendingClaim?: NodeClaim
  /** ponytail: T2 仅在 completed 保存 END 交付；T3 移入终局工作单，不作活动材料镜像。 */
  finalHandoff?: string
  /**
   * A1 §6.4 (D4): the durable REJECT evidence for the current node — the
   * Judge's rejection reason plus a snapshot of the claim it rejected.
   * Written on every REJECT (overwriting), retained through re-claims /
   * NEED_CONTEXT / judge-fault BLOCKs / correction-dispatch-failure BLOCKs
   * (resume rebuilds the correction message from it), and cleared by
   * `advance()` when the node finally leaves.
   */
  pendingCorrection?: PendingCorrection
  /**
   * 20260906-claim-handoff-symmetry: the one-shot transient context of a
   * DEFERRED dispatch, persisted with the advanced run by `persistDeferred`
   * so the window between the accepted claim (PASS/FAIL) and the deferred
   * dispatch cannot lose the handoff on a host restart — the in-memory
   * DispatchBook dies with the process, this field does not. Consumed by
   * exactly one successful dispatch (`dispatchNow` clears it) or by a resume
   * (the actor-path resume re-delivers it alongside the Manager's resolution).
   * Only set while `status === 'running'`: a FAIL without onFail BLOCKs with
   * the claim consumed, so it never carries a pending dispatch.
   */
  pendingDispatchContext?: TransientDispatch
  /**
   * Absolute path of this run's trace log file (A3). Persisted so events
   * after a host restart (restart-reconcile BLOCK, post-restart resume)
   * still append to the SAME file; absent for pre-A3 rows (logging no-ops).
   * The trace log itself remains a derived artifact — this path is metadata,
   * never workflow state.
   */
  traceLogPath?: string
}

export interface StateRow {
  workspaceKey: string
  formatVersion: typeof STATE_FORMAT_VERSION
  stateVersion: number
  run: RunState
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

/**
 * A1 §3 + 20260906-claim-handoff-symmetry: one-shot transient context for the
 * next dispatch — `handoff` (an accepted PASS/FAIL edge / resolution) or
 * `correction` (a REJECTed claim re-dispatched to the same node). Identical
 * rules for completed and failed: the outcome only picks the onPass/onFail
 * edge, never the framing. Threading the kind through DispatchBook /
 * persistDeferred / dispatchNow keeps the delayed correction's header
 * distinct from `[handoff]`.
 */
export type TransientDispatch =
  | { kind: 'handoff'; text: string }
  | { kind: 'correction'; text: string }

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

/** A1 §6.4: persisted REJECT evidence for the current node's correction cycle. */
export interface PendingCorrection {
  /** The Judge's REJECT reason (≤ reasonMax) — reused verbatim as the correction instruction. */
  judgeReason: string
  /** Snapshot of the claim the Judge rejected. */
  previousClaim: NodeClaim
}

/** Judge decision submitted through the `judge_claim` protocol (A1 R9). */
export interface JudgeResult {
  result: JudgeVerdict
  reason: string
}

/** Builtin program terminal outcome. */
export type ProgramResult =
  | { kind: 'PASS'; details?: unknown }
  | { kind: 'FAIL'; reason?: string }
  | { kind: 'ERROR'; reason: string }

/** Tool-facing result codes surfaced as tool error text. */
export class WorkflowError extends Error {
  readonly code: string
  constructor(message: string, code = 'WORKFLOW') {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}
