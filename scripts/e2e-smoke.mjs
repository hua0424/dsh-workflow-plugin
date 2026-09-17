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
import { loadCatalogEntry, scanCatalog } from '../src/catalog/loader.ts'
import { authorizeToolCall } from '../src/tools/authz.ts'

const home = mkdtempSync(join(tmpdir(), 'dsh-t4-e2e-'))
const cwd = join(home, 'workspace')
mkdirSync(cwd)
mkdirSync(join(home, 'workflows'))
writeFileSync(join(home, 'workflows', 'smoke-test.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker: { persona: Work only in the isolated workspace. }
judgeRole: { persona: Read-only verification. }
workflow:
  startNode: hello
  returns: [delivered]
  nodes:
    hello:
      execution: { type: actor-task, role: manager, instruction: Write the single line "smoke ok" into result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: result.txt holds exactly the single line "smoke ok". } }
      results:
        succeeded: { criteria: result.txt holds exactly the single line "smoke ok"., target: { node: worker-echo } }
    worker-echo:
      execution: { type: actor-task, role: worker, instruction: Append the single line "worker ok" to result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: 'result.txt holds "smoke ok" then "worker ok", exactly two lines.' } }
      results:
        succeeded: { criteria: 'result.txt holds "smoke ok" then "worker ok", exactly two lines.', target: { return: delivered } }
        retry: { criteria: The worker line is absent and the artifact needs another attempt., target: { node: worker-echo } }
`)

// #59: a catalog whose persona hand-writes the submission protocol must stay
// loadable/startable (warning diagnostic only).
writeFileSync(join(home, 'workflows', 'warn-persona.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker: { persona: Report only through node_claim. }
judgeRole: { persona: Read-only verification. }
workflow:
  startNode: hello
  returns: [delivered]
  nodes:
    hello:
      execution: { type: actor-task, role: manager, instruction: Say ok. }
      checker: { checkerId: judge.claim-correct, config: { criteria: ok was said. } }
      results:
        succeeded: { criteria: ok was said., target: { return: delivered } }
`)

// #131: real catalog with an explicit Child return (T2). The call layer dispatches no
// model and no Judge; the child's named return maps to the Root business return.
writeFileSync(join(home, 'workflows', 'child-smoke.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker: { persona: Work only in the isolated workspace. }
judgeRole: { persona: Read-only verification. }
workflow:
  startNode: plan
  returns: [delivered]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan the child delegation. }
      checker: { checkerId: judge.claim-correct, config: { criteria: The plan is complete. } }
      results:
        succeeded: { criteria: The plan is complete., target: { node: delegate } }
    delegate:
      execution: { type: child-workflow, workflowId: child-work }
      onReturn: { finished: { return: delivered } }
childWorkflows:
  child-work:
    startNode: work
    returns: [finished]
    nodes:
      work:
        execution: { type: actor-task, role: worker, instruction: Produce the child artifact. }
        checker: { checkerId: judge.claim-correct, config: { criteria: The child artifact exists. } }
        results:
          succeeded: { criteria: The child artifact exists., target: { return: finished } }
`)

// #132: real catalog with a Program node whose PASS/FAIL are unified Targets (T3).
// ERROR never routes automatically: it only BLOCKs, and the Manager's fact
// confirmation advances exactly once without any Judge for the Program.
writeFileSync(join(home, 'workflows', 'program-smoke.yaml'), `schemaVersion: agent-workflow/v3
roles:
  worker: { persona: Work only in the isolated workspace. }
judgeRole: { persona: Read-only verification. }
workflow:
  startNode: plan
  returns: [delivered, reopened]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan the milestone check. }
      checker: { checkerId: judge.claim-correct, config: { criteria: The plan is complete. } }
      results:
        succeeded: { criteria: The plan is complete., target: { node: check } }
    check:
      execution: { type: builtin-program, programId: github.all-milestone-issues-complete, instruction: Check the milestone. }
      results:
        PASS: { criteria: The program reported the milestone complete., target: { node: confirm } }
        FAIL: { criteria: The program reported the milestone incomplete., target: { return: reopened } }
    confirm:
      execution: { type: actor-task, role: manager, instruction: Record the confirmed Program result. }
      checker: { checkerId: judge.claim-correct, config: { criteria: The confirmed result is recorded. } }
      results:
        succeeded: { criteria: The confirmed result is recorded., target: { return: delivered } }
