/**
 * T2（#131）：v3 Child 显式返回与嵌套原子交接。
 *
 * 真实 Runtime + 临时 SQLite（可关库重开）+ 受控 Host Adapter。验证的是：调用层不派
 * 模型/Judge；子流程的命名返回沿 `onReturn` 逐层映射（允许重命名）进入不同父后继或
 * 本层流程返回；来源 executionId/handoff/直接前驱结果正确；子终局结算、各层 caller
 * 退出与 frame pop、后继登记或 Root 终局同一次事务提交。
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
import type { ClaimCaller, ExecutionChange, NodeExecution, RunState, Target, WorkflowConfig } from '../src/types.ts'

const CHECKER = { checkerId: 'judge.claim-correct', config: { criteria: 'shared criteria' } }

function actorNode(role: string, instruction: string, targets: Record<string, Target>) {
  return {
    execution: { type: 'actor-task' as const, role, instruction },
    checker: CHECKER,
    results: Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, { criteria: `${name} is verified`, target }])),
  }
}

/**
 * Root：plan → call-child（onReturn 两个返回分别去不同父后继 / 直接返回本层流程）→ after。
 * child-a：work 两个结果分别显式返回 `finished` / `cancelled`。
 */
function childConfig(): WorkflowConfig {
  return {
    schemaVersion: 'agent-workflow/v3',
    roles: { worker: { persona: 'Worker' } },
    judgeRole: { persona: 'Read only' },
    workflow: {
      startNode: 'plan',
      returns: ['planned', 'aborted'],
      nodes: {
        plan: actorNode('manager', 'Plan', { succeeded: { node: 'call-child' } }),
        'call-child': {
          execution: { type: 'child-workflow', workflowId: 'child-a' },
          onReturn: { finished: { node: 'after' }, cancelled: { return: 'aborted' } },
        },
        after: actorNode('manager', 'Continue', { succeeded: { return: 'planned' } }),
      },
    },
    childWorkflows: {
      'child-a': {
        startNode: 'work',
        returns: ['finished', 'cancelled'],
        nodes: {
          work: actorNode('worker', 'Child work', { succeeded: { return: 'finished' }, cancelled: { return: 'cancelled' } }),
        },
      },
    },
  }
}

/**
 * 同一个 Child 的两个声明返回分别进入**两个不同的父后继节点**（#133 收口 D-131-01）。
 */
function twoSuccessorConfig(): WorkflowConfig {
  return {
    schemaVersion: 'agent-workflow/v3',
    roles: { worker: { persona: 'Worker' } },
    judgeRole: { persona: 'Read only' },
    workflow: {
      startNode: 'plan',
      returns: ['delivered', 'aborted'],
      nodes: {
        plan: actorNode('manager', 'Plan', { succeeded: { node: 'call-child' } }),
        'call-child': {
          execution: { type: 'child-workflow', workflowId: 'child-a' },
          onReturn: { finished: { node: 'after' }, cancelled: { node: 'triage' } },
        },
        after: actorNode('manager', 'Continue', { succeeded: { return: 'delivered' } }),
        triage: actorNode('manager', 'Triage the cancellation', { succeeded: { return: 'aborted' } }),
      },
    },
    childWorkflows: {
      'child-a': {
        startNode: 'work',
        returns: ['finished', 'cancelled'],
        nodes: {
          work: actorNode('worker', 'Child work', { succeeded: { return: 'finished' }, cancelled: { return: 'cancelled' } }),
        },
      },
    },
  }
}

/**
 * 两层 Child：root → outer（child-a）→ inner（child-b）→ work。
 * 返回沿两层 `onReturn` 逐层重命名：exhausted → stopped → 外层映射目标。
 */
