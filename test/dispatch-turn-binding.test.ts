/**
 * Issue #139 验收：Actor 跨 turn 等待后台子代理后，派发绑定不断裂。
 *
 * 故障回放：派发 turn（含派发消息 `u-dispatch`）被后台子代理结算通知关闭，
 * 会话进入新 turn（只有 `u-settle-notice`）。旧语义下新 turn 的严格消息集
 * 不再包含派发 ID → `node_claim` 被拒、`node_block` 被拒、`handleTurnEnded`
 * 静默 return，节点永久滞留 working。
 *
 * 新语义：调用方同时携带会话血统（up-to-call 的累积 `user/message` 集）；
 * 严格集或血统集命中其一即绑定。以下用例直接构造跨 turn caller（与工具层
 * 快照等价：`claimCallerOf` / `session/event` 捕获点的成品形状），分别钉住
 * 收口、可见 BLOCK、跨会话/陈旧快照仍被拒，以及 #54 waiting 语义不受影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaimCaller } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'workflow-139-'))
  const store = new StateStore(home)
  const messages: string[] = []
  let safety: 'safe' | 'waiting' | 'unsafe' = 'safe'
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { messages.push(text); return { messageId: 'actor-message-1' } },
    async sendRoleActor() { throw new Error('not expected') },
    managerSessionSeq() { return 0 },
  }, {
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'judge-message-1' } },
    async safeToInspect() { return safety },
  }, {}, makeStateHost(store))
  engine.cwdResolver = async () => home
  const config = {
    schemaVersion: 'agent-workflow/v3' as const, roles: {}, judgeRole: { persona: 'Read only' },
    workflow: { startNode: 'plan', returns: ['done'], nodes: { plan: {
      execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Plan' },
      checker: { checkerId: 'judge.claim-correct', config: { criteria: 'Correct plan' } },
      results: { succeeded: { criteria: 'The plan is complete.', target: { return: 'done' } } },
    } } },
  }
  return {
    home, store, engine, messages,
    setSafety(value: 'safe' | 'waiting' | 'unsafe') { safety = value },
    async start() {
      const run = engine.buildInitialRun('manager', 'test', config, 'hash')
      assert.equal((await engine.startRun('ws', run, undefined, 'root request')).ok, true)
      const dispatch = (await store.get('ws'))!.execution.dispatch!
      assert.ok(dispatch.sessionId && dispatch.messageId)
      const strict: ClaimCaller = { sessionId: dispatch.sessionId, turnUserMessageIds: new Set([dispatch.messageId]) }
      // 后台子代理结算通知推进出的新 turn：严格集只有通知，血统集保留派发 ID。
      const crossTurn: ClaimCaller = {
        sessionId: dispatch.sessionId,
        turnUserMessageIds: new Set(['u-settle-notice']),
        sessionUserMessageIds: new Set([dispatch.messageId, 'u-settle-notice']),
      }
      return { dispatch, strict, crossTurn }
    },
    async row() { return (await store.get('ws'))! },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

test('#139 跨 turn caller 仍可 node_claim（血统命中），不再滞留 working', async () => {
  const h = harness()
  try {
    const { crossTurn } = await h.start()
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'review artifact' }, crossTurn)).ok, true)
    assert.equal((await h.row()).execution.phase, 'checking')
  } finally { h.close() }
})

test('#139 跨 turn 空回合触发可见 BLOCK + Manager 通知（不静默滞留）', async () => {
  const h = harness()
  try {
    const { crossTurn } = await h.start()
    await h.engine.handleTurnEnded('ws', crossTurn)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.blockReason, 'actor-turn-ended-without-result')
    assert.equal(h.messages.at(-1), `Workflow BLOCK: actor-turn-ended-without-result\n材料已保存；Manager 可查看 status 后选择恢复目标。`)
  } finally { h.close() }
})

test('#139 跨会话 caller 即使血统含派发 ID 仍被拒，且不触发 BLOCK', async () => {
  const h = harness()
  try {
    const { dispatch, crossTurn } = await h.start()
    const forged: ClaimCaller = { ...crossTurn, sessionId: 'attacker-session' }
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'x' }, forged)).ok, false)
    await h.engine.handleTurnEnded('ws', forged)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.blockReason, null)
    assert.equal(dispatch.sessionId === forged.sessionId, false)
  } finally { h.close() }
})

test('#139 陈旧快照（血统早于本次派发）仍被拒：同会话旧 visit 不能认领新派发', async () => {
  const h = harness()
  try {
    const { dispatch } = await h.start()
    const stale: ClaimCaller = {
      sessionId: dispatch.sessionId!,
      turnUserMessageIds: new Set(['u-old-dispatch']),
      sessionUserMessageIds: new Set(['u-old-dispatch']),
    }
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'stale' }, stale)).ok, false)
    await h.engine.handleTurnEnded('ws', stale)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.phase, 'working')
  } finally { h.close() }
})

test('#139 跨 turn caller 可 node_block 自救（非控制者路径不再 unbound dispatch）', async () => {
  const h = harness()
  try {
    const { crossTurn } = await h.start()
    const row = await h.row()
    assert.equal((await h.engine.handleBlock('ws', row.execution.nodeToken, 'actor observed a conflict', crossTurn)).ok, true)
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.blockReason, 'actor observed a conflict')
  } finally { h.close() }
})

test('#139 #54 waiting 语义保留：子代理仍在跑时跨 turn 空回合不 BLOCK、不结算', async () => {
  const h = harness()
  try {
    const { crossTurn } = await h.start()
    h.setSafety('waiting')
    await h.engine.handleTurnEnded('ws', crossTurn)
    const row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.blockReason, null)
    // 等待期间绑定保持：子代理完成后下一回合照常 claim。
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'late artifact' }, crossTurn)).ok, true)
  } finally { h.close() }
})
