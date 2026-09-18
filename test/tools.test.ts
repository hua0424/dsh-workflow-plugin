import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkflowTools, type ToolHost } from '../src/tools/tools.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { makeBlankSessionActivator, makeDshFlowCommand, type CommandHost } from '../src/commands/dsh-flow.ts'
import { randomUUID } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

/** Find a tool by name inside ONE instance's bound tool set (#94: no module-level set). */
function findTool(host: { tools: ToolDefinition[] }, name: string) {
  const def = host.tools.find(t => t.name === name)
  assert.ok(def, `tool ${name} should be registered`)
  return def!
}

/** A tiny host double that records engine mutations; `tools` are bound to THIS host (#94). */
function makeToolHost(overrides: Partial<ToolHost> = {}): ToolHost & { calls: Array<{ name: string; args: unknown }>; tools: ToolDefinition[] } {
  const calls: Array<{ name: string; args: unknown }> = []
  const host: ToolHost = {
    async authorize(toolName) {
      if (toolName === 'workflow_status') return { workspaceKey: 'ws-1' }
      return { workspaceKey: 'ws-1' }
    },
    claim: async (ws, claim, caller) => { calls.push({ name: 'claim', args: { ws, claim, caller } }); return { ok: true, message: 'claimed' } },
    block: async (ws, nodeToken, reason) => { calls.push({ name: 'block', args: { ws, nodeToken, reason } }); return { ok: true, message: 'blocked' } },
    resume: async (ws, nodeToken, resolutionContext, _caller, target) => { calls.push({ name: 'resume', args: { ws, nodeToken, resolutionContext, target } }); return { ok: true, message: 'resumed' } },
    runProgram: async (ws, nodeToken, parameters) => { calls.push({ name: 'runProgram', args: { ws, nodeToken, parameters } }); return { ok: true, message: 'ran' } },
    resolveProgram: async (ws, nodeToken, result, reason) => { calls.push({ name: 'resolveProgram', args: { ws, nodeToken, result, reason } }); return { ok: true, message: 'resolved' } },
    setRoleModel: async (ws, roleKey, provider, modelId) => { calls.push({ name: 'setRoleModel', args: { ws, roleKey, provider, modelId } }); return { ok: true, message: 'set' } },
    judgeClaim: async (ws, nodeToken, result, reason, caller) => { calls.push({ name: 'judgeClaim', args: { ws, nodeToken, result, reason, caller } }); return { ok: true, message: 'claimed' } },
    respawnJudge: async (ws, nodeToken, reason, caller) => { calls.push({ name: 'respawnJudge', args: { ws, nodeToken, reason, caller } }); return { ok: true, message: 'respawned' } },
    status: async () => ({ ok: true, status: { runId: 'r1', status: 'running' } }),
    inspectGit: async (_ws, operation) => ({ ok: true, value: `git:${operation}` }),
    inspectGithub: async (_ws, operation, milestoneNumber) => ({ ok: true, value: `gh:${operation}:${milestoneNumber ?? ''}` }),
    ...overrides,
  }
  return { ...host, calls, tools: makeWorkflowTools(host) }
}

const EXEC = {
  signal: new AbortController().signal,
  callId: 'c1' as never,
  rootCallId: 'c1' as never,
  name: 'tool',
  arguments: {},
  token: Symbol('t') as never,
  deferContext: () => {},
  concludeTurn: () => {},
}

test('eleven workflow tools + judge_claim/judge_respawn are registered', () => {
  const names = makeToolHost().tools.map(t => t.name).sort()
  assert.deepEqual(names, [
    'judge_claim',
    'judge_respawn',
    'node_block',
    'node_claim',
    'node_resolve_program',
    'node_resume',
    'node_run_program',
    'workflow_inspect_git',
    'workflow_inspect_github',
    'workflow_set_role_model',
    'workflow_status',
  ])
})

test('node_claim routes to host.claim and concludes the turn on success', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'node_claim')
  let concluded = false
  const exec = { ...EXEC, concludeTurn: () => { concluded = true } }
  const result = await tool.execute(
    { result: 'succeeded', handoff: 'did it; next: X' },
    exec as never,
  )
  assert.equal(result, 'claimed')
  // A1 AC2: no nodeToken — only the payload plus the lease caller snapshot
  // (EXEC has no agent → fail-closed empty id set, sessionId '').
  assert.deepEqual(host.calls[0], { name: 'claim', args: { ws: 'ws-1', claim: { result: 'succeeded', handoff: 'did it; next: X' }, caller: { sessionId: '', turnUserMessageIds: new Set<string>() } } })
  assert.equal(concluded, true)
})

