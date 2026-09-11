import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as binding from '../src/plugin/turnbind.ts'
import { makeSubagentHost, type HostAdapters } from '../src/plugin/host.ts'
import { inject } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

function makeSafetyHost(ctx: Context, manager: Agent) {
  return makeSubagentHost({ ctx, managerAgentOf: () => manager, cwdOfManager: async () => undefined,
    registerJudgeSession() {}, revokeJudgeSession() {}, registerRoleActorSession() {} } satisfies HostAdapters, () => ({}))
}

test('plugin injects the standard Web services but never compaction (preset-plane since dsh rc.7)', () => {
  // compaction 由每个会话的 preset 在 isolate 域挂载（web-app bundle 禁用了
  // 宿主平面副本），宿主行 inject 只会永久 pending 并卡死 boot；运行期按
  // agent 解析（host.ts compactionFor）。
  assert.deepEqual(inject, ['commands', 'tools', 'subagents', 'agents', 'sessions', 'jobs'])
})

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

test('safe inspection rejects a different live Activation for the observed Session', async () => {
  const oldActor = { id: 'actor', status: 'idle', session: { id: 'actor', header: {} }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  const replacement = { ...oldActor, whenIdle: async () => {} } as unknown as Agent
  let current: Agent | undefined = oldActor
  const ctx = {
    jobs: { list: () => [], onJobDone: () => () => {} }, effect: () => {},
    agents: { get: () => current, list: () => current ? [current] : [] },
    subagents: { listDescendants: async () => [] },
  } as unknown as Context
  const host = makeSafetyHost(ctx, oldActor)
  host.observeTurnEnd('actor')
  current = replacement
  assert.equal(await host.safeToInspect('actor'), false)
})

test('safe inspection rejects a descendant that appears while idle checks await', async () => {
  let checks = 0
  let child: Agent | undefined
  const actor = {
    id: 'actor', status: 'idle', session: { id: 'actor', header: {} }, inbox: { nextTurn: [], nextStep: [] },
    whenIdle: async () => { if (++checks === 2) child = { id: 'child', status: 'running', session: { id: 'child', header: { parentSession: 'actor' } }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent },
  } as unknown as Agent
  const ctx = {
    jobs: { list: () => [], onJobDone: () => () => {} }, effect: () => {},
    agents: { get: (id: unknown) => id === 'actor' ? actor : child, list: () => child ? [actor, child] : [actor] },
    subagents: { listDescendants: async () => [] },
  } as unknown as Context
  const host = makeSafetyHost(ctx, actor)
  assert.equal(await host.safeToInspect('actor'), false)
})

test('safe inspection requires observable idle descendants, empty inboxes, and terminal non-orphan jobs', async () => {
  const actor = { id: 'actor', status: 'idle', session: { id: 'actor', header: {} }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  const child = { id: 'child', status: 'idle', session: { id: 'child', header: { parentSession: 'actor' } }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  let descendants: unknown[] = []
  let live: Agent[] = [actor]
  let jobs: Array<{ status: string; ownerSession?: string; detail?: string }> = []
  const ctx = {
    jobs: { list: () => jobs, onJobDone: () => () => {} }, effect: () => {},
    agents: { get: (id: unknown) => live.find(agent => agent.id === id), list: () => live },
    subagents: { listDescendants: async () => descendants },
  } as unknown as Context
  const host = makeSafetyHost(ctx, actor)

  descendants = [{ kind: 'diagnostic', id: 'child', reason: 'corrupt', parentId: 'actor', depth: 1 }]
  assert.equal(await host.safeToInspect('actor'), false)
  descendants = [{ kind: 'child', id: 'child', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'child', parentId: 'actor', depth: 1 }]
  assert.equal(await host.safeToInspect('actor'), true, 'durably inactive descendant has no live Activation')
  descendants = [{ kind: 'child', id: 'child', activity: 'running', hasChildren: false, mode: 'continuable', label: 'child', parentId: 'actor', depth: 1 }]
  assert.equal(await host.safeToInspect('actor'), false, 'running descriptor without an Agent is unknown')
  live = [actor, { ...child, status: 'running' } as unknown as Agent]
  assert.equal(await host.safeToInspect('actor'), false)
  live = [actor, { ...child, inbox: { nextTurn: [{}], nextStep: [] } } as unknown as Agent]
  assert.equal(await host.safeToInspect('actor'), false)
  live = [actor, child]
  jobs = [{ status: 'running' }]
  assert.equal(await host.safeToInspect('actor'), true, 'unowned jobs do not belong to the Role tree')
  jobs = [{ status: 'stopping', ownerSession: 'actor' }]
  assert.equal(await host.safeToInspect('actor'), false)
  jobs = [{ status: 'completed', ownerSession: 'actor' }]
  assert.equal(await host.safeToInspect('actor'), true)
  jobs = [{ status: 'failed', ownerSession: 'actor', detail: 'work may be orphaned after teardown' }]
  assert.equal(await host.safeToInspect('actor'), false)
})

test('orphan evidence follows its exact nested Session across descriptor removal without tainting a new Session', async () => {
  const actor = { id: 'actor', status: 'idle', session: { id: 'actor', header: {} }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  const branch = { id: 'branch-old', status: 'idle', session: { id: 'branch-old', header: { parentSession: 'actor' } }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  const leaf = { id: 'leaf-old', status: 'idle', session: { id: 'leaf-old', header: { parentSession: 'branch-old' } }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  const fresh = { id: 'fresh', status: 'idle', session: { id: 'fresh', header: {} }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} } as unknown as Agent
  let descendants: unknown[] = [
    { kind: 'child', id: 'branch-old', activity: 'running', hasChildren: true, mode: 'continuable', label: 'branch', parentId: 'actor', depth: 1 },
    { kind: 'child', id: 'leaf-old', activity: 'inactive', hasChildren: false, mode: 'continuable', label: 'leaf', parentId: 'branch-old', depth: 2 },
  ]
  let branchLive = true
  let done: ((job: { detail?: string }, owner?: Agent) => void) | undefined
  const ctx = {
    jobs: { list: () => [], onJobDone: (listener: typeof done) => { done = listener; return () => {} } }, effect: () => {},
    agents: {
      get: (id: unknown) => id === 'actor' ? actor : id === 'branch-old' && branchLive ? branch : id === 'fresh' ? fresh : undefined,
      list: () => branchLive ? [actor, branch, fresh] : [actor, fresh],
    },
    subagents: { listDescendants: async (id: unknown) => id === 'actor' ? descendants : [] },
  } as unknown as Context
  const host = makeSafetyHost(ctx, actor)
  assert.equal(await host.safeToInspect('actor'), true)
  branchLive = false
  done?.({ detail: 'work may be orphaned after forced cleanup' }, leaf)
  descendants = []
  assert.equal(await host.safeToInspect('actor'), false, 'known ancestry survives an unavailable middle Agent and descriptor removal')
  assert.equal(await host.safeToInspect('fresh'), true)
})

test('safe inspection waits exact Agent, rejects job tail and retains cold/orphan evidence', async () => {
  const idle = Promise.withResolvers<void>()
  let live = true
  let jobs: Array<{ status: string; ownerSession?: string; detail?: string }> = []
  let done: ((job: { detail?: string }, owner?: Agent) => void) | undefined
  let dispose: (() => void) | undefined
  let unsubscribed = false
  const actor = { id: 'actor', status: 'idle', session: { id: 'actor', header: {} }, inbox: { nextTurn: [], nextStep: [] }, whenIdle: () => idle.promise } as unknown as Agent
  const ctx = {
    get: () => { throw new Error('required services must use direct Context properties') },
    jobs: { list: () => jobs, onJobDone: (listener: typeof done) => { done = listener; return () => { unsubscribed = true; done = undefined } } },
    effect: (factory: () => () => void) => { dispose = factory() },
    agents: { get: () => live ? actor : undefined, list: () => live ? [actor] : [] },
    subagents: { listDescendants: async () => [] },
  } as unknown as Context
  const host = makeSafetyHost(ctx, actor)
  host.observeTurnEnd('actor')
  let settled = false
  const checking = host.safeToInspect('actor').then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false, 'public idle does not prove maintenance/driver quiescence')
  jobs = [{ status: 'stopping', ownerSession: 'actor' }]
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
