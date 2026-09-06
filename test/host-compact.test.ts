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
schemaVersion: agent-workflow/v2
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
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
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

/** Agent stub carrying a Session surface (what the threshold gate measures). */
function agentWithSession(id: string): Agent {
  return { id, session: { id } } as unknown as Agent
}

function manualError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { name: 'ManualCompactionError', code })
}

interface CompactCall { agent: Agent; }
interface ResumeCall { resumeSessionId: unknown; agentOptions: unknown }
/** Issue #5: scripted `ctx.tokenMeter` surface. */
interface MeterSpec { totalTokens?: unknown; error?: Error }

/** Fake host surface for compactRoleActor: ctx.get('compaction'), ctx.get('tokenMeter'), ctx.agents. */
function makeHost(options: {
  resident?: Agent
  resumeResult?: { handle?: AgentHandle; error?: Error }
  compactResult?: { shadowedSeqs: number[]; shadowedTokenCount: number } | null
  compactError?: Error
  disposeError?: Error
  meter?: MeterSpec
  events: string[]
  resumes: ResumeCall[]
  compacts: CompactCall[]
}) {
  const measures: Array<unknown> = []
  const meter = options.meter === undefined
    ? undefined
    : {
      measure: (session: unknown) => {
        measures.push(session)
        if (options.meter!.error !== undefined) throw options.meter!.error
        return { totalTokens: options.meter!.totalTokens }
      },
    }
  const compaction = {
    compactNow: async (agent: Agent, _signal: AbortSignal) => {
      options.compacts.push({ agent })
      options.events.push('compact')
      if (options.compactError !== undefined) throw options.compactError
      return options.compactResult ?? null
    },
  }
  // The cold-materialized agent also carries a Session (the gate measures it).
  const materialized: Agent = agentWithSession('materialized')
  const fakeCtx = {
    get: (key: string) => {
      if (key === 'compaction') return compaction
      if (key === 'tokenMeter') return meter
      return undefined
    },
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
  return { host: makeSubagentHost(adapters, () => ({})), materialized, measures }
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

// ---- compactThresholdTokens gate (Issue #5 / milestone subagent-compact-threshold) ----

const THRESHOLD = 5000

test('threshold resident actor BELOW threshold: measures the resident session, skips compactNow (AC3)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host, measures } = makeHost({ ...f, resident, meter: { totalTokens: THRESHOLD - 1 } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `compact skip (below threshold): totalTokens=${THRESHOLD - 1} vs compactThresholdTokens=${THRESHOLD}` })
  assert.deepEqual(f.events, [])
  assert.equal(f.compacts.length, 0)
  assert.equal(f.resumes.length, 0)
  assert.deepEqual(measures, [resident.session])
})

test('threshold resident actor AT threshold: strictly-greater comparison skips compactNow (AC4)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host } = makeHost({ ...f, resident, meter: { totalTokens: THRESHOLD } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `compact skip (at threshold): totalTokens=${THRESHOLD} vs compactThresholdTokens=${THRESHOLD}` })
  assert.deepEqual(f.events, [])
  assert.equal(f.compacts.length, 0)
})

test('threshold resident actor ABOVE threshold: compactNow runs exactly once with the gate in the detail (AC5)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host, measures } = makeHost({ ...f, resident, meter: { totalTokens: THRESHOLD + 1 }, compactResult: { shadowedSeqs: [7], shadowedTokenCount: 42 } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `compact run (above threshold): totalTokens=${THRESHOLD + 1} vs compactThresholdTokens=${THRESHOLD}; compacted 1 items (~42 tokens)` })
  assert.deepEqual(f.events, ['compact'])
  assert.equal(f.compacts.length, 1)
  assert.deepEqual(measures, [resident.session])
})

test('threshold resident actor above threshold with a null compact result: no-op branch stays distinct from skip', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host } = makeHost({ ...f, resident, meter: { totalTokens: THRESHOLD + 1 }, compactResult: null })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `compact run (above threshold): totalTokens=${THRESHOLD + 1} vs compactThresholdTokens=${THRESHOLD}; no compactable range` })
  assert.deepEqual(f.events, ['compact'])
})

