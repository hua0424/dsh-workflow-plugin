/**
 * /dsh-flow native command (design §2.3 A1-A5).
 * list | start <workflow-id> [extra text] | status | reset | check <workflow-id>
 * No arguments = usage error.
 *
 * #85：命令层另外负责"空白会话激活"的投递时机——handler 的结果契约不变，
 * 投递只是 handler 返回之后的 best-effort 副作用（见 withActivation）。
 */
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only：解析 ctx.get('sessionProjections')。#85 读宿主 UI 用的同一个 blank bit；
// 服务缺席（未挂 session-controller 的宿主）时激活降级为 seq 启发式。
import type {} from '@deepseek-ai/dsh-session-projection'

export interface CommandHost {
  /** Workspace key of the invoking session's cwd. */
  currentWorkspaceKey(agent: Agent): Promise<string | undefined>
  list(): Promise<{ entries: Array<{ workflowId: string }>; diagnostics: Array<{ workflowId: string | null; path: string; reason: string; severity: 'error' | 'warning' }>; ok?: boolean; reason?: string }>
  /** Start a workflow run on behalf of the given agent session. */
  start(agent: Agent, workspaceKey: string, workflowId: string, extraText: string): Promise<{ ok: boolean; reason?: string; message?: string }>
  status(workspaceKey: string | undefined, caller: string): Promise<{ ok: boolean; reason?: string; status?: unknown }>
  reset(agent: Agent, workspaceKey: string | undefined, mode: 'compatible' | 'incompatible-store'): Promise<{ ok: boolean; reason?: string; message?: string }>
  /** provider 注册 + modelId 本地列表 + reasoningEffort 档位静态检查：逐角色报告，永不阻断加载。 */
  check(workflowId: string): Promise<{ ok: boolean; reason?: string; message?: string }>
}

export function isRootCommandAgent(agent: Agent): boolean {
  const header = agent.session.header
  return header.parentSession === undefined && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
}

const PLUGIN_NAME = 'dsh-agent-team-workflow'

/** 结果文本进 prompt 的上限：只给模型够转述的量（status 的 JSON 可达数十 KB）。 */
const ACTIVATION_RESULT_MAX_CHARS = 4_000

/** #85：一次待投递的空白会话激活。 */
export interface BlankActivationRequest {
  /** 原始输入（子命令 + 参数），用于消息摘要与正文。 */
  readonly command: string
  /** handler 已落定的结果；success / error 都投递。 */
  readonly result: CommandResult
  /**
   * handler 执行时刻的 `session.seq`。宿主 `CommandRuntime.execute` 已先行追加
   * `command/run`，所以全新空白会话此刻恰为 1；投递时刻日志里已经多了
   * `command/done`（seq 已是 2），那时再读会误判为非空白。
   */
  readonly seqAtHandler: number
}

/** #85：激活投递回调；默认实现由插件入口（持有 ctx）注入。 */
export type SessionActivator = (agent: Agent, request: BlankActivationRequest) => void

/**
 * #85：空白会话的默认激活实现。
 *
 * 宿主 UI 在会话 `blank` 阶段整段不渲染对话区，`/dsh-flow` 的结果只落在会话日志里，
 * 用户看不到；命令生命周期事件又不含 `turn/start`，blank 位永不自行清除。这里投递一条
 * plugin/notice 消息唤醒一个 turn：`turn/start` 清除 blank，此前落日志的 command 节点
 * 连同助手的一句转述立即可见。blank 位本身就是"每会话最多一次"的闸门（turn 一开即永久
 * 为 false），无需额外状态；任何失败都静默降级为 warn，不影响命令本身的结果与日志。
 */
export function makeBlankSessionActivator(ctx: Context): SessionActivator {
  return (agent, request) => {
    try {
      // 与宿主 UI 同源的权威 bit。cachedSnapshot 只读已 materialize 的 cell：
      // 服务或 cell 缺席时返回 undefined，由下面的 seq 启发式兜底。
      const values = ctx.get('sessionProjections')?.cachedSnapshot(agent.session)?.values as
        | { sessionListMetadata?: { blank?: boolean } }
        | undefined
      const blank = values?.sessionListMetadata?.blank ?? request.seqAtHandler <= 1
      if (!blank) return
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: activationText(request) }],
        source: {
          kind: 'plugin',
          plugin: PLUGIN_NAME,
          form: 'notice',
          summary: boundContextSummary(`/dsh-flow ${request.command.split(/\s+/)[0] || '(无参数)'} 结果`),
        },
      }))
    } catch (error) {
      ctx.logger.warn(`dsh-flow blank-session activation skipped: ${String(error)}`)
    }
  }
}

