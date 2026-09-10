/** 唯一工作单 Runtime。SQLite CAS 保护短写；Host 调用始终在事务/锁之外。 */
import type { WorkflowConfig, NodeClaim, RunState, CallFrame, ClaimCaller, NodeContextBoundary, NodeExecution, ExecutionChange, NodeExecutionEvent, ExecutionDispatch, ExecutionJudge, ResumeTarget, ProgramResult } from '../types.ts'
import { WorkflowError, LIMITS, normalizeModelRoute, normalizeNodeClaim } from '../types.ts'
import { newNodeToken, topFrame } from '../state/invariants.ts'
import { validateAndNormalize, computeDefinitionHash } from '../catalog/validate.ts'
import { ACTOR_RECOVERY_INSTRUCTION, SUBMISSION_CONSTRAINT } from './texts.ts'
import { BUILTIN_PROGRAMS } from '../programs/catalog.ts'
import { createRunLog, appendLine, traceEvent, jsonField, shortId } from './tracelog.ts'

export interface DispatchTargets {
  steerManager(run: RunState, text: string): Promise<{ messageId: string }>
  sendRoleActor(run: RunState, roleKey: string, text: string): Promise<{ messageId: string }>
  managerSessionSeq(run: RunState): number
}
export interface JudgeSpawnInput {
  nodeToken: string
  instruction: string
  criteria: string
  input: string
  boundary: NodeContextBoundary
  claim: NodeClaim
  previousFeedback?: { result: 'REJECT' | 'NEED_CONTEXT'; reason: string; claim: NodeClaim }
  managerContext?: string
  cwd: string
  judgeSessionId: string
  recovery?: boolean
}
export type SessionAvailability = 'available' | 'missing' | 'unknown'
export interface SubagentHost {
  ensureRoleActor(run: RunState, roleKey: string, initialText: string): Promise<{ childId: string; messageId: string }>
  startJudge(run: RunState, input: JudgeSpawnInput): Promise<{ judgeSessionId: string; messageId: string }>
  followupJudge(run: RunState, judgeSessionId: string, input: JudgeSpawnInput): Promise<{ messageId: string }>
  judgeSessionAvailability(judgeSessionId: string): Promise<SessionAvailability>
  roleSessionAvailability(roleSessionId: string): Promise<SessionAvailability>
  retireJudge(run: RunState, judgeSessionId: string): Promise<void>
  drainJudge(run: RunState, judgeSessionId: string): Promise<void>
  compactRoleActor(run: RunState, roleKey: string): Promise<{ ok: boolean; detail?: string }>
  /** 必须覆盖普通工具 tail、已知后台写任务及未收口后代；unknown=false。 */
  safeToInspect(sessionId: string): Promise<boolean>
}
export interface ProgramHost {
  run(run: RunState, programId: string, parameters: Record<string, unknown>, cwd: string): Promise<ProgramResult>
}
export interface RuntimeRow { run: RunState; execution: NodeExecution; version: number }
export interface StateHost {
  get(workspaceKey: string): Promise<RuntimeRow | undefined>
  put(workspaceKey: string, run: RunState, expectedVersion: number, changes: ExecutionChange[]): Promise<void>
  create(workspaceKey: string, run: RunState, execution: NodeExecution): Promise<number>
  listRuns(): Promise<Array<RuntimeRow & { workspaceKey: string }>>
  execution(workspaceKey: string, executionId: string): Promise<NodeExecution | undefined>
  events(workspaceKey: string, executionId: string, after?: number, limit?: number): Promise<NodeExecutionEvent[]>
  historyOwner(workspaceKey: string, executionId: string): Promise<{ runId: string; managerSessionId: string } | undefined>
}
export type EngineOutcome = { ok: true; run: RunState; message: string } | { ok: false; reason: string }
export interface NodeView {
  execution: { type: 'actor-task' | 'builtin-program' | 'child-workflow'; role?: string; instruction?: string; programId?: string; workflowId?: string; config?: Record<string, unknown> }
  checker?: { checkerId: string; config: Record<string, unknown> }
  onPass: string
  onFail?: string
}
export function executorSessionOf(run: RunState): string {
  const frame = topFrame(run)
  const def = frame.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
  const execution = def?.nodes[frame.nodeId]?.execution
  return execution?.type === 'actor-task' && execution.role !== 'manager' ? run.roleActors[execution.role] ?? '' : run.managerSessionId
}
const rejected = (reason: string): EngineOutcome => ({ ok: false, reason })
const matches = (dispatch: ExecutionDispatch | undefined, caller: ClaimCaller): boolean =>
  dispatch?.sessionId === caller.sessionId && dispatch.messageId !== undefined && caller.turnUserMessageIds.has(dispatch.messageId)
const executionHandoff = (execution: NodeExecution): string | undefined => execution.claim?.handoff
  ?? (execution.program?.result?.kind === 'PASS' || execution.program?.result?.kind === 'FAIL' ? execution.program.result.handoff : undefined)
  ?? execution.child?.result?.handoff
const change = (execution: NodeExecution, ...events: NodeExecutionEvent['type'][]): ExecutionChange => ({ execution, expectedRevision: execution.revision, events })
export const TERMINATED_REASON = 'terminated; external effects not cancelled'

export class WorkflowEngine {
  cwdResolver: (run: RunState) => Promise<string> = async () => { throw new WorkflowError('cwd resolver is not wired') }
  actorActivity: (sessionId: string) => Promise<'active' | 'idle' | 'unknown'> = async () => 'unknown'
  managerRoute: (sessionId: string) => Promise<{ provider?: string; model?: string }> = async () => ({})
  frozenRoute: { provider?: string; model?: string } = {}
  traceWarn: ((message: string) => void) | undefined
  private readonly targets: DispatchTargets
  private readonly subagents: SubagentHost
  private readonly programs: ProgramHost
  private readonly state: StateHost
  private readonly traceWarned = new Set<string>()
  private trace(run: RunState, event: string, fields: Parameters<typeof traceEvent>[1]): void {
    if (run.traceLogPath && !appendLine(run.traceLogPath, traceEvent(event, fields))) this.warnTrace(run)
  }
  private warnTrace(run: RunState): void {
    if (this.traceWarned.has(run.runId)) return
    this.traceWarned.add(run.runId)
    try { this.traceWarn?.(`workflow trace unavailable for run ${run.runId}; SQLite remains authoritative`) } catch {}
  }
  constructor(targets: DispatchTargets, subagents: SubagentHost, programs: ProgramHost, state: StateHost) {
    this.targets = targets
    this.subagents = subagents
    this.programs = programs
    this.state = state
  }

