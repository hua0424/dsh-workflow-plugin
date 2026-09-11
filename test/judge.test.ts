import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJudgeClaim, renderJudgePrompt } from '../src/judge/checker.ts'
import { projectNodeLocal, projectSessionSurface, messageText, compressDispatchToHandoff, type ProjectionSource } from '../src/judge/projection.ts'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SUBMISSION_CONSTRAINT } from '../src/engine/texts.ts'

function makeSession(events: Array<{ type: string; data: unknown; surfaceOp?: unknown }>): Session {
  const id = 'sess-test' as SessionId
  const session = Session.create(id)
  for (const event of events) {
    const opts = event.surfaceOp === undefined
      ? []
      : [{ surfaceOp: event.surfaceOp } as never]
    ;(session.append as (t: string, d: unknown, ...opts: unknown[]) => unknown)(event.type, event.data, ...opts)
  }
  return session
}

/** A synthetic projection source with FULL control over event time/seq (AC4). */
function makeSource(id: string, events: Array<{ time: number; seq: number; type: string; data: unknown; surfaceOp?: string }>): ProjectionSource {
  return {
    id,
    seq: events.reduce((max, e) => Math.max(max, e.seq + 1), 0),
    snapshotEvents: () => events.map(e => ({ type: e.type, seq: e.seq, time: e.time, data: e.data, surfaceOp: e.surfaceOp ?? 'append' }) as SessionEvent),
  }
}

test('plugin-owned dispute protocol tells Actor to BLOCK disagreements and Judge not to invent criteria', () => {
  assert.match(SUBMISSION_CONSTRAINT, /认可.*修正/)
  assert.match(SUBMISSION_CONSTRAINT, /分歧.*证据.*Manager/)
  assert.match(SUBMISSION_CONSTRAINT, /不伪报 failed/)
  const prompt = renderJudgePrompt({
    nodeToken: 'tok', criteria: 'existing criteria', workerOutcome: 'completed', workerHandoff: 'claim', workspaceCwd: '.', transcript: '',
  })
  assert.match(prompt, /existing criteria/)
  assert.match(prompt, /verifiable fact/i)
  assert.match(prompt, /NEED_CONTEXT/)
  assert.match(prompt, /preference.*criterion/i)
})

test('parseJudgeClaim accepts ACCEPT/REJECT/NEED_CONTEXT (A1 v2)', () => {
  assert.deepEqual(parseJudgeClaim({ result: 'ACCEPT', reason: 'good' }), { result: 'ACCEPT', reason: 'good' })
  assert.deepEqual(parseJudgeClaim({ result: 'REJECT', reason: 'bad' }), { result: 'REJECT', reason: 'bad' })
  assert.deepEqual(parseJudgeClaim({ result: 'NEED_CONTEXT', reason: 'need repo' }), { result: 'NEED_CONTEXT', reason: 'need repo' })
  // The v1 values are gone for good (D1: no dual-track).
  assert.equal(parseJudgeClaim({ result: 'PASS', reason: 'good' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'FAIL', reason: 'bad' }), undefined)
})

test('parseJudgeClaim rejects invalid shapes', () => {
  assert.equal(parseJudgeClaim({ result: 'MAYBE', reason: 'x' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'ACCEPT' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'ACCEPT', reason: '' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'ACCEPT', reason: '  ' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'ACCEPT', reason: 'x'.repeat(2001) }), undefined)
  assert.equal(parseJudgeClaim(null), undefined)
})

test('T2 Judge packet preserves the actual handoff literally, without a summary', () => {
  const handoff = '实际交付 $& {workspaceCwd} {transcript}'
  const text = renderJudgePrompt({ nodeToken: 'token', criteria: 'verify', workerOutcome: 'failed', workerHandoff: handoff, workspaceCwd: '.', transcript: '' })
  assert.ok(text.includes(`Worker handoff:\n${handoff}`))
  assert.doesNotMatch(text, /Worker summary/)
})

test('#44 P2: Judgment packet carries no nodeInstruction and anchors ACCEPT on facts + frozen criteria', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-44', criteria: 'PASS when built', workerHandoff: 'I built it',
    workerOutcome: 'completed', workspaceCwd: '.', transcript: '',
  })
  assert.doesNotMatch(text, /Node instruction/)
  assert.doesNotMatch(text, /node instruction/)
  assert.doesNotMatch(text, /当前工作单 input/)
  assert.match(text, /ACCEPT: the worker's claim is consistent with the facts and the goal criteria/)
  assert.match(text, /Goal criteria \(authoritative and frozen for this execution\):\nPASS when built/)
})

