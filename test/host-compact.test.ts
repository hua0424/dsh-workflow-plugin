import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { makeSubagentHost } from '../src/plugin/host.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState } from '../src/types.ts'

const CONFIG = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles:
  developer:
    persona: Developer persona.
    model: { provider: p1, modelId: m1 }
  reviewer:
    persona: Reviewer persona.
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`), { workflowId: 'host-compact-test' })

function makeRun(actorForDeveloper: string | undefined): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'manager',
    catalogWorkflowId: 'host-compact-test',
    definitionHash: 'hash',
    definitionSnapshot: CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'host-compact-test', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: actorForDeveloper === undefined ? {} : { developer: actorForDeveloper },
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
}

function manualError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { name: 'ManualCompactionError', code })
}

interface CompactCall { agent: Agent; }
interface ResumeCall { resumeSessionId: unknown; agentOptions: unknown }

/** Fake host surface for compactRoleActor: ctx.get('compaction'), ctx.agents. */
function makeHost(options: {
  resident?: Agent
  resumeResult?: { handle?: AgentHandle; error?: Error }
  compactResult?: { shadowedSeqs: number[]; shadowedTokenCount: number } | null
  compactError?: Error
  disposeError?: Error
  events: string[]
  resumes: ResumeCall[]
  compacts: CompactCall[]
}) {
  const compaction = {
    compactNow: async (agent: Agent, _signal: AbortSignal) => {
      options.compacts.push({ agent })
      options.events.push('compact')
      if (options.compactError !== undefined) throw options.compactError
      return options.compactResult ?? null
    },
  }
  const materialized: Agent = { id: 'materialized' } as unknown as Agent
  const fakeCtx = {
    get: (key: string) => (key === 'compaction' ? compaction : undefined),
    agents: {
      get: (id: unknown) => (options.resident !== undefined && id === 'sess-dev' ? options.resident : undefined),
      resume: async (call: ResumeCall) => {
        options.resumes.push(call)
        options.events.push('resume')
        if (options.resumeResult?.error !== undefined) throw options.resumeResult.error
        return options.resumeResult?.handle ?? {
          agent: materialized,
          dispose: async () => {
            options.events.push('dispose')
            if (options.disposeError !== undefined) throw options.disposeError
          },
        }
      },
    },
  }
  const adapters = {
    ctx: fakeCtx as unknown as Context,
    managerAgentOf: () => undefined,
    cwdOfManager: async () => undefined,
    registerJudgeSession: () => {},
    revokeJudgeSession: () => {},
    registerRoleActorSession: () => {},
  }
  return { host: makeSubagentHost(adapters, () => ({})), materialized }
}

test('cold actor: materialize → compactNow → dispose, role route passed to resume', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host, materialized } = makeHost({ ...f, compactResult: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234 } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: true, detail: 'cold compacted 3 items (~1234 tokens)' })
  assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
  assert.equal(f.resumes.length, 1)
  assert.equal(f.resumes[0]!.resumeSessionId, 'sess-dev')
  assert.deepEqual(f.resumes[0]!.agentOptions, { provider: 'p1', model: 'm1' })
  assert.equal(f.compacts[0]!.agent, materialized)
})

test('cold actor: null compact result continues with cold-noop detail and still disposes', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, compactResult: null })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: true, detail: 'cold: no compactable range' })
  assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
})

test('cold actor: ManualCompactionError fail-closes but the materialization is still released', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, compactError: manualError('summary', 'summarizer exploded') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: false, detail: 'compaction summary: summarizer exploded' })
  assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
})

test('cold actor: resume failure fail-closes without compact or dispose', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, resumeResult: { error: new Error('session persistence is not configured') } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: false, detail: 'cold materialize failed: session persistence is not configured' })
  assert.deepEqual(f.events, ['resume'])
  assert.equal(f.compacts.length, 0)
})

test('cold actor: dispose failure fail-closes (a leaked resident agent would break the followup)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, compactResult: { shadowedSeqs: [1], shadowedTokenCount: 9 }, disposeError: new Error('teardown wedged') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: false, detail: 'cold materialize teardown failed: teardown wedged' })
  assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
})

test('cold actor with no role model and no frozen route resumes with undefined agentOptions', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, compactResult: null })
  // reviewer has no model in the config; frozenRoute is () => ({}) in makeHost.
  const result = await host.compactRoleActor({ ...makeRun('sess-rev'), roleActors: { reviewer: 'sess-rev' } } as RunState, 'reviewer')
  assert.deepEqual(result, { ok: true, detail: 'cold: no compactable range' })
  assert.equal(f.resumes[0]!.agentOptions, undefined)
  assert.equal(f.resumes[0]!.resumeSessionId, 'sess-rev')
})

test('resident idle actor: compacted in place, never materialized', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = { id: 'sess-dev' } as unknown as Agent
  const { host } = makeHost({ ...f, resident, compactResult: { shadowedSeqs: [7], shadowedTokenCount: 42 } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: true, detail: 'compacted 1 items (~42 tokens)' })
  assert.deepEqual(f.events, ['compact'])
  assert.equal(f.compacts[0]!.agent, resident)
  assert.equal(f.resumes.length, 0)
})

test('resident busy actor (Judge raced the actor turn tail): degrades to a skip', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, resident: {} as Agent, compactError: manualError('busy', 'agent is active') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: true, detail: 'resident actor busy; skipped' })
  assert.equal(f.resumes.length, 0)
})

test('resident actor non-busy manual failure fail-closes', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, resident: {} as Agent, compactError: manualError('commit', 'durable marker lost') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: false, detail: 'compaction commit: durable marker lost' })
})

test('missing compaction service skips without touching the registry', async () => {
  const events: string[] = []
  const fakeCtx = {
    get: () => undefined,
    agents: { get: () => undefined, resume: async () => { throw new Error('must not resume') } },
  }
  const adapters = {
    ctx: fakeCtx as unknown as Context,
    managerAgentOf: () => undefined,
    cwdOfManager: async () => undefined,
    registerJudgeSession: () => {},
    revokeJudgeSession: () => {},
    registerRoleActorSession: () => {},
  }
  const host = makeSubagentHost(adapters, () => ({}))
  assert.deepEqual(await host.compactRoleActor(makeRun('sess-dev'), 'developer'), { ok: true, detail: 'no compaction service' })
  assert.deepEqual(events, [])
})

test('unmapped role is a no-op', async () => {
  const { host } = makeHost({ events: [], resumes: [], compacts: [] })
  assert.deepEqual(await host.compactRoleActor(makeRun(undefined), 'developer'), { ok: true, detail: 'no actor mapped' })
})
