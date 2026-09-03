/**
 * The workflow-control tools (design §5.2 G1-G9) + the read-only inspection
 * wrappers. Pure definitions + execute closures over a ToolHost interface, so
 * the whole tool layer is unit-testable without the host.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { LIMITS, type ClaimOutcome } from '../types.ts'

/** Length-check a tool text argument per the design bounds. */
function lengthError(field: string, value: string | undefined, min: number, max: number, required: boolean): string | undefined {
  const trimmed = (value ?? '').trim()
  if (required && trimmed === '') return `${field} is required`
  if (trimmed.length < min) return `${field} must be at least ${min} characters after trim`
  if (trimmed.length > max) return `${field} must be at most ${max} characters after trim`
  return undefined
}

/** Host services the tools need (wired by the plugin). */
export interface ToolHost {
  /**
   * Authorize a workflow-control tool call from `agent` (the exec's caller).
   * Resolves to the run's workspace key when allowed (Manager or mapped Role
   * Actor of the current run); rejects with a reason otherwise (design §5.2 G8).
   */
  authorize(agent: unknown, toolName: string): Promise<{ workspaceKey: string } | { workspaceKey: null; reason: string }>

  // Engine mutations (callers already passed authorize; `caller` is the
  // calling agent's session id for precise-executor enforcement).
  claim(workspaceKey: string, claim: { nodeToken: string; outcome: ClaimOutcome; summary: string; handoffContext?: string }, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  block(workspaceKey: string, nodeToken: string, reason: string, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  resume(workspaceKey: string, nodeToken: string, resolutionContext: string, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  runProgram(workspaceKey: string, nodeToken: string, parameters: Record<string, unknown>, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  resolveProgram(workspaceKey: string, nodeToken: string, result: 'PASS' | 'FAIL', reason: string, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  setRoleModel(workspaceKey: string, roleKey: string, provider: string, modelId: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  status(workspaceKey: string): Promise<{ ok: boolean; reason?: string; status?: unknown }>
  judgeClaim(workspaceKey: string, nodeToken: string, result: 'PASS' | 'FAIL' | 'NEED_CONTEXT', reason: string, judgeSessionId: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  respawnJudge(workspaceKey: string, nodeToken: string, reason: string | undefined, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>

  // Inspection wrappers (read-only, enum operations)
  inspectGit(workspaceKey: string, operation: 'status' | 'branch' | 'remote' | 'top-level'): Promise<{ ok: boolean; reason?: string; value?: unknown }>
  inspectGithub(workspaceKey: string, operation: 'milestones' | 'issues' | 'milestone-issues', milestoneNumber?: number): Promise<{ ok: boolean; reason?: string; value?: unknown }>
}

function text(v: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: v }]
}

function fmtResult(outcome: { ok: boolean; reason?: string; message?: string; status?: unknown; value?: unknown }): string {
  if (!outcome.ok) return `拒绝：${outcome.reason ?? '未知错误'}`
  if (outcome.value !== undefined) return JSON.stringify(outcome.value, null, 2)
  if (outcome.status !== undefined) return JSON.stringify(outcome.status, null, 2)
  return outcome.message ?? 'ok'
}

const stringOut = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => text(value),
}

/** Authorize a control tool call and resolve its workspace key + caller id. */
async function controlWorkspace(agent: unknown, toolName: string): Promise<{ workspaceKey: string; caller: string } | { workspaceKey: null; reason: string }> {
  const auth = await thisHost().authorize(agent, toolName)
  if (auth.workspaceKey === null) return auth as { workspaceKey: null; reason: string }
  const caller = typeof agent === 'object' && agent !== null && 'session' in agent
    ? (agent as { session: { id: string } }).session.id
    : ''
  return { workspaceKey: auth.workspaceKey, caller }
}

export const workflowTools: ToolDefinition[] = [
  defineTool({
    name: 'workflow_status',
    description: '查看当前 workspace 的 Workflow Run 状态（只读；Manager 与 Role Actor 可用）。',
    parameters: {},
    output: stringOut,
    async execute(_args, exec) {
      const auth = await controlWorkspace(exec.agent, 'workflow_status')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      return fmtResult(await thisHost().status(auth.workspaceKey))
    },
  }),

  defineTool({
    name: 'node_claim',
    description: '提交当前 Node 的工作结果声明。completed/failed 之后由 Checker 独立判定 PASS/FAIL。这必须是当前 Turn 的最后一个动作。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken（status 工具返回）' },
      outcome: { type: 'string', required: true, enum: ['completed', 'failed'], description: 'completed | failed' },
      summary: { type: 'string', required: true, description: '工作摘要（1..4000 字符）' },
      handoffContext: { type: 'string', description: '交给下一 Node 的上下文（仅 completed 可用，1..8000 字符）' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'node_claim')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      const host = thisHost()
      const summaryError = lengthError('summary', args.summary, LIMITS.summaryMin, LIMITS.summaryMax, true)
      if (summaryError !== undefined) return `拒绝：${summaryError}`
      if (args.handoffContext !== undefined) {
        if (args.outcome !== 'completed') return '拒绝：handoffContext 仅 completed 可用'
        const handoffError = lengthError('handoffContext', args.handoffContext, 1, LIMITS.handoffMax, false)
        if (handoffError !== undefined) return `拒绝：${handoffError}`
      }
      const outcome = await host.claim(auth.workspaceKey, { nodeToken: args.nodeToken, outcome: args.outcome, summary: args.summary, handoffContext: args.handoffContext }, auth.caller)
      if (outcome.ok) exec.concludeTurn()
      return fmtResult(outcome)
    },
  }),

  defineTool({
    name: 'node_block',
    description: '把当前 Node 置为 BLOCK（暂停）。不执行 Checker/Edge。这必须是当前 Turn 的最后一个动作。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      reason: { type: 'string', required: true, description: 'BLOCK 原因（1..4000 字符）' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'node_block')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      const reasonError = lengthError('reason', args.reason, 1, LIMITS.blockReasonMax, true)
      if (reasonError !== undefined) return `拒绝：${reasonError}`
      const outcome = await thisHost().block(auth.workspaceKey, args.nodeToken, args.reason, auth.caller)
      if (outcome.ok) exec.concludeTurn()
      return fmtResult(outcome)
    },
  }),

  defineTool({
    name: 'node_resume',
    description: 'Manager 恢复 BLOCK 的当前 Node（生成新 token 并重新派发）。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      resolutionContext: { type: 'string', required: true, description: '处理结果上下文（1..8000 字符）' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'node_resume')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      const ctxError = lengthError('resolutionContext', args.resolutionContext, LIMITS.resolutionMin, LIMITS.resolutionMax, true)
      if (ctxError !== undefined) return `拒绝：${ctxError}`
      return fmtResult(await thisHost().resume(auth.workspaceKey, args.nodeToken, args.resolutionContext, auth.caller))
    },
  }),

  defineTool({
    name: 'node_run_program',
    description: 'Manager 为当前 builtin-program Node 提供临时 typed parameters 并运行。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      parameters: { type: 'object', additionalProperties: true, required: true, description: '当前 program 的 parameters' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'node_run_program')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      return fmtResult(await thisHost().runProgram(auth.workspaceKey, args.nodeToken, args.parameters, auth.caller))
    },
  }),

