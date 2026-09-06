/**
 * Host interaction surfaces the engine needs, declared as narrow interfaces so
 * the whole engine is testable without a live DSH host. The plugin's `apply()`
 * wires real DSH services into these.
 */
import type { WorkflowConfig, NodeClaim, RunState, CallFrame, ClaimOutcome, ClaimCaller, TransientDispatch, PendingCorrection } from '../types.ts'
import { WorkflowError, LIMITS, normalizeModelRoute } from '../types.ts'
import { newNodeToken, topFrame } from '../state/invariants.ts'
import { createRunLog, appendLine, jsonField, redact, shortId, traceEvent } from './tracelog.ts'
import { SUBMISSION_CONSTRAINT } from './texts.ts'

/** A2 R4: marker prefix compactBeforeDispatch throws with (for clean BLOCK routing). */
const COMPACT_FAIL_PREFIX = 'node-boundary compact failed: '

/** A4 R2: fixed template for a judge technical fault (steered to the Manager). */
function judgeFaultNotice(run: RunState, nodeId: string, detail: string): string {
  const resumeAction = run.judgeSessionId !== undefined
    ? '你的补充/指示交给当前 Judge 继续（followup）'
    : '没有可 followup 的 Judge；从 pendingClaim 重建新 Judge'
  const respawnAction = run.judgeSessionId !== undefined
    ? '放弃当前 Judge，重建新 Judge 重来一次判定'
    : '显式重建新 Judge，重来一次判定'
  return `⚠️ Judge 判定故障（workflow ${run.runId} / node ${nodeId}）\n诊断：${detail}\n\n当前 Node 已 BLOCK，未推进 PASS/FAIL。\n可选动作：\n  1. node_resume({nodeToken, resolutionContext}) —— ${resumeAction}；\n  2. judge_respawn({nodeToken}) —— ${respawnAction}；\n  3. workflow_set_role_model({roleKey:'judge', ...}) 换模型后再 resume/respawn；\n  4. node_block 保留现场等待人工。`
}

/** A1 R10: fixed template for a NEED_CONTEXT judgment (steered to the Manager). */
function needContextNotice(run: RunState, nodeId: string, reason: string): string {
  return `⚠️ Judge 需要补充信息（workflow ${run.runId} / node ${nodeId}）\n原因：${reason}\n\n当前 Node 已 BLOCK，未推进 PASS/FAIL。\n可选动作：\n  1. node_resume({nodeToken, resolutionContext}) —— 你的补充交给当前 Judge 继续；\n  2. node_block 保留现场等待人工。`
}

/** A3 R3: fixed template for an actor-turn-without-result BLOCK (steered to the Manager). */
function actorNoResultNotice(run: RunState, nodeId: string): string {
  return `⚠️ Actor 未提交结果（workflow ${run.runId} / node ${nodeId}）\n当前 Actor 结束回合但未调用 node_claim。\n当前 Node 已 BLOCK，未推进。\n可选动作：\n  1. node_resume({nodeToken, resolutionContext}) —— 将你的指示交给当前 Actor 继续并提交；\n  2. node_block 保留现场等待人工。`
}

/** A2 R4: fixed template for a node-boundary compact failure (steered to the Manager). */
function compactFaultNotice(run: RunState, nodeId: string, detail: string): string {
  return `⚠️ Node 边界 compact 失败（workflow ${run.runId} / node ${nodeId}）\n诊断：${detail}\n\n当前 Node 已 BLOCK，未派发。\n可选动作：\n  1. node_resume({nodeToken, resolutionContext}) —— 重试派发（compact 会再次尝试）；\n  2. workflow_set_role_model 换 summarization 模型后 resume；\n  3. node_block 保留现场等待人工。`
}

/**
 * A1 R7/§6.3: the correction message's evidence sections — `[judge rejection]`
 * + `[previous claim]`. The dispatch wrapper prepends `[correction]` and
 * appends `[instruction]`; a resume rebuild additionally appends
 * `[manager resolution]`. Lengths are bounded by the entry LIMITS chain.
 */
export function correctionEvidence(pc: { judgeReason: string; previousClaim: { outcome: ClaimOutcome; summary: string; handoffContext?: string } }): string {
  const claim = `[previous claim]\noutcome: ${pc.previousClaim.outcome}\nsummary: ${pc.previousClaim.summary}`
    + (pc.previousClaim.handoffContext !== undefined ? `\nhandoffContext: ${pc.previousClaim.handoffContext}` : '')
  return `[judge rejection]\n${pc.judgeReason}\n\n${claim}`
}

/** Deliverable messages to Manager / Role Actors. */
export interface DispatchTargets {
  /**
   * Steer the Manager session. Returns the user message id assigned by
   * `createUserMessage` (synchronously allocated before the steer) — the
   * Manager-dispatch lease identity (A1 R2/R3).
   */
  steerManager(run: RunState, text: string): Promise<{ messageId: string }>
  /** Deliver to an EXISTING mapped role actor (followup); returns the message id (A1 R2). */
  sendRoleActor(run: RunState, roleKey: string, text: string): Promise<{ messageId: string }>
  /** The Manager session's current next-seq, captured at dispatch (A1 R2). */
  managerSessionSeq(run: RunState): number
}

/** Judge spawn input the host needs to build the Judgment Packet. */
export interface JudgeSpawnInput {
  nodeToken: string
  instruction: string
  criteria: string
  /** A1 R7: the Judge sees only the worker's claim outcome/summary. */
  claim: { outcome: ClaimOutcome; summary: string }
  /** A1 §7.1: REJECT evidence from a previous correction round on this node, when present. */
  previousRejection?: PendingCorrection
  cwd: string
  /**
   * Engine-reserved Judge session id. The Host must use it as the continuable
   * child's caller-reserved `childId`, because the child may start its first
   * turn before this adapter returns and State has already been updated.
   */
  judgeSessionId: string
}

/** Subagent lifecycle used by roles/judge. */
export interface SubagentHost {
  /**
   * Create a continuable role actor for roleKey and deliver `initialText` as
   * its first prompt. Returns the durable child id + the dispatch message id.
   */
  ensureRoleActor(run: RunState, roleKey: string, initialText: string): Promise<{ childId: string; messageId: string }>
  /** Start a fresh continuable Judge and deliver its Judgment Packet (A1 R8). The reserved input.judgeSessionId must become the child id. */
  startJudge(run: RunState, input: JudgeSpawnInput): Promise<{ judgeSessionId: string; messageId: string }>
  /** Followup an existing Judge session with supplemental context (A1 R10). */
  followupJudge(run: RunState, judgeSessionId: string, text: string): Promise<void>
  /** Whether the durable Judge Session exists and can be cold-resumed after a host restart. */
  judgeSessionExists(judgeSessionId: string): Promise<boolean>
  /**
   * Retire a Judge after its PASS/FAIL verdict (A1 R11): revoke its
   * authorization only. The resident Activation is released by DSH's own
   * settlement watcher once the Judge's turn ends — an explicit drain from
   * inside the Judge's own `judge_claim` tool call would cancel the very turn
   * executing the call and deadlock on its quiescence.
   */
  retireJudge(run: RunState, judgeSessionId: string): Promise<void>
  /**
   * Drain a Judge's resident Activation (revoke + explicit drain). Only safe
   * from a turn OTHER than the Judge's own (judge_respawn); an absent target
   * is an accepted no-op.
   */
  drainJudge(run: RunState, judgeSessionId: string): Promise<void>
  /**
   * Node-boundary compact of a role actor (A2; A4 plan A). A cold actor is
   * materialized without a prompt, compacted while idle, and released before
   * the dispatch followup cold-resumes the compacted surface. Failure returns
   * ok:false so the caller BLOCKs with a clean reason (A2 R4).
   * `compactThresholdTokens` (Issue #5) is the workflow-wide gate frozen in
   * the Definition Snapshot: defined → the host measures the materialized
   * surface via the DSH token meter first and only compacts when totalTokens
   * is strictly greater (equality skips; meter failures fail closed);
   * undefined → the legacy unconditional compact attempt with no metering.
   */
  compactRoleActor(run: RunState, roleKey: string, compactThresholdTokens?: number): Promise<{ ok: boolean; detail?: string }>
}

/** Program executor used by builtin-program nodes. */
export interface ProgramHost {
  run(run: RunState, programId: string, parameters: Record<string, unknown>, cwd: string): Promise<{ kind: 'PASS' | 'FAIL' | 'ERROR'; reason?: string; details?: unknown }>
}

/** Persistence boundary (state store wrapper). */
export interface StateHost {
  get(workspaceKey: string): Promise<{ run: RunState; version: number } | undefined>
  put(workspaceKey: string, run: RunState, expectedVersion: number): Promise<void>
  /** Insert/overwrite the row; resolves with the row's new state version. */
  create(workspaceKey: string, run: RunState): Promise<number>
  remove(workspaceKey: string): Promise<void>
  listRuns(): Promise<Array<{ workspaceKey: string; run: RunState; version: number }>>
}

export type EngineOutcome =
  | { ok: true; run: RunState; message: string }
  | { ok: false; reason: string }

export interface NodeView {
  execution: {
    type: 'actor-task' | 'builtin-program' | 'child-workflow'
    role?: string
    instruction?: string
    programId?: string
    workflowId?: string
    config?: Record<string, unknown>
  }
  checker?: { checkerId: string; config: Record<string, unknown> }
  onPass: string
  onFail?: string
}