test('threshold resident actor above threshold with a busy race: degrade-to-skip keeps the gate note', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host } = makeHost({ ...f, resident, meter: { totalTokens: THRESHOLD + 1 }, compactError: manualError('busy', 'agent is active') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `compact run (above threshold): totalTokens=${THRESHOLD + 1} vs compactThresholdTokens=${THRESHOLD}; resident actor busy; skipped` })
})

test('threshold resident actor above threshold with a non-busy failure still fail-closes (existing classification)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host } = makeHost({ ...f, resident, meter: { totalTokens: THRESHOLD + 1 }, compactError: manualError('commit', 'durable marker lost') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: false, detail: 'compaction commit: durable marker lost' })
})

test('threshold cold actor BELOW threshold: resume(no prompt) → measure → skip → dispose, handle never leaks (AC6)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host, materialized, measures } = makeHost({ ...f, meter: { totalTokens: 100 } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `cold compact skip (below threshold): totalTokens=100 vs compactThresholdTokens=${THRESHOLD}` })
  assert.deepEqual(f.events, ['resume', 'dispose'])
  assert.equal(f.compacts.length, 0)
  assert.deepEqual(measures, [materialized.session])
})

test('threshold cold actor AT threshold: skip + dispose (strict-greater on the cold surface)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, meter: { totalTokens: THRESHOLD } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `cold compact skip (at threshold): totalTokens=${THRESHOLD} vs compactThresholdTokens=${THRESHOLD}` })
  assert.deepEqual(f.events, ['resume', 'dispose'])
  assert.equal(f.compacts.length, 0)
})

test('threshold cold actor ABOVE threshold: cold compact runs, then dispose', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, meter: { totalTokens: 9000 }, compactResult: { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234 } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: true, detail: `compact run (above threshold): totalTokens=9000 vs compactThresholdTokens=${THRESHOLD}; cold compacted 3 items (~1234 tokens)` })
  assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
})

test('threshold cold actor meter throws: fail-closed AND the materialized handle is still disposed (AC6/AC8)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, meter: { error: new Error('meter exploded') } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: false, detail: 'threshold check failed: token meter measure failed: meter exploded' })
  assert.deepEqual(f.events, ['resume', 'dispose'])
  assert.equal(f.compacts.length, 0)
})

test('threshold configured but the token-meter service is missing: fail-closed, never treated as below threshold (AC8)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host } = makeHost({ ...f, resident })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: false, detail: 'threshold check failed: token meter service is unavailable' })
  assert.deepEqual(f.events, [])
  assert.equal(f.compacts.length, 0)
})

test('threshold cold path with a missing meter: resume → fail-closed → dispose (no leak)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
  assert.deepEqual(result, { ok: false, detail: 'threshold check failed: token meter service is unavailable' })
  assert.deepEqual(f.events, ['resume', 'dispose'])
  assert.equal(f.compacts.length, 0)
})

test('threshold gate rejects illegal measurements (string / NaN / negative / missing) fail-closed (AC8)', async () => {
  for (const totalTokens of ['4200', Number.NaN, -1, undefined]) {
    const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
    const resident = agentWithSession('sess-dev')
    const { host } = makeHost({ ...f, resident, meter: { totalTokens } })
    const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', THRESHOLD)
    assert.ok(!result.ok, `expected failure for totalTokens=${String(totalTokens)}`)
    assert.match(result.detail ?? '', /^threshold check failed: token meter returned an invalid totalTokens:/)
    assert.equal(f.compacts.length, 0)
  }
})

test('unconfigured threshold: compact proceeds unconditionally and never touches a token meter (AC2)', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = agentWithSession('sess-dev')
  const { host, measures } = makeHost({ ...f, resident, meter: { error: new Error('meter must not be called') } })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer', undefined)
  assert.deepEqual(result, { ok: true, detail: 'no compactable range' })
  assert.deepEqual(f.events, ['compact'])
  assert.equal(f.compacts.length, 1)
  assert.equal(measures.length, 0)
})