`)

let store = new StateStore(home)
try {
  const ws = await workspaceKeyOf(cwd)
  assert.ok(ws)
  const entry = await loadCatalogEntry(home, 'smoke-test')
  assert.ok(entry)

  // #59: warned catalog is an ordinary entry; only its diagnostic severity differs.
  const warned = await loadCatalogEntry(home, 'warn-persona')
  assert.ok(warned, '#59: persona 协议关键词只警告、不阻止加载')
  assert.equal(warned.config.roles.worker.persona, 'Report only through node_claim.')
  const catalog = await scanCatalog(home)
  assert.deepEqual(catalog.entries.map(e => e.workflowId), ['child-smoke', 'program-smoke', 'smoke-test', 'warn-persona'])
  assert.deepEqual(catalog.diagnostics.map(d => [d.workflowId, d.severity, /node_claim/.test(d.reason)]), [['warn-persona', 'warning', true]])

  let sequence = 0
  let actorSerial = 0
  let programScript = async () => { throw new Error('no Program in this smoke') }
  const programCalls = []
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
  }, {
    async run(_run, programId, parameters) {
      programCalls.push({ programId, parameters: structuredClone(parameters) })
      return programScript(parameters)
    },
  }, makeStateHost(() => store))
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
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'wrote wrong result' }, caller(current.execution.dispatch))).ok, true)
  const firstJudge = await settleActorAndJudge('REJECT', 'existing criteria requires exactly smoke ok')
  current = await row()
  assert.equal(current.execution.executionId, firstExecutionId)
  assert.match(actorPrompts.at(-1).text, /existing criteria requires exactly smoke ok/)
  assert.match(actorPrompts.at(-1).text, /wrote wrong result/)
  assert.equal((await engine.handleJudgeClaim(ws, current.execution.nodeToken, 'ACCEPT', 'late old verdict', firstJudge)).ok, false)

  writeFileSync(join(cwd, 'result.txt'), 'smoke ok\n')
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'wrote smoke ok' }, caller(current.execution.dispatch))).ok, true)
  const helloAccepted = await settleActorAndJudge('ACCEPT', 'content matches criteria')
  await engine.handleTurnEnded(ws, helloAccepted)
  current = await row()
  assert.equal(current.execution.nodeId, 'worker-echo')
  assert.equal(current.execution.input, 'wrote smoke ok')

  const failedHandoff = 'rework: append the exact line worker ok'
  const releasedWorkerCaller = caller(current.execution.dispatch)
  assert.equal((await engine.handleClaim(ws, { result: 'retry', handoff: failedHandoff }, releasedWorkerCaller)).ok, true)
  const failureAccepted = await settleActorAndJudge('ACCEPT', 'honest failure; worker line is absent')
  await engine.handleTurnEnded(ws, failureAccepted)
  current = await row()
  assert.equal(current.execution.nodeId, 'worker-echo')
  assert.equal(current.execution.input, failedHandoff)
  assert.deepEqual(drained, ['worker-1'], '离开节点先 drain 被释放的 Role 会话')
  assert.deepEqual(compacts, [], 'reuse: node 全程不做节点边界 compact')
  assert.equal(current.run.roleActors.worker, 'worker-2', '回边重入同一节点得到全新 child 会话')
  assert.equal(current.execution.dispatch.sessionId, 'worker-2')
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'stale worker-1 claim' }, releasedWorkerCaller)).ok, false,
    '旧会话随映射删除失权：worker-1 的迟到 claim 不被接受')
  assert.equal(authorizeToolCall({
    run: current.run, sessionId: 'worker-1', knownRoleOfSession: 'worker', isJudgeSession: false, toolName: 'node_claim',
  }).allow, false, '映射已删除：worker-1 不再持有 workflow 工具授权（authz 精确比对 roleActors）')

  writeFileSync(join(cwd, 'result.txt'), 'smoke ok\nwrong worker\n')
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'appended wrong worker line' }, caller(current.execution.dispatch))).ok, true)
  await settleActorAndJudge('REJECT', 'existing criteria requires the exact worker ok line')
  current = await row()
  assert.match(actorPrompts.at(-1).text, /appended wrong worker line/)
  assert.deepEqual(compacts, [], 'same-execution correction must not compact')
  assert.deepEqual(drained, ['worker-1'], '节点内修正不离开节点，会话不释放')

  writeFileSync(join(cwd, 'result.txt'), 'smoke ok\nworker ok\n')
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'final verified result.txt' }, caller(current.execution.dispatch))).ok, true)
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

  // #131: 真实 catalog 的 Child 显式返回：调用层不派模型/Judge，子流程返回经 onReturn
  // 映射到 Root 业务终局，重开后返回链与终局仍在。
  const childEntry = await loadCatalogEntry(home, 'child-smoke')
  assert.ok(childEntry, '#131: Child 调用 catalog 可加载')
  const judgesBefore = judgePackets.length
  assert.equal((await engine.startRun(ws, engine.buildInitialRun('manager', 'child-smoke', childEntry.config, childEntry.definitionHash), childEntry.path, 'child smoke request')).ok, true)
  let childRow = await row()
  assert.equal(childRow.execution.nodeId, 'plan')
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'plan ok' }, caller(childRow.execution.dispatch))).ok, true)
  await engine.handleTurnEnded(ws, caller(childRow.execution.dispatch))
  const planJudge = caller((await row()).execution.judge)
  assert.equal((await engine.handleJudgeClaim(ws, (await row()).execution.nodeToken, 'ACCEPT', 'plan verified', planJudge)).ok, true)
  await engine.handleTurnEnded(ws, planJudge)
  childRow = await row()
  assert.equal(childRow.execution.workflowId, 'child-work', '#131: 调用层直接进入子流程起点')
  assert.equal(childRow.run.callStack.length, 2)
  const callerExecutionId = childRow.run.callStack[0].executionId
  const callerMaterials = await store.execution(ws, callerExecutionId)
  assert.equal(callerMaterials.dispatch, undefined, '#131: 调用层不被派发（无额外模型/Judge）')
  assert.equal(callerMaterials.judge, undefined)
  assert.equal(callerMaterials.child.executionId, childRow.execution.executionId)
  assert.equal(judgePackets.length, judgesBefore + 1, '#131: 至此只有子节点派了 Judge')

  const leafExecutionId = childRow.execution.executionId
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'child artifact' }, caller(childRow.execution.dispatch))).ok, true)
  await engine.handleTurnEnded(ws, caller(childRow.execution.dispatch))
  const childJudge = caller((await row()).execution.judge)
  assert.equal((await engine.handleJudgeClaim(ws, (await row()).execution.nodeToken, 'ACCEPT', 'child artifact verified', childJudge)).ok, true)
  await engine.handleTurnEnded(ws, childJudge)
  childRow = await row()
  assert.equal(childRow.run.status, 'completed', '#131: 子流程返回经 onReturn 映射到 Root 业务终局')
  assert.deepEqual(childRow.run.callStack, [])
  assert.equal(childRow.execution.nodeId, 'delegate')
  assert.deepEqual(childRow.run.businessReturn, { name: 'delivered', source: childRow.execution.executionId })
  assert.deepEqual(childRow.execution.returned, { kind: 'return', name: 'delivered', source: childRow.execution.executionId })
  assert.equal(judgePackets.length, judgesBefore + 2, '#131: 包装层不多派 Judge')

  const mappedCaller = await store.execution(ws, callerExecutionId)
  assert.deepEqual(mappedCaller.child.result, { terminalExecutionId: leafExecutionId, handoff: 'child artifact' })
  assert.deepEqual(mappedCaller.returned, { kind: 'return', name: 'delivered', source: callerExecutionId })
  const childEvents = await store.events(ws, callerExecutionId)
  assert.equal(childEvents.filter(event => event.type === 'child-entered').length, 1)
  assert.equal(childEvents.filter(event => event.type === 'child-returned').length, 1)

  store.close(); store = new StateStore(home)
  assert.deepEqual((await store.get(ws)).run.businessReturn, { name: 'delivered', source: childRow.execution.executionId })

  // #132: 真实 catalog 的 Program 统一目标路由：ERROR 只 BLOCK（保留参数、不创建后继、
  // 不给 Program 派 Judge），Manager 用 node_resolve_program 事实确认后恰好推进一次，
  // 后继的控制上下文由插件给出 PASS，最终走 Actor 节点到 Root 业务终局。
  const programEntry = await loadCatalogEntry(home, 'program-smoke')
  assert.ok(programEntry, '#132: Program catalog 可加载')
  const judgesBeforeProgram = judgePackets.length
  assert.equal((await engine.startRun(ws, engine.buildInitialRun('manager', 'program-smoke', programEntry.config, programEntry.definitionHash), programEntry.path, 'program smoke request')).ok, true)
  let programRow = await row()
  assert.equal(programRow.execution.nodeId, 'plan')
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'program plan ok' }, caller(programRow.execution.dispatch))).ok, true)
  await engine.handleTurnEnded(ws, caller(programRow.execution.dispatch))
  const programPlanJudge = caller((await row()).execution.judge)
  assert.equal((await engine.handleJudgeClaim(ws, (await row()).execution.nodeToken, 'ACCEPT', 'plan verified', programPlanJudge)).ok, true)
  await engine.handleTurnEnded(ws, programPlanJudge)
  programRow = await row()
  assert.equal(programRow.execution.nodeId, 'check')
  assert.equal(programRow.execution.phase, 'ready')
  assert.match(actorPrompts.at(-1).text, /\[program\]\ngithub\.all-milestone-issues-complete\n请调用 node_run_program/)
  const programExecutionId = programRow.execution.executionId

  programScript = async () => ({ kind: 'ERROR', reason: 'milestone state is uncertain' })
  assert.equal((await engine.handleRunProgram(ws, programRow.execution.nodeToken, { milestoneNumber: 8 }, 'manager')).ok, true)
  programRow = await row()
  assert.equal(programRow.run.status, 'blocked', '#132: ERROR 只 BLOCK，不默认走任一业务边')
  assert.equal(programRow.execution.nodeId, 'check')
  assert.equal(programRow.execution.successorId, undefined, '#132: 异常不创建后继')
  assert.deepEqual(programRow.execution.program.parameters, { milestoneNumber: 8 }, '#132: 参数材料保留')
  assert.deepEqual(programCalls.at(-1), { programId: 'github.all-milestone-issues-complete', parameters: { milestoneNumber: 8 } })
  assert.equal(judgePackets.length, judgesBeforeProgram + 1, '#132: Program 异常不引入 Judge')

  assert.equal((await engine.handleResolveProgram(ws, programRow.execution.nodeToken, 'PASS', 'Manager verified the milestone state', 'manager')).ok, true)
  programRow = await row()
  assert.equal(programRow.run.status, 'running')
  assert.equal(programRow.execution.nodeId, 'confirm', '#132: 事实确认后恰好推进一次')
  assert.equal(programRow.execution.input, 'program plan ok')
  assert.equal((await store.execution(ws, programRow.execution.executionId)).predecessorId, programExecutionId)
  assert.match(actorPrompts.at(-1).text, /\[直接前驱结果\]\n前驱节点 check 已确认结果：PASS（kind: result）/)
  assert.equal(judgePackets.length, judgesBeforeProgram + 1, '#132: 人工确认不引入 Judge')

  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'confirmed program check' }, caller(programRow.execution.dispatch))).ok, true)
  await engine.handleTurnEnded(ws, caller(programRow.execution.dispatch))
  const confirmJudge = caller((await row()).execution.judge)
  assert.equal((await engine.handleJudgeClaim(ws, (await row()).execution.nodeToken, 'ACCEPT', 'recorded', confirmJudge)).ok, true)
  await engine.handleTurnEnded(ws, confirmJudge)
  programRow = await row()
  assert.equal(programRow.run.status, 'completed', '#132: Program PASS → Actor 节点 → Root 返回')
  assert.deepEqual(programRow.run.businessReturn, { name: 'delivered', source: programRow.execution.executionId })
  assert.equal(judgePackets.length, judgesBeforeProgram + 2, '#132: 只有两个 Actor 节点各派一次 Judge')
  store.close(); store = new StateStore(home)
  assert.deepEqual((await store.get(ws)).run.businessReturn, { name: 'delivered', source: programRow.execution.executionId })

  // D-132-02（#133 收口）：同一个真实 catalog 走另一条边——FAIL → { return: reopened }，
  // 使「两类 Target 在真实 catalog 下都有证据」与交付声明一致（不创建后继节点）。
  assert.equal((await engine.startRun(ws, engine.buildInitialRun('manager', 'program-smoke', programEntry.config, programEntry.definitionHash), programEntry.path, 'program fail request')).ok, true)
  programRow = await row()
  assert.equal((await engine.handleClaim(ws, { result: 'succeeded', handoff: 'program plan ok' }, caller(programRow.execution.dispatch))).ok, true)
  await engine.handleTurnEnded(ws, caller(programRow.execution.dispatch))
  const failPlanJudge = caller((await row()).execution.judge)
  assert.equal((await engine.handleJudgeClaim(ws, (await row()).execution.nodeToken, 'ACCEPT', 'plan verified', failPlanJudge)).ok, true)
  await engine.handleTurnEnded(ws, failPlanJudge)
  programRow = await row()
  assert.equal(programRow.execution.nodeId, 'check')
  const failExecutionId = programRow.execution.executionId
  programScript = async () => ({ kind: 'FAIL', reason: 'milestone 8 still has open issues', handoff: 'milestone 8 incomplete' })
  assert.equal((await engine.handleRunProgram(ws, programRow.execution.nodeToken, { milestoneNumber: 8 }, 'manager')).ok, true)
  programRow = await row()
  assert.equal(programRow.run.status, 'completed', '#132: FAIL 直接路由到 Root 返回')
  assert.equal(programRow.execution.executionId, failExecutionId, '#132: 终局工作单仍是 Program 自己')
  assert.equal((await store.execution(ws, failExecutionId)).successorId, undefined, '#132: 返回目标不创建后继节点')
  assert.deepEqual((await store.execution(ws, failExecutionId)).returned, { kind: 'return', name: 'reopened', source: failExecutionId })
  assert.deepEqual(programRow.run.businessReturn, { name: 'reopened', source: failExecutionId })
  assert.match(actorPrompts.at(-1).text, /业务终局：reopened/)
  store.close(); store = new StateStore(home)
  assert.deepEqual((await store.get(ws)).run.businessReturn, { name: 'reopened', source: failExecutionId })

  console.log('E2E SMOKE PASS: REJECT correction + retry result self-loop + node-level Role reuse (drain on leave + fresh re-entry) + final ACCEPT + SQLite reopen + #59 warned-persona catalog loadable + #131 Child explicit return mapped to the Root business return + #132 Program ERROR BLOCK/manual resolution advancing exactly once to a Root return + #132 Program FAIL routed to a Root business return (#133)')
} finally {
  store.close()
  rmSync(home, { recursive: true, force: true })
}
