import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as binding from '../src/plugin/turnbind.ts'
import { makeSubagentHost, type HostAdapters } from '../src/plugin/host.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

test('turn/end binds its exact completed turn, never a later dispatch', () => {
  const end = { seq: 3, type: 'turn/end', data: { turn: 1 } }
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: 'dispatch-old' } },
    { seq: 2, type: 'user/message', data: { id: 'steer' } }, end,
    { seq: 4, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, type: 'user/message', data: { id: 'dispatch-new' } },
  ]
  assert.deepEqual(binding.endedTurnUserMessageIds(events, end), new Set(['steer', 'dispatch-old']))
  assert.equal(binding.endedTurnUserMessageIds(events, { ...end, data: { turn: 9 } }), undefined)
})

test('safe inspection waits exact Agent, rejects job tail and retains cold/orphan evidence', async () => {
  const idle = Promise.withResolvers<void>()
  let live = true
  let jobs: Array<{ status: string; detail?: string }> = []
  let done: ((job: { detail?: string }, owner?: Agent) => void) | undefined
  let dispose: (() => void) | undefined
  let unsubscribed = false
  const actor = { id: 'actor', status: 'idle', session: { id: 'actor', header: {} }, inbox: { hasPending: false }, whenIdle: () => idle.promise } as unknown as Agent
  const ctx = {
    get: () => ({ list: () => jobs, onJobDone: (listener: typeof done) => { done = listener; return () => { unsubscribed = true; done = undefined } } }),
    effect: (factory: () => () => void) => { dispose = factory() },
    agents: { get: () => live ? actor : undefined, list: () => live ? [actor] : [] },
    subagents: { listDescendants: async () => [] },
  } as unknown as Context
  const host = makeSubagentHost({ ctx, managerAgentOf: () => actor, cwdOfManager: async () => undefined,
    registerJudgeSession() {}, revokeJudgeSession() {}, registerRoleActorSession() {} } satisfies HostAdapters, () => ({}))
  host.observeTurnEnd('actor')
  let settled = false
  const checking = host.safeToInspect('actor').then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false, 'public idle does not prove maintenance/driver quiescence')
  jobs = [{ status: 'stopping' }]
  idle.resolve()
  assert.equal(await checking, false)
  jobs = []
  live = false
  assert.equal(await host.safeToInspect('actor'), true, 'recorded exact Agent survives cold release')
  done?.({ detail: 'cancel threw during teardown; work may be orphaned: boom' }, actor)
  assert.equal(await host.safeToInspect('actor'), false, 'removing job snapshots cannot erase orphan evidence')
  dispose?.()
  assert.equal(unsubscribed, true)
  assert.equal(done, undefined)
  live = true
  assert.equal(await host.safeToInspect('actor'), true, 'disposal clears old orphan evidence')
  live = false
  assert.equal(await host.safeToInspect('actor'), false, 'disposal releases retained Agent references')
})
