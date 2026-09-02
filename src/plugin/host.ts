/**
 * Host adapters: wire the real DSH services into the engine's narrow
 * interfaces (design §2.3 deployment / §4 runtime).
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { StateStore } from '../state/store.ts'
import type { RunState } from '../types.ts'
import { WorkflowError } from '../types.ts'
import type { DispatchTargets, StateHost, SubagentHost, ProgramHost } from '../engine/engine.ts'
import { BUILTIN_PROGRAMS } from '../programs/catalog.ts'
import { judgeSpawnPlan, JUDGE_ALLOW, JUDGE_OUTPUT_SCHEMA, resolveRoleModel, roleDenyList } from '../roles/roles.ts'
import { projectManagerTranscript } from '../judge/projection.ts'
import { renderJudgePrompt, parseJudgeResult } from '../judge/checker.ts'

/** Fail-closed Judge tool-surface assertion (design §2.2/E2). */
function assertJudgeToolSurface(childAgent: Agent): string | undefined {
  const schemas = childAgent.ctx.tools.schemas(childAgent)
  const visible = new Set(schemas.map(s => s.name))
  for (const required of JUDGE_ALLOW) {
    if (!visible.has(required)) return `Judge tool surface is missing required tool "${required}"`
  }
  // Own-scope delegation machinery registered by the in-process driver
  // (structured_output for outputSchema children) is exempt from the
  // allow-list — it is never visible-filtered (design §2.2 machinery).
  const JUDGE_MACHINERY = new Set(['structured_output'])
  for (const name of visible) {
    if (!(JUDGE_ALLOW as readonly string[]).includes(name) && !JUDGE_MACHINERY.has(name)) {
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
  /** Register a fresh Judge session so the plugin can authorize its inspection calls. */
  registerJudgeSession(sessionId: string, cwd: string | undefined): void
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
      await adapters.ctx.subagents.followup(manager, childId as SessionId, textBlocks(text), {
        source: { kind: 'coordinator', form: 'relay', senderSessionId: manager.session.id },
        signal: new AbortController().signal,
      })
    },
  }
}

export function makeSubagentHost(adapters: HostAdapters, frozenRoute: () => { provider?: string; model?: string }): SubagentHost {
  return {
    async ensureRoleActor(run, roleKey, initialText) {
      const existing = run.roleActors[roleKey]
      if (existing !== undefined) return existing
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
      return started.childId
    },
    async runJudge(run, input) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const plan = judgeSpawnPlan(run, frozenRoute())
      const transcript = projectManagerTranscript(manager.session)
      const prompt = renderJudgePrompt({
        nodeInstruction: input.instruction,
        criteria: input.criteria,
        workerSummary: input.claim.summary,
        workerOutcome: input.claim.outcome,
        workspaceCwd: input.cwd,
        transcript,
      })
      const runHandle = await adapters.ctx.subagents.start('spawn', {
        label: 'workflow-judge',
        prompt: textBlocks(prompt),
        parent: manager,
        persona: plan.persona,
        toolFilter: plan.toolFilter,
        agentOptions: plan.agentOptions.provider !== undefined || plan.agentOptions.model !== undefined
          ? { provider: plan.agentOptions.provider, model: plan.agentOptions.model }
          : undefined,
        outputSchema: JUDGE_OUTPUT_SCHEMA as never,
        signal: new AbortController().signal,
      })
      try {
        // Fail-closed: the Judge must see exactly the fixed allow-list plus
        // delegation machinery. Any deviation aborts the evaluation.
        if (runHandle.localAgent !== undefined) {
          const surfaceProblem = assertJudgeToolSurface(runHandle.localAgent)
          if (surfaceProblem !== undefined) {
            return undefined
          }
          adapters.registerJudgeSession(runHandle.id, input.cwd)
        }
        const result = await runHandle.result
        if (result.stopReason !== 'completed' || result.structured === undefined) return undefined
        return parseJudgeResult(JSON.stringify(result.structured))
      } catch {
        return undefined
      } finally {
        await runHandle.dispose()
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
