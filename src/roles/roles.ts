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
import { readRoleDefModel, readRoleFallbackModel, type DelegationRoute, type RoleRouteStage, type RunState } from '../types.ts'
import { ROLE_ACTOR_SUBMISSION_PROTOCOL } from '../engine/texts.ts'

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

/**
 * #235：角色当前生效的路由阶段。无阶段记录时按旧行为解释——
 * 有 override 视为 `manual`（存量 Run 的 workflow_set_role_model 结果照常生效），
 * 否则 `primary`。
 */
export function effectiveRoleRouteStage(run: RunState, roleKey: string): RoleRouteStage {
  const declared = run.roleRoutes?.[roleKey]?.stage
  if (declared !== undefined) return declared
  return run.modelOverrides[roleKey] === undefined ? 'primary' : 'manual'
}

/** #235：角色配置的备用路由（未配置即 undefined——此时不引入任何人工恢复链）。 */
export function roleFallbackRoute(run: RunState, roleKey: string): DelegationRoute | undefined {
  return readRoleFallbackModel(run.definitionSnapshot, roleKey)
}

/**
 * 主路由（忽略 override）：显式 catalog model，缺省回落到本 Run 冻结的默认路由。
 * 启动期主备冲突检查与运行期「切到备用会不会是同一个模型」判定共用。
 */
export function rolePrimaryRoute(run: RunState, roleKey: string, frozen?: DelegationRoute): DelegationRoute {
  return readRoleDefModel(run.definitionSnapshot, roleKey) ?? frozen ?? {}
}

/**
 * Resolve a Role's effective model route: 阶段 > override > role def > frozen
 * Manager route. def 分支走共享单源。#118 D-91-1：三条分支全是领域事实
 * （`modelId`），直接返回 `DelegationRoute`，交界处不再有逐字段的匿名形状转换。
 * #235：`fallback` 阶段用该角色的备用路由（未配置则回落旧链，fail-closed 不猜）。
 */
export function resolveRoleModel(run: RunState, roleKey: 'judge' | string, frozen?: DelegationRoute): DelegationRoute {
  const stage = effectiveRoleRouteStage(run, roleKey)
  if (stage === 'fallback') {
    const fallback = roleFallbackRoute(run, roleKey)
    if (fallback !== undefined) return fallback
  }
  // `primary` 显式忽略 override（切回主模型后旧 override 不再生效）；其余阶段沿用
  // override > def > frozen。
  if (stage !== 'primary') {
    const override = run.modelOverrides[roleKey]
    if (override !== undefined) return override
  }
  const def = readRoleDefModel(run.definitionSnapshot, roleKey)
  if (def !== undefined) return def
  return frozen ?? {} // inherit the Manager route at spawn time
}

/** The deny list for a worker role (empty when none). */
export function roleDenyList(run: RunState, roleKey: string): string[] {
  const tools = run.definitionSnapshot.roles[roleKey]?.tools
  return tools?.deny ?? []
}

/**
 * Issue #140：公共 persona 与角色专属 persona 的组合分隔符（单源）。
 * 公共规则先建立上下文，角色专属职责紧随其后；缺省（未配置）时不拼接。
 */
export const ACTOR_PERSONA_SEPARATOR = '\n\n'

/**
 * Issue #140：Role Actor system persona 的唯一组合函数。spawn 路径（host.ts
 * ensureRoleActor）与冷恢复后的一切读取都走这里：只读冻结快照，
 * 不改写快照中的 role persona，因此重复调用不会叠加。
 * Issue #226：末尾固定追加提交协议（公共 persona → 角色 persona → 固定
 * 协议；缺省公共 persona 时为角色 persona → 固定协议）。Judge 与 Manager
 * 不经过此函数，不受影响。
 */
export function roleActorPersona(run: RunState, roleKey: string): string {
  const rolePersona = run.definitionSnapshot.roles[roleKey]?.persona ?? ''
  const common = run.definitionSnapshot.actorCommonPersona
  const base = common === undefined ? rolePersona : `${common}${ACTOR_PERSONA_SEPARATOR}${rolePersona}`
  return base === '' ? ROLE_ACTOR_SUBMISSION_PROTOCOL : `${base}${ACTOR_PERSONA_SEPARATOR}${ROLE_ACTOR_SUBMISSION_PROTOCOL}`
}

/**
 * Judge spawn plan: fresh continuable (A1 R8) whose tool surface is the full
 * catalog minus the effective deny list. The plugin adapter MUST verify the
 * child's final visible schema contains no denied tool before dispatching
 * (design E2); this function returns the intended plan.
 */
export function judgeSpawnPlan(run: RunState, frozen?: DelegationRoute): {
  persona: string
  toolFilter: { deny: readonly string[] }
  agentOptions: DelegationRoute
} {
  const route = resolveRoleModel(run, 'judge', frozen)
  return {
    persona: run.definitionSnapshot.judgeRole.persona,
    toolFilter: { deny: judgeDenyList(run) },
    agentOptions: route,
  }
}