/**
 * Per-workspace dispatch bookkeeping (in-memory, design §4.2):
 * - dispatchedToken: token the last dispatched turn was running under.
 * - executorSessionId: the exact session that was dispatched for the current
 *   node (manager session id or role-actor child id). Only that session's
 *   turn settlement drives auto-BLOCK / deferred dispatch (design §4.2).
 * - pendingDispatch: the node advanced via an accepted claim/verdict, and the
 *   NEXT node dispatch is deferred until the old turn settles (design §4.2:
 *   "dispatch next Node only after old Turn settles").
 * - transientContext: one-shot context to prepend to the next dispatch
 *   message (handoff on PASS / resolution on resume / correction evidence on
 *   REJECT). Never persisted; consumed by exactly one dispatch (design
 *   §2.6/§5.2 G4).
 * - workerSettled: the dispatched executor's turn already ended while a
 *   judgment was pending (the async-Judge era: the worker's `node_claim` ends
 *   its turn long before the verdict). When true, a later PASS/FAIL verdict
 *   dispatches the next node immediately instead of deferring to a turn/end
 *   that already fired (A1 R9–R11).
 * - dispatchMessageId + leaseConsumed: the ActorDispatchLease (A1 R2). The
 *   user message id of THIS node's actual dispatch, consumable exactly once
 *   by a node_claim/node_block whose calling turn contains that id.
 */
interface DispatchBook {
  dispatchedToken: string
  executorSessionId: string
  pendingDispatch: boolean
  transientContext: TransientDispatch | null
  workerSettled: boolean
  /** A1 R2: the dispatch's user message id — the lease principal. `undefined` for lease-less nodes (builtin-program). */
  dispatchMessageId?: string
  /** Whether the lease has been consumed by one admitted claim/block. */
  leaseConsumed: boolean
}

/**
 * A1 §3.1: the identity of one real dispatch, returned by `dispatchCurrent`
 * so `dispatchNow` can publish the lease at its single convergence point.
 * `undefined` means the node publishes no lease (builtin-program).
 */
interface DispatchIdentity {
  executorSessionId: string
  /** The steer/followup/startContinuable user message id. */
  dispatchMessageId: string
}

/** The current node's precise executor session (design §4 seriality). */
export function executorSessionOf(run: RunState): string {
  const frame = topFrame(run)
  const def = frame.workflowId === run.catalogWorkflowId
    ? run.definitionSnapshot.workflow
    : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
  const node = def?.nodes[frame.nodeId]
  if (node !== undefined && node.execution.type === 'actor-task' && node.execution.role === 'manager') {
    return run.managerSessionId
  }
  if (node !== undefined && node.execution.type === 'actor-task' && node.execution.role !== undefined) {
    return run.roleActors[node.execution.role] ?? ''
  }
  // builtin-program / child-workflow are Manager-driven (program parameters /
  // child admission come from the Manager).
  return run.managerSessionId
}

export class WorkflowEngine {
  /** Bound cwd resolver (wired by the plugin; throws until then). */
  cwdResolver: (run: RunState) => Promise<string> = async () => { throw new WorkflowError('cwd resolver is not wired') }

  /** Optional actor-activity oracle (wired by the plugin when available). */
  actorActivity: (actorSessionId: string) => Promise<'active' | 'idle' | 'unknown'> = async () => 'unknown'

  /** Optional model-route resolver for the Manager at Run start (F22). */
  managerRoute: (managerSessionId: string) => Promise<{ provider?: string; model?: string }> = async () => ({})

  private readonly dispatchBook = new Map<string, DispatchBook>()
  private readonly inFlight = new Map<string, string>() // workspaceKey → operation kind
  /**
   * A3 §10: ONE warning per run on the first trace-log failure, so
   * best-effort still has a diagnosis without a warning loop. Wired to the
   * Host logger by the plugin; absent in tests.
   */
  traceWarn: ((message: string) => void) | undefined
  private readonly traceWarnedRuns = new Set<string>()
  private readonly targets: DispatchTargets
  private readonly subagents: SubagentHost
  private readonly programs: ProgramHost
  private readonly state: StateHost

  constructor(targets: DispatchTargets, subagents: SubagentHost, programs: ProgramHost, state: StateHost) {
    this.targets = targets
    this.subagents = subagents
    this.programs = programs
    this.state = state
  }

  buildInitialRun(managerSessionId: string, workflowId: string, config: WorkflowConfig, definitionHash: string): RunState {
    return {
      runId: crypto.randomUUID(),
      managerSessionId,
      catalogWorkflowId: workflowId,
      definitionHash,
      definitionSnapshot: config,
      status: 'running',
      callStack: [{ workflowId, nodeId: config.workflow.startNode, nodeToken: newNodeToken() }],
      roleActors: {},
      modelOverrides: {},
      blockReason: null,
      nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
    }
  }

  /** F22: the Manager's route frozen at Run start (empty = inherit per-spawn). */
  frozenRoute: { provider?: string; model?: string } = {}

  /** Start a run: persist the initial row, then dispatch the root start node immediately. */
  async startRun(workspaceKey: string, run: RunState, configPath?: string): Promise<EngineOutcome> {
    // A3 review round 2: the workspace-uniqueness check is atomic with the
    // row creation (state.create). Pre-check it so the COMMON conflict (user
    // error, not a crash) rejects cleanly BEFORE any trace artifact exists —
    // only a genuine race between this check and create can leave an orphan
    // START line + file (declared at-least-once semantics).
    const existing = await this.state.get(workspaceKey)
    if (existing !== undefined && existing.run.status !== 'completed') {
      return { ok: false, reason: `workspace already has a ${existing.run.status} run (key: ${workspaceKey})` }
    }
    // A3: create the trace log BEFORE the state row and persist its path on
    // the row, so every later event (including after a host restart) appends
    // to the same file. Best-effort — tracelog never throws, so logging can
    // never block run startup (R4); a create failure leaves traceLogPath
    // unset and the run simply runs unlogged.
    if (configPath !== undefined) {
      const logPath = createRunLog(configPath, run.catalogWorkflowId, run.runId)
      if (logPath !== undefined) {
        run.traceLogPath = logPath
      } else {
        this.warnTraceOnce(run.runId, `workflow trace log creation failed for run ${shortId(run.runId)}; the run continues without a trace log`)
      }
    }
    // R1/R2: the START line announces the event-line format version (A3 §3).
    // Written BEFORE the row creation per the §10 order (validate → trace →
    // persist): a crash between leaves an orphan START in an orphan file
    // (at-least-once); the reverse gap (row without START) does not exist.
    this.logLine(run, traceEvent('START', { workflow: run.catalogWorkflowId, run: run.runId, fmt: 2 }))
    let version: number
    try {
      version = await this.state.create(workspaceKey, run)
    } catch (error) {
      // A3 review S4: a failed start leaves no run to clean the marker later.
      this.traceWarnedRuns.delete(run.runId)
      if (error instanceof Error && error.name === 'StateConflictError') {
        return { ok: false, reason: error.message }
      }
      throw error
    }
    // F22: freeze the Manager's current route as the inherited fallback at Run
    // start, so later Manager UI model switches do not change first-time
    // Worker/Judge spawns.
    this.frozenRoute = await this.managerRoute(run.managerSessionId)
    await this.dispatchNow(workspaceKey, run, version)
    return { ok: true, run, message: run.blockReason ?? `dispatched ${topFrame(run).nodeId}` }
  }

  /**
   * Append one line to this run's trace log (best-effort, R4). No-op when the
   * run has no trace-log path (no configPath at start, log creation failed,
   * or a pre-A3 durable row). The path travels ON the durable row, so events
   * after a host restart reach the same file (A3 R5 restart coverage).
   */
  private logLine(run: RunState, line: string): void {
    const logPath = run.traceLogPath
    if (logPath === undefined) return
    if (!appendLine(logPath, line)) {
      this.warnTraceOnce(run.runId, `workflow trace log append failed for run ${shortId(run.runId)} (path: ${logPath}); further trace failures for this run stay silent`)
    }
  }

  /** A3 §10: surface the FIRST trace failure of a run once, never in a loop. */
  private warnTraceOnce(runId: string, message: string): void {
    if (this.traceWarnedRuns.has(runId)) return
    this.traceWarnedRuns.add(runId)
    try {
      this.traceWarn?.(message)
    } catch {
      // even the warning is best-effort
    }
  }

  // ---- A3 trace events (fmt=2). Free-text fields go through `jsonField`
  // at their protocol bounds (§4); ids use short prefixes (§5/§10). ----

