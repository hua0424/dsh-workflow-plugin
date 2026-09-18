/** Run / 工作单的持久化边界；坏材料不交给 Runtime 猜测恢复。 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { workflowConfigSchema } from '../catalog/schema.ts'
import { computeDefinitionHash } from '../catalog/validate.ts'
import { LIMITS, ID_PATTERN, declaredResults, type CallFrame, type NodeDef, type NodeExecution, type RunState } from '../types.ts'

const text = z.string().min(1)
const revision = z.number().int().nonnegative()
const dispatch = z.object({ id: text, sessionId: text.optional(), messageId: text.optional(), settled: z.boolean() }).strict()
const route = z.object({ provider: text.optional(), modelId: text.optional() }).strict()
const judge = dispatch.extend({ sessionId: text, claimId: text, inputVersion: revision, model: route.optional() })
// v3: claim 携带一个已声明的节点结果名（result），不再有 outcome。
const claim = z.object({ id: text, dispatchId: text, result: z.string().regex(ID_PATTERN), handoff: z.string().trim().min(1).max(LIMITS.handoffMax) }).strict()
const frame = z.object({ workflowId: text, nodeId: text, nodeToken: z.uuid(), executionId: text }).strict()
const model = z.object({ provider: text, modelId: text }).strict()
const runSchema = z.object({
  runId: text, managerSessionId: text, catalogWorkflowId: text, definitionHash: text,
  definitionSnapshot: workflowConfigSchema, status: z.enum(['running', 'blocked', 'completed', 'terminated']),
  callStack: z.array(frame), roleActors: z.record(z.string(), text), modelOverrides: z.record(z.string(), model),
  blockReason: text.nullable(), currentExecutionId: text, traceLogPath: text.optional(),
  // #91: 启动时冻结的默认模型路由；旧 Run 无该字段（不得由运行时补造）。
  delegationRoute: z.object({ provider: text.optional(), modelId: text.optional() }).strict().optional(),
  // v3: 已确认的业务终局（名字 + 终局来源 executionId）；handoff 不做第二份镜像。
  businessReturn: z.object({ name: z.string().regex(ID_PATTERN), source: text }).strict().optional(),
}).strict()
const executionSchema = z.object({
  executionId: text, runId: text, workflowId: text, nodeId: text, nodeToken: z.uuid(),
  visit: z.number().int().positive(), revision, input: z.string(),
  phase: z.enum(['ready', 'working', 'checking', 'settling', 'exited']), roleBoundaryPrepared: z.boolean(), restartPending: z.boolean(),
  predecessorId: text.optional(), successorId: text.optional(),
  boundary: z.object({ dispatchedAt: revision, managerFromSeq: revision, executorSessionId: text.optional(), executorDispatchMessageId: text.optional() }).strict().optional(),
  dispatch: dispatch.optional(), claim: claim.optional(), previousClaim: claim.optional(),
  judge: judge.optional(), previousJudge: judge.optional(),
  judgment: z.object({
    result: z.enum(['ACCEPT', 'REJECT', 'NEED_CONTEXT']), reason: z.string().trim().min(1).max(LIMITS.reasonMax),
    claimId: text, judgeDispatchId: text, judgeSessionId: text, inputVersion: revision,
  }).strict().optional(),
  resolution: z.object({
    target: z.enum(['actor', 'judge', 'child']), context: z.string().trim().min(LIMITS.resolutionMin).max(LIMITS.resolutionMax).optional(),
    decision: z.string().trim().min(1).max(LIMITS.reasonMax).optional(), judgeMode: z.enum(['followup', 'fresh']).optional(),
    judgeSessionId: text.optional(), inputVersion: revision,
  }).strict().optional(),
  program: z.object({
    id: text,
    parameters: z.record(z.string(), z.union([z.string().max(LIMITS.programParametersMax), z.number().finite()])),
    result: z.union([
      z.object({ kind: z.enum(['PASS', 'FAIL']), handoff: z.string().trim().min(1).max(LIMITS.handoffMax), reason: z.string().max(LIMITS.blockReasonMax).optional() }).strict(),
      z.object({ kind: z.literal('ERROR'), reason: z.string().trim().min(1).max(LIMITS.blockReasonMax) }).strict(),
    ]).optional(),
  }).strict().optional(),
  child: z.object({
    workflowId: text, executionId: text,
    result: z.object({ terminalExecutionId: text, handoff: z.string().trim().min(1).max(LIMITS.handoffMax) }).strict().optional(),
  }).strict().optional(),
  inputVersion: revision, blockReason: text.nullable(), enteredAt: z.iso.datetime(), exitedAt: z.iso.datetime().optional(),
  /**
   * v3：本工作单退出时实际裁决的终局名。`result` = 节点结果名（节点退出），
   * `return` = 流程返回名（本流程正常结束，Root 时即 Run 的业务终局）。
   * 名字语法在下面的跨字段校验里按种类分别判定（Program 的结果键是协议固定的
   * `PASS`/`FAIL`，不受业务结果名的小写标识符规则约束），此处只要求有界字符串。
   */
  returned: z.object({ kind: z.enum(['result', 'return']), name: z.string().min(1).max(64), source: text }).strict().optional(),
}).strict()

