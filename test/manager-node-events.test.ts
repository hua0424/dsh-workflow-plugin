/**
 * Issue #203 验收：节点 phase 变化时向 Manager 会话推送结构化节点事件。
 *
 * - 每次 Manager 不可见的 phase 变化（working/checking/判定中/退出/BLOCK/终局）
 *   都恰好对应一条 `[node-event]` 消息，字段含 nodeId、nodeToken、phase、
 *   claimResult、judgment 摘要、blockReason。
 * - Manager 可见的派发（manager 角色 / Program 指令 / BLOCK / 终局正文本就是
 *   当 turn 的通知，不另发一条（BLOCK/终局首部携带结构化字段）。
 * - 推送 best-effort：steerManager 抛错不阻断主流程（降级为现状轮询）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type SubagentHost } from '../src/engine/engine.ts'
import type { ExecutionDispatch, WorkflowConfig } from '../src/types.ts'

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3' as const,
  roles: { worker: { persona: 'do work' } },
  judgeRole: { persona: 'readonly' },
  workflow: { startNode: 'first', returns: ['done'],
    nodes: {
      first: {
        execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Start' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } },
        results: { succeeded: { criteria: 'The start is verified.', target: { node: 'job' } } },
      },
      job: {
        execution: { type: 'actor-task' as const, role: 'worker', instruction: 'Do it' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } },
        results: { succeeded: { criteria: 'The job is verified.', target: { return: 'done' } } },
      },
    } },
}

function harness(opts: { steerFailsOnEvent?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-203-'))
  const store = new StateStore(home)
  const managerTexts: string[] = []
  const actorTexts: string[] = []
  let sequence = 0
  const subagents: SubagentHost = {
    ensureRoleActor: async (_run, _role, text) => { actorTexts.push(text); return { childId: 'actor-1', messageId: `actor-${++sequence}` } },
    startJudge: async (_run, input) => ({ judgeSessionId: input.judgeSessionId, messageId: `judge-${++sequence}` }),
    followupJudge: async () => { throw new Error('not expected') },
    judgeSessionAvailability: async () => 'available',
    roleSessionAvailability: async () => 'available',
    retireJudge: async () => {},
    drainJudge: async () => {},
    drainRoleActor: async () => {},
    compactRoleActor: async () => ({ ok: true }),
    safeToInspect: async () => 'safe',
  }
  const engine = new WorkflowEngine({
    steerManager: async (_run, text) => {
      if (opts.steerFailsOnEvent && text.startsWith('[node-event]')) throw new Error('manager push exploded')
      managerTexts.push(text)
      return { messageId: `manager-${++sequence}` }
    },
    sendRoleActor: async () => { throw new Error('unexpected followup') },
    managerSessionSeq: () => 0,
  }, subagents, { run: async () => ({ kind: 'ERROR' }) }, makeStateHost(store))
  engine.cwdResolver = async () => `${home}-cwd`
  const caller = (dispatch: ExecutionDispatch) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  const events = () => managerTexts.filter(text => text.startsWith('[node-event]'))
  return {
    engine, managerTexts, actorTexts, caller, events,
    row: async () => (await store.get('ws'))!,
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('#203 节点推进全程：每次 Manager 不可见的 phase 变化都有结构化事件', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    // manager 首节点：派发正文本身就是当 turn 通知，不另发事件。
    assert.equal(h.events().length, 0)
    const first = await h.row()
    const manager = h.caller(first.execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
    // claim 已提交（checking）。
    assert.equal(h.events().length, 1)
    assert.match(h.events()[0]!, /phase=checking/)
    assert.match(h.events()[0]!, /node=test\/first/)
    assert.match(h.events()[0]!, new RegExp(`nodeToken=${(await h.row()).execution.nodeToken}`))
    assert.match(h.events()[0]!, /claimResult=succeeded/)
    await h.engine.handleTurnEnded('ws', manager)
    // Judge 已派发（判定中）：同一 checking 内的第二次事件带 claim 结果。
    assert.equal(h.events().length, 2)
    assert.match(h.events()[1]!, /phase=checking/)
    assert.match(h.events()[1]!, /claimResult=succeeded/)
    const checking = await h.row()
    const judge = h.caller(checking.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'looks good', judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    const after = await h.row()
    // ACCEPT 退出 + worker 节点派发（working）：退出事件带终局名与 judgment 摘要。
    assert.equal(after.execution.nodeId, 'job')
    assert.equal(h.events().length, 4)
    assert.match(h.events()[2]!, /phase=exited/)
    assert.match(h.events()[2]!, /returned=result:succeeded/)
    assert.match(h.events()[2]!, /judgment=ACCEPT looks good/)
    assert.match(h.events()[3]!, /phase=working/)
    assert.match(h.events()[3]!, /node=test\/job/)
    // 全程 Manager 无需轮询 workflow_status：事件数与 phase 变化一一对应即可，
    // 此处只断言不再需要 status 也能从事件读出当前节点与 token。
    assert.match(h.events()[3]!, new RegExp(`nodeToken=${after.execution.nodeToken}`))
  } finally { h.close() }
})

test('#203 BLOCK 与终局消息首部携带结构化事件（不另发一条）', async () => {
  const h = harness()
  try {
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const first = await h.row()
    const manager = h.caller(first.execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
    await h.engine.handleTurnEnded('ws', manager)
    const checking = await h.row()
    const judge = h.caller(checking.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'NEED_CONTEXT', 'need more logs', judge)).ok, true)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    // NEED_CONTEXT 的 BLOCK 只有一条 Manager 消息，且首部是结构化事件。
    // （此前 claim 事件 + Judge 派发事件各一条，共 4 条。）
    assert.equal(h.managerTexts.length, 4)
    const block = h.managerTexts.at(-1)!
    assert.ok(block.startsWith('[node-event]'))
    assert.match(block, /phase=checking/)
    assert.match(block, /judgment=NEED_CONTEXT need more logs/)
    assert.match(block, /blockReason=Judge NEED_CONTEXT: need more logs/)
    assert.ok(block.includes('Workflow BLOCK:'))
  } finally { h.close() }
})

test('#203 推送失败不阻断主流程（best-effort 降级轮询）', async () => {
  const h = harness({ steerFailsOnEvent: true })
  try {
    // 首节点必须是 manager 角色：先 ACCEPT 首节点，worker 后继派发时事件推送全炸。
    await h.engine.startRun('ws', h.engine.buildInitialRun('manager', 'test', config, 'hash'))
    const first = await h.row()
    const manager = h.caller(first.execution.dispatch!)
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
    await h.engine.handleTurnEnded('ws', manager)
    const checking = await h.row()
    const judge = h.caller(checking.execution.judge!)
    assert.equal((await h.engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    const row = await h.row()
    // 事件推送全炸，节点推进本身不受影响：worker 后继仍在 working，Manager 可降级轮询 status。
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.nodeId, 'job')
    assert.equal(row.execution.phase, 'working')
    assert.ok(h.managerTexts.every(text => !text.startsWith('[node-event]')))
    const status = await h.engine.status('ws')
    assert.equal((status as { ok: boolean }).ok, true)
  } finally { h.close() }
})