test('#44 P2: recovery packet keeps the read-only recovery protocol segment without any instruction', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-44', criteria: 'PASS', workerHandoff: 'candidate',
    workerOutcome: 'completed', workspaceCwd: '.', transcript: '', recovery: true,
  })
  assert.match(text, /只读核验当前 claim 与实际现场，不补做 Actor 工作/)
  assert.doesNotMatch(text, /Node instruction/)
})

test('renderJudgePrompt includes criteria, claim, cwd, transcript and the judge_claim protocol', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-1',
    criteria: 'PASS when built',
    workerHandoff: 'I built it',
    workerOutcome: 'completed',
    workspaceCwd: 'C:\\ws',
    transcript: 'USER\nhello',
  })
  assert.match(text, /PASS when built/)
  assert.match(text, /I built it/)
  assert.match(text, /C:\\ws/)
  assert.match(text, /USER\nhello/)
  assert.match(text, /judge_claim/)
  assert.match(text, /tok-1/)
  // A1 v2 protocol vocabulary.
  assert.match(text, /"ACCEPT" \| "REJECT" \| "NEED_CONTEXT"/)
  assert.doesNotMatch(text, /"PASS" \| "FAIL"/)
  // No previous-rejection section without evidence.
  assert.doesNotMatch(text, /Previous judgment on this node/)
})

test('renderJudgePrompt renders the [previous rejection] evidence before the claim (A1 §7.1)', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-1',
    criteria: 'PASS when built',
    workerHandoff: 'I built it',
    workerOutcome: 'completed',
    workspaceCwd: 'C:\\ws',
    transcript: '',
    previousFeedback: {
      result: 'REJECT', reason: 'tests missing',
      claim: { outcome: 'completed', handoff: 'notes' },
    },
  })
  assert.match(text, /# Previous Judge feedback on this node \(REJECT\)\n\[judge reason\]\ntests missing\n\n\[judged claim\]\noutcome: completed\nhandoff: notes\n/)
  const evidenceAt = text.indexOf('[judge reason]')
  const claimAt = text.indexOf('Worker claimed outcome')
  assert.ok(evidenceAt !== -1 && claimAt !== -1 && evidenceAt < claimAt, 'evidence precedes the worker claim')
})

test('fresh Judge packet preserves NEED_CONTEXT feedback and the current Manager resolution', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-1', criteria: 'PASS when built',
    workerHandoff: 'candidate', workerOutcome: 'completed', workspaceCwd: '.', transcript: '',
    previousFeedback: { result: 'NEED_CONTEXT', reason: 'need the approved scope decision', claim: { outcome: 'completed', handoff: 'candidate' } },
    managerContext: 'The approved scope explicitly includes this behavior.',
  })
  assert.match(text, /NEED_CONTEXT/)
  assert.match(text, /need the approved scope decision/)
  assert.match(text, /candidate/)
  assert.match(text, /The approved scope explicitly includes this behavior/)
  assert.match(text, /does not change frozen criteria/)
})

test('renderJudgePrompt renders an empty transcript placeholder', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-1', criteria: 'y', workerHandoff: 'z', workerOutcome: 'completed', workspaceCwd: '.', transcript: '',
  })
  assert.match(text, /no node-local conversation since dispatch/)
})

test('projectNodeLocal projects only post-boundary user/manager/actor messages, ordered by time', () => {
  const user = createUserMessage({ content: [{ type: 'text', text: 'user says hi' }], source: { kind: 'user' } })
  const pluginInjected = createUserMessage({ content: [{ type: 'text', text: 'plugin context' }], source: { kind: 'plugin', plugin: 'x' } })
  const assistantEvent = {
    turn: 1,
    step: 1,
    message: {
      id: 'm2' as never,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'manager reply' }],
      source: { kind: 'model', model: 'm' },
    },
  }
  const manager = makeSession([
    { type: 'user/message', data: user, surfaceOp: 'append' },
    { type: 'user/message', data: pluginInjected, surfaceOp: 'append' },
    { type: 'assistant/message', data: assistantEvent, surfaceOp: 'append' },
  ])
  // Boundary after the first event (seq 1) → only assistant reply projects.
  const boundary = { dispatchedAt: 0, managerFromSeq: 1 }
  const text = projectNodeLocal(manager, boundary)
  assert.match(text, /manager reply/)
  assert.doesNotMatch(text, /user says hi/)
  assert.doesNotMatch(text, /plugin context/)
})

