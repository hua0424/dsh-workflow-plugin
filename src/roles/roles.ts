/**
 * Role Actor / Judge spawn assembly (design §2.1/§2.2 E1/E2).
 *
 * This module is pure decision logic over a narrow SubagentRuntime stub so it
 * can be unit-tested without the host. The plugin layer adapts the real
 * `ctx.subagents` service into the stub below.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { RunState, JudgeResult } from '../types.ts'

/** Judge fixed read-only allow-list (design §2.2). */
export const JUDGE_ALLOW = [
  'read',
  'glob',
  'grep',
  'read_image',
  'workflow_inspect_git',
  'workflow_inspect_github',
] as const

/** Delegation machinery names the child runtime may register into its own layer (never visible-filtered). */
export const JUDGE_MACHINERY_EXEMPT: readonly string[] = []

/**
 * Narrow spawn surface the roles module needs. The real adapter implements
 * these with ctx.subagents + ctx.agents.
 */
export interface SpawnRuntime {
  startOneShot(request: {
    label: string
    promptBlocks: unknown[]
    parent: Agent
    persona?: string
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
    agentOptions?: { provider?: string; model?: string }
    outputSchema?: unknown
  }): Promise<{ runId: string; result: Promise<{ structured?: unknown; output: unknown[]; stopReason: string }>; dispose(): Promise<void> }>
  startContinuable(request: {
    provider: string
    label: string
    promptBlocks: unknown[]
    parent: Agent
    persona?: string
    toolFilter?: { allow?: readonly string[]; deny?: readonly string[] }
    agentOptions?: { provider?: string; model?: string }
    childId?: string
  }): Promise<{ childId: string; messageId: string }>
  followup(parent: Agent, childId: string, promptBlocks: unknown[]): Promise<unknown>
}

/** Resolve a Role's effective model route: override > role def > frozen Manager route. */
export function resolveRoleModel(run: RunState, roleKey: 'judge' | string, frozen?: { provider?: string; model?: string }): { provider?: string; model?: string } {
  const override = run.modelOverrides[roleKey]
  if (override !== undefined) return { provider: override.provider, model: override.modelId }
  const def = roleKey === 'judge' ? run.definitionSnapshot.judgeRole.model : run.definitionSnapshot.roles[roleKey]?.model
  if (def !== undefined) return { provider: def.provider, model: def.modelId }
  if (frozen !== undefined && (frozen.provider !== undefined || frozen.model !== undefined)) {
    return { provider: frozen.provider, model: frozen.model }
  }
  return {} // inherit the Manager route at spawn time
}

/** The deny list for a worker role (empty when none). */
export function roleDenyList(run: RunState, roleKey: string): string[] {
  const tools = run.definitionSnapshot.roles[roleKey]?.tools
  return tools?.deny ?? []
}

/**
 * Judge spawn plan: fresh one-shot with a fixed allow-list. The plugin adapter
 * MUST verify the child's final visible schema ⊆ allow ∪ machinery before
 * dispatching (design E2); this function returns the intended plan.
 */
export function judgeSpawnPlan(run: RunState, frozen?: { provider?: string; model?: string }): {
  persona: string
  toolFilter: { allow: readonly string[] }
  agentOptions: { provider?: string; model?: string }
} {
  const route = resolveRoleModel(run, 'judge', frozen)
  return {
    persona: run.definitionSnapshot.judgeRole.persona,
    toolFilter: { allow: JUDGE_ALLOW },
    agentOptions: route,
  }
}

/** Judge structured-result contract (output schema for the one-shot spawn). */
export const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: ['PASS', 'FAIL'] },
    reason: { type: 'string' },
  },
  required: ['result', 'reason'],
  additionalProperties: false,
} as const

/** Parse a one-shot structured result into a JudgeResult; undefined when invalid. */
export function judgeResultFromStructured(structured: unknown): JudgeResult | undefined {
  if (typeof structured !== 'object' || structured === null) return undefined
  const record = structured as Record<string, unknown>
  if (record['result'] !== 'PASS' && record['result'] !== 'FAIL') return undefined
  const reason = record['reason']
  if (typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 2000) return undefined
  return { result: record['result'], reason: reason.trim() }
}

/** Types re-exported for the plugin adapter. */
export type { SubagentStartRequest, SubagentResult }
