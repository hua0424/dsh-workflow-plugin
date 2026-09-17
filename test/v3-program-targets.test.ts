/**
 * T3（#132）：v3 Program 统一目标路由与异常人工恢复。
 *
 * 真实 Runtime + 临时 SQLite（可关库重开）+ 受控 Host Adapter（脚本化 Program）。
 * 验证的是：Program 的 PASS/FAIL 走统一 Target（可到 Actor 节点或 Root 返回）；
 * 后继的控制上下文由插件提供 PASS/FAIL 而非从文本猜测；ERROR/抛错/结果未知都
 * 保留材料并 BLOCK、不默认为任一业务边；Manager 的 `node_resolve_program` 事实确认
 * 恰好推进一次且留审计；交接事务失败全部回滚；Program 自身不派 Judge。
 *
 * D-131-02（deferred.md，#132 归属）：Program 前驱没有自己的 Judge、也没有 Child
 * 返回链，因此「已登记但重启时仍 ready 的后继」在 `node_resume` 里没有可补收口的
 * 转交门——本文件为该放行条件提供定向用例。真正把守恢复的是 Program 前驱的
 * `phase='exited' && successorId === 本后继` 不变量（drive 的就绪门），不是 Judge。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { WorkflowEngine, type JudgeSpawnInput, type StateHost } from '../src/engine/engine.ts'
import { checkExecutionInvariants } from '../src/state/invariants.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import type { ClaimCaller, ExecutionChange, NodeExecution, ProgramResult, RunState, Target, WorkflowConfig } from '../src/types.ts'

const CHECKER = { checkerId: 'judge.claim-correct', config: { criteria: 'shared criteria' } }
const PROGRAM_ID = 'github.all-milestone-issues-complete'
const PARAMS = { milestoneNumber: 7 }

function actorNode(role: string, instruction: string, targets: Record<string, Target>) {
  return {
    execution: { type: 'actor-task' as const, role, instruction },
    checker: CHECKER,
    results: Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, { criteria: `${name} is verified`, target }])),
  }
}

/**
 * Root：plan → program（PASS/FAIL 各带一个统一 Target）→ 后继 Actor 或 Root 返回。
 * 两个结果的目标都可指向节点或 `{ return }`；`delivered`/`reopened` 是两条互不相同的业务终局名。
 */
function programConfig(passTarget: Target, failTarget: Target): WorkflowConfig {
  return {
    schemaVersion: 'agent-workflow/v3',
    roles: {},
    judgeRole: { persona: 'Read only' },
    workflow: {
      startNode: 'plan',
      returns: [
        ...('return' in passTarget ? [passTarget.return] : ['delivered']),
        ...('return' in failTarget ? [failTarget.return] : ['reopened']),
      ],
      nodes: {
        plan: actorNode('manager', 'Plan the milestone work.', { succeeded: { node: 'program' } }),
        program: {
          execution: { type: 'builtin-program', programId: PROGRAM_ID, instruction: 'Check whether the milestone is complete.' },
          results: {
            PASS: { criteria: 'The program reported PASS.', target: passTarget },
            FAIL: { criteria: 'The program reported FAIL.', target: failTarget },
          },
        },
        ...('node' in passTarget ? { after: actorNode('manager', 'Continue the delivery.', { succeeded: { return: 'delivered' } }) } : {}),
        ...('node' in failTarget ? { repair: actorNode('manager', 'Repair the milestone.', { succeeded: { return: 'reopened' } }) } : {}),
      },
    },
  }
}

type ScriptedProgram = (parameters: Record<string, unknown>) => ProgramResult | Promise<ProgramResult>

