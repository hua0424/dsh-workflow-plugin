/**
 * T4（#133）：完整组合示例与组合路径恢复。
 *
 * 示例本体是 `docs/example/v3-combined-example.yaml`（真实 catalog 加载器接受、可复制到
 * `%DSH_HOME%/workflows/` 直接运行）；本文件在真实 Runtime + 临时 SQLite（可关库重开）+
 * 受控 Host Adapter（脚本化 Program）上验证：
 *   - 多出口/单出口 Actor、同一个 Child 的两个返回进入两个不同父后继、两层 Child 嵌套返回
 *     逐层重命名、Program 在 Child 内结束、Root 三个不同业务终局；
 *   - 组合路径上的 REJECT 改选、NEED_CONTEXT 保留 claim、Program FAIL 回边与 ERROR 人工恢复；
 *   - 交接事务故障前后不丢结果、不重复推进，重启与迟到/重复回调只推进一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalogEntry } from '../src/catalog/loader.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type JudgeSpawnInput, type StateHost } from '../src/engine/engine.ts'
import { checkExecutionInvariants } from '../src/state/invariants.ts'
import type { ClaimCaller, ExecutionChange, ProgramResult, RunState, WorkflowConfig } from '../src/types.ts'

const EXAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'example', 'v3-combined-example.yaml')
const PROGRAM_ID = 'github.all-milestone-issues-complete'
const PARAMS = { milestoneNumber: 9 }

/** 示例文本经真实 parse + schema + 静态校验；引擎与加载器用同一个 config。 */
function exampleConfig(): WorkflowConfig {
  return parseCatalogConfig(readFileSync(EXAMPLE_PATH, 'utf8'))
}

type ScriptedProgram = (parameters: Record<string, unknown>) => ProgramResult | Promise<ProgramResult>