test('node_block routes to host.block and concludes the turn on success', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'node_block')
  let concluded = false
  const exec = { ...EXEC, concludeTurn: () => { concluded = true } }
  const token = randomUUID()
  await tool.execute({ nodeToken: token, reason: 'blocked by hand' }, exec as never)
  assert.deepEqual(host.calls[0], { name: 'block', args: { ws: 'ws-1', nodeToken: token, reason: 'blocked by hand' } })
  assert.equal(concluded, true)
})

test('node_resume routes to host.resume', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'node_resume')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, resolutionContext: 'fixed it', target: 'judge' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'resume', args: { ws: 'ws-1', nodeToken: token, resolutionContext: 'fixed it', target: 'judge' } })
  await assert.rejects(() => tool.execute({ nodeToken: token, resolutionContext: 'fixed', surprise: true }, EXEC as never), /unsupported node_resume property/)
})

test('node_run_program routes to host.runProgram', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'node_run_program')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, parameters: { title: 'M1' } }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'runProgram', args: { ws: 'ws-1', nodeToken: token, parameters: { title: 'M1' } } })
})

test('node_resolve_program routes to host.resolveProgram', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'node_resolve_program')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, result: 'PASS', reason: 'verified by hand' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'resolveProgram', args: { ws: 'ws-1', nodeToken: token, result: 'PASS', reason: 'verified by hand' } })
})

test('workflow_set_role_model routes to host.setRoleModel', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'workflow_set_role_model')
  await tool.execute({ roleKey: 'developer', provider: 'p', modelId: 'm' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'setRoleModel', args: { ws: 'ws-1', roleKey: 'developer', provider: 'p', modelId: 'm' } })
})

test('workflow_status renders host status', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'workflow_status')
  const result = await tool.execute({}, EXEC as never)
  assert.match(result as string, /r1/)
  assert.ok(host.calls.length === 0)
})

test('workflow_status forwards explicit history paging and rejects open-root extras or invalid combinations', async () => {
  const calls: unknown[] = []
  const host = makeToolHost({ status: async (...args: unknown[]) => { calls.push(args); return { ok: true, status: { history: [] } } } })
  const tool = findTool(host, 'workflow_status')
  const agent = { session: { id: 'manager' } }
  await tool.execute({ executionId: 'execution-1', after: 4, limit: 10 }, { ...EXEC, agent } as never)
  assert.deepEqual(calls, [['ws-1', 'manager', { executionId: 'execution-1', after: 4, limit: 10 }]])
  await assert.rejects(() => tool.execute({ after: 1 }, { ...EXEC, agent } as never), /executionId/)
  await assert.rejects(() => tool.execute({ executionId: 'execution-1', limit: 51 }, { ...EXEC, agent } as never), /limit/)
  await assert.rejects(() => tool.execute({ executionId: 'execution-1', surprise: true }, { ...EXEC, agent } as never), /unsupported workflow_status property/)
})

test('judge_claim routes to host.judgeClaim and concludes the turn on success', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'judge_claim')
  assert.match(tool.description, /REJECT 仅用于 claim 与既有 criteria 或可验证事实冲突/)
  const resultDescription = (tool.parameters as { properties: { result: { description: string } } }).properties.result.description
  assert.match(resultDescription, /NEED_CONTEXT=信息不足或要求不清/)
  let concluded = false
  const exec = { ...EXEC, concludeTurn: () => { concluded = true } }
  const token = randomUUID()
  const result = await tool.execute({ nodeToken: token, result: 'ACCEPT', reason: 'verified' }, exec as never)
  assert.equal(result, 'claimed')
  assert.deepEqual(host.calls[0], { name: 'judgeClaim', args: { ws: 'ws-1', nodeToken: token, result: 'ACCEPT', reason: 'verified', caller: { sessionId: '', turnUserMessageIds: new Set<string>() } } })
  assert.equal(concluded, true)
})

