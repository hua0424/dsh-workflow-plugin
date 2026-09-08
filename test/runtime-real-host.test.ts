import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { scanCatalog } from '../src/catalog/loader.ts'

const MODEL = 'scripted-a30'
const SUMMARY = 'A30 COMPACT CHECKPOINT: first Role visit completed and its accepted handoff is authoritative.'
const OLD_SURFACE = 'OLD_ROLE_SURFACE '

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 31, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 37, outputTokens: 9 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function readOnlyFixtureTool(name: 'read' | 'glob' | 'grep' | 'read_image') {
  return defineTool({
    name,
    description: `A30 controlled read-only ${name} surface placeholder.`,
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() { return 'A30 read-only fixture' },
  })
}

function blockText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const value = block as { type?: string; text?: unknown; content?: unknown }
  if (value.type === 'text' && typeof value.text === 'string') return value.text
  return Array.isArray(value.content) ? value.content.map(blockText).join('\n') : ''
}

function messageText(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content).map(blockText).join('\n')
}

function lastNodeToken(text: string): string {
  const matches = [...text.matchAll(/"nodeToken"\s*:\s*"([^"]+)"/g)]
  const token = matches.at(-1)?.[1]
  if (!token) throw new Error('scripted adapter could not find workflow_status nodeToken')
  return token
}

class A30Adapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly roleRequests: GenerateOptions[] = []
  readonly compactionRequests: GenerateOptions[] = []
  readonly resumeGate = Promise.withResolvers<void>()
  readonly firstRoleReleased = Promise.withResolvers<void>()
  readonly secondRoleStarted = Promise.withResolvers<void>()
  readonly trace: string[] = []
  roleSessionId: string | undefined
  blockedSeen = false
  private managerClaimed = false
  private managerStatusRequested = false
  private managerResumed = false
  private firstRoleClaimed = false
  private firstRoleJudgeReleased = false
  private roleAwaitingStatus = false
  private secondRoleInterrupted = false
  private resumedRoleClaimed = false
  private call = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.purpose === 'compaction') {
      this.compactionRequests.push(options)
      yield* textChunks(SUMMARY)
      return
    }

    const tools = new Set((options.tools ?? []).map(tool => tool.name))
    const text = messageText(options)
    const sessionId = String(options.sessionId ?? '')
    this.trace.push(`${sessionId}:${options.purpose ?? 'turn'}:first=${text.includes('FIRST_ROLE_VISIT')}:second=${text.includes('SECOND_ROLE_VISIT')}:resume=${text.includes('Manager confirmed the interrupted Role turn')}:status=${/\"nodeId\"\s*:\s*\"second-role\"/.test(text)}:${[...tools].join(',')}:${text.slice(-120)}`)
    let chunks: StreamChunk[]

    if (tools.has('judge_claim') && !tools.has('node_claim')) {
      if (this.firstRoleClaimed && !this.firstRoleJudgeReleased && this.compactionRequests.length === 0) {
        await this.firstRoleReleased.promise
        this.firstRoleJudgeReleased = true
      }
      const token = text.match(/"nodeToken": "([^"]+)"/)?.[1]
      if (!token) throw new Error('Judge packet omitted nodeToken')
      chunks = toolChunks(`a30-call-${++this.call}`, 'judge_claim', {
        nodeToken: token,
        result: 'ACCEPT',
        reason: 'Scripted read-only Judge accepts the recorded handoff for Host integration verification.',
      })
    } else if (sessionId === 'a30-manager') {
      if (!this.managerClaimed && text.includes('Kickoff the isolated A30 Host scenario.')) {
        this.managerClaimed = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', {
          outcome: 'completed',
          handoff: OLD_SURFACE.repeat(60),
        })
      } else if (text.includes('Workflow BLOCK: actor-turn-ended-without-result') && !this.managerStatusRequested) {
        this.blockedSeen = true
        await this.resumeGate.promise
        this.managerStatusRequested = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'workflow_status', {})
      } else if (this.managerStatusRequested && !this.managerResumed && /"status"\s*:\s*"blocked"/.test(text)) {
        this.managerResumed = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'node_resume', {
          nodeToken: lastNodeToken(text),
          resolutionContext: 'Manager confirmed the interrupted Role turn is closed and authorizes the same execution to continue.',
          target: 'actor',
        })
      } else {
        chunks = textChunks('Manager observed a Host lifecycle notice; no workflow mutation is needed.')
      }
    } else if (tools.has('node_claim')) {
      this.roleSessionId ??= sessionId
      assert.equal(sessionId, this.roleSessionId, 'both Role visits and resume must use one durable Session')
      this.roleRequests.push(options)
      if (!this.roleAwaitingStatus) {
        this.roleAwaitingStatus = true
        chunks = toolChunks(`a30-call-${++this.call}`, 'workflow_status', {})
      } else {
        this.roleAwaitingStatus = false
        const nodeMatches = [...text.matchAll(/"nodeId"\s*:\s*"([^"]+)"/g)]
        const nodeId = nodeMatches.at(-1)?.[1]
        if (!this.firstRoleClaimed) {
          assert.equal(nodeId, 'first-role')
          this.firstRoleClaimed = true
          chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', {
            outcome: 'completed',
            handoff: 'first Role visit accepted handoff',
          })
        } else if (!this.secondRoleInterrupted && nodeId === 'second-role') {
          this.secondRoleInterrupted = true
          this.secondRoleStarted.resolve()
          await new Promise<void>(resolve => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          assert.equal(options.signal?.aborted, true)
          return
        } else if (!this.resumedRoleClaimed && this.secondRoleInterrupted && nodeId === 'second-role'
          && /"status"\s*:\s*"running"/.test(text)) {
          this.resumedRoleClaimed = true
          chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', {
            outcome: 'completed',
            handoff: 'second Role visit completed after Host interrupt and same-execution resume',
          })
        } else {
          chunks = textChunks('Role observed a non-work lifecycle notice.')
        }
      }
    } else {
      chunks = textChunks('No workflow action required.')
    }
    yield* chunks
  }
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}