test('projectNodeLocal excludes pre-boundary actor history via the dispatch message id (A1 AC2/AC3)', () => {
  const oldAssistant = { turn: 1, step: 1, message: { id: 'old-a' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'old actor reply' }], source: { kind: 'model', model: 'm' } } }
  // THIS node's dispatch message — the boundary anchor. `createUserMessage`
  // mints ids itself, so build the message literal with a known id.
  const dispatchMessage = {
    id: 'dispatch-msg' as never,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'new dispatch' }],
    source: { kind: 'user' as const },
  }
  const actor = makeSession([
    { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'old node work' }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'assistant/message', data: oldAssistant, surfaceOp: 'append' },
    { type: 'user/message', data: dispatchMessage, surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'new-a' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'new actor reply' }], source: { kind: 'model', model: 'm' } } }, surfaceOp: 'append' },
  ])
  const manager = makeSession([])
  const boundary = { dispatchedAt: 0, managerFromSeq: 0, executorSessionId: 'actor', executorDispatchMessageId: 'dispatch-msg' }
  const text = projectNodeLocal(manager, boundary, actor)
  assert.match(text, /new dispatch/)
  assert.match(text, /new actor reply/)
  assert.doesNotMatch(text, /old node work/)
  assert.doesNotMatch(text, /old actor reply/)
})

test('projectNodeLocal fails CLOSED when the dispatch message id is missing (A1 R2: no time fallback)', () => {
  const actor = makeSession([
    { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'old node work' }], source: { kind: 'user' } }), surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'old actor reply' }], source: { kind: 'model', model: 'm' } } }, surfaceOp: 'append' },
  ])
  const manager = makeSession([])
  const boundary = { dispatchedAt: 0, managerFromSeq: 0, executorSessionId: 'actor', executorDispatchMessageId: 'missing-id' }
  const text = projectNodeLocal(manager, boundary, actor)
  // The id cannot be located → the actor surface contributes NOTHING; losing
  // one node's actor context beats leaking the previous node's history.
  assert.equal(text, '')
})

test('ACTOR projection keeps coordinator relay dispatch text; MANAGER projection drops it (A1 R5/R6)', () => {
  const relay = createUserMessage({
    content: [{ type: 'text', text: '[handoff]\nrepo=acme/server\n\n[instruction]\nBuild.' }],
    source: { kind: 'coordinator', form: 'relay', senderSessionId: 'manager-1' },
  })
  const s = makeSession([{ type: 'user/message', data: relay, surfaceOp: 'append' }])
  // Manager surface (R5): coordinator relays are excluded like other notices.
  const managerView = projectSessionSurface(s, 0, 'MANAGER')
  assert.equal(managerView.length, 0)
  // Actor surface (R6): within the boundary, the relay IS the dispatch text.
  const actorView = projectSessionSurface(s, 0, 'ACTOR')
  assert.equal(actorView.length, 1)
  assert.match(actorView[0]!.text, /repo=acme\/server/)
})

test('target host Workflow queue provenance projects only for the Actor and only after its dispatch', () => {
  const dispatch = createUserMessage({ content: [{ type: 'text', text: 'current work' + SUBMISSION_CONSTRAINT }], source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' } })
  const actor = makeSession([
    { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'old work' }], source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' } }), surfaceOp: 'append' },
    { type: 'user/message', data: dispatch, surfaceOp: 'append' },
    { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'unrelated notice' }], source: { kind: 'plugin', plugin: 'other-plugin' } }), surfaceOp: 'append' },
  ])
  const text = projectNodeLocal(makeSession([]), {
    dispatchedAt: 0, managerFromSeq: 0, executorSessionId: actor.id, executorDispatchMessageId: dispatch.id,
  }, actor)
  assert.equal(text, '[ACTOR]\ncurrent work')
  assert.deepEqual(projectSessionSurface(actor, 0, 'MANAGER'), [])
})