function harness(config: WorkflowConfig) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-v3-program-'))
  let store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judges: JudgeSpawnInput[] = []
  const spawnedRoles: string[] = []
  const programCalls: Array<{ programId: string; parameters: Record<string, unknown> }> = []
  let script: ScriptedProgram = async () => ({ kind: 'PASS', handoff: 'program artifact' })
  let failNextPut = false
  let skipNextDrive = false
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
    const drive = engine.drive.bind(engine)
    // 受控恢复现场：交接已提交但驱动器没有跑完（宿主在两次提交之间挂掉），后继停在 ready。
    engine.drive = async (ws: string) => {
      if (skipNextDrive) { skipNextDrive = false; return }
      await drive(ws)
    }
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
    actorOf: (current: Row) => caller(current.execution.dispatch!),
    judgeOf: (current: Row) => caller(current.execution.judge!),
    async start(input = 'root request') { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, input) },
    /** 当前 Actor 提交并收口（claim → turn end）。 */
    async claim(result: string, handoff = 'artifact') {
      const actor = caller((await row()).execution.dispatch!)
      const claimed = await engine.handleClaim('ws', { result, handoff }, actor)
      assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.reason)
      await engine.handleTurnEnded('ws', actor)
      return row()
    },
    /** 当前 claim 的 Judge 判定（默认 ACCEPT）+ Judge turn 收口。 */
    async judge(result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT' = 'ACCEPT', reason = 'verified') {
      const current = await row()
      const judge = caller(current.execution.judge!)
      const outcome = await engine.handleJudgeClaim('ws', current.execution.nodeToken, result, reason, judge)
      if (outcome.ok) await engine.handleTurnEnded('ws', judge)
      return outcome
    },
    /** 提交 + ACCEPT + 收口。 */
    async accept(result: string, handoff = 'artifact') {
      await this.claim(result, handoff)
      await this.judge('ACCEPT')
      return row()
    },
    /** Manager 提供当前参数并运行 Program（默认调用方就是 Manager）。 */
    async runProgram(supplied: Record<string, unknown> = PARAMS, by = 'manager') {
      const current = await row()
      return engine.handleRunProgram('ws', current.execution.nodeToken, supplied, by)
    },
    /** Manager 在 BLOCK 的 Program 现场提交事实确认。 */
    async resolveProgram(result: 'PASS' | 'FAIL', reason = 'Manager verified the Program facts', by = 'manager', token?: string) {
      const current = await row()
      return engine.handleResolveProgram('ws', token ?? current.execution.nodeToken, result, reason, by)
    },
    scriptProgram(next: ScriptedProgram) { script = next },
    /** 下一次 state.put 抛错（注入事务失败）。 */
    armPutFailure() { failNextPut = true },
    /** 让下一次驱动器调用成为空转（只有在 Program 脚本里设置才精确命中交接后的那次）。 */
    skipNextDrive() { skipNextDrive = true },
    reopen() { store.close(); store = new StateStore(home); engine = makeEngine() },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

const config = (value: WorkflowConfig) => validateAndNormalize(value, { workflowId: 'test' })
const events = async (store: StateStore, executionId: string) => (await store.events('ws', executionId)).map(event => event.type)

// ── A: PASS/FAIL 走统一 Target（节点目标与 Root 返回目标）─────────────────────

