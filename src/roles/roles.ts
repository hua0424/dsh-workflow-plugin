/**
 * Role Actor / Judge spawn assembly (design §2.1/§2.2 E1/E2).
 *
 * Pure decision logic (route resolution, deny lists, judge tool surface) that
 * can be unit-tested without the host. The plugin layer adapts the real
 * `ctx.subagents` service.
 *
 * Judge tool surface (Issue #25): the Judge inherits the full tool catalog and
 * the surface is narrowed by a deny list, exactly like a worker Role — the
 * default deny list below plus the catalog's optional `judgeRole.tools.deny`.
 * The three enforcement layers (spawn filter here, spawn assertion in host.ts,
 * runtime gate in tools/authz.ts) all derive from this one source.
 */
import { readRoleDefModel, type RunState } from '../types.ts'

/**
 * Tools the Judge must always have: the `judge_claim` protocol tool (A1 R9)
 * plus the core read-only inspection surface. Never deniable.
 */
export const JUDGE_REQUIRED_TOOLS = ['read', 'glob', 'grep', 'read_image', 'workflow_inspect_git', 'workflow_inspect_github', 'judge_claim'] as const

/**
 * Default deny list: file-write tools plus the workflow control tools that
 * mutate Run state. The Judge is a read-only confirmer, so these stay invisible
 * unless an operator explicitly removes them from the deny list (catalog
 * `judgeRole.tools.deny`).
 *
 * Maintenance obligation (Issue #25 "注意"): DSH may add new host tools with
 * side effects; the Judge keeps full-catalog visibility, so this list must be
 * extended in the plugin release that starts relying on such a tool.
 */
export const JUDGE_DEFAULT_DENY = [
  'edit',
  'write',
  'node_claim',
  'node_block',
  'node_resume',
  'node_run_program',
  'node_resolve_program',
  'workflow_set_role_model',
  'judge_respawn',
] as const

/**
 * Delegation machinery names the child runtime may register into its own
 * layer (never visible-filtered). Single source of truth for the
 * fail-closed tool-surface assertion (used by the plugin adapter, host.ts).
 */
export const JUDGE_MACHINERY_EXEMPT = ['report', 'structured_output'] as const

/**
 * Denying any of these is a hard deadlock (the Judge could no longer claim, the
 * driver could no longer deliver its verdict), so the catalog schema rejects it.
 */
export const JUDGE_PROTECTED_TOOLS = [...JUDGE_REQUIRED_TOOLS, ...JUDGE_MACHINERY_EXEMPT] as const

/** Effective Judge deny list: the plugin defaults ∪ the catalog's extra entries. */
export function judgeDenyList(run: RunState): string[] {
  const extra = run.definitionSnapshot.judgeRole.tools?.deny ?? []
  return [...new Set<string>([...JUDGE_DEFAULT_DENY, ...extra])]
}

/**
 * Intersect a deny list with the tools the running profile actually ships.
 * `ctx.tools.restrict()` faults on unknown global names, and the default list
 * names host tools (`edit`/`write`) that a minimal profile does not register —
 * denying an absent tool is a no-op, so dropping it preserves the intent instead
 * of faulting every Judge spawn.
 */
export function knownDenyList(deny: readonly string[], available: Iterable<string>): string[] {
  const known = new Set(available)
  return deny.filter(name => known.has(name))
}

/**
 * Judge subagent display label carrying the current node id, aligned with the
 * role-actor naming style (`workflow-role:<roleKey>`). Pure so it can be unit
 * tested without the host.
 */
export function judgeLabel(nodeId: string): string {
  return `workflow-judge:${nodeId}`
}

/** Resolve a Role's effective model route: override > role def > frozen Manager route. def 分支走共享单源。 */
export function resolveRoleModel(run: RunState, roleKey: 'judge' | string, frozen?: { provider?: string; model?: string }): { provider?: string; model?: string } {
  const override = run.modelOverrides[roleKey]
  if (override !== undefined) return { provider: override.provider, model: override.modelId }
  const def = readRoleDefModel(run.definitionSnapshot, roleKey)
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
 * Judge spawn plan: fresh continuable (A1 R8) whose tool surface is the full
 * catalog minus the effective deny list. The plugin adapter MUST verify the
 * child's final visible schema contains no denied tool before dispatching
 * (design E2); this function returns the intended plan.
 */
export function judgeSpawnPlan(run: RunState, frozen?: { provider?: string; model?: string }): {
  persona: string
  toolFilter: { deny: readonly string[] }
  agentOptions: { provider?: string; model?: string }
} {
  const route = resolveRoleModel(run, 'judge', frozen)
  return {
    persona: run.definitionSnapshot.judgeRole.persona,
    toolFilter: { deny: judgeDenyList(run) },
    agentOptions: route,
  }
}
