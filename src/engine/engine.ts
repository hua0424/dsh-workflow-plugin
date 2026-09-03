/**
 * Host interaction surfaces the engine needs, declared as narrow interfaces so
 * the whole engine is testable without a live DSH host. The plugin's `apply()`
 * wires real DSH services into these.
 */
import type { WorkflowConfig, NodeClaim, RunState, CallFrame, ClaimOutcome } from '../types.ts'
import { WorkflowError, LIMITS } from '../types.ts'
import { newNodeToken, topFrame } from '../state/invariants.ts'
import { createRunLog, appendLine } from './tracelog.ts'
import { SUBMISSION_CONSTRAINT } from './texts.ts'

/** A2 R4: marker prefix compactBeforeDispatch throws with (for clean BLOCK routing). */
const COMPACT_FAIL_PREFIX = 'node-boundary compact failed: '

/** A4 R2: fixed template for a judge technical fault (steered to the Manager). */
function judgeFaultNotice(run: RunState, nodeId: string, detail: string): string {
  return `⚠️ Judge 判定故障（workflow ${run.runId} / node ${nodeId}）\n诊断：${detail}\n\n当前 Node 已 BLOCK，未推进 PASS/FAIL。\n可选动作：\n  1. node_resume({nodeToken, resolutionContext}) —— 你的补充/指示交给当前 Judge 继续（followup）；\n  2. judge_respawn({nodeToken}) —— 放弃当前 Judge，重建新 Judge 重来一次判定；\n  3. workflow_set_role_model({roleKey:'judge', ...}) 换模型后再 resume/respawn；\n  4. node_block 保留现场等待人工。`
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

/** Deliverable messages to Manager / Role Actors. */
export interface DispatchTargets {
  steerManager(run: RunState, text: string): Promise<void>
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
  /** Node-boundary compact of a resident role actor (A2). */
  compactRoleActor(run: RunState, roleKey: string): Promise<{ ok: boolean; detail?: string }>
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
 *   message (handoffContext on PASS / resolutionContext on resume). Never
 *   persisted; consumed by exactly one dispatch (design §2.6/§5.2 G4).
 * - workerSettled: the dispatched executor's turn already ended while a
 *   judgment was pending (the async-Judge era: the worker's `node_claim` ends
 *   its turn long before the verdict). When true, a later PASS/FAIL verdict
 *   dispatches the next node immediately instead of deferring to a turn/end
 *   that already fired (A1 R9–R11).
 */
interface DispatchBook {
  dispatchedToken: string
  executorSessionId: string
  pendingDispatch: boolean
  transientContext: string | null
  workerSettled: boolean
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
  /** runId → trace-log file path (PRD workflow-run-logging R1; in-memory only). */
  private readonly logFiles = new Map<string, string>()
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
    let version: number
    try {
      version = await this.state.create(workspaceKey, run)
    } catch (error) {
      if (error instanceof Error && error.name === 'StateConflictError') {
        return { ok: false, reason: error.message }
      }
      throw error
    }
    // R1/R2: create the run trace log beside the catalog config and write the
    // START line. Best-effort — tracelog never throws, so logging can never
    // block run startup (R4).
    if (configPath !== undefined) {
      const logPath = createRunLog(configPath, run.catalogWorkflowId, run.runId)
      if (logPath !== undefined) {
        this.logFiles.set(run.runId, logPath)
        this.logLine(run, `START workflow=${run.catalogWorkflowId} run=${run.runId}`)
      }
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
   * run has no log file (no configPath at start, or log creation failed).
   */
  private logLine(run: RunState, line: string): void {
    const logPath = this.logFiles.get(run.runId)
    if (logPath === undefined) return
    appendLine(logPath, line)
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
   * A one-shot transientContext (handoff / resolution) is prepended to the
   * message and consumed. Establishes the NodeContextBoundary at actual
   * dispatch (A1 R1), performs node-boundary compaction (A2), and injects the
   * submission hard constraint for actor-tasks (A3 R1). Mutates the run in
   * memory only (role mapping + child frames + boundary). Throws on dispatch
   * failure so callers can BLOCK.
   */
  async dispatchCurrent(run: RunState, transientContext: string | null): Promise<void> {
    const frame = topFrame(run)
    const node = this.nodeAt(run, frame)
    if (node === undefined) throw new WorkflowError('current node is missing from the snapshot')
    const execution = node.execution
    const text = transientContext !== null && transientContext !== ''
      ? `[handoff]\n${transientContext}\n\n[instruction]\n${execution.instruction ?? ''}`
      : (execution.instruction ?? '')

    if (execution.type === 'actor-task') {
      // A3 R1: append the submission hard constraint (never replace the original).
      const dispatchText = text + SUBMISSION_CONSTRAINT
      if (execution.role === 'manager') {
        // A2 R2: the Manager (user main session) is never compacted.
        this.establishManagerBoundary(run)
        await this.targets.steerManager(run, dispatchText)
      } else {
        const roleKey = execution.role!
        const existing = run.roleActors[roleKey]
        // A2 R6 / A1 R4: compact only on fresh node entry — a retained
        // boundary for the SAME executor means this is a same-node resume.
        const isSameNodeResume = run.nodeBoundary.dispatchedAt !== 0
          && run.nodeBoundary.executorSessionId === existing
        if (existing !== undefined) {
          if (!isSameNodeResume) {
            await this.compactBeforeDispatch(run, roleKey)
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
        } else {
          // A2 R3: first creation has no history — create directly, no compact.
          const dispatchedAt = Date.now()
          const managerFromSeq = this.targets.managerSessionSeq(run)
          const { childId, messageId } = await this.subagents.ensureRoleActor(run, roleKey, dispatchText)
          run.roleActors[roleKey] = childId
          run.nodeBoundary = { dispatchedAt, managerFromSeq, executorSessionId: childId, executorDispatchMessageId: messageId }
        }
      }
    } else if (execution.type === 'builtin-program') {
      // A3 R1: builtin-program dispatch is NOT injected with the constraint.
      this.establishManagerBoundary(run)
      const programText = text !== ''
        ? text
        : 'Run the current builtin program via node_run_program.'
      await this.targets.steerManager(run, programText)
    } else {
      const childId = execution.workflowId!
      const childDef = run.definitionSnapshot.childWorkflows?.[childId]
      if (childDef === undefined) throw new WorkflowError(`child workflow "${childId}" is missing from the snapshot`)
      run.callStack.push({ workflowId: childId, nodeId: childDef.startNode, nodeToken: newNodeToken() })
      // R3: child-workflow push routing (the pop side is logged by advance()).
      this.logLine(run, `NODE ${frame.workflowId}/${frame.nodeId} PUSH -> ${childId}`)
      // The handoff reaches the Child's start node (design §2.6).
      await this.dispatchCurrent(run, transientContext)
    }
  }

  /** Establish the boundary for a Manager-driven node (no executor session). */
  private establishManagerBoundary(run: RunState): void {
    // A1 R4: on resume the boundary is retained; on fresh node entry it is
    // (re)established from the current manager session cursor.
    if (run.nodeBoundary.dispatchedAt !== 0) return
    run.nodeBoundary = { dispatchedAt: Date.now(), managerFromSeq: this.targets.managerSessionSeq(run) }
  }

  /** A2: node-boundary compact of a resident role actor (best-effort trace log). */
  private async compactBeforeDispatch(run: RunState, roleKey: string): Promise<void> {
    // Fresh-node-entry decision is the caller's (dispatchCurrent): same-node
    // resume and first creation never reach here (A2 R3/R6).
    const result = await this.subagents.compactRoleActor(run, roleKey)
    if (!result.ok) {
      const detail = result.detail ?? 'unknown compaction failure'
      this.logLine(run, `COMPACT ${topFrame(run).workflowId}/${topFrame(run).nodeId} role=${roleKey} FAIL: ${detail}`)
      throw new WorkflowError(`${COMPACT_FAIL_PREFIX}${detail}`)
    }
    this.logLine(run, `COMPACT ${topFrame(run).workflowId}/${topFrame(run).nodeId} role=${roleKey} ${result.detail ?? 'ok'}`)
  }

  /** Mutate the run along a PASS/FAIL edge (no persistence). */
  private advance(run: RunState, verdict: 'PASS' | 'FAIL', reason: string): void {
    const frame = topFrame(run)
    const node = this.nodeAt(run, frame)
    if (node === undefined) throw new WorkflowError('current node is missing from the snapshot')
    // The verdict always ends the judgment phase.
    delete run.judgeSessionId
    delete run.pendingClaim
    // R3: log the routing decision as `NODE <workflowId>/<nodeId> <verdict> -> <target>`.
    const route = (line: string) => this.logLine(run, `NODE ${frame.workflowId}/${frame.nodeId} ${line}`)
    if (verdict === 'PASS') {
      const target = node.onPass
      if (target === 'END') {
        route('PASS -> END')
        if (run.callStack.length === 1) {
          run.status = 'completed'
          run.callStack = []
          run.blockReason = null
          // A1 R4: the node has left; the boundary is invalid.
          run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
          return
        }
        run.callStack.pop()
        this.advance(run, 'PASS', '')
        return
      }
      route(`PASS -> ${target}`)
      frame.nodeId = target
      frame.nodeToken = newNodeToken()
      // A1 R4: the node has left; the next dispatch establishes a fresh boundary.
      run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
      return
    }
    const target = node.onFail
    if (target === undefined || target === 'END') {
      route('FAIL -> BLOCK')
      run.status = 'blocked'
      run.blockReason = `checker FAIL${reason.trim() !== '' ? `: ${reason.trim()}` : ''} and no onFail edge`
      // A1 R4: FAIL with no onFail keeps the node — the boundary is RETAINED so
      // a resume preserves this node's local history (and A2 R6 skips compact).
      return
    }
    route(`FAIL -> ${target}`)
    frame.nodeId = target
    frame.nodeToken = newNodeToken()
    // A1 R4: the node has left via the onFail edge.
    run.nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }
  }

  /** Dispatch the current node NOW (start/resume), then persist. */
  private async dispatchNow(workspaceKey: string, run: RunState, expectedVersion: number, transientContext: string | null = null): Promise<void> {
    if (run.status === 'running') {
      try {
        await this.dispatchCurrent(run, transientContext)
      } catch (error) {
        run.status = 'blocked'
        // A2 R4/AC5: a node-boundary compact failure gets its own clean
        // reason (no double wrapping) and an active Manager notification,
        // reusing the A4 BLOCK-steer framework.
        if (error instanceof WorkflowError && error.message.startsWith(COMPACT_FAIL_PREFIX)) {
          run.blockReason = error.message.slice(0, LIMITS.blockReasonMax)
          await this.state.put(workspaceKey, run, expectedVersion)
          this.dispatchBook.delete(workspaceKey)
          this.logLine(run, `DISPATCH BLOCKED ${topFrame(run).workflowId}/${topFrame(run).nodeId}: ${run.blockReason}`)
          await this.targets.steerManager(run, compactFaultNotice(run, topFrame(run).nodeId, error.message.slice(COMPACT_FAIL_PREFIX.length))).catch(() => {})
          return
        }
        run.blockReason = `dispatch-failed: ${String(error)}`.slice(0, LIMITS.blockReasonMax)
      }
    }
    await this.state.put(workspaceKey, run, expectedVersion)
    if (run.status === 'running') {
      this.dispatchBook.set(workspaceKey, {
        dispatchedToken: topFrame(run).nodeToken,
        executorSessionId: executorSessionOf(run),
        pendingDispatch: false,
        transientContext: null,
        workerSettled: false,
      })
    } else {
      this.dispatchBook.delete(workspaceKey)
      await this.notifyCompletion(run)
    }
  }

  /** Persist an advanced run WITHOUT dispatching (deferred until turn settlement). */
  private async persistDeferred(workspaceKey: string, run: RunState, version: number, transientContext: string | null = null): Promise<void> {
    await this.state.put(workspaceKey, run, version)
    if (run.status === 'running') {
      const previous = this.dispatchBook.get(workspaceKey)
      this.dispatchBook.set(workspaceKey, {
        dispatchedToken: previous?.dispatchedToken ?? topFrame(run).nodeToken,
        executorSessionId: previous?.executorSessionId ?? '',
        pendingDispatch: true,
        transientContext,
        workerSettled: false,
      })
    } else {
      this.dispatchBook.delete(workspaceKey)
      await this.notifyCompletion(run)
    }
  }

  /** When a run reaches Root END, notify the Manager (the user's main session). */
  private async notifyCompletion(run: RunState): Promise<void> {
    if (run.status !== 'completed') return
    // The run's trace log is complete; drop the in-memory mapping.
    this.logFiles.delete(run.runId)
    try {
      await this.targets.steerManager(run, `workflow "${run.catalogWorkflowId}" 已完成（run ${run.runId}）。`)
    } catch {
      // Completion notification is best-effort: the completed state is durable.
    }
  }

  /**
   * Handle a worker node_claim (design §5.2 G2): enter the judgment phase by
   * spawning a fresh continuable Judge with the Node-local Judgment Packet (A1
   * R7/R8) and persist the `pendingClaim` for respawn rebuild (A4 R9). The
   * verdict arrives later via `judge_claim` (handleJudgeClaim) or, on a
   * technical fault, via handleJudgeTurnEnded.
   */
  async handleClaim(workspaceKey: string, claim: NodeClaim, callerSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}; claims are rejected` }
    const frame = topFrame(run)
    if (frame.nodeToken !== claim.nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    if (this.currentNodeKind(run) !== 'actor-task') {
      return { ok: false, reason: `current node is ${this.currentNodeKind(run)}; only actor-task accepts claims` }
    }
    // Precise-executor check (design §4 seriality / review F5): only the
    // current node's mapped executor may claim; the Manager may claim only
    // Manager nodes.
    const expectedExecutor = executorSessionOf(run)
    if (expectedExecutor !== '' && expectedExecutor !== callerSessionId) {
      return { ok: false, reason: 'only the current node executor may claim' }
    }
    const node = this.nodeAt(run, frame)!
    const checker = node.checker
    if (checker === undefined) return { ok: false, reason: 'actor-task node has no checker' }
    if (checker.checkerId !== 'judge.goal-satisfied') {
      return { ok: false, reason: `unknown checker ${checker.checkerId}` }
    }
    // A1 R9 / single-flight: a node already in judgment phase rejects new claims.
    if (run.pendingClaim !== undefined) {
      return { ok: false, reason: 'a judgment is already pending for this node' }
    }
    // F14: single-flight per node token — one in-flight Judge per claim.
    const flightKey = `${workspaceKey}:${claim.nodeToken}`
    if (this.inFlight.has(flightKey)) {
      return { ok: false, reason: 'a judge evaluation is already in flight for this node' }
    }
    this.inFlight.set(flightKey, 'judge')
    try {
      // Prepare every fallible packet input BEFORE publishing the reserved id.
      const criteria = typeof checker.config['criteria'] === 'string' ? checker.config['criteria'] : ''
      const cwd = await this.cwdResolver(run)

      // A4 R9: persist pendingClaim AND the reserved Judge id BEFORE the
      // child admission. A freshly materialized child can run immediately, so
      // State must name the Judge before its first judge_claim is possible.
      const entered = await this.state.get(workspaceKey)
      if (entered === undefined) return { ok: false, reason: 'state row vanished during claim' }
      if (entered.run.status !== 'running' || topFrame(entered.run).nodeToken !== claim.nodeToken) {
        return { ok: false, reason: 'stale claim discarded: the node moved or blocked meanwhile' }
      }
      const reservedJudgeSessionId = newNodeToken()
      entered.run.pendingClaim = { outcome: claim.outcome, summary: claim.summary }
      if (claim.outcome === 'completed' && claim.handoffContext !== undefined && claim.handoffContext.trim() !== '') {
        entered.run.pendingClaim.handoffContext = claim.handoffContext.trim()
      }
      entered.run.judgeSessionId = reservedJudgeSessionId
      await this.state.put(workspaceKey, entered.run, entered.version)

      // A4 R1: spawn failure becomes a judge technical fault → BLOCK with detail.
      try {
        await this.subagents.startJudge(entered.run, {
          nodeToken: frame.nodeToken,
          instruction: node.execution.instruction ?? '',
          criteria,
          claim: { outcome: claim.outcome, summary: claim.summary },
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
          || topFrame(fresh.run).nodeToken !== claim.nodeToken) {
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
        || topFrame(fresh.run).nodeToken !== claim.nodeToken) {
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
    await this.state.put(workspaceKey, run, version)
    this.dispatchBook.delete(workspaceKey)
    this.logLine(run, `JUDGE FAULT ${frame.workflowId}/${frame.nodeId}: ${detail}`)
    await this.targets.steerManager(run, judgeFaultNotice(run, frame.nodeId, detail)).catch(() => {})
  }

  /**
   * Handle the Judge's `judge_claim` tool call (A1 R9–R11, A4 R4).
   * PASS/FAIL advance the node and release the judge; NEED_CONTEXT BLOCKs and
   * keeps the judge session for a followup.
   */
  async handleJudgeClaim(workspaceKey: string, nodeToken: string, result: 'PASS' | 'FAIL' | 'NEED_CONTEXT', reason: string, judgeSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}; judge claims are rejected` }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    // A1 R9 / AC9: only the current node's mapped judge session may claim.
    if (run.judgeSessionId === undefined || run.judgeSessionId !== judgeSessionId) {
      return { ok: false, reason: 'judge session is not the current node judge' }
    }
    if (run.pendingClaim === undefined) {
      return { ok: false, reason: 'no pending judgment for this node' }
    }
    if (result === 'NEED_CONTEXT') {
      // A1 R10: BLOCK, keep the judge session + pendingClaim + boundary.
      run.status = 'blocked'
      run.blockReason = reason.slice(0, LIMITS.blockReasonMax)
      await this.state.put(workspaceKey, run, version)
      this.dispatchBook.delete(workspaceKey)
      this.logLine(run, `JUDGE NEED_CONTEXT ${frame.workflowId}/${frame.nodeId}: ${reason}`)
      await this.targets.steerManager(run, needContextNotice(run, frame.nodeId, reason)).catch(() => {})
      return { ok: true, run, message: run.blockReason }
    }
    // PASS/FAIL: apply the edge and retire the judge.
    const handoff = run.pendingClaim?.handoffContext
    this.advance(run, result, reason)
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
    if (workerStillActive || (book !== undefined && !book.workerSettled)) {
      await this.persistDeferred(workspaceKey, run, version, handoff ?? null)
    } else {
      await this.dispatchNow(workspaceKey, run, version, handoff ?? null)
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
    // Drain the old judge (if any) and clear the mapping + revoke authz.
    const oldJudge = run.judgeSessionId
    delete run.judgeSessionId
    if (oldJudge !== undefined) {
      await this.subagents.drainJudge(run, oldJudge).catch(() => {})
    }
    // Prepare every fallible packet input BEFORE publishing the reserved id.
    const node = this.nodeAt(run, frame)!
    const checker = node.checker!
    const criteria = typeof checker.config['criteria'] === 'string' ? checker.config['criteria'] : ''
    const cwd = await this.cwdResolver(run)
    // Rebuild: reserve and persist the fresh Judge id before child admission,
    // so the Judge can submit judge_claim as soon as DSH accepts its first
    // prompt (P1).
    const reservedJudgeSessionId = newNodeToken()
    run.judgeSessionId = reservedJudgeSessionId
    run.status = 'running'
    run.blockReason = null
    await this.state.put(workspaceKey, run, version)
    try {
      await this.subagents.startJudge(run, {
        nodeToken: frame.nodeToken,
        instruction: node.execution.instruction ?? '',
        criteria,
        // A1 R7: the Judgment Packet receives only outcome/summary; handoff
        // remains persisted in pendingClaim for the next node after PASS.
        claim: { outcome: run.pendingClaim.outcome, summary: run.pendingClaim.summary },
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
    if (reason !== undefined) {
      this.logLine(fresh.run, `JUDGE RESPAWN ${frame.workflowId}/${frame.nodeId}: ${reason}`)
    }
    return { ok: true, run: fresh.run, message: `judge respawned for node ${frame.nodeId}` }
  }

  /** Handle node_block (design §5.2 G3). */
  async handleBlock(workspaceKey: string, nodeToken: string, reason: string, callerSessionId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (run.status !== 'running') return { ok: false, reason: `run is ${run.status}` }
    const frame = topFrame(run)
    if (frame.nodeToken !== nodeToken) return { ok: false, reason: 'nodeToken is stale' }
    // Manager may block any current node; a role actor may block only its own.
    const expectedExecutor = executorSessionOf(run)
    const isManager = run.managerSessionId === callerSessionId
    if (!isManager && expectedExecutor !== '' && expectedExecutor !== callerSessionId) {
      return { ok: false, reason: 'only the current node executor or the Manager may block' }
    }
    run.status = 'blocked'
    run.blockReason = reason
    await this.state.put(workspaceKey, run, version)
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

    // A4 R4: in the judgment phase, the sole control signal is judgeSessionId.
    if (run.pendingClaim !== undefined) {
      run.status = 'running'
      run.blockReason = null
      frame.nodeToken = newNodeToken()
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
    await this.dispatchNow(workspaceKey, run, version, resolutionContext)
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
      if (result.kind === 'ERROR') {
        fresh.run.status = 'blocked'
        fresh.run.blockReason = `program ${programId} ERROR: ${result.reason ?? ''}`
        await this.state.put(workspaceKey, fresh.run, fresh.version)
        this.dispatchBook.delete(workspaceKey)
        return { ok: true, run: fresh.run, message: fresh.run.blockReason }
      }
      this.advance(fresh.run, result.kind, result.reason ?? '')
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
    // Clear the BLOCK before advancing; advance() re-BLOCKs on a FAIL without
    // an onFail edge (design §5.2 G6 / acceptance G6).
    run.status = 'running'
    run.blockReason = null
    this.advance(run, result, reason)
    await this.persistDeferred(workspaceKey, run, version)
    return { ok: true, run, message: `resolved ${result}` }
  }

  /** Handle workflow_set_role_model (design §5.2 G7 / review F12). */
  async handleSetRoleModel(workspaceKey: string, roleKey: string, provider: string, modelId: string): Promise<EngineOutcome> {
    const row = await this.state.get(workspaceKey)
    if (row === undefined) return { ok: false, reason: 'no active run' }
    const { run, version } = row
    if (roleKey !== 'judge' && !Object.prototype.hasOwnProperty.call(run.definitionSnapshot.roles, roleKey)) {
      return { ok: false, reason: `unknown role key "${roleKey}"` }
    }
    // Reject only while the mapped actor has a live ACTIVE turn; an idle actor
    // is replaceable (design §5.2: "目标 Worker active 时拒绝").
    if (roleKey !== 'judge') {
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
    }
    run.modelOverrides[roleKey] = { provider, modelId }
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

  /** Host-restart reconciliation (design §4.2 H1): every running row BLOCKs. */
  async handleRestartReconcile(): Promise<void> {
    this.dispatchBook.clear()
    for (const row of await this.state.listRuns()) {
      if (row.run.status !== 'running') continue
      row.run.status = 'blocked'
      row.run.blockReason = 'host-restarted-before-node-result'
      // A reserved Judge id may be durable while its Session is not (the host
      // can crash between the pre-admission write and materialization). Clear
      // it so node_resume takes A4 R4's spawn-rebuild branch; pendingClaim
      // stays for the packet.
      if (row.run.judgeSessionId !== undefined) {
        const exists = await this.subagents.judgeSessionExists(row.run.judgeSessionId).catch(() => false)
        if (!exists) delete row.run.judgeSessionId
      }
      await this.state.put(row.workspaceKey, row.run, row.version)
    }
  }

  /** Reset: remove the workspace row (design A5). */
  async handleReset(workspaceKey: string): Promise<void> {
    const row = await this.state.get(workspaceKey)
    if (row !== undefined) this.logFiles.delete(row.run.runId)
    await this.state.remove(workspaceKey)
    this.dispatchBook.delete(workspaceKey)
  }
}