  defineTool({
    name: 'node_resolve_program',
    description: 'Manager 在 BLOCK 的 builtin-program Node 检查现场后手工提交 PASS/FAIL。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      result: { type: 'string', required: true, enum: ['PASS', 'FAIL'], description: 'PASS | FAIL' },
      reason: { type: 'string', required: true, description: '裁决理由（1..4000 字符）' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'node_resolve_program')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      const reasonError = lengthError('reason', args.reason, 1, LIMITS.blockReasonMax, true)
      if (reasonError !== undefined) return `拒绝：${reasonError}`
      return fmtResult(await thisHost().resolveProgram(auth.workspaceKey, args.nodeToken, args.result, args.reason, auth.caller))
    },
  }),

  defineTool({
    name: 'workflow_set_role_model',
    description: 'Manager 为某个 Role 或 Judge 切换模型（provider + modelId）。目标 Role 有 active Actor 时拒绝。',
    parameters: {
      roleKey: { type: 'string', required: true, description: 'roleKey 或 judge' },
      provider: { type: 'string', required: true, description: 'provider route' },
      modelId: { type: 'string', required: true, description: 'model id' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'workflow_set_role_model')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      return fmtResult(await thisHost().setRoleModel(auth.workspaceKey, args.roleKey, args.provider, args.modelId))
    },
  }),

  defineTool({
    name: 'judge_respawn',
    description: 'Manager 显式重建当前 Node 的 Judge（清映射 + drain 旧 Judge + spawn 新 Judge 重投判定）。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      reason: { type: 'string', description: '可选，写入 trace log 说明为何重建' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'judge_respawn')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      return fmtResult(await thisHost().respawnJudge(auth.workspaceKey, args.nodeToken, args.reason, auth.caller))
    },
  }),

  defineTool({
    name: 'judge_claim',
    description: 'Judge 提交当前 Node 的判定结果（PASS | FAIL | NEED_CONTEXT）。这必须是当前 Turn 的最后一个动作。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      result: { type: 'string', required: true, enum: ['PASS', 'FAIL', 'NEED_CONTEXT'], description: 'PASS | FAIL | NEED_CONTEXT' },
      reason: { type: 'string', required: true, description: '判定理由（1..2000 字符）' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'judge_claim')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      const reasonError = lengthError('reason', args.reason, LIMITS.reasonMin, LIMITS.reasonMax, true)
      if (reasonError !== undefined) return `拒绝：${reasonError}`
      const outcome = await thisHost().judgeClaim(auth.workspaceKey, args.nodeToken, args.result, args.reason, auth.caller)
      if (outcome.ok) exec.concludeTurn()
      return fmtResult(outcome)
    },
  }),

  defineTool({
    name: 'workflow_inspect_git',
    description: '只读检查当前 workspace git 现场（Judge 专用；enum 操作）。',
    parameters: {
      operation: { type: 'string', required: true, enum: ['status', 'branch', 'remote', 'top-level'], description: '检查操作' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'workflow_inspect_git')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      return fmtResult(await thisHost().inspectGit(auth.workspaceKey, args.operation))
    },
  }),

  defineTool({
    name: 'workflow_inspect_github',
    description: '只读检查当前 workspace GitHub repository 现场（Judge 专用；enum 操作）。',
    parameters: {
      operation: { type: 'string', required: true, enum: ['milestones', 'issues', 'milestone-issues'], description: '检查操作' },
      milestoneNumber: { type: 'integer', description: 'milestone-issues 时的 Milestone number' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'workflow_inspect_github')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      return fmtResult(await thisHost().inspectGithub(auth.workspaceKey, args.operation, args.milestoneNumber))
    },
  }),
]

let toolHostRef: ToolHost | undefined

export function setToolHost(host: ToolHost): void {
  toolHostRef = host
}

function thisHost(): ToolHost {
  if (toolHostRef === undefined) throw new Error('workflow tool host is not wired')
  return toolHostRef
}
