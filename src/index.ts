/**
 * dsh-agent-team-workflow — plugin entry (design §2.3 deployment).
 *
 * Cordis plugin: registers /dsh-flow command + seven workflow tools + two
 * inspection wrappers, owns the state store + engine, and subscribes to
 * session/event for turn-settlement observation.
 */
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { StateStore, workspaceKeyOf, StateConflictError } from './state/store.ts'
import { topFrame } from './state/invariants.ts'
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
  /** Fresh Judge sessions (one-shot); allowed to call only the two inspection wrappers. */
  const judgeSessions = new Set<string>()

  /** Register a fresh Judge session for inspection authorization (host adapter). */
  function registerJudgeSession(sessionId: string, cwd: string | undefined): void {
    judgeSessions.add(sessionId)
    if (cwd !== undefined) sessionWorkspaces.set(sessionId, cwd)
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

  /**
   * Per-workspace mutation serialization (design §5: one short mutation
   * queue). Engine handlers are chained so concurrent claims/programs settle
   * in order; the in-flight async Judge/Program phase runs OUTSIDE the queue.
   */
  const workspaceQueues = new Map<string, Promise<unknown>>()
  function enqueue<T>(workspaceKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = workspaceQueues.get(workspaceKey) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    workspaceQueues.set(workspaceKey, next.catch(() => {}))
    return next
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

  const engine: WorkflowEngine = new WorkflowEngine(
    makeDispatchTargets({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, registerRoleActorSession }),
    makeSubagentHost({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, registerRoleActorSession }, () => engine.frozenRoute),
    makeProgramHost({ ctx, managerAgentOf: managerOf, cwdOfManager: cwdOf, registerJudgeSession, registerRoleActorSession }),
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
    const decision = authorizeToolCall({
      run: row.run,
      sessionId,
      knownRoleOfSession: sessionRoles.get(sessionId),
      isJudgeSession: judgeSessions.has(sessionId),
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
    claim: (ws, claim, caller) => enqueue(ws, () => engine.handleClaim(ws, claim, caller).then(outcomeOf)),
    block: (ws, nodeToken, reason, caller) => enqueue(ws, () => engine.handleBlock(ws, nodeToken, reason, caller).then(outcomeOf)),
    resume: (ws, nodeToken, resolutionContext, caller) => enqueue(ws, () => engine.handleResume(ws, nodeToken, resolutionContext, caller).then(outcomeOf)),
    runProgram: (ws, nodeToken, parameters, caller) => enqueue(ws, () => engine.handleRunProgram(ws, nodeToken, parameters, caller).then(outcomeOf)),
    resolveProgram: (ws, nodeToken, result, reason, caller) => enqueue(ws, () => engine.handleResolveProgram(ws, nodeToken, result, reason, caller).then(outcomeOf)),
    setRoleModel: (ws, roleKey, provider, modelId) => enqueue(ws, () => engine.handleSetRoleModel(ws, roleKey, provider, modelId).then(outcomeOf)),
    status: async (ws) => {
      const row = await store.get(ws)
      if (row === undefined) return { ok: true, status: 'no active run' }
      const run = row.run
      return {
        ok: true,
        status: {
          runId: run.runId,
          catalogWorkflowId: run.catalogWorkflowId,
          status: run.status,
          callStack: run.callStack.map(f => ({ workflowId: f.workflowId, nodeId: f.nodeId, nodeToken: f.nodeToken })),
          currentFrame: run.callStack.length > 0 ? topFrame(run) : null,
          roleActors: run.roleActors,
          modelOverrides: run.modelOverrides,
          blockReason: run.blockReason,
        },
      }
    },
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
        const outcome = await engine.startRun(workspaceKey, run)
        if (!outcome.ok) return { ok: false, reason: outcome.reason }
        // Design §2.6: extra text only enters the steer message to the Manager.
        if (extraText !== '') {
          const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: extraText }],
            source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' },
          }))
        }
        return { ok: true, message: `started ${workflowId} (run ${outcome.run.runId})${extraText !== '' ? `; steered: ${extraText}` : ''}` }
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

  // ---- Turn-settlement observation (design §4.2 D6) ----
  // Only MANAGER and mapped ROLE ACTOR sessions settle workflow turns. Judge
  // sessions (one-shot machinery) must never drive auto-BLOCK or dispatch.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const ws = sessionWorkspaces.get(session.id)
    if (ws === undefined) return
    if (judgeSessions.has(session.id)) return
    // Defer: never mutate state inside the append publication lock (design).
    void (async () => {
      await engine.handleTurnEnded(ws, session.id)
    })()
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
