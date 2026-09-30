/**
 * 本插件自声明的消息 source kind（0.2.0 迁移 T2，#189）。
 *
 * 0.2.0 删除了共用的 `plugin` kind，改为合并可扩展的 `MessageSourceMap`——
 * 每个生产者仿宿主生产者模式（`agent-message` / `subagent-settled` /
 * `runtime-context`）在自己模块里声明自有 kind。本插件声明两个：
 * - 派发类 `workflow-dispatch`：Manager steer / Role / Judge 派发，保持原字段
 *   （`plugin` 宿主名），只换 kind，不加 form；
 * - 通知类 `workflow-notice`：blank 会话激活，保留 `notice` form 与 `summary`。
 *
 * 该写法是标准接口合并，在新旧两版 dsh-llm 下均可合并（双向兼容修法）；
 * 读路径（`judge/projection.ts`）额外保留旧 `plugin` kind 识别，以便冷读
 * 0.1.5 写下的存量会话（单向门 FORMAT 3→4 之前写下的派发仍为旧 kind）。
 */

/** 宿主内本插件的稳定生产者名（派发与通知共用）。 */
export const PLUGIN_NAME = 'dsh-agent-team-workflow'

/** 派发类 kind：Manager steer / Role / Judge 派发。 */
export const WORKFLOW_DISPATCH_KIND = 'workflow-dispatch' as const
/** 通知类 kind：blank 会话激活。 */
export const WORKFLOW_NOTICE_KIND = 'workflow-notice' as const

/** 派发类 source：保持原字段、只换 kind，不加 form。 */
export interface WorkflowDispatchSource {
  readonly kind: typeof WORKFLOW_DISPATCH_KIND
  readonly plugin: string
  readonly form?: never
}

/** 通知类 source：保留 notice form 与 context summary。 */
export interface WorkflowNoticeSource {
  readonly kind: typeof WORKFLOW_NOTICE_KIND
  readonly plugin: string
  readonly form: 'notice'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'workflow-dispatch': WorkflowDispatchSource
    'workflow-notice': WorkflowNoticeSource
  }
}

/** 派发点共用的 source 常量（Manager steer / Role / Judge followup 同形）。 */
export const WORKFLOW_DISPATCH_SOURCE = {
  kind: WORKFLOW_DISPATCH_KIND,
  plugin: PLUGIN_NAME,
} as const satisfies WorkflowDispatchSource

/** blank 激活通知的 source：summary 逐次生成，kind/form 固定。 */
export function workflowNoticeSource(summary: string): WorkflowNoticeSource {
  return { kind: WORKFLOW_NOTICE_KIND, plugin: PLUGIN_NAME, form: 'notice', summary }
}

/** 读路径用的旧 kind（0.1.5 写下的存量派发，冷读兼容）。 */
export const LEGACY_PLUGIN_KIND = 'plugin' as const

/** 判定一条来源是否为本插件的派发（含旧 kind 存量）。 */
export function isWorkflowDispatchSource(source: { kind?: string; plugin?: string } | undefined): boolean {
  return source?.plugin === PLUGIN_NAME
    && (source.kind === WORKFLOW_DISPATCH_KIND || source.kind === LEGACY_PLUGIN_KIND)
}
