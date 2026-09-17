/**
 * T1 (#130) 定向验证：v3 Actor 命名结果、出口验收合同与 Root 终局闭环。
 *
 * 真实 Runtime + 真实临时 SQLite + 受控 Host（只 stub 模型派发）。覆盖本票 AC：
 * - 三出口互斥 Actor：ACCEPT 后各走各自唯一后继，每次只创建一个后继；
 * - 单出口 Actor 显式声明 succeeded，不隐含任何结果；
 * - Actor 初次派发/REJECT 修正/恢复收到同源共同条件 + 全部结果条件；Judge 只拿
 *   共同条件与所选结果条件；
 * - Root 以 manager 起步，Root 业务返回与 Run 生命周期分离，terminated 不制造返回；
 * - 前任直接结果由插件提供、Root 首次派发无伪造前驱；
 * - claim 严格只接受 { result, handoff }：未知结果/旧字段/非法 handoff/非法目标
 *   一律拒绝且不消费资格、不写部分状态；
 * - 静态合同：returns 非空唯一、result 名字与 criteria、Target 恰好一个字段、裸
 *   END 与 v2 配置被拒绝、返回路径可达性；
 * - 旧状态格式库不静默转换（显式不兼容维护路径）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { StateStore, StateAccess, stateDbPath } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, CatalogValidationError } from '../src/catalog/validate.ts'
import type { WorkflowConfig } from '../src/types.ts'

type Config = WorkflowConfig

/**
 * Root 以 manager 起步；三出口 Node 之后各走各自唯一后继（或显式 Root 返回）。
 * `manager` 是保留 roleKey，不进 `roles`。
 */
function reviewConfig(): Config {
  return parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  reviewer: { persona: Review. }
judgeRole: { persona: Read only. }
workflow:
  startNode: review
  returns: [approved, changes-required, disputed, abandoned]
  nodes:
    review:
      execution: { type: actor-task, role: manager, instruction: Report findings. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Report is bound to the reviewed revision. } }
      results:
        approved: { criteria: No open dispute and no required change., target: { return: approved } }
        changes-required: { criteria: No open dispute and a grounded required-change list., target: { node: implement } }
        disputed: { criteria: An evidenced unresolved business dispute., target: { node: adjudicate } }
    implement:
      execution: { type: actor-task, role: reviewer, instruction: Implement. }
      checker: { checkerId: judge.claim-correct }
      results:
        succeeded: { criteria: The required changes are implemented., target: { return: changes-required } }
        abandoned: { criteria: The work cannot proceed., target: { return: abandoned } }
    adjudicate:
      execution: { type: actor-task, role: reviewer, instruction: Adjudicate. }
      checker: { checkerId: judge.claim-correct }
      results:
        succeeded: { criteria: The dispute is resolved., target: { return: disputed } }
`)
}

/** 单出口节点也显式声明，不隐含 completed。 */
function singleExitConfig(): Config {
  return parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: Read only. }
workflow:
  startNode: plan
  returns: [delivered]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: A plan exists. } }
      results:
        succeeded: { criteria: The plan is complete., target: { return: delivered } }
`)
}

