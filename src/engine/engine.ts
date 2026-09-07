/** 唯一工作单 Runtime。SQLite CAS 保护短写；Host 调用始终在事务/锁之外。 */
import type { WorkflowConfig, NodeClaim, RunState, CallFrame, ClaimCaller, PendingCorrection, NodeContextBoundary, NodeExecution, ExecutionChange, NodeExecutionEvent, ExecutionDispatch } from '../types.ts'
import { WorkflowError, LIMITS, normalizeNodeClaim } from '../types.ts'
import { newNodeToken, topFrame } from '../state/invariants.ts'
import { validateAndNormalize, computeDefinitionHash } from '../catalog/validate.ts'
import { SUBMISSION_CONSTRAINT } from './texts.ts'
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
  previousRejection?: PendingCorrection
  cwd: string
  judgeSessionId: string
}
export interface SubagentHost {
  ensureRoleActor(run: RunState, roleKey: string, initialText: string): Promise<{ childId: string; messageId: string }>
  startJudge(run: RunState, input: JudgeSpawnInput): Promise<{ judgeSessionId: string; messageId: string }>
  followupJudge(run: RunState, judgeSessionId: string, text: string): Promise<void>
  judgeSessionExists(judgeSessionId: string): Promise<boolean>
  retireJudge(run: RunState, judgeSessionId: string): Promise<void>
  drainJudge(run: RunState, judgeSessionId: string): Promise<void>
  compactRoleActor(run: RunState, roleKey: string): Promise<{ ok: boolean; detail?: string }>
  /** 必须覆盖普通工具 tail、已知后台写任务及未收口后代；unknown=false。 */
  safeToInspect(sessionId: string): Promise<boolean>
}
export interface ProgramHost {
  run(run: RunState, programId: string, parameters: Record<string, unknown>, cwd: string): Promise<{ kind: 'PASS' | 'FAIL' | 'ERROR'; reason?: string; details?: unknown }>
}
export interface RuntimeRow { run: RunState; execution: NodeExecution; version: number }
export interface StateHost {
  get(workspaceKey: string): Promise<RuntimeRow | undefined>
  put(workspaceKey: string, run: RunState, expectedVersion: number, changes: ExecutionChange[]): Promise<void>
  create(workspaceKey: string, run: RunState, execution: NodeExecution): Promise<number>
  remove(workspaceKey: string): Promise<void>
  listRuns(): Promise<Array<RuntimeRow & { workspaceKey: string }>>
  execution(workspaceKey: string, executionId: string): Promise<NodeExecution | undefined>
  events(workspaceKey: string, executionId: string, after?: number, limit?: number): Promise<NodeExecutionEvent[]>
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
export function correctionEvidence(pc: PendingCorrection): string {
  return `[judge rejection]\n${pc.judgeReason}\n\n[previous claim]\noutcome: ${pc.previousClaim.outcome}\nhandoff: ${pc.previousClaim.handoff}`
}
const rejected = (reason: string): EngineOutcome => ({ ok: false, reason })
const unsupported = (ticket: string): EngineOutcome => rejected(`refact integration: not connected until ${ticket}; no legacy fallback`)
const matches = (dispatch: ExecutionDispatch | undefined, caller: ClaimCaller): boolean =>
  dispatch?.sessionId === caller.sessionId && dispatch.messageId !== undefined && caller.turnUserMessageIds.has(dispatch.messageId)
const change = (execution: NodeExecution, ...events: NodeExecutionEvent['type'][]): ExecutionChange => ({ execution, expectedRevision: execution.revision, events })

export class WorkflowEngine {
  cwdResolver: (run: RunState) => Promise<string> = async () => { throw new WorkflowError('cwd resolver is not wired') }
  actorActivity: (sessionId: string) => Promise<'active' | 'idle' | 'unknown'> = async () => 'unknown'
  managerRoute: (sessionId: string) => Promise<{ provider?: string; model?: string }> = async () => ({})
  frozenRoute: { provider?: string; model?: string } = {}
  traceWarn: ((message: string) => void) | undefined
  private readonly targets: DispatchTargets
  private readonly subagents: SubagentHost
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
  constructor(targets: DispatchTargets, subagents: SubagentHost, _programs: ProgramHost, state: StateHost) {
    this.targets = targets
    this.subagents = subagents
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
    return {
      runId: newNodeToken(), managerSessionId, catalogWorkflowId: workflowId,
      definitionHash: computeDefinitionHash(snapshot), definitionSnapshot: snapshot,
      status: 'running', callStack: [{ workflowId, nodeId: snapshot.workflow.startNode, nodeToken: newNodeToken() }],
      currentExecutionId: newNodeToken(), roleActors: {}, modelOverrides: {}, blockReason: null,
    }
  }
  private newExecution(run: RunState, input: string, visit: number, predecessorId?: string): NodeExecution {
    const frame = topFrame(run)
    return { executionId: run.currentExecutionId, runId: run.runId, ...frame, visit, revision: 0,
      input, phase: 'ready', inputVersion: 1, blockReason: null, enteredAt: new Date().toISOString(),
      ...(predecessorId === undefined ? {} : { predecessorId }) }
  }
  async status(ws: string) {
    const row = await this.state.get(ws)
    if (!row) return { ok: true, status: 'no active run' }
    const { run, execution } = row
    return { ok: true, status: {
      runId: run.runId, catalogWorkflowId: run.catalogWorkflowId, status: run.status,
      callStack: run.callStack, currentFrame: run.callStack.at(-1) ?? null,
      roleActors: run.roleActors, modelOverrides: run.modelOverrides,
      execution, blockReason: execution.blockReason ?? run.blockReason,
      handoffPreview: execution.claim?.handoff.slice(0, 500) ?? null,
      finalHandoff: run.status === 'completed' ? execution.claim?.handoff ?? null : null,
    } }
  }
  async startRun(ws: string, run: RunState, configPath?: string, extraText = ''): Promise<EngineOutcome> {
    if (extraText.length > LIMITS.handoffMax) return rejected(`root input exceeds ${LIMITS.handoffMax} characters`)
    // T7 接通前明确拒绝整份含未支持执行类型的流程，绝不启动旧路径。
    if (Object.values(run.definitionSnapshot.workflow.nodes).some(n => n.execution.type !== 'actor-task')) return unsupported('T7 Program/Child')
    const previous = await this.state.get(ws)
    if (previous && previous.run.status !== 'completed') return rejected(`workspace already has a ${previous.run.status} run`)
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
        if (!predecessor?.judge?.settled) return
      }
      const node = this.nodeAt(run, topFrame(run))!
      if (node.execution.type !== 'actor-task') { await this.blockRow(ws, row, 'T7 execution type not connected'); return }
      const role = node.execution.role!
      let committedVersion = version
      try {
        e.phase = 'working'
        e.dispatch = { id: newNodeToken(), settled: false, ...(role === 'manager' ? { sessionId: run.managerSessionId } : run.roleActors[role] ? { sessionId: run.roleActors[role] } : {}) }
        e.boundary = { dispatchedAt: Date.now(), managerFromSeq: this.targets.managerSessionSeq(run), ...(role === 'manager' ? {} : e.dispatch.sessionId ? { executorSessionId: e.dispatch.sessionId } : {}) }
        await this.state.put(ws, run, version, [change(e, 'actor-arranged')])
        committedVersion = version + 1
        const arrangedVersion = committedVersion
        if (role !== 'manager' && run.roleActors[role]) {
          if (!await this.subagents.safeToInspect(run.roleActors[role])) throw new WorkflowError('previous Role execution is not safely closed')
          if (!await this.stillCurrent(ws, e, arrangedVersion)) return
          const compact = await this.subagents.compactRoleActor(run, role)
          if (!compact.ok) throw new WorkflowError(`node-boundary compact failed: ${compact.detail ?? 'unknown'}`)
          if (!await this.stillCurrent(ws, e, arrangedVersion)) return
        }
        const text = `[handoff]\n${e.input}\n\n[instruction]\n${node.execution.instruction ?? ''}\n\n[criteria]\n${String(node.checker?.config.criteria ?? '')}${SUBMISSION_CONSTRAINT}`
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
    if (e.phase !== 'checking' || !e.claim || !e.dispatch?.settled || e.judge) return
    // checking 不等于Judge已经运行：只有精确 Actor 收口入口能置settled。
    let committedVersion = version
    try {
      const node = this.nodeAt(run, topFrame(run))!
      const cwd = await this.cwdResolver(run)
      if (!await this.stillCurrent(ws, e, version)) return
      e.judge = { id: newNodeToken(), sessionId: newNodeToken(), claimId: e.claim.id, inputVersion: e.inputVersion, settled: false }
      await this.state.put(ws, run, version, [change(e, 'judge-arranged')])
      committedVersion = version + 1
      const sent = await this.subagents.startJudge(run, {
        nodeToken: e.nodeToken, instruction: node.execution.instruction ?? '', criteria: String(node.checker?.config.criteria ?? ''),
        input: e.input, boundary: e.boundary!, claim: { outcome: e.claim.outcome, handoff: e.claim.handoff }, cwd, judgeSessionId: e.judge.sessionId!,
      })
      const fresh = await this.stillCurrent(ws, e, version + 1)
      if (!fresh) { await this.subagents.retireJudge(run, e.judge.sessionId!).catch(() => {}); return }
      if (sent.judgeSessionId !== e.judge.sessionId || !sent.messageId) throw new WorkflowError('Host returned mismatched Judge identity')
      fresh.execution.judge!.messageId = sent.messageId
      await this.state.put(ws, fresh.run, fresh.version, [change(fresh.execution)])
    } catch (error) { await this.dispatchFault(ws, e, error, committedVersion) }
  }
  private async stillCurrent(ws: string, e: NodeExecution, version: number): Promise<RuntimeRow | undefined> {
    const row = await this.state.get(ws)
    return row?.run.status === 'running' && row.version === version && row.execution.executionId === e.executionId
      && row.execution.dispatch?.id === e.dispatch?.id && row.execution.claim?.id === e.claim?.id ? row : undefined
  }
  private async dispatchFault(ws: string, e: NodeExecution, error: unknown, committedVersion: number): Promise<void> {
    const row = await this.state.get(ws)
    // 本地候选安排可能尚未提交；只认最后成功提交的Run/visit/CAS版本。
    if (row?.run.status !== 'running' || row.run.runId !== e.runId || row.execution.executionId !== e.executionId || row.version !== committedVersion) return
    await this.blockRow(ws, row, `dispatch fault: ${error instanceof Error ? error.message : String(error)}`)
  }
  private async blockRow(ws: string, row: RuntimeRow, reason: string): Promise<void> {
    row.run.status = 'blocked'
    row.execution.blockReason = reason.slice(0, LIMITS.blockReasonMax)
    await this.state.put(ws, row.run, row.version, [change(row.execution, 'blocked')])
    this.trace(row.run, 'BLOCK', { workflow: row.execution.workflowId, node: row.execution.nodeId, reason: jsonField(row.execution.blockReason, LIMITS.blockReasonMax) })
    await this.targets.steerManager(row.run, `Workflow BLOCK: ${row.execution.blockReason}\n材料已保存；refact 中恢复路径待 T6 接通。`).catch(() => {})
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
    if (e.nodeToken !== token || e.phase !== 'checking' || !e.claim || !e.judge || e.judgment
      || e.judge.claimId !== e.claim.id || e.judge.inputVersion !== e.inputVersion || !matches(e.judge, caller)) return rejected('stale or unbound Judge submission')
    if (result !== 'ACCEPT') return unsupported('T4 REJECT/NEED_CONTEXT')
    const node = this.nodeAt(run, topFrame(run))!
    const target = e.claim.outcome === 'completed' ? node.onPass : node.onFail
    if (!target) return unsupported('T7 FAIL without onFail')
    e.judgment = { result, reason, claimId: e.claim.id, judgeDispatchId: e.judge.id }
    e.phase = 'exited'; e.exitedAt = new Date().toISOString()
    const changes = [change(e, 'judgment', 'exited')]
    if (target === 'END') { run.status = 'completed'; run.callStack = [] }
    else {
      run.currentExecutionId = newNodeToken()
      run.callStack = [{ workflowId: e.workflowId, nodeId: target, nodeToken: newNodeToken() }]
      const successor = this.newExecution(run, e.claim.handoff, e.visit + 1, e.executionId)
      e.successorId = successor.executionId
      changes.push({ execution: successor, expectedRevision: null, events: ['entered'] })
    }
    // 判定/前驱离开/后继输入/进入事件/Run指针一次提交，绝不先消费Judge资格。
    await this.state.put(ws, run, version, changes)
    this.trace(run, 'JUDGE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result, reason: jsonField(reason, LIMITS.reasonMax), judge: shortId(e.judge.sessionId!) })
    this.trace(run, 'ROUTE', { workflow: e.workflowId, node: e.nodeId, token: shortId(e.nodeToken), result: e.claim.outcome === 'completed' ? 'PASS' : 'FAIL', target })
    if (run.status === 'completed') this.traceWarned.delete(run.runId)
    await this.subagents.retireJudge(run, e.judge.sessionId!).catch(() => {})
    if (run.status === 'completed') await this.targets.steerManager(run, `workflow "${run.catalogWorkflowId}" 已完成（run ${run.runId}）。\n\n[handoff]\n${e.claim.handoff}`).catch(() => {})
    // 后继只由Judge的精确、安全turn settlement驱动，绝不在自身提交Turn里drain。
    return { ok: true, run, message: 'ACCEPT committed' }
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
      if (row.run.status !== 'running') continue
      try { await this.blockRow(row.workspaceKey, row, 'host restarted; saved work retained; T6 recovery not connected') }
      catch (error) { this.traceWarn?.(`restart reconciliation failed: ${String(error)}`) }
    }
  }
  async handleResume(_ws: string, _token: string, _context: string, _caller: string): Promise<EngineOutcome> { return unsupported('T6 resume') }
  async handleRespawnJudge(_ws: string, _token: string, _reason?: string, _caller?: string): Promise<EngineOutcome> { return unsupported('T4/T6 Judge rebuild') }
  async handleRunProgram(_ws: string, _token: string, _parameters: Record<string, unknown>, _caller: string): Promise<EngineOutcome> { return unsupported('T7 Program') }
  async handleResolveProgram(_ws: string, _token: string, _result: 'PASS' | 'FAIL', _reason: string, _caller: string): Promise<EngineOutcome> { return unsupported('T7 Program resolution') }
  async handleSetRoleModel(_ws: string, _role: string, _provider: string, _model: string): Promise<EngineOutcome> { return unsupported('T5/T7 model replacement') }
  async handleReset(_ws: string): Promise<void> { throw new WorkflowError('T8 authorized termination not connected; original data retained') }
}