test('trim-bounded payloads reach the host trimmed — a whitespace bomb never lands (A1 review fix)', async () => {
  const host = makeToolHost()
  const nodeClaim = findTool(host, 'node_claim')
  const judgeClaim = findTool(host, 'judge_claim')
  const nodeBlock = findTool(host, 'node_block')
  const padded = ' '.repeat(10_000) + 'x'
  await nodeClaim.execute({ result: 'succeeded', handoff: padded }, EXEC as never)
  await judgeClaim.execute({ nodeToken: randomUUID(), result: 'ACCEPT', reason: padded }, EXEC as never)
  await nodeBlock.execute({ nodeToken: randomUUID(), reason: padded }, EXEC as never)
  assert.deepEqual((host.calls[0]!.args as { claim: { handoff: string } }).claim, { result: 'succeeded', handoff: 'x' })
  assert.equal((host.calls[1]!.args as { reason: string }).reason, 'x')
  assert.equal((host.calls[2]!.args as { reason: string }).reason, 'x')
})

test('#130 node_claim public schema rejects legacy fields and invalid handoff symmetrically', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'node_claim')
  for (const result of ['succeeded', 'changes-required']) {
    // v2 的 outcome / 旧的 summary / handoffContext 及缺失必填项一律拒绝
    for (const args of [
      { result },
      { outcome: 'completed', handoff: 'legacy' },
      { result, handoff: 42 },
      { result, summary: 'old' }, { result, handoffContext: 'old' },
      { result, handoff: 'valid', summary: 'old' },
      { result, handoff: 'valid', handoffContext: 'old' },
      { result, handoff: 'valid', outcome: 'completed' },
    ]) {
      await assert.rejects(() => tool.execute(args, EXEC as never), /invalid arguments/)
    }
    for (const handoff of ['', '   ', 'x'.repeat(8001)]) {
      assert.match(await tool.execute({ result, handoff }, EXEC as never) as string, /拒绝：handoff/)
    }
    const handoff = 'x'.repeat(8000)
    assert.equal(await tool.execute({ result, handoff: `  ${handoff}  ` }, EXEC as never), 'claimed')
    assert.deepEqual((host.calls.at(-1)!.args as { claim: unknown }).claim, { result, handoff })
  }
  assert.equal(host.calls.length, 2)
})

test('judge_respawn routes to host.respawnJudge', async () => {
  const host = makeToolHost()
  const tool = findTool(host, 'judge_respawn')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, reason: 'model swap' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'respawnJudge', args: { ws: 'ws-1', nodeToken: token, reason: 'model swap', caller: '' } })
  await assert.rejects(() => tool.execute({ nodeToken: token, extra: true }, EXEC as never), /unsupported judge_respawn property/)
})

test('inspection wrappers reject when authorize fails', async () => {
  const host = makeToolHost({
    authorize: async () => ({ workspaceKey: null, reason: 'judge only' }),
  })
  const tool = findTool(host, 'workflow_inspect_git')
  const result = await tool.execute({ operation: 'status' }, EXEC as never)
  assert.match(result as string, /拒绝：judge only/)
})

test('authorize denial surfaces in control tools', async () => {
  const host = makeToolHost({
    authorize: async () => ({ workspaceKey: null, reason: 'only manager' }),
  })
  const tool = findTool(host, 'node_claim')
  const result = await tool.execute({ result: 'succeeded', handoff: 's' }, EXEC as never)
  assert.match(result as string, /拒绝：only manager/)
})

test('target host Session snapshot binds native claim to its dispatch, excluding later turns', async () => {
  const host = makeToolHost()
  const session = Session.create(SessionId('native-caller'))
  session.append('turn/start', { turn: 1 } as never)
  const dispatch = createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } })
  session.append('user/message', dispatch, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'native-claim', name: 'node_claim', arguments: '{}' } as never)
  session.append('tool/call', { turn: 1, step: 1, callId: 'judge-call', name: 'judge_claim', arguments: '{}' } as never)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } } as never)
  session.append('turn/start', { turn: 2 } as never)
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'new work' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await findTool(host, 'node_claim').execute({ result: 'succeeded', handoff: 'done' }, {
    ...EXEC, agent: { session }, callId: 'native-claim', rootCallId: 'native-claim',
  } as never)
  assert.deepEqual((host.calls[0]!.args as { caller: unknown }).caller, {
    sessionId: 'native-caller', turnUserMessageIds: new Set([dispatch.id]), sessionUserMessageIds: new Set([dispatch.id]),
  })
  await findTool(host, 'judge_claim').execute({ nodeToken: randomUUID(), result: 'ACCEPT', reason: 'verified' }, {
    ...EXEC, agent: { session }, callId: 'judge-call', rootCallId: 'judge-call',
  } as never)
  assert.deepEqual((host.calls[1]!.args as { caller: unknown }).caller, {
    sessionId: 'native-caller', turnUserMessageIds: new Set([dispatch.id]), sessionUserMessageIds: new Set([dispatch.id]),
  })
})