function harness(config: Config = reviewConfig()) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-v3-'))
  const store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judges: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  const followups: Array<import('../src/engine/engine.ts').JudgeSpawnInput> = []
  let roleSerial = 0
  let judgeSerial = 0
  const send = (sessionId: string, text: string) => {
    const messageId = `message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text })
    return { messageId }
  }
  const engine = new WorkflowEngine({
    async steerManager(_run, text) { return send('manager', text) },
    async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor(_run, _role, text) { const childId = roleSerial++ === 0 ? 'reviewer-session' : `reviewer-session-${roleSerial}`; return { ...send(childId, text), childId } },
    async startJudge(_run, input) { judges.push(input); return { ...send(input.judgeSessionId, 'Judge'), judgeSessionId: input.judgeSessionId } },
    async followupJudge(_run, judgeSessionId, input) { followups.push(input); return send(judgeSessionId, 'Judge followup') },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async safeToInspect() { return 'safe' as const },
    async retireJudge() {},
    async drainJudge() {},
    async drainRoleActor() {},
    async compactRoleActor() { return { ok: true } },
  }, { async run() { throw new Error('programs are not part of T1') } }, makeStateHost(store))
  engine.cwdResolver = async () => home
  const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return {
    home, store, engine, messages, judges, followups, caller,
    async start(input = 'root request') { return engine.startRun('ws', engine.buildInitialRun('manager', 'review', config, 'hash'), undefined, input) },
    async row() { return (await store.get('ws'))! },
    /** 当前 Actor 提交并等 Actor 收口，返回等待判定的现场。 */
    async claim(result: string, handoff = 'artifact') {
      const actor = caller((await this.row()).execution.dispatch!)
      const claimed = await engine.handleClaim('ws', { result, handoff }, actor)
      assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.reason)
      await engine.handleTurnEnded('ws', actor)
      return this.row()
    },
    /**
     * 对当前 claim 出判定（默认 ACCEPT），并模拟 Judge turn 的正常收口：后继派发只由
     * Judge 的精确、安全 turn settlement 驱动，不在 Judge 自己的提交 turn 内 drain。
     */
    async judge(result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT' = 'ACCEPT', reason = 'verified') {
      const row = await this.row()
      const judge = caller(row.execution.judge!)
      const outcome = await engine.handleJudgeClaim('ws', row.execution.nodeToken, result, reason, judge)
      if (outcome.ok) await engine.handleTurnEnded('ws', judge)
      return outcome
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

// ── A: 三出口互斥路由与 Root 业务终局 ─────────────────────────────────────────

test('v3: each named result routes along its own唯一后继 and Root records the business return', async () => {
  const h = harness()
  try {
    assert.equal((await h.start()).ok, true)
    const root = await h.row()
    assert.equal(root.run.callStack[0]!.nodeId, 'review', 'Root 仍以 manager 起步')

    // approved → { return: approved }：终局工作单承载业务返回名与 handoff 原文
    await h.claim('approved', 'review evidence @ abc123')
    const advanced = await h.judge('ACCEPT', 'bound to abc123; no required change')
    assert.equal(advanced.ok, true)
    const terminal = await h.row()
    assert.equal(terminal.run.status, 'completed')
    assert.equal(terminal.run.callStack.length, 0)
    assert.deepEqual(terminal.run.businessReturn, { name: 'approved', source: terminal.execution.executionId })
    assert.deepEqual(terminal.execution.returned, { kind: 'return', name: 'approved', source: terminal.execution.executionId })
    assert.equal(terminal.execution.claim!.handoff, 'review evidence @ abc123')
    assert.equal(terminal.execution.successorId, undefined, '终局不创建后继')
    // 终局通知携带业务返回名，不把业务终局渲染成交付成功
    assert.match(h.messages.at(-1)!.text, /业务终局：approved/)
  } finally { h.close() }
})

test('v3: changes-required creates exactly one successor node and the predecessor result is plugin-provided', async () => {
  const h = harness()
  try {
    await h.start()
    await h.claim('changes-required', 'required changes list')
    await h.judge('ACCEPT')
    const routed = await h.row()
    assert.equal(routed.run.status, 'running')
    assert.equal(routed.execution.nodeId, 'implement')
    assert.equal(routed.execution.visit, 2)
    assert.equal(routed.execution.input, 'required changes list', 'handoff 原文逐字传递')
    // 每次只创建一个后继：callStack 仍只有 Root 一层，无额外选路 Actor/Judge
    assert.equal(routed.run.callStack.length, 1)
    // 后继派发的控制上下文由插件提供直接前驱结果
    const dispatch = [...h.messages].reverse().find(message => message.text.includes('[直接前驱结果]'))?.text ?? ''
    assert.match(dispatch, /\[直接前驱结果\]\n前驱节点 review 已确认结果：changes-required（kind: result）/)

    // 单出口后继回到 Root 返回名
    await h.claim('succeeded', 'implemented')
    await h.judge('ACCEPT')
    const terminal = await h.row()
    assert.equal(terminal.run.businessReturn!.name, 'changes-required')
    assert.equal(terminal.execution.nodeId, 'implement')
    assert.equal(terminal.execution.claim!.handoff, 'implemented')
  } finally { h.close() }
})

test('v3: Root first dispatch carries no fabricated predecessor result; shared and all result conditions are in the same source', async () => {
  const h = harness()
  try {
    await h.start()
    const prompt = h.messages[0]!.text
    assert.match(prompt, /\[handoff\]\nroot request/)
    assert.doesNotMatch(prompt, /\[直接前驱结果\]/, 'Root 首次派发无前驱结果')
    // 共同条件 + 全部合法结果条件同源于冻结快照
    assert.match(prompt, /\[验收合同·共同条件\]\nReport is bound to the reviewed revision\./)
    assert.match(prompt, /\[合法结果与各自条件\]\n- approved：No open dispute and no required change\./)
    assert.match(prompt, /- changes-required：No open dispute and a grounded required-change list\./)
    assert.match(prompt, /- disputed：An evidenced unresolved business dispute\./)
    assert.match(prompt, /本次只能选择一个结果提交（互斥出口）。/)
    // Judge 只收到共同条件与所选结果条件，不遍历其他出口
    await h.claim('disputed', 'open dispute evidence')
    const packet = h.judges[0]!
    assert.equal(packet.result, 'disputed')
    assert.equal(packet.resultCriteria, 'An evidenced unresolved business dispute.')
    assert.equal(packet.criteria, 'Report is bound to the reviewed revision.')
  } finally { h.close() }
})

test('v3: ACCEPT routes to the node named by the selected result; disputed result has its own successor', async () => {
  const h = harness()
  try {
    await h.start()
    await h.claim('disputed', 'dispute evidence')
    await h.judge('ACCEPT')
    const routed = await h.row()
    assert.equal(routed.execution.nodeId, 'adjudicate')
    assert.equal(routed.execution.returned === undefined, true)
  } finally { h.close() }
})

// ── B: 单出口 Actor 与 Root 生命周期/业务终局分离 ─────────────────────────────

test('v3: a single-exit node declares its result explicitly; reset terminated creates no business return', async () => {
  const h = harness(singleExitConfig())
  try {
    await h.start()
    const prompt = h.messages[0]!.text
    assert.match(prompt, /\[合法结果与各自条件\]\n- succeeded：The plan is complete\./)
    // 合法结果段只列声明结果与条件，不出现 v2 的 completed/failed 双语义
    assert.doesNotMatch(prompt.split('[合法结果与各自条件]')[1]!.split('本次只能选择')[0]!, /completed|failed|outcome/)

    // reset 是控制面终止：status=terminated，不制造业务返回
    const reset = await h.engine.handleReset('ws', true)
    assert.equal(reset.ok, true)
    const terminated = await h.row()
    assert.equal(terminated.run.status, 'terminated')
    assert.equal(terminated.run.businessReturn, undefined)
    assert.equal(terminated.execution.returned, undefined)
  } finally { h.close() }

  // 单出口 ACCEPT → Root 业务返回 delivered
  const h2 = harness(singleExitConfig())
  try {
    await h2.start()
    await h2.claim('succeeded', 'plan artifact')
    await h2.judge('ACCEPT')
    const terminal = await h2.row()
    assert.equal(terminal.run.status, 'completed')
    assert.equal(terminal.run.businessReturn!.name, 'delivered')
    assert.equal(terminal.execution.returned!.kind, 'return')
    assert.equal(terminal.execution.claim!.handoff, 'plan artifact')
  } finally { h2.close() }
})

// ── C: claim 交付合同（未知结果/旧字段/非法 handoff/非法目标） ─────────────────

test('v3: node_claim rejects unknown results and legacy fields before consuming the dispatch or writing state', async () => {
  const h = harness()
  try {
    await h.start()
    const before = await h.row()
    const actor = h.caller(before.execution.dispatch!)

    // 未知结果：不消费资格、不写部分状态
    const unknown = await h.engine.handleClaim('ws', { result: 'ghost', handoff: 'x' }, actor)
    assert.equal(unknown.ok, false)
    assert.match(unknown.ok ? '' : unknown.reason, /unknown result "ghost"; declared results: approved, changes-required, disputed/)
    // 旧协议字段
    for (const legacy of [{ outcome: 'completed', handoff: 'x' }, { result: 'approved', handoff: 'x', outcome: 'completed' }, { result: 'approved', handoff: 'x', exit: 'approved' }]) {
      const rejected = await h.engine.handleClaim('ws', legacy as never, actor)
      assert.equal(rejected.ok, false)
      assert.match(rejected.ok ? '' : rejected.reason, /only accepts result and handoff/)
    }
    // 非法/空/超长 handoff
    const badHandoff = await h.engine.handleClaim('ws', { result: 'approved', handoff: '   ' }, actor)
    assert.equal(badHandoff.ok, false)
    assert.match(badHandoff.ok ? '' : badHandoff.reason, /handoff is required/)
    const tooLong = await h.engine.handleClaim('ws', { result: 'approved', handoff: 'x'.repeat(8001) }, actor)
    assert.equal(tooLong.ok, false)
    assert.match(tooLong.ok ? '' : tooLong.reason, /at most 8000 characters/)

    // 全部拒绝之后承诺资格仍在、状态未变
    const after = await h.row()
    assert.equal(after.stateVersion, before.stateVersion, '非法提交不写部分状态')
    assert.equal(after.execution.phase, 'working')
    assert.equal(after.execution.claim, undefined)

    // 合法提交仍可消费同一资格
    assert.equal((await h.engine.handleClaim('ws', { result: 'approved', handoff: '  ok  ' }, actor)).ok, true)
    const claimed = await h.row()
    assert.deepEqual({ result: claimed.execution.claim!.result, handoff: claimed.execution.claim!.handoff }, { result: 'approved', handoff: 'ok' })
  } finally { h.close() }
})

test('v3: cross-node claims and late duplicate claims are rejected', async () => {
  const h = harness()
  try {
    await h.start()
    await h.claim('changes-required', 'go implement')
    await h.judge('ACCEPT')
    // 跨节点：旧节点资格不得消费新工作单
    const stale = { sessionId: 'reviewer-session', turnUserMessageIds: new Set(['message-1']) }
    const rejected = await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'old work' }, stale)
    assert.equal(rejected.ok, false)
    assert.equal((await h.row()).execution.nodeId, 'implement')
  } finally { h.close() }
})

// ── D: REJECT / NEED_CONTEXT 语义 ────────────────────────────────────────────

test('v3: REJECT stays in the same execution and the Actor may pick another legal result, which must be re-verified', async () => {
  const h = harness()
  try {
    await h.start()
    const first = await h.row()
    await h.claim('approved', 'thin evidence')
    const rejected = await h.judge('REJECT', 'criteria require the reviewed revision')
    assert.equal(rejected.ok, true)
    const afterReject = await h.row()
    assert.equal(afterReject.execution.nodeId, 'review', 'REJECT 不走业务返工边')
    assert.equal(afterReject.execution.executionId, first.execution.executionId)
    assert.equal(afterReject.execution.visit, 1)
    assert.equal(afterReject.run.status, 'running')
    assert.equal(afterReject.execution.phase, 'working')
    // 旧 claim 归档、新派发携带旧 claim 与 Judge 反馈
    assert.equal(afterReject.execution.previousClaim!.result, 'approved')
    const correction = h.messages.at(-1)!.text
    assert.match(correction, /\[最近 Judge REJECT 与旧 claim\]/)
    assert.match(correction, /result: approved/)
    assert.match(correction, /\[合法结果与各自条件\]/)

    // 改选另一个合法结果 → 必须重新核验，不能沿原边偷跑
    await h.claim('disputed', 'dispute with evidence')
    assert.equal((await h.row()).run.status, 'running')
    const second = h.judges.at(-1)!
    assert.equal(second.result, 'disputed')
    assert.equal(second.previousFeedback!.result, 'REJECT')
    await h.judge('ACCEPT')
    assert.equal((await h.row()).execution.nodeId, 'adjudicate')
  } finally { h.close() }
})

test('v3: NEED_CONTEXT keeps the claim and a resume re-verifies it', async () => {
  const h = harness()
  try {
    await h.start()
    await h.claim('approved', 'needs facts')
    await h.judge('NEED_CONTEXT', 'need the approved scope decision')
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal(blocked.execution.claim!.result, 'approved', 'NEED_CONTEXT 保留 claim')
    assert.equal(blocked.execution.phase, 'checking')

    const resumed = await h.engine.handleResume('ws', blocked.execution.nodeToken, 'scope decision: revision abc123', 'manager', 'judge')
    assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.reason)
    const recheck = h.followups.at(-1) ?? h.judges.at(-1)!
    assert.equal(recheck.result, 'approved')
    assert.equal(recheck.managerContext, 'scope decision: revision abc123')
    assert.equal(recheck.resultCriteria, 'No open dispute and no required change.')
  } finally { h.close() }
})

// ── E: 静态合同（A01/A08 的 Actor/Root 子集） ────────────────────────────────

test('v3 schema rejects v2 configs, legacy Actor fields and bare END targets', () => {
  assert.throws(() => parseCatalogConfig('schemaVersion: agent-workflow/v2\nroles: {}\njudgeRole: {persona: J}\nworkflow: {startNode: x, returns: [a], nodes: {}}'), /schemaVersion/)
  assert.throws(() => parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct }
      onPass: END
`), /onPass/)
  assert.throws(() => parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct }
      results:
        succeeded: { criteria: ok, target: END }
