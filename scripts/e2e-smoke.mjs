/**
 * T4 isolated smoke: real Catalog + WorkflowEngine + SQLite, controlled Host only.
 * It never reads or writes the real DSH home/workspace and is not a real-host Run.
 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { StateStore, workspaceKeyOf } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { loadCatalogEntry } from '../src/catalog/loader.ts'
import { authorizeToolCall } from '../src/tools/authz.ts'

const home = mkdtempSync(join(tmpdir(), 'dsh-t4-e2e-'))
const cwd = join(home, 'workspace')
mkdirSync(cwd)
mkdirSync(join(home, 'workflows'))
writeFileSync(join(home, 'workflows', 'smoke-test.yaml'), `schemaVersion: agent-workflow/v2
roles:
  worker: { persona: Work only in the isolated workspace. }
judgeRole: { persona: Read-only verification. }
workflow:
  startNode: hello
  nodes:
    hello:
      execution: { type: actor-task, role: manager, instruction: Write the single line "smoke ok" into result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: result.txt holds exactly the single line "smoke ok". } }
      onPass: worker-echo
    worker-echo:
      execution: { type: actor-task, role: worker, instruction: Append the single line "worker ok" to result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: result.txt holds "smoke ok" then "worker ok", exactly two lines. } }
      onPass: END
      onFail: worker-echo
`)

let store = new StateStore(home)
try {
  const ws = await workspaceKeyOf(cwd)
  assert.ok(ws)
  const entry = await loadCatalogEntry(home, 'smoke-test')
  assert.ok(entry)

  let sequence = 0
  let actorSerial = 0
  const actorPrompts = []
  const judgePackets = []
  const compacts = []
  const drained = []
  const send = (sessionId, text) => {
    const messageId = `message-${++sequence}`
    actorPrompts.push({ sessionId, messageId, text })
    return { messageId }
  }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(run, role, text) { return send(run.roleActors[role], text) },
    managerSessionSeq() { return 0 },
  }, {
    // 缺省 `reuse: node`：每次 fresh spawn 都是新 child，回边重入必须可区分。
    async ensureRoleActor(_run, _role, text) { const childId = `worker-${++actorSerial}`; return { ...send(childId, text), childId } },
    async startJudge(_run, input) {
      judgePackets.push(structuredClone(input))
      return { judgeSessionId: input.judgeSessionId, messageId: `judge-message-${++sequence}` }
    },
    async followupJudge(_run, sessionId, input) {
      judgePackets.push(structuredClone(input))
      return { messageId: `judge-followup-${sessionId}-${++sequence}` }
    },
    async safeToInspect() { return 'safe' },
    async retireJudge() {}, async drainJudge() {}, async judgeSessionExists() { return true },
    async drainRoleActor(run, role) { drained.push(run.roleActors[role]) },
    async compactRoleActor(_run, role) { compacts.push(role); return { ok: true, detail: 'controlled no-op' } },
  }, { async run() { throw new Error('no Program in this smoke') } }, makeStateHost(store))
  engine.cwdResolver = async () => cwd
  const caller = dispatch => ({ sessionId: dispatch.sessionId, turnUserMessageIds: new Set([dispatch.messageId]) })
  const row = () => store.get(ws)
  async function settleActorAndJudge(result, reason) {
    const claimed = await row()
    const actor = caller(claimed.execution.dispatch)
    await engine.handleTurnEnded(ws, actor)
    const checking = await row()
    const judge = caller(checking.execution.judge)
    assert.equal((await engine.handleJudgeClaim(ws, checking.execution.nodeToken, result, reason, judge)).ok, true)
    return judge
  }

  const run = engine.buildInitialRun('manager', 'smoke-test', entry.config, entry.definitionHash)
  assert.equal((await engine.startRun(ws, run, entry.path, 'isolated request')).ok, true)
  const firstExecutionId = (await row()).execution.executionId

  writeFileSync(join(cwd, 'result.txt'), 'wrong\n')
  let current = await row()
  assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff: 'wrote wrong result' }, caller(current.execution.dispatch))).ok, true)
  const firstJudge = await settleActorAndJudge('REJECT', 'existing criteria requires exactly smoke ok')
  current = await row()
  assert.equal(current.execution.executionId, firstExecutionId)
  assert.match(actorPrompts.at(-1).text, /existing criteria requires exactly smoke ok/)
  assert.match(actorPrompts.at(-1).text, /wrote wrong result/)
  assert.equal((await engine.handleJudgeClaim(ws, current.execution.nodeToken, 'ACCEPT', 'late old verdict', firstJudge)).ok, false)

  writeFileSync(join(cwd, 'result.txt'), 'smoke ok\n')
  assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff: 'wrote smoke ok' }, caller(current.execution.dispatch))).ok, true)
  const helloAccepted = await settleActorAndJudge('ACCEPT', 'content matches criteria')
  await engine.handleTurnEnded(ws, helloAccepted)
  current = await row()
  assert.equal(current.execution.nodeId, 'worker-echo')
  assert.equal(current.execution.input, 'wrote smoke ok')

  const failedHandoff = 'rework: append the exact line worker ok'
  const releasedWorkerCaller = caller(current.execution.dispatch)
  assert.equal((await engine.handleClaim(ws, { outcome: 'failed', handoff: failedHandoff }, releasedWorkerCaller)).ok, true)
  const failureAccepted = await settleActorAndJudge('ACCEPT', 'honest failure; worker line is absent')
  await engine.handleTurnEnded(ws, failureAccepted)
  current = await row()
  assert.equal(current.execution.nodeId, 'worker-echo')
  assert.equal(current.execution.input, failedHandoff)
  assert.deepEqual(drained, ['worker-1'], '离开节点先 drain 被释放的 Role 会话')
  assert.deepEqual(compacts, [], 'reuse: node 全程不做节点边界 compact')
  assert.equal(current.run.roleActors.worker, 'worker-2', '回边重入同一节点得到全新 child 会话')
  assert.equal(current.execution.dispatch.sessionId, 'worker-2')
  assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff: 'stale worker-1 claim' }, releasedWorkerCaller)).ok, false,
    '旧会话随映射删除失权：worker-1 的迟到 claim 不被接受')
  assert.equal(authorizeToolCall({
    run: current.run, sessionId: 'worker-1', knownRoleOfSession: 'worker', isJudgeSession: false, toolName: 'node_claim',
  }).allow, false, '映射已删除：worker-1 不再持有 workflow 工具授权（authz 精确比对 roleActors）')

  writeFileSync(join(cwd, 'result.txt'), 'smoke ok\nwrong worker\n')
  assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff: 'appended wrong worker line' }, caller(current.execution.dispatch))).ok, true)
  await settleActorAndJudge('REJECT', 'existing criteria requires the exact worker ok line')
  current = await row()
  assert.match(actorPrompts.at(-1).text, /appended wrong worker line/)
  assert.deepEqual(compacts, [], 'same-execution correction must not compact')
  assert.deepEqual(drained, ['worker-1'], '节点内修正不离开节点，会话不释放')

  writeFileSync(join(cwd, 'result.txt'), 'smoke ok\nworker ok\n')
  assert.equal((await engine.handleClaim(ws, { outcome: 'completed', handoff: 'final verified result.txt' }, caller(current.execution.dispatch))).ok, true)
  await settleActorAndJudge('ACCEPT', 'content matches criteria')
  current = await row()
  assert.equal(current.run.status, 'completed')
  assert.equal(current.execution.claim.handoff, 'final verified result.txt')

  const firstHistory = await store.events(ws, firstExecutionId)
  assert.equal(firstHistory.filter(event => event.type === 'claim').length, 2)
  assert.equal(firstHistory.filter(event => event.type === 'judgment').length, 2)
  const rejected = firstHistory.find(event => event.type === 'judgment' && event.snapshot.judgment?.result === 'REJECT')
  assert.equal(rejected.snapshot.previousClaim.handoff, 'wrote wrong result')

  const finalExecutionId = current.execution.executionId
  store.close(); store = new StateStore(home)
  assert.equal((await store.get(ws)).execution.claim.handoff, 'final verified result.txt')
  assert.ok((await store.events(ws, finalExecutionId)).some(event => event.type === 'judgment'))

  const logDir = join(dirname(entry.path), 'smoke-test')
  const logs = readdirSync(logDir).filter(name => name.endsWith('.txt'))
  assert.equal(logs.length, 1)
  const trace = readFileSync(join(logDir, logs[0]), 'utf8')
  for (const marker of [' START ', ' CLAIM ', ' JUDGE ', ' result=REJECT ', ' result=ACCEPT ', ' ROUTE ']) assert.match(trace, new RegExp(marker))

  console.log('E2E SMOKE PASS: REJECT correction + failed onFail self-loop + node-level Role reuse (drain on leave + fresh re-entry) + final ACCEPT + SQLite reopen')
} finally {
  store.close()
  rmSync(home, { recursive: true, force: true })
}
