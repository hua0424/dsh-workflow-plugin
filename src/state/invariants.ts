/** Run / 工作单的持久化边界；坏材料不交给 Runtime 猜测恢复。 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { workflowConfigSchema } from '../catalog/schema.ts'
import { computeDefinitionHash } from '../catalog/validate.ts'
import { LIMITS, type CallFrame, type NodeExecution, type RunState } from '../types.ts'

const text = z.string().min(1)
const revision = z.number().int().nonnegative()
const dispatch = z.object({ id: text, sessionId: text.optional(), messageId: text.optional(), settled: z.boolean() }).strict()
const judge = dispatch.extend({ sessionId: text, claimId: text, inputVersion: revision })
const claim = z.object({ id: text, dispatchId: text, outcome: z.enum(['completed', 'failed']), handoff: z.string().trim().min(1).max(LIMITS.handoffMax) }).strict()
const frame = z.object({ workflowId: text, nodeId: text, nodeToken: z.uuid() }).strict()
const model = z.object({ provider: text, modelId: text }).strict()
const runSchema = z.object({
  runId: text, managerSessionId: text, catalogWorkflowId: text, definitionHash: text,
  definitionSnapshot: workflowConfigSchema, status: z.enum(['running', 'blocked', 'completed']),
  callStack: z.array(frame), roleActors: z.record(z.string(), text), modelOverrides: z.record(z.string(), model),
  blockReason: text.nullable(), currentExecutionId: text, traceLogPath: text.optional(),
}).strict()
const executionSchema = z.object({
  executionId: text, runId: text, workflowId: text, nodeId: text, nodeToken: z.uuid(),
  visit: z.number().int().positive(), revision, input: z.string(),
  phase: z.enum(['ready', 'working', 'checking', 'settling', 'exited']),
  predecessorId: text.optional(), successorId: text.optional(),
  boundary: z.object({ dispatchedAt: revision, managerFromSeq: revision, executorSessionId: text.optional(), executorDispatchMessageId: text.optional() }).strict().optional(),
  dispatch: dispatch.optional(), claim: claim.optional(), previousClaim: claim.optional(),
  judge: judge.optional(), previousJudge: judge.optional(),
  judgment: z.object({
    result: z.enum(['ACCEPT', 'REJECT', 'NEED_CONTEXT']), reason: z.string().trim().min(1).max(LIMITS.reasonMax),
    claimId: text, judgeDispatchId: text, judgeSessionId: text, inputVersion: revision,
  }).strict().optional(),
  resolution: z.object({
    target: z.enum(['actor', 'judge']), context: z.string().trim().min(LIMITS.resolutionMin).max(LIMITS.resolutionMax).optional(),
    decision: z.string().trim().min(1).max(LIMITS.reasonMax).optional(), inputVersion: revision,
  }).strict().optional(),
  inputVersion: revision, blockReason: text.nullable(), enteredAt: z.iso.datetime(), exitedAt: z.iso.datetime().optional(),
}).strict()

export function newNodeToken(): string { return randomUUID() }

/** Validate shape without transforming persisted opaque materials. */
export function checkExecutionInvariants(run: RunState, execution: NodeExecution): string[] {
  const result = executionSchema.safeParse(execution)
  if (!result.success) return [result.error.message]
  const problems: string[] = []
  if (execution.runId !== run.runId) problems.push('execution belongs to another run')
  const def = execution.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[execution.workflowId]
  if (!def?.nodes[execution.nodeId]) problems.push('execution position is absent from definitionSnapshot')
  if ((execution.phase === 'exited') !== (execution.exitedAt !== undefined)) problems.push('exited phase/time mismatch')
  if (execution.claim && execution.claim.dispatchId !== execution.dispatch?.id) problems.push('claim dispatch mismatch')
  if (execution.judge && (execution.judge.claimId !== execution.claim?.id || execution.judge.inputVersion !== execution.inputVersion)) problems.push('judge claim/input mismatch')
  const currentJudgment = execution.judgment !== undefined
    && execution.judgment.inputVersion === execution.inputVersion
    && execution.judgment.claimId === execution.claim?.id
  if (execution.previousJudge && (!execution.judgment || currentJudgment)) problems.push('previous Judge requires a historical judgment')
  if (execution.judgment) {
    const judgedClaim = execution.judgment.claimId === execution.claim?.id ? execution.claim : execution.previousClaim
    if (execution.judgment.claimId !== judgedClaim?.id) problems.push('judgment claim mismatch')
    if (currentJudgment && execution.judgment.result === 'REJECT') problems.push('REJECT cannot be a current judgment')
    if (execution.judgment.result === 'ACCEPT' && !currentJudgment) problems.push('ACCEPT must be the current conclusion')
    if (!currentJudgment && execution.judgment.result === 'REJECT' && execution.judgment.claimId !== execution.previousClaim?.id) problems.push('historical REJECT must target previous claim')
    if (currentJudgment && (execution.judgment.judgeDispatchId !== execution.judge?.id
      || execution.judgment.judgeSessionId !== execution.judge?.sessionId)) problems.push('judgment dispatch/session mismatch')
    if (!currentJudgment) {
      if (execution.judgment.inputVersion >= execution.inputVersion) problems.push('historical judgment must have an older input version')
      if (execution.judgment.judgeDispatchId !== execution.previousJudge?.id
        || execution.judgment.judgeSessionId !== execution.previousJudge?.sessionId
        || execution.judgment.claimId !== execution.previousJudge?.claimId
        || execution.judgment.inputVersion !== execution.previousJudge?.inputVersion) problems.push('historical judgment/Judge mismatch')
    }
  }
  if (execution.resolution && !execution.resolution.context && !execution.resolution.decision) problems.push('resolution requires context or decision')
  if (execution.resolution?.inputVersion !== undefined && execution.resolution.inputVersion !== execution.inputVersion) problems.push('resolution input version mismatch')
  if (execution.resolution?.target === 'judge' && !execution.claim) problems.push('judge resolution requires claim')
  if (execution.phase === 'checking' && !execution.claim) problems.push('checking requires claim')
  return problems
}

