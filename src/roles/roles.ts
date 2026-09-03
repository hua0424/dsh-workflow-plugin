/**
 * Role Actor / Judge spawn assembly (design §2.1/§2.2 E1/E2).
 *
 * Pure decision logic (route resolution, deny lists, judge allow-list) that can
 * be unit-tested without the host. The plugin layer adapts the real
 * `ctx.subagents` service.
 */
import type { RunState } from '../types.ts'

/** Judge fixed read-only allow-list (design §2.2) + the `judge_claim` protocol tool (A1 R9). */
export const JUDGE_ALLOW = [
  'read',
  'glob',
  'grep',
  'read_image',
  'workflow_inspect_git',
  'workflow_inspect_github',
  'judge_claim',
] as const

/** Delegation machinery names the child runtime may register into its own layer (never visible-filtered). */
export const JUDGE_MACHINERY_EXEMPT: readonly string[] = []

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
 * Judge spawn plan: fresh continuable with a fixed allow-list (A1 R8). The
 * plugin adapter MUST verify the child's final visible schema ⊆ allow ∪
 * machinery before dispatching (design E2); this function returns the intended
 * plan.
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