test('#132 A11: PASS → Actor 后继，前驱结果为插件给出的 PASS，handoff 是唯一文本，全程不派 Judge', async () => {
  const h = harness(config(programConfig({ node: 'after' }, { node: 'repair' })))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    let row = await h.row()
    assert.equal(row.execution.nodeId, 'program')
    assert.equal(row.execution.phase, 'ready')
    assert.equal(row.execution.program, undefined, 'ready Program 不带调用现场（能进 ready 就能等 Manager 提供参数）')
    assert.match(h.messages.at(-1)!.text, /\[program\]\ngithub\.all-milestone-issues-complete\n请调用 node_run_program/)
    const programExecutionId = row.execution.executionId
    const judgesAfterPlan = h.judges.length
    const messagesAfterPlan = h.messages.length

    assert.equal((await h.runProgram()).ok, true)
    assert.deepEqual(h.programCalls, [{ programId: PROGRAM_ID, parameters: PARAMS }])
    row = await h.row()
    assert.equal(row.execution.nodeId, 'after')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.predecessorId, programExecutionId, '直接前驱是 Program 工作单')
    assert.equal(row.execution.input, 'program artifact', 'handoff 是后继唯一的输入文本')
    assert.equal(h.messages.length, messagesAfterPlan + 1, '只创建一个后继、只派发一次')
    const successorText = h.messages.at(-1)!.text
    assert.match(successorText, /\[直接前驱结果\]\n前驱节点 program 已确认结果：PASS（kind: result）/)
    assert.doesNotMatch(successorText, /FAIL/, '后继上下文不掺入未选中的出口')
    assert.equal(h.judges.length, judgesAfterPlan, 'Program 不派 Judge，后继作为新 claim 才另派')
    assert.deepEqual(h.spawnedRoles, [], 'Program 与 manager 后继都不产生 Role 会话')

    const program = (await h.store.execution('ws', programExecutionId))!
    assert.equal(program.phase, 'exited')
    assert.deepEqual(program.program?.parameters, PARAMS, '参数材料随工作单保留')
    assert.deepEqual(program.program?.result, { kind: 'PASS', handoff: 'program artifact' })
    assert.deepEqual(program.returned, { kind: 'result', name: 'PASS', source: programExecutionId })
    assert.equal(program.successorId, row.execution.executionId)
    assert.deepEqual(await events(h.store, programExecutionId), ['entered', 'program-ready', 'program-arranged', 'program-result', 'exited'])
    const successor = (await h.store.execution('ws', row.execution.executionId))!
    assert.deepEqual(checkExecutionInvariants(row.run, program), [])
    assert.deepEqual(checkExecutionInvariants(row.run, successor), [])

    // 只创建一个后继：重放驱动器不再派发，也不新建工作单
    const successorId = successor.executionId
    const dispatchId = successor.dispatch?.id
    await h.engine.drive('ws')
    assert.equal((await h.row()).execution.executionId, successorId)
    assert.equal((await h.store.execution('ws', successorId))!.dispatch?.id, dispatchId)

    const completed = await h.accept('succeeded', 'delivered artifact')
    assert.equal(completed.run.status, 'completed')
    assert.deepEqual(completed.run.businessReturn, { name: 'delivered', source: successorId })
    assert.equal((await h.engine.status('ws', 'manager')).status.finalHandoffPreview, 'delivered artifact')
  } finally { h.close() }
})

test('#132 A11: FAIL → Actor 后继，前驱结果为 FAIL 且 Program 的 reason 留在工作单上', async () => {
  const h = harness(config(programConfig({ node: 'after' }, { node: 'repair' })))
  try {
    await h.scriptProgram(async () => ({ kind: 'FAIL', reason: 'milestone #7 still has open issues', handoff: 'repair milestone #7' }))
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    const programExecutionId = (await h.row()).execution.executionId
    const judgesAfterPlan = h.judges.length

    assert.equal((await h.runProgram()).ok, true)
    const row = await h.row()
    assert.equal(row.execution.nodeId, 'repair')
    assert.equal(row.execution.input, 'repair milestone #7')
    assert.match(h.messages.at(-1)!.text, /已确认结果：FAIL（kind: result）/)
    assert.equal(h.judges.length, judgesAfterPlan, 'FAIL 是执行协议结果，不经过 Judge')
    const program = (await h.store.execution('ws', programExecutionId))!
    assert.deepEqual(program.program?.result, { kind: 'FAIL', handoff: 'repair milestone #7', reason: 'milestone #7 still has open issues' })
    assert.deepEqual(program.returned, { kind: 'result', name: 'FAIL', source: programExecutionId })
    assert.equal((await h.accept('succeeded', 'repaired')).run.businessReturn?.name, 'reopened')
  } finally { h.close() }
})

