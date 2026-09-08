/**
 * Host adapters: wire the real DSH services into the engine's narrow
 * interfaces (design §2.3 deployment / §4 runtime).
 */
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { JobStatus } from '@deepseek-ai/dsh-jobs'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { StateStore } from '../state/store.ts'
import type { RunState } from '../types.ts'
import { WorkflowError } from '../types.ts'
import type { DispatchTargets, StateHost, SubagentHost, ProgramHost } from '../engine/engine.ts'
import { BUILTIN_PROGRAMS } from '../programs/catalog.ts'
import { judgeLabel, judgeSpawnPlan, JUDGE_ALLOW, JUDGE_MACHINERY_EXEMPT, resolveRoleModel, roleDenyList } from '../roles/roles.ts'
import { topFrame } from '../state/invariants.ts'
import { projectNodeLocal, type ProjectionSource } from '../judge/projection.ts'
import { renderJudgePrompt } from '../judge/checker.ts'

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(['completed', 'failed', 'killed'])

/** 从 durable 根集合按 parentSession 线性补齐 live 后代。 */
function liveDescendantIds(seedIds: Iterable<string>, agents: readonly Agent[]): Set<string> {
  const ids = new Set(seedIds)
  const childrenByParent = new Map<string, Agent[]>()
  for (const agent of agents) {
    const parent = agent.session.header.parentSession
    if (!parent) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(agent)
    childrenByParent.set(parent, children)
  }
  const queue = [...ids]
  for (let index = 0; index < queue.length; index++) {
    for (const child of childrenByParent.get(queue[index]!) ?? []) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      queue.push(child.id)
    }
  }
  return ids
}

/**
 * Narrow shape of the optional `sessionPersistence` service
 * (`@deepseek-ai/dsh-session-persistence`, ctx key `sessionPersistence`) — the
 * same `inspect()` the subagent continuation manager uses for cold resume.
 * Duck-typed because the package is not a dependency of this plugin.
 */
interface SessionPersistenceLike {
  inspect(id: string, signal?: AbortSignal): Promise<{ meta: { id: string }; events: ReadonlyArray<import('@deepseek-ai/dsh-session').SessionEvent> }>
}

/**
 * Read one durable session's events without residency (F9/S2). Service absent
 * → undefined (the packet degrades without the actor surface — logged by the
 * caller). A present-but-failing persistence read is a technical fault (A1
 * R12 "Session/持久化/读取异常"): it throws so the engine fail-closes into a
 * `judge fault: <detail>` BLOCK instead of judging from a silently truncated
 * packet.
 */