function commandJson(execution: Awaited<ReturnType<CommandRuntime['execute']>>): Record<string, any> {
  assert.ok(execution)
  assert.equal(execution.result.kind, 'success', execution.result.kind === 'error' ? execution.result.text : undefined)
  assert.ok(execution.result.text)
  return JSON.parse(execution.result.text)
}

test('A30 real DSH Host composes cold Role continuation, Basic compaction, Host interrupt, and same-execution resume', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a30-host-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(join(home, 'workflows'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'workflows', 'a30.yaml'), `schemaVersion: agent-workflow/v2
roles:
  worker:
    persona: Complete only the current workflow work order and use its control tools.
judgeRole:
  persona: Read-only verification; submit only judge_claim.
workflow:
  startNode: kickoff
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: Kickoff the isolated A30 Host scenario. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the scripted kickoff handoff. } }
      onPass: first-role
    first-role:
      execution: { type: actor-task, role: worker, instruction: FIRST_ROLE_VISIT complete the first isolated Host task. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the first Role handoff. } }
      onPass: second-role
    second-role:
      execution: { type: actor-task, role: worker, instruction: "SECOND_ROLE_VISIT wait for a Host interrupt, then complete after Manager resume." }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept only the resumed second Role handoff. } }
      onPass: END
`, 'utf8')

  const catalog = await scanCatalog(home)
  assert.deepEqual(catalog.diagnostics, [], JSON.stringify(catalog.diagnostics, null, 2))
  assert.equal(catalog.entries.length, 1)

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A30Adapter()
  const lifecycleStarts = new Map<string, { runId: string; id: string }>()
  const roleEnds: Array<{ runId: string; released: boolean }> = []
  const observedCompactionEvents: SessionEvent[] = []
  const signal = new AbortController().signal

  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none', packChunks: false })
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(CommandRuntime)
    for (const name of ['read', 'glob', 'grep', 'read_image'] as const) ctx.tools.register(readOnlyFixtureTool(name))
    ctx.llm.registerAdapter([MODEL], adapter)

    ctx.on('subagent/start', info => {
      lifecycleStarts.set(String(info.runId), { runId: String(info.runId), id: String(info.id) })
    })
    ctx.on('subagent/end', info => {
      if (String(info.id) !== adapter.roleSessionId) return
      roleEnds.push({ runId: String(info.runId), released: ctx.agents.get(info.id) === undefined })
      if (roleEnds.length === 1) adapter.firstRoleReleased.resolve()
    })
    ctx.on('session/event', (session, event) => {
      if (String(session.id) === adapter.roleSessionId && event.type.startsWith('compaction/')) observedCompactionEvents.push(event)
    })

    const WorkflowPlugin = await import('../src/index.ts')
    await ctx.plugin(WorkflowPlugin)
    const manager = ctx.agentLoop.create(SessionId('a30-manager'), { provider: MODEL, model: MODEL }, { cwd: workspace })
    const start = await ctx.commands.execute(manager, '/dsh-flow start a30 isolated-host-input', [], signal)
    assert.ok(start)
    assert.equal(start.result.kind, 'success', start.result.kind === 'error' ? start.result.text : undefined)

    await adapter.secondRoleStarted.promise
    const interruptedRoleSessionId = adapter.roleSessionId
    assert.ok(interruptedRoleSessionId)
    assert.equal(ctx.agents.get(SessionId(interruptedRoleSessionId))?.status, 'running')
    ctx.subagents.interrupt(SessionId(interruptedRoleSessionId), { kind: 'ancestor', agent: manager })

    await waitFor(async () => adapter.blockedSeen ? true : undefined, 10_000).catch(async error => {
      const current = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
      throw new Error(`${String(error)}; current status:\n${JSON.stringify(current, null, 2)}; adapter trace:\n${adapter.trace.join('\n')}`)
    })
    const blocked = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.execution.nodeId, 'second-role', `${JSON.stringify(blocked, null, 2)}\nadapter trace:\n${adapter.trace.join('\n')}`)
    assert.equal(blocked.execution.hasClaim, false, 'interrupted old Turn did not gain claim qualification')
    assert.equal(blocked.execution.blockReason, 'actor-turn-ended-without-result')
    const blockedExecutionId = blocked.execution.executionId
    const blockedToken = blocked.execution.nodeToken
    adapter.resumeGate.resolve()

    const completed = await waitFor(async () => {
      const status = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
      return status.status === 'completed' ? status : undefined
    }, 10_000).catch(error => {
      throw new Error(`${String(error)}; adapter trace:\n${adapter.trace.join('\n')}`)
    })
    assert.equal(completed.execution.executionId, blockedExecutionId)
    assert.notEqual(completed.execution.nodeToken, blockedToken)
    assert.equal(completed.finalHandoffPreview, 'second Role visit completed after Host interrupt and same-execution resume')

    const roleSessionId = adapter.roleSessionId
    assert.ok(roleSessionId)
    const persisted = await ctx.sessionPersistence.inspect(SessionId(roleSessionId))
    const abortedEnd = persisted.events.find(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted')
    assert.ok(abortedEnd)
    assert.equal(persisted.events.some(event => event.type === 'tool/call'
      && event.data.turn === abortedEnd.data.turn && event.data.name === 'node_claim'), false,
    'the interrupted old Turn never dispatched node_claim')
    const compactEvents = persisted.events.filter(event => event.type.startsWith('compaction/'))
    const startEvent = compactEvents.find(event => event.type === 'compaction/start')
    const summaryEvent = compactEvents.find(event => event.type === 'compaction/summary')
    const endEvent = compactEvents.find(event => event.type === 'compaction/end')
    assert.ok(startEvent && summaryEvent && endEvent)
    assert.equal(startEvent.data.compactionId, summaryEvent.data.compactionId)
    assert.equal(summaryEvent.data.compactionId, endEvent.data.compactionId)
    assert.equal(startEvent.data.turn, null)
    assert.equal(endEvent.data.turn, null)
    assert.equal(endEvent.data.error, undefined)
    assert.equal(summaryEvent.data.llmStreamCall, true)
    assert.ok(summaryEvent.data.shadowedSeqs.length > 0)
    assert.equal(summaryEvent.data.provider, MODEL)
    assert.equal(summaryEvent.data.model, MODEL)
    assert.equal(adapter.compactionRequests.length, 1, 'same-execution BLOCK/resume must not add another node-boundary compact')
    assert.equal(observedCompactionEvents.length, 3)

    const replacement = persisted.events.find(event => event.type === 'user/message'
      && typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
    assert.ok(replacement)
    assert.equal(replacement.surfaceOp.start, summaryEvent.data.shadowedRange.start)
    assert.equal(replacement.surfaceOp.end, summaryEvent.data.shadowedRange.end)

    const resumedRequest = adapter.roleRequests.at(-1)
    assert.ok(resumedRequest)
    const resumedText = messageText(resumedRequest)
    assert.match(resumedText, /A30 COMPACT CHECKPOINT/)
    assert.doesNotMatch(resumedText, /OLD_ROLE_SURFACE/)

    assert.ok(roleEnds.length >= 2)
    assert.ok(roleEnds.every(end => lifecycleStarts.get(end.runId)?.id === roleSessionId))
    assert.equal(roleEnds[0]!.released, true, 'first Role Activation must be released before cold continuation')
  } finally {
    adapter.resumeGate.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
