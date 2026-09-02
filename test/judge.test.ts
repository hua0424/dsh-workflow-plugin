import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJudgeResult, renderJudgePrompt } from '../src/judge/checker.ts'
import { projectManagerTranscript } from '../src/judge/projection.ts'
import { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

function makeSession(events: Array<{ type: string; data: unknown; surfaceOp?: unknown }>): Session {
  const id = 'sess-test' as SessionId
  const session = Session.create(id)
  // Session.append requires the store-owned publication hooks; for detached
  // sessions append is allowed but does not publish (no observers).
  for (const event of events) {
    const opts = event.surfaceOp === undefined
      ? []
      : [{ surfaceOp: event.surfaceOp } as never]
    ;(session.append as (t: string, d: unknown, ...opts: unknown[]) => unknown)(event.type, event.data, ...opts)
  }
  return session
}

test('parseJudgeResult accepts bare JSON', () => {
  assert.deepEqual(parseJudgeResult('{"result":"PASS","reason":"good"}'), { result: 'PASS', reason: 'good' })
})

test('parseJudgeResult accepts fenced JSON', () => {
  const text = '```json\n{"result":"FAIL","reason":"bad"}\n```'
  assert.deepEqual(parseJudgeResult(text), { result: 'FAIL', reason: 'bad' })
})

test('parseJudgeResult rejects invalid shapes', () => {
  assert.throws(() => parseJudgeResult('{"result":"MAYBE","reason":"x"}'))
  assert.throws(() => parseJudgeResult('{"result":"PASS"}'))
  assert.throws(() => parseJudgeResult('not json'))
  assert.throws(() => parseJudgeResult('{"result":"PASS","reason":""}'))
})

test('renderJudgePrompt includes criteria, claim, cwd and transcript', () => {
  const text = renderJudgePrompt({
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
})

test('renderJudgePrompt renders an empty transcript placeholder', () => {
  const text = renderJudgePrompt({
    nodeInstruction: 'x', criteria: 'y', workerSummary: 'z', workerOutcome: 'completed', workspaceCwd: '.', transcript: '',
  })
  assert.match(text, /no prior user\/manager conversation/)
})

test('projectManagerTranscript keeps only user/manager messages', () => {
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
  const session = makeSession([
    { type: 'user/message', data: user, surfaceOp: 'append' },
    { type: 'user/message', data: pluginInjected, surfaceOp: 'append' },
    { type: 'assistant/message', data: assistantEvent, surfaceOp: 'append' },
  ])
  const text = projectManagerTranscript(session)
  assert.match(text, /user says hi/)
  assert.match(text, /manager reply/)
  assert.doesNotMatch(text, /plugin context/)
})
