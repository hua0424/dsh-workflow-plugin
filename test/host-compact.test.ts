import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { makeDispatchTargets, makeSubagentHost, type HostAdapters } from '../src/plugin/host.ts'
import { queueSubagentPrompt, type HostPromptQueue } from '@deepseek-ai/dsh-subagent/internal'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { ManualCompactionError, type ManualCompactionErrorCode } from '@deepseek-ai/dsh-compaction'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
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
    currentExecutionId: 'execution',
  }
}

test('Role and Judge continuation use host distinct-turn queue with exact Manager authority', async () => {
  const manager = { session: { id: 'manager', seq: 0, snapshotEvents: () => [] } } as unknown as Agent
  const deliveries: Array<{ parent: Agent; childId: string; text: string; source: unknown }> = []
  const queue: HostPromptQueue = {
    async [queueSubagentPrompt](parent, childId, content, source, signal) {
      assert.equal(signal.aborted, false)
      deliveries.push({ parent, childId, text: (content[0] as { text: string }).text, source })
      return MessageId(`dispatch-${deliveries.length}`)
    },
  }
  const adapters: HostAdapters = {
    ctx: { subagents: queue, jobs: { onJobDone: () => () => {} }, effect: () => {} } as unknown as Context,
    managerAgentOf: () => manager,
    cwdOfManager: async () => undefined,
    registerJudgeSession: () => {}, revokeJudgeSession: () => {}, registerRoleActorSession: () => {},
  }
  const run = makeRun('sess-dev')
  const dispatch = makeDispatchTargets(adapters)
  const host = makeSubagentHost(adapters, () => ({}))
  assert.deepEqual(await dispatch.sendRoleActor(run, 'developer', 'next node'), { messageId: 'dispatch-1' })
  assert.deepEqual(await host.ensureRoleActor(run, 'developer', 'resume node'), { childId: 'sess-dev', messageId: 'dispatch-2' })
  assert.deepEqual(await host.followupJudge(run, 'sess-judge', {
    nodeToken: run.callStack[0]!.nodeToken, instruction: 'Do.', criteria: 'PASS.', input: 'root input',
    boundary: { dispatchedAt: 0, managerFromSeq: 0 }, claim: { outcome: 'completed', handoff: 'candidate' },
    previousFeedback: { result: 'NEED_CONTEXT', reason: 'need facts', claim: { outcome: 'completed', handoff: 'candidate' } },
    managerContext: 'more evidence', cwd: '.', judgeSessionId: 'sess-judge', recovery: true,
  }), { messageId: 'dispatch-3' })
  assert.deepEqual(deliveries.slice(0, 2), [
    { parent: manager, childId: 'sess-dev', text: 'next node', source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' } },
    { parent: manager, childId: 'sess-dev', text: 'resume node', source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' } },
  ])
  assert.equal(deliveries[2]!.childId, 'sess-judge')
  assert.match(deliveries[2]!.text, /Worker handoff:\ncandidate/)
  assert.match(deliveries[2]!.text, /need facts/)
  assert.match(deliveries[2]!.text, /more evidence/)
  assert.match(deliveries[2]!.text, /只读核验当前 claim 与实际现场，不补做 Actor 工作/)
  adapters.managerAgentOf = () => undefined
  await assert.rejects(dispatch.sendRoleActor(run, 'developer', 'unauthorized'), /manager agent is not live/)
  assert.equal(deliveries.length, 3)
})

test('Judge drain propagates missing Manager and host drain failures', async () => {
  const manager = { session: { id: 'manager' } } as unknown as Agent
  const adapters: HostAdapters = {
    ctx: { subagents: { drainContinuableChildren: async () => { throw new Error('drain failed') } }, jobs: { onJobDone: () => () => {} }, effect: () => {} } as unknown as Context,
    managerAgentOf: () => manager,
    cwdOfManager: async () => undefined,
    registerJudgeSession: () => {}, revokeJudgeSession: () => {}, registerRoleActorSession: () => {},
  }
  const host = makeSubagentHost(adapters, () => ({}))
  await assert.rejects(host.drainJudge(makeRun(undefined), 'judge-old'), /drain failed/)
  adapters.managerAgentOf = () => undefined
  await assert.rejects(host.drainJudge(makeRun(undefined), 'judge-old'), /manager agent is not live/)
})

function manualError(code: ManualCompactionErrorCode, message: string): ManualCompactionError {
  return new ManualCompactionError(code, message)
}

interface CompactCall { agent: Agent; }
interface ResumeCall { resumeSessionId: unknown; agentOptions: unknown; setup?: unknown }

/**
 * compactRoleActor 测试 Host：compaction 经 `ctx.get('compaction')` 解析
 * （preset serviceFor 优先、宿主平面回退），可选 presets roster 与告警记录。
 */
function makeHost(options: {
  resident?: Agent
  manager?: Agent
  resumeResult?: { handle?: AgentHandle; error?: Error }
  compactResult?: { shadowedSeqs: number[]; shadowedTokenCount: number } | null
  compactError?: Error
  disposeError?: Error
  presets?: { serviceFor: (agent: Agent, name: string) => unknown; composeFrom?: (agentCtx: unknown, parentCtx: unknown) => void }
  noHostCompaction?: boolean
  events: string[]
  resumes: ResumeCall[]
  compacts: CompactCall[]
  warns?: string[]
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
  const logger = { warn: (message: string) => { options.warns?.push(message) } }
  const get = (key: string) => {
    if (key === 'agentPresets') return options.presets
    if (key === 'compaction') return options.noHostCompaction === true ? undefined : compaction
    return undefined
  }
  const fakeCtx = {
    get,
    logger,
    jobs: { list: () => [], onJobDone: () => () => {} },
    effect: () => {},
    agents: {
      get: (id: unknown) => (options.resident !== undefined && id === 'sess-dev' ? options.resident : undefined),
      resume: async (call: ResumeCall) => {
        options.resumes.push(call)
        options.events.push('resume')
        if (options.resumeResult?.error !== undefined) throw options.resumeResult.error
        if (call.setup !== undefined) await (call.setup as (agentCtx: unknown) => unknown)({ get, logger })
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
    managerAgentOf: () => options.manager,
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
  assert.deepEqual(Object.keys(f.resumes[0]!).sort(), ['agentOptions', 'resumeSessionId'], 'cold maintenance resume carries no prompt')
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

test('cold actor: busy and ordinary compact failures remain distinct and always dispose', async () => {
  for (const [error, detail] of [
    [manualError('busy', 'maintenance raced'), 'compaction busy: maintenance raced'],
    [new Error('unexpected backend fault'), 'unexpected backend fault'],
  ] as const) {
    const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
    const { host } = makeHost({ ...f, compactError: error })
    assert.deepEqual(await host.compactRoleActor(makeRun('sess-dev'), 'developer'), { ok: false, detail })
    assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
  }
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

test('resident idle actor: null is a successful no-range result', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, resident: { id: 'sess-dev' } as unknown as Agent, compactResult: null })
  assert.deepEqual(await host.compactRoleActor(makeRun('sess-dev'), 'developer'), { ok: true, detail: 'no compactable range' })
  assert.deepEqual(f.events, ['compact'])
})

test('resident busy actor (Judge raced the actor turn tail): fails closed', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, resident: {} as Agent, compactError: manualError('busy', 'agent is active') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: false, detail: 'resident actor busy' })
  assert.equal(f.resumes.length, 0)
})

test('resident actor non-busy manual failure fail-closes', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, resident: {} as Agent, compactError: manualError('commit', 'durable marker lost') })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.deepEqual(result, { ok: false, detail: 'compaction commit: durable marker lost' })
})

