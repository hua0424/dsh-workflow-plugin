// #251 运行监控 status RPC 受控测试：真 engine + SQLite + stub 派发 + 隔离临时
// DSH home（绝不触碰真实 ~/.dsh），覆盖活跃 Run / 无 Run / 终态 Run / 维护诊断态。
// 视图模型纯函数与 bundle 注册断言在 test/monitor-view.test.ts。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimCaller, WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { createMonitorRpcHandler, MONITOR_RPC_CHANNEL } from '../src/monitor/rpc.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3', roles: { reviewer: { persona: 'Review', model: { provider: 'prov', modelId: 'm-review' } } }, judgeRole: { persona: 'Read only' },
  workflow: { startNode: 'plan', returns: ['done'], nodes: {
    plan: {
      execution: { type: 'actor-task', role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
      results: { succeeded: { criteria: 'The plan is complete.', target: { node: 'review' } } },
    },
    review: {
      execution: { type: 'actor-task', role: 'reviewer', instruction: 'Review' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct review' } },
      results: { succeeded: { criteria: 'The review is complete.', target: { return: 'done' } } },
    },
  } } }

// 与 test/actor-tokenless-block.test.ts 同构的最小 harness（stub 派发，零真实会话）。
function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-251-'))
  const store = new StateStore(home)
  let message = 0
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: `actor-message-${++message}` } },
    async sendRoleActor(run, role) { return { messageId: `actor-message-${++message}`, childId: run.roleActors[role]! } },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, role) { return { childId: `role-${role}`, messageId: `actor-message-${++message}` } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: `judge-message-${++message}` } },
    async followupJudge() { return { messageId: `judge-followup-${++message}` } },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {}, async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' },
  }, { async run() { throw new Error('unexpected Program') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  return { home, store, engine, cleanup() { store.close(); rmSync(home, { recursive: true, force: true }) } }
}

/** 显式传 workspace key 形状的 cwd：服务端只按请求上行解析，不再回退 process.cwd。 */
function handlerOf(h: ReturnType<typeof harness>) {
  return createMonitorRpcHandler({
    maintenance: () => undefined,
    status: async cwd => h.store.get(cwd ?? 'ws'),
    executions: async cwd => h.store.runExecutions(cwd ?? 'ws'),
  })
}

async function claim(h: ReturnType<typeof harness>, caller: ClaimCaller, result: string, handoff: string): Promise<void> {
  assert.equal((await h.engine.handleClaim('ws', { result, handoff }, caller)).ok, true)
  await h.engine.handleTurnEnded('ws', caller)
}

async function judgeAccept(h: ReturnType<typeof harness>, caller: ClaimCaller): Promise<void> {
  const row = (await h.store.get('ws'))!
  assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'verified', caller)).ok, true)
  await h.engine.handleTurnEnded('ws', caller)
}

test('#251 status：无 Run → empty 模式', async () => {
  const h = harness()
  try {
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { mode: 'empty' })
  } finally { h.cleanup() }
})

