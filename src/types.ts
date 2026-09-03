/**
 * Core domain types for agent-workflow/v1.
 * Pure data types only — no Cordis imports, testable without the host.
 */

export const SCHEMA_VERSION = 'agent-workflow/v1' as const
export const STATE_FORMAT_VERSION = 'agent-workflow-state/v1' as const
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
  summaryMin: 1,
  summaryMax: 4000,
  handoffMax: 8000,
  resolutionMin: 1,
  resolutionMax: 8000,
  blockReasonMax: 4000,
} as const

export interface RoleModel {
  provider: string
  modelId: string
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

/** Judge verdict + protocol (A1 R9). PASS/FAIL are the only Graph results. */
export type JudgeVerdict = 'PASS' | 'FAIL' | 'NEED_CONTEXT'

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
  /** Worker claim held during the judgment phase for respawn rebuild (A4 R9). */
  pendingClaim?: { outcome: ClaimOutcome; summary: string }
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

/** A worker's transient completion claim (never persisted). */
export interface NodeClaim {
  nodeToken: string
  outcome: ClaimOutcome
  summary: string
  handoffContext?: string
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