test('#132 A11: PASS/FAIL 都可路由到 Root 返回，业务返回名区分两者且不渲染成交付成功', async () => {
  for (const [kind, script, expected] of [
    ['PASS', async () => ({ kind: 'PASS' as const, handoff: 'milestone #7 complete' }), 'delivered'],
    ['FAIL', async () => ({ kind: 'FAIL' as const, reason: 'not complete', handoff: 'milestone #7 incomplete' }), 'reopened'],
  ] as Array<[string, ScriptedProgram, string]>) {
    const h = harness(config(programConfig({ return: 'delivered' }, { return: 'reopened' })))
    try {
      await h.scriptProgram(script)
      await h.start('root request')
      await h.accept('succeeded', 'plan approved')
      const programExecutionId = (await h.row()).execution.executionId
      assert.equal((await h.runProgram()).ok, true)
      const row = await h.row()
      assert.equal(row.run.status, 'completed', kind)
      assert.deepEqual(row.run.callStack, [], `${kind}: 终局 Run 没有未退出的 frame`)
      assert.equal(row.execution.nodeId, 'program')
      assert.deepEqual(row.run.businessReturn, { name: expected, source: programExecutionId }, kind)
      assert.deepEqual(row.execution.returned, { kind: 'return', name: expected, source: programExecutionId }, kind)
      const terminal = h.messages.at(-1)!.text
      assert.match(terminal, new RegExp(`业务终局：${expected}`), kind)
      assert.match(terminal, new RegExp(kind === 'PASS' ? 'milestone #7 complete' : 'milestone #7 incomplete'), `${kind}: 唯一 handoff 原文`)
      assert.doesNotMatch(terminal, /已完成（run/, `${kind}: 业务终局不渲染成通用完成`)
      const status = await h.engine.status('ws', 'manager')
      assert.equal(status.status.businessReturn?.name, expected, kind)
      assert.equal(status.status.finalHandoffPreview, kind === 'PASS' ? 'milestone #7 complete' : 'milestone #7 incomplete')
    } finally { h.close() }
  }
})

// ── B: 异常与未知结果一律 BLOCK 保留材料 ────────────────────────────────────

