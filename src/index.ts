/**
 * dsh-agent-team-workflow — plugin entry (design §2.3 deployment).
 *
 * Cordis plugin: registers /dsh-flow command + workflow tools + inspection
 * wrappers, owns the state store + engine, and subscribes to
 * session/event for turn-settlement observation.
 */
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parentAgentOptionsForDelegation } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { StateAccess, workspaceKeyOf, StateConflictError, type StateMaintenanceDiagnostic } from './state/store.ts'
import { endedTurnUserMessageIds } from './plugin/turnbind.ts'
import { turnEndFailure, type TurnEndFact } from './plugin/turn-end.ts'
import { scanCatalog, loadCatalogEntry } from './catalog/loader.ts'
import { checkCatalogProviders, renderProviderCheckReport, renderStartProviderBlock } from './catalog/provider-check.ts'
import { WorkflowEngine } from './engine/engine.ts'
import { WorkflowError } from './types.ts'
import type { RunState, NodeExecution } from './types.ts'
import { makeWorkflowTools, type ToolHost } from './tools/tools.ts'
import { authorizeToolCall } from './tools/authz.ts'
import { isRootCommandAgent, makeBlankSessionActivator, makeDshFlowCommand, type CommandHost } from './commands/dsh-flow.ts'
import { makeStateHost, makeDispatchTargets, makeSubagentHost, makeProgramHost } from './plugin/host.ts'
import {
  judgeAdmissionInWorkOrder, makeParticipantIndex, participantInWorkOrder, participantServicesOf,
  type WorkOrderFacts,
} from './plugin/participants.ts'

export const name = 'dsh-agent-team-workflow'
// compaction 不可注入：dsh 0.1.1-rc.7 引入 agent presets 后，压缩后端移入每个
// 会话 preset 的 isolate 域（web-app bundle 显式禁用宿主平面副本），宿主行
// inject 它只会永久 `waiting for service: compaction` 并卡死整个 boot。
// 改为运行期按目标 agent 解析（plugin/host.ts 的 compactionFor）。
export const inject = ['commands', 'tools', 'subagents', 'agents', 'sessions', 'jobs', 'llm'] as const