  nodeAt(run: RunState, frame: CallFrame): NodeView | undefined {
    const def = frame.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
    return def?.nodes[frame.nodeId]
  }
  currentNodeKind(run: RunState): NodeView['execution']['type'] {
    const node = this.nodeAt(run, topFrame(run))
    if (!node) throw new WorkflowError('current node is missing from snapshot')
    return node.execution.type
  }
  buildInitialRun(managerSessionId: string, workflowId: string, config: WorkflowConfig, _definitionHash: string): RunState {
    const snapshot = validateAndNormalize(structuredClone(config), { workflowId })
    const currentExecutionId = newNodeToken()
    return {
      runId: newNodeToken(), managerSessionId, catalogWorkflowId: workflowId,
      definitionHash: computeDefinitionHash(snapshot), definitionSnapshot: snapshot,
      status: 'running', callStack: [{ workflowId, nodeId: snapshot.workflow.startNode, nodeToken: newNodeToken(), executionId: currentExecutionId }],
      currentExecutionId, roleActors: {}, modelOverrides: {}, blockReason: null,
    }
  }
  private newExecution(run: RunState, input: string, visit: number, predecessorId?: string): NodeExecution {
    const frame = topFrame(run)
    const execution = this.nodeAt(run, frame)?.execution
    const role = execution?.type === 'actor-task' ? execution.role : undefined
    const roleBoundaryPrepared = role === undefined || role === 'manager' || run.roleActors[role] === undefined
    return { runId: run.runId, ...frame, visit, revision: 0,
      input, phase: 'ready', roleBoundaryPrepared, restartPending: false, inputVersion: 1, blockReason: null, enteredAt: new Date().toISOString(),
      ...(predecessorId === undefined ? {} : { predecessorId }) }
  }
  private judgePacket(run: RunState, e: NodeExecution, cwd: string): JudgeSpawnInput {
    const node = this.nodeAt(run, topFrame(run))!
    const feedback = e.judgment?.result === 'REJECT' && e.previousClaim
      ? { result: e.judgment.result, reason: e.judgment.reason, claim: { outcome: e.previousClaim.outcome, handoff: e.previousClaim.handoff } }
      : e.judgment?.result === 'NEED_CONTEXT' && e.claim
        ? { result: e.judgment.result, reason: e.judgment.reason, claim: { outcome: e.claim.outcome, handoff: e.claim.handoff } }
        : undefined
    return {
      nodeToken: e.nodeToken, instruction: node.execution.instruction ?? '', criteria: String(node.checker?.config.criteria ?? ''),
      input: e.input, boundary: e.boundary!, claim: { outcome: e.claim!.outcome, handoff: e.claim!.handoff }, cwd, judgeSessionId: e.judge!.sessionId!,
      ...(feedback ? { previousFeedback: feedback } : {}),
      ...(e.resolution?.context ? { managerContext: e.resolution.context } : {}),
      ...(e.resolution?.target === 'judge' ? { recovery: true } : {}),
    }
  }
  async status(ws: string, caller = '', history?: { executionId: string; after?: number; limit?: number }) {
    const row = await this.state.get(ws)
    if (!row) return { ok: true, status: 'no active run' }
    const { run, execution } = row
    if (history) {
      const after = history.after ?? 0
      const limit = history.limit ?? 50
      if (!history.executionId.trim() || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        return { ok: false, reason: 'history requires executionId, after >= 0, and limit 1..50' }
      }
      try {
        const owner = await this.state.historyOwner(ws, history.executionId)
        if (!owner || owner.runId !== run.runId) return { ok: false, reason: 'workflow history execution is not in the current Run' }
        if (caller !== owner.managerSessionId) return { ok: false, reason: 'workflow history is Manager-only' }
        const events = await this.state.events(ws, history.executionId, after, limit)
        return { ok: true, status: { runId: owner.runId, history: { executionId: history.executionId, after, limit, events, nextAfter: events.length === limit ? events.at(-1)!.sequence : null } } }
      } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    const node = run.status === 'completed' ? undefined : this.nodeAt(run, topFrame(run))
    const handoffPreview = executionHandoff(execution)?.slice(0, 500) ?? null
    return { ok: true, status: {
      runId: run.runId, catalogWorkflowId: run.catalogWorkflowId, status: run.status,
      currentFrame: run.callStack.at(-1) ?? null,
      handler: node?.execution.type === 'actor-task' ? node.execution.role : node?.execution.type ?? null,
      execution: {
        executionId: execution.executionId, workflowId: execution.workflowId, nodeId: execution.nodeId,
        nodeToken: execution.nodeToken, visit: execution.visit, phase: execution.phase,
        hasClaim: execution.claim !== undefined, claimOutcome: execution.claim?.outcome ?? null,
        judgment: execution.judgment ? { result: execution.judgment.result, reasonPreview: execution.judgment.reason.slice(0, 500) } : null,
        inputPreview: execution.input.slice(0, 500), handoffPreview,
        blockReason: execution.blockReason ?? run.blockReason, recoveryTarget: execution.resolution?.target ?? null,
        restartPending: execution.restartPending,
      },
      blockReason: execution.blockReason ?? run.blockReason,
      handoffPreview,
      finalHandoffPreview: run.status === 'completed' ? handoffPreview : null,
    } }
  }
  async startRun(ws: string, run: RunState, configPath?: string, extraText = ''): Promise<EngineOutcome> {
    if (extraText.length > LIMITS.handoffMax) return rejected(`root input exceeds ${LIMITS.handoffMax} characters`)
    const previous = await this.state.get(ws)
    if (previous && previous.run.status !== 'completed' && previous.run.status !== 'terminated') return rejected(`workspace already has a ${previous.run.status} run`)
    if (previous?.run.status === 'terminated') {
      const previousNode = this.nodeAt(previous.run, topFrame(previous.run))
      const knownSessions = new Set<string>()
      if (previousNode?.execution.type === 'actor-task' && previousNode.execution.role !== 'manager') {
        const actorSessionId = previous.execution.dispatch?.sessionId ?? previous.run.roleActors[previousNode.execution.role!]
        if (actorSessionId) knownSessions.add(actorSessionId)
      }
      if (previous.execution.judge?.sessionId) knownSessions.add(previous.execution.judge.sessionId)
      if (previous.execution.predecessorId) {
        const predecessor = await this.state.execution(ws, previous.execution.predecessorId)
        if (!await this.sameRow(ws, previous)) return rejected('workspace history changed during terminated predecessor inspection')
        if (predecessor?.judge && !predecessor.judge.settled) knownSessions.add(predecessor.judge.sessionId)
      }
      for (const sessionId of knownSessions) {
        const safe = await this.subagents.safeToInspect(sessionId)
        if (!await this.sameRow(ws, previous)) return rejected('workspace history changed during terminated Run safety inspection')
        if (!safe) {
          const activity = await this.actorActivity(sessionId)
          if (!await this.sameRow(ws, previous)) return rejected('workspace history changed during terminated Run activity inspection')
          if (activity !== 'unknown') return rejected(`terminated Run session ${sessionId} is not safely closed`)
        }
      }
    }
    this.frozenRoute = await this.managerRoute(run.managerSessionId)
    if (configPath) {
      const path = createRunLog(configPath, run.catalogWorkflowId, run.runId)
      if (path) run.traceLogPath = path
      else this.warnTrace(run)
    }
    try { await this.state.create(ws, run, this.newExecution(run, extraText, 1)) }
    catch (error) {
      if (error instanceof Error && error.name === 'StateConflictError') return rejected(error.message)
      throw error
    }
    this.trace(run, 'START', { workflow: run.catalogWorkflowId, run: run.runId, fmt: 3 })
    await this.drive(ws)
    const row = (await this.state.get(ws))!
    return { ok: true, run: row.run, message: row.execution.blockReason ?? 'work order started' }
  }

  /** 一次触发只登记当前需要的一个安排。并发触发由数据库 CAS 仲裁，非整Promise锁。 */
  async drive(ws: string): Promise<void> {
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return
    const { run, execution: e, version } = row
    if (e.phase === 'ready') {
      if (e.predecessorId) {
        const predecessor = await this.state.execution(ws, e.predecessorId)
        if (!predecessor) return
        const predecessorNode = this.nodeAt(run, { workflowId: predecessor.workflowId, nodeId: predecessor.nodeId, nodeToken: predecessor.nodeToken, executionId: predecessor.executionId })
        const settled = predecessorNode?.execution.type === 'actor-task'
          ? predecessor.judge?.settled === true
          : predecessor.phase === 'exited' && predecessor.successorId === e.executionId
        if (!settled) return
      }
      const node = this.nodeAt(run, topFrame(run))!
      if (node.execution.type === 'builtin-program') {
        await this.state.put(ws, run, version, [change(e, 'program-ready')])
        await this.targets.steerManager(run, `[handoff]\n${e.input}\n\n[instruction]\n${node.execution.instruction ?? ''}\n\n[program]\n${node.execution.programId}\n请调用 node_run_program 提供当前参数；Program 结果由 Runtime 直接结算，不使用 Judge。`).catch(async error => {
          const current = await this.state.get(ws)
          if (current?.version === version + 1 && current.execution.executionId === e.executionId) await this.blockRow(ws, current, `dispatch fault: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      if (node.execution.type === 'child-workflow') {
        const child = run.definitionSnapshot.childWorkflows?.[node.execution.workflowId!]
        if (!child) { await this.blockRow(ws, row, 'Child workflow is missing from the frozen snapshot'); return }
        const executionId = newNodeToken()
        e.phase = 'working'
        e.child = { workflowId: node.execution.workflowId!, executionId }
        run.currentExecutionId = executionId
        run.callStack.push({ workflowId: node.execution.workflowId!, nodeId: child.startNode, nodeToken: newNodeToken(), executionId })
        const first = this.newExecution(run, e.input, e.visit + 1)
        await this.state.put(ws, run, version, [change(e, 'child-entered'), { execution: first, expectedRevision: null, events: ['entered'] }])
        await this.drive(ws)
        return
      }
      const role = node.execution.role!
      const previousDispatchSettled = e.dispatch?.settled === true
      let committedVersion = version
      try {
        e.phase = 'working'
        e.dispatch = { id: newNodeToken(), settled: false, ...(role === 'manager' ? { sessionId: run.managerSessionId } : run.roleActors[role] ? { sessionId: run.roleActors[role] } : {}) }
        e.boundary = { dispatchedAt: Date.now(), managerFromSeq: this.targets.managerSessionSeq(run), ...(role === 'manager' ? {} : e.dispatch.sessionId ? { executorSessionId: e.dispatch.sessionId } : {}) }
        await this.state.put(ws, run, version, [change(e, 'actor-arranged')])
        committedVersion = version + 1
        let arrangedVersion = committedVersion
        if (role !== 'manager' && run.roleActors[role]) {
          if (!previousDispatchSettled) {
            const sessionId = run.roleActors[role]
            const safe = await this.subagents.safeToInspect(sessionId)
            if (!await this.stillCurrent(ws, e, arrangedVersion)) return
            if (!safe) {
              const activity = await this.actorActivity(sessionId)
              if (!await this.stillCurrent(ws, e, arrangedVersion)) return
              if (e.resolution?.target !== 'actor' || activity !== 'unknown') throw new WorkflowError('previous Role execution is not safely closed')
            }
          }
          if (!e.roleBoundaryPrepared) {
            const compact = await this.subagents.compactRoleActor(run, role)
            if (!compact.ok) throw new WorkflowError(`node-boundary compact failed: ${compact.detail ?? 'unknown'}`)
            const current = await this.stillCurrent(ws, e, arrangedVersion)
            if (!current) return
            current.execution.roleBoundaryPrepared = true
            await this.state.put(ws, current.run, current.version, [change(current.execution)])
            e.roleBoundaryPrepared = true
            arrangedVersion = current.version + 1
            committedVersion = arrangedVersion
            if (!await this.stillCurrent(ws, e, arrangedVersion)) return
          }
        }
        const correction = e.previousClaim
          ? e.judgment && e.judgment.result !== 'ACCEPT' && e.judgment.claimId === e.previousClaim.id
            ? `\n\n[最近 Judge ${e.judgment.result} 与旧 claim]\n[judge feedback]\n${e.judgment.reason}\n\n[previous claim]\noutcome: ${e.previousClaim.outcome}\nhandoff: ${e.previousClaim.handoff}`
            : `\n\n[Manager 退回的旧 claim；无当前 Judge 反馈]\n[previous claim]\noutcome: ${e.previousClaim.outcome}\nhandoff: ${e.previousClaim.handoff}`
          : ''
        const resolution = e.resolution?.context ? `\n\n[Manager 当前完整补充]\n${e.resolution.context}` : ''
        const recovery = e.resolution?.target === 'actor' ? ACTOR_RECOVERY_INSTRUCTION : ''
        const text = `[handoff]\n${e.input}\n\n[instruction]\n${node.execution.instruction ?? ''}\n\n[criteria]\n${String(node.checker?.config.criteria ?? '')}${correction}${resolution}${recovery}${SUBMISSION_CONSTRAINT}`
        const sent = role === 'manager'
          ? { ...await this.targets.steerManager(run, text), childId: run.managerSessionId }
          : run.roleActors[role]
            ? { ...await this.targets.sendRoleActor(run, role, text), childId: run.roleActors[role] }
            : await this.subagents.ensureRoleActor(run, role, text)
        const fresh = await this.stillCurrent(ws, e, arrangedVersion)
        if (!fresh) return // 撤权不是停止；旧已知执行保留在工作单，不给它新权利。
        if (!sent.messageId || !sent.childId) throw new WorkflowError('Host returned no real dispatch identity')
        fresh.execution.dispatch!.sessionId = sent.childId
        fresh.execution.dispatch!.messageId = sent.messageId
        fresh.execution.boundary!.executorDispatchMessageId = sent.messageId
        if (role !== 'manager') {
          fresh.run.roleActors[role] = sent.childId
          fresh.execution.boundary!.executorSessionId = sent.childId
        }
        await this.state.put(ws, fresh.run, fresh.version, [change(fresh.execution)])
      } catch (error) { await this.dispatchFault(ws, e, error, committedVersion) }
      return
    }
    if (e.phase !== 'checking' || !e.claim || !e.dispatch?.settled || e.judge?.messageId) return
    // checking 不等于Judge已经运行：只有精确 Actor 收口入口能置settled。
    let committedVersion = version
    try {
      const node = this.nodeAt(run, topFrame(run))!
      const cwd = await this.cwdResolver(run)
      if (!await this.stillCurrent(ws, e, version)) return
      const continuationSessionId = e.resolution?.target === 'judge' && e.resolution.judgeMode === 'followup'
        ? e.resolution.judgeSessionId : undefined
      if (!await this.stillCurrent(ws, e, version)) return
      if (!e.judge) {
        e.judge = { id: newNodeToken(), sessionId: continuationSessionId ?? newNodeToken(), claimId: e.claim.id, inputVersion: e.inputVersion, settled: false }
        await this.state.put(ws, run, version, [change(e, 'judge-arranged')])
        committedVersion = version + 1
      } else if (e.judge.claimId !== e.claim.id || e.judge.inputVersion !== e.inputVersion
        || (continuationSessionId !== undefined && e.judge.sessionId !== continuationSessionId)) return
      const packet = this.judgePacket(run, e, cwd)
      const sent = continuationSessionId
        ? { ...await this.subagents.followupJudge(run, continuationSessionId, packet), judgeSessionId: continuationSessionId }
        : await this.subagents.startJudge(run, packet)
      const fresh = await this.stillCurrent(ws, e, committedVersion)
      if (!fresh) { await this.subagents.retireJudge(run, e.judge.sessionId!).catch(() => {}); return }
      if (sent.judgeSessionId !== e.judge.sessionId || !sent.messageId) throw new WorkflowError('Host returned mismatched Judge identity')
      fresh.execution.judge!.messageId = sent.messageId
      await this.state.put(ws, fresh.run, fresh.version, [change(fresh.execution)])
    } catch (error) { await this.dispatchFault(ws, e, error, committedVersion) }
  }
  private async stillCurrent(ws: string, e: NodeExecution, version: number): Promise<RuntimeRow | undefined> {
    const row = await this.state.get(ws)
    return row?.run.status === 'running' && row.version === version && row.execution.executionId === e.executionId
      && row.execution.dispatch?.id === e.dispatch?.id && row.execution.claim?.id === e.claim?.id
      && row.execution.judge?.id === e.judge?.id ? row : undefined
  }
  private async sameRow(ws: string, row: RuntimeRow): Promise<boolean> {
    const current = await this.state.get(ws)
    return current?.version === row.version && current.run.runId === row.run.runId
      && current.execution.executionId === row.execution.executionId
  }
  /** Manager-side destructive Judge handoff: drain first, then prove the same work is still current. */
  private async drainJudgeAndRevalidate(ws: string, row: RuntimeRow, judgeToDrain: ExecutionJudge | undefined): Promise<boolean> {
    if (judgeToDrain) await this.subagents.drainJudge(row.run, judgeToDrain.sessionId)
    const current = await this.state.get(ws)
    return current?.version === row.version && current.run.runId === row.run.runId
      && current.execution.executionId === row.execution.executionId
  }
  private async dispatchFault(ws: string, e: NodeExecution, error: unknown, committedVersion: number): Promise<void> {
    const row = await this.state.get(ws)
    // 本地候选安排可能尚未提交；只认最后成功提交的Run/visit/CAS版本。
    if (row?.run.status !== 'running' || row.run.runId !== e.runId || row.execution.executionId !== e.executionId || row.version !== committedVersion) return
    await this.blockRow(ws, row, `dispatch fault: ${error instanceof Error ? error.message : String(error)}`)
  }
  private async blockRow(ws: string, row: RuntimeRow, reason: string, ...beforeBlock: NodeExecutionEvent['type'][]): Promise<void> {
    row.run.status = 'blocked'
    row.execution.blockReason = reason.slice(0, LIMITS.blockReasonMax)
    await this.state.put(ws, row.run, row.version, [change(row.execution, ...beforeBlock, 'blocked')])
    this.trace(row.run, 'BLOCK', { workflow: row.execution.workflowId, node: row.execution.nodeId, reason: jsonField(row.execution.blockReason, LIMITS.blockReasonMax) })
    await this.targets.steerManager(row.run, `Workflow BLOCK: ${row.execution.blockReason}\n材料已保存；Manager 可查看 status 后选择恢复目标。`).catch(() => {})
  }
  private programParameters(node: NodeView, supplied: Record<string, unknown>): Record<string, unknown> {
    if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) throw new WorkflowError('program parameters must be an object')
    const definition = BUILTIN_PROGRAMS[node.execution.programId!]
    if (!definition) throw new WorkflowError(`unknown program ${node.execution.programId}`)
    const parameters = { ...(node.execution.config ?? {}), ...supplied }
    const unknown = Object.keys(parameters).filter(key => !(key in definition.parameters))
    if (unknown.length) throw new WorkflowError(`unknown program parameter: ${unknown.join(', ')}`)
    for (const [key, spec] of Object.entries(definition.parameters)) {
      const value = parameters[key]
      if (value === undefined) {
        if (spec.required) throw new WorkflowError(`program parameter ${key} is required`)
      } else if (spec.type === 'string' ? typeof value !== 'string' || value.trim() === '' : typeof value !== 'number' || !Number.isFinite(value)) {
        throw new WorkflowError(`program parameter ${key} must be a ${spec.type}`)
      }
    }
    const encoded = JSON.stringify(parameters)
    if (encoded.length > LIMITS.programParametersMax) throw new WorkflowError(`program parameters must be at most ${LIMITS.programParametersMax} characters`)
    return structuredClone(parameters)
  }
  private effectiveProgramResult(result: ProgramResult, input: string): NonNullable<NonNullable<NodeExecution['program']>['result']> {
    if (result.kind === 'ERROR') {
      const reason = result.reason.trim()
      if (!reason || reason.length > LIMITS.blockReasonMax) throw new WorkflowError('Program ERROR requires a bounded reason')
      return { kind: 'ERROR', reason }
    }
    const handoff = result.handoff === undefined ? input : result.handoff.trim()
    if (!handoff || handoff.length > LIMITS.handoffMax) throw new WorkflowError(`Program handoff must be 1..${LIMITS.handoffMax} characters`)
    const reason = result.kind === 'FAIL' && result.reason?.trim() ? result.reason.trim().slice(0, LIMITS.blockReasonMax) : undefined
    return { kind: result.kind, handoff, ...(reason ? { reason } : {}) }
  }
  private async advanceKnownResult(ws: string, row: RuntimeRow, result: 'PASS' | 'FAIL', handoff: string, ...events: NodeExecutionEvent['type'][]): Promise<EngineOutcome> {
    const { run, execution: e, version } = row
    const node = this.nodeAt(run, topFrame(run))!
    const target = result === 'PASS' ? node.onPass : node.onFail
    if (!target) {
      e.phase = 'settling'
      e.blockReason = `${result} has no configured Graph edge`.slice(0, LIMITS.blockReasonMax)
      run.status = 'blocked'
      await this.state.put(ws, run, version, [change(e, ...events, 'blocked')])
      await this.targets.steerManager(run, `Workflow BLOCK: ${e.blockReason}\n材料已保存；Manager 核查后可显式恢复。`).catch(() => {})
      return { ok: true, run, message: e.blockReason }
    }
    e.phase = 'exited'
    e.exitedAt = new Date().toISOString()
    const changes = [change(e, ...events, 'exited')]
    const exitedChain = [e]
    let nextTarget = target
    let terminalVisit = e.visit
    while (nextTarget === 'END' && run.callStack.length > 1) {
      run.callStack.pop()
      const parentFrame = topFrame(run)
      const parent = await this.state.execution(ws, parentFrame.executionId)
      const parentNode = this.nodeAt(run, parentFrame)
      if (!parent || parentNode?.execution.type !== 'child-workflow' || parent.phase !== 'working'
        || !parent.child || parent.child.result) throw new WorkflowError('stale or corrupt Child return')
      parent.child.result = { terminalExecutionId: e.executionId, handoff }
      parent.phase = 'exited'
      parent.exitedAt = new Date().toISOString()
      terminalVisit = Math.max(terminalVisit, parent.visit)
      exitedChain.push(parent)
      changes.push(change(parent, 'child-returned', 'exited'))
      nextTarget = parentNode.onPass
    }
    if (nextTarget === 'END') {
      run.status = 'completed'
      run.currentExecutionId = exitedChain.at(-1)!.executionId
      run.callStack = []
    } else {
      run.currentExecutionId = newNodeToken()
      const frame = topFrame(run)
      frame.nodeId = nextTarget
      frame.nodeToken = newNodeToken()
      frame.executionId = run.currentExecutionId
      const successor = this.newExecution(run, handoff, terminalVisit + 1, e.executionId)
      for (const exited of exitedChain) exited.successorId = successor.executionId
      changes.push({ execution: successor, expectedRevision: null, events: ['entered'] })
    }
    await this.state.put(ws, run, version, changes)
    this.trace(run, 'ROUTE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, target })
    if (run.status === 'completed') {
      this.traceWarned.delete(run.runId)
      const terminal = result === 'FAIL'
        ? `workflow "${run.catalogWorkflowId}" 以失败结果结束（run ${run.runId}，FAIL→END）。Run 状态沿用 completed 表示执行结束，终局业务结果见 handoff。\n\n[handoff]\n${handoff}`
        : `workflow "${run.catalogWorkflowId}" 已完成（run ${run.runId}）。\n\n[handoff]\n${handoff}`
      await this.targets.steerManager(run, terminal).catch(() => {})
    }
    return { ok: true, run, message: `${result} committed` }
  }
  async handleClaim(ws: string, claim: NodeClaim, caller: ClaimCaller): Promise<EngineOutcome> {
    try { claim = normalizeNodeClaim(claim) } catch (error) { return rejected(String(error)) }
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return rejected('no running work order')
    const e = row.execution
    if (e.phase !== 'working' || e.claim || !matches(e.dispatch, caller)) return rejected('当前调用无法绑定到一个已 dispatch 的 Node')
    e.claim = { ...claim, id: newNodeToken(), dispatchId: e.dispatch!.id }
    e.phase = 'checking'
    // lease消费就是该事务中的phase/claim更新；失败不改内存权威，没有第二本lease book。
    await this.state.put(ws, row.run, row.version, [change(e, 'claim')])
    this.trace(row.run, 'CLAIM', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), outcome: claim.outcome, handoff: jsonField(claim.handoff, LIMITS.handoffMax) })
    return { ok: true, run: row.run, message: 'claim saved; waiting for Actor safe settlement' }
  }
  async handleJudgeClaim(ws: string, token: string, result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT', reason: string, caller: ClaimCaller): Promise<EngineOutcome> {
    reason = reason.trim()
    if (!['ACCEPT', 'REJECT', 'NEED_CONTEXT'].includes(result) || !reason || reason.length > LIMITS.reasonMax) return rejected('invalid Judge result/reason')
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return rejected('no running work order')
    const { run, execution: e, version } = row
    const alreadyJudged = e.judgment !== undefined && e.judgment.claimId === e.claim?.id && e.judgment.inputVersion === e.inputVersion
    if (e.nodeToken !== token || e.phase !== 'checking' || !e.claim || !e.judge || alreadyJudged
      || e.judge.claimId !== e.claim.id || e.judge.inputVersion !== e.inputVersion || !matches(e.judge, caller)) return rejected('stale or unbound Judge submission')
    if (e.resolution?.target === 'judge') {
      delete e.resolution.judgeMode
      delete e.resolution.judgeSessionId
    }
    if (result === 'REJECT') {
      const rejectedClaim = e.claim
      const rejectedJudge = e.judge
      e.previousClaim = rejectedClaim
      e.previousJudge = rejectedJudge
      e.judgment = {
        result, reason, claimId: rejectedClaim.id, judgeDispatchId: rejectedJudge.id,
        judgeSessionId: rejectedJudge.sessionId!, inputVersion: rejectedJudge.inputVersion,
      }
      delete e.claim
      delete e.judge
      e.phase = 'ready'
      e.inputVersion++
      if (e.resolution?.context) e.resolution = { target: 'actor', context: e.resolution.context, inputVersion: e.inputVersion }
      else delete e.resolution
      await this.state.put(ws, run, version, [change(e, 'judgment')])
      this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(rejectedJudge.sessionId!) })
      await this.subagents.retireJudge(run, rejectedJudge.sessionId!).catch(() => {})
      await this.drive(ws)
      return { ok: true, run, message: 'REJECT committed; Actor correction prepared' }
    }
    if (result === 'NEED_CONTEXT') {
      const judge = e.judge
      delete e.previousJudge
      delete e.previousClaim
      e.judgment = {
        result, reason, claimId: e.claim.id, judgeDispatchId: judge.id,
        judgeSessionId: judge.sessionId!, inputVersion: judge.inputVersion,
      }
      e.blockReason = `Judge NEED_CONTEXT: ${reason}`.slice(0, LIMITS.blockReasonMax)
      run.status = 'blocked'
      await this.state.put(ws, run, version, [change(e, 'judgment', 'blocked')])
      this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(judge.sessionId!) })
      await this.subagents.retireJudge(run, judge.sessionId!).catch(() => {})
      await this.targets.steerManager(run, `Workflow BLOCK: ${e.blockReason}\n请用 node_resume target=judge 提供完整当前补充；已保存 claim 不会丢失。`).catch(() => {})
      return { ok: true, run, message: 'NEED_CONTEXT committed; Manager context required' }
    }
    delete e.previousJudge
    delete e.previousClaim
    const judgeSessionId = e.judge.sessionId
    e.judgment = {
      result, reason, claimId: e.claim.id, judgeDispatchId: e.judge.id,
      judgeSessionId, inputVersion: e.judge.inputVersion,
    }
    const graphResult = e.claim.outcome === 'completed' ? 'PASS' : 'FAIL'
    const advanced = await this.advanceKnownResult(ws, row, graphResult, e.claim.handoff, 'judgment')
    this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(judgeSessionId) })
    await this.subagents.retireJudge(run, judgeSessionId).catch(() => {})
    // 后继只由Judge的精确、安全turn settlement驱动，绝不在自身提交Turn里drain。
    return advanced
  }

  /** Host 必须退出append回调再调用；caller只带该turn/end对应Turn的消息ID。 */
  async handleTurnEnded(ws: string, caller: ClaimCaller): Promise<EngineOutcome | undefined> {
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running') return
    let e = row.execution
    if (e.phase === 'ready' && e.predecessorId) {
      const predecessor = await this.state.execution(ws, e.predecessorId)
      if (!predecessor || !matches(predecessor.judge, caller) || predecessor.judge!.settled) return
      if (!await this.subagents.safeToInspect(caller.sessionId)) { await this.blockRow(ws, row, 'Judge/known tools not safely closed'); return }
      const fresh = await this.state.get(ws)
      if (!fresh || fresh.version !== row.version || fresh.execution.executionId !== e.executionId) return
      predecessor.judge!.settled = true
      await this.state.put(ws, fresh.run, fresh.version, [change(predecessor)])
      await this.drive(ws)
      return
    }
    const actor = matches(e.dispatch, caller) && !e.dispatch!.settled
    const judge = matches(e.judge, caller) && !e.judge!.settled
    if (!actor && !judge) return
    const safe = await this.subagents.safeToInspect(caller.sessionId)
    const fresh = await this.stillCurrent(ws, e, row.version)
    if (!fresh) return
    e = fresh.execution
    if (!safe) { await this.blockRow(ws, fresh, 'Actor/Judge or known tools not safely closed'); return }
    if (actor && e.phase === 'checking') {
      e.dispatch!.settled = true
      await this.state.put(ws, fresh.run, fresh.version, [change(e)])
      await this.drive(ws)
    } else if (actor && e.phase === 'working') await this.blockRow(ws, fresh, 'actor-turn-ended-without-result')
    else if (judge && e.phase === 'checking') await this.blockRow(ws, fresh, 'judge turn ended without judge_claim')
  }
  async handleBlock(ws: string, token: string, reason: string, caller: ClaimCaller): Promise<EngineOutcome> {
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'running' || row.execution.nodeToken !== token) return rejected('no current running Node/token')
    reason = reason.trim()
    if (!reason || reason.length > LIMITS.blockReasonMax) return rejected('invalid block reason')
    const control = row.run.managerSessionId === caller.sessionId && this.nodeAt(row.run, topFrame(row.run))?.execution.role !== 'manager'
    if (!control && (row.execution.phase !== 'working' || !matches(row.execution.dispatch, caller))) return rejected('unbound dispatch')
    await this.blockRow(ws, row, reason)
    return { ok: true, run: row.run, message: 'blocked' }
  }
  async handleRestartReconcile(): Promise<void> {
    for (const row of await this.state.listRuns()) {
      if (row.run.status === 'completed' || row.run.status === 'terminated' || row.execution.restartPending) continue
      try {
        row.execution.restartPending = true
        if (row.run.status === 'running') await this.blockRow(row.workspaceKey, row, 'host restarted; saved work retained; Manager resume must confirm the recovery target', 'interrupted')
        else await this.state.put(row.workspaceKey, row.run, row.version, [change(row.execution, 'interrupted')])
      } catch (error) { this.traceWarn?.(`restart reconciliation failed: ${String(error)}`) }
    }
  }
  async handleResume(ws: string, token: string, context: string, caller: string, target: ResumeTarget = 'auto'): Promise<EngineOutcome> {
    context = context.trim()
    if (!context || context.length > LIMITS.resolutionMax || !['auto', 'actor', 'judge'].includes(target)) return rejected('invalid resolution context/target')
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'blocked' || row.execution.nodeToken !== token) return rejected('node_resume requires the current BLOCK/token')
    const { run, execution: e, version } = row
    if (caller !== run.managerSessionId) return rejected('node_resume is Manager-only')
    const node = this.nodeAt(run, topFrame(run))
    if (!node || e.phase === 'exited') return rejected('resume target is not applicable to this execution')
    let recoveredPredecessor: NodeExecution | undefined
    if (e.phase === 'ready' && e.predecessorId) {
      const predecessor = await this.state.execution(ws, e.predecessorId)
      if (!await this.sameRow(ws, row)) return rejected('stale resume request after predecessor inspection')
      if (!predecessor?.judge?.settled) {
        const terminalAccepted = predecessor?.phase === 'exited' && predecessor.successorId === e.executionId
          && predecessor.judgment?.result === 'ACCEPT' && predecessor.judgment.claimId === predecessor.claim?.id
          && predecessor.judgment.judgeDispatchId === predecessor.judge?.id
        if (!e.restartPending || !terminalAccepted) return rejected('predecessor Judge is not safely settled; keep BLOCK until its activity is resolved')
        predecessor.judge!.settled = true
        recoveredPredecessor = predecessor
      }
    }
    if (node.execution.type === 'child-workflow') {
      if (target !== 'auto' || e.phase !== 'ready' || e.child) return rejected('Child resume requires an unentered ready caller and target=auto')
      e.inputVersion++
      e.resolution = { target: 'child', context, inputVersion: e.inputVersion }
      e.restartPending = false
      e.blockReason = null
      e.nodeToken = newNodeToken()
      topFrame(run).nodeToken = e.nodeToken
      run.status = 'running'
      run.blockReason = null
      await this.state.put(ws, run, version, [change(e, 'manager-context', 'resumed'), ...(recoveredPredecessor ? [change(recoveredPredecessor)] : [])])
      await this.drive(ws)
      return { ok: true, run, message: 'Child caller resume committed; driver invoked' }
    }
    if (node.execution.type !== 'actor-task') return rejected('Program recovery requires node_run_program or node_resolve_program')
    const resolvedTarget: Exclude<ResumeTarget, 'auto'> = target === 'auto'
      ? e.phase === 'checking' && e.claim && e.dispatch?.settled && e.judgment?.result !== 'ACCEPT' ? 'judge' : 'actor'
      : target
    const role = node.execution.role!
    let replaceRole = false
    if (role !== 'manager' && run.roleActors[role] && (resolvedTarget === 'actor' || !e.dispatch?.settled)) {
      const sessionId = run.roleActors[role]
      const safe = await this.subagents.safeToInspect(sessionId)
      if (!await this.sameRow(ws, row)) return rejected('stale resume request after Role safety inspection')
      if (!safe) {
        const activity = await this.actorActivity(sessionId)
        if (!await this.sameRow(ws, row)) return rejected('stale resume request after Role activity inspection')
        if (activity !== 'unknown') return rejected('previous Role execution is not safely closed')
        if (resolvedTarget === 'actor') {
          const availability = await this.subagents.roleSessionAvailability(sessionId)
          if (!await this.sameRow(ws, row)) return rejected('stale resume request after Role Session inspection')
          replaceRole = availability === 'missing'
        }
      }
    }
    const oldJudge = e.judge
    const oldJudgeSessionId = oldJudge?.sessionId
    let judgeMode: 'followup' | 'fresh' | undefined
    let judgeSessionId: string | undefined
    if (resolvedTarget === 'judge') {
      if (e.phase !== 'checking' || !e.claim || !e.dispatch || e.judgment?.result === 'ACCEPT') return rejected('judge resume requires an effective claim without a business conclusion')
      // auto never takes this branch while unsettled; explicit target=judge is the Manager's takeover decision.
      if (!e.dispatch.settled) e.dispatch.settled = true
      const sameJudgeNeedContext = oldJudge !== undefined && e.judgment?.result === 'NEED_CONTEXT'
        && e.judgment.claimId === e.claim.id && e.judgment.inputVersion === e.inputVersion
        && e.judgment.judgeDispatchId === oldJudge.id && e.judgment.judgeSessionId === oldJudge.sessionId
      const restartRecovery = e.restartPending
      const historicalNeedContext = e.judgment?.result === 'NEED_CONTEXT' && e.previousJudge?.claimId === e.claim.id
        && e.judgment.judgeDispatchId === e.previousJudge.id && e.judgment.judgeSessionId === e.previousJudge.sessionId
      const unjudgedCurrent = oldJudge !== undefined && (e.judgment === undefined
        || e.judgment.claimId !== e.claim.id || e.judgment.inputVersion !== e.inputVersion)
      const judgeToContinue = sameJudgeNeedContext ? oldJudge
        : historicalNeedContext && !oldJudge ? e.previousJudge
          : restartRecovery && unjudgedCurrent ? oldJudge : undefined
      if ((restartRecovery || sameJudgeNeedContext) && judgeToContinue) {
        const availability = await this.subagents.judgeSessionAvailability(judgeToContinue.sessionId)
        if (!await this.sameRow(ws, row)) return rejected('stale judge resume request after Judge Session inspection')
        if (availability !== 'missing') {
          const safe = await this.subagents.safeToInspect(judgeToContinue.sessionId)
          if (!await this.sameRow(ws, row)) return rejected('stale judge resume request after Judge safety inspection')
          if (!safe) {
            const activity = await this.actorActivity(judgeToContinue.sessionId)
            if (!await this.sameRow(ws, row)) return rejected('stale judge resume request after Judge activity inspection')
            if (!restartRecovery || activity !== 'unknown') return rejected('previous Judge turn is not safely closed')
          }
          judgeMode = 'followup'
          judgeSessionId = judgeToContinue.sessionId
        } else {
          try {
            if (!await this.drainJudgeAndRevalidate(ws, row, oldJudge ?? judgeToContinue)) return rejected('stale judge resume request after missing Judge drain')
          } catch (error) { return rejected(`Judge drain failed: ${error instanceof Error ? error.message : String(error)}`) }
          judgeMode = 'fresh'
        }
      } else {
        const judgeToDrain = oldJudge ?? (e.previousJudge?.claimId === e.claim.id ? e.previousJudge : undefined)
        if (judgeToDrain) {
          try {
            if (!await this.drainJudgeAndRevalidate(ws, row, judgeToDrain)) return rejected('stale judge resume request after Judge drain')
          } catch (error) { return rejected(`Judge drain failed: ${error instanceof Error ? error.message : String(error)}`) }
        }
        judgeMode = 'fresh'
      }
      if (sameJudgeNeedContext && oldJudge) e.previousJudge = oldJudge
      delete e.judge
    } else {
      const acceptedFailureWithoutEdge = e.phase === 'settling' && e.claim?.outcome === 'failed'
        && e.judgment?.result === 'ACCEPT' && node.onFail === undefined
      const canReturnActor = e.phase === 'ready' || (e.phase === 'working' && !e.claim)
        || (e.phase === 'checking' && !!e.claim && e.judgment?.result !== 'ACCEPT') || acceptedFailureWithoutEdge
      if (!canReturnActor) return rejected('actor resume would overwrite a transferable conclusion')
      const relatedClaimId = e.claim?.id ?? e.previousClaim?.id
      const judgeToDrain = oldJudge ?? (e.previousJudge?.claimId === relatedClaimId ? e.previousJudge : undefined)
      if (judgeToDrain) {
        try {
          if (!await this.drainJudgeAndRevalidate(ws, row, judgeToDrain)) return rejected('stale actor resume request after Judge drain')
        } catch (error) { return rejected(`Judge drain failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (e.claim) {
        const returnedClaim = e.claim
        const currentFeedback = e.judgment?.result === 'NEED_CONTEXT' && e.judgment.claimId === returnedClaim.id && e.judgment.inputVersion === e.inputVersion
          && oldJudge !== undefined && e.judgment.judgeDispatchId === oldJudge.id && e.judgment.judgeSessionId === oldJudge.sessionId
        const historicalFeedback = e.judgment?.claimId === returnedClaim.id && e.judgment.inputVersion < e.inputVersion
          && e.previousJudge !== undefined && e.judgment.judgeDispatchId === e.previousJudge.id
          && e.judgment.judgeSessionId === e.previousJudge.sessionId
        e.previousClaim = returnedClaim
        if (currentFeedback && oldJudge) e.previousJudge = oldJudge
        else if (!historicalFeedback) { delete e.judgment; delete e.previousJudge }
      }
      delete e.claim
      delete e.judge
      e.phase = 'ready'
    }
    if (replaceRole) {
      delete run.roleActors[role]
      // Fresh replacement has no prior cross-Node context to compact; same-execution correction must not compact it later.
      e.roleBoundaryPrepared = true
    }
    e.inputVersion++
    e.resolution = {
      target: resolvedTarget, context, inputVersion: e.inputVersion,
      ...(resolvedTarget === 'judge' ? { judgeMode: judgeMode!, ...(judgeSessionId ? { judgeSessionId } : {}) } : {}),
    }
    if (resolvedTarget === 'judge') {
      e.judge = {
        id: newNodeToken(), sessionId: judgeSessionId ?? newNodeToken(), claimId: e.claim!.id,
        inputVersion: e.inputVersion, settled: false,
      }
    }
    e.restartPending = false
    e.blockReason = null
    e.nodeToken = newNodeToken()
    topFrame(run).nodeToken = e.nodeToken
    run.status = 'running'
    run.blockReason = null
    await this.state.put(ws, run, version, [
      change(e, 'manager-context', 'resumed', ...(resolvedTarget === 'judge' ? ['judge-arranged' as const] : [])),
      ...(recoveredPredecessor ? [change(recoveredPredecessor)] : []),
    ])
    if (oldJudgeSessionId) await this.subagents.retireJudge(run, oldJudgeSessionId).catch(() => {})
    await this.drive(ws)
    return { ok: true, run, message: `resume ${resolvedTarget} committed; driver invoked` }
  }
  async handleRespawnJudge(ws: string, token: string, reason = '', caller = ''): Promise<EngineOutcome> {
    reason = reason.trim()
    if (reason.length > LIMITS.reasonMax) return rejected(`reason exceeds ${LIMITS.reasonMax} characters`)
    const row = await this.state.get(ws)
    if (!row || !['running', 'blocked'].includes(row.run.status) || row.execution.nodeToken !== token) return rejected('judge_respawn requires the current Node/token')
    const { run, execution: e, version } = row
    if (caller !== run.managerSessionId) return rejected('judge_respawn is Manager-only')
    if (this.nodeAt(run, topFrame(run))?.execution.type !== 'actor-task' || e.phase !== 'checking' || !e.claim
      || !e.dispatch?.settled || e.judgment?.result === 'ACCEPT') return rejected('judge_respawn requires an effective settled claim without a business conclusion')
    const oldJudge = e.judge
    let committedVersion = version
    try {
      const cwd = await this.cwdResolver(run)
      const judgeToDrain = oldJudge ?? (e.previousJudge?.claimId === e.claim.id ? e.previousJudge : undefined)
      if (!await this.drainJudgeAndRevalidate(ws, row, judgeToDrain)) return rejected('stale respawn request after Judge drain')
      const currentFeedback = oldJudge !== undefined && e.judgment?.result === 'NEED_CONTEXT'
        && e.judgment.claimId === e.claim.id && e.judgment.inputVersion === e.inputVersion
        && e.judgment.judgeDispatchId === oldJudge.id && e.judgment.judgeSessionId === oldJudge.sessionId
      e.inputVersion++
      if (currentFeedback && oldJudge) e.previousJudge = oldJudge
      e.resolution = {
        target: 'judge', inputVersion: e.inputVersion, judgeMode: 'fresh',
        ...(e.resolution?.context ? { context: e.resolution.context } : {}),
        decision: reason || 'Manager requested Judge respawn',
      }
      e.restartPending = false
      e.judge = { id: newNodeToken(), sessionId: newNodeToken(), claimId: e.claim.id, inputVersion: e.inputVersion, settled: false }
      e.blockReason = null
      run.status = 'running'
      run.blockReason = null
      await this.state.put(ws, run, version, [change(e, 'judge-respawned', 'judge-arranged')])
      committedVersion = version + 1
      if (!await this.stillCurrent(ws, e, committedVersion)) return rejected('stale respawn request')
      const sent = await this.subagents.startJudge(run, this.judgePacket(run, e, cwd))
      const fresh = await this.stillCurrent(ws, e, committedVersion)
      if (!fresh) { await this.subagents.retireJudge(run, sent.judgeSessionId).catch(() => {}); return rejected('stale respawn result') }
      if (fresh.execution.judge?.id !== e.judge.id || sent.judgeSessionId !== e.judge.sessionId || !sent.messageId) throw new WorkflowError('Host returned mismatched Judge identity')
      fresh.execution.judge.messageId = sent.messageId
      await this.state.put(ws, fresh.run, fresh.version, [change(fresh.execution)])
      return { ok: true, run: fresh.run, message: `Judge respawn committed${reason ? `: ${reason}` : ''}` }
    } catch (error) {
      await this.dispatchFault(ws, e, error, committedVersion)
      return rejected(`Judge respawn failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async handleRunProgram(ws: string, token: string, supplied: Record<string, unknown>, caller: string): Promise<EngineOutcome> {
    const row = await this.state.get(ws)
    if (!row || !['running', 'blocked'].includes(row.run.status) || row.execution.nodeToken !== token) return rejected('node_run_program requires the current Node/token')
    const { run, execution: e } = row
    if (caller !== run.managerSessionId) return rejected('node_run_program is Manager-only')
    const node = this.nodeAt(run, topFrame(run))
    if (!node || node.execution.type !== 'builtin-program' || !['ready', 'working', 'settling'].includes(e.phase)) return rejected('current execution is not a runnable Program')
    if (run.status === 'running' && e.program && !e.program.result) return rejected('Program invocation is already in progress')
    let parameters: Record<string, unknown>
    try { parameters = this.programParameters(node, supplied) } catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    if (run.status === 'blocked') {
      e.nodeToken = newNodeToken()
      topFrame(run).nodeToken = e.nodeToken
    }
    e.program = { id: newNodeToken(), parameters }
    e.phase = 'working'
    e.restartPending = false
    e.blockReason = null
    run.status = 'running'
    run.blockReason = null
    await this.state.put(ws, run, row.version, [change(e, 'program-arranged')])
    const arrangedVersion = row.version + 1
    const invocationId = e.program.id
    let result: ProgramResult
    try {
      const cwd = await this.cwdResolver(run)
      const current = await this.state.get(ws)
      if (!current || current.version !== arrangedVersion || current.run.status !== 'running'
        || current.execution.executionId !== e.executionId || current.execution.program?.id !== invocationId) return rejected('stale Program invocation before effect')
      result = await this.programs.run(run, node.execution.programId!, parameters, cwd)
    } catch (error) {
      const current = await this.state.get(ws)
      if (current?.version === arrangedVersion && current.run.status === 'running'
        && current.execution.executionId === e.executionId && current.execution.program?.id === invocationId) {
        await this.blockRow(ws, current, `Program result unknown; inspect before retry or resolution: ${error instanceof Error ? error.message : String(error)}`)
      }
      return rejected('Program result is unknown; Manager inspection required')
    }
    const current = await this.state.get(ws)
    if (!current || current.version !== arrangedVersion || current.run.status !== 'running'
      || current.execution.executionId !== e.executionId || current.execution.program?.id !== invocationId) return rejected('stale Program result ignored')
    let normalized: NonNullable<NonNullable<NodeExecution['program']>['result']>
    try { normalized = this.effectiveProgramResult(result, current.execution.input) } catch (error) {
      await this.blockRow(ws, current, `Program result unknown; inspect before retry or resolution: ${error instanceof Error ? error.message : String(error)}`)
      return rejected('invalid Program result; Manager inspection required')
    }
    current.execution.program!.result = normalized
    if (normalized.kind === 'ERROR') {
      current.execution.phase = 'settling'
      await this.blockRow(ws, current, `Program ERROR: ${normalized.reason}`, 'program-result')
      return { ok: true, run: current.run, message: current.execution.blockReason! }
    }
    try {
      const advanced = await this.advanceKnownResult(ws, current, normalized.kind, normalized.handoff, 'program-result')
      if (advanced.ok && advanced.run.status === 'running') await this.drive(ws)
      return advanced
    } catch (error) {
      const after = await this.state.get(ws)
      if (after?.version === arrangedVersion && after.run.status === 'running'
        && after.execution.executionId === e.executionId && after.execution.program?.id === invocationId) {
        delete after.execution.program.result
        await this.blockRow(ws, after, `Program result commit unknown; inspect before retry or resolution: ${error instanceof Error ? error.message : String(error)}`)
      }
      return rejected('Program result commit failed; Manager inspection required')
    }
  }
  async handleResolveProgram(ws: string, token: string, result: 'PASS' | 'FAIL', reason: string, caller: string): Promise<EngineOutcome> {
    reason = reason.trim()
    if (!reason || reason.length > LIMITS.blockReasonMax || !['PASS', 'FAIL'].includes(result)) return rejected('invalid Program resolution')
    const row = await this.state.get(ws)
    if (!row || row.run.status !== 'blocked' || row.execution.nodeToken !== token) return rejected('node_resolve_program requires the current BLOCK/token')
    if (caller !== row.run.managerSessionId) return rejected('node_resolve_program is Manager-only')
    const node = this.nodeAt(row.run, topFrame(row.run))
    if (node?.execution.type !== 'builtin-program' || !row.execution.program || !['working', 'settling'].includes(row.execution.phase)) return rejected('current execution has no Program result to resolve')
    const prior = row.execution.program.result
    const handoff = prior && prior.kind !== 'ERROR' ? prior.handoff : row.execution.input
    row.execution.program.result = { kind: result, handoff, reason }
    row.execution.blockReason = null
    row.execution.restartPending = false
    row.run.status = 'running'
    row.run.blockReason = null
    const advanced = await this.advanceKnownResult(ws, row, result, handoff, 'program-resolved')
    if (advanced.ok && advanced.run.status === 'running') await this.drive(ws)
    return advanced
  }
  async handleSetRoleModel(ws: string, role: string, provider: string, model: string, caller: string): Promise<EngineOutcome> {
    const row = await this.state.get(ws)
    if (!row || row.run.status === 'completed' || row.run.status === 'terminated') return rejected('workflow_set_role_model requires the current active Run')
    if (caller !== row.run.managerSessionId) return rejected('workflow_set_role_model is Manager-only')
    if (role !== 'judge' && !(role in row.run.definitionSnapshot.roles)) return rejected(`unknown role "${role}"`)
    let route
    try { route = normalizeModelRoute(provider, model) } catch (error) { return rejected(error instanceof Error ? error.message : String(error)) }
    const existing = row.run.modelOverrides[role]
    if (existing?.provider === route.provider && existing.modelId === route.modelId) return { ok: true, run: row.run, message: 'model override already applied' }
    const mapped = role === 'judge' ? undefined : row.run.roleActors[role]
    const currentNode = this.nodeAt(row.run, topFrame(row.run))
    const replacesCurrentRole = mapped && currentNode?.execution.type === 'actor-task' && currentNode.execution.role === role
    if (replacesCurrentRole && row.run.status === 'running' && row.execution.phase === 'working') return rejected('current active Role must node_block before model replacement')
    if (mapped) {
      const safe = await this.subagents.safeToInspect(mapped)
      if (!await this.sameRow(ws, row)) return rejected('stale model replacement after Role safety inspection')
      if (!safe) {
        const activity = await this.actorActivity(mapped)
        if (!await this.sameRow(ws, row)) return rejected('stale model replacement after Role activity inspection')
        if (activity !== 'unknown') return rejected('active actor cannot be replaced')
      }
    }
    row.run.modelOverrides[role] = route
    if (mapped) delete row.run.roleActors[role]
    if (replacesCurrentRole) row.execution.roleBoundaryPrepared = true
    await this.state.put(ws, row.run, row.version, [change(row.execution, 'model-changed')])
    this.trace(row.run, 'MODEL', { workflow: row.execution.workflowId, role, provider: jsonField(route.provider, LIMITS.providerMax), model: jsonField(route.modelId, LIMITS.modelIdMax) })
    return { ok: true, run: row.run, message: `model override saved for ${role}` }
  }
  async handleReset(ws: string, caller: string): Promise<EngineOutcome> {
    const row = await this.state.get(ws)
    if (!row || (row.run.status !== 'running' && row.run.status !== 'blocked')) return rejected('reset requires the current active Run')
    if (caller !== row.run.managerSessionId) return rejected('reset is Manager-only')
    const judgeSessionId = row.execution.judge?.sessionId
    row.run.status = 'terminated'
    row.run.blockReason = TERMINATED_REASON
    row.execution.restartPending = false
    row.execution.blockReason = TERMINATED_REASON
    row.execution.nodeToken = newNodeToken()
    topFrame(row.run).nodeToken = row.execution.nodeToken
    await this.state.put(ws, row.run, row.version, [change(row.execution, 'terminated')])
    if (judgeSessionId) await this.subagents.retireJudge(row.run, judgeSessionId).catch(() => {})
    this.traceWarned.delete(row.run.runId)
    return { ok: true, run: row.run, message: `${TERMINATED_REASON}; saved Run history retained` }
  }
}