test('#132 A11/AC3: ERROR、抛错与结果未知都 BLOCK 保留材料，不默认为任一业务边', async () => {
  const cases: Array<[string, ScriptedProgram, RegExp]> = [
    ['ERROR', async () => ({ kind: 'ERROR', reason: 'remote response was uncertain' }), /Program ERROR: remote response was uncertain/],
    ['抛错', async () => { throw new Error('gh cli missing') }, /Program result unknown; inspect before retry or resolution: gh cli missing/],
    ['结果未知', async () => ({ kind: 'PASS', handoff: '   ' }), /Program result unknown; inspect before retry or resolution: Program handoff must be/],
  ]
  for (const [label, script, expected] of cases) {
    const h = harness(config(programConfig({ node: 'after' }, { node: 'repair' })))
    try {
      await h.scriptProgram(script)
      await h.start('root request')
      await h.accept('succeeded', 'plan approved')
      const programExecutionId = (await h.row()).execution.executionId
      const outcome = await h.runProgram()
      assert.equal(outcome.ok, label === 'ERROR', `${label}: 只有已结算的 ERROR 是 ok 的 BLOCK`)
      const row = await h.row()
      assert.equal(row.run.status, 'blocked', label)
      assert.equal(row.execution.nodeId, 'program', `${label}: 不默认为任一业务边`)
      assert.equal(row.execution.executionId, programExecutionId, label)
      assert.equal(row.execution.phase, label === 'ERROR' ? 'settling' : 'working', label)
      assert.deepEqual(row.execution.program?.parameters, PARAMS, `${label}: 参数材料保留`)
      assert.match(row.execution.blockReason, expected, label)
      assert.equal(row.execution.successorId, undefined, `${label}: 不创建后继`)
      assert.equal(row.execution.returned, undefined, `${label}: 不产生业务终局裁决名`)
      assert.equal(row.run.businessReturn, undefined, label)
      assert.equal(h.judges.length, 1, `${label}: Program 不派 Judge（只有 plan 的那次）`)
      if (label === 'ERROR') assert.deepEqual(row.execution.program?.result, { kind: 'ERROR', reason: 'remote response was uncertain' })
      else assert.equal(row.execution.program?.result, undefined, `${label}: 未知结果不落库`)

      // Program 自身不由 node_resume 恢复：Manager 走 node_run_program / node_resolve_program
      const resumed = await h.engine.handleResume('ws', row.execution.nodeToken, '核查 Program 现场。', 'manager', 'auto')
      assert.equal(resumed.ok, false, label)
      assert.match(resumed.ok ? '' : resumed.reason, /Program recovery requires node_run_program or node_resolve_program/)

      // 关库重开：BLOCK 现场、参数与原因都还在
      h.reopen()
      const durable = await h.row()
      assert.equal(durable.run.status, 'blocked', label)
      assert.equal(durable.execution.executionId, programExecutionId, label)
      assert.deepEqual(durable.execution.program?.parameters, PARAMS, label)
      assert.equal(durable.execution.blockReason, row.execution.blockReason, label)
      assert.deepEqual(checkExecutionInvariants(durable.run, durable.execution), [])

      // D-132-01（#133 收口）：重开后的 store 上，Manager 事实确认仍能完成推进且恰好一次
      if (label === 'ERROR') {
        assert.equal((await h.resolveProgram('PASS', 'Manager verified the milestone state after restart')).ok, true)
        const advanced = await h.row()
        assert.equal(advanced.execution.nodeId, 'after')
        assert.equal(advanced.execution.predecessorId, programExecutionId, '直接前驱是 Program 工作单')
        assert.equal((await events(h.store, programExecutionId)).filter(type => type === 'program-resolved').length, 1, '确认恰好留一次审计')
        const program = (await h.store.execution('ws', programExecutionId))!
        assert.deepEqual(program.returned, { kind: 'result', name: 'PASS', source: programExecutionId })
        assert.equal(program.successorId, advanced.execution.executionId)
        assert.match(h.messages.at(-1)!.text, /前驱节点 program 已确认结果：PASS（kind: result）/)
        const completed = await h.accept('succeeded', 'delivered after restart')
        assert.equal(completed.run.status, 'completed')
        assert.deepEqual(completed.run.businessReturn, { name: 'delivered', source: advanced.execution.executionId })
      }
    } finally { h.close() }
  }
})

// ── C: Manager 事实确认的授权、审计与恰好一次 ───────────────────────────────