test('#251 status：活跃 Run → 完整只读投影（节点/角色模型/图/启动 prompt/BLOCK）', async () => {
  const h = harness()
  try {
    assert.equal((await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')).ok, true)
    const handler = handlerOf(h)
    const active = await handler('status', { cwd: 'ws' })
    assert.equal(active.ok, true)
    const payload = active.value as Extract<typeof active.value, { mode: 'run' }>
    assert.equal(payload.mode, 'run')
    assert.equal(payload.run!.status, 'running')
    assert.equal(payload.run!.workflowId, 'test')
    assert.equal(payload.run!.launchPrompt, '受控启动请求')
    // 节点按 visit 升序；首个工作单 working、当前焦点在 plan。
    assert.equal(payload.run!.nodes.length, 1)
    assert.deepEqual([payload.run!.nodes[0].nodeId, payload.run!.nodes[0].phase, payload.run!.nodes[0].current], ['plan', 'working', true])
    // 冻结图结构：根流程两节点 + 生效模型（manager 继承路由，reviewer 显式声明）。
    const flow = payload.run!.flows['test']
    assert.deepEqual(flow.nodes.map(node => [node.id, node.kind, node.role]), [['plan', 'actor-task', 'manager'], ['review', 'actor-task', 'reviewer']])
    assert.equal(flow.nodes.find(node => node.id === 'review')!.model!.modelId, 'm-review')
    const roles = Object.fromEntries(payload.run!.roles.map(role => [role.role, role.model.modelId]))
    assert.equal(roles['reviewer'], 'm-review')
    assert.ok('judge' in roles, '角色清单含 judge')

    // 推进到 review working 后：节点两个，栈顶焦点切到 review。
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    const afterPlan = (await h.store.get('ws'))!
    const planJudge: ClaimCaller = { sessionId: afterPlan.execution.judge!.sessionId!, turnUserMessageIds: new Set([afterPlan.execution.judge!.messageId!]) }
    await judgeAccept(h, planJudge)
    let row = (await h.store.get('ws'))!
    assert.equal(row.execution.nodeId, 'review')
    const reviewer: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    await claim(h, reviewer, 'succeeded', 'review artifact')
    const afterReview = await handler('status', { cwd: 'ws' })
    assert.equal(afterReview.ok, true)
    const checking = afterReview.value as Extract<typeof afterReview.value, { mode: 'run' }>
    assert.deepEqual(checking.run!.nodes.map(node => [node.visit, node.nodeId, node.phase, node.current]), [[1, 'plan', 'exited', false], [2, 'review', 'checking', true]])
    // 未知 endpoint 与非法 payload 明确拒绝。
    assert.equal((await handler('reset', {})).ok, false)
    assert.equal((await handler('status', { cwd: 42 })).ok, false)
  } finally { h.cleanup() }
})

test('#251 status：BLOCK 原因透出（run 级 + 节点级）', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    const afterPlan = (await h.store.get('ws'))!
    const planJudge: ClaimCaller = { sessionId: afterPlan.execution.judge!.sessionId!, turnUserMessageIds: new Set([afterPlan.execution.judge!.messageId!]) }
    await judgeAccept(h, planJudge)
    const row = (await h.store.get('ws'))!
    const reviewer: ClaimCaller = { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    assert.equal((await h.engine.handleBlock('ws', undefined, '等待授权', reviewer)).ok, true)
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    assert.equal(payload.run!.status, 'blocked')
    // BLOCK 原因记录在工作单上（run.blockReason 只在终止等路径写入）；投影按节点透出。
    const blockedNode = payload.run!.nodes.find(node => node.current)
    assert.equal(blockedNode!.blockReason, '等待授权')
  } finally { h.cleanup() }
})

test('#251 status：终态 Run → completed + 业务返回', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, '受控启动请求')
    const manager: ClaimCaller = { sessionId: 'manager', turnUserMessageIds: new Set(['actor-message-1']) }
    await claim(h, manager, 'succeeded', 'plan artifact')
    let row = (await h.store.get('ws'))!
    await judgeAccept(h, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
    row = (await h.store.get('ws'))!
    await claim(h, { sessionId: 'role-reviewer', turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }, 'succeeded', 'review artifact')
    row = (await h.store.get('ws'))!
    await judgeAccept(h, { sessionId: row.execution.judge!.sessionId!, turnUserMessageIds: new Set([row.execution.judge!.messageId!]) })
    row = (await h.store.get('ws'))!
    assert.equal(row.run.status, 'completed')
    const result = await handlerOf(h)('status', { cwd: 'ws' })
    assert.equal(result.ok, true)
    const payload = result.value as Extract<typeof result.value, { mode: 'run' }>
    assert.equal(payload.run!.status, 'completed')
    assert.deepEqual(payload.run!.businessReturn, { name: 'done', source: row.execution.executionId })
    assert.deepEqual(payload.run!.nodes.map(node => [node.visit, node.phase]), [[1, 'exited'], [2, 'exited']])
  } finally { h.cleanup() }
})

test('#251 status：cwd 原样透传，缺省不猜宿主 process.cwd（F4）', async () => {
  const seen: Array<string | undefined> = []
  const handler = createMonitorRpcHandler({
    maintenance: () => undefined,
    status: async cwd => { seen.push(cwd); return undefined },
    executions: async cwd => { seen.push(cwd); return [] },
  })
  assert.deepEqual(await handler('status', {}), { ok: true, value: { mode: 'empty' } })
  assert.deepEqual(await handler('status', { cwd: 'D:/ws' }), { ok: true, value: { mode: 'empty' } })
  assert.deepEqual(seen, [undefined, undefined, 'D:/ws', 'D:/ws'])
})

test('#251 status：维护诊断短路，不触碰状态库', async () => {
  const touched: string[] = []
  const handler = createMonitorRpcHandler({
    maintenance: () => ({ kind: 'incompatible', path: '/tmp/state.sqlite3', userVersion: 1, tables: ['runs'], reason: 'incompatible state format (user_version=1); original data retained' }),
    status: async () => { touched.push('status'); return undefined },
    executions: async () => { touched.push('executions'); return [] },
  })
  const result = await handler('status', {})
  assert.equal(result.ok, true)
  const payload = result.value as Extract<typeof result.value, { mode: 'maintenance' }>
  assert.equal(payload.mode, 'maintenance')
  assert.equal(payload.maintenance!.kind, 'incompatible')
  assert.match(payload.maintenance!.reason, /incompatible state format/)
  assert.deepEqual(touched, [])
  // 通道名与编辑器通道分离（ADR-0005：独立通道）。
  assert.notEqual(MONITOR_RPC_CHANNEL, '/workflow-config-editor')
})