test('the A3 submission constraint is stripped from the projected dispatch text (A3 R1/AC6)', () => {
  const relay = createUserMessage({
    content: [{ type: 'text', text: `[instruction]\nBuild it.${SUBMISSION_CONSTRAINT}` }],
    source: { kind: 'coordinator', form: 'relay', senderSessionId: 'manager-1' },
  })
  const s = makeSession([{ type: 'user/message', data: relay, surfaceOp: 'append' }])
  const out = projectSessionSurface(s, 0, 'ACTOR')
  assert.equal(out.length, 1)
  assert.match(out[0]!.text, /Build it\./)
  assert.doesNotMatch(out[0]!.text, /提交要求/)
  assert.doesNotMatch(out[0]!.text, /node_claim/)
})

test('#44 P2: executor dispatch compresses to [handoff]; later actor messages are untouched', () => {
  const dispatchText = `[handoff]\nroot request\n\n[instruction]\nPlan${SUBMISSION_CONSTRAINT}`
  const dispatch = { id: 'dispatch-44' as never, role: 'user' as const, content: [{ type: 'text' as const, text: dispatchText }], source: { kind: 'user' as const } }
  const actor = makeSession([
    { type: 'user/message', data: dispatch, surfaceOp: 'append' },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'a44' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'actor followup mentions [instruction] verbatim' }], source: { kind: 'model', model: 'm' } } }, surfaceOp: 'append' },
  ])
  const text = projectNodeLocal(makeSession([]), {
    dispatchedAt: 0, managerFromSeq: 0, executorSessionId: 'actor', executorDispatchMessageId: 'dispatch-44',
  }, actor)
  assert.match(text, /\[ACTOR\]\n\[handoff\]\nroot request$/m)
  assert.doesNotMatch(text, /\[ACTOR\]\n\[handoff\]\nroot request\n\n\[instruction\]/)
  assert.match(text, /actor followup mentions \[instruction\] verbatim/)
  // Manager/user surface is unaffected by dispatch compression.
  const user = createUserMessage({ content: [{ type: 'text', text: '[instruction]\nhuman note' }], source: { kind: 'user' } })
  const managerView = projectNodeLocal(makeSession([{ type: 'user/message', data: user, surfaceOp: 'append' }]), { dispatchedAt: 0, managerFromSeq: 0 })
  assert.match(managerView, /\[USER\]\n\[instruction\]\nhuman note/)
})

test('#44 P2: compressDispatchToHandoff strips instruction/criteria/constraint segments, keeps plain text', () => {
  assert.equal(
    compressDispatchToHandoff(`[handoff]\nroot request\n\n[instruction]\nPlan${SUBMISSION_CONSTRAINT}`),
    '[handoff]\nroot request',
  )
  // Legacy dispatch text with [criteria] compresses the same way.
  assert.equal(
    compressDispatchToHandoff('[handoff]\nreq\n\n[instruction]\nDo.\n\n[criteria]\nOld.'),
    '[handoff]\nreq',
  )
  assert.equal(compressDispatchToHandoff('plain actor note'), 'plain actor note')
})

test('stripping preserves the surrounding instruction and handoff text verbatim (A3 AC3)', () => {
  const text = `[handoff]\nrepo=acme/server\n\n[instruction]\nWrite the file.${SUBMISSION_CONSTRAINT}`
  const s = makeSession([
    { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), surfaceOp: 'append' },
  ])
  const out = projectSessionSurface(s, 0, 'ACTOR')
  assert.equal(out.length, 1)
  // Both non-constraint sections survive with their exact newlines.
  assert.match(out[0]!.text, /\[handoff\]\nrepo=acme\/server/)
  assert.match(out[0]!.text, /\[instruction\]\nWrite the file\.$/)
  assert.doesNotMatch(out[0]!.text, /提交要求/)
})

test('manager-session user messages project as USER, assistant output as MANAGER (A1 R3)', () => {
  const user = createUserMessage({ content: [{ type: 'text', text: 'human question' }], source: { kind: 'user' } })
  const assistant = { turn: 1, step: 1, message: { id: 'm' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'manager answer' }], source: { kind: 'model', model: 'm' } } }
  const s = makeSession([
    { type: 'user/message', data: user, surfaceOp: 'append' },
    { type: 'assistant/message', data: assistant, surfaceOp: 'append' },
  ])
  const out = projectSessionSurface(s, 0, 'MANAGER')
  assert.equal(out.length, 2)
  assert.equal(out[0]!.role, 'USER')
  assert.equal(out[1]!.role, 'MANAGER')
  const text = projectNodeLocal(s, { dispatchedAt: 0, managerFromSeq: 0 })
  assert.match(text, /\[USER\]\nhuman question/)
  assert.match(text, /\[MANAGER\]\nmanager answer/)
})