test('#132 AC4: node_resolve_program 拒绝越权/旧 token/重复确认，合法确认恰好推进一次并留审计', async () => {
  const h = harness(config(programConfig({ node: 'after' }, { node: 'repair' })))
  try {
    await h.scriptProgram(async () => ({ kind: 'ERROR', reason: 'remote response was uncertain' }))
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    const programExecutionId = (await h.row()).execution.executionId
    assert.equal((await h.runProgram()).ok, true)
    let row = await h.row()
    const blockedToken = row.execution.nodeToken

    // 越权与非法参数：只有 Manager 能用当前 token 提交有界 reason
    const foreign = await h.resolveProgram('PASS', 'not the Manager', 'some-actor')
    assert.equal(foreign.ok, false)
    assert.match(foreign.ok ? '' : foreign.reason, /Manager-only/)
    assert.equal((await h.engine.handleResolveProgram('ws', blockedToken, 'PASS', '   ', 'manager')).ok, false)

    // 重试轮换 token 后，旧 token 的确认被拒绝
    assert.equal((await h.runProgram()).ok, true)
    row = await h.row()
    assert.notEqual(row.execution.nodeToken, blockedToken, '重试轮换 nodeToken')
    const stale = await h.resolveProgram('PASS', 'stale token', 'manager', blockedToken)
    assert.equal(stale.ok, false)
    assert.match(stale.ok ? '' : stale.reason, /requires the current BLOCK\/token/)

    // 合法确认：恰好推进一次
    assert.equal((await h.resolveProgram('PASS', 'Manager verified the milestone state')).ok, true)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'after')
    assert.equal(row.run.status, 'running')
    const successorId = row.execution.executionId
    const duplicate = await h.engine.handleResolveProgram('ws', row.execution.nodeToken, 'PASS', 'duplicate', 'manager')
    assert.equal(duplicate.ok, false, '已推进的 Run 不再接受第二次确认')
    await h.engine.drive('ws')
    assert.equal((await h.row()).execution.executionId, successorId, '重复确认/重放不创建第二个后继')

    // 审计：原工作单保留两次事实材料、Manager 的确认原因与来源，事件齐全
    const program = (await h.store.execution('ws', programExecutionId))!
    assert.equal(program.program?.result?.kind, 'PASS')
    assert.equal(program.program?.result?.reason, 'Manager verified the milestone state')
    assert.deepEqual(program.returned, { kind: 'result', name: 'PASS', source: programExecutionId })
    assert.equal(program.successorId, successorId)
    const programEvents = await events(h.store, programExecutionId)
    assert.deepEqual(programEvents, [
      'entered', 'program-ready', 'program-arranged', 'program-result', 'blocked',
      'program-arranged', 'program-result', 'blocked', 'program-resolved', 'exited',
    ])
    assert.equal((await h.store.events('ws', programExecutionId)).filter(event => event.type === 'program-resolved').length, 1)
    assert.equal(h.judges.length, 1, 'Program 的异常恢复不引入 Judge')
  } finally { h.close() }
})

// ── D: 事务失败回滚与状态校验 ───────────────────────────────────────────────

test('#132 AC5: Program 交接事务失败全部回滚，恢复恰好推进一次，且 Program 不能携带 Actor/Judge 材料', async () => {
  const h = harness(config(programConfig({ node: 'after' }, { node: 'repair' })))
  try {
    await h.scriptProgram(async () => { h.armPutFailure(); return { kind: 'PASS', handoff: 'program artifact' } })
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    const programExecutionId = (await h.row()).execution.executionId

    const failed = await h.runProgram()
    assert.equal(failed.ok, false)
    assert.match(failed.ok ? '' : failed.reason, /Program result commit failed/)
    let row = await h.row()
    // 交接（Program 结算 + 后继登记）是一个事务：失败后一处都不能留下
    assert.equal(row.run.status, 'blocked')
    assert.equal(row.execution.nodeId, 'program')
    assert.equal(row.execution.executionId, programExecutionId)
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.program?.result, undefined, '失败的事务不留下已结算结果')
    assert.deepEqual(row.execution.program?.parameters, PARAMS)
    assert.match(row.execution.blockReason, /Program result commit unknown; inspect before retry or resolution/)
    assert.equal(row.execution.successorId, undefined)
    assert.equal(row.execution.returned, undefined)
    assert.deepEqual(await events(h.store, programExecutionId), ['entered', 'program-ready', 'program-arranged', 'blocked'])
    assert.deepEqual(checkExecutionInvariants(row.run, row.execution), [])

    // Manager 事实确认后恰好推进一次
    assert.equal((await h.resolveProgram('PASS', 'Manager verified after inspecting the workspace')).ok, true)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'after')
    const successorId = row.execution.executionId
    const successor = (await h.store.execution('ws', successorId))!
    assert.equal(successor.predecessorId, programExecutionId)
    assert.equal(successor.input, 'plan approved', '无 Program handoff 时沿用工作单输入（既有单文本规则）')
    assert.equal((await h.store.events('ws', successorId)).filter(event => event.type === 'entered').length, 1)
    assert.equal((await h.store.events('ws', programExecutionId)).filter(event => event.type === 'exited').length, 1)
    assert.equal((await h.engine.handleResolveProgram('ws', row.execution.nodeToken, 'PASS', 'again', 'manager')).ok, false)
    await h.engine.drive('ws')
    assert.equal((await h.row()).execution.executionId, successorId)

    // 不旁路状态校验：Program 工作单不能携带 Actor/Judge 材料，也不能进入 checking
    const program = (await h.store.execution('ws', programExecutionId))!
    const forgedJudge: NodeExecution = {
      ...structuredClone(program),
      judge: { id: 'forged-judge', sessionId: 'forged-session', claimId: 'forged-claim', inputVersion: program.inputVersion, settled: false },
    }
    assert.match(checkExecutionInvariants(row.run, forgedJudge).join('; '), /builtin-program cannot carry Actor\/Judge materials/)
    const forgedChecking: NodeExecution = { ...structuredClone(program), phase: 'checking' }
    assert.match(checkExecutionInvariants(row.run, forgedChecking).join('; '), /builtin-program cannot enter checking/)
  } finally { h.close() }
})

