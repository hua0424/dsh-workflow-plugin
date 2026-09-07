import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowTools, setToolHost, type ToolHost } from '../src/tools/tools.ts'
import { makeDshFlowCommand, type CommandHost } from '../src/commands/dsh-flow.ts'
import { randomUUID } from 'node:crypto'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Find a registered tool by name. */
function findTool(name: string) {
  const def = workflowTools.find(t => t.name === name)
  assert.ok(def, `tool ${name} should be registered`)
  return def!
}

/** A tiny host double that records engine mutations. */
function makeToolHost(overrides: Partial<ToolHost> = {}): ToolHost & { calls: Array<{ name: string; args: unknown }> } {
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
  setToolHost(host)
  return { ...host, calls }
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
  const names = workflowTools.map(t => t.name).sort()
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
  const tool = findTool('node_claim')
  let concluded = false
  const exec = { ...EXEC, concludeTurn: () => { concluded = true } }
  const result = await tool.execute(
    { outcome: 'completed', handoff: 'did it; next: X' },
    exec as never,
  )
  assert.equal(result, 'claimed')
  // A1 AC2: no nodeToken — only the payload plus the lease caller snapshot
  // (EXEC has no agent → fail-closed empty id set, sessionId '').
  assert.deepEqual(host.calls[0], { name: 'claim', args: { ws: 'ws-1', claim: { outcome: 'completed', handoff: 'did it; next: X' }, caller: { sessionId: '', turnUserMessageIds: new Set<string>() } } })
  assert.equal(concluded, true)
})

test('node_block routes to host.block and concludes the turn on success', async () => {
  const host = makeToolHost()
  const tool = findTool('node_block')
  let concluded = false
  const exec = { ...EXEC, concludeTurn: () => { concluded = true } }
  const token = randomUUID()
  await tool.execute({ nodeToken: token, reason: 'blocked by hand' }, exec as never)
  assert.deepEqual(host.calls[0], { name: 'block', args: { ws: 'ws-1', nodeToken: token, reason: 'blocked by hand' } })
  assert.equal(concluded, true)
})

test('node_resume routes to host.resume', async () => {
  const host = makeToolHost()
  const tool = findTool('node_resume')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, resolutionContext: 'fixed it', target: 'judge' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'resume', args: { ws: 'ws-1', nodeToken: token, resolutionContext: 'fixed it', target: 'judge' } })
  await assert.rejects(() => tool.execute({ nodeToken: token, resolutionContext: 'fixed', surprise: true }, EXEC as never), /unsupported node_resume property/)
})

test('node_run_program routes to host.runProgram', async () => {
  const host = makeToolHost()
  const tool = findTool('node_run_program')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, parameters: { title: 'M1' } }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'runProgram', args: { ws: 'ws-1', nodeToken: token, parameters: { title: 'M1' } } })
})

test('node_resolve_program routes to host.resolveProgram', async () => {
  const host = makeToolHost()
  const tool = findTool('node_resolve_program')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, result: 'PASS', reason: 'verified by hand' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'resolveProgram', args: { ws: 'ws-1', nodeToken: token, result: 'PASS', reason: 'verified by hand' } })
})

test('workflow_set_role_model routes to host.setRoleModel', async () => {
  const host = makeToolHost()
  const tool = findTool('workflow_set_role_model')
  await tool.execute({ roleKey: 'developer', provider: 'p', modelId: 'm' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'setRoleModel', args: { ws: 'ws-1', roleKey: 'developer', provider: 'p', modelId: 'm' } })
})

test('workflow_status renders host status', async () => {
  const host = makeToolHost()
  const tool = findTool('workflow_status')
  const result = await tool.execute({}, EXEC as never)
  assert.match(result as string, /r1/)
  assert.ok(host.calls.length === 0)
})

test('workflow_status forwards explicit history paging and rejects open-root extras or invalid combinations', async () => {
  const calls: unknown[] = []
  makeToolHost({ status: async (...args: unknown[]) => { calls.push(args); return { ok: true, status: { history: [] } } } })
  const tool = findTool('workflow_status')
  const agent = { session: { id: 'manager' } }
  await tool.execute({ executionId: 'execution-1', after: 4, limit: 10 }, { ...EXEC, agent } as never)
  assert.deepEqual(calls, [['ws-1', 'manager', { executionId: 'execution-1', after: 4, limit: 10 }]])
  await assert.rejects(() => tool.execute({ after: 1 }, { ...EXEC, agent } as never), /executionId/)
  await assert.rejects(() => tool.execute({ executionId: 'execution-1', limit: 51 }, { ...EXEC, agent } as never), /limit/)
  await assert.rejects(() => tool.execute({ executionId: 'execution-1', surprise: true }, { ...EXEC, agent } as never), /unsupported workflow_status property/)
})

