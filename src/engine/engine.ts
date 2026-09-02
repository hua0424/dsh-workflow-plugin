/**
 * Host interaction surfaces the engine needs, declared as narrow interfaces so
 * the whole engine is testable without a live DSH host. The plugin's `apply()`
 * wires real DSH services into these.
 */
import type { WorkflowConfig, NodeClaim, JudgeResult, RunState, CallFrame } from '../types.ts'
import { WorkflowError } from '../types.ts'
import { newNodeToken, topFrame } from '../state/invariants.ts'
import { createRunLog, appendLine } from './tracelog.ts'

/** Deliverable messages to Manager / Role Actors. */
export interface DispatchTargets {
  steerManager(run: RunState, text: string): Promise<void>
  /** Deliver to an EXISTING mapped role actor (followup). */
  sendRoleActor(run: RunState, roleKey: string, text: string): Promise<void>
}

/** Subagent lifecycle used by roles/judge. */
export interface SubagentHost {
  /**
   * Create a continuable role actor for roleKey and deliver `initialText` as
   * its first prompt. Returns the durable child id.
   */
  ensureRoleActor(run: RunState, roleKey: string, initialText: string): Promise<string>
  runJudge(run: RunState, input: {
    instruction: string
    criteria: string
    claim: NodeClaim
    cwd: string
  }): Promise<JudgeResult | undefined>
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
 */
interface DispatchBook {
  dispatchedToken: string
  executorSessionId: string
  pendingDispatch: boolean
  transientContext: string | null
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
   * message and consumed. Mutates the run in memory only (role mapping + child
   * frames). Throws on dispatch failure so callers can BLOCK.
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
      if (execution.role === 'manager') {
        await this.targets.steerManager(run, text)
      } else {
        const roleKey = execution.role!
        const existing = run.roleActors[roleKey]
        if (existing !== undefined) {
          await this.targets.sendRoleActor(run, roleKey, text)
        } else {
          const childId = await this.subagents.ensureRoleActor(run, roleKey, text)
          run.roleActors[roleKey] = childId
        }
      }
    } else if (execution.type === 'builtin-program') {
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

  /** Mutate the run along a PASS/FAIL edge (no persistence). */
  private advance(run: RunState, verdict: 'PASS' | 'FAIL', reason: string): void {
    const frame = topFrame(run)
    const node = this.nodeAt(run, frame)
    if (node === undefined) throw new WorkflowError('current node is missing from the snapshot')
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
          return
        }
        run.callStack.pop()
        this.advance(run, 'PASS', '')
        return
      }
      route(`PASS -> ${target}`)
      frame.nodeId = target
      frame.nodeToken = newNodeToken()
      return
    }
    const target = node.onFail
    if (target === undefined || target === 'END') {
      route('FAIL -> BLOCK')
      run.status = 'blocked'
      run.blockReason = `checker FAIL${reason.trim() !== '' ? `: ${reason.trim()}` : ''} and no onFail edge`
      return
    }
    route(`FAIL -> ${target}`)
    frame.nodeId = target
    frame.nodeToken = newNodeToken()
  }

  /** Dispatch the current node NOW (start/resume), then persist. */
  private async dispatchNow(workspaceKey: string, run: RunState, expectedVersion: number, transientContext: string | null = null): Promise<void> {
    if (run.status === 'running') {
      try {
        await this.dispatchCurrent(run, transientContext)
      } catch (error) {
        run.status = 'blocked'
        run.blockReason = `dispatch-failed: ${String(error)}`
      }
    }
    await this.state.put(workspaceKey, run, expectedVersion)
    if (run.status === 'running') {
      this.dispatchBook.set(workspaceKey, {
        dispatchedToken: topFrame(run).nodeToken,
        executorSessionId: executorSessionOf(run),
        pendingDispatch: false,
        transientContext: null,
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

  /** Handle a worker node_claim (design §5.2 G2): run the checker and advance. */
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
    // F14: single-flight per node token — one in-flight Judge per claim.
    const flightKey = `${workspaceKey}:${claim.nodeToken}`
    if (this.inFlight.has(flightKey)) {
      return { ok: false, reason: 'a judge evaluation is already in flight for this node' }
    }
    this.inFlight.set(flightKey, 'judge')
    try {
      const criteria = typeof checker.config['criteria'] === 'string' ? checker.config['criteria'] : ''
      const cwd = await this.cwdResolver(run)

      // Async Judge evaluation — the per-workspace mutation queue is NOT held.
      const verdict = await this.subagents.runJudge(run, {
        instruction: node.execution.instruction ?? '',
        criteria,
        claim,
        cwd,
      })

      // Fresh re-read + token revalidation before applying the verdict (design §4).
      const fresh = await this.state.get(workspaceKey)
      if (fresh === undefined) return { ok: false, reason: 'state row vanished during judgment' }
      if (fresh.run.status !== 'running' || topFrame(fresh.run).nodeToken !== claim.nodeToken) {
        return { ok: false, reason: 'stale judge result discarded: the node moved or blocked meanwhile' }
      }
      if (verdict === undefined) {
        fresh.run.status = 'blocked'
        fresh.run.blockReason = 'judge evaluation produced no result'
        await this.state.put(workspaceKey, fresh.run, fresh.version)
        this.dispatchBook.delete(workspaceKey)
        return { ok: true, run: fresh.run, message: fresh.run.blockReason }
      }
      this.advance(fresh.run, verdict.result, verdict.reason)
      // handoffContext rides the deferred dispatch (design §2.6) — only completed claims.
      const handoff = claim.outcome === 'completed' && claim.handoffContext !== undefined && claim.handoffContext.trim() !== ''
        ? claim.handoffContext
        : null
      await this.persistDeferred(workspaceKey, fresh.run, fresh.version, handoff)
      return { ok: true, run: fresh.run, message: `checker ${verdict.result}` }
    } finally {
      this.inFlight.delete(flightKey)
    }
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

  /** Handle node_resume (design §5.2 G4): rotate token, dispatch now with resolutionContext. */
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
    if (topFrame(run).nodeToken === book.dispatchedToken && currentExecutor === sessionId) {
      run.status = 'blocked'
      run.blockReason = 'actor-turn-ended-without-result'
      await this.state.put(workspaceKey, run, row.version)
      this.dispatchBook.delete(workspaceKey)
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