function harness(config: WorkflowConfig) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-v3-combined-'))
  let store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judges: JudgeSpawnInput[] = []
  const spawnedRoles: string[] = []
  const programCalls: Array<{ programId: string; parameters: Record<string, unknown> }> = []
  let script: ScriptedProgram = async () => ({ kind: 'PASS', handoff: 'program artifact' })
  let failNextPut = false
  const send = (sessionId: string, text: string) => {
    const messageId = `message-${messages.length + 1}`
    messages.push({ sessionId, messageId, text })
    return { messageId }
  }
  const makeEngine = () => {
    const base = makeStateHost(() => store)
    const host: StateHost = {
      ...base,
      async put(workspaceKey: string, run: RunState, expectedVersion: number, changes: ExecutionChange[]) {
        if (failNextPut) { failNextPut = false; throw new Error('injected transaction failure') }
        await base.put(workspaceKey, run, expectedVersion, changes)
      },
    }
    const engine = new WorkflowEngine({
      async steerManager(_run, text) { return send('manager', text) },
      async sendRoleActor(run, role, text) { return send(run.roleActors[role]!, text) },
      managerSessionSeq() { return 0 },
    }, {
      async ensureRoleActor(_run, role, text) { spawnedRoles.push(role); return { ...send(`${role}-session`, text), childId: `${role}-session` } },
      async startJudge(_run, input) { judges.push(input); return { ...send(input.judgeSessionId, 'Judge'), judgeSessionId: input.judgeSessionId } },
      async followupJudge(_run, judgeSessionId, input) { judges.push(input); return send(judgeSessionId, 'Judge followup') },
      async judgeSessionAvailability() { return 'available' as const },
      async roleSessionAvailability() { return 'available' as const },
      async safeToInspect() { return 'safe' as const },
      async retireJudge() {},
      async drainJudge() {},
      async drainRoleActor() {},
      async compactRoleActor() { return { ok: true } },
    }, {
      async run(_run, programId, parameters) {
        programCalls.push({ programId, parameters: structuredClone(parameters) })
        return script(parameters)
      },
    }, host)
    engine.cwdResolver = async () => home
    return engine
  }
  let engine = makeEngine()
  const caller = (dispatch: { sessionId?: string; messageId?: string }): ClaimCaller => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  type Row = NonNullable<Awaited<ReturnType<StateStore['get']>>>
  const row = async (): Promise<Row> => (await store.get('ws'))!
  return {
    home, messages, judges, spawnedRoles, programCalls,
    get store() { return store }, get engine() { return engine },
    row,
    judgeOf: (current: Row) => caller(current.execution.judge!),
    async start(input = 'combined request') { return engine.startRun('ws', engine.buildInitialRun('manager', 'combined-example', config, 'hash'), undefined, input) },
    /** 当前 Actor 提交并收口（claim → turn end）。 */
    async claim(result: string, handoff = 'artifact') {
      const actor = caller((await row()).execution.dispatch!)
      const claimed = await engine.handleClaim('ws', { result, handoff }, actor)
      assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.reason)
      await engine.handleTurnEnded('ws', actor)
      return row()
    },
    /** 当前 claim 的 Judge 判定（默认 ACCEPT）+ Judge turn 收口；后继只由该收口驱动。 */
    async judge(result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT' = 'ACCEPT', reason = 'verified') {
      const current = await row()
      const judge = caller(current.execution.judge!)
      const outcome = await engine.handleJudgeClaim('ws', current.execution.nodeToken, result, reason, judge)
      if (outcome.ok && result !== 'NEED_CONTEXT') await engine.handleTurnEnded('ws', judge)
      return outcome
    },
    /** 提交 + ACCEPT + 收口。 */
    async accept(result: string, handoff = 'artifact') {
      await this.claim(result, handoff)
      await this.judge('ACCEPT')
      return row()
    },
    /** Manager 提供参数并运行当前 Program 节点。 */
    async runProgram(supplied: Record<string, unknown> = PARAMS, by = 'manager') {
      const current = await row()
      return engine.handleRunProgram('ws', current.execution.nodeToken, supplied, by)
    },
    /** Manager 在 BLOCK 的 Program 现场提交事实确认。 */
    async resolveProgram(result: 'PASS' | 'FAIL', reason = 'Manager verified the Program facts', by = 'manager') {
      const current = await row()
      return engine.handleResolveProgram('ws', current.execution.nodeToken, result, reason, by)
    },
    scriptProgram(next: ScriptedProgram) { script = next },
    armPutFailure() { failNextPut = true },
    reopen() { store.close(); store = new StateStore(home); engine = makeEngine() },
    /** 按已提交的示例文本把示例放进隔离临时 catalog 目录，用真实加载器读回。 */
    async loadFromCatalog() {
      const catalogHome = join(home, 'catalog-home')
      mkdirSync(join(catalogHome, 'workflows'), { recursive: true })
      writeFileSync(join(catalogHome, 'workflows', 'v3-combined-example.yaml'), readFileSync(EXAMPLE_PATH, 'utf8'))
      return loadCatalogEntry(catalogHome, 'v3-combined-example')
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

// ── A: 示例本身可加载，且嵌套返回到达 Root 业务终局 ─────────────────────────

test('#133 AC3: 完整组合示例由真实 catalog 加载器接受，嵌套 Child 返回逐层映射到 Root 终局', async () => {
  const h = harness(exampleConfig())
  try {
    const entry = await h.loadFromCatalog()
    assert.ok(entry, '示例必须是可加载的 v3 catalog')
    assert.deepEqual(Object.keys(entry.config.workflow.nodes).sort(), ['escalate', 'fix', 'plan', 'report', 'review', 'run-cycle', 'run-nested', 'triage'])
    assert.deepEqual(entry.config.workflow.returns, ['delivered', 'cancelled', 'no-change'])
    assert.deepEqual(Object.keys(entry.config.workflow.nodes['run-cycle']!.execution.type === 'child-workflow' ? (entry.config.workflow.nodes['run-cycle'] as { onReturn: Record<string, unknown> }).onReturn : {}), ['done', 'cancelled'])

    await h.start('combined request')
    await h.accept('succeeded', 'plan approved')
    let row = await h.row()
    assert.equal(row.execution.nodeId, 'review', '多出口 Actor 由 plan 的命名结果路由进入')

    // review(approved) → run-cycle（Child）
    row = await h.accept('approved', 'review approved')
    assert.equal(row.execution.workflowId, 'issue-cycle')
    assert.equal(row.execution.nodeId, 'work')
    assert.equal(row.execution.input, 'review approved', 'handoff 原文进入子流程起点')
    const cycleCallerId = row.run.callStack[0]!.executionId
    assert.equal(row.run.callStack.length, 2)
    const cycleCaller = (await h.store.execution('ws', cycleCallerId))!
    assert.equal(cycleCaller.dispatch, undefined, '调用层不派 Actor')
    assert.equal(cycleCaller.judge, undefined, '调用层不派 Judge')

    // work(succeeded) → check（Child 内的 Program）
    row = await h.accept('succeeded', 'milestone work done')
    assert.equal(row.execution.nodeId, 'check')
    assert.equal(row.execution.phase, 'ready')
    const checkExecutionId = row.execution.executionId
    const judgesBeforeProgram = h.judges.length
    h.scriptProgram(async () => ({ kind: 'PASS', handoff: 'milestone 9 complete' }))
    assert.equal((await h.runProgram()).ok, true)
    assert.deepEqual(h.programCalls, [{ programId: PROGRAM_ID, parameters: PARAMS }])
    assert.equal(h.judges.length, judgesBeforeProgram, 'Program 不派 Judge')

    // PASS → { return: done } 在 Child 内结束 → 父后继 run-nested（不是 triage），
    // 且 run-nested 是 Child 调用层：驱动器立即进入 outer → inner，停在 inner 的起点节点。
    row = await h.row()
    assert.equal(row.execution.workflowId, 'inner')
    assert.equal(row.execution.nodeId, 'deep')
    assert.equal(row.run.callStack.length, 3, 'root(run-nested) → outer(call-inner) → inner(deep)')
    assert.equal(row.execution.input, 'milestone 9 complete', '子流程终局 handoff 原文逐层传递')
    const nestedCallerId = row.run.callStack[0]!.executionId
    const outerCallerId = row.run.callStack[1]!.executionId
    const returnedCycleCaller = (await h.store.execution('ws', cycleCallerId))!
    assert.equal(nestedCallerId, returnedCycleCaller.successorId, 'done 进入的父后继就是 run-nested 工作单')
    assert.deepEqual(returnedCycleCaller.returned, { kind: 'result', name: 'done', source: cycleCallerId })
    assert.deepEqual(returnedCycleCaller.child?.result, { terminalExecutionId: checkExecutionId, handoff: 'milestone 9 complete' })
    const nestedCaller = (await h.store.execution('ws', nestedCallerId))!
    assert.equal(nestedCaller.nodeId, 'run-nested')
    assert.equal(nestedCaller.predecessorId, cycleCallerId, '父后继的直接前驱是刚退出的 caller')
    assert.equal(nestedCaller.child?.workflowId, 'outer')
    const outerEntry = (await h.store.execution('ws', outerCallerId))!
    assert.equal(outerEntry.nodeId, 'call-inner')
    assert.equal(outerEntry.predecessorId, undefined, 'Child 起点帧不是后继，不带前驱登记')
    assert.match(h.messages.at(-1)!.text, /\[handoff\]\nmilestone 9 complete/)

    const innerLeafId = row.execution.executionId

    // deep(succeeded) → inner 返回 exhausted → outer 映射为 stopped → root 后继 report
    row = await h.accept('succeeded', 'inner artifact')
    assert.equal(row.run.callStack.length, 1, '两层 frame 一次事务 pop')
    assert.equal(row.execution.nodeId, 'report')
    assert.equal(row.execution.input, 'inner artifact', 'handoff 逐层传递，不重摘要')
    const outerCaller = (await h.store.execution('ws', outerCallerId))!
    assert.deepEqual(outerCaller.child?.result, { terminalExecutionId: innerLeafId, handoff: 'inner artifact' })
    assert.deepEqual(outerCaller.returned, { kind: 'return', name: 'stopped', source: outerCallerId }, '外层 caller 用本层映射结果退出')
    assert.match(h.messages.at(-1)!.text, /前驱节点 run-nested 已确认结果：stopped（kind: result）/)
    assert.doesNotMatch(h.messages.at(-1)!.text, /exhausted/, '最底层返回名不穿透到 Root')

    row = await h.accept('succeeded', 'delivered artifact')
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.businessReturn, { name: 'delivered', source: row.execution.executionId })
    assert.match(h.messages.at(-1)!.text, /业务终局：delivered/)
    assert.equal((await h.engine.status('ws', 'manager')).status.finalHandoffPreview, 'delivered artifact')
    assert.deepEqual(checkExecutionInvariants(row.run, row.execution), [])
  } finally { h.close() }
})