export function checkStateInvariants(run: RunState, execution?: NodeExecution): string[] {
  const result = runSchema.safeParse(run)
  if (!result.success) return [result.error.message]
  const problems: string[] = []
  if (computeDefinitionHash(run.definitionSnapshot) !== run.definitionHash) problems.push('definitionSnapshot hash mismatch')
  if (run.status === 'completed' ? run.callStack.length !== 0 : run.callStack.length === 0) problems.push('status/callStack mismatch')
  if (run.status !== 'blocked' && run.blockReason !== null) problems.push('status/blockReason mismatch')
  const tokens = new Set(run.callStack.map(f => f.nodeToken))
  if (tokens.size !== run.callStack.length) problems.push('nodeToken duplicates in callStack')
  for (const [index, f] of run.callStack.entries()) {
    const def = f.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[f.workflowId]
    if (!def?.nodes[f.nodeId]) problems.push('frame position is absent from definitionSnapshot')
    if (index === 0 && f.workflowId !== run.catalogWorkflowId) problems.push('first frame must be root')
    if (index > 0) {
      const parent = run.callStack[index - 1]!
      const node = workflowOf(run, parent).nodes[parent.nodeId] as { execution?: { type: string; workflowId?: string } } | undefined
      if (node?.execution?.type !== 'child-workflow' || node.execution.workflowId !== f.workflowId) problems.push('child frame does not match parent call')
    }
  }
  for (const key of Object.keys(run.roleActors)) if (!(key in run.definitionSnapshot.roles)) problems.push(`unknown roleActors key: ${key}`)
  for (const key of Object.keys(run.modelOverrides)) if (key !== 'judge' && !(key in run.definitionSnapshot.roles)) problems.push(`unknown modelOverrides key: ${key}`)
  if (execution) {
    problems.push(...checkExecutionInvariants(run, execution))
    if (run.status === 'blocked' && !(run.blockReason?.trim() || execution.blockReason?.trim())) problems.push('blocked run requires a control or execution reason')
    if (run.currentExecutionId !== execution.executionId) problems.push('currentExecutionId mismatch')
    if (run.status === 'completed') {
      if (execution.phase !== 'exited' || execution.successorId) problems.push('completed must point to terminal execution')
    } else {
      const top = run.callStack.at(-1)
      if (!top || top.workflowId !== execution.workflowId || top.nodeId !== execution.nodeId || top.nodeToken !== execution.nodeToken) problems.push('current execution/callStack mismatch')
      if (execution.phase === 'exited') problems.push('active run points to exited execution')
    }
  }
  return problems
}

export function topFrame(run: RunState): CallFrame {
  const frame = run.callStack.at(-1)
  if (!frame) throw new Error('call stack is empty')
  return frame
}

export function workflowOf(run: RunState, frame: CallFrame): { startNode: string; nodes: Record<string, unknown> } {
  const def = frame.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[frame.workflowId]
  if (!def) throw new Error(`unknown workflow id in frame: ${frame.workflowId}`)
  return def
}