function nestedConfig(outerTarget: Target): WorkflowConfig {
  const continuesInRoot = 'node' in outerTarget
  return {
    schemaVersion: 'agent-workflow/v3',
    roles: { worker: { persona: 'Worker' } },
    judgeRole: { persona: 'Read only' },
    workflow: {
      startNode: 'plan',
      returns: continuesInRoot ? ['planned'] : ['aborted'],
      nodes: {
        plan: actorNode('manager', 'Plan', { succeeded: { node: 'call-outer' } }),
        'call-outer': {
          execution: { type: 'child-workflow', workflowId: 'outer' },
          onReturn: { stopped: outerTarget },
        },
        ...(continuesInRoot ? { fix: actorNode('manager', 'Fix', { succeeded: { return: 'planned' } }) } : {}),
      },
    },
    childWorkflows: {
      outer: {
        startNode: 'call-inner',
        returns: ['stopped'],
        nodes: {
          'call-inner': {
            execution: { type: 'child-workflow', workflowId: 'inner' },
            onReturn: { exhausted: { return: 'stopped' } },
          },
        },
      },
      inner: {
        startNode: 'work',
        returns: ['exhausted'],
        nodes: { work: actorNode('worker', 'Inner work', { succeeded: { return: 'exhausted' } }) },
      },
    },
  }
}

function harness(config: WorkflowConfig) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-v3-child-'))
  let store = new StateStore(home)
  const messages: Array<{ sessionId: string; messageId: string; text: string }> = []
  const judges: JudgeSpawnInput[] = []
  const spawnedRoles: string[] = []
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
    }, { async run() { throw new Error('programs are not part of T2') } }, host)
    engine.cwdResolver = async () => home
    return engine
  }
  let engine = makeEngine()
  const caller = (dispatch: { sessionId?: string; messageId?: string }): ClaimCaller => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  type Row = Awaited<ReturnType<StateStore['get']>>
  const row = async (): Promise<NonNullable<Row>> => (await store.get('ws'))!
  const judgeOf = (current: NonNullable<Row>) => caller(current.execution.judge!)
  return {
    home, messages, judges, spawnedRoles,
    get store() { return store }, get engine() { return engine },
    row, judgeOf,
    actorOf: (current: NonNullable<Row>) => caller(current.execution.dispatch!),
    async start(input = 'root request') { return engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'), undefined, input) },
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
      const judge = judgeOf(current)
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
    armPutFailure() { failNextPut = true },
    reopen() { store.close(); store = new StateStore(home); engine = makeEngine() },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
}

const config = (value: WorkflowConfig) => validateAndNormalize(value, { workflowId: 'test' })

// ── A: Child 返回进入父后继节点 / 父调用方直接返回本层流程 ───────────────────

test('v3 Child: 一个返回进入父后继节点、另一个直接返回本层流程，调用层不派模型/Judge', async () => {
  const h = harness(config(childConfig()))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    // 子流程已进入：栈顶是子流程起点，调用层没有被派发
    let row = await h.row()
    assert.equal(row.execution.workflowId, 'child-a')
    assert.equal(row.execution.nodeId, 'work')
    assert.equal(row.execution.input, 'plan approved', 'handoff 原文进入子流程起点')
    assert.equal(row.run.callStack.length, 2)
    const callerExecutionId = row.run.callStack[0]!.executionId
    const callerRow = (await h.store.execution('ws', callerExecutionId))!
    assert.equal(callerRow.phase, 'working')
    assert.equal(callerRow.child?.executionId, row.execution.executionId)
    // 包装层无额外模型/Judge：调用层没有 dispatch/judge 材料，只有子节点派了一个 Judge
    assert.equal(callerRow.dispatch, undefined)
    assert.equal(callerRow.judge, undefined)
    assert.equal(h.judges.length, 1, '子节点各自派 Judge；调用层不多派')
    assert.deepEqual(h.spawnedRoles, ['worker'], '调用层不追加任何 Role 模型派发')

    const innerExecutionId = row.execution.executionId
    row = await h.accept('succeeded', 'child artifact')
    // finished → { node: after }：恰好一个后继，跨 frame 原子交接
    assert.equal(row.execution.nodeId, 'after')
    assert.equal(row.run.callStack.length, 1)
    assert.equal(row.execution.input, 'child artifact', 'handoff 原文逐层传递，不重摘要')
    assert.equal(row.execution.phase, 'working', '后继由子流程终局的 Judge 收口驱动')
    const returned = (await h.store.execution('ws', callerExecutionId))!
    assert.equal(returned.phase, 'exited')
    assert.deepEqual(returned.child?.result, { terminalExecutionId: innerExecutionId, handoff: 'child artifact' })
    assert.deepEqual(returned.returned, { kind: 'result', name: 'finished', source: callerExecutionId })
    // 直接前驱结果由插件提供：本层 caller 的 Child 返回名，不从文本猜测
    assert.match(h.messages.at(-1)!.text, /\[直接前驱结果\]\n前驱节点 call-child 已确认结果：finished（kind: result）/)
    assert.match(h.messages.at(-1)!.text, /\[handoff\]\nchild artifact/)

    row = await h.accept('succeeded', 'delivered')
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.businessReturn, { name: 'planned', source: row.execution.executionId })

    // 同 workspace 再跑一次：另一条 Child 返回走另一条父路径（父调用方直接返回本层流程）
    await h.start('second request')
    await h.accept('succeeded', 'plan two')
    await h.accept('cancelled', 'child declared exhausted')
    row = await h.row()
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.callStack, [])
    assert.equal(row.execution.nodeId, 'call-child')
    assert.deepEqual(row.execution.returned, { kind: 'return', name: 'aborted', source: row.execution.executionId })
    assert.deepEqual(row.run.businessReturn, { name: 'aborted', source: row.execution.executionId })
    assert.match(h.messages.at(-1)!.text, /业务终局：aborted/)
    assert.match(h.messages.at(-1)!.text, /child declared exhausted/)
  } finally { h.close() }
})