  /** A3 R1: an accepted Actor claim, logged after admission, before Judge spawn. */
  private logClaim(run: RunState, frame: CallFrame, role: string, outcome: ClaimOutcome, summary: string, handoff: string | null): void {
    this.logLine(run, traceEvent('CLAIM', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      role,
      outcome,
      summary: jsonField(summary, LIMITS.summaryMax),
      handoff: jsonField(handoff, LIMITS.handoffMax),
    }))
  }

  /** A1 v2: the Judge's confirmation (ACCEPT/REJECT/NEED_CONTEXT), recorded before any state transition. */
  private logJudge(run: RunState, frame: CallFrame, result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT', reason: string, judgeSessionId: string): void {
    this.logLine(run, traceEvent('JUDGE', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      result,
      reason: jsonField(reason, LIMITS.reasonMax),
      judge: shortId(judgeSessionId),
    }))
  }

  /** A1 §7.2: the REJECT re-dispatch boundary — same node, rotated token,
   * retired judge. Marks where a correction cycle began (never a ROUTE: no
   * Edge was read). */
  private logCorrect(run: RunState, frame: CallFrame, role: string, oldJudgeId: string, detail: string): void {
    this.logLine(run, traceEvent('CORRECT', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      role,
      judge: shortId(oldJudgeId),
      detail: jsonField(detail, LIMITS.reasonMax),
    }))
  }

  /** A3 §3: the finally-adopted Graph edge direction (verdict synthesis, not the verdict itself). */
  private logRoute(run: RunState, frame: CallFrame, result: 'PASS' | 'FAIL', target: string): void {
    this.logLine(run, traceEvent('ROUTE', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      result,
      target,
    }))
  }

  /** A3 R5: every BLOCK entrance with its source and normalized reason. */
  private logBlock(run: RunState, frame: CallFrame, source: 'actor' | 'judge' | 'program' | 'dispatch' | 'compact' | 'restart' | 'manager', reason: string): void {
    this.logLine(run, traceEvent('BLOCK', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      source,
      reason: jsonField(reason, LIMITS.blockReasonMax),
    }))
  }

  /** A3 R6: node_resume — target=judge in the judgment phase, else target=actor. */
  private logResume(run: RunState, frame: CallFrame, oldToken: string, target: 'judge' | 'actor', resolutionContext: string): void {
    this.logLine(run, traceEvent('RESUME', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      oldToken: shortId(oldToken),
      newToken: shortId(frame.nodeToken),
      target,
      context: jsonField(resolutionContext, LIMITS.resolutionMax),
    }))
  }

  /** A3 R6: judge_respawn — the fresh Judge id prefix links back to its JUDGE line. */
  private logRespawn(run: RunState, frame: CallFrame, judgeSessionId: string, reason: string | null): void {
    this.logLine(run, traceEvent('RESPAWN', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      judge: shortId(judgeSessionId),
      reason: jsonField(reason, LIMITS.reasonMax),
    }))
  }

  /** A3 R6: node_resolve_program — the Manager's manual verdict on a blocked program node. */
  private logResolve(run: RunState, frame: CallFrame, result: 'PASS' | 'FAIL', reason: string): void {
    this.logLine(run, traceEvent('RESOLVE', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      result,
      reason: jsonField(reason, LIMITS.blockReasonMax),
    }))
  }

  /** A3 §9: builtin program outcome. Parameters are never logged (§9 privacy). */
  private logProgram(run: RunState, frame: CallFrame, programId: string, result: 'PASS' | 'FAIL' | 'ERROR', reason: string | null): void {
    this.logLine(run, traceEvent('PROGRAM', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      program: programId,
      result,
      reason: jsonField(reason, LIMITS.reasonMax),
    }))
  }

  /** A3 R6: model override — ids only, never credentials. provider/modelId
   * are untrusted Manager tool input: redact credential shapes pointwise
   * (other raw identifiers are catalog-validated and intentionally exempt,
   * A3 review round 3 S1). */
  private logModel(run: RunState, roleKey: string, provider: string, modelId: string): void {
    this.logLine(run, traceEvent('MODEL', {
      workflow: run.catalogWorkflowId,
      role: roleKey,
      provider: redact(provider),
      model: redact(modelId),
    }))
  }

  /** A3 §8: child-workflow entry (push). Token pairs with the POP of the same node. */
  private logPush(run: RunState, frame: CallFrame, childWorkflowId: string): void {
    this.logLine(run, traceEvent('PUSH', {
      parent: `${frame.workflowId}/${frame.nodeId}`,
      token: shortId(frame.nodeToken),
      child: childWorkflowId,
    }))
  }

  /** A3 §8: child-workflow return (pop) — explicit, not inferred from the parent PASS. */
  private logPop(run: RunState, childWorkflowId: string, result: 'PASS' | 'FAIL', parentFrame: CallFrame): void {
    this.logLine(run, traceEvent('POP', {
      child: childWorkflowId,
      result,
      parent: `${parentFrame.workflowId}/${parentFrame.nodeId}`,
      token: shortId(parentFrame.nodeToken),
    }))
  }

  /** A2 R7: node-boundary compact outcome. */
  private logCompact(run: RunState, frame: CallFrame, roleKey: string, ok: boolean, detail: string | null): void {
    this.logLine(run, traceEvent('COMPACT', {
      workflow: frame.workflowId,
      node: frame.nodeId,
      token: shortId(frame.nodeToken),
      role: roleKey,
      ok,
      detail: jsonField(detail, LIMITS.blockReasonMax),
    }))
  }

  nodeAt(run: RunState, frame: CallFrame): NodeView | undefined {
    const def = frame.workflowId === run.catalogWorkflowId
      ? run.definitionSnapshot.workflow
      : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
    if (def === undefined) return undefined
    return def.nodes[frame.nodeId] as NodeView | undefined
  }

  currentNodeKind(run: RunState): NodeView['execution']['type'] {
    const node = this.nodeAt(run, topFrame(run))
    if (node === undefined) throw new WorkflowError('current node is missing from the snapshot')
    return node.execution.type
  }

  /**
   * Deliver the current node's prompt to its executor (design §4.1).
   * A one-shot transientContext (handoff / resolution / correction) is
   * prepended to the message and consumed. Establishes the NodeContextBoundary
   * at actual dispatch (A1 R1), performs node-boundary compaction (A2), and
   * injects the submission hard constraint for actor-tasks (A3 R1). Mutates
   * the run in memory only (role mapping + child frames + boundary). Throws
   * on dispatch failure so callers can BLOCK.
   *
   * Returns the dispatch identity (A1 §3.1) — the executor session plus the
   * dispatch message id — for lease publication; `undefined` for lease-less
   * nodes (builtin-program: they accept no claims).
   */
  async dispatchCurrent(run: RunState, transientContext: TransientDispatch | null): Promise<DispatchIdentity | undefined> {
    const frame = topFrame(run)
    const node = this.nodeAt(run, frame)
    if (node === undefined) throw new WorkflowError('current node is missing from the snapshot')
    const execution = node.execution
    const text = transientContext !== null && transientContext.text !== ''
      ? `[${transientContext.kind}]\n${transientContext.text}\n\n[instruction]\n${execution.instruction ?? ''}`
      : (execution.instruction ?? '')

    if (execution.type === 'actor-task') {
      // A3 R1: append the submission hard constraint (never replace the original).
      const dispatchText = text + SUBMISSION_CONSTRAINT
      if (execution.role === 'manager') {
        // A2 R2: the Manager (user main session) is never compacted.
        const freshBoundary = run.nodeBoundary.dispatchedAt === 0
        this.establishManagerBoundary(run)
        const { messageId } = await this.targets.steerManager(run, dispatchText)
        // A1 R2: record the Manager dispatch's message id on the boundary too
        // (the field existed but was previously only written on role paths).
        if (freshBoundary) run.nodeBoundary.executorDispatchMessageId = messageId
        return { executorSessionId: run.managerSessionId, dispatchMessageId: messageId }
      }
      const roleKey = execution.role!
      // A1 §6.5: a correction re-dispatch targets the ORIGINAL actor — the
      // retained boundary names this node's executor truth, so repair a
      // drifted/missing mapping before the followup decision. A mapping loss
      // must never silently redirect a correction to a replacement actor.
      if (transientContext?.kind === 'correction'
        && run.nodeBoundary.dispatchedAt !== 0
        && run.nodeBoundary.executorSessionId !== undefined) {
        run.roleActors[roleKey] = run.nodeBoundary.executorSessionId
      }
      const existing = run.roleActors[roleKey]
      // A2 R6 / A1 R4: compact only on fresh node entry — a retained
      // boundary for the SAME executor means this is a same-node resume.
      const isSameNodeResume = run.nodeBoundary.dispatchedAt !== 0
        && run.nodeBoundary.executorSessionId === existing
      if (existing !== undefined) {
        if (!isSameNodeResume) {
          // Issue #5: the threshold travels from the frozen Definition
          // Snapshot on every fresh dispatch (AC10 — disk edits after Run
          // start never reach the running snapshot).
          await this.compactBeforeDispatch(run, roleKey, run.definitionSnapshot.compactThresholdTokens)
        }
        // A1 R2: capture the boundary cursors BEFORE the followup await — a
        // manager message landing during the send belongs to this node's
        // projection window, exactly like the first-creation path.
        const dispatchedAt = Date.now()
        const managerFromSeq = this.targets.managerSessionSeq(run)
        const { messageId } = await this.targets.sendRoleActor(run, roleKey, dispatchText)
        if (!isSameNodeResume) {
          run.nodeBoundary = {
            dispatchedAt,
            managerFromSeq,
            executorSessionId: existing,
            executorDispatchMessageId: messageId,
          }
        }
        // Same-node resume: RETAIN the original boundary (A1 R4/AC5) so the
        // Judge projection keeps this node's pre-resume local history; the
        // resume dispatch itself still projects (it follows the boundary seq).
        return { executorSessionId: existing, dispatchMessageId: messageId }
      }
      // A2 R3: first creation has no history — create directly, no compact.
      const dispatchedAt = Date.now()
      const managerFromSeq = this.targets.managerSessionSeq(run)
      const { childId, messageId } = await this.subagents.ensureRoleActor(run, roleKey, dispatchText)
      run.roleActors[roleKey] = childId
      run.nodeBoundary = { dispatchedAt, managerFromSeq, executorSessionId: childId, executorDispatchMessageId: messageId }
      return { executorSessionId: childId, dispatchMessageId: messageId }
    }
    if (execution.type === 'builtin-program') {
      // A3 R1: builtin-program dispatch is NOT injected with the constraint,
      // and publishes NO lease (program nodes accept no claims — A1 §5.2).
      this.establishManagerBoundary(run)
      const programText = text !== ''
        ? text
        : 'Run the current builtin program via node_run_program.'
      await this.targets.steerManager(run, programText)
      return undefined
    }
    const childId = execution.workflowId!
    const childDef = run.definitionSnapshot.childWorkflows?.[childId]
    if (childDef === undefined) throw new WorkflowError(`child workflow "${childId}" is missing from the snapshot`)
    run.callStack.push({ workflowId: childId, nodeId: childDef.startNode, nodeToken: newNodeToken() })
    // A3 §8: child-workflow entry (push); the return is logged by advance()'s POP.
    this.logPush(run, frame, childId)
    // The handoff reaches the Child's start node (design §2.6). The lease
    // belongs to the innermost real actor-task dispatch — propagate it.
    return await this.dispatchCurrent(run, transientContext)
  }

  /** Establish the boundary for a Manager-driven node (no executor session). */
  private establishManagerBoundary(run: RunState): void {
    // A1 R4: on resume the boundary is retained; on fresh node entry it is
    // (re)established from the current manager session cursor.
    if (run.nodeBoundary.dispatchedAt !== 0) return
    run.nodeBoundary = { dispatchedAt: Date.now(), managerFromSeq: this.targets.managerSessionSeq(run) }
  }

  /** A2: node-boundary compact of a resident role actor (best-effort trace log). */
  private async compactBeforeDispatch(run: RunState, roleKey: string, compactThresholdTokens?: number): Promise<void> {
    // Fresh-node-entry decision is the caller's (dispatchCurrent): same-node
    // resume and first creation never reach here (A2 R3/R6). The threshold is
    // the optional frozen `compactThresholdTokens` (Issue #5) — undefined
    // keeps the unconditional compact attempt.
    const frame = topFrame(run)
    const result = await this.subagents.compactRoleActor(run, roleKey, compactThresholdTokens)
    if (!result.ok) {
      const detail = result.detail ?? 'unknown compaction failure'
      this.logCompact(run, frame, roleKey, false, detail)
      throw new WorkflowError(`${COMPACT_FAIL_PREFIX}${detail}`)
    }
    this.logCompact(run, frame, roleKey, true, result.detail ?? null)
  }

  /**
   * Mutate the run along a PASS/FAIL edge (no persistence). Emits ROUTE (the
   * finally-adopted edge direction, A3 §3), POP on a child-workflow return
   * (§8), and BLOCK when a FAIL finds no onFail edge (R5) — `blockSource`
   * names the component whose verdict ran out of edges.
   */
  private advance(run: RunState, verdict: 'PASS' | 'FAIL', reason: string, blockSource: 'judge' | 'program' | 'manager'): void {
    const frame = topFrame(run)
    const node = this.nodeAt(run, frame)
    if (node === undefined) throw new WorkflowError('current node is missing from the snapshot')
    // The verdict always ends the judgment phase — and any correction cycle:
    // an accepted conclusion supersedes the previous rejection evidence.
    delete run.judgeSessionId
    delete run.pendingClaim
    delete run.pendingCorrection
    if (verdict === 'PASS') {
      const target = node.onPass
      if (target === 'END') {
        this.logRoute(run, frame, 'PASS', 'END')
        if (run.callStack.length === 1) {
          run.status = 'completed'
          run.callStack = []
          run.blockReason = null
          // A1 R4: the node has left; the boundary is invalid.
          run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
          return
        }
        const childWorkflowId = frame.workflowId
        run.callStack.pop()
        // A3 §8: the child's return is explicit, not inferred from the
        // parent's next PASS line.
        this.logPop(run, childWorkflowId, 'PASS', topFrame(run))
        this.advance(run, 'PASS', '', blockSource)
        return
      }
      this.logRoute(run, frame, 'PASS', target)
      frame.nodeId = target
      frame.nodeToken = newNodeToken()
      // A1 R4: the node has left; the next dispatch establishes a fresh boundary.
      run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
      return
    }
    const target = node.onFail
    if (target === undefined || target === 'END') {
      const blockReason = `checker FAIL${reason.trim() !== '' ? `: ${reason.trim()}` : ''} and no onFail edge`
      this.logRoute(run, frame, 'FAIL', 'BLOCK')
      this.logBlock(run, frame, blockSource, blockReason)
      run.status = 'blocked'
      run.blockReason = blockReason
      // A1 R4: FAIL with no onFail keeps the node — the boundary is RETAINED so
      // a resume preserves this node's local history (and A2 R6 skips compact).
      return
    }
    this.logRoute(run, frame, 'FAIL', target)
    frame.nodeId = target
    frame.nodeToken = newNodeToken()
    // A1 R4: the node has left via the onFail edge.
    run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
  }

  /** Dispatch the current node NOW (start/resume), then persist. */
  private async dispatchNow(workspaceKey: string, run: RunState, expectedVersion: number, transientContext: TransientDispatch | null = null): Promise<void> {
    let identity: DispatchIdentity | undefined
    if (run.status === 'running') {
      try {
        identity = await this.dispatchCurrent(run, transientContext)
      } catch (error) {
        run.status = 'blocked'
        // A2 R4/AC5: a node-boundary compact failure gets its own clean
        // reason (no double wrapping) and an active Manager notification,
        // reusing the A4 BLOCK-steer framework.
        if (error instanceof WorkflowError && error.message.startsWith(COMPACT_FAIL_PREFIX)) {
          run.blockReason = error.message.slice(0, LIMITS.blockReasonMax)
          // A3 R5: compact-failure BLOCK (before persistence, per §10 order).
          this.logBlock(run, topFrame(run), 'compact', run.blockReason)
          await this.state.put(workspaceKey, run, expectedVersion)
          this.dispatchBook.delete(workspaceKey)
          await this.targets.steerManager(run, compactFaultNotice(run, topFrame(run).nodeId, error.message.slice(COMPACT_FAIL_PREFIX.length))).catch(() => {})
          return
        }
        run.blockReason = `dispatch-failed: ${String(error)}`.slice(0, LIMITS.blockReasonMax)
        // A3 R5: dispatch-failure BLOCK.
        this.logBlock(run, topFrame(run), 'dispatch', run.blockReason)
      }
    }
    await this.state.put(workspaceKey, run, expectedVersion)
    if (run.status === 'running') {
      // A1 §3.1: publish the dispatch lease at the single convergence point —
      // every real dispatch funnels through dispatchNow. A failed send throws
      // out of dispatchCurrent above, so no claimable lease can exist for a
      // dispatch that did not happen. A lease-less node (builtin-program)
      // initializes EXPLICITLY: "no lease" is a first-class state, never a
      // missing field read as "not yet published".
      this.dispatchBook.set(workspaceKey, {
        dispatchedToken: topFrame(run).nodeToken,
        executorSessionId: identity?.executorSessionId ?? executorSessionOf(run),
        pendingDispatch: false,
        transientContext: null,
        workerSettled: false,
        dispatchMessageId: identity?.dispatchMessageId,
        leaseConsumed: identity === undefined,
      })
    } else {
      this.dispatchBook.delete(workspaceKey)
      await this.notifyCompletion(run)
    }
  }

  /** Persist an advanced run WITHOUT dispatching (deferred until turn settlement). */
  private async persistDeferred(workspaceKey: string, run: RunState, version: number, transientContext: TransientDispatch | null = null): Promise<void> {
    await this.state.put(workspaceKey, run, version)
    if (run.status === 'running') {
      const previous = this.dispatchBook.get(workspaceKey)
      this.dispatchBook.set(workspaceKey, {
        dispatchedToken: previous?.dispatchedToken ?? topFrame(run).nodeToken,
        executorSessionId: previous?.executorSessionId ?? '',
        pendingDispatch: true,
        transientContext,
        workerSettled: false,
        // A1 §3: the deferred book carries NO lease — the node advanced and
        // its token rotated, so the old dispatch's claimability is dead by
        // construction (the admission predicate is the defensive backstop).
        dispatchMessageId: undefined,
        leaseConsumed: true,
      })
    } else {
      this.dispatchBook.delete(workspaceKey)
      await this.notifyCompletion(run)
    }
  }

  /** When a run reaches Root END, notify the Manager (the user's main session). */
  private async notifyCompletion(run: RunState): Promise<void> {
    if (run.status !== 'completed') return
    // A3 review S3: release the one-warning marker — a completed run's log is final.
    this.traceWarnedRuns.delete(run.runId)
    try {
      await this.targets.steerManager(run, `workflow "${run.catalogWorkflowId}" 已完成（run ${run.runId}）。`)
    } catch {
      // Completion notification is best-effort: the completed state is durable.
    }
  }

  /**
   * A1 R2/§3: the dispatch-lease admission predicate. The DispatchBook is
   * the single source of truth — a claim is admissible only when the current
   * node has a REAL (not deferred, not consumed) dispatch whose executor is
   * the caller and whose dispatch message id belongs to the caller's CURRENT
   * turn. Fail-closed on every mismatch.
   */
  private admitLease(workspaceKey: string, run: RunState, caller: ClaimCaller): { ok: true; book: DispatchBook } | { ok: false } {
    const book = this.dispatchBook.get(workspaceKey)
    if (book === undefined) return { ok: false }
    if (book.pendingDispatch) return { ok: false }
    if (book.leaseConsumed) return { ok: false }
    if (book.dispatchMessageId === undefined) return { ok: false }
    if (book.dispatchedToken !== topFrame(run).nodeToken) return { ok: false }
    if (book.executorSessionId !== caller.sessionId) return { ok: false }
    if (!caller.turnUserMessageIds.has(book.dispatchMessageId)) return { ok: false }
    return { ok: true, book }
  }

  /**
   * Handle a worker node_claim (design §5.2 G2): enter the judgment phase by
   * spawning a fresh continuable Judge with the Node-local Judgment Packet (A1
   * R7/R8) and persist the `pendingClaim` for respawn rebuild (A4 R9). The
   * verdict arrives later via `judge_claim` (handleJudgeClaim) or, on a
   * technical fault, via handleJudgeTurnEnded.
   */
  async handleClaim(workspaceKey: string, claim: NodeClaim, caller: ClaimCaller): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}; claims are rejected` }
    const frame = topFrame(run)
    if (this.currentNodeKind(run) !== 'actor-task') {
      return { ok: false, reason: `current node is ${this.currentNodeKind(run)}; only actor-task accepts claims` }
    }
    const node = this.nodeAt(run, frame)!
    const checker = node.checker
    if (checker === undefined) return { ok: false, reason: 'actor-task node has no checker' }
    if (checker.checkerId !== 'judge.claim-correct') {
      return { ok: false, reason: `unknown checker ${checker.checkerId}` }
    }
    // A1 R2/§5.1: dispatch-lease admission. This also subsumes the old
    // precise-executor check (book.executorSessionId IS the dispatch target)
    // and rejects the PRD's core failure mode: State advanced but the next
    // Node never dispatched → book is pendingDispatch / id-less → reject
    // WITHOUT touching State or spawning a Judge (AC1). The claim carries NO
    // nodeToken (AC2) — the book's dispatchedToken is the token truth.
    const lease = this.admitLease(workspaceKey, run, caller)
    if (!lease.ok) {
      return { ok: false, reason: '当前调用无法绑定到一个已 dispatch 的 Node' }
    }
    const book = lease.book
    // A1 R9 / single-flight: a node already in judgment phase rejects new claims.
    if (run.pendingClaim !== undefined) {
      return { ok: false, reason: 'a judgment is already pending for this node' }
    }
    // F14: single-flight per node token — one in-flight Judge per claim.
    const flightKey = `${workspaceKey}:${book.dispatchedToken}`
    if (this.inFlight.has(flightKey)) {
      return { ok: false, reason: 'a judge evaluation is already in flight for this node' }
    }
    this.inFlight.set(flightKey, 'judge')
    try {
      // A1 review fix: the tool layer validates trim-based lengths, so the
      // payloads persisted/traced here are trimmed defensively too — a
      // whitespace-padded summary can never bloat State or the correction
      // message regardless of how the caller reached the engine.
      const summary = claim.summary.trim()
      const handoff = claim.handoffContext?.trim()
      // Prepare every fallible packet input BEFORE publishing the reserved id.
      const criteria = typeof checker.config['criteria'] === 'string' ? checker.config['criteria'] : ''
      const cwd = await this.cwdResolver(run)

      // A4 R9: persist pendingClaim AND the reserved Judge id BEFORE the
      // child admission. A freshly materialized child can run immediately, so
      // State must name the Judge before its first judge_claim is possible.
      const entered = await this.state.get(workspaceKey)
      if (entered === undefined) return { ok: false, reason: 'state row vanished during claim' }
      if (entered.run.status !== 'running' || topFrame(entered.run).nodeToken !== book.dispatchedToken) {
        return { ok: false, reason: 'stale claim discarded: the node moved or blocked meanwhile' }
      }
      const reservedJudgeSessionId = newNodeToken()
      entered.run.pendingClaim = { outcome: claim.outcome, summary }
      if (claim.outcome === 'completed' && handoff !== undefined && handoff !== '') {
        entered.run.pendingClaim.handoffContext = handoff
      }
      entered.run.judgeSessionId = reservedJudgeSessionId
      // A3 R1 + §10 crash-seam order: validate → trace → persist. The CLAIM
      // line is written BEFORE the durable acceptance (at-least-once: a
      // crash between leaves an orphan CLAIM whose token prefix is
      // distinguishable; State remains authoritative). Logging here also
      // guarantees the line survives a Judge spawn fault (§5 R1 reason).
      this.logClaim(
        entered.run,
        topFrame(entered.run),
        node.execution.role ?? 'manager',
        claim.outcome,
        summary,
        entered.run.pendingClaim.handoffContext ?? null,
      )
      await this.state.put(workspaceKey, entered.run, entered.version)
      // A1 §3.2 acceptance boundary: consume the lease only AFTER the durable
      // put succeeded — a put failure leaves State un-accepted and the lease
      // unconsumed, so the same Actor can retry verbatim. Workspace
      // mutations are enqueue-serialized, so no early consumption is needed
      // against concurrency. A second claim on the same lease is rejected
      // from here on (AC4).
      book.leaseConsumed = true

      // A4 R1: spawn failure becomes a judge technical fault → BLOCK with detail.
      try {
        await this.subagents.startJudge(entered.run, {
          nodeToken: frame.nodeToken,
          instruction: node.execution.instruction ?? '',
          criteria,
          claim: { outcome: claim.outcome, summary },
          // A1 §7.1: a re-claim after a REJECT carries the prior evidence.
          previousRejection: entered.run.pendingCorrection,
          cwd,
          judgeSessionId: reservedJudgeSessionId,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const fresh = await this.state.get(workspaceKey)
        if (fresh === undefined) return { ok: false, reason: 'state row vanished during judge spawn' }
        if (fresh.run.runId !== entered.run.runId
          || fresh.run.judgeSessionId !== reservedJudgeSessionId
          || fresh.run.status !== 'running'
          || topFrame(fresh.run).nodeToken !== book.dispatchedToken) {
          await this.subagents.drainJudge(entered.run, reservedJudgeSessionId).catch(() => {})
          return { ok: false, reason: 'stale judge spawn discarded: the run changed while the judge was materializing' }
        }
        // The child was never successfully admitted. Clear the reserved id so
        // node_resume takes A4 R4's spawn-rebuild branch instead of attempting
        // to followup a Judge that does not exist.
        delete fresh.run.judgeSessionId
        await this.blockOnJudgeFault(workspaceKey, fresh.run, fresh.version, detail)
        return { ok: true, run: fresh.run, message: fresh.run.blockReason ?? '' }
      }

      // A1 R11 spawn-cleanup path: reset/start or another non-queued command may
      // invalidate the row while the child is being materialized. Re-read after
      // admission and drain the stale Judge if the run moved on.
      const fresh = await this.state.get(workspaceKey)
      if (fresh === undefined
        || fresh.run.runId !== entered.run.runId
        || fresh.run.judgeSessionId !== reservedJudgeSessionId
        || fresh.run.status !== 'running'
        || topFrame(fresh.run).nodeToken !== book.dispatchedToken) {
        await this.subagents.drainJudge(entered.run, reservedJudgeSessionId).catch(() => {})
        return { ok: false, reason: 'stale judge spawn discarded: the run changed while the judge was materializing' }
      }
      return { ok: true, run: fresh.run, message: `judge spawned for node ${frame.nodeId}` }
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  /**
   * A4 R1/R2: fail-closed BLOCK on a judge technical fault, with steer.
   * Spawn/admission failure callers must first clear the never-admitted
   * reserved id so node_resume can spawn-rebuild (A4 R4/R8). Failures of an
   * admitted Judge keep judgeSessionId for the Manager's followup/respawn
   * decision (A4 R5); pendingClaim always survives for packet rebuild.
   */
  private async blockOnJudgeFault(workspaceKey: string, run: RunState, version: number, detail: string): Promise<void> {
    const frame = topFrame(run)
    const reason = `judge fault: ${detail}`.slice(0, LIMITS.blockReasonMax)
    run.status = 'blocked'
    run.blockReason = reason
    // A3 R4/R5: judge technical fault → BLOCK with source=judge (before the
    // persistence, per §10 order). The reason mirrors the durable blockReason.
    this.logBlock(run, frame, 'judge', reason)
    await this.state.put(workspaceKey, run, version)
    this.dispatchBook.delete(workspaceKey)
    await this.targets.steerManager(run, judgeFaultNotice(run, frame.nodeId, detail)).catch(() => {})
  }

  /**
   * Handle the Judge's `judge_claim` tool call (A1 v2 truth table):
   * - ACCEPT → advance with the ACTOR's claimed outcome (completed→PASS,
   *   failed→FAIL); the Judge confirms, it never rewrites the result.
   * - REJECT → correction flow: retire the Judge, persist the rejection
   *   evidence, rotate the token, re-dispatch the SAME node to the ORIGINAL
   *   actor with the evidence (§6.2).
   * - NEED_CONTEXT → BLOCK and keep the judge session for a followup.
   */
  async handleJudgeClaim(workspaceKey: string, nodeToken: string, result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT', reason: string, judgeSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}; judge claims are rejected` }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    // A1 review fix: the stored/traced reason is the trim result — a
    // whitespace-padded reason must not bloat State or the correction message
    // (design §6.3/§6.4 bound the LIMITS at their trim semantics).
    reason = reason.trim()
    // A1 R9 / AC9: only the current node's mapped judge session may claim.
    if (run.judgeSessionId === undefined || run.judgeSessionId !== judgeSessionId) {
      return { ok: false, reason: 'judge session is not the current node judge' }
    }
    if (run.pendingClaim === undefined) {
      return { ok: false, reason: 'no pending judgment for this node' }
    }
    // A3 R3: the verdict is validated against the pending claim — record it
    // before any state transition (§10 order).
    this.logJudge(run, frame, result, reason, judgeSessionId)
    if (result === 'NEED_CONTEXT') {
      // A1 R10: BLOCK, keep the judge session + pendingClaim + boundary.
      // A1 §6.4: pendingCorrection is RETAINED through the BLOCK so the
      // respawn/spawn-rebuild packet still carries the previous rejection.
      run.status = 'blocked'
      run.blockReason = reason.slice(0, LIMITS.blockReasonMax)
      this.logBlock(run, frame, 'judge', reason)
      await this.state.put(workspaceKey, run, version)
      this.dispatchBook.delete(workspaceKey)
      await this.targets.steerManager(run, needContextNotice(run, frame.nodeId, reason)).catch(() => {})
      return { ok: true, run, message: run.blockReason }
    }
    if (result === 'REJECT') {
      // A1 §6.2 correction flow — no Edge is read, no ROUTE is logged (R6.6).
      const node = this.nodeAt(run, frame)!
      const role = node.execution.type === 'actor-task' ? (node.execution.role ?? 'manager') : 'manager'
      // 2. Snapshot BEFORE clearing (the packet and the correction message
      //    both quote the rejected claim).
      const previousClaim = { ...run.pendingClaim }
      const oldJudgeId = judgeSessionId
      // 3. Retire the Judge (revoke authorization; DSH's settlement watcher
      //    releases the Activation) and end the judgment phase.
      await this.subagents.retireJudge(run, oldJudgeId).catch(() => {})
      delete run.judgeSessionId
      delete run.pendingClaim
      // 4. Persist the durable REJECT evidence (D4): feeds the next
      //    Judgment Packet's [previous rejection] section and survives a
      //    correction-dispatch failure + resume rebuild.
      run.pendingCorrection = { judgeReason: reason, previousClaim }
      // 5. Same node, fresh token (D2: rotation retires the stale-judge
      //    rejection path; workflowId/nodeId unchanged — R6.3).
      frame.nodeToken = newNodeToken()
      // 6. nodeBoundary is RETAINED (R8): the correction re-dispatch resolves
      //    the ORIGINAL actor through nodeBoundary.executorSessionId (§6.5),
      //    isSameNodeResume skips compaction, and the projection window
      //    keeps this node's local history.
      // 7. Trace the re-dispatch boundary BEFORE persistence (§10 order).
      this.logCorrect(run, frame, role, oldJudgeId, reason)
      // 8–9. Correction message + dispatch decision, exactly like a PASS's
      // next-node dispatch: defer while the executor's turn is still open,
      // dispatch now when it already settled.
      const correction = { kind: 'correction' as const, text: correctionEvidence(run.pendingCorrection) }
      const book = this.dispatchBook.get(workspaceKey)
      const workerStillActive = await this.executorActive(run)
      if (workerStillActive || (book !== undefined && !book.workerSettled)) {
        await this.persistDeferred(workspaceKey, run, version, correction)
      } else {
        await this.dispatchNow(workspaceKey, run, version, correction)
      }
      return { ok: true, run, message: 'checker REJECT; correction dispatched' }
    }
    // ACCEPT: the Graph verdict is the ACTOR's claimed outcome (AC5/AC6) —
    // the Judge confirmed, it did not rewrite the result.
    const verdict = run.pendingClaim.outcome === 'completed' ? 'PASS' : 'FAIL'
    // PASS/FAIL: apply the edge and retire the judge.
    const handoff = run.pendingClaim?.handoffContext
    this.advance(run, verdict, reason, 'judge')
    // A1 R11: retire the judge (revoke authorization; the resident Activation
    // is released by DSH's settlement watcher once its turn ends). Never drain
    // from inside the judge's own tool call — see SubagentHost.retireJudge.
    await this.subagents.retireJudge(run, judgeSessionId).catch(() => {})
    // Dispatch the next node. If the worker's turn already settled (the common
    // async-Judge ordering), no future turn/end will arrive — dispatch now.
    // Otherwise defer to that settlement (handleTurnEnded's pendingDispatch
    // branch) so we never dispatch into a still-open executor turn.
    const book = this.dispatchBook.get(workspaceKey)
    const workerStillActive = await this.executorActive(run)
    const handoffTransient = handoff !== undefined ? { kind: 'handoff' as const, text: handoff } : null
    if (workerStillActive || (book !== undefined && !book.workerSettled)) {
      await this.persistDeferred(workspaceKey, run, version, handoffTransient)
    } else {
      await this.dispatchNow(workspaceKey, run, version, handoffTransient)
    }
    return { ok: true, run, message: `checker ${result}` }
  }

  /**
   * Whether the run's current executor still has an active (unsettled) turn.
   * Manager sessions are never treated as active here — the Manager can always
   * be steered; only role actors need the F13 wait. Used after judgment-phase
   * BLOCKs, where the dispatch book is gone (S9 hardening).
   */
  private async executorActive(run: RunState): Promise<boolean> {
    if (run.status !== 'running' || run.callStack.length === 0) return false
    const executor = executorSessionOf(run)
    if (executor === '' || executor === run.managerSessionId) return false
    return await this.actorActivity(executor) === 'active'
  }

  /**
   * A4 R4/R5: judge turn ended without a `judge_claim` → technical fault →
   * BLOCK with detail. The engine does NOT auto-retry or auto-respawn.
   */
  async handleJudgeTurnEnded(workspaceKey: string, judgeSessionId: string, detail?: string): Promise<EngineOutcome | undefined> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return undefined
    const { run, version } = row
    if (run.status !== 'running') return undefined
    if (run.judgeSessionId !== judgeSessionId) return undefined
    const frame = topFrame(run)
    const reason = detail ?? 'judge turn ended without judge_claim'
    await this.blockOnJudgeFault(workspaceKey, run, version, reason)
    return { ok: true, run, message: run.blockReason ?? '' }
  }

  /** A4 R6: Manager-only explicit judge rebuild (clear + spawn + re-deliver packet). */
  async handleRespawnJudge(workspaceKey: string, nodeToken: string, reason?: string, callerSessionId?: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'blocked') return { ok: false, reason: `run is ${run.status}; respawn requires blocked` }
    if (run.managerSessionId !== callerSessionId) {
      return { ok: false, reason: 'only the Manager may respawn the judge' }
    }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    if (run.pendingClaim === undefined) {
      return { ok: false, reason: 'no pending judgment to respawn' }
    }
    // Prepare every fallible packet input before draining the existing Judge or
    // publishing a replacement id. A preparation fault leaves the blocked run
    // and its current Judge mapping untouched, so Manager may retry safely.
    const node = this.nodeAt(run, frame)!
    const checker = node.checker!
    const criteria = typeof checker.config['criteria'] === 'string' ? checker.config['criteria'] : ''
    const cwd = await this.cwdResolver(run)
    // Drain the old judge (if any) and clear the mapping + revoke authz.
    const oldJudge = run.judgeSessionId
    delete run.judgeSessionId
    if (oldJudge !== undefined) {
      await this.subagents.drainJudge(run, oldJudge).catch(() => {})
    }
    // Rebuild: reserve and persist the fresh Judge id before child admission,
    // so the Judge can submit judge_claim as soon as DSH accepts its first
    // prompt (P1).
    const reservedJudgeSessionId = newNodeToken()
    run.judgeSessionId = reservedJudgeSessionId
    run.status = 'running'
    run.blockReason = null
    // A3 R6 + review round 2: record the rebuild BEFORE persistence (§10
    // validate → trace → persist; at-least-once). A spawn failure afterwards
    // is covered by the following judge-fault BLOCK line.
    this.logRespawn(run, frame, reservedJudgeSessionId, reason ?? null)
    await this.state.put(workspaceKey, run, version)
    try {
      await this.subagents.startJudge(run, {
        nodeToken: frame.nodeToken,
        instruction: node.execution.instruction ?? '',
        criteria,
        // A1 R7: the Judgment Packet receives only outcome/summary; handoff
        // remains persisted in pendingClaim for the next node after PASS.
        claim: { outcome: run.pendingClaim.outcome, summary: run.pendingClaim.summary },
        // A1 §6.4: judge-fault/NEED_CONTEXT BLOCKs keep the correction
        // evidence — the rebuilt packet still sees what was rejected.
        previousRejection: run.pendingCorrection,
        cwd,
        judgeSessionId: reservedJudgeSessionId,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const fresh = await this.state.get(workspaceKey)
      if (fresh === undefined) return { ok: false, reason: 'state row vanished during judge respawn' }
      // reset/start can replace the row during spawn; never mutate a run that
      // is not this respawn's original run/token.
      if (fresh.run.runId !== run.runId
        || fresh.run.judgeSessionId !== reservedJudgeSessionId
        || fresh.run.status !== 'running'
        || topFrame(fresh.run).nodeToken !== nodeToken) {
        await this.subagents.drainJudge(run, reservedJudgeSessionId).catch(() => {})
        return { ok: false, reason: 'stale judge respawn discarded: the run changed while the judge was materializing' }
      }
      delete fresh.run.judgeSessionId
      await this.blockOnJudgeFault(workspaceKey, fresh.run, fresh.version, detail)
      return { ok: true, run: fresh.run, message: fresh.run.blockReason ?? '' }
    }

    // A1 R11 spawn-cleanup path: validate the post-admission row before the
    // respawn is allowed to claim success.
    const fresh = await this.state.get(workspaceKey)
    if (fresh === undefined
      || fresh.run.runId !== run.runId
      || fresh.run.judgeSessionId !== reservedJudgeSessionId
      || fresh.run.status !== 'running'
      || topFrame(fresh.run).nodeToken !== nodeToken) {
      await this.subagents.drainJudge(run, reservedJudgeSessionId).catch(() => {})
      return { ok: false, reason: 'stale judge respawn discarded: the run changed while the judge was materializing' }
    }
    return { ok: true, run: fresh.run, message: `judge respawned for node ${frame.nodeId}` }
  }

  /** Handle node_block (design §5.2 G3 / A1 §5.2 lease classification). */
  async handleBlock(workspaceKey: string, nodeToken: string, reason: string, caller: ClaimCaller): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}` }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    const isManager = run.managerSessionId === caller.sessionId
    // A1 §5.2, review fix: classify by NODE ROLE — never by the drift-prone
    // roleActors mapping. executorSessionOf() returning '' for a missing
    // mapping must not fail OPEN: a sibling role actor that keeps its own
    // authorization (live session-role mapping) could otherwise block a node
    // whose executor mapping drifted, with no dispatch lease at all.
    const kind = this.currentNodeKind(run)
    if (kind !== 'actor-task') {
      // builtin-program / child-workflow nodes are Manager-driven control
      // plane and publish no lease; the Manager keeps its control-plane block.
      if (!isManager) {
        return { ok: false, reason: 'only the current node executor or the Manager may block' }
      }
    } else {
      const roleOfNode = this.nodeAt(run, frame)!.execution.role!
      // Manager on a role-executor node: control plane (node_resume's
      // sibling) — the status/token/caller checks above suffice, no lease.
      const managerControlPlane = isManager && roleOfNode !== 'manager'
      if (!managerControlPlane) {
        // Non-Manager on a Manager-executor node is not the executor at all.
        if (!isManager && roleOfNode === 'manager') {
          return { ok: false, reason: 'only the current node executor or the Manager may block' }
        }
        // Everyone else here IS the precise executor of this dispatch (the
        // Manager-executor, or the role Actor bound by the book's executor
        // truth) — the claim/block pair shares one dispatch lease, so a
        // second claim/block and a stale-turn block are both rejected.
        const lease = this.admitLease(workspaceKey, run, caller)
        if (!lease.ok) {
          return { ok: false, reason: '当前调用无法绑定到一个已 dispatch 的 Node' }
        }
      }
    }
    run.status = 'blocked'
    // A1 review fix: the tool layer's bound is trim-based — persist the trim
    // result so a whitespace bomb never inflates the durable row.
    run.blockReason = reason.trim()
    // A3 R5: explicit node_block — source reflects who called (Manager vs the
    // node's own Actor).
    this.logBlock(run, frame, isManager ? 'manager' : 'actor', run.blockReason)
    await this.state.put(workspaceKey, run, version)
    // A1 §3.2: BLOCK consumes the lease WITH the book (no consumed residue);
    // a put failure above leaves the book intact for a verbatim retry.
    this.dispatchBook.delete(workspaceKey)
    return { ok: true, run, message: `blocked: ${reason}` }
  }

  /** Handle node_resume (design §5.2 G4 / A1 R10 / A4 R4): rotate token, dispatch or followup. */
  async handleResume(workspaceKey: string, nodeToken: string, resolutionContext: string, callerSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'blocked') return { ok: false, reason: `run is ${run.status}; resume requires blocked` }
    if (run.managerSessionId !== callerSessionId) {
      return { ok: false, reason: 'only the Manager may resume a blocked node' }
    }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    // A1 review fix: trim the resolution context once — it feeds followups,
    // the resume log and the correction rebuild, all under trim-based bounds.
    resolutionContext = resolutionContext.trim()

    // A4 R4: in the judgment phase, the sole control signal is judgeSessionId.
    if (run.pendingClaim !== undefined) {
      run.status = 'running'
      run.blockReason = null
      frame.nodeToken = newNodeToken()
      // A3 R6: judgment-phase resume always targets the judge (followup the
      // live session, or rebuild from pendingClaim below).
      this.logResume(run, frame, nodeToken, 'judge', resolutionContext)
      if (run.judgeSessionId !== undefined) {
        // followup the SAME judge (A1 R10 / A4 R3); do not re-dispatch the actor.
        const followup = `[manager resolution]\n${resolutionContext}\n\n请用新的 nodeToken "${frame.nodeToken}" 继续判定，并再次调用 judge_claim 提交。`
        try {
          await this.subagents.followupJudge(run, run.judgeSessionId, followup)
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          await this.blockOnJudgeFault(workspaceKey, run, version, detail)
          return { ok: true, run, message: run.blockReason ?? '' }
        }
        await this.state.put(workspaceKey, run, version)
        return { ok: true, run, message: `followup judge ${run.judgeSessionId}` }
      }
      // Prepare every fallible packet input BEFORE publishing the reserved id.
      const node = this.nodeAt(run, frame)!
      const checker = node.checker!
      const criteria = typeof checker.config['criteria'] === 'string' ? checker.config['criteria'] : ''
      const cwd = await this.cwdResolver(run)
      // No judge session: reserve and persist the fresh Judge id before child
      // admission, so the child can judge_claim immediately after DSH accepts
      // its first prompt.
      const reservedJudgeSessionId = newNodeToken()
      run.judgeSessionId = reservedJudgeSessionId
      await this.state.put(workspaceKey, run, version)
      try {
        await this.subagents.startJudge(run, {
          nodeToken: frame.nodeToken,
          instruction: node.execution.instruction ?? '',
          criteria,
          // A1 R7: only outcome/summary enter the rebuilt Judgment Packet;
          // handoff stays in pendingClaim for delivery after a PASS.
          claim: { outcome: run.pendingClaim.outcome, summary: run.pendingClaim.summary },
          // A1 §6.4: the spawn-rebuild keeps the prior rejection evidence.
          previousRejection: run.pendingCorrection,
          cwd,
          judgeSessionId: reservedJudgeSessionId,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const fresh = await this.state.get(workspaceKey)
        if (fresh === undefined) return { ok: false, reason: 'state row vanished during judge spawn recovery' }
        if (fresh.run.runId !== run.runId
          || fresh.run.judgeSessionId !== reservedJudgeSessionId
          || fresh.run.status !== 'running'
          || topFrame(fresh.run).nodeToken !== frame.nodeToken) {
          await this.subagents.drainJudge(run, reservedJudgeSessionId).catch(() => {})
          return { ok: false, reason: 'stale judge spawn discarded: the run changed while the judge was materializing' }
        }
        delete fresh.run.judgeSessionId
        await this.blockOnJudgeFault(workspaceKey, fresh.run, fresh.version, detail)
        return { ok: true, run: fresh.run, message: fresh.run.blockReason ?? '' }
      }

      // A1 R11 spawn-cleanup path: validate the post-admission row before the
      // recovery is allowed to claim success.
      const fresh = await this.state.get(workspaceKey)
      if (fresh === undefined
        || fresh.run.runId !== run.runId
        || fresh.run.judgeSessionId !== reservedJudgeSessionId
        || fresh.run.status !== 'running'
        || topFrame(fresh.run).nodeToken !== frame.nodeToken) {
        await this.subagents.drainJudge(run, reservedJudgeSessionId).catch(() => {})
        return { ok: false, reason: 'stale judge spawn discarded: the run changed while the judge was materializing' }
      }
      return { ok: true, run: fresh.run, message: `judge respawned for node ${frame.nodeId}` }
    }

    // F13: never dispatch while the current node's actor has an active turn.
    const currentExecutor = executorSessionOf(run)
    if (currentExecutor !== run.managerSessionId && currentExecutor !== '') {
      const activity = await this.actorActivity(currentExecutor)
      if (activity === 'active') {
        return { ok: false, reason: 'the current role actor still has an active turn; wait for it to settle' }
      }
    }
    run.status = 'running'
    run.blockReason = null
    frame.nodeToken = newNodeToken()
    // A3 R6: actor-path resume (re-dispatch with the resolution context).
    this.logResume(run, frame, nodeToken, 'actor', resolutionContext)
    // A1 §6.4: resuming a correction-dispatch failure (pendingCorrection set,
    // no pendingClaim) rebuilds the FULL R7 evidence so the Actor receives
    // [judge rejection] + [previous claim] + [manager resolution] + the
    // [instruction] wrapper — independent of the Manager copying from trace.
    const transient: TransientDispatch = run.pendingCorrection !== undefined && run.pendingClaim === undefined
      ? { kind: 'correction', text: `${correctionEvidence(run.pendingCorrection)}\n\n[manager resolution]\n${resolutionContext}` }
      : { kind: 'handoff', text: resolutionContext }
    await this.dispatchNow(workspaceKey, run, version, transient)
    return { ok: true, run, message: run.blockReason ?? `resumed: ${resolutionContext.slice(0, 120)}` }
  }

  /** Handle node_run_program (design §5.2 G5). */
  async handleRunProgram(workspaceKey: string, nodeToken: string, parameters: Record<string, unknown>, callerSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}` }
    if (run.managerSessionId !== callerSessionId) {
      return { ok: false, reason: 'only the Manager may run a builtin program' }
    }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    const kind = this.currentNodeKind(run)
    if (kind !== 'builtin-program') return { ok: false, reason: `current node is ${kind}; only builtin-program accepts node_run_program` }
    const node = this.nodeAt(run, frame)!
    const programId = node.execution.programId!
    // F14: single-flight per node token — one program run at a time.
    const flightKey = `${workspaceKey}:${nodeToken}`
    if (this.inFlight.has(flightKey)) {
      return { ok: false, reason: 'a program run is already in flight for this node' }
    }
    this.inFlight.set(flightKey, 'program')
    try {
      const cwd = await this.cwdResolver(run)

      // Async program run — the mutation queue is NOT held.
      const result = await this.programs.run(run, programId, parameters, cwd)

      // Fresh re-read + token revalidation before applying (design §4).
      const fresh = await this.state.get(workspaceKey)
      if (fresh === undefined) return { ok: false, reason: 'state row vanished during the program run' }
      if (fresh.run.status !== 'running' || topFrame(fresh.run).nodeToken !== nodeToken) {
        return { ok: false, reason: 'stale program result discarded: the node moved or blocked meanwhile' }
      }
      // A3 §9: program outcome (parameters never logged). Recorded after the
      // stale-result revalidation and before the state transition (§10 order).
      this.logProgram(fresh.run, topFrame(fresh.run), programId, result.kind, result.kind === 'PASS' ? null : result.reason ?? null)
      if (result.kind === 'ERROR') {
        fresh.run.status = 'blocked'
        fresh.run.blockReason = `program ${programId} ERROR: ${result.reason ?? ''}`
        this.logBlock(fresh.run, topFrame(fresh.run), 'program', fresh.run.blockReason)
        await this.state.put(workspaceKey, fresh.run, fresh.version)
        this.dispatchBook.delete(workspaceKey)
        return { ok: true, run: fresh.run, message: fresh.run.blockReason }
      }
      this.advance(fresh.run, result.kind, result.reason ?? '', 'program')
      await this.persistDeferred(workspaceKey, fresh.run, fresh.version)
      return { ok: true, run: fresh.run, message: `program ${result.kind}` }
    } finally {
      this.inFlight.delete(flightKey)
    }
  }

  /** Handle node_resolve_program (design §5.2 G6). */
  async handleResolveProgram(workspaceKey: string, nodeToken: string, result: 'PASS' | 'FAIL', reason: string, callerSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'blocked') return { ok: false, reason: `run is ${run.status}; resolve_program requires blocked` }
    if (run.managerSessionId !== callerSessionId) {
      return { ok: false, reason: 'only the Manager may resolve a blocked program' }
    }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    if (this.currentNodeKind(run) !== 'builtin-program') {
      return { ok: false, reason: `current node is ${this.currentNodeKind(run)}; only builtin-program accepts node_resolve_program` }
    }
    // A1 review fix: same defensive trim as the judge/block/resume reasons —
    // the resolve reason flows into the trace line and any FAIL BLOCK reason.
    reason = reason.trim()
    // Clear the BLOCK before advancing; advance() re-BLOCKs on a FAIL without
    // an onFail edge (design §5.2 G6 / acceptance G6).
    run.status = 'running'
    run.blockReason = null
    // A3 R6: the Manager's manual resolution, recorded before routing.
    this.logResolve(run, frame, result, reason)
    this.advance(run, result, reason, 'manager')
    await this.persistDeferred(workspaceKey, run, version)
    return { ok: true, run, message: `resolved ${result}` }
  }

  /** Handle workflow_set_role_model (design §5.2 G7 / review F12 / A1 §6.5). */
  async handleSetRoleModel(workspaceKey: string, roleKey: string, provider: string, modelId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (roleKey !== 'judge' && !Object.prototype.hasOwnProperty.call(run.definitionSnapshot.roles, roleKey)) {
      return { ok: false, reason: `unknown role key "${roleKey}"` }
    }
    if (roleKey !== 'judge') {
      // A1 §6.5 guard (main): while the CURRENT node's actor awaits a
      // judgment or a correction re-dispatch, an override would delete the
      // mapping and silently redirect the correction to a replacement — the
      // REJECT flow would then resurrect the OLD actor mapping. Judged by
      // Node role + boundary (NOT the roleActors mapping): a drifted/missing
      // mapping must still trip the guard.
      // Review fix: a completed run has NO top frame (callStack=[]) — read
      // the node only when one exists; completed runs take the plain
      // override path exactly as before A1 (no throw).
      const node = run.callStack.length > 0 ? this.nodeAt(run, topFrame(run)) : undefined
      if (run.status === 'running'
        && node !== undefined && node.execution.type === 'actor-task' && node.execution.role === roleKey
        && run.nodeBoundary.dispatchedAt !== 0 && run.nodeBoundary.executorSessionId !== undefined
        && (run.pendingClaim !== undefined || run.pendingCorrection !== undefined)) {
        return { ok: false, reason: `role "${roleKey}" 的 actor 正在等待判定/修正；override 被拒绝` }
      }
      // Reject only while the mapped actor has a live ACTIVE turn; an idle actor
      // is replaceable (design §5.2: "目标 Worker active 时拒绝").
      const actorId = run.roleActors[roleKey]
      if (actorId !== undefined) {
        const activity = await this.actorActivity(actorId)
        if (activity === 'active') {
          return { ok: false, reason: `role "${roleKey}" has an active actor turn; override is rejected` }
        }
        // Remove the idle mapping so the next dispatch creates a replacement
        // with the new route (design §5.2).
        delete run.roleActors[roleKey]
      }
      // A1 §6.5 blocked escape hatch: a correction-dispatch failure BLOCK is
      // the Manager's disposal point — an override here is ACCEPTED and the
      // boundary is reset so the resume's correction re-dispatch takes the
      // ensureRoleActor path (replacement with the new route) while the
      // correction evidence still reaches it. The MODEL trace line plus the
      // boundary reset are the durable record of the explicit replacement.
      if (run.status === 'blocked' && run.pendingCorrection !== undefined && run.pendingClaim === undefined
        && node !== undefined && node.execution.type === 'actor-task' && node.execution.role === roleKey
        && run.nodeBoundary.dispatchedAt !== 0) {
        run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
      }
    }
    // A1 D3: one trim-then-normalize rule for both entry points (catalog zod
    // caps + here). A blank/over-limit route is rejected with the limit.
    let route: { provider: string; modelId: string }
    try {
      route = normalizeModelRoute(provider, modelId)
    } catch (error) {
      return { ok: false, reason: error instanceof WorkflowError ? error.message : String(error) }
    }
    run.modelOverrides[roleKey] = route
    // A3 R6: model override — ids only, never credentials (already normalized).
    this.logModel(run, roleKey, route.provider, route.modelId)
    await this.state.put(workspaceKey, run, version)
    return { ok: true, run, message: `model override set for ${roleKey}` }
  }

  /**
   * Turn settlement for one executor session (design §4.2):
   * - ONLY the current node's precise executor session can settle workflow
   *   turns (Manager/Role Actor/helper interleaving is ignored).
   * - pendingDispatch && running → dispatch the advanced node now.
   * - running && dispatchedToken still current → no accepted result → BLOCK.
   * Called by the plugin on `turn/end` of the manager or a mapped role actor.
   */
  async handleTurnEnded(workspaceKey: string, sessionId: string): Promise<EngineOutcome | undefined> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return undefined
    const { run } = row
    if (run.status !== 'running') {
      this.dispatchBook.delete(workspaceKey)
      return undefined
    }
    const book = this.dispatchBook.get(workspaceKey)
    if (book === undefined) return undefined
    // Only the dispatched executor's own settlement counts (design §4.2:
    // "only status=running && dispatchedToken==current top-frame nodeToken").
    const currentExecutor = executorSessionOf(run)
    const isDispatchedExecutor = book.executorSessionId === sessionId
      // A pending (not-yet-dispatched) advancement is settled by the OLD
      // turn's executor — the executor recorded at deferral time.
      || (book.pendingDispatch && (book.executorSessionId === '' || book.executorSessionId === sessionId))
    if (!isDispatchedExecutor) return undefined
    if (book.pendingDispatch) {
      const context = book.transientContext
      await this.dispatchNow(workspaceKey, run, row.version, context)
      return { ok: true, run, message: run.blockReason ?? `dispatched ${topFrame(run).nodeId}` }
    }
    // A judgment is in flight for this node: the worker's accepted claim ends
    // its turn BEFORE the async Judge verdict arrives. That turn-end is the
    // expected conclusion of a claiming turn, not a no-result turn (A3 R2
    // scopes the BLOCK to turns without node_claim/node_block). Record the
    // settlement so the later PASS/FAIL dispatches immediately (A1 R9–R11).
    if (run.pendingClaim !== undefined) {
      book.workerSettled = true
      return undefined
    }
    if (topFrame(run).nodeToken === book.dispatchedToken && currentExecutor === sessionId) {
      run.status = 'blocked'
      run.blockReason = 'actor-turn-ended-without-result'
      // A3 R5: the turn ended without node_claim/node_block — this BLOCK is
      // what fills the former 52-minute trace silence.
      this.logBlock(run, topFrame(run), 'actor', run.blockReason)
      await this.state.put(workspaceKey, run, row.version)
      this.dispatchBook.delete(workspaceKey)
      // A3 R3: actively notify the Manager.
      await this.targets.steerManager(run, actorNoResultNotice(run, topFrame(run).nodeId)).catch(() => {})
      return { ok: true, run, message: run.blockReason }
    }
    // Token changed without pendingDispatch: the old turn settled after an
    // edge advancement that was already dispatched — nothing to do.
    return undefined
  }

  /** Host-restart reconciliation (design §4.2 H1): every pre-existing running row BLOCKs. */
  async handleRestartReconcile(): Promise<void> {
    this.dispatchBook.clear()
    for (const listed of await this.state.listRuns()) {
      if (listed.run.status !== 'running') continue
      try {
        // The Session probe performs persistence I/O. Re-read afterwards and
        // mutate only the same pre-restart run/id; a concurrent post-restart
        // mutation or replacement owns the newer row and must not be clobbered.
        const listedJudgeId = listed.run.judgeSessionId
        const judgeExists = listedJudgeId === undefined
          ? true
          : await this.subagents.judgeSessionExists(listedJudgeId).catch(() => false)
        const fresh = await this.state.get(listed.workspaceKey)
        if (fresh === undefined
          || fresh.run.runId !== listed.run.runId
          || fresh.run.status !== 'running'
          || fresh.run.judgeSessionId !== listedJudgeId) {
          continue
        }
        fresh.run.status = 'blocked'
        fresh.run.blockReason = 'host-restarted-before-node-result'
        // A3 R5: restart-reconcile BLOCK. Reaches the ORIGINAL run log via the
        // durable traceLogPath persisted at Run start.
        this.logBlock(fresh.run, topFrame(fresh.run), 'restart', fresh.run.blockReason)
        // A reserved Judge id may be durable while its Session is not (the host
        // can crash between the pre-admission write and materialization). Clear
        // it so node_resume takes A4 R4's spawn-rebuild branch; pendingClaim
        // stays for the packet.
        if (!judgeExists) delete fresh.run.judgeSessionId
        await this.state.put(listed.workspaceKey, fresh.run, fresh.version)
      } catch {
        // Reconciliation is best-effort per workspace. A concurrent writer may
        // win the final optimistic put; never abort reconciliation of all
        // remaining rows or overwrite the newer state.
      }
    }
  }

  /** Reset: remove the workspace row (design A5). */
  async handleReset(workspaceKey: string): Promise<void> {
    const row = await this.state.get(workspaceKey)
    // A3 review S3: release the one-warning marker for the removed run.
    if (row !== undefined) this.traceWarnedRuns.delete(row.run.runId)
    await this.state.remove(workspaceKey)
    this.dispatchBook.delete(workspaceKey)
  }
}