export function apply(ctx: Context) {
  const home = resolveDshHome()
  const stateAccess = new StateAccess(home)
  const store = () => stateAccess.current()
  ctx.effect(() => () => stateAccess.close())
  const maintenanceText = (diagnostic: StateMaintenanceDiagnostic): string => [
    'Workflow State Store is in maintenance mode; ordinary list/start/tools are disabled.',
    `path: ${diagnostic.path}`,
    `user_version: ${diagnostic.userVersion ?? 'unreadable'}`,
    `reason: ${diagnostic.reason}`,
    'No data was migrated or replaced. Plain /dsh-flow reset cannot cut over an incompatible store.',
    'A root user may back up and replace the ENTIRE workflow State Store with: /dsh-flow reset --incompatible-store',
    'This does not cancel old external effects; inspect them before starting new work.',
  ].join('\n')

  /**
   * #99：参与者路由、重启修复与观察引用寿命全部收在同一个深 Module
   * （`plugin/participants.ts`）。本文件只做两件事：把 Store 的**当前工作单**
   * 投影成授权事实（唯一权威），以及把宿主 cwd/emitter 事实喂给它。
   */
  const participants = makeParticipantIndex(participantServicesOf(ctx), {
    workspaceKeyOf,
    facts: async workspaceKey => {
      const row = await store().get(workspaceKey)
      return row === undefined ? undefined : workOrderFactsOf(row)
    },
    // 冷恢复兜底：cwd 推导不出所属行时按 Session 找一次（不再是无条件全表扫）。
    factsBySession: async sessionId => {
      for (const row of await store().list()) {
        if (row.execution.judge?.sessionId === sessionId) return { workspaceKey: row.workspaceKey, facts: workOrderFactsOf(row) }
      }
      return undefined
    },
  })

  /** 当前工作单行 → 路由/授权事实。Store 行本身仍是唯一授权权威。 */
  function workOrderFactsOf(row: { run: RunState; execution: NodeExecution }): WorkOrderFacts {
    const execution = row.execution
    const judgment = execution.judgment
    return {
      runStatus: row.run.status,
      phase: execution.phase,
      managerSessionId: row.run.managerSessionId,
      roleActors: row.run.roleActors,
      dispatchSessionId: execution.dispatch?.sessionId,
      judgeSessionId: execution.judge?.sessionId,
      judgeJudgedCurrentClaim: judgment !== undefined && judgment.claimId === execution.claim?.id
        && judgment.inputVersion === execution.inputVersion,
      predecessorSettlementPending: execution.phase === 'ready' && execution.predecessorId !== undefined,
    }
  }

  /** Register a fresh Judge session for inspection + judge_claim authorization. */
  function registerJudgeSession(sessionId: string, cwd: string | undefined): void {
    // S3: store the CANONICAL workspace key (realpath), not the raw header cwd
    // — state rows are keyed by canonical path, and a mismatch would partition
    // the mutation queue and silently stall the run. If this async lookup fails
    // or races the Judge's first tool call, authorization falls through to the
    // durable state row repair in judgeAuthorized (A1 R12 fail-closed).
    if (cwd === undefined) return
    void workspaceKeyOf(cwd).then(ws => {
      if (ws !== undefined) participants.admitJudge(sessionId, ws)
    }).catch(() => {})
  }

  /** Revoke a Judge session's authorization (A1 R11). */
  function revokeJudgeSession(sessionId: string): void {
    participants.revokeJudge(sessionId)
    // 历史routing保留；授权只认当前工作单，不因撤权丢最后turn/end。
  }

  /**
   * Whether a session is authorized as the current node's Judge for one
   * workspace. The live registration is workspace-scoped: a Judge admission
   * (and its repair) always resolves through the workspace key recorded at
   * registration time, never through the session id alone. Every call judges
   * against the CURRENT work order row (#99 AC5).
   */
  function judgeAuthorized(sessionId: string, workspaceKey: string, row: { run: RunState; execution: NodeExecution }): boolean {
    const admittedWorkspace = participants.judgeWorkspaceOf(sessionId)
    if (admittedWorkspace !== undefined && admittedWorkspace !== workspaceKey) return false
    // Missing mapping can be a registration race (async realpath) or a host
    // restart. The durable row repairs the live mappings on a positive match.
    if (!judgeAdmissionInWorkOrder(workOrderFactsOf(row), sessionId)) return false
    participants.adopt(sessionId, workspaceKey, { kind: 'judge' })
    return true
  }

  /** Register a role-actor session mapping at creation time (host adapter). */
  function registerRoleActorSession(sessionId: string, roleKey: string, cwd: string | undefined): void {
    participants.rememberRole(sessionId, roleKey)
    if (cwd === undefined) return
    void workspaceKeyOf(cwd).then(ws => {
      if (ws !== undefined) participants.rememberWorkspace(sessionId, ws, 'participation')
    }).catch(() => {})
  }

  function managerOf(run: RunState): Agent | undefined {
    return ctx.agents.get(run.managerSessionId as SessionId)
  }

  async function cwdOf(run: RunState): Promise<string> {
    const manager = managerOf(run)
    const cwd = manager?.session.header.cwd
    if (cwd === undefined) throw new WorkflowError('manager session has no cwd')
    return cwd
  }

  /** The agent currently initiating tool execution (inside an agent scope). */
  function ambientAgent(): Agent | undefined {
    return ctx.agents.currentInitiator()
  }

  // #91: 兜底回调只服务旧 Run（无 `delegationRoute` 的 v9 行）：不推测历史值，
  // 也不借其他 Run 的值——留空即让宿主 spawn 的正式继承语义从本 Run 自己的
  // Manager 解析。新 Run 一律读 Run row 上的冻结值。
  const subagentHost = makeSubagentHost(
    { ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, revokeJudgeSession, registerRoleActorSession },
    () => ({}),
    participants)
  const engine: WorkflowEngine = new WorkflowEngine(
    makeDispatchTargets({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, revokeJudgeSession, registerRoleActorSession }),
    subagentHost,
    makeProgramHost({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, revokeJudgeSession, registerRoleActorSession }),
    makeStateHost(store),
  )
  engine.cwdResolver = cwdOf
  // F22 / #91：Run 启动时冻结 Manager 的默认路由，冻结值随 Run row 持久化。
  // 取源走 DSH 固定版本的正式委派 helper——最新 request header 拥有 provider/model，
  // 创建该会话时的 options 兜底——这样冻结值与新建子会话真正会继承到的路由一致。
  engine.managerRoute = async (managerSessionId: string) => {
    const agent = ctx.agents.get(managerSessionId as SessionId)
    if (agent === undefined) return {}
    const options = parentAgentOptionsForDelegation(agent)
    return { provider: options.provider, model: options.model }
  }
  // F13: actor-activity oracle for resume/model-switch checks.
  engine.actorActivity = async (actorSessionId: string) => {
    const agent = ctx.agents.get(actorSessionId as SessionId)
    if (agent === undefined) return 'unknown'
    return agent.status === 'running' ? 'active' : 'idle'
  }
  // A3 §10: surface the FIRST per-run trace-log failure through the Host
  // logger (once per run, never in a loop).
  engine.traceWarn = (message) => {
    ctx.logger.warn(message)
  }

  /** Resolve one session's workspace: recorded mapping first, then cwd realpath. */
  async function workspaceOfSession(sessionId: string): Promise<string | undefined> {
    const recorded = participants.workspaceOf(sessionId)
    if (recorded !== undefined) return recorded
    const agent = ctx.agents.get(sessionId as SessionId)
    if (agent === undefined) return undefined
    const ws = await workspaceKeyOf(agent.session.header.cwd)
    // #99 M-1：这里是**探测**（为后续调用定位 workspace），不证明参与——被拒绝的
    // 无关 Session 也会走到这里，所以它不得单独让该 Session 的证据被保留。
    if (ws !== undefined) participants.rememberWorkspace(sessionId, ws, 'probe')
    return ws
  }

  /** Authorize a workflow-control tool call from the calling agent (exec.agent). */
  async function authorize(caller: unknown, toolName: string): Promise<{ workspaceKey: string } | { workspaceKey: null; reason: string }> {
    const diagnostic = stateAccess.maintenanceDiagnostic()
    if (diagnostic) return { workspaceKey: null, reason: maintenanceText(diagnostic) }
    if (typeof caller !== 'object' || caller === null || !('session' in caller)) {
      return { workspaceKey: null, reason: 'no calling agent' }
    }
    const agent = caller as Agent
    const sessionId = agent.session.id
    // Workspace resolution: recorded mapping → live cwd realpath (records the
    // mapping for future calls, covering the Manager's new post-restart session).
    const ws = await workspaceOfSession(sessionId)
    if (ws === undefined) return { workspaceKey: null, reason: 'no workspace for this session' }
    const row = await store().get(ws)
    if (row === undefined) return { workspaceKey: null, reason: 'no active run in this workspace' }
    // S1: a cold-resumed Judge is re-admitted when its id matches the durable
    // row's current judgeSessionId (host-restart repair).
    const judge = judgeAuthorized(sessionId, ws, row)
    const decision = authorizeToolCall({
      run: row.run,
      sessionId,
      knownRoleOfSession: participants.roleOf(sessionId),
      isJudgeSession: judge,
      toolName,
    })
    if (!decision.allow) return { workspaceKey: null, reason: decision.reason }
    // Repair live mappings learned from the durable tables (host restart /
    // cold-resumed actors): record and cache them for future calls.
    if (decision.kind === 'role' && participants.roleOf(sessionId) === undefined) {
      participants.rememberRole(sessionId, decision.roleKey)
    }
    return { workspaceKey: ws }
  }

  const toolHost: ToolHost = {
    authorize,
    claim: (ws, claim, caller) => engine.handleClaim(ws, claim, caller).then(outcomeOf),
    block: (ws, nodeToken, reason, caller) => engine.handleBlock(ws, nodeToken, reason, caller).then(outcomeOf),
    resume: (ws, nodeToken, resolutionContext, caller, target) => engine.handleResume(ws, nodeToken, resolutionContext, caller, target).then(outcomeOf),
    runProgram: (ws, nodeToken, parameters, caller) => engine.handleRunProgram(ws, nodeToken, parameters, caller).then(outcomeOf),
    resolveProgram: (ws, nodeToken, result, reason, caller) => engine.handleResolveProgram(ws, nodeToken, result, reason, caller).then(outcomeOf),
    setRoleModel: (ws, roleKey, provider, modelId, caller) => engine.handleSetRoleModel(ws, roleKey, provider, modelId, caller).then(outcomeOf),
    judgeClaim: (ws, nodeToken, result, reason, caller) => engine.handleJudgeClaim(ws, nodeToken, result, reason, caller).then(outcomeOf),
    respawnJudge: (ws, nodeToken, reason, caller) => engine.handleRespawnJudge(ws, nodeToken, reason, caller).then(outcomeOf),
    status: (ws, caller, history) => engine.status(ws, caller, history),
    inspectGit: async (_ws, operation) => {
      const cwd = ambientAgent()?.session.header.cwd
      if (cwd === undefined) return { ok: false, reason: 'no cwd' }
      // 与固定 Program 共用同一只读事实层（repository.ts）；失败返回 ok:false，不当 null/clean。
      const { inspectGitFact } = await import('./programs/repository.ts')
      const { realRepositoryAdapter } = await import('./programs/runner.ts')
      return inspectGitFact(realRepositoryAdapter, cwd, operation)
    },
    inspectGithub: async (_ws, operation, milestoneNumber) => {
      const cwd = ambientAgent()?.session.header.cwd
      if (cwd === undefined) return { ok: false, reason: 'no cwd' }
      const { inspectGithubFacts } = await import('./programs/repository.ts')
      const { realRepositoryAdapter } = await import('./programs/runner.ts')
      return inspectGithubFacts(realRepositoryAdapter, cwd, operation, milestoneNumber)
    },
  }

  function outcomeOf(o: { ok: boolean; reason?: string; message?: string }): { ok: boolean; reason?: string; message?: string } {
    if (!o.ok) return { ok: false, reason: o.reason ?? 'engine rejected the mutation' }
    return { ok: true, message: o.message }
  }

  // ---- Role-actor session mapping maintenance ----
  // Every continuable child created for a role records (sessionId, workspace,
  // roleKey). We learn the child id from `subagent/start` (local children) and
  // join it with the run's roleActors/judge mapping — the restart repair path
  // for a cold-resumed child (#99).
  ctx.on('subagent/start', (info) => {
    if (stateAccess.maintenanceDiagnostic()) return
    const agent = ctx.agents.get(info.id)
    if (agent === undefined) return
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return
    void (async () => {
      const ws = participants.workspaceOf(parentId)
      if (ws === undefined) return
      // #99 M-1：子会话从父会话继承的只是**位置**（探测），不是参与证据——角色的
      // 参与身份由下面的工作单行（或创建时的 registerRoleActorSession）证明。
      participants.rememberWorkspace(info.id, ws, 'probe')
      const row = await store().get(ws)
      if (row === undefined) return
      const admission = participantInWorkOrder(workOrderFactsOf(row), info.id)
      if (admission !== undefined) participants.adopt(info.id, ws, admission)
    })()
  })

  // ---- Command host ----
  const commandHost: CommandHost = {
    currentWorkspaceKey: async (agent) => {
      return workspaceKeyOf(agent.session.header.cwd)
    },
    async list() {
      const diagnostic = stateAccess.maintenanceDiagnostic()
      if (diagnostic) return { ok: false, reason: maintenanceText(diagnostic), entries: [], diagnostics: [] }
      return scanCatalog(home)
    },
    async start(agent, workspaceKey, workflowId, extraText) {
      const diagnostic = stateAccess.maintenanceDiagnostic()
      if (diagnostic) return { ok: false, reason: maintenanceText(diagnostic) }
      try {
        const entry = await loadCatalogEntry(home, workflowId)
        if (entry === undefined) return { ok: false, reason: `workflow "${workflowId}" not found in the catalog` }
        // Issue #41：静态校验通过后、创建 Run 前做纯静态 provider 比对（本地
        // 注册表读取，无网络）；任一角色不可用即拒绝启动，不创建 Run。
        const available = ctx.llm.listProviders().map(provider => provider.id)
        const report = checkCatalogProviders(workflowId, entry.config, available)
        if (!report.ok) return { ok: false, reason: renderStartProviderBlock(report) }
        const run = engine.buildInitialRun(agent.session.id, workflowId, entry.config, entry.definitionHash)
        // Manager 启动：该 Session 就是本 Run 的 Manager（工作单行即将引用它），是参与事实。
        participants.rememberWorkspace(agent.session.id, workspaceKey, 'participation')
        const outcome = await engine.startRun(workspaceKey, run, entry.path, extraText)
        if (!outcome.ok) return { ok: false, reason: outcome.reason }
        return { ok: true, message: `started ${workflowId} (run ${outcome.run?.runId})` }
      } catch (error) {
        if (error instanceof StateConflictError) return { ok: false, reason: error.message }
        return { ok: false, reason: String(error) }
      }
    },
    status: (workspaceKey, caller) => {
      const diagnostic = stateAccess.maintenanceDiagnostic()
      if (diagnostic) return Promise.resolve({ ok: true, status: maintenanceText(diagnostic) })
      if (workspaceKey === undefined) return Promise.resolve({ ok: false, reason: '当前会话没有 workspace cwd' })
      return toolHost.status(workspaceKey, caller)
    },
    async check(workflowId) {
      const diagnostic = stateAccess.maintenanceDiagnostic()
      if (diagnostic) return { ok: false, reason: maintenanceText(diagnostic) }
      try {
        const entry = await loadCatalogEntry(home, workflowId)
        if (entry === undefined) return { ok: false, reason: `workflow "${workflowId}" not found in the catalog` }
        // 纯静态比对：宿主已注册 provider 清单是本地注册表读取，无网络调用。
        const available = ctx.llm.listProviders().map(provider => provider.id)
        const report = checkCatalogProviders(workflowId, entry.config, available)
        return { ok: true, message: renderProviderCheckReport(report) }
      } catch (error) {
        return { ok: false, reason: String(error) }
      }
    },
    async reset(agent, workspaceKey, mode) {
      const diagnostic = stateAccess.maintenanceDiagnostic()
      if (diagnostic) {
        if (mode !== 'incompatible-store') return { ok: false, reason: maintenanceText(diagnostic) }
        if (!isRootCommandAgent(agent)) return { ok: false, reason: 'incompatible-store cutover is root-command-only; subagent/diagnostic Sessions are not authorized' }
        try {
          const cutover = await stateAccess.archiveIncompatible()
          return { ok: true, message: `Entire incompatible Workflow State Store was backed up to ${cutover.backupPath} and replaced with an empty v9 Store. Original raw files: ${cutover.archivePath}. External effects were not cancelled.` }
        } catch (error) { return { ok: false, reason: String(error) }
        }
      }
      if (mode === 'incompatible-store') return { ok: false, reason: 'state store is compatible; use plain /dsh-flow reset for the current Run' }
      if (workspaceKey === undefined) return { ok: false, reason: '当前会话没有 workspace cwd' }
      try {
        const outcome = await engine.handleReset(workspaceKey, isRootCommandAgent(agent))
        return outcome.ok ? { ok: true, message: outcome.message } : { ok: false, reason: outcome.reason }
      } catch (error) {
        return { ok: false, reason: String(error) }
      }
    },
  }

  // ---- Register command + tools ----
  // #85：空白会话的激活投递需要 ctx（读宿主 blank 投影）——在这里组装，命令层只接收回调。
  const disposeCommand = ctx.commands.register(makeDshFlowCommand(commandHost, makeBlankSessionActivator(ctx)))
  // #94：工具集在本实例装配时绑定本实例的 toolHost，dispose 只撤销本实例的注册。
  const workflowTools = makeWorkflowTools(toolHost)
  const disposeTools = workflowTools.map(def => ctx.tools.register(def))

  // ---- Turn settlement ----
  // 同步回调只捕获事实（#99 AC6）：路由已确定的参与者在这里立即定格该 Turn 的消息
  // 集合与失败诊断；路由未定的 Session 推迟到 setImmediate 之后、由参与者索引做完
  // 路由判定再定格——无关 Session 的 churn 因此既不再为每个 turn/end 复制整段日志，
  // 也不再触发一次全表 Store.list（#99 AC7）。判定与推进都不在 append 回调内发生。
  ctx.on('session/event', (session, event) => {
    if (stateAccess.maintenanceDiagnostic() || event.type !== 'turn/end') return
    const capture = (): { caller: { sessionId: string; turnUserMessageIds: ReadonlySet<string> }; turnFailure: string | undefined } | undefined => {
      const snapshot = session.snapshotEvents()
      const ids = endedTurnUserMessageIds(snapshot, event)
      if (ids === undefined) return undefined
      // #29：同一次读取里取该 Turn 的失败事实（正常结束为 undefined）。诊断在这里
      // 定格，引擎只收到成品文本——它不需要理解 Host 的 TurnEndReason 形状。
      return {
        caller: { sessionId: session.id, turnUserMessageIds: ids },
        turnFailure: turnEndFailure(snapshot as ReadonlyArray<TurnEndFact>, event as TurnEndFact),
      }
    }
    const captured = participants.workspaceOf(session.id) === undefined ? undefined : capture()
    participants.observeTurnEnd(session.id)
    setImmediate(() => {
      void (async () => {
        const ws = await participants.resolveTurn(session.id, session.header.cwd)
        if (ws === undefined) return
        const settled = captured ?? capture()
        if (settled === undefined) return
        await engine.handleTurnEnded(ws, settled.caller, settled.turnFailure)
      })().catch(error => ctx.logger.warn(`workflow turn settlement failed: ${String(error)}`))
    })
  })

  ctx.effect(() => () => {
    disposeCommand()
    for (const dispose of disposeTools) dispose()
  })

  // ---- Host restart reconciliation (design §4.2 H1) ----
  if (!stateAccess.maintenanceDiagnostic()) void (async () => {
    await engine.handleRestartReconcile()
  })()
}