async function inspectPersistedSession(ctx: Context, sessionId: string): Promise<ProjectionSource | undefined> {
  const persistence = ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
  if (persistence === undefined || typeof persistence.inspect !== 'function') return undefined
  let inspection: Awaited<ReturnType<SessionPersistenceLike['inspect']>>
  try {
    inspection = await persistence.inspect(sessionId, new AbortController().signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorkflowError(`actor session projection failed: ${detail}`)
  }
  if (inspection === undefined || !Array.isArray(inspection.events)) {
    throw new WorkflowError(`actor session projection failed: inspect returned no events for "${sessionId}"`)
  }
  const events = inspection.events.slice()
  return {
    id: inspection.meta.id,
    snapshotEvents: () => events,
    seq: events.length > 0 ? events[events.length - 1]!.seq + 1 : 0,
  }
}

/** Best-effort durable existence probe for a reserved Judge Session id. */
async function judgeSessionExistsInPersistence(ctx: Context, sessionId: string): Promise<boolean> {
  try {
    const source = await inspectPersistedSession(ctx, sessionId)
    return source !== undefined && source.id === sessionId
  } catch {
    // A persistence fault is not proof of existence. Fail closed toward
    // spawn-rebuild, which rebuilds the Judge packet from pendingClaim.
    return false
  }
}

/** Fail-closed Judge tool-surface assertion (design §2.2/E2 + A1 R9). */
function assertJudgeToolSurface(childAgent: Agent): string | undefined {
  const schemas = childAgent.ctx.tools.schemas(childAgent)
  const visible = new Set(schemas.map(s => s.name))
  for (const required of JUDGE_ALLOW) {
    if (!visible.has(required)) return `Judge tool surface is missing required tool "${required}"`
  }
  // Own-scope delegation machinery registered by the in-process driver is
  // exempt from the allow-list — it is never visible-filtered (design §2.2).
  for (const name of visible) {
    if (!(JUDGE_ALLOW as readonly string[]).includes(name) && !(JUDGE_MACHINERY_EXEMPT as readonly string[]).includes(name)) {
      return `Judge tool surface contains unexpected tool "${name}"`
    }
  }
  return undefined
}

function textBlocks(text: string) {
  return [{ type: 'text' as const, text }]
}

/** Readable detail for a compaction-path failure (never wraps WorkflowError). */
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** ManualCompactionError detail (`compaction <code>: <message>`), else the plain message. */
function compactErrorDetail(error: unknown): string {
  if (error instanceof ManualCompactionError) return `compaction ${error.code}: ${error.message}`
  return errorDetail(error)
}

export function makeStateHost(store: StateStore): StateHost {
  return {
    async get(workspaceKey) {
      const row = await store.get(workspaceKey)
      if (row === undefined) return undefined
      return { run: row.run, execution: row.execution, version: row.stateVersion }
    },
    async put(workspaceKey, run, expectedVersion, changes) {
      await store.updateRow(workspaceKey, run, expectedVersion, changes)
    },
    async create(workspaceKey, run, execution) {
      const row = await store.createRow(workspaceKey, run, execution)
      return row.stateVersion
    },
    async remove(workspaceKey) {
      await store.deleteRow(workspaceKey)
    },
    execution: (workspaceKey, executionId) => store.execution(workspaceKey, executionId),
    events: (workspaceKey, executionId, after, limit) => store.events(workspaceKey, executionId, after, limit),
    async listRuns() {
      const rows = await store.list()
      return rows.map(row => ({ workspaceKey: row.workspaceKey, run: row.run, execution: row.execution, version: row.stateVersion }))
    },
  }
}

export interface HostAdapters {
  ctx: Context
  managerAgentOf(run: RunState): Agent | undefined
  cwdOfManager(run: RunState): Promise<string | undefined>
  /** Register a fresh Judge session so the plugin can authorize its inspection + judge_claim calls. */
  registerJudgeSession(sessionId: string, cwd: string | undefined): void
  /** Revoke a Judge session's authorization (A1 R11). */
  revokeJudgeSession(sessionId: string): void
  /** Register a role-actor session↔(workspace,roleKey) mapping at creation time. */
  registerRoleActorSession(sessionId: string, roleKey: string, cwd: string | undefined): void
}

export function makeDispatchTargets(adapters: HostAdapters): DispatchTargets {
  return {
    async steerManager(run, text) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      // A1 R3: the message id is assigned synchronously by createUserMessage,
      // so the return is available even though steer() itself is fire-and-forget.
      const message = createUserMessage({
        content: textBlocks(text),
        source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' },
      })
      manager.steer(message)
      return { messageId: message.id }
    },
    async sendRoleActor(run, roleKey, text) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const childId = run.roleActors[roleKey]
      if (childId === undefined) throw new WorkflowError(`no actor mapped for role "${roleKey}"`)
      // Workflow 派发必须是独立 child turn，不可用 nearest-step sendMessage。
      const messageId = await queueHostSubagentPrompt(adapters.ctx.subagents, manager, SessionId(childId), textBlocks(text),
        { kind: 'plugin', plugin: 'dsh-agent-team-workflow' }, new AbortController().signal)
      return { messageId }
    },
    managerSessionSeq(run) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) return 0
      return manager.session.seq
    },
  }
}