test('judge_claim routes to host.judgeClaim and concludes the turn on success', async () => {
  const host = makeToolHost()
  const tool = findTool('judge_claim')
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
  const nodeClaim = findTool('node_claim')
  const judgeClaim = findTool('judge_claim')
  const nodeBlock = findTool('node_block')
  const padded = ' '.repeat(10_000) + 'x'
  await nodeClaim.execute({ outcome: 'completed', handoff: padded }, EXEC as never)
  await judgeClaim.execute({ nodeToken: randomUUID(), result: 'ACCEPT', reason: padded }, EXEC as never)
  await nodeBlock.execute({ nodeToken: randomUUID(), reason: padded }, EXEC as never)
  assert.deepEqual((host.calls[0]!.args as { claim: { handoff: string } }).claim, { outcome: 'completed', handoff: 'x' })
  assert.equal((host.calls[1]!.args as { reason: string }).reason, 'x')
  assert.equal((host.calls[2]!.args as { reason: string }).reason, 'x')
})

test('T2 public schema rejects legacy fields and invalid handoff symmetrically', async () => {
  const host = makeToolHost()
  const tool = findTool('node_claim')
  for (const outcome of ['completed', 'failed']) {
    for (const args of [
      { outcome }, { outcome, handoff: 42 },
      { outcome, summary: 'old' }, { outcome, handoffContext: 'old' },
      { outcome, handoff: 'valid', summary: 'old' },
      { outcome, handoff: 'valid', handoffContext: 'old' },
    ]) {
      await assert.rejects(() => tool.execute(args, EXEC as never), /invalid arguments/)
    }
    for (const handoff of ['', '   ', 'x'.repeat(8001)]) {
      assert.match(await tool.execute({ outcome, handoff }, EXEC as never) as string, /拒绝：handoff/)
    }
    const handoff = 'x'.repeat(8000)
    assert.equal(await tool.execute({ outcome, handoff: `  ${handoff}  ` }, EXEC as never), 'claimed')
    assert.deepEqual((host.calls.at(-1)!.args as { claim: unknown }).claim, { outcome, handoff })
  }
  assert.equal(host.calls.length, 2)
})

test('judge_respawn routes to host.respawnJudge', async () => {
  const host = makeToolHost()
  const tool = findTool('judge_respawn')
  const token = randomUUID()
  await tool.execute({ nodeToken: token, reason: 'model swap' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'respawnJudge', args: { ws: 'ws-1', nodeToken: token, reason: 'model swap', caller: '' } })
  await assert.rejects(() => tool.execute({ nodeToken: token, extra: true }, EXEC as never), /unsupported judge_respawn property/)
})

test('inspection wrappers reject when authorize fails', async () => {
  const host = makeToolHost({
    authorize: async () => ({ workspaceKey: null, reason: 'judge only' }),
  })
  const tool = findTool('workflow_inspect_git')
  const result = await tool.execute({ operation: 'status' }, EXEC as never)
  assert.match(result as string, /拒绝：judge only/)
})

test('authorize denial surfaces in control tools', async () => {
  const host = makeToolHost({
    authorize: async () => ({ workspaceKey: null, reason: 'only manager' }),
  })
  const tool = findTool('node_claim')
  const result = await tool.execute({ outcome: 'completed', handoff: 's' }, EXEC as never)
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
  await findTool('node_claim').execute({ outcome: 'completed', handoff: 'done' }, {
    ...EXEC, agent: { session }, callId: 'native-claim', rootCallId: 'native-claim',
  } as never)
  assert.deepEqual((host.calls[0]!.args as { caller: unknown }).caller, {
    sessionId: 'native-caller', turnUserMessageIds: new Set([dispatch.id]),
  })
  await findTool('judge_claim').execute({ nodeToken: randomUUID(), result: 'ACCEPT', reason: 'verified' }, {
    ...EXEC, agent: { session }, callId: 'judge-call', rootCallId: 'judge-call',
  } as never)
  assert.deepEqual((host.calls[1]!.args as { caller: unknown }).caller, {
    sessionId: 'native-caller', turnUserMessageIds: new Set([dispatch.id]),
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
  makeToolHost({
    claim: async (_ws, _claim, caller) => { callers.push(caller); return { ok: true } },
    block: async (_ws, _token, _reason, caller) => { callers.push(caller); return { ok: true } },
  })
  const exec = { ...EXEC, agent: { session }, callId: 'root:code:1', rootCallId: 'root' }
  await findTool('node_claim').execute({ outcome: 'completed', handoff: 'done' }, exec as never)
  await findTool('node_block').execute({ nodeToken: randomUUID(), reason: 'pause' }, exec as never)
  await findTool('node_claim').execute({ outcome: 'completed', handoff: 'forged root' }, { ...exec, rootCallId: 'other-root' } as never)
  await findTool('node_claim').execute({ outcome: 'completed', handoff: 'forged subcall' }, { ...exec, callId: 'root:code:2' } as never)
  assert.deepEqual(callers, [
    { sessionId: 'code-caller', turnUserMessageIds: new Set([dispatch.id]) },
    { sessionId: 'code-caller', turnUserMessageIds: new Set([dispatch.id]) },
    { sessionId: 'code-caller', turnUserMessageIds: new Set() },
    { sessionId: 'code-caller', turnUserMessageIds: new Set() },
  ])
})

// ---- command tests ----

function makeCommandHost(overrides: Partial<CommandHost> = {}): CommandHost {
  return {
    currentWorkspaceKey: async () => 'ws-1',
    list: async () => ({ entries: [{ workflowId: 'a' }, { workflowId: 'b' }], diagnostics: [{ workflowId: 'bad', path: 'p', reason: 'broken' }] }),
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
