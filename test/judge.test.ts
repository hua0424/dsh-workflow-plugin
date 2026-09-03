import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJudgeClaim, renderJudgePrompt } from '../src/judge/checker.ts'
import { projectNodeLocal, projectSessionSurface, messageText } from '../src/judge/projection.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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

test('parseJudgeClaim accepts PASS/FAIL/NEED_CONTEXT', () => {
  assert.deepEqual(parseJudgeClaim({ result: 'PASS', reason: 'good' }), { result: 'PASS', reason: 'good' })
  assert.deepEqual(parseJudgeClaim({ result: 'FAIL', reason: 'bad' }), { result: 'FAIL', reason: 'bad' })
  assert.deepEqual(parseJudgeClaim({ result: 'NEED_CONTEXT', reason: 'need repo' }), { result: 'NEED_CONTEXT', reason: 'need repo' })
})

test('parseJudgeClaim rejects invalid shapes', () => {
  assert.equal(parseJudgeClaim({ result: 'MAYBE', reason: 'x' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'PASS' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'PASS', reason: '' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'PASS', reason: '  ' }), undefined)
  assert.equal(parseJudgeClaim({ result: 'PASS', reason: 'x'.repeat(2001) }), undefined)
  assert.equal(parseJudgeClaim(null), undefined)
})

test('renderJudgePrompt includes criteria, claim, cwd, transcript and the judge_claim protocol', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-1',
    nodeInstruction: 'Build it',
    criteria: 'PASS when built',
    workerSummary: 'I built it',
    workerOutcome: 'completed',
    workspaceCwd: 'C:\\ws',
    transcript: 'USER\nhello',
  })
  assert.match(text, /Build it/)
  assert.match(text, /PASS when built/)
  assert.match(text, /I built it/)
  assert.match(text, /C:\\ws/)
  assert.match(text, /USER\nhello/)
  assert.match(text, /judge_claim/)
  assert.match(text, /tok-1/)
})

test('renderJudgePrompt renders an empty transcript placeholder', () => {
  const text = renderJudgePrompt({
    nodeToken: 'tok-1', nodeInstruction: 'x', criteria: 'y', workerSummary: 'z', workerOutcome: 'completed', workspaceCwd: '.', transcript: '',
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