test('target host Code Mode snapshot binds claim/block only with the real root and subcall', async () => {
  const session = Session.create(SessionId('code-caller'))
  session.append('turn/start', { turn: 1 } as never)
  const dispatch = createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } })
  session.append('user/message', dispatch, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{}' } as never)
  session.append('tool/code-dispatch-start', { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:code:1', name: 'node_claim', arguments: {} } as never)
  const callers: unknown[] = []
  const host = makeToolHost({
    claim: async (_ws, _claim, caller) => { callers.push(caller); return { ok: true } },
    block: async (_ws, _token, _reason, caller) => { callers.push(caller); return { ok: true } },
  })
  const exec = { ...EXEC, agent: { session }, callId: 'root:code:1', rootCallId: 'root' }
  await findTool(host, 'node_claim').execute({ result: 'succeeded', handoff: 'done' }, exec as never)
  await findTool(host, 'node_block').execute({ nodeToken: randomUUID(), reason: 'pause' }, exec as never)
  await findTool(host, 'node_claim').execute({ result: 'succeeded', handoff: 'forged root' }, { ...exec, rootCallId: 'other-root' } as never)
  await findTool(host, 'node_claim').execute({ result: 'succeeded', handoff: 'forged subcall' }, { ...exec, callId: 'root:code:2' } as never)
  assert.deepEqual(callers, [
    { sessionId: 'code-caller', turnUserMessageIds: new Set([dispatch.id]), sessionUserMessageIds: new Set([dispatch.id]) },
    { sessionId: 'code-caller', turnUserMessageIds: new Set([dispatch.id]), sessionUserMessageIds: new Set([dispatch.id]) },
    { sessionId: 'code-caller', turnUserMessageIds: new Set() },
    { sessionId: 'code-caller', turnUserMessageIds: new Set() },
  ])
})

// ---- #94 按插件实例绑定 Host（无模块级可变引用） ----

/** 工具注册表替身：register 返回只撤销本次注册的 dispose（对应 ctx.tools.register）。 */
function makeRegistry() {
  const registered = new Map<string, ToolDefinition>()
  return {
    registered,
    register(def: ToolDefinition) {
      registered.set(def.name, def)
      return () => { registered.delete(def.name) }
    },
    async execute(name: string, args: unknown) {
      const def = registered.get(name)
      assert.ok(def, `tool ${name} should be registered`)
      return def!.execute(args as never, EXEC as never)
    },
  }
}

test('#94: two instances each route their own tools to their own host', async () => {
  const a = makeToolHost({ authorize: async () => ({ workspaceKey: 'ws-A' }) })
  const b = makeToolHost({ authorize: async () => ({ workspaceKey: 'ws-B' }) })
  await findTool(a, 'node_block').execute({ nodeToken: 't1', reason: 'from A' }, EXEC as never)
  await findTool(b, 'node_block').execute({ nodeToken: 't2', reason: 'from B' }, EXEC as never)
  assert.deepEqual(a.calls, [{ name: 'block', args: { ws: 'ws-A', nodeToken: 't1', reason: 'from A' } }])
  assert.deepEqual(b.calls, [{ name: 'block', args: { ws: 'ws-B', nodeToken: 't2', reason: 'from B' } }])
})

test('#94: an authorize still suspended while another instance is assembled mutates its OWN host', async () => {
  let releaseA: () => void = () => {}
  const gate = new Promise<void>(resolve => { releaseA = resolve })
  const a = makeToolHost({ authorize: async () => { await gate; return { workspaceKey: 'ws-A' } } })
  const pending = findTool(a, 'node_block').execute({ nodeToken: 't1', reason: 'A after suspend' }, EXEC as never)
  // A 的 authorize 挂起期间，B 完成装配并注册同名工具。
  const b = makeToolHost({ authorize: async () => ({ workspaceKey: 'ws-B' }) })
  await findTool(b, 'node_block').execute({ nodeToken: 't2', reason: 'B' }, EXEC as never)
  releaseA()
  await pending
  assert.deepEqual(a.calls, [{ name: 'block', args: { ws: 'ws-A', nodeToken: 't1', reason: 'A after suspend' } }])
  assert.deepEqual(b.calls, [{ name: 'block', args: { ws: 'ws-B', nodeToken: 't2', reason: 'B' } }])
})

test('#94: disposing one instance leaves the other instance registered and routing', async () => {
  const a = makeToolHost()
  const b = makeToolHost({ authorize: async () => ({ workspaceKey: 'ws-B' }) })
  // 两个实例各自建集：共享同一份工具对象就会让「按实例绑定 Host」失效。
  assert.notStrictEqual(a.tools, b.tools)
  assert.notStrictEqual(a.tools[0], b.tools[0])
  const registryA = makeRegistry()
  const registryB = makeRegistry()
  const disposeA = a.tools.map(def => registryA.register(def))
  for (const def of b.tools) registryB.register(def)
  assert.deepEqual([...registryA.registered.keys()].sort(), [...registryB.registered.keys()].sort())
  for (const dispose of disposeA) dispose()
  // A 卸载后自身注册表为空（无引用已关闭 Store 的遗留注册），B 的注册与路由不受影响。
  assert.equal(registryA.registered.size, 0)
  assert.equal(registryB.registered.size, b.tools.length)
  assert.equal(await registryB.execute('node_resume', { nodeToken: 't2', resolutionContext: 'still alive' }), 'resumed')
  assert.deepEqual(b.calls, [{ name: 'resume', args: { ws: 'ws-B', nodeToken: 't2', resolutionContext: 'still alive', target: 'auto' } }])
})

// ---- command tests ----

function makeCommandHost(overrides: Partial<CommandHost> = {}): CommandHost {
  return {
    currentWorkspaceKey: async () => 'ws-1',
    list: async () => ({ entries: [{ workflowId: 'a' }, { workflowId: 'b' }], diagnostics: [{ workflowId: 'bad', path: 'p', reason: 'broken', severity: 'error' }] }),
    start: async (_agent, _ws, workflowId, extra) => ({ ok: true, message: `started ${workflowId} [${extra}]` }),
    status: async () => ({ ok: true, status: { status: 'running' } }),
    reset: async () => ({ ok: true, message: 'removed' }),
    ...overrides,
  }
}

test('dsh-flow with no arguments returns usage', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: '', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /用法/)
})