export function newNodeToken(): string { return randomUUID() }

/** Validate shape without transforming persisted opaque materials. */
export function checkExecutionInvariants(run: RunState, execution: NodeExecution): string[] {
  const result = executionSchema.safeParse(execution)
  if (!result.success) return [result.error.message]
  const problems: string[] = []
  if (execution.runId !== run.runId) problems.push('execution belongs to another run')
  const def = execution.workflowId === run.catalogWorkflowId ? run.definitionSnapshot.workflow : run.definitionSnapshot.childWorkflows?.[execution.workflowId]
  const node = def?.nodes[execution.nodeId]
  if (!node) problems.push('execution position is absent from definitionSnapshot')
  if (execution.program && node?.execution.type !== 'builtin-program') problems.push('Program materials require a builtin-program execution')
  if (execution.child && (node?.execution.type !== 'child-workflow' || execution.child.workflowId !== node.execution.workflowId)) problems.push('Child materials do not match the child-workflow execution')
  if (node?.execution.type === 'builtin-program') {
    if (execution.dispatch || execution.boundary || execution.claim || execution.previousClaim || execution.judge || execution.previousJudge || execution.judgment || execution.resolution) problems.push('builtin-program cannot carry Actor/Judge materials')
    if (execution.phase === 'checking') problems.push('builtin-program cannot enter checking')
    if (execution.phase === 'ready' && execution.program) problems.push('ready Program cannot have an invocation')
    if (execution.phase === 'working' && (!execution.program || execution.program.result)) problems.push('working Program requires one unresolved invocation')
    if (execution.phase === 'settling' && !execution.program?.result) problems.push('settling Program requires a known result')
    if (execution.phase === 'exited' && (!execution.program?.result || execution.program.result.kind === 'ERROR')) problems.push('exited Program requires PASS or FAIL result')
  }
  if (node?.execution.type === 'child-workflow') {
    if (execution.dispatch || execution.boundary || execution.claim || execution.previousClaim || execution.judge || execution.previousJudge || execution.judgment || execution.program) problems.push('child-workflow cannot carry Actor/Judge/Program materials')
    if (execution.resolution && execution.resolution.target !== 'child') problems.push('Child recovery metadata must target child')
    if (execution.phase === 'checking' || execution.phase === 'settling') problems.push('child-workflow has no checking or settling phase')
    if (execution.phase === 'ready' && execution.child) problems.push('ready Child caller cannot have an invocation')
    if (execution.phase === 'working' && (!execution.child || execution.child.result)) problems.push('working Child caller requires one pending Child')
    if (execution.phase === 'exited' && !execution.child?.result) problems.push('exited Child caller requires a returned Child result')
  }
  if ((execution.phase === 'exited') !== (execution.exitedAt !== undefined)) problems.push('exited phase/time mismatch')
  // v3: 终局裁决名（节点结果名或流程返回名）随工作单材料保留，供 status/通知/trace 解释。
  if (execution.returned !== undefined) {
    if (execution.phase !== 'exited') problems.push('returned is only valid on an exited execution')
    if (execution.returned.source !== execution.executionId) problems.push('returned source must be this execution')
    // 语法按种类分别判定：流程返回名是本流程声明的小写标识符；节点结果名只需在**本节点
    // 声明**中（Program 的结果键是协议固定的 PASS/FAIL）。
    if (execution.returned.kind === 'return') {
      if (!ID_PATTERN.test(execution.returned.name)) problems.push('workflow return name must be a lowercase id')
      else if (!def?.returns.includes(execution.returned.name)) problems.push('workflow return name is not declared by this workflow')
    } else if (!!node && !declaredResults(node).includes(execution.returned.name)) {
      problems.push('node result name is not declared by this node')
    }
  }
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
  if (execution.resolution?.target === 'judge' && !currentJudgment && !execution.resolution.judgeMode) problems.push('judge resolution requires a recovery mode')
  if (execution.resolution?.target === 'judge' && currentJudgment && (execution.resolution.judgeMode || execution.resolution.judgeSessionId)) problems.push('current judgment cannot retain Judge recovery mode')
  if (execution.resolution?.target !== 'judge' && (execution.resolution?.judgeMode || execution.resolution?.judgeSessionId)) problems.push('Judge recovery metadata requires judge target')
  if (execution.resolution?.judgeMode === 'followup' ? !execution.resolution.judgeSessionId : execution.resolution?.judgeSessionId !== undefined) problems.push('Judge followup requires exactly one Session id')
  if (execution.resolution?.judgeMode === 'followup') {
    const historicalNeedContext = execution.judgment?.result === 'NEED_CONTEXT' && !currentJudgment
      && execution.judgment.claimId === execution.claim?.id && execution.previousJudge !== undefined
      && execution.judgment.judgeDispatchId === execution.previousJudge.id
      && execution.judgment.judgeSessionId === execution.previousJudge.sessionId
      && execution.resolution.judgeSessionId === execution.previousJudge.sessionId
    const currentRecoveryDispatch = execution.judge !== undefined && !currentJudgment
      && execution.judge.claimId === execution.claim?.id && execution.judge.inputVersion === execution.inputVersion
      && execution.resolution.judgeSessionId === execution.judge.sessionId
    if (!historicalNeedContext && !currentRecoveryDispatch) problems.push('Judge followup must bind the exact current recovery or historical NEED_CONTEXT Judge')
  }
  if (execution.phase === 'checking' && !execution.claim) problems.push('checking requires claim')
  return problems
}

