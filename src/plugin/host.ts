/**
 * Host adapters: wire the real DSH services into the engine's narrow
 * interfaces (design §2.3 deployment / §4 runtime).
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { StateStore } from '../state/store.ts'
import type { RunState } from '../types.ts'
import { WorkflowError } from '../types.ts'
import type { DispatchTargets, StateHost, SubagentHost, ProgramHost } from '../engine/engine.ts'
import { BUILTIN_PROGRAMS } from '../programs/catalog.ts'
import { judgeSpawnPlan, JUDGE_ALLOW, JUDGE_MACHINERY_EXEMPT, resolveRoleModel, roleDenyList } from '../roles/roles.ts'
import { projectNodeLocal, type ProjectionSource } from '../judge/projection.ts'
import { renderJudgePrompt } from '../judge/checker.ts'

/** Narrow shape of the `ctx.compaction` service (`@deepseek-ai/dsh-compaction`). */
interface CompactionService {
  compactNow(agent: Agent, signal: AbortSignal): Promise<{ shadowedSeqs: number[]; shadowedTokenCount: number } | null>
}

/** Duck-typed ManualCompactionError (`@deepseek-ai/dsh-compaction`). */
function isManualCompactionError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === 'ManualCompactionError'
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
    events,
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

export function makeStateHost(store: StateStore): StateHost {
  return {
    async get(workspaceKey) {
      const row = await store.get(workspaceKey)
      if (row === undefined) return undefined
      return { run: row.run, version: row.stateVersion }
    },
    async put(workspaceKey, run, expectedVersion) {
      await store.updateRow(workspaceKey, run, expectedVersion)
    },
    async create(workspaceKey, run) {
      const row = await store.createRow(workspaceKey, run)
      return row.stateVersion
    },
    async remove(workspaceKey) {
      await store.deleteRow(workspaceKey)
    },
    async listRuns() {
      const rows = await store.list()
      return rows.map(row => ({ workspaceKey: row.workspaceKey, run: row.run, version: row.stateVersion }))
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
      manager.steer(createUserMessage({
        content: textBlocks(text),
        source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' },
      }))
    },
    async sendRoleActor(run, roleKey, text) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const childId = run.roleActors[roleKey]
      if (childId === undefined) throw new WorkflowError(`no actor mapped for role "${roleKey}"`)
      const messageId = await adapters.ctx.subagents.followup(manager, childId as SessionId, textBlocks(text), {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: manager.session.id },
        signal: new AbortController().signal,
      })
      return { messageId }
    },
    managerSessionSeq(run) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) return 0
      return manager.session.seq
    },
  }
}

export function makeSubagentHost(adapters: HostAdapters, frozenRoute: () => { provider?: string; model?: string }): SubagentHost {
  return {
    async ensureRoleActor(run, roleKey, initialText) {
      const existing = run.roleActors[roleKey]
      if (existing !== undefined) {
        // Not expected: the engine checks this before calling. Followup is the
        // correct continuation for an existing mapping.
        const manager = adapters.managerAgentOf(run)
        if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
        const messageId = await adapters.ctx.subagents.followup(manager, existing as SessionId, textBlocks(initialText), {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: manager.session.id },
          signal: new AbortController().signal,
        })
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

      // A1 R5–R7: Node-local projection (no full manager transcript).
      // F9: read the actor's events resident-first, then through session
      // persistence — a Judge packet rebuilt for respawn/spawn-recovery runs
      // long after the actor's Activation auto-settled (DSH releases continuable
      // children when quiescent), and the durable Session log still holds the
      // node's actor history either way.
      const executorSessionId = run.nodeBoundary.executorSessionId
      let actorSession: ProjectionSource | undefined
      if (executorSessionId !== undefined) {
        const actorAgent = adapters.ctx.agents.get(SessionId(executorSessionId))
        if (actorAgent !== undefined) {
          actorSession = actorAgent.session
        } else {
          actorSession = await inspectPersistedSession(adapters.ctx, executorSessionId)
        }
      }
      const transcript = projectNodeLocal(manager.session, run.nodeBoundary, actorSession)

      const prompt = renderJudgePrompt({
        nodeToken: input.nodeToken,
        nodeInstruction: input.instruction,
        criteria: input.criteria,
        workerOutcome: input.claim.outcome,
        workerSummary: input.claim.summary,
        workspaceCwd: input.cwd,
        transcript,
      })

      const started = await adapters.ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'workflow-judge',
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

    async followupJudge(run, judgeSessionId, text) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      await adapters.ctx.subagents.followup(manager, SessionId(judgeSessionId), textBlocks(text), {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: manager.session.id },
        signal: new AbortController().signal,
      })
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
      if (manager === undefined) return
      await adapters.ctx.subagents.drainContinuableChildren(manager, [SessionId(judgeSessionId)]).catch(() => {})
    },

    async compactRoleActor(run, roleKey) {
      const childId = run.roleActors[roleKey]
      if (childId === undefined) return { ok: true, detail: 'no actor mapped' }
      // A2 R5: cold-resume (no resident agent) skips compact.
      const agent = adapters.ctx.agents.get(childId as SessionId)
      if (agent === undefined) return { ok: true, detail: 'cold-resume skip' }
      const compaction = adapters.ctx.get('compaction') as CompactionService | undefined
      if (compaction === undefined || typeof compaction.compactNow !== 'function') {
        return { ok: true, detail: 'no compaction service' }
      }
      try {
        const result = await compaction.compactNow(agent, new AbortController().signal)
        if (result === null) return { ok: true, detail: 'no compactable range' }
        return { ok: true, detail: `compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens)` }
      } catch (error) {
        if (isManualCompactionError(error)) {
          return { ok: false, detail: `compaction ${error.code}: ${error.message}` }
        }
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, detail: message }
      }
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