test('dsh-flow list renders entries and diagnostics', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'list', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /a/)
  assert.match(result.text ?? '', /invalid/)
})

test('#59: dsh-flow list tags warnings as [warn], never as [invalid]', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost({
    list: async () => ({
      entries: [{ workflowId: 'warned' }],
      diagnostics: [{ workflowId: 'warned', path: 'p', reason: 'role "developer" persona must not hand-write submission protocol (found "node_claim")', severity: 'warning' }],
    }),
  }))
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'list', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /^- warned$/m)
  assert.match(result.text ?? '', /- \[warn\] warned — role "developer".*node_claim/)
  assert.doesNotMatch(result.text ?? '', /\[invalid\]/)
})

test('dsh-flow start parses workflow id and extra text', async () => {
  const started: string[] = []
  const cmd = makeDshFlowCommand(makeCommandHost({
    start: async (_agent, _ws, workflowId, extra) => { started.push(workflowId, extra); return { ok: true, message: 'started' } },
  }))
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'start my-wf hello world', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.deepEqual(started, ['my-wf', 'hello world'])
})

test('dsh-flow start rejects a missing workflow id', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'start', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
})

test('dsh-flow start rejects invalid workflow ids', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'start BadId', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
})

test('dsh-flow status renders host status', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: { session: { id: 'manager' } } as never, rawInput: 'status', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /running/)
})

test('dsh-flow unknown verb returns usage', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'frobnicate', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知子命令/)
})

// ---- #85 blank-session activation ----

/** 让 setTimeout(0) 的激活投递跑完。 */
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function invocation(agent: unknown, rawInput: string) {
  return { commandId: 'x' as never, agent: agent as never, rawInput, attachments: [], signal: new AbortController().signal }
}

/** root 会话 + 记录 followup 的 Agent 替身。 */
function fakeRootAgent(session: Session) {
  const sent: UserMessage[] = []
  const agent = { session, followup: (message: UserMessage) => { sent.push(message) } }
  return { agent, sent }
}

const textOf = (message: UserMessage) => message.content.map(block => block.type === 'text' ? block.text : '').join('')

/** 宿主 session-controller 的 blank 投影服务替身（cachedSnapshot 只读 cell）。 */
function projectionWith(blank: boolean | undefined) {
  return { cachedSnapshot: () => blank === undefined ? undefined : { asOfSeq: 0, values: { sessionListMetadata: { blank } } } }
}