// ── B: 同一个 Child 的两个返回进两个不同父后继 / Program FAIL 回边 / 另外两个 Root 终局 ──

test('#133 AC3/AC4: 同一 Child 的另一个返回进另一个父后继，Program FAIL 在 Child 内回边，Root 另两个终局', async () => {
  // 第一条：work(blocked) → issue-cycle 返回 cancelled → 父后继 triage → Root cancelled
  const cancelled = harness(exampleConfig())
  try {
    await cancelled.start('cancelled request')
    await cancelled.accept('succeeded', 'plan approved')
    await cancelled.accept('approved', 'review approved')
    let row = await cancelled.row()
    const cycleCallerId = row.run.callStack[0]!.executionId
    row = await cancelled.accept('blocked', 'needs a decision')
    assert.equal(row.run.callStack.length, 1)
    assert.equal(row.execution.nodeId, 'triage', 'cancelled 走另一个父后继节点')
    assert.equal(row.execution.predecessorId, cycleCallerId)
    assert.equal(row.execution.input, 'needs a decision')
    assert.match(cancelled.messages.at(-1)!.text, /前驱节点 run-cycle 已确认结果：cancelled（kind: result）/)
    row = await cancelled.accept('succeeded', 'cancellation recorded')
    assert.deepEqual(row.run.businessReturn, { name: 'cancelled', source: row.execution.executionId })
    assert.match(cancelled.messages.at(-1)!.text, /业务终局：cancelled/)
    assert.doesNotMatch(cancelled.messages.at(-1)!.text, /交付成功|已完成（run/, '业务终局不渲染成通用“已完成”')
  } finally { cancelled.close() }

  // 第二条：Program FAIL 留在 Child 内回到 repair，重跑 PASS 后返回 done，再走 skipped → Root no-change
  const noChange = harness(exampleConfig())
  try {
    await noChange.start('no-change request')
    await noChange.accept('succeeded', 'plan approved')
    await noChange.accept('approved', 'review approved')
    let row = await noChange.accept('succeeded', 'first attempt')
    assert.equal(row.execution.nodeId, 'check')
    const programExecutionId = row.execution.executionId
    noChange.scriptProgram(async () => ({ kind: 'FAIL', reason: 'milestone 9 still has open issues', handoff: 'repair milestone 9' }))
    assert.equal((await noChange.runProgram()).ok, true)
    row = await noChange.row()
    assert.equal(row.execution.workflowId, 'issue-cycle', 'FAIL 的 Target 是子流程内节点')
    assert.equal(row.execution.nodeId, 'repair')
    assert.equal(row.execution.input, 'repair milestone 9')
    assert.match(noChange.messages.at(-1)!.text, /已确认结果：FAIL（kind: result）/)
    assert.deepEqual((await noChange.store.execution('ws', programExecutionId))!.returned, { kind: 'result', name: 'FAIL', source: programExecutionId })

    row = await noChange.accept('succeeded', 'gap closed')
    assert.equal(row.execution.nodeId, 'check', 'repair 回到同一个 Program 节点（新 visit）')
    noChange.scriptProgram(async () => ({ kind: 'PASS', handoff: 'milestone 9 complete' }))
    assert.equal((await noChange.runProgram()).ok, true)
    row = await noChange.row()
    assert.equal(row.execution.nodeId, 'deep', 'PASS → 子流程返回 done → 父后继 run-nested 立即进入 outer/inner')
    assert.equal(row.run.callStack.length, 3)

    // run-nested(outer) 的另一个返回：inner 的 waiting → outer 的 skipped → Root no-change
    row = await noChange.accept('abandoned', 'abandoned with reason')
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.callStack, [])
    assert.equal(row.execution.nodeId, 'run-nested', 'Root 终局工作单是实际裁决终局的 caller')
    assert.deepEqual(row.execution.returned, { kind: 'return', name: 'no-change', source: row.execution.executionId })
    assert.deepEqual(row.run.businessReturn, { name: 'no-change', source: row.execution.executionId })
    assert.match(noChange.messages.at(-1)!.text, /经 Child 逐层映射：skipped/)
  } finally { noChange.close() }
})