export function makeSubagentHost(adapters: HostAdapters, frozenRoute: () => { provider?: string; model?: string }): SubagentHost & { observeTurnEnd(sessionId: string): void } {
  // ponytail: plugin-lifetime保留当代Agent/祖先/unsafe证据；若长期进程的Session churn实测成问题，再随Run完成/Reset显式清理。
  const observed = new Map<string, Agent>()
  const parents = new Map<string, string>()
  const unsafe = new Set<string>()
  const recordParentSession = (agent: Agent): void => {
    const parentId = agent.session.header.parentSession
    if (parentId !== undefined) parents.set(agent.id, parentId)
  }
  const stopObservingJobs = adapters.ctx.jobs.onJobDone((job, owner) => {
    if (!owner || !job.detail?.includes('work may be orphaned')) return
    recordParentSession(owner)
    // 保留 exact owner 与当时已知祖先；descriptor 消失不能洗白父 Role。
    const seen = new Set<string>()
    for (let id: string | undefined = owner.id; id !== undefined && !seen.has(id); id = parents.get(id)) {
      seen.add(id)
      unsafe.add(id)
      const agent = observed.get(id) ?? adapters.ctx.agents.get(SessionId(id))
      if (agent !== undefined) recordParentSession(agent)
    }
  })
  adapters.ctx.effect(() => () => {
    stopObservingJobs()
    observed.clear()
    parents.clear()
    unsafe.clear()
  })
  async function judgePrompt(run: RunState, input: import('../engine/engine.ts').JudgeSpawnInput): Promise<string> {
    const manager = adapters.managerAgentOf(run)
    if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
    const executorSessionId = input.boundary.executorSessionId
    let actorSession: ProjectionSource | undefined
    if (executorSessionId !== undefined) {
      const actorAgent = adapters.ctx.agents.get(SessionId(executorSessionId))
      actorSession = actorAgent?.session ?? await inspectPersistedSession(adapters.ctx, executorSessionId)
    }
    return renderJudgePrompt({
      nodeToken: input.nodeToken,
      nodeInstruction: `[当前工作单 input]\n${input.input}\n\n[instruction]\n${input.instruction}`,
      criteria: input.criteria,
      workerOutcome: input.claim.outcome,
      workerHandoff: input.claim.handoff,
      workspaceCwd: input.cwd,
      transcript: projectNodeLocal(manager.session, input.boundary, actorSession),
      previousFeedback: input.previousFeedback,
      managerContext: input.managerContext,
    })
  }
  return {
    observeTurnEnd(sessionId) {
      const agent = adapters.ctx.agents.get(SessionId(sessionId))
      if (agent) {
        observed.set(sessionId, agent)
        recordParentSession(agent)
      }
    },
    async safeToInspect(sessionId) {
      const agent = observed.get(sessionId) ?? adapters.ctx.agents.get(SessionId(sessionId))
      if (!agent || unsafe.has(sessionId)) return false
      try {
        await agent.whenIdle()
        const descendants = await adapters.ctx.subagents.listDescendants(SessionId(sessionId))
        if (descendants.some(child => child.kind === 'diagnostic')) return false
        for (const child of descendants) parents.set(String(child.id), String(child.parentId))
        const durableIds = new Set([sessionId, ...descendants.map(child => String(child.id))])
        if ([...durableIds].some(id => unsafe.has(id))) return false
        const requiredIds = new Set([sessionId, ...descendants
          .filter(child => child.kind === 'child' && child.activity === 'running')
          .map(child => String(child.id))])
        for (const id of durableIds) if (observed.has(id)) requiredIds.add(id)

        // Durable inactive 后代没有 Activation；registry 补齐 descriptor
        // 发布窗口中的 live 后代，以及 cold parent 之下的 live 后代。
        const live = adapters.ctx.agents.list()
        for (const candidate of live) recordParentSession(candidate)
        const treeIds = liveDescendantIds(durableIds, live)
        for (const child of live) if (treeIds.has(child.id)) requiredIds.add(child.id)

        const agents: Agent[] = []
        for (const id of requiredIds) {
          const candidate = observed.get(id) ?? adapters.ctx.agents.get(SessionId(id))
          if (!candidate || candidate.status !== 'idle' || candidate.inbox.hasPending || unsafe.has(id)) return false
          agents.push(candidate)
        }
        await Promise.all(agents.map(candidate => candidate.whenIdle()))

        const currentDescendants = await adapters.ctx.subagents.listDescendants(SessionId(sessionId))
        for (const child of currentDescendants) parents.set(String(child.id), String(child.parentId))
        if (currentDescendants.some(child => child.kind === 'diagnostic'
          || unsafe.has(String(child.id))
          || (child.activity === 'running' && !requiredIds.has(String(child.id))))) return false
        const currentLive = adapters.ctx.agents.list()
        for (const candidate of currentLive) recordParentSession(candidate)
        const currentTreeIds = liveDescendantIds([sessionId, ...currentDescendants.map(child => String(child.id))], currentLive)
        if (currentLive.some(child => currentTreeIds.has(child.id) && !requiredIds.has(child.id))) return false
        return agents.every(candidate => {
          const current = adapters.ctx.agents.get(candidate.id)
          return (current === undefined || current === candidate) && candidate.status === 'idle' && !candidate.inbox.hasPending && !unsafe.has(candidate.id)
            && adapters.ctx.jobs.list(candidate).filter(job => job.ownerSession === candidate.id)
              .every(job => TERMINAL_JOB_STATUSES.has(job.status) && !job.detail?.includes('work may be orphaned'))
        })
      } catch { return false }
    },
    async ensureRoleActor(run, roleKey, initialText) {
      const existing = run.roleActors[roleKey]
      if (existing !== undefined) {
        // Not expected: the engine checks this before calling. Followup is the
        // correct continuation for an existing mapping.
        const manager = adapters.managerAgentOf(run)
        if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
        const messageId = await queueHostSubagentPrompt(adapters.ctx.subagents, manager, SessionId(existing), textBlocks(initialText),
          { kind: 'plugin', plugin: 'dsh-agent-team-workflow' }, new AbortController().signal)
        return { childId: existing, messageId }
      }
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const roleDef = run.definitionSnapshot.roles[roleKey]
      if (roleDef === undefined) throw new WorkflowError(`unknown role "${roleKey}"`)
      const route = resolveRoleModel(run, roleKey, frozenRoute())
      const deny = roleDenyList(run, roleKey)
      const started = await adapters.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: `workflow-role:${roleKey}`,
        request: {
          prompt: textBlocks(initialText),
          parent: manager,
          persona: roleDef.persona,
          toolFilter: deny.length > 0 ? { deny } : undefined,
          agentOptions: route.provider !== undefined || route.model !== undefined
            ? { provider: route.provider, model: route.model }
            : undefined,
        },
        signal: new AbortController().signal,
      })
      // Record the session mapping IMMEDIATELY at creation — the child's first
      // turn may end before the engine persists roleActors, and its node_claim
      // authorization needs this mapping.
      adapters.registerRoleActorSession(started.childId, roleKey, manager.session.header.cwd)
      return { childId: started.childId, messageId: started.messageId }
    },

    async startJudge(run, input) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const plan = judgeSpawnPlan(run, frozenRoute())

      // 首次、followup 与 respawn 都从同一当前工作单材料重建完整 packet。
      const prompt = await judgePrompt(run, input)

      const started = await adapters.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: judgeLabel(topFrame(run).nodeId),
        // P1: use the engine-reserved id, which was persisted BEFORE child
        // admission; the child may begin judging as soon as the prompt is
        // accepted, so an Engine-returned id would arrive too late.
        childId: SessionId(input.judgeSessionId),
        request: {
          prompt: textBlocks(prompt),
          parent: manager,
          persona: plan.persona,
          toolFilter: plan.toolFilter,
          agentOptions: plan.agentOptions.provider !== undefined || plan.agentOptions.model !== undefined
            ? { provider: plan.agentOptions.provider, model: plan.agentOptions.model }
            : undefined,
        },
        signal: new AbortController().signal,
      })

      // Fail-closed tool-surface assertion over the freshly published child
      // (CONTEXT.md "每次 spawn 后对 Judge final visible schema 做 fail-closed
      // 断言"): an unobservable child is itself a fault, never a pass.
      const childAgent = adapters.ctx.agents.get(started.childId)
      if (childAgent === undefined) {
        await adapters.ctx.subagents.drainContinuableChildren(manager, [started.childId]).catch(() => {})
        adapters.revokeJudgeSession(started.childId)
        throw new WorkflowError('judge child agent is not observable after spawn')
      }
      const surfaceProblem = assertJudgeToolSurface(childAgent)
      if (surfaceProblem !== undefined) {
        // Drain the judge we just spawned and surface the detail.
        await adapters.ctx.subagents.drainContinuableChildren(manager, [started.childId]).catch(() => {})
        adapters.revokeJudgeSession(started.childId)
        throw new WorkflowError(surfaceProblem)
      }
      adapters.registerJudgeSession(started.childId, input.cwd)
      return { judgeSessionId: started.childId, messageId: started.messageId }
    },

    async judgeSessionExists(judgeSessionId) {
      return judgeSessionExistsInPersistence(adapters.ctx, judgeSessionId)
    },

    async followupJudge(run, judgeSessionId, input) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const messageId = await queueHostSubagentPrompt(adapters.ctx.subagents, manager, SessionId(judgeSessionId), textBlocks(await judgePrompt(run, input)),
        { kind: 'plugin', plugin: 'dsh-agent-team-workflow' }, new AbortController().signal)
      adapters.registerJudgeSession(judgeSessionId, input.cwd)
      return { messageId }
    },

    async retireJudge(run, judgeSessionId) {
      // A1 R11: revoke authorization only. Never drain from inside the Judge's
      // own judge_claim tool call — DSH's dispose() cancels the caller's turn
      // and awaits its quiescence (a self-deadlock); the settlement watcher
      // releases the Activation automatically once the Judge's turn ends.
      void run
      adapters.revokeJudgeSession(judgeSessionId)
    },

    async drainJudge(run, judgeSessionId) {
      const manager = adapters.managerAgentOf(run)
      adapters.revokeJudgeSession(judgeSessionId)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      await adapters.ctx.subagents.drainContinuableChildren(manager, [SessionId(judgeSessionId)])
    },

    async compactRoleActor(run, roleKey) {
      const childId = run.roleActors[roleKey]
      if (childId === undefined) return { ok: true, detail: 'no actor mapped' }
      const signal = new AbortController().signal
      // A4 plan A (docs/prd/20260903-workflow-hardening/a4-code-findings.md §3):
      // the settlement watcher releases the actor's Activation right after its
      // turn, and the next dispatch always follows a full Judge cycle, so the
      // actor is cold at this point on every cross-node path. Compact a COLD
      // actor by materializing it WITHOUT a prompt (no turn starts), running
      // compactNow on the idle agent (its result is durably flushed before it
      // resolves), then releasing the handle so the dispatch followup
      // cold-resumes the compacted surface.
      const resident = adapters.ctx.agents.get(childId as SessionId)
      if (resident !== undefined) {
        // 收口后仍可能被外部唤醒；busy 必须拒绝，不能以FIFO排队冒充compact通过。
        try {
          const result = await adapters.ctx.compaction.compactNow(resident, signal)
          if (result === null) return { ok: true, detail: 'no compactable range' }
          return { ok: true, detail: `compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens)` }
        } catch (error) {
          if (error instanceof ManualCompactionError && error.code === 'busy') {
            return { ok: false, detail: 'resident actor busy' }
          }
          return { ok: false, detail: compactErrorDetail(error) }
        }
      }
      const route = resolveRoleModel(run, roleKey, frozenRoute())
      let handle: AgentHandle
      try {
        handle = await adapters.ctx.agents.resume({
          resumeSessionId: childId as SessionId,
          // Mirrors the agentOptions the continuation manager re-applies when
          // IT cold-resumes this child. This is only the summarizer's LAST
          // fallback (compaction summarization* config > the session's own
          // latest routed request), so the summary model may differ from the
          // actor's model.
          agentOptions: route.provider !== undefined || route.model !== undefined ? route : undefined,
        })
      } catch (error) {
        return { ok: false, detail: `cold materialize failed: ${errorDetail(error)}` }
      }
      let outcome: { ok: boolean; detail: string }
      try {
        const result = await adapters.ctx.compaction.compactNow(handle.agent, signal)
        outcome = result === null
          ? { ok: true, detail: 'cold: no compactable range' }
          : { ok: true, detail: `cold compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens)` }
      } catch (error) {
        outcome = { ok: false, detail: compactErrorDetail(error) }
      }
      // ALWAYS tear the materialization down: a leaked resident agent would
      // collide on the registry id inside the dispatch followup's cold resume.
      try {
        await handle.dispose()
      } catch (error) {
        return { ok: false, detail: `cold materialize teardown failed: ${errorDetail(error)}` }
      }
      return outcome
    },
  }
}

export function makeProgramHost(adapters: HostAdapters): ProgramHost {
  return {
    async run(_run, programId, parameters, cwd) {
      const def = BUILTIN_PROGRAMS[programId]
      if (def === undefined) return { kind: 'ERROR', reason: `unknown program ${programId}` }
      return def.run({ cwd }, parameters)
    },
  }
}