function ctxWith(registry: unknown) {
  const warnings: string[] = []
  return { ctx: { get: () => registry, logger: { warn: (message: string) => { warnings.push(message) } } }, warnings }
}

/** 模拟宿主：handler 执行前已追加 command/run，全新空白会话此刻 seq === 1。 */
function blankSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('command/run', { commandId: 'c1', name: 'dsh-flow', args: 'list', source: { kind: 'user' } } as never)
  return session
}

test('#85: a blank root session gets one plugin/notice followup after the handler returns', async () => {
  const { agent, sent } = fakeRootAgent(blankSession('blank-root'))
  const { ctx } = ctxWith(projectionWith(true))
  const cmd = makeDshFlowCommand(makeCommandHost(), makeBlankSessionActivator(ctx as never))
  const result = await cmd.handler(invocation(agent, 'list'))
  assert.equal(result.kind, 'success')
  assert.equal(sent.length, 0) // 投递发生在 handler 返回之后
  await tick()
  assert.equal(sent.length, 1)
  assert.equal(sent[0]!.source.kind, 'plugin')
  assert.equal((sent[0]!.source as { form?: string }).form, 'notice')
  assert.match(textOf(sent[0]!), /- a/) // 结果文本进了转述内容
  assert.match(textOf(sent[0]!), /不要调用任何工具/)
})

test('#85: a blank root session also gets an error result delivered', async () => {
  const { agent, sent } = fakeRootAgent(blankSession('blank-root-error'))
  const { ctx } = ctxWith(projectionWith(true))
  const cmd = makeDshFlowCommand(makeCommandHost(), makeBlankSessionActivator(ctx as never))
  const result = await cmd.handler(invocation(agent, 'frobnicate'))
  assert.equal(result.kind, 'error')
  await tick()
  assert.equal(sent.length, 1)
  assert.match(textOf(sent[0]!), /未知子命令/)
})

test('#85: a non-blank session is never activated, even at seq 1', async () => {
  const { agent, sent } = fakeRootAgent(blankSession('already-open'))
  const { ctx } = ctxWith(projectionWith(false))
  const cmd = makeDshFlowCommand(makeCommandHost(), makeBlankSessionActivator(ctx as never))
  await cmd.handler(invocation(agent, 'list'))
  await tick()
  assert.equal(sent.length, 0)
})

test('#85: projection absent falls back to seq — fresh session activates, later session does not', async () => {
  const fresh = fakeRootAgent(blankSession('fresh'))
  const later = fakeRootAgent(blankSession('later'))
  later.agent.session.append('command/done', { commandId: 'c1', kind: 'success' } as never)
  const { ctx } = ctxWith(undefined) // 无 sessionProjections 服务
  const cmd = makeDshFlowCommand(makeCommandHost(), makeBlankSessionActivator(ctx as never))
  await cmd.handler(invocation(fresh.agent, 'list'))
  await cmd.handler(invocation(later.agent, 'list'))
  await tick()
  assert.equal(fresh.sent.length, 1)
  assert.equal(later.sent.length, 0)
})

test('#85: a subagent-shaped invoker never reaches the activator', async () => {
  const calls: unknown[] = []
  const cmd = makeDshFlowCommand(makeCommandHost(), agent => { calls.push(agent) })
  const child = { session: { header: { parentSession: 'root', origin: 'subagent' } } }
  const result = await cmd.handler(invocation(child, 'list'))
  await tick()
  assert.equal(result.kind, 'success')
  assert.deepEqual(calls, [])
})

test('#85: a throwing activator leaves the command result untouched', async () => {
  const { agent } = fakeRootAgent(blankSession('throwing'))
  const cmd = makeDshFlowCommand(makeCommandHost(), () => { throw new Error('boom') })
  const result = await cmd.handler(invocation(agent, 'list'))
  await tick()
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /- a/)
})

test('#85: a failing activation is swallowed with a warn', async () => {
  const { agent, sent } = fakeRootAgent(blankSession('failing'))
  const { ctx, warnings } = ctxWith(undefined)
  const cmd = makeDshFlowCommand(makeCommandHost(), makeBlankSessionActivator({
    get: () => { throw new Error('no service plane') },
    logger: ctx.logger,
  } as never))
  const result = await cmd.handler(invocation(agent, 'list'))
  await tick()
  assert.equal(result.kind, 'success')
  assert.equal(sent.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /activation skipped: Error: no service plane/)
})