test('equal-time cross-session events order by stable session id, seq only within a session (A1 R3/AC4)', () => {
  const userMsg = createUserMessage({ content: [{ type: 'text', text: 'user event' }], source: { kind: 'user' } })
  const managerAssistant = { turn: 1, step: 1, message: { id: 'ma' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'manager event' }], source: { kind: 'model', model: 'm' } } }
  const actorAssistant = { turn: 1, step: 1, message: { id: 'aa' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'actor event' }], source: { kind: 'model', model: 'm' } } }
  // All three events share time=100; session ids: manager-session < actor-session.
  const manager = makeSource('manager-session', [
    { time: 100, seq: 7, type: 'user/message', data: userMsg },
    { time: 100, seq: 8, type: 'assistant/message', data: managerAssistant },
  ])
  const actor = makeSource('actor-session', [
    { time: 100, seq: 1, type: 'assistant/message', data: actorAssistant },
  ])
  const boundary = { dispatchedAt: 100, managerFromSeq: 0, executorSessionId: 'actor-session', executorDispatchMessageId: 'actor-dispatch' }
  // The actor cursor cannot locate 'actor-dispatch' (fail closed) → only the
  // manager surface projects; within it seq 7 < seq 8 at equal time.
  const text = projectNodeLocal(manager, boundary, actor)
  const userAt = text.indexOf('user event')
  const managerAt = text.indexOf('manager event')
  assert.ok(userAt !== -1 && managerAt !== -1)
  assert.ok(userAt < managerAt, 'within-session seq orders equal-time events')
  assert.doesNotMatch(text, /actor event/)
  // Cross-session equal-time tie-break: give the actor a matchable dispatch id
  // so both surfaces project; manager-session < actor-session → manager first.
  const dispatch = { id: 'actor-dispatch' as never, role: 'user' as const, content: [{ type: 'text' as const, text: 'actor dispatch' }], source: { kind: 'user' as const } }
  const actor2 = makeSource('actor-session', [
    { time: 100, seq: 0, type: 'user/message', data: dispatch },
    { time: 100, seq: 1, type: 'assistant/message', data: actorAssistant },
  ])
  const text2 = projectNodeLocal(manager, boundary, actor2)
  const managerAt2 = text2.indexOf('manager event')
  const actorAt2 = text2.indexOf('actor event')
  assert.ok(managerAt2 !== -1 && actorAt2 !== -1)
  // 'actor-session' < 'manager-session' lexicographically → the actor surface
  // precedes the manager surface at equal time (stable, deterministic).
  assert.ok(actorAt2 < managerAt2, 'stable session-id tie-break across sessions at equal time')
})

test('messageText extracts only text blocks', () => {
  const message = { id: 'm' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a' }, { type: 'reasoning' as const, text: 'think' }], source: { kind: 'model' as const, model: 'm' } }
  assert.equal(messageText(message), 'a')
})

test('projectSessionSurface filters plugin/user and assistant text', () => {
  const user = createUserMessage({ content: [{ type: 'text', text: 'u' }], source: { kind: 'user' } })
  const plugin = createUserMessage({ content: [{ type: 'text', text: 'p' }], source: { kind: 'plugin', plugin: 'x' } })
  const assistant = { turn: 1, step: 1, message: { id: 'm' as never, role: 'assistant' as const, content: [{ type: 'text' as const, text: 'a' }], source: { kind: 'model', model: 'm' } } }
  const s = makeSession([
    { type: 'user/message', data: user, surfaceOp: 'append' },
    { type: 'user/message', data: plugin, surfaceOp: 'append' },
    { type: 'assistant/message', data: assistant, surfaceOp: 'append' },
  ])
  const out = projectSessionSurface(s, 0, 'MANAGER')
  assert.equal(out.length, 2)
  assert.equal(out[0]!.text, 'u')
  assert.equal(out[1]!.text, 'a')
})