// ── A2: 同一 Child 的两个返回进入两个不同的父后继节点（D-131-01）─────────────

test('v3 Child: 同一 Child 的两个返回分别进入两个不同的父后继节点，各创建一次且来源正确', async () => {
  // 第一条：child-a 返回 finished → 父后继 after（不是 triage）
  const first = harness(config(twoSuccessorConfig()))
  try {
    await first.start('first request')
    await first.accept('succeeded', 'plan one')
    let row = await first.row()
    const callerId = row.run.callStack[0]!.executionId
    const leafId = row.execution.executionId
    const judgesBefore = first.judges.length
    row = await first.accept('succeeded', 'first child artifact')
    assert.equal(row.execution.nodeId, 'after', 'finished 走它自己的父后继')
    assert.notEqual(row.execution.nodeId, 'triage')
    assert.equal(first.judges.length, judgesBefore + 1, '只多派子节点的 Judge，调用层不追加')
    const afterExecutionId = row.execution.executionId
    const callerRow = (await first.store.execution('ws', callerId))!
    assert.equal(callerRow.phase, 'exited')
    assert.equal(callerRow.successorId, afterExecutionId)
    assert.deepEqual(callerRow.child?.result, { terminalExecutionId: leafId, handoff: 'first child artifact' })
    assert.deepEqual(callerRow.returned, { kind: 'result', name: 'finished', source: callerId })
    // 后继的直接前驱是刚退出的 caller；控制上下文给出本层映射后的返回名与唯一 handoff 原文
    assert.equal(row.execution.predecessorId, callerId)
    assert.equal(row.execution.input, 'first child artifact')
    assert.match(first.messages.at(-1)!.text, /\[直接前驱结果\]\n前驱节点 call-child 已确认结果：finished（kind: result）/)
    assert.match(first.messages.at(-1)!.text, /\[handoff\]\nfirst child artifact/)
    // 各自只创建一次：重复驱动不产生第二个后继，后继工作单只 entered 一次
    await first.engine.drive('ws')
    assert.equal((await first.row()).execution.executionId, afterExecutionId)
    assert.equal((await first.store.events('ws', afterExecutionId)).filter(event => event.type === 'entered').length, 1)
    assert.equal((await first.accept('succeeded', 'delivered')).run.businessReturn?.name, 'delivered')
  } finally { first.close() }

  // 第二条：同一个 Child 的另一个返回 cancelled → 另一个父后继 triage（不是 after）
  const second = harness(config(twoSuccessorConfig()))
  try {
    await second.start('second request')
    await second.accept('succeeded', 'plan two')
    let row = await second.row()
    const callerId = row.run.callStack[0]!.executionId
    row = await second.accept('cancelled', 'second child artifact')
    assert.equal(row.execution.nodeId, 'triage', 'cancelled 走另一个父后继')
    assert.equal(row.execution.predecessorId, callerId)
    assert.equal(row.execution.input, 'second child artifact')
    assert.deepEqual((await second.store.execution('ws', callerId))!.returned, { kind: 'result', name: 'cancelled', source: callerId })
    assert.match(second.messages.at(-1)!.text, /前驱节点 call-child 已确认结果：cancelled（kind: result）/)
    assert.doesNotMatch(second.messages.at(-1)!.text, /finished/)
    assert.equal((await second.store.events('ws', row.execution.executionId)).filter(event => event.type === 'entered').length, 1)
    assert.equal((await second.accept('succeeded', 'aborted by triage')).run.businessReturn?.name, 'aborted')
  } finally { second.close() }
})

