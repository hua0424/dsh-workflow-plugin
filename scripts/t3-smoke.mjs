/** T3 隔离烟测（受控 Host，不代表真实 DSH 宿主 E2E）：
 * 真实 Catalog/Runtime/SQLite + 显式 `reuse: continuable` 的 Role —— 覆盖 e2e-smoke
 * 不覆盖的那一半角色生命周期：Manager 节点 → Role 跨节点复用（节点边界 compact）
 * → END → SQLite 关库重开；e2e-smoke.mjs 覆盖缺省 `reuse: node` 的 REJECT 修正、
 * failed onFail 自环、离开节点 drain 与新 visit 新会话。两者合起来是 `pnpm run test:smoke`。
 * 全部使用独立临时 home，绝不读写真实 ~/.dsh；Adapter 必须跟随当前 Host 合同
 * （`safeToInspect` 返回 'safe'|'unsafe'，不是 boolean——旧 boolean 断言会把
 * continuable 复用误判成 "Judge/known tools not safely closed" 的假失败）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore, workspaceKeyOf } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { loadCatalogEntry } from '../src/catalog/loader.ts'

const home = mkdtempSync(join(tmpdir(), 'workflow-t3-smoke-'))
const cwd = join(home, 'workspace')
mkdirSync(cwd)
mkdirSync(join(home, 'workflows'))
writeFileSync(join(home, 'workflows', 'smoke.yaml'), `schemaVersion: agent-workflow/v2
roles:
  worker: { persona: Work only on the isolated artifact., reuse: continuable }
judgeRole: { persona: Read only verification. }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Create plan.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: plan.txt is present and correct. } }
      onPass: work
    work:
      execution: { type: actor-task, role: worker, instruction: Create result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: result.txt is present and correct. } }
      onPass: finish
    finish:
      execution: { type: actor-task, role: worker, instruction: Final delivery. }
      checker: { checkerId: judge.claim-correct, config: { criteria: final handoff identifies result.txt. } }
      onPass: END
`)
let store = new StateStore(home)
try {
  const ws = await workspaceKeyOf(cwd)
  const entry = await loadCatalogEntry(home, 'smoke')
  assert.ok(entry)
  let sequence = 0
  let compacts = 0
  let rolesCreated = 0
  const packets = []
  const actorInputs = []
  const send = text => { actorInputs.push(text); return { messageId: `smoke-message-${++sequence}` } }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send(text) },
    async sendRoleActor(_run, _role, text) { return send(text) },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) { rolesCreated++; return { ...send(text), childId: 'worker' } },
    async startJudge(_run, input) { packets.push(input); return { judgeSessionId: input.judgeSessionId, messageId: `smoke-message-${++sequence}` } },
    async retireJudge() {}, async safeToInspect() { return 'safe' },
    async compactRoleActor() { compacts++; return { ok: true, detail: 'controlled no-op' } },
  }, {}, makeStateHost(store))
  engine.cwdResolver = async () => cwd
  const run = engine.buildInitialRun('manager', 'smoke', entry.config, entry.definitionHash)
  assert.equal((await engine.startRun(ws, run, undefined, 'isolated smoke request')).ok, true)
  const caller = d => ({ sessionId: d.sessionId, turnUserMessageIds: new Set([d.messageId]) })
  for (const [index, handoff] of ['plan.txt', 'result.txt', 'final result.txt'].entries()) {
    const row = await store.get(ws)
    if (index === 0) writeFileSync(join(cwd, 'plan.txt'), 'plan ok')
    if (index === 1) writeFileSync(join(cwd, 'result.txt'), 'result ok')
    const actor = caller(row.execution.dispatch)
    assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff }, actor)).ok, true)
    assert.equal(packets.length, index, 'claim must wait for Actor settlement')
    await engine.handleTurnEnded(ws, actor)
    assert.equal(readFileSync(join(cwd, index === 0 ? 'plan.txt' : 'result.txt'), 'utf8'), index === 0 ? 'plan ok' : 'result ok')
    assert.equal(packets[index].claim.handoff, handoff)
    const checking = await store.get(ws)
    const judge = caller(checking.execution.judge)
    assert.equal((await engine.handleJudgeClaim(ws, checking.execution.nodeToken, 'ACCEPT', 'isolated artifact verified', judge)).ok, true)
    await engine.handleTurnEnded(ws, judge)
  }
  assert.equal(rolesCreated, 1)
  assert.equal(compacts, 1)
  const completed = await store.get(ws)
  const finalId = completed.execution.executionId
  assert.equal(completed.run.status, 'completed')
  assert.equal(completed.execution.claim.handoff, 'final result.txt')
  store.close(); store = new StateStore(home)
  assert.equal((await store.get(ws)).execution.claim.handoff, 'final result.txt')
  assert.deepEqual((await store.events(ws, finalId)).map(e => e.type), ['entered', 'actor-arranged', 'claim', 'judge-arranged', 'judgment', 'exited'])
  console.log('T3 ISOLATED SMOKE PASS: Catalog → Actor → safe settlement → Judge ACCEPT → reused Role/compact → END → SQLite reopen')
} finally {
  store.close()
  rmSync(home, { recursive: true, force: true })
}
