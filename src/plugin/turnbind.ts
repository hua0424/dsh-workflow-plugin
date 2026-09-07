/**
 * Caller-turn binding for claim admission (A1 R3 / design §2).
 *
 * The admission gate must verify that the turn executing `node_claim` /
 * `node_block` was indeed started by this Node's dispatch message. DSH gives
 * us everything we need on the caller's own session log:
 *
 * - native tool calls have a `tool/call` event (with `turn`) appended BEFORE
 *   the tool body runs (dsh-agent-loop appendToolCall);
 * - Code Mode sub-dispatches (`run_code` children) have NO `tool/call` — they
 *   write `tool/code-dispatch-start` (no `turn`) instead, appended by the
 *   code-mode scheduler before the tool body pipeline. Their `exec.callId` is
 *   the deterministic `<parent>:code:<n>` subCallId and `exec.rootCallId`
 *   names the ROOT `run_code` call, which DOES have a `tool/call`.
 *
 * Binding predicate: the claim turn's `user/message` id SET contains the
 * dispatch message id. Set membership (not "first message equals") so a steer
 * landing mid-turn still binds; an old turn's tool call never contains the
 * new dispatch id and is naturally rejected.
 *
 * Pure functions; fail-closed (`undefined`) on any log anomaly.
 */

/** Minimal session-log event shape (DSH `SessionEvent` satisfies it). */
export interface TurnBindEvent {
  type: string
  seq: number
  data: unknown
}

function dataOf(event: TurnBindEvent): Record<string, unknown> | undefined {
  if (typeof event.data !== 'object' || event.data === null) return undefined
  return event.data as Record<string, unknown>
}

/**
 * The `user/message` ids of the turn that executes this tool call, or
 * `undefined` when the turn cannot be derived from the log (fail-closed).
 * `callId` / `rootCallId` come from the tool exec.
 */
export function callerTurnUserMessageIds(
  events: ReadonlyArray<TurnBindEvent>,
  callId: string,
  rootCallId: string,
): ReadonlySet<string> | undefined {
  // Locate the event that names this call's turn.
  let locateSeq: number | undefined
  let turn: number | undefined

  // 1. Native path: the `tool/call` (appended before the tool body, so it is
  //    always already in the log while the body runs).
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = dataOf(event)
    if (data === undefined || data['callId'] !== callId) continue
    if (typeof data['turn'] !== 'number') return undefined
    turn = data['turn']
    locateSeq = event.seq
    break
  }

  // 2. Code Mode path: the sub-dispatch start must match BOTH `subCallId`
  //    and `rootCallId` (proof that this call is genuinely a code child of
  //    that root — a forged callId cannot piggyback on the root's turn), then
  //    the ROOT `run_code`'s own `tool/call` locates the turn.
  if (locateSeq === undefined) {
    let startFound = false
    for (const event of events) {
      if (event.type !== 'tool/code-dispatch-start') continue
      const data = dataOf(event)
      if (data === undefined || data['subCallId'] !== callId || data['rootCallId'] !== rootCallId) continue
      startFound = true
      break
    }
    if (!startFound) return undefined
    for (const event of events) {
      if (event.type !== 'tool/call') continue
      const data = dataOf(event)
      if (data === undefined || data['callId'] !== rootCallId) continue
      if (typeof data['turn'] !== 'number') return undefined
      turn = data['turn']
      locateSeq = event.seq
      break
    }
    if (locateSeq === undefined) return undefined
  }

  return turnUserMessageIds(events, locateSeq, turn)
}

/** 精确结束事件的派发来源；延迟处理也不能借用后续 Turn。 */
export function endedTurnUserMessageIds(events: ReadonlyArray<TurnBindEvent>, end: TurnBindEvent): ReadonlySet<string> | undefined {
  if (end.type !== 'turn/end') return undefined
  const turn = dataOf(end)?.['turn']
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return undefined
  const logged = events.find(event => event.seq === end.seq)
  if (logged?.type !== 'turn/end' || dataOf(logged)?.['turn'] !== turn) return undefined
  return turnUserMessageIds(events, end.seq, turn)
}

function turnUserMessageIds(events: ReadonlyArray<TurnBindEvent>, locateSeq: number, turn: number | undefined): ReadonlySet<string> | undefined {
  // 3. Single reverse scan from the locating event: collect `user/message`
  //    ids until the `turn/start` that opened `turn`. Crossing a turn
  //    boundary without hitting it, or running off the log head, is a log
  //    anomaly → fail-closed.
  const ids = new Set<string>()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.seq > locateSeq) continue
    if (event.type === 'turn/end' && event.seq !== locateSeq) return undefined
    if (event.type === 'turn/start') {
      const data = dataOf(event)
      return data !== undefined && data['turn'] === turn ? ids : undefined
    }
    if (event.type === 'user/message') {
      const data = dataOf(event)
      const id = data?.['id']
      if (typeof id === 'string' && id !== '') ids.add(id)
    }
  }
  return undefined
}
