/**
 * Run-state invariants and token helpers (design §5 C2).
 */
import { randomUUID } from 'node:crypto'
import type { CallFrame, RunState } from '../types.ts'

/** Mint a fresh node token (design §5 nodeToken). */
export function newNodeToken(): string {
  return randomUUID()
}

/**
 * Check the strict state invariants. Returns a list of violations (empty = ok).
 */
export function checkStateInvariants(run: RunState): string[] {
  const problems: string[] = []
  if (run.status === 'completed') {
    if (run.callStack.length !== 0) problems.push('completed run must have an empty callStack')
    if (run.blockReason !== null) problems.push('completed run must have null blockReason')
  } else {
    if (run.callStack.length === 0) problems.push(`${run.status} run must have a non-empty callStack`)
  }
  if (run.status === 'blocked') {
    if (run.blockReason === null || run.blockReason.trim() === '') problems.push('blocked run must have a non-empty blockReason')
  } else {
    if (run.blockReason !== null) problems.push(`${run.status} run must have null blockReason`)
  }
  const tokens = new Set<string>()
  for (const frame of run.callStack) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frame.nodeToken)) {
      problems.push(`frame ${frame.workflowId}:${frame.nodeId} has a non-UUID nodeToken`)
    }
    tokens.add(frame.nodeToken)
  }
  if (tokens.size !== run.callStack.length) problems.push('nodeToken duplicates in callStack')
  const roleKeys = Object.keys(run.definitionSnapshot.roles)
  for (const key of Object.keys(run.roleActors)) {
    if (!roleKeys.includes(key)) problems.push(`roleActors key "${key}" is not in the definition roles`)
  }
  for (const key of Object.keys(run.modelOverrides)) {
    if (key !== 'judge' && !roleKeys.includes(key)) problems.push(`modelOverrides key "${key}" is neither a role nor "judge"`)
  }
  return problems
}

/** Top frame of the call stack (throws when empty). */
export function topFrame(run: RunState): CallFrame {
  const frame = run.callStack[run.callStack.length - 1]
  if (frame === undefined) throw new Error('call stack is empty')
  return frame
}

/** Workflow definition for a frame, from the snapshot. */
export function workflowOf(run: RunState, frame: CallFrame): { startNode: string; nodes: Record<string, unknown> } {
  const def = frame.workflowId === run.catalogWorkflowId
    ? run.definitionSnapshot.workflow
    : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
  if (def === undefined) throw new Error(`unknown workflow id in frame: ${frame.workflowId}`)
  return def as { startNode: string; nodes: Record<string, unknown> }
}