`), /target/)
})

test('v3 静态校验：returns 非空唯一、结果条件必填、Target 恰好一个字段、返回路径可达', () => {
  const base = (nodes: string, returns = '[done]') => parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: ${returns}
  nodes:
${nodes}
`)
  const plan = (results: string) => `    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct }
      results:
${results}
`
  // 空 returns 被 schema 拒绝
  assert.throws(() => base(plan('        succeeded: { criteria: ok, target: { return: done } }'), '[]'), /returns/)
  // 重复返回名
  assert.throws(() => validateAndNormalize(base(plan('        succeeded: { criteria: ok, target: { return: done } }'), '[done, done]'), { workflowId: 'w' }), CatalogValidationError, /duplicate returns/)
  // 未声明的返回名
  assert.throws(() => validateAndNormalize(base(plan('        succeeded: { criteria: ok, target: { return: ghost } }')), { workflowId: 'w' }), CatalogValidationError, /target return "ghost" is not declared/)
  // 不存在的节点目标
  assert.throws(() => validateAndNormalize(base(plan('        succeeded: { criteria: ok, target: { node: ghost } }')), { workflowId: 'w' }), CatalogValidationError, /target node "ghost" does not exist/)
  // 结果名非法（大写）——严格 record 键规则拒绝，issues 路径点名非法键
  assert.throws(
    () => base(plan('        Succeeded: { criteria: ok, target: { return: done } }')),
    (error: unknown) => JSON.stringify((error as { issues?: unknown }).issues ?? []).includes('Succeeded'),
  )
  // returns 声明了但没有结构可达的返回路径
  assert.throws(() => validateAndNormalize(base(plan('        succeeded: { criteria: ok, target: { node: plan } }')), { workflowId: 'w' }), CatalogValidationError, /no structurally reachable return path/)
  // 空 criteria
  assert.throws(() => validateAndNormalize(base(plan('        succeeded: { criteria: "  ", target: { return: done } }')), { workflowId: 'w' }), /criteria/)
  // 同时给 node + return（strict 拒绝）
  assert.throws(() => base(plan('        succeeded: { criteria: ok, target: { node: plan, return: done } }')), /target/)
  // 合法的 returns + 多出口可通过
  const ok = validateAndNormalize(reviewConfig(), { workflowId: 'review' })
  assert.deepEqual(ok.workflow.returns, ['approved', 'changes-required', 'disputed', 'abandoned'])
})

