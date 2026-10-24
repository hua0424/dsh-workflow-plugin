import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
// 0.1.5 起 SessionProjectionRegistry 由 mountAgentLoopTestDependencies 内置挂载。
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as CordisLoader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
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
  /** #216：Judge 请求的实际工具面快照（deny 收敛断言）。 */
  readonly judgeSurfaces: string[][] = []
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
      this.judgeSurfaces.push([...tools])
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
        chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: OLD_SURFACE.repeat(60),
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
          chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'first Role visit accepted handoff',
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
          chunks = toolChunks(`a30-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'second Role visit completed after Host interrupt and same-execution resume',
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
  writeFileSync(join(home, 'workflows', 'a30.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker:
    # A30 场景断言的是 continuable 语义（整 Run 复用 + 节点边界 compact + 冷延续）；
    # 缺省 reuse: node 的节点级释放由 scripts/e2e-smoke.mjs 与 runtime-work-order 的 node 用例覆盖。
    reuse: continuable
    persona: Complete only the current workflow work order and use its control tools.
judgeRole:
  persona: Read-only verification of the isolated workspace.
workflow:
  startNode: kickoff
  returns: [done]
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: Kickoff the isolated A30 Host scenario. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the scripted kickoff handoff. } }
      results:
        succeeded: { criteria: The kickoff handoff is accepted., target: { node: first-role } }
    first-role:
      execution: { type: actor-task, role: worker, instruction: FIRST_ROLE_VISIT complete the first isolated Host task. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the first Role handoff. } }
      results:
        succeeded: { criteria: The first Role handoff is accepted., target: { node: second-role } }
    second-role:
      execution: { type: actor-task, role: worker, instruction: "SECOND_ROLE_VISIT wait for a Host interrupt, then complete after Manager resume." }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept only the resumed second Role handoff. } }
      results:
        succeeded: { criteria: The resumed second Role handoff is accepted., target: { return: done } }
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
    // 0.2.1 起 SubagentRuntime 静态 inject=['workingDirectory'] 且子代理创建
    // 需要 `set`：testkit 的 fixture 不含 set，这里提供完整最小桩。
    ctx.provide('workingDirectory', {
      defaultDirectory: workspace,
      get: (session: { header: { cwd?: string } }) => session.header.cwd ?? workspace,
      ensure: (agent: { session: { header: { cwd?: string } } }) =>
        Promise.resolve(agent.session.header.cwd ?? workspace),
      set: () => Promise.resolve(),
    })
    // #216：persona/deny 组装走 Agent Preset——真实宿主侧挂 loader + registry + persona。
    await ctx.plugin(CordisLoader.Loader)
    await ctx.plugin(AgentPresetRegistry, { default: 'a30-base' })
    await ctx.get('agentPresets').register({ id: 'a30-base', plugins: [] })
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
    const manager = await ctx.agentLoop.create(SessionId('a30-manager'), { provider: MODEL, model: MODEL }, { cwd: workspace })
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
    // #29：BLOCK 文本必须自带可辨识的失败分类（此处为父会话中断），而不是只有裸的基础原因。
    assert.match(blocked.execution.blockReason ?? '', /^actor-turn-ended-without-result \| turn-end reason=aborted cause=parent \| turn=\d+ tools=used$/,
      `blockReason should carry the turn-end failure classification: ${blocked.execution.blockReason}`)
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
    // 0.1.5 起持久化读走 SessionHandle：open('read') 不取写所有权，读完即 close。
    const persistedHandle = await ctx.sessionPersistence.open(SessionId(roleSessionId), 'read')
    let persisted: { events: readonly SessionEvent[] }
    try {
      persisted = { events: (await persistedHandle.read(0)).events }
    } finally {
      await persistedHandle.close()
    }
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
    // 0.1.5 起 surfaceOp.replace 的字段名为 startSeq/endSeq（旧名 start/end）。
    assert.equal(replacement.surfaceOp.startSeq, summaryEvent.data.shadowedRange.start)
    assert.equal(replacement.surfaceOp.endSeq, summaryEvent.data.shadowedRange.end)

    const resumedRequest = adapter.roleRequests.at(-1)
    assert.ok(resumedRequest)
    const resumedText = messageText(resumedRequest)
    assert.match(resumedText, /A30 COMPACT CHECKPOINT/)
    assert.doesNotMatch(resumedText, /OLD_ROLE_SURFACE/)

    assert.ok(roleEnds.length >= 2)
    assert.ok(roleEnds.every(end => lifecycleStarts.get(end.runId)?.id === roleSessionId))
    assert.equal(roleEnds[0]!.released, true, 'first Role Activation must be released before cold continuation')

    // #216 断言一：preset 组装下 Judge deny 实际收敛工具面——
    // Judge 请求携带 judge_claim 且不携带 workflow 控制工具（node_claim 等）。
    assert.ok(adapter.judgeSurfaces.length > 0, 'Judge must have issued at least one request')
    for (const surface of adapter.judgeSurfaces) {
      assert.ok(surface.includes('judge_claim'), `Judge surface must keep judge_claim: ${surface.join(',')}`)
      for (const denied of ['node_claim', 'node_block', 'node_resume', 'node_run_program', 'node_resolve_program'])
        assert.ok(!surface.includes(denied), `Judge surface must not expose ${denied}: ${surface.join(',')}`)
    }
    // #216 断言二：动态 preset 注册/注销与 Run 生命周期严格配对——
    // Run 完成后注册表不得残留 dsh-wf-* 派生 preset。
    const registry = ctx.get('agentPresets')
    assert.ok(registry)
    const leftover = (await registry.list()).filter((preset: { id: string }) => preset.id.startsWith('dsh-wf-'))
    assert.deepEqual(leftover.map((preset: { id: string }) => preset.id), [], `Run 完成后动态 preset 必须全部注销: ${JSON.stringify(leftover)}`)
  } finally {
    adapter.resumeGate.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #247 真实宿主契约：受理后无 turn/end 的失败必须经过真实插件接线（index.ts 的
// `subagent/end` 观察 → Dispatch Lifecycle → Engine 工作单核验 → SQLite）落成技术
// BLOCK，而不是停在 running 或等下一次 turn 才失败。这里刻意让 Role 的模型流挂起
// （不产出任何 chunk，因此不会有 turn/end），再用宿主同款 `subagent/end` 事件注入
// 终态；事件可能在派发登记发布前到达，正好覆盖发布窗口对账。
class A3LifecycleAdapter extends LlmAdapter {
  readonly roleGate = Promise.withResolvers<void>()
  readonly roleTurnStarted = Promise.withResolvers<void>()
  roleSessionId: string | undefined
  private managerClaimed = false
  private call = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const tools = new Set((options.tools ?? []).map(tool => tool.name))
    const text = messageText(options)
    const sessionId = String(options.sessionId ?? '')
    if (tools.has('judge_claim') && !tools.has('node_claim')) {
      const token = text.match(/"nodeToken": "([^"]+)"/)?.[1]
      if (!token) throw new Error('Judge packet omitted nodeToken')
      yield* toolChunks(`a3-call-${++this.call}`, 'judge_claim', {
        nodeToken: token,
        result: 'ACCEPT',
        reason: 'Scripted read-only Judge accepts the kickoff handoff.',
      })
      return
    }
    if (sessionId === 'a3-manager') {
      if (!this.managerClaimed && text.includes('Kickoff the isolated A3 lifecycle scenario.')) {
        this.managerClaimed = true
        yield* toolChunks(`a3-call-${++this.call}`, 'node_claim', { result: 'succeeded', handoff: 'kickoff accepted' })
        return
      }
      yield* textChunks('Manager observed a Host lifecycle notice; no workflow mutation is needed.')
      return
    }
    if (tools.has('node_claim')) {
      if (this.roleSessionId === undefined) {
        this.roleSessionId = sessionId
        this.roleTurnStarted.resolve()
      }
      // 受理后的模型流挂起（不产出 chunk、不结束 turn），终态由测试注入的宿主事件给出。
      await this.roleGate.promise
      yield* textChunks('Late Role turn after the injected Host terminal event.')
      return
    }
    yield* textChunks('No workflow action required.')
  }
}

test('A3 real DSH Host: accepted Role dispatch without turn/end fails into a technical BLOCK through plugin wiring', { timeout: 30_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a3-host-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(join(home, 'workflows'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'workflows', 'a3.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Complete only the current workflow work order and use its control tools.
judgeRole:
  persona: Read-only verification of the isolated workspace.
workflow:
  startNode: kickoff
  returns: [done]
  nodes:
    kickoff:
      execution: { type: actor-task, role: manager, instruction: Kickoff the isolated A3 lifecycle scenario. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the scripted kickoff handoff. } }
      results:
        succeeded: { criteria: The kickoff handoff is accepted., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Wait for a Host terminal event without finishing a turn. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Accept the worker handoff. } }
      results:
        succeeded: { criteria: The worker handoff is accepted., target: { return: done } }
`, 'utf8')

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const adapter = new A3LifecycleAdapter()
  const signal = new AbortController().signal
  const lifecycleStarts = new Map<string, { id: string; runId: string }>()

  try {
    await mountAgentLoopTestDependencies(ctx)
    ctx.provide('workingDirectory', {
      defaultDirectory: workspace,
      get: (session: { header: { cwd?: string } }) => session.header.cwd ?? workspace,
      ensure: (agent: { session: { header: { cwd?: string } } }) =>
        Promise.resolve(agent.session.header.cwd ?? workspace),
      set: () => Promise.resolve(),
    })
    await ctx.plugin(CordisLoader.Loader)
    await ctx.plugin(AgentPresetRegistry, { default: 'a3-base' })
    await ctx.get('agentPresets').register({ id: 'a3-base', plugins: [] })
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
      lifecycleStarts.set(String(info.id), { id: String(info.id), runId: String(info.runId) })
    })

    const WorkflowPlugin = await import('../src/index.ts')
    await ctx.plugin(WorkflowPlugin)
    const manager = await ctx.agentLoop.create(SessionId('a3-manager'), { provider: MODEL, model: MODEL }, { cwd: workspace })
    const start = await ctx.commands.execute(manager, '/dsh-flow start a3 isolated-host-input', [], signal)
    assert.ok(start)
    assert.equal(start.result.kind, 'success', start.result.kind === 'error' ? start.result.text : undefined)

    // 受理 = Role turn 已开始（模型请求已到达）。此后注入宿主终态：没有 turn/end 可以
    // 解释这次结束，只能由观察模块转交 Engine 落成技术 BLOCK。
    await adapter.roleTurnStarted.promise
    const roleSessionId = adapter.roleSessionId
    assert.ok(roleSessionId)
    const startInfo = lifecycleStarts.get(roleSessionId)
    assert.ok(startInfo, `missing subagent/start for the Role session: ${JSON.stringify([...lifecycleStarts])}`)
    ctx.emit('subagent/end', { id: startInfo.id, runId: startInfo.runId, stopReason: 'error' } as never)

    const blocked = await waitFor(async () => {
      const status = commandJson(await ctx.commands.execute(manager, '/dsh-flow status', [], signal))
      return status.status === 'blocked' ? status : undefined
    }, 10_000).catch(error => {
      throw new Error(`${String(error)}; lifecycle starts: ${JSON.stringify([...lifecycleStarts])}`)
    })
    assert.equal(blocked.execution.nodeId, 'work')
    assert.equal(blocked.execution.hasClaim, false)
    assert.match(blocked.execution.blockReason ?? '', /^activation settled without turn\/end: actor role=worker/,
      `blockReason should carry the lifecycle settlement: ${blocked.execution.blockReason}`)
  } finally {
    adapter.roleGate.resolve()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// #246 A0 的真实宿主契约：宿主只在 setup 返回值 resolve 之后才 publication
// （agent-loop `setupAndPublish`：`await raceAbort(setup(...))` → publish）。
// 冷维护 setup 等待角色 preset 挂载正是靠这条时序才成立，所以这里在真实 Host 上
// 固定它：不等待的 setup 立刻发布（旧形态的失效机制）；等待中的 setup 在其
// resolve 前不发布；取消挂起中的 setup 不留迟到 live Agent，同一 Session id
// 之后仍可再次 resume。不断言取消能回滚底层 mount / preset 绑定。
test('A0 real DSH Host publishes a cold resume only after its awaited setup resolves (#246)', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-a0-setup-'))
  const workspace = join(home, 'workspace')
  const sessions = join(home, 'sessions')
  mkdirSync(workspace, { recursive: true })
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none', packChunks: false })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter([MODEL], new A30Adapter())

    const id = SessionId('a0-setup-contract')
    const seed = await ctx.agents.create({ sessionId: id, agentOptions: { provider: MODEL, model: MODEL }, meta: { cwd: workspace } })
    seed.agent.session.append('turn/start', { turn: 1 })
    seed.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await seed.dispose()
    assert.equal(ctx.agents.get(id), undefined, '冷基线：持久化会话存在但没有 live agent')

    // 1) 旧插件形态：setup 里把 mount 的 Promise 丢掉，宿主立刻 publication。
    const backgroundMount = Promise.withResolvers<void>()
    const detached = await ctx.agentLoop.resume(ctx, {
      resumeSessionId: id,
      setup: () => { void backgroundMount.promise },
    })
    assert.notEqual(ctx.agents.get(id), undefined,
      '不等待的 setup 在其同步返回后就被当成完成——这正是 #246 的失效机制（挂载仍在进行却已发布）')
    await detached.dispose()
    assert.equal(ctx.agents.get(id), undefined)
    backgroundMount.resolve()

    // 2) 修复形态：setup await 挂载，挂载完成前不得 publication。
    const mountStarted = Promise.withResolvers<void>()
    const mountGate = Promise.withResolvers<void>()
    const trace: string[] = []
    const pending = ctx.agentLoop.resume(ctx, {
      resumeSessionId: id,
      setup: async () => {
        trace.push('setup-start')
        mountStarted.resolve()
        await mountGate.promise
        trace.push('setup-done')
      },
    })
    await mountStarted.promise
    await sleep(50)
    assert.equal(ctx.agents.get(id), undefined, 'setup/挂载挂起期间不得 publication（否则后续解析会跑在没挂上的 isolate 上）')
    mountGate.resolve()
    const mountedHandle = await pending
    assert.deepEqual(trace, ['setup-start', 'setup-done'])
    assert.notEqual(ctx.agents.get(id), undefined, '挂载完成后才 publication')
    await mountedHandle.dispose()

    // 3) 挂起中取消：不留迟到 live Agent；同一 Session id 仍可再次 resume。
    const controller = new AbortController()
    const cancellingStart = Promise.withResolvers<void>()
    const cancelGate = Promise.withResolvers<void>()
    const cancelled = ctx.agentLoop.resume(ctx, {
      resumeSessionId: id,
      signal: controller.signal,
      setup: async () => {
        cancellingStart.resolve()
        await cancelGate.promise
      },
    })
    await cancellingStart.promise
    controller.abort()
    await assert.rejects(cancelled)
    cancelGate.resolve()
    await sleep(50)
    assert.equal(ctx.agents.get(id), undefined, '取消后的迟到 setup 不得发布 live Agent')

    const recovered = await ctx.agentLoop.resume(ctx, { resumeSessionId: id, setup: () => {} })
    assert.notEqual(ctx.agents.get(id), undefined, '同一 Session id 仍可冷 resume（取消不回滚可复用性）')
    await recovered.dispose()
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
