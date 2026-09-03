/**
 * Tool-call authorization policy (design §5.2 G8), extracted as a pure
 * function for direct unit testing. The plugin layer feeds it live session
 * mappings and registers them back on success.
 */
import type { RunState } from '../types.ts'

export type AuthzDecision =
  | { allow: true; kind: 'manager' }
  | { allow: true; kind: 'role'; roleKey: string }
  | { allow: true; kind: 'judge' }
  | { allow: false; reason: string }

/** Tools a mapped Role Actor may call (design §5.2). */
const ROLE_ALLOWED = new Set(['node_claim', 'node_block', 'workflow_status'])

/** Tools a fresh Judge may call (two read-only wrappers + judge_claim). */
const JUDGE_ALLOWED = new Set(['workflow_inspect_git', 'workflow_inspect_github', 'judge_claim'])

export interface AuthzInput {
  run: RunState
  sessionId: string
  /** Live role mapping when known; the policy also scans roleActors directly
   *  so cold-resumed actors still resolve after a host restart. */
  knownRoleOfSession: string | undefined
  isJudgeSession: boolean
  toolName: string
}

export function authorizeToolCall(input: AuthzInput): AuthzDecision {
  const { run, sessionId, toolName } = input

  if (input.isJudgeSession) {
    if (JUDGE_ALLOWED.has(toolName)) return { allow: true, kind: 'judge' }
    return { allow: false, reason: 'judge sessions may only call the read-only inspection tools' }
  }

  if (run.managerSessionId === sessionId) {
    return { allow: true, kind: 'manager' }
  }

  // Role actors: prefer the live mapping, fall back to the durable roleActors
  // table (cold resume after a host restart keeps the child id in roleActors).
  const actorRole = input.knownRoleOfSession
    ?? Object.entries(run.roleActors).find(([, actorId]) => actorId === sessionId)?.[0]
  if (actorRole !== undefined && run.roleActors[actorRole] === sessionId) {
    if (ROLE_ALLOWED.has(toolName)) return { allow: true, kind: 'role', roleKey: actorRole }
    return { allow: false, reason: `role "${actorRole}" may not call ${toolName}` }
  }

  return { allow: false, reason: 'only the current Run Manager or a mapped Role Actor may call workflow tools' }
}
