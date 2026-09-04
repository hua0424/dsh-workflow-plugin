/**
 * A1 §2 / 评审补充4: caller-turn binding helper — pure-function tests over
 * synthetic session logs (native path, Code Mode path, fail-closed cases).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callerTurnUserMessageIds, type TurnBindEvent } from '../src/plugin/turnbind.ts'

function ev(seq: number, type: string, data: unknown): TurnBindEvent {
  return { type, seq, data }
}

function idsOf(result: ReadonlySet<string> | undefined): string[] {
  assert.ok(result !== undefined, 'expected a binding set')
  return [...result]
}

test('native path: collects the turn user/message ids up to the tool call', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { id: 'u-old', source: { kind: 'user' } }),
    ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ev(4, 'turn/start', { turn: 2 }),
    ev(5, 'user/message', { id: 'u-dispatch', source: { kind: 'user' } }),
    ev(6, 'assistant/message', { turn: 2, step: 1, message: { id: 'a1' } }),
    ev(7, 'tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'node_claim', arguments: '{}' }),
  ]
  assert.deepEqual(idsOf(callerTurnUserMessageIds(events, 'call-1', 'call-1')), ['u-dispatch'])
})

test('native path: mid-turn steers join the id set (set membership, not first-message)', () => {
  const events = [
    ev(1, 'turn/start', { turn: 5 }),
    ev(2, 'user/message', { id: 'u-first' }),
    ev(3, 'user/message', { id: 'u-steer' }),
    ev(4, 'tool/call', { turn: 5, step: 2, callId: 'c9', name: 'node_claim', arguments: '{}' }),
  ]
  const ids = callerTurnUserMessageIds(events, 'c9', 'c9')
  assert.deepEqual(new Set(idsOf(ids)), new Set(['u-first', 'u-steer']))
})

test('native path: an old turn cannot see a newer dispatch id', () => {
  const events = [
    ev(1, 'turn/start', { turn: 3 }),
    ev(2, 'user/message', { id: 'u-old-dispatch' }),
    ev(3, 'tool/call', { turn: 3, step: 1, callId: 'c-old', name: 'node_claim', arguments: '{}' }),
    ev(4, 'turn/end', { turn: 3, reason: { kind: 'completed' } }),
    ev(5, 'turn/start', { turn: 4 }),
    ev(6, 'user/message', { id: 'u-new-dispatch' }),
  ]
  // The old turn's set contains only the OLD dispatch id — binding against the
  // new dispatch (not in the set) fails at the admission gate, not here.
  assert.deepEqual(idsOf(callerTurnUserMessageIds(events, 'c-old', 'c-old')), ['u-old-dispatch'])
})

test('Code Mode path: subCallId + rootCallId double binding locates the root run_code turn', () => {
  const events = [
    ev(1, 'turn/start', { turn: 2 }),
    ev(2, 'user/message', { id: 'u-code-dispatch' }),
    ev(3, 'tool/call', { turn: 2, step: 1, callId: 'root-1', name: 'run_code', arguments: '{}' }),
    ev(4, 'tool/code-dispatch-start', { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'root-1:code:1', name: 'node_claim', arguments: {} }),
    ev(5, 'tool/code-dispatch', { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'root-1:code:1', name: 'node_claim', isError: false, content: [] }),
  ]
  assert.deepEqual(idsOf(callerTurnUserMessageIds(events, 'root-1:code:1', 'root-1')), ['u-code-dispatch'])
})

test('Code Mode path: nested run_code resolves through the shared rootCallId', () => {
  const events = [
    ev(1, 'turn/start', { turn: 9 }),
    ev(2, 'user/message', { id: 'u-deep' }),
    ev(3, 'tool/call', { turn: 9, step: 1, callId: 'root-9', name: 'run_code', arguments: '{}' }),
    ev(4, 'tool/code-dispatch-start', { rootCallId: 'root-9', parentCallId: 'root-9', subCallId: 'root-9:code:1', name: 'run_code', arguments: {} }),
    ev(5, 'tool/code-dispatch-start', { rootCallId: 'root-9', parentCallId: 'root-9:code:1', subCallId: 'root-9:code:1:code:2', name: 'node_claim', arguments: {} }),
  ]
  assert.deepEqual(idsOf(callerTurnUserMessageIds(events, 'root-9:code:1:code:2', 'root-9')), ['u-deep'])
})

test('fail-closed: forged code-style callId without a matching start event', () => {
  const events = [
    ev(1, 'turn/start', { turn: 2 }),
    ev(2, 'user/message', { id: 'u1' }),
    ev(3, 'tool/call', { turn: 2, step: 1, callId: 'root-1', name: 'run_code', arguments: '{}' }),
  ]
  assert.equal(callerTurnUserMessageIds(events, 'x:code:1', 'root-1'), undefined)
})

test('fail-closed: start event exists but rootCallId does not match', () => {
  const events = [
    ev(1, 'turn/start', { turn: 2 }),
    ev(2, 'user/message', { id: 'u1' }),
    ev(3, 'tool/call', { turn: 2, step: 1, callId: 'root-1', name: 'run_code', arguments: '{}' }),
    ev(4, 'tool/code-dispatch-start', { rootCallId: 'root-1', parentCallId: 'root-1', subCallId: 'root-1:code:1', name: 'node_claim', arguments: {} }),
  ]
  // A different claimed root cannot borrow the real root's turn.
  assert.equal(callerTurnUserMessageIds(events, 'root-1:code:1', 'someone-else'), undefined)
})

test('fail-closed: subCallId matches but the root tool/call is missing', () => {
  const events = [
    ev(1, 'turn/start', { turn: 2 }),
    ev(2, 'user/message', { id: 'u1' }),
    ev(3, 'tool/code-dispatch-start', { rootCallId: 'ghost', parentCallId: 'ghost', subCallId: 'ghost:code:1', name: 'node_claim', arguments: {} }),
  ]
  assert.equal(callerTurnUserMessageIds(events, 'ghost:code:1', 'ghost'), undefined)
})

test('fail-closed: unknown callId anywhere', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { id: 'u1' }),
    ev(3, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'node_claim', arguments: '{}' }),
  ]
  assert.equal(callerTurnUserMessageIds(events, 'call-other', 'call-other'), undefined)
})

test('fail-closed: tool/call without a numeric turn field', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'tool/call', { callId: 'call-1', name: 'node_claim', arguments: '{}' }),
  ]
  assert.equal(callerTurnUserMessageIds(events, 'call-1', 'call-1'), undefined)
})

test('fail-closed: turn/start mismatch while scanning back (log anomaly)', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { id: 'u1' }),
    ev(3, 'tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'node_claim', arguments: '{}' }),
  ]
  assert.equal(callerTurnUserMessageIds(events, 'call-1', 'call-1'), undefined)
})

test('fail-closed: log truncated before the turn start', () => {
  const events = [
    ev(1, 'user/message', { id: 'u1' }),
    ev(2, 'tool/call', { turn: 2, step: 1, callId: 'call-1', name: 'node_claim', arguments: '{}' }),
  ]
  assert.equal(callerTurnUserMessageIds(events, 'call-1', 'call-1'), undefined)
})

test('fail-closed: empty log', () => {
  assert.equal(callerTurnUserMessageIds([], 'call-1', 'call-1'), undefined)
})
