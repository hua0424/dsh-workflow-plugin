/**
 * Node-local Judge transcript projection (A1 R5–R7).
 *
 * Replaces the old whole-Manager-transcript projection: the Judge now receives
 * only the messages produced AFTER the current Node's actual dispatch boundary,
 * merged across Manager + User + (optionally) the executing Actor session and
 * ordered by event time with a deterministic tie-break.
 *
 * Pure functions over the DSH Session event logs; never persisted, rebuilt for
 * each fresh Judge (and each respawn rebuild).
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { NodeContextBoundary } from '../types.ts'
import { SUBMISSION_CONSTRAINT } from '../engine/texts.ts'

/** Max projected transcript length in characters (defensive bound, #45 P3 保留). */
export const PROJECTION_MAX_CHARS = 120_000

/**
 * #45 P3 投影窗口：MANAGER/ACTOR 消息只保留最近 6 条。首条 dispatch 与全部
 * USER 消息保底（USER 全保留——用户中途指示是范围变更判据，数量极少）。
 */
export const PROJECTION_WINDOW_MANAGER_ACTOR = 6

/**
 * Minimal session shape the projection needs. A live DSH `Session` satisfies
 * it structurally, and so does a `sessionPersistence.inspect()` result wrapped
 * with its id (F9: the actor may be non-resident when a Judge packet is
 * rebuilt for respawn/spawn-recovery).
 */
export interface ProjectionSource {
  id: string
  snapshotEvents(): readonly SessionEvent[]
  /** Next unallocated seq (one past the last event). */
  seq: number
}

/** Extract the plain text of one assistant/user message (text blocks only). */
export function messageText(message: ReturnType<typeof deriveEventMessage>): string {
  if (message === null) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    // reasoning blocks are provider-internal and omitted to keep the projection
    // faithful to what the user/manager actually saw.
  }
  return parts.join('\n')
}

/** One projected, ordered surface message from any session. */
export interface ProjectedMessage {
  /** Sort key: event.time asc, then sessionId asc, then seq within a session. */
  time: number
  seq: number
  sessionId: string
  role: 'USER' | 'MANAGER' | 'ACTOR'
  text: string
}

/**
 * Filter + project one session's append-origin surface events into plain text
 * entries. Only `user/message` and `assistant/message` text blocks are kept;
 * system/tool/plugin/replacement/hidden content is excluded exactly like the
 * old manager projection.
 *
 * A1 R5 vs R6 source policy:
 * - MANAGER/USER sessions keep only `source.kind === 'user'` user messages
 *   (plugin/coordinator notices are excluded per R5);
 * - ACTOR 也保留本插件的 host Queue 派发来源；旧 coordinator 仅供历史读取。
 *   dispatch/handoff/resolution 仍受 message-id 边界约束（R6）。
 *   首次 `startContinuable` prompt 的来源仍是 `{kind:'user'}`。
 */
export function projectSessionSurface(session: ProjectionSource, fromSeq: number, role: 'USER' | 'MANAGER' | 'ACTOR'): ProjectedMessage[] {
  const out: ProjectedMessage[] = []
  for (const event of session.snapshotEvents()) {
    if (event.seq < fromSeq) continue
    if (!isAppendSurfaceEvent(event)) continue
    let message: ReturnType<typeof deriveEventMessage>
    let entryRole = role
    if (event.type === 'user/message') {
      const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
      if (source?.kind !== 'user' && !(role === 'ACTOR' && (source?.kind === 'coordinator'
        || (source?.kind === 'plugin' && source.plugin === 'dsh-agent-team-workflow')))) continue
      // A1 R3: keep the three-way attribution — a real human user message in
      // the Manager session projects as USER, assistant output as MANAGER.
      if (role === 'MANAGER' && source?.kind === 'user') entryRole = 'USER'
      message = deriveEventMessage(event)
    } else if (event.type === 'assistant/message') {
      message = deriveEventMessage(event)
    } else {
      continue
    }
    const text = stripSubmissionConstraint(messageText(message)).trim()
    if (text === '') continue
    out.push({ time: event.time, seq: event.seq, sessionId: session.id, role: entryRole, text })
  }
  return out
}

/**
 * A3 R1/AC6: the engine's fixed submission constraint is injected into the
 * dispatch text but must never reach the Judge. Strip the exact fixed suffix
 * (instruction/handoff/resolution原文 are preserved verbatim).
 */
function stripSubmissionConstraint(text: string): string {
  if (!text.endsWith(SUBMISSION_CONSTRAINT.trim())) return text
  return text.slice(0, text.length - SUBMISSION_CONSTRAINT.trim().length)
}

/**
 * #44 P2：executor 首条 dispatch 在投影中只留 `[handoff]`。模板化压缩——
 * 按 `[instruction]` / `[criteria]` / `[提交要求]` 段边界截断（#43 后派发
 * 已无 `[criteria]`，此处兼容旧文本）；派发模板内的纠错/补充/恢复段都挂在
 * `[instruction]` 之后，随之一并截掉。无模板标记时原文保留，不破坏未知文本。
 */