test('v3: 未接通的 Child 执行路径在 catalog 校验期被明确拒绝（T2 接通）', () => {
  assert.throws(() => validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct }
      results:
        succeeded: { criteria: ok, target: { node: call } }
    call:
      execution: { type: child-workflow, workflowId: child }
      onReturn: { finished: { return: done } }
childWorkflows:
  child:
    startNode: work
    returns: [finished]
    nodes:
      work:
        execution: { type: actor-task, role: manager, instruction: Work. }
        checker: { checkerId: judge.claim-correct }
        results:
          succeeded: { criteria: ok, target: { return: finished } }
`), { workflowId: 'w' }), CatalogValidationError, /does not execute yet \(T2\)/)
})

// ── F: 新状态格式与旧库的不兼容维护保护（A12 的维护子集） ────────────────────

test('v3: an old state-format database is never silently converted; explicit backup path required', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-v3-store-'))
  try {
    const path = stateDbPath(home)
    mkdirSync(join(home, 'workflows'), { recursive: true })
    const legacy = new DatabaseSync(path, { create: true })
    legacy.exec(`
      CREATE TABLE runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL UNIQUE, workspace_key TEXT NOT NULL,
        format_version TEXT NOT NULL, state_version INTEGER NOT NULL, status TEXT NOT NULL, current_execution_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      CREATE TABLE node_executions (execution_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, visit INTEGER NOT NULL, revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL, UNIQUE(run_id, execution_id), UNIQUE(run_id, visit)) STRICT;
      CREATE TABLE node_execution_events (execution_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY(execution_id, sequence)) STRICT;
      PRAGMA user_version = 9;
    `)
    legacy.close()

    // 打开旧库：进入显式维护模式，不静默写入/转换/清空
    const access = new StateAccess(home)
    const diagnostic = access.maintenanceDiagnostic()
    assert.ok(diagnostic, '旧格式库必须进入维护模式')
    assert.equal(diagnostic.kind, 'incompatible')
    assert.match(diagnostic.reason, /original data retained/)
    assert.throws(() => access.current(), /maintenance mode/)
    access.close()

    // 原字节保留：旧库仍是 user_version=9，没有被静默升级
    const probe = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal((probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9)
    } finally { probe.close() }

    // 显式归档后才建立新库（v10 可启动）
    const archive = new StateAccess(home)
    const moved = await archive.archiveIncompatible()
    assert.match(moved.backupPath, /\.backup-.*\.sqlite3$/)
    archive.close()
    const fresh = new StateStore(home)
    fresh.close()
    const upgraded = new DatabaseSync(path, { readOnly: true })
    try {
      assert.equal((upgraded.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10)
    } finally { upgraded.close() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
