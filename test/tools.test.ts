import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workflowTools, setToolHost, type ToolHost } from '../src/tools/tools.ts'
import { makeDshFlowCommand, type CommandHost } from '../src/commands/dsh-flow.ts'
import { randomUUID } from 'node:crypto'

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
    claim: async (ws, claim) => { calls.push({ name: 'claim', args: { ws, claim } }); return { ok: true, message: 'claimed' } },
    block: async (ws, nodeToken, reason) => { calls.push({ name: 'block', args: { ws, nodeToken, reason } }); return { ok: true, message: 'blocked' } },
    resume: async (ws, nodeToken, resolutionContext) => { calls.push({ name: 'resume', args: { ws, nodeToken, resolutionContext } }); return { ok: true, message: 'resumed' } },
    runProgram: async (ws, nodeToken, parameters) => { calls.push({ name: 'runProgram', args: { ws, nodeToken, parameters } }); return { ok: true, message: 'ran' } },
    resolveProgram: async (ws, nodeToken, result, reason) => { calls.push({ name: 'resolveProgram', args: { ws, nodeToken, result, reason } }); return { ok: true, message: 'resolved' } },
    setRoleModel: async (ws, roleKey, provider, modelId) => { calls.push({ name: 'setRoleModel', args: { ws, roleKey, provider, modelId } }); return { ok: true, message: 'set' } },
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

test('exactly seven workflow tools + two inspection wrappers are registered', () => {
  const names = workflowTools.map(t => t.name).sort()
  assert.deepEqual(names, [
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
  const token = randomUUID()
  const result = await tool.execute(
    { nodeToken: token, outcome: 'completed', summary: 'did it', handoffContext: 'next: X' },
    exec as never,
  )
  assert.equal(result, 'claimed')
  assert.deepEqual(host.calls[0], { name: 'claim', args: { ws: 'ws-1', claim: { nodeToken: token, outcome: 'completed', summary: 'did it', handoffContext: 'next: X' } } })
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
  await tool.execute({ nodeToken: token, resolutionContext: 'fixed it' }, EXEC as never)
  assert.deepEqual(host.calls[0], { name: 'resume', args: { ws: 'ws-1', nodeToken: token, resolutionContext: 'fixed it' } })
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
  const result = await tool.execute({ nodeToken: 'x', outcome: 'completed', summary: 's' }, EXEC as never)
  assert.match(result as string, /拒绝：only manager/)
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
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'status', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /running/)
})

test('dsh-flow unknown verb returns usage', async () => {
  const cmd = makeDshFlowCommand(makeCommandHost())
  const result = await cmd.handler({ commandId: 'x' as never, agent: {} as never, rawInput: 'frobnicate', attachments: [], signal: new AbortController().signal })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知子命令/)
})
