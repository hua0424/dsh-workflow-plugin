/**
 * dsh-agent-team-workflow — plugin entry (design §2.3 deployment).
 *
 * Cordis plugin: registers /dsh-flow command + workflow tools + inspection
 * wrappers, owns the state store + engine, and subscribes to
 * session/event for turn-settlement observation.
 */
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { StateStore, workspaceKeyOf, StateConflictError } from './state/store.ts'
import { endedTurnUserMessageIds } from './plugin/turnbind.ts'
import { scanCatalog, loadCatalogEntry } from './catalog/loader.ts'
import { WorkflowEngine } from './engine/engine.ts'
import { WorkflowError } from './types.ts'
import type { RunState } from './types.ts'
import { setToolHost, workflowTools, type ToolHost } from './tools/tools.ts'
import { authorizeToolCall } from './tools/authz.ts'
import { makeDshFlowCommand, type CommandHost } from './commands/dsh-flow.ts'
import { makeStateHost, makeDispatchTargets, makeSubagentHost, makeProgramHost } from './plugin/host.ts'

export const name = 'dsh-agent-team-workflow'
export const inject = ['commands', 'tools', 'subagents', 'agents', 'sessions'] as const

export function apply(ctx: Context) {
  const home = resolveDshHome()
  const store = new StateStore(home)
  ctx.effect(() => () => store.close())

  /** Live session → workspace key for every run participant (manager + role actors). */
  const sessionWorkspaces = new Map<string, string>()
  /** Live session → role key for authorization refinement (role actors only). */
  const sessionRoles = new Map<string, string>()
  /** Fresh Judge sessions (continuable); allowed to call judge_claim + the two inspection wrappers. */
  const judgeSessions = new Set<string>()
  /** Judge session id → workspace key (for authorization). */
  const judgeWorkspaces = new Map<string, string>()

  /** Register a fresh Judge session for inspection + judge_claim authorization. */
  function registerJudgeSession(sessionId: string, cwd: string | undefined): void {
    judgeSessions.add(sessionId)
    // S3: store the CANONICAL workspace key (realpath), not the raw header cwd
    // — state rows are keyed by canonical path, and a mismatch would partition
    // the mutation queue and silently stall the run. If this async lookup fails
    // or races the Judge's first tool call, authorization falls through to the
    // durable state row repair in isJudgeSessionOf (A1 R12 fail-closed).
    if (cwd !== undefined) {
      void workspaceKeyOf(cwd).then(ws => {
        if (ws !== undefined) {
          judgeWorkspaces.set(sessionId, ws)
          sessionWorkspaces.set(sessionId, ws)
        }
      }).catch(() => {})
    }
  }

  /** Revoke a Judge session's authorization (A1 R11). */
  function revokeJudgeSession(sessionId: string): void {
    judgeSessions.delete(sessionId)
    judgeWorkspaces.delete(sessionId)
    // 历史routing保留；授权只认当前工作单，不因撤权丢最后turn/end。
  }

  /**
   * S1: durable Judge repair after a host restart. The in-memory Judge sets
   * are empty, but running/blocked rows still carry `judgeSessionId`. A
   * cold-resumed Judge is re-admitted as the current node's judge when its
   * session id matches the durable row.
   */
  async function durableJudgeWorkspace(sessionId: string): Promise<string | undefined> {
    for (const row of await store.list()) {
      if (row.execution.judge?.sessionId === sessionId) return row.workspaceKey
    }
    return undefined
  }

  /**
   * Whether a session is authorized as the current node's Judge for one
   * workspace. The live registration is workspace-scoped: a Judge admission
   * (and its repair) always resolves through the workspace key recorded at
   * registration time, never through the session id alone.
   */
  async function isJudgeSessionOf(sessionId: string, workspaceKey: string): Promise<boolean> {
    const admittedWorkspace = judgeWorkspaces.get(sessionId)
    if (admittedWorkspace !== undefined && admittedWorkspace !== workspaceKey) return false
    // Missing mapping can be a registration race (async realpath) or a host
    // restart. Fall back to the durable row in either case; a positive match
    // repairs the live mappings.
    const row = await store.get(workspaceKey)
    if (row !== undefined && row.run.status === 'running' && row.execution.phase === 'checking'
      && row.execution.judgment === undefined && row.execution.judge?.sessionId === sessionId) {
      judgeSessions.add(sessionId)
      judgeWorkspaces.set(sessionId, workspaceKey)
      sessionWorkspaces.set(sessionId, workspaceKey)
      return true
    }
    return false
  }

  /** Register a role-actor session mapping at creation time (host adapter). */
  function registerRoleActorSession(sessionId: string, roleKey: string, cwd: string | undefined): void {
    if (cwd !== undefined) {
      void workspaceKeyOf(cwd).then(ws => {
        if (ws !== undefined) sessionWorkspaces.set(sessionId, ws)
      }).catch(() => {})
    }
    sessionRoles.set(sessionId, roleKey)
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

  const subagentHost = makeSubagentHost({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, revokeJudgeSession, registerRoleActorSession }, () => engine.frozenRoute)
  const engine: WorkflowEngine = new WorkflowEngine(
    makeDispatchTargets({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, revokeJudgeSession, registerRoleActorSession }),
    subagentHost,
    makeProgramHost({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, revokeJudgeSession, registerRoleActorSession }),
    makeStateHost(store),
  )
  engine.cwdResolver = cwdOf
  // F22: freeze the Manager route at Run start (read from the live agent).
  engine.managerRoute = async (managerSessionId: string) => {
    const agent = ctx.agents.get(managerSessionId as SessionId)
    if (agent === undefined) return {}
    return { provider: agent.options.provider, model: agent.options.model }
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
    const recorded = sessionWorkspaces.get(sessionId)
    if (recorded !== undefined) return recorded
    const agent = ctx.agents.get(sessionId as SessionId)
    if (agent === undefined) return undefined
    const ws = await workspaceKeyOf(agent.session.header.cwd)
    if (ws !== undefined) sessionWorkspaces.set(sessionId, ws)
    return ws
  }

  /** Authorize a workflow-control tool call from the calling agent (exec.agent). */
  async function authorize(caller: unknown, toolName: string): Promise<{ workspaceKey: string } | { workspaceKey: null; reason: string }> {
    if (typeof caller !== 'object' || caller === null || !('session' in caller)) {
      return { workspaceKey: null, reason: 'no calling agent' }
    }
    const agent = caller as Agent
    const sessionId = agent.session.id
    // Workspace resolution: recorded mapping → live cwd realpath (records the
    // mapping for future calls, covering the Manager's new post-restart session).
    const ws = await workspaceOfSession(sessionId)
    if (ws === undefined) return { workspaceKey: null, reason: 'no workspace for this session' }
    const row = await store.get(ws)
    if (row === undefined) return { workspaceKey: null, reason: 'no active run in this workspace' }
    // S1: a cold-resumed Judge is re-admitted when its id matches the durable
    // row's current judgeSessionId (host-restart repair).
    const judge = await isJudgeSessionOf(sessionId, ws)
    const decision = authorizeToolCall({
      run: row.run,
      sessionId,
      knownRoleOfSession: sessionRoles.get(sessionId),
      isJudgeSession: judge,
      toolName,
    })
    if (!decision.allow) return { workspaceKey: null, reason: decision.reason }
    // Repair live mappings learned from the durable tables (host restart /
    // cold-resumed actors): record and cache them for future calls.
    if (decision.kind === 'role' && !sessionRoles.has(sessionId)) sessionRoles.set(sessionId, decision.roleKey)
    return { workspaceKey: ws }
  }

  const toolHost: ToolHost = {
    authorize,
    claim: (ws, claim, caller) => engine.handleClaim(ws, claim, caller).then(outcomeOf),
    block: (ws, nodeToken, reason, caller) => engine.handleBlock(ws, nodeToken, reason, caller).then(outcomeOf),
    resume: (ws, nodeToken, resolutionContext, caller) => engine.handleResume(ws, nodeToken, resolutionContext, caller).then(outcomeOf),
    runProgram: (ws, nodeToken, parameters, caller) => engine.handleRunProgram(ws, nodeToken, parameters, caller).then(outcomeOf),
    resolveProgram: (ws, nodeToken, result, reason, caller) => engine.handleResolveProgram(ws, nodeToken, result, reason, caller).then(outcomeOf),
    setRoleModel: (ws, roleKey, provider, modelId) => engine.handleSetRoleModel(ws, roleKey, provider, modelId).then(outcomeOf),
    judgeClaim: (ws, nodeToken, result, reason, caller) => engine.handleJudgeClaim(ws, nodeToken, result, reason, caller).then(outcomeOf),
    respawnJudge: (ws, nodeToken, reason, caller) => engine.handleRespawnJudge(ws, nodeToken, reason, caller).then(outcomeOf),
    status: (ws) => engine.status(ws),
    inspectGit: async (_ws, operation) => {
      const cwd = ambientAgent()?.session.header.cwd
      if (cwd === undefined) return { ok: false, reason: 'no cwd' }
      const { inspectGit } = await import('./programs/runner.ts')
      const facts = inspectGit(cwd)
      switch (operation) {
        case 'status': return { ok: true, value: facts.statusShort ?? null }
        case 'branch': return { ok: true, value: facts.branch ?? (facts.detached ? '(detached)' : null) }
        case 'remote': return { ok: true, value: facts.originUrl ?? null }
        case 'top-level': return { ok: true, value: facts.topLevel ?? null }
        default: return { ok: false, reason: `unknown operation ${String(operation)}` }
      }
    },
    inspectGithub: async (_ws, operation, milestoneNumber) => {
      const cwd = ambientAgent()?.session.header.cwd
      if (cwd === undefined) return { ok: false, reason: 'no cwd' }
      const { inspectGit, parseOriginRepo, ghApi } = await import('./programs/runner.ts')
      const git = inspectGit(cwd)
      if (!git.inRepo || git.originUrl === undefined || git.originUrl === '') return { ok: false, reason: 'not a git repository with origin' }
      const parsed = parseOriginRepo(git.originUrl)
      if (parsed === undefined) return { ok: false, reason: `origin is not a GitHub repo: ${git.originUrl}` }
      const base = `repos/${parsed.owner}/${parsed.repo}`
      switch (operation) {
        case 'milestones': {
          const r = ghApi({ cwd, method: 'GET', path: `${base}/milestones`, query: 'state=all&per_page=100' })
          return r.kind === 'PASS' ? { ok: true, value: r.details } : { ok: false, reason: r.reason }
        }
        case 'issues': {
          const r = ghApi({ cwd, method: 'GET', path: `${base}/issues`, query: 'state=all&per_page=100' })
          if (r.kind !== 'PASS') return { ok: false, reason: r.reason }
          const issues = Array.isArray(r.details)
            ? (r.details as Array<{ number: number; title: string; state: string; pull_request?: unknown; milestone: { number: number } | null }>).filter(i => i.pull_request === undefined)
            : []
          return { ok: true, value: issues }
        }
        case 'milestone-issues': {
          if (milestoneNumber === undefined) return { ok: false, reason: 'milestoneNumber is required for milestone-issues' }
          const r = ghApi({ cwd, method: 'GET', path: `${base}/issues`, query: `state=all&milestone=${milestoneNumber}&per_page=100` })
          if (r.kind !== 'PASS') return { ok: false, reason: r.reason }
          const issues = Array.isArray(r.details)
            ? (r.details as Array<{ number: number; title: string; state: string; pull_request?: unknown }>).filter(i => i.pull_request === undefined)
            : []
          return { ok: true, value: issues }
        }
        default: return { ok: false, reason: `unknown operation ${String(operation)}` }
      }
    },
  }

  function outcomeOf(o: { ok: boolean; reason?: string; message?: string }): { ok: boolean; reason?: string; message?: string } {
    if (!o.ok) return { ok: false, reason: o.reason ?? 'engine rejected the mutation' }
    return { ok: true, message: o.message }
  }

  setToolHost(toolHost)

  // ---- Role-actor session mapping maintenance ----
  // Every continuable child created for a role records (sessionId, workspace,
  // roleKey). We learn the child id from `subagent/start` (local children) and
  // join it with the run's roleActors mapping.
  ctx.on('subagent/start', (info) => {
    const agent = ctx.agents.get(info.id)
    if (agent === undefined) return
    const parentId = agent.session.header.parentSession
    if (parentId === undefined) return
    void (async () => {
      const ws = sessionWorkspaces.get(parentId)
      if (ws === undefined) return
      sessionWorkspaces.set(info.id, ws)
      const row = await store.get(ws)
      if (row === undefined) return
      // S1: a cold-resumed JUDGE child re-registers via the durable row.
      if (row.execution.judge?.sessionId === info.id) {
        judgeSessions.add(info.id)
        judgeWorkspaces.set(info.id, ws)
        return
      }
      for (const [roleKey, actorId] of Object.entries(row.run.roleActors)) {
        if (actorId === info.id) {
          sessionRoles.set(info.id, roleKey)
          return
        }
      }
    })()
  })

  // ---- Command host ----
  const commandHost: CommandHost = {
    currentWorkspaceKey: async (agent) => {
      return workspaceKeyOf(agent.session.header.cwd)
    },
    list: () => scanCatalog(home),
    async start(agent, workspaceKey, workflowId, extraText) {
      try {
        const entry = await loadCatalogEntry(home, workflowId)
        if (entry === undefined) return { ok: false, reason: `workflow "${workflowId}" not found in the catalog` }
        const run = engine.buildInitialRun(agent.session.id, workflowId, entry.config, entry.definitionHash)
        sessionWorkspaces.set(agent.session.id, workspaceKey)
        const outcome = await engine.startRun(workspaceKey, run, entry.path, extraText)
        if (!outcome.ok) return { ok: false, reason: outcome.reason }
        return { ok: true, message: `started ${workflowId} (run ${outcome.run.runId})` }
      } catch (error) {
        if (error instanceof StateConflictError) return { ok: false, reason: error.message }
        return { ok: false, reason: String(error) }
      }
    },
    status: (workspaceKey) => toolHost.status(workspaceKey),
    async reset(workspaceKey) {
      try {
        await engine.handleReset(workspaceKey)
        return { ok: true, message: 'run row removed' }
      } catch (error) {
        return { ok: false, reason: String(error) }
      }
    },
  }

  // ---- Register command + tools ----
  const disposeCommand = ctx.commands.register(makeDshFlowCommand(commandHost))
  const disposeTools = workflowTools.map(def => ctx.tools.register(def))

  // append 内只读快照；setImmediate 后才触发可能追加消息的 Runtime。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const ids = endedTurnUserMessageIds(session.snapshotEvents(), event)
    if (ids === undefined) return
    subagentHost.observeTurnEnd(session.id)
    const caller = { sessionId: session.id, turnUserMessageIds: ids }
    setImmediate(() => {
      void (async () => {
        const ws = sessionWorkspaces.get(session.id) ?? await durableJudgeWorkspace(session.id)
          ?? await workspaceKeyOf(session.header.cwd)
        if (ws !== undefined) await engine.handleTurnEnded(ws, caller)
      })().catch(error => ctx.logger.warn(`workflow turn settlement failed: ${String(error)}`))
    })
  })

  ctx.effect(() => () => {
    disposeCommand()
    for (const dispose of disposeTools) dispose()
  })

  // ---- Host restart reconciliation (design §4.2 H1) ----
  void (async () => {
    await engine.handleRestartReconcile()
  })()
}