test('unmapped role is a no-op', async () => {
  const { host } = makeHost({ events: [], resumes: [], compacts: [] })
  assert.deepEqual(await host.compactRoleActor(makeRun(undefined), 'developer'), { ok: true, detail: 'no actor mapped' })
})

test('preset-scoped compaction instance is preferred over the host-plane service', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const resident = { id: 'sess-dev' } as unknown as Agent
  const presetCompaction = {
    compactNow: async (agent: Agent) => {
      f.compacts.push({ agent })
      f.events.push('preset-compact')
      return { shadowedSeqs: [9], shadowedTokenCount: 99 }
    },
  }
  const { host } = makeHost({
    ...f, resident,
    presets: { serviceFor: (agent, name) => name === 'compaction' && agent === resident ? presetCompaction : undefined },
  })
  assert.deepEqual(await host.compactRoleActor(makeRun('sess-dev'), 'developer'), { ok: true, detail: 'compacted 1 items (~99 tokens)' })
  assert.deepEqual(f.events, ['preset-compact'], 'the host-plane stub (events: compact) must never run')
})

test('resident actor with no backend anywhere: benign skip plus one host warning', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[], warns: [] as string[] }
  const { host } = makeHost({ ...f, resident: { id: 'sess-dev' } as unknown as Agent, noHostCompaction: true })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.equal(result.ok, true)
  assert.match(result.detail!, /no compaction backend/)
  assert.deepEqual(f.events, [])
  assert.equal(f.warns.length, 1)
})

