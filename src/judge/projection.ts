/**
 * Transient Judge transcript projection (design §2.2/§10.3 F1).
 *
 * Pure function over the Manager session's event log: append-origin
 * user/message (source.kind === 'user') and assistant/message text blocks
 * only. Excludes system/tool/plugin/replacement/hidden content. Never
 * persisted; rebuilt for each fresh Judge.
 */
import type { Session } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, deriveEventMessage } from '@deepseek-ai/dsh-session'

/** Max projected transcript length in characters (defensive bound). */
export const PROJECTION_MAX_CHARS = 120_000

/** Extract the plain text of one assistant/user message (text blocks only). */
export function messageText(message: ReturnType<typeof deriveEventMessage>): string {
  if (message === null) return ''
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text)
    // reasoning blocks: include when they are the model's visible thinking? No —
    // design says user/manager-visible text; reasoning is provider-internal and
    // omitted to keep the projection faithful to what the user saw.
  }
  return parts.join('\n')
}

/** Project one manager session into plain transcript text. */
export function projectManagerTranscript(session: Session): string {
  const parts: string[] = []
  for (const event of session.events) {
    if (!isAppendSurfaceEvent(event)) continue
    let message: ReturnType<typeof deriveEventMessage>
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source.kind !== 'user') continue // plugin injections, coordinator relays, etc.
      message = deriveEventMessage(event)
    } else if (event.type === 'assistant/message') {
      message = deriveEventMessage(event)
    } else {
      continue
    }
    const text = messageText(message).trim()
    if (text === '') continue
    const role = event.type === 'user/message' ? 'USER' : 'MANAGER'
    parts.push(`[${role}]\n${text}`)
  }
  let out = parts.join('\n\n')
  if (out.length > PROJECTION_MAX_CHARS) {
    out = out.slice(-PROJECTION_MAX_CHARS)
  }
  return out
}