// ── B: 两层 Child 逐层映射与重命名 ──────────────────────────────────────────

test('v3 Child: 两层连续返回逐层应用本层映射，最底层结果名不穿透到 Root', async () => {
  const h = harness(config(nestedConfig({ node: 'fix' })))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    let row = await h.row()
    assert.equal(row.run.callStack.length, 3, 'root → outer → inner')
    assert.equal(row.execution.workflowId, 'inner')
    const outerCallerId = row.run.callStack[0]!.executionId
    const innerCallerId = row.run.callStack[1]!.executionId
    const innerLeafId = row.execution.executionId

    row = await h.accept('succeeded', 'inner artifact')
    assert.equal(row.run.callStack.length, 1, '两层 frame 一次事务 pop')
    assert.equal(row.execution.nodeId, 'fix')
    assert.equal(row.execution.input, 'inner artifact')
    const outerCaller = (await h.store.execution('ws', outerCallerId))!
    const innerCaller = (await h.store.execution('ws', innerCallerId))!
    // 每层 caller 用**本层**映射结果退出：exhausted → stopped（重命名）→ fix
    assert.deepEqual(innerCaller.returned, { kind: 'return', name: 'stopped', source: innerCallerId })
    assert.deepEqual(outerCaller.returned, { kind: 'result', name: 'stopped', source: outerCallerId })
    // 来源链可追溯：外层 caller 指向内层 caller，内层 caller 指向真正裁决终局的工作单
    assert.equal(outerCaller.child?.result?.terminalExecutionId, innerCallerId)
    assert.equal(innerCaller.child?.result?.terminalExecutionId, innerLeafId)
    assert.equal(outerCaller.child?.result?.handoff, 'inner artifact')
    assert.equal(innerCaller.child?.result?.handoff, 'inner artifact')
    // 后继看到的是直接前驱 Child（本层映射后）的返回名，不是最底层的 exhausted
    const dispatch = h.messages.at(-1)!.text
    assert.match(dispatch, /前驱节点 call-outer 已确认结果：stopped（kind: result）/)
    assert.doesNotMatch(dispatch, /exhausted/)
    // 每层恰好退出一次，终局工作单才带 exited
    for (const executionId of [innerCallerId, outerCallerId]) {
      const events = await h.store.events('ws', executionId)
      assert.equal(events.filter(event => event.type === 'child-returned').length, 1)
      assert.equal(events.filter(event => event.type === 'exited').length, 1)
    }
    assert.equal((await h.store.events('ws', innerLeafId)).filter(event => event.type === 'exited').length, 1)

    row = await h.accept('succeeded', 'fixed')
    assert.deepEqual(row.run.businessReturn, { name: 'planned', source: row.execution.executionId })
  } finally { h.close() }
})