export function compressDispatchToHandoff(text: string): string {
  const markers = ['\n\n[instruction]', '\n\n[criteria]', '\n\n[提交要求]']
  let end = text.length
  for (const marker of markers) {
    const at = text.indexOf(marker)
    if (at !== -1 && at < end) end = at
  }
  if (end === text.length) return text
  return text.slice(0, end)
}

/**
 * Locate the first event seq of the executor's dispatch message: the message id
 * recorded in the boundary (A1 R2/R6) — the authoritative cursor. When the id
 * cannot be found, the actor surface contributes NOTHING (`session.seq` = next
 * unallocated seq): A1 R2 forbids time-based fallbacks ("不得仅依赖
 * event.time >= dispatchedAt 判断边界"), and failing closed loses one node's
 * actor context rather than leaking a previous node's history (AC2/AC3).
 */
function executorFromSeq(session: ProjectionSource, boundary: NodeContextBoundary): number {
  const id = boundary.executorDispatchMessageId
  if (id !== undefined) {
    for (const event of session.snapshotEvents()) {
      const message = deriveEventMessage(event)
      if (message !== null && message.id === id) return event.seq
    }
  }
  return session.seq
}

/** Stable per-session tie-break for equal event timestamps (A1 R3). */
function sessionOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Ordering for projected messages: (time, sessionId, seq within a session). */
function compareProjected(a: ProjectedMessage, b: ProjectedMessage): number {
  return a.time - b.time
    // A1 R3: seq orders ONLY within one session at equal time; different
    // sessions at equal time break ties by the stable session id.
    || sessionOrder(a.sessionId, b.sessionId)
    || (a.sessionId === b.sessionId ? a.seq - b.seq : 0)
}

/**
 * Node-local projection (A1 R5–R7; #45 P3 窗口): Manager + User messages from
 * the boundary cursor, merged with the executing Actor's own Node-scoped
 * messages, ordered by (time, seq, session). Excludes all pre-boundary
 * history. 窗口规则：首条 dispatch + 全部 USER 保底，MANAGER/ACTOR 只取最近
 * PROJECTION_WINDOW_MANAGER_ACTOR 条；无 actor 会话时仅 Manager 侧参与窗口。
 */
export function projectNodeLocal(
  managerSession: ProjectionSource,
  boundary: NodeContextBoundary,
  actorSession?: ProjectionSource,
): string {
  const managerParts = projectSessionSurface(managerSession, boundary.managerFromSeq, 'MANAGER')
  const actorParts: ProjectedMessage[] = []

  // Executing Actor session: its own Node-scoped visible assistant + dispatch
  // text (the dispatch message itself is a user/message with source.kind ===
  // 'user' on first creation, or this Workflow plugin on host Queue continuation
  // (legacy coordinator history is also kept for the ACTOR role per A1 R6).
  let dispatch: ProjectedMessage | undefined
  if (actorSession !== undefined && boundary.executorSessionId !== undefined) {
    const from = executorFromSeq(actorSession, boundary)
    const scoped = projectSessionSurface(actorSession, from, 'ACTOR')
    // #44 P2: the executor's dispatch message (the boundary anchor at `from`)
    // keeps only [handoff] in the projection; later actor messages are untouched.
    const dispatchAt = scoped.findIndex(p => p.seq === from)
    if (dispatchAt !== -1) {
      dispatch = { ...scoped[dispatchAt]!, text: compressDispatchToHandoff(scoped[dispatchAt]!.text) }
      scoped.splice(dispatchAt, 1)
    }
    actorParts.push(...scoped)
  }

  // #45 P3: 窗口只对 MANAGER/ACTOR 生效；USER 全保留。先按最终展示顺序
  // 排好序，再取 MANAGER/ACTOR 的尾部 N 条 = 合并口径的"最近 N 条"。
  const nonUser = [...managerParts, ...actorParts]
    .filter(p => p.role !== 'USER')
    .sort(compareProjected)
    .slice(-PROJECTION_WINDOW_MANAGER_ACTOR)
  // 不变式：ACTOR 面永不产出 USER 角色（projectSessionSurface 仅在 role === 'MANAGER'
  // 时改写 USER）；USER 保底只来自 Manager 面。
  const parts: ProjectedMessage[] = [
    ...managerParts.filter(p => p.role === 'USER'),
    ...(dispatch !== undefined ? [dispatch] : []),
    ...nonUser,
  ]

  parts.sort(compareProjected)

  const rendered = parts.map(p => `[${p.role}]\n${p.text}`)
  let out = rendered.join('\n\n')
  if (out.length > PROJECTION_MAX_CHARS) {
    out = out.slice(-PROJECTION_MAX_CHARS)
  }
  return out
}