// ── E: D-131-02 Program 前驱的 ready 后继经 node_resume 恢复 ────────────────

test('#132 D-131-02: Program 前驱的 ready 后继经 node_resume 恢复，跳过无 Judge 的转交收口且只派发一次', async () => {
  const h = harness(config(programConfig({ node: 'after' }, { node: 'repair' })))
  try {
    await h.scriptProgram(async () => { h.skipNextDrive(); return { kind: 'PASS', handoff: 'program artifact' } })
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    const programExecutionId = (await h.row()).execution.executionId
    assert.equal((await h.runProgram()).ok, true)
    let row = await h.row()
    // 宿主重启窗口：交接已提交，但驱动器没跑完 → 后继停在 ready
    assert.equal(row.execution.nodeId, 'after')
    assert.equal(row.execution.phase, 'ready')
    assert.equal(row.execution.predecessorId, programExecutionId)
    assert.equal(row.execution.dispatch, undefined, '尚未派发')
    const successorId = row.execution.executionId

    // 放行条件：Program 前驱没有自己的 Judge、也不在 Child 返回链上 → 没有可补收口的转交门
    let predecessor = (await h.store.execution('ws', programExecutionId))!
    assert.equal(predecessor.judge, undefined)
    assert.equal(predecessor.child, undefined)
    assert.equal(predecessor.judgment, undefined)
    // 真正把守恢复的是这条不变量（drive 的就绪门）：前驱已退出且恰好登记了本后继
    assert.equal(predecessor.phase, 'exited')
    assert.equal(predecessor.successorId, successorId)

    h.reopen()
    await h.engine.handleRestartReconcile()
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.equal(row.execution.restartPending, true)
    const restored = await h.engine.handleResume('ws', row.execution.nodeToken, 'Program 后继已登记，核实现场后继续执行。', 'manager', 'auto')
    assert.equal(restored.ok, true, restored.ok ? '' : restored.reason)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.equal(row.execution.executionId, successorId, '恢复的是已登记的后继，不新建工作单')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.restartPending, false)
    assert.equal(row.execution.dispatch?.sessionId, 'manager')
    assert.match(h.messages.at(-1)!.text, /\[直接前驱结果\]\n前驱节点 program 已确认结果：PASS（kind: result）/)
    assert.equal((await h.store.events('ws', successorId)).filter(event => event.type === 'actor-arranged').length, 1)
    const messages = h.messages.length
    await h.engine.drive('ws')
    assert.equal(h.messages.length, messages, '恰好派发一次')
    assert.equal(h.judges.length, 1, 'Program 前驱的恢复不引入 Judge')

    // 恢复后的后继照常推进到 Root 业务终局
    const completed = await h.accept('succeeded', 'delivered artifact')
    assert.equal(completed.run.status, 'completed')
    assert.deepEqual(completed.run.businessReturn, { name: 'delivered', source: successorId })
    predecessor = (await h.store.execution('ws', programExecutionId))!
    assert.deepEqual(predecessor.program?.result, { kind: 'PASS', handoff: 'program artifact' })
    assert.deepEqual(checkExecutionInvariants(completed.run, completed.execution), [])
  } finally { h.close() }
})