test('v3 Child: 两层返回经重命名后到达 Root 业务终局，来源是最后一层 caller', async () => {
  const h = harness(config(nestedConfig({ return: 'aborted' })))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    const row = await h.accept('succeeded', 'inner artifact')
    assert.equal(row.run.status, 'completed')
    assert.deepEqual(row.run.callStack, [])
    assert.equal(row.execution.nodeId, 'call-outer', 'Root 终局工作单是实际裁决终局的 caller')
    assert.deepEqual(row.execution.returned, { kind: 'return', name: 'aborted', source: row.execution.executionId })
    assert.deepEqual(row.run.businessReturn, { name: 'aborted', source: row.execution.executionId })
    assert.equal(row.run.currentExecutionId, row.execution.executionId)
    const terminal = h.messages.at(-1)!.text
    assert.match(terminal, /业务终局：aborted/)
    assert.match(terminal, /经 Child 逐层映射：stopped/)
    assert.match(terminal, /inner artifact/)
    const status = await h.engine.status('ws', 'manager')
    assert.deepEqual(status.status.businessReturn, { name: 'aborted', source: row.execution.executionId })
    assert.equal(status.status.finalHandoffPreview, 'inner artifact', '唯一 handoff 原文保留')
  } finally { h.close() }
})

// ── C: 同事务与注入失败回滚 ─────────────────────────────────────────────────