test('cold actor with no backend anywhere: still materializes and disposes, compact skipped with warning', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[], warns: [] as string[] }
  const { host } = makeHost({ ...f, noHostCompaction: true, compactResult: null })
  const result = await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.equal(result.ok, true)
  assert.match(result.detail!, /no compaction backend/)
  assert.deepEqual(f.events, ['resume', 'dispose'], 'the maintenance materialization must not leak')
  assert.equal(f.warns.length, 1)
})

test('cold maintenance resume joins the live manager preset inside the creation window', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[], warns: [] as string[] }
  const joins: Array<{ agentCtx: unknown; parentCtx: unknown }> = []
  const manager = { id: 'manager', ctx: { tag: 'manager-ctx' } } as unknown as Agent
  const { host } = makeHost({
    ...f, manager, compactResult: null,
    presets: {
      serviceFor: () => undefined,
      composeFrom: (agentCtx, parentCtx) => { joins.push({ agentCtx, parentCtx }) },
    },
  })
  assert.deepEqual(await host.compactRoleActor(makeRun('sess-dev'), 'developer'), { ok: true, detail: 'cold: no compactable range' })
  assert.equal(typeof f.resumes[0]!.setup, 'function', 'resume must carry the joining setup when the manager is live')
  assert.equal(joins.length, 1)
  assert.equal((joins[0]!.parentCtx as { tag?: string }).tag, 'manager-ctx')
  assert.deepEqual(f.events, ['resume', 'compact', 'dispose'])
})

test('cold maintenance resume carries no setup when the manager is not live', async () => {
  const f = { events: [] as string[], resumes: [] as ResumeCall[], compacts: [] as CompactCall[] }
  const { host } = makeHost({ ...f, compactResult: null })
  await host.compactRoleActor(makeRun('sess-dev'), 'developer')
  assert.equal(f.resumes[0]!.setup, undefined)
  assert.deepEqual(Object.keys(f.resumes[0]!).sort(), ['agentOptions', 'resumeSessionId'])
})

test('Role/Judge Session availability distinguishes durable absence from unreadable persistence', async () => {
  const live = { id: 'live-session' } as unknown as Agent
  const ctx = {
    agents: { get: (id: unknown) => id === 'live-session' ? live : undefined },
    get: (key: string) => key === 'sessionPersistence' ? {
      inspect: async (id: string) => {
        if (id === 'broken-session') throw new Error('persistence read failed')
        if (id === 'missing-session') throw new SessionPersistenceNotFoundError(id as never)
        return { meta: { id }, events: [] }
      },
    } : undefined,
    jobs: { onJobDone: () => () => {} }, effect: () => {},
  } as unknown as Context
  const host = makeSubagentHost({
    ctx, managerAgentOf: () => undefined, cwdOfManager: async () => undefined,
    registerJudgeSession: () => {}, revokeJudgeSession: () => {}, registerRoleActorSession: () => {},
  }, () => ({}))
  assert.equal(await host.roleSessionAvailability('live-session'), 'available')
  assert.equal(await host.roleSessionAvailability('durable-session'), 'available')
  assert.equal(await host.roleSessionAvailability('missing-session'), 'missing')
  assert.equal(await host.judgeSessionAvailability('broken-session'), 'unknown')
  const noService = makeSubagentHost({
    ...({ ctx: { ...ctx, get: () => undefined } as unknown as Context } as HostAdapters),
    managerAgentOf: () => undefined, cwdOfManager: async () => undefined,
    registerJudgeSession: () => {}, revokeJudgeSession: () => {}, registerRoleActorSession: () => {},
  }, () => ({}))
  assert.equal(await noService.roleSessionAvailability('cold-session'), 'unknown')
})