export function checkStateInvariants(run: RunState, execution?: NodeExecution): string[] {
  const result = runSchema.safeParse(run)
  if (!result.success) return [result.error.message]
  const problems: string[] = []
  if (computeDefinitionHash(run.definitionSnapshot) !== run.definitionHash) problems.push('definitionSnapshot hash mismatch')
  if (run.status === 'completed' ? run.callStack.length !== 0 : run.callStack.length === 0) problems.push('status/callStack mismatch')
  // v3: 业务终局只在 completed 且只由终局工作单承载；terminated 不制造返回值。
  if (run.status !== 'completed' && run.businessReturn !== undefined) problems.push('only a completed run carries a business return')
  if (run.status === 'completed' && run.businessReturn !== undefined) {
    if (!run.definitionSnapshot.workflow.returns.includes(run.businessReturn.name)) problems.push('business return name is not declared by the root workflow')
    if (run.businessReturn.source !== run.currentExecutionId) problems.push('business return source must be the terminal execution')
  }
  if ((run.status === 'running' || run.status === 'completed') && run.blockReason !== null) problems.push('status/blockReason mismatch')
  if (run.status === 'terminated' && !run.blockReason?.trim()) problems.push('terminated run requires a reason')
  const tokens = new Set(run.callStack.map(f => f.nodeToken))
  if (tokens.size !== run.callStack.length) problems.push('nodeToken duplicates in callStack')
  if (new Set(run.callStack.map(f => f.executionId)).size !== run.callStack.length) problems.push('executionId duplicates in callStack')
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
      // v3：终局裁决名必须有材料（节点结果名或流程返回名）；否则 status 无法解释终局。
      if (execution.returned === undefined) problems.push('completed run requires a terminal decision on its work order')
    } else {
      const top = run.callStack.at(-1)
      if (!top || top.executionId !== execution.executionId || top.workflowId !== execution.workflowId || top.nodeId !== execution.nodeId || top.nodeToken !== execution.nodeToken) problems.push('current execution/callStack mismatch')
      if (run.status !== 'terminated' && execution.phase === 'exited') problems.push('active run points to exited execution')
      if (run.status === 'terminated' && !execution.blockReason?.trim()) problems.push('terminated execution requires a reason')
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