test('v3 Child: 嵌套返回推进同事务，注入失败全部回滚且同 turn 重试恰好推进一次', async () => {
  const h = harness(config(nestedConfig({ node: 'fix' })))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    let row = await h.row()
    const beforeExecutionId = row.execution.executionId
    const beforeToken = row.execution.nodeToken
    const callerIds = row.run.callStack.slice(0, 2).map(frame => frame.executionId)
    const judge = h.judgeOf(await h.claim('succeeded', 'inner artifact'))

    h.armPutFailure()
    await assert.rejects(h.engine.handleJudgeClaim('ws', beforeToken, 'ACCEPT', 'verified', judge), /injected transaction failure/)
    row = await h.row()
    // 子终局结算、各层 caller 退出、frame pop、后继登记是一个事务：失败后一处都不能留下
    assert.equal(row.run.status, 'running')
    assert.equal(row.run.callStack.length, 3)
    assert.equal(row.run.currentExecutionId, beforeExecutionId)
    assert.equal(row.execution.phase, 'checking')
    assert.equal(row.execution.judgment, undefined)
    assert.equal(row.execution.successorId, undefined)
    for (const executionId of callerIds) {
      const callerRow = (await h.store.execution('ws', executionId))!
      assert.equal(callerRow.phase, 'working')
      assert.equal(callerRow.returned, undefined)
      assert.equal(callerRow.child?.result, undefined)
    }

    // 同 turn 重试：恰好推进一次，不产生重复后继
    assert.equal((await h.engine.handleJudgeClaim('ws', beforeToken, 'ACCEPT', 'verified', judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    row = await h.row()
    assert.equal(row.execution.nodeId, 'fix')
    assert.equal(row.run.callStack.length, 1)
    for (const executionId of callerIds) {
      assert.equal((await h.store.events('ws', executionId)).filter(event => event.type === 'exited').length, 1)
    }
  } finally { h.close() }
})

// ── D: 关库重开、重复/迟到回调 ──────────────────────────────────────────────

test('v3 Child: 关库重开不丢返回，重复/迟到回调不重复创建后继', async () => {
  const h = harness(config(childConfig()))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    let row = await h.row()
    const callerExecutionId = row.run.callStack[0]!.executionId
    const leafExecutionId = row.execution.executionId
    await h.claim('succeeded', 'child artifact')
    const leafToken = (await h.row()).execution.nodeToken
    const judge = h.judgeOf(await h.row())
    assert.equal((await h.engine.handleJudgeClaim('ws', leafToken, 'ACCEPT', 'verified', judge)).ok, true)
    await h.engine.handleTurnEnded('ws', judge)
    const advanced = await h.row()
    assert.equal(advanced.execution.nodeId, 'after')
    const successorId = advanced.execution.executionId

    // 迟到/重复回调：同一 Judge 再次提交与重复 turn 收口都不再推进
    assert.equal((await h.engine.handleJudgeClaim('ws', leafToken, 'ACCEPT', 'verified', judge)).ok, false)
    await h.engine.handleTurnEnded('ws', judge)
    const afterCallbacks = await h.row()
    assert.equal(afterCallbacks.execution.executionId, successorId)
    assert.equal(afterCallbacks.run.callStack.length, 1)

    h.reopen()
    row = await h.row()
    assert.equal(row.execution.executionId, successorId, '重开后后继与现场保留')
    const callerRow = (await h.store.execution('ws', callerExecutionId))!
    assert.deepEqual(callerRow.child?.result, { terminalExecutionId: leafExecutionId, handoff: 'child artifact' })
    assert.deepEqual(callerRow.returned, { kind: 'result', name: 'finished', source: callerExecutionId })
    // claim/Judge 资格未被破坏：后继仍可正常提交并推进到 Root 终局
    assert.equal((await h.accept('succeeded', 'delivered')).run.status, 'completed')
    assert.equal((await h.row()).run.businessReturn?.name, 'planned')
  } finally { h.close() }
})

test('v3 Child: 重启后恢复未进入的 Child caller 恰好进入一次，子流程栈顶不被重复压栈', async () => {
  const h = harness(config(childConfig()))
  try {
    await h.start('root request')
    const claimed = await h.claim('succeeded', 'plan approved')
    const judge = h.judgeOf(claimed)
    assert.equal((await h.engine.handleJudgeClaim('ws', claimed.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
    const registered = await h.row()
    assert.equal(registered.execution.nodeId, 'call-child')
    assert.equal(registered.execution.phase, 'ready')

    // 重启现场：未收口的父 Judge 由 Manager 确认后补收口，然后进入子流程（只压一次栈）
    h.reopen()
    await h.engine.handleRestartReconcile()
    const blocked = await h.row()
    assert.equal(blocked.run.status, 'blocked')
    assert.equal((await h.engine.handleResume('ws', blocked.execution.nodeToken, '核查已登记的 Child 调用。', 'manager', 'auto')).ok, true)
    const entered = await h.row()
    assert.equal(entered.run.callStack.length, 2)
    assert.equal(entered.execution.workflowId, 'child-a')
    assert.equal(entered.execution.input, 'plan approved')
    const callerRow = (await h.store.execution('ws', registered.execution.executionId))!
    assert.equal(callerRow.child?.executionId, entered.execution.executionId)
    assert.equal((await h.store.events('ws', callerRow.executionId)).filter(event => event.type === 'child-entered').length, 1)

    // 已进入子流程后，子流程栈顶按普通节点恢复，不重复压栈
    await h.engine.handleRestartReconcile()
    const childTop = await h.row()
    assert.equal((await h.engine.handleResume('ws', childTop.execution.nodeToken, '继续子流程工作。', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.run.callStack.length, 2)
    assert.equal(resumed.run.callStack[1]!.executionId, entered.execution.executionId)
    assert.equal(resumed.execution.workflowId, 'child-a')
  } finally { h.close() }
})

// ── E: 状态不变量拒绝 Child 调用层的 Actor/Judge 材料 ───────────────────────

test('v3 Child: 调用层工作单携带 Actor/Judge 材料会被状态校验拒绝', async () => {
  const h = harness(config(childConfig()))
  try {
    await h.start('root request')
    await h.accept('succeeded', 'plan approved')
    const row = await h.row()
    const callerRow = (await h.store.execution('ws', row.run.callStack[0]!.executionId))!
    assert.deepEqual(checkExecutionInvariants(row.run, callerRow), [])
    const withDispatch: NodeExecution = { ...structuredClone(callerRow), dispatch: { id: 'forged', settled: false } }
    assert.match(checkExecutionInvariants(row.run, withDispatch).join('; '), /child-workflow cannot carry Actor\/Judge\/Program materials/)
  } finally { h.close() }
})