// ── C: NEED_CONTEXT 保留 claim、REJECT 改选需重新核验 ───────────────────────

test('#133 AC4: 组合路径上 NEED_CONTEXT 保留 claim 后可补证恢复，REJECT 改选另一结果需重新核验', async () => {
  const h = harness(exampleConfig())
  try {
    await h.start('disputed request')
    await h.accept('succeeded', 'plan approved')
    const reviewExecutionId = (await h.row()).execution.executionId

    // REJECT：留在同一 execution、同一 visit，不沿业务边推进
    let row = await h.claim('changes-required', 'only one required change')
    const visit = row.execution.visit
    const rejected = await h.judge('REJECT', 'the required-change list is incomplete')
    assert.equal(rejected.ok, true)
    row = await h.row()
    assert.equal(row.execution.executionId, reviewExecutionId)
    assert.equal(row.execution.visit, visit, 'REJECT 不新建 visit')
    assert.equal(row.execution.successorId, undefined, 'REJECT 不走业务边')
    assert.equal(row.execution.previousClaim?.result, 'changes-required', '原 claim 归档保留')
    assert.equal(row.run.callStack.length, 1)

    // 改选 disputed 后必须重新核验：先 NEED_CONTEXT 保留 claim，再补证恢复
    row = await h.claim('disputed', 'two parties disagree about scope')
    const disputedClaimId = row.execution.claim?.id
    const judge = h.judgeOf(row)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'NEED_CONTEXT', 'the dispute basis is missing', judge)).ok, true)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.equal(row.execution.claim?.id, disputedClaimId, 'NEED_CONTEXT 保留 claim')
    assert.equal(row.execution.judgment?.result, 'NEED_CONTEXT')
    assert.match(row.execution.blockReason, /Judge NEED_CONTEXT: the dispute basis is missing/)
    assert.match(h.messages.at(-1)!.text, /Workflow BLOCK: Judge NEED_CONTEXT/)

    // Manager 补证后恢复同一 Judge 工作单，重新核验通过才推进
    assert.equal((await h.engine.handleResume('ws', row.execution.nodeToken, '争议依据已补：范围以 plan 为准。', 'manager', 'judge')).ok, true)
    row = await h.row()
    assert.equal(row.execution.claim?.id, disputedClaimId, '恢复沿用同一 claim')
    const followup = h.judgeOf(row)
    assert.equal((await h.engine.handleJudgeClaim('ws', row.execution.nodeToken, 'ACCEPT', 'dispute basis recorded', followup)).ok, true)
    await h.engine.handleTurnEnded('ws', followup)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'escalate', '改选后按新结果进入对应唯一后继')
    assert.deepEqual((await h.store.execution('ws', reviewExecutionId))!.returned, { kind: 'result', name: 'disputed', source: reviewExecutionId })
    assert.deepEqual((await h.store.events('ws', reviewExecutionId)).filter(event => event.type === 'exited').length, 1, '每次只退出一次')
  } finally { h.close() }
})

