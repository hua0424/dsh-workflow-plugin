/**
 * /dsh-flow native command (design §2.3 A1-A5).
 * list | start <workflow-id> [extra text] | status | reset
 * No arguments = usage error.
 */
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface CommandHost {
  /** Workspace key of the invoking session's cwd. */
  currentWorkspaceKey(agent: Agent): Promise<string | undefined>
  list(): Promise<{ entries: Array<{ workflowId: string }>; diagnostics: Array<{ workflowId: string | null; path: string; reason: string }> }>
  /** Start a workflow run on behalf of the given agent session. */
  start(agent: Agent, workspaceKey: string, workflowId: string, extraText: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  status(workspaceKey: string): Promise<{ ok: boolean; reason?: string; status?: unknown }>
  reset(workspaceKey: string): Promise<{ ok: boolean; reason?: string; message?: string }>
}

const USAGE = `用法：
/dsh-flow list                        列出所有合法 workflow
/dsh-flow start <workflow-id> [文本]  启动 workflow（附加文本交给 Manager）
/dsh-flow status                      查看当前 workspace 的 Run 状态
/dsh-flow reset                       删除当前 workspace 的 Run 记录`

export function makeDshFlowCommand(host: CommandHost): CommandDefinition {
  return {
    name: 'dsh-flow',
    description: 'Agent-team workflow 控制：list / start / status / reset',
    input: { hint: 'list | start <workflow-id> [text] | status | reset' },
    recordInput: true,
    async handler(invocation) {
      const raw = invocation.rawInput.trim()
      if (raw === '') {
        return { kind: 'error', text: USAGE }
      }
      const [verb, ...rest] = raw.split(/\s+/)
      switch (verb) {
        case 'list': {
          const result = await host.list()
          if (result.entries.length === 0 && result.diagnostics.length === 0) {
            return { kind: 'success', text: '（没有找到 workflow 配置文件）' }
          }
          const lines: string[] = []
          for (const entry of result.entries) lines.push(`- ${entry.workflowId}`)
          for (const d of result.diagnostics) {
            lines.push(`- [invalid] ${d.workflowId ?? '?'} — ${d.reason}`)
          }
          return { kind: 'success', text: lines.join('\n') }
        }
        case 'start': {
          const workflowId = rest[0]
          if (workflowId === undefined || !/^[a-z][a-z0-9-]*$/.test(workflowId)) {
            return { kind: 'error', text: `workflow-id 必须是 [a-z][a-z0-9-]*；${USAGE}` }
          }
          const extra = rest.slice(1).join(' ')
          const ws = await host.currentWorkspaceKey(invocation.agent)
          if (ws === undefined) return { kind: 'error', text: '当前会话没有 workspace cwd，无法启动 workflow' }
          const outcome = await host.start(invocation.agent, ws, workflowId, extra)
          if (!outcome.ok) return { kind: 'error', text: `start 失败：${outcome.reason ?? '未知错误'}` }
          return { kind: 'success', text: outcome.message ?? 'started' }
        }
        case 'status': {
          const ws = await host.currentWorkspaceKey(invocation.agent)
          if (ws === undefined) return { kind: 'error', text: '当前会话没有 workspace cwd' }
          const outcome = await host.status(ws)
          if (!outcome.ok) return { kind: 'error', text: `status 失败：${outcome.reason ?? '未知错误'}` }
          return { kind: 'success', text: typeof outcome.status === 'string' ? outcome.status : JSON.stringify(outcome.status ?? null, null, 2) }
        }
        case 'reset': {
          const ws = await host.currentWorkspaceKey(invocation.agent)
          if (ws === undefined) return { kind: 'error', text: '当前会话没有 workspace cwd' }
          const outcome = await host.reset(ws)
          if (!outcome.ok) return { kind: 'error', text: `reset 失败：${outcome.reason ?? '未知错误'}` }
          return { kind: 'success', text: outcome.message ?? 'reset done' }
        }
        default:
          return { kind: 'error', text: `未知子命令 "${verb}"；${USAGE}` }
      }
    },
  }
}
