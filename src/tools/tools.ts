/**
 * The workflow-control tools (design §5.2 G1-G9) + the read-only inspection
 * wrappers. Pure definitions + execute closures over a ToolHost interface, so
 * the whole tool layer is unit-testable without the host.
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { LIMITS, normalizeNodeClaim, type ClaimOutcome, type ClaimCaller } from '../types.ts'
import { callerTurnUserMessageIds } from '../plugin/turnbind.ts'

/** Length-check a tool text argument per the design bounds. */
function lengthError(field: string, value: string | undefined, min: number, max: number, required: boolean): string | undefined {
  const trimmed = (value ?? '').trim()
  if (required && trimmed === '') return `${field} is required`
  if (trimmed.length < min) return `${field} must be at least ${min} characters after trim`
  if (trimmed.length > max) return `${field} must be at most ${max} characters after trim`
  return undefined
}

/** Minimal shape of the exec's caller agent the binding needs. */
interface CallerAgentLike {
  session: { id: string; snapshotEvents?: () => unknown }
}

/**
 * A1 R3/§2: snapshot the calling turn BEFORE the mutation is enqueued — the
 * turn's user-message id set only grows, so the snapshot stays valid for the
 * admission decision. Fail-closed: an un-derivable turn yields an EMPTY set,
 * which no dispatch message id can match (claim rejected downstream).
 */
function claimCallerOf(exec: { agent?: unknown; callId?: string; rootCallId?: string }): ClaimCaller {
  const agent = typeof exec.agent === 'object' && exec.agent !== null && 'session' in exec.agent
    ? (exec.agent as CallerAgentLike)
    : undefined
  const sessionId = agent?.session.id ?? ''
  const events = typeof agent?.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : undefined
  const callId = typeof exec.callId === 'string' ? exec.callId : ''
  const rootCallId = typeof exec.rootCallId === 'string' ? exec.rootCallId : callId
  const ids = Array.isArray(events) && callId !== ''
    ? callerTurnUserMessageIds(events as ReadonlyArray<{ type: string; seq: number; data: unknown }>, callId, rootCallId)
    : undefined
  return { sessionId, turnUserMessageIds: ids ?? new Set<string>() }
}

/** Host services the tools need (wired by the plugin). */
export interface ToolHost {
  /**
   * Authorize a workflow-control tool call from `agent` (the exec's caller).
   * Resolves to the run's workspace key when allowed (Manager or mapped Role
   * Actor of the current run); rejects with a reason otherwise (design §5.2 G8).
   */
  authorize(agent: unknown, toolName: string): Promise<{ workspaceKey: string } | { workspaceKey: null; reason: string }>

  // Engine mutations (callers already passed authorize; `caller` identifies
  // the calling agent's session — for claim/block it also carries the calling
  // turn's user-message id snapshot for dispatch-lease admission, A1 R2/R3).
  claim(workspaceKey: string, claim: { outcome: ClaimOutcome; handoff: string }, caller: ClaimCaller): Promise<{ ok: boolean; reason?: string; message?: string }>
  block(workspaceKey: string, nodeToken: string, reason: string, caller: ClaimCaller): Promise<{ ok: boolean; reason?: string; message?: string }>
  resume(workspaceKey: string, nodeToken: string, resolutionContext: string, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  runProgram(workspaceKey: string, nodeToken: string, parameters: Record<string, unknown>, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  resolveProgram(workspaceKey: string, nodeToken: string, result: 'PASS' | 'FAIL', reason: string, caller: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  setRoleModel(workspaceKey: string, roleKey: string, provider: string, modelId: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  status(workspaceKey: string): Promise<{ ok: boolean; reason?: string; status?: unknown }>
  judgeClaim(workspaceKey: string, nodeToken: string, result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT', reason: string, judgeSessionId: string): Promise<{ ok: boolean; reason?: string; message?: string }>
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
    description: '提交当前 Node 的工作结果声明（candidate result）。由 Checker 独立确认 ACCEPT/REJECT。无需任何 token——绑定由派发 lease 自动完成。这必须是当前 Turn 的最后一个动作。',
    parameters: {
      outcome: { type: 'string', required: true, enum: ['completed', 'failed'], description: 'completed | failed' },
      handoff: { type: 'string', required: true, description: '唯一结果与交接说明（trim 后 1..8000 字符，completed/failed 对称，END 也必填）：实际结果、产物位置与核验依据、剩余问题和后续约束。Judge、Manager、后继读取同一文本；不接受旧 summary/handoffContext。' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'node_claim')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      // 宿主 defineTool 的参数根是 open object；显式拒绝旧字段及其它业务入口。
      const unknown = Object.keys(args).filter(key => key !== 'outcome' && key !== 'handoff')
      if (unknown.length > 0) throw new ToolArgsError(unknown.map(key => `unsupported node_claim property "${key}"; use outcome and handoff`))
      const host = thisHost()
      let claim
      try {
        claim = normalizeNodeClaim(args)
      } catch (error) {
        return `拒绝：${error instanceof Error ? error.message : String(error)}`
      }
      const outcome = await host.claim(auth.workspaceKey, claim, claimCallerOf(exec))
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
      const outcome = await thisHost().block(auth.workspaceKey, args.nodeToken, args.reason.trim(), claimCallerOf(exec))
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
      return fmtResult(await thisHost().resume(auth.workspaceKey, args.nodeToken, args.resolutionContext.trim(), auth.caller))
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
      return fmtResult(await thisHost().resolveProgram(auth.workspaceKey, args.nodeToken, args.result, args.reason.trim(), auth.caller))
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
    description: 'Judge 确认当前 Node 的 Actor 声明是否可信（ACCEPT | REJECT | NEED_CONTEXT）。ACCEPT = 声明与事实/instruction/criteria 一致；REJECT = 不正确或证据不足，reason 必须写明如何修正。这必须是当前 Turn 的最后一个动作。',
    parameters: {
      nodeToken: { type: 'string', required: true, description: '当前 Node 的 nodeToken' },
      result: { type: 'string', required: true, enum: ['ACCEPT', 'REJECT', 'NEED_CONTEXT'], description: 'ACCEPT | REJECT | NEED_CONTEXT' },
      reason: { type: 'string', required: true, description: '判定理由（1..2000 字符）' },
    },
    output: stringOut,
    async execute(args, exec) {
      const auth = await controlWorkspace(exec.agent, 'judge_claim')
      if (auth.workspaceKey === null) return `拒绝：${auth.reason}`
      const reasonError = lengthError('reason', args.reason, LIMITS.reasonMin, LIMITS.reasonMax, true)
      if (reasonError !== undefined) return `拒绝：${reasonError}`
      const outcome = await thisHost().judgeClaim(auth.workspaceKey, args.nodeToken, args.result, args.reason.trim(), auth.caller)
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