// ── D: 交接事务故障、重启与迟到/重复回调 ────────────────────────────────────

test('#133 AC4: 嵌套返回的事务失败全部回滚，重启后重试恰好推进一次，旧/重复回调不再推进', async () => {
  const h = harness(exampleConfig())
  try {
    await h.start('recovery request')
    await h.accept('succeeded', 'plan approved')
    await h.accept('approved', 'review approved')
    h.scriptProgram(async () => ({ kind: 'PASS', handoff: 'milestone 9 complete' }))
    let row = await h.accept('succeeded', 'cycle work')
    assert.equal(row.execution.nodeId, 'check')
    assert.equal((await h.runProgram()).ok, true)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'deep', 'PASS 返回后父后继 run-nested 立即进入 outer/inner')
    assert.equal(row.run.callStack.length, 3)
    const leafExecutionId = row.execution.executionId
    const leafToken = row.execution.nodeToken
    const rootCallerId = row.run.callStack[0]!.executionId
    const callerIds = row.run.callStack.slice(0, 2).map(frame => frame.executionId)
    const judge = h.judgeOf(await h.claim('succeeded', 'inner artifact'))

    // 提交前故障：子终局结算、各层 caller 退出、frame pop、后继登记是一个事务
    h.armPutFailure()
    await assert.rejects(h.engine.handleJudgeClaim('ws', leafToken, 'ACCEPT', 'verified', judge), /injected transaction failure/)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.run.callStack.length, 3, '失败后不做任何 pop')
    assert.equal(row.execution.executionId, leafExecutionId)
    assert.equal(row.execution.successorId, undefined)
    assert.equal(row.execution.returned, undefined)
    assert.equal(row.run.businessReturn, undefined)
    for (const executionId of callerIds) {
      const callerRow = (await h.store.execution('ws', executionId))!
      assert.equal(callerRow.phase, 'working')
      assert.equal(callerRow.returned, undefined)
      assert.equal(callerRow.child?.result, undefined)
    }

    // 同一 turn 重试：恰好推进一次
    assert.equal((await h.engine.handleJudgeClaim('ws', leafToken, 'ACCEPT', 'verified', judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'report')
    const successorId = row.execution.executionId
    for (const executionId of callerIds) {
      assert.equal((await h.store.events('ws', executionId)).filter(event => event.type === 'exited').length, 1)
    }

    // 迟到/重复回调：重开库后同一 Judge 再次提交与重复 turn 收口都不再推进
    h.reopen()
    assert.equal((await h.row()).execution.executionId, successorId, '重开后后继与现场保留')
    assert.equal((await h.engine.handleJudgeClaim('ws', leafToken, 'ACCEPT', 'verified', judge)).ok, false)
    await h.engine.handleTurnEnded('ws', judge)
    assert.equal((await h.row()).execution.executionId, successorId)
    await h.engine.drive('ws')
    assert.equal((await h.row()).execution.executionId, successorId)

    // 现场仍可继续推进到 Root 业务终局，来源与前驱链不变
    row = await h.accept('succeeded', 'delivered after recovery')
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.businessReturn, { name: 'delivered', source: successorId })
    assert.equal((await h.store.execution('ws', successorId)).predecessorId, rootCallerId)
    const innermost = (await h.store.execution('ws', callerIds.at(-1)!))!
    assert.deepEqual(innermost.child?.result, { terminalExecutionId: leafExecutionId, handoff: 'inner artifact' })
  } finally { h.close() }
})