/** 转述指令：结果本身已经作为 flow node 落在对话流里，助手只需复述要点。 */
function activationText(request: BlankActivationRequest): string {
  return [
    `用户刚在空白会话中执行 /dsh-flow ${request.command === '' ? '(无参数)' : request.command}，命令结果已作为 flow node 记录在上方对话流中：`,
    '',
    (request.result.text ?? '').slice(0, ACTIVATION_RESULT_MAX_CHARS),
    '',
    '请用一两句话向用户转述结果要点，不要调用任何工具。',
  ].join('\n')
}

/**
 * 把激活投递包在既有 handler 外层：返回的 CommandResult 原样透传，投递是它之后
 * 的副作用。`setTimeout` 是宏任务，宿主在 handler settle 之后追加的 `command/done`
 * 一定先落日志，因此对话流里 command 节点排在 turn 内容之前；投递本身 best-effort，
 * 抛异常（含同步抛）只被吞掉，绝不改变命令结果。
 */
function withActivation(handler: CommandDefinition['handler'], activate: SessionActivator): CommandDefinition['handler'] {
  return async (invocation) => {
    // #85：只对 root command 会话生效，绝不触碰 workflow 的 Manager/Role Actor/Judge 会话。
    const request = isRootCommandAgent(invocation.agent)
      ? { command: invocation.rawInput.trim(), seqAtHandler: invocation.agent.session.seq }
      : undefined
    const result = await handler(invocation)
    if (request !== undefined) {
      setTimeout(() => {
        void Promise.resolve()
          .then(() => activate(invocation.agent, { ...request, result }))
          .catch(() => {})
      }, 0)
    }
    return result
  }
}

const USAGE = `用法：
/dsh-flow list                        列出所有合法 workflow
/dsh-flow start <workflow-id> [文本]  启动 workflow（附加文本交给 Manager）
/dsh-flow status                      查看当前 workspace 的 Run 状态
/dsh-flow reset                       终止当前 workspace 的活动 Run（不取消外部动作）
/dsh-flow reset --incompatible-store  备份并退出整个不兼容 State Store
/dsh-flow check <workflow-id>         静态检查各角色 provider 注册 + modelId 本地列表 + 思考档位（只报告，不阻断）`

export function makeDshFlowCommand(host: CommandHost, activate?: SessionActivator): CommandDefinition {
  const command: CommandDefinition = {
    name: 'dsh-flow',
    description: 'Agent-team workflow 控制：list / start / status / reset / check',
    input: { hint: 'list | start <workflow-id> [text] | status | reset | check <workflow-id>' },
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
          if (result.ok === false) return { kind: 'error', text: `list 失败：${result.reason ?? '未知错误'}` }
          if (result.entries.length === 0 && result.diagnostics.length === 0) {
            return { kind: 'success', text: '（没有找到 workflow 配置文件）' }
          }
          const lines: string[] = []
          for (const entry of result.entries) lines.push(`- ${entry.workflowId}`)
          for (const d of result.diagnostics) {
            // #59: warnings stay startable — they get their own tag, never [invalid].
            const tag = d.severity === 'warning' ? '[warn]' : '[invalid]'
            lines.push(`- ${tag} ${d.workflowId ?? '?'} — ${d.reason}`)
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
          const outcome = await host.status(ws, invocation.agent.session.id)
          if (!outcome.ok) return { kind: 'error', text: `status 失败：${outcome.reason ?? '未知错误'}` }
          return { kind: 'success', text: typeof outcome.status === 'string' ? outcome.status : JSON.stringify(outcome.status ?? null, null, 2) }
        }
        case 'reset': {
          const mode = rest.length === 0 ? 'compatible'
            : rest.length === 1 && rest[0] === '--incompatible-store' ? 'incompatible-store'
              : undefined
          if (mode === undefined) return { kind: 'error', text: `reset 只接受 --incompatible-store；${USAGE}` }
          const ws = await host.currentWorkspaceKey(invocation.agent)
          if (mode === 'compatible' && ws === undefined) return { kind: 'error', text: '当前会话没有 workspace cwd' }
          const outcome = await host.reset(invocation.agent, ws, mode)
          if (!outcome.ok) return { kind: 'error', text: `reset 失败：${outcome.reason ?? '未知错误'}` }
          return { kind: 'success', text: outcome.message ?? 'reset done' }
        }
        case 'check': {
          const workflowId = rest[0]
          if (workflowId === undefined || rest.length !== 1 || !/^[a-z][a-z0-9-]*$/.test(workflowId)) {
            return { kind: 'error', text: `check 需要一个 workflow-id（[a-z][a-z0-9-]*）；${USAGE}` }
          }
          const outcome = await host.check(workflowId)
          if (!outcome.ok) return { kind: 'error', text: `check 失败：${outcome.reason ?? '未知错误'}` }
          return { kind: 'success', text: outcome.message ?? 'check done' }
        }
        default:
          return { kind: 'error', text: `未知子命令 "${verb}"；${USAGE}` }
      }
    },
  }
  return activate === undefined ? command : { ...command, handler: withActivation(command.handler, activate) }
}
