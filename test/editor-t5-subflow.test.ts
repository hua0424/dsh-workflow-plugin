/**
 * T5（#164）子流程与返回映射编辑：服务端 `src/editor/draft.ts` 行为。
 *
 * 真实链路：loadDraft（严格解析 + 静态校验）→ T5 op → validateDraft
 * （真实 validator）→ serializeConfig/loadDraft 往返。Actor/Program 复用
 * 已交付能力；Program 数据在 T5 操作下原样保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addActorNode,
  addChildNode,
  addFlowReturn,
  addNodeResult,
  addSubflow,
  businessEqual,
  deleteFlowReturn,
  deleteSubflow,
  findSubflowCallers,
  loadDraft,
  redo,
  renameFlowReturn,
  renameNode,
  renameSubflow,
  serializeConfig,
  serializeDraftLayout,
  setChildReturnTarget,
  setChildWorkflowId,
  setNodeResult,
  undo,
  validateDraft,
} from '../src/editor/draft.ts'

const MINI_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Build it.
judgeRole:
  persona: Judge it.
workflow:
  startNode: a
  returns: [done]
  nodes:
    a:
      execution: { type: actor-task, role: manager, instruction: Do it. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Done., target: { node: p } }
    p:
      execution: { type: builtin-program, programId: github.all-milestone-issues-complete }
      results:
        PASS: { criteria: All good., target: { return: done } }
        FAIL: { criteria: Bad state., target: { node: a } }
childWorkflows:
  review:
    startNode: r
    returns: [pass, fail]
    nodes:
      r:
        execution: { type: actor-task, role: developer, instruction: Review it. }
        checker: { checkerId: judge.claim-correct }
        results:
          pass: { criteria: Looks good., target: { return: pass } }
          fail: { criteria: Needs work., target: { return: fail } }
`

function freshSession() {
  const loaded = loadDraft('mini', MINI_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  return loaded.session
}

function mustOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}

/** 新增 Child 并把入口接到它（否则不可达，保存前校验会拦）。 */
function addWiredChild(session) {
  mustOk(addChildNode(session, undefined, 'c', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { node: 'p' } },
  }))
  mustOk(setNodeResult(session, undefined, 'a', 'ok', { target: { node: 'c' } }))
  return session
}

test('T5: 新增子流程（最小合法起点）+ 布局坐标，可直接保存', () => {
  const session = freshSession()
  mustOk(addSubflow(session, 'qa'))
  const def = session.draft.config.childWorkflows['qa']
  assert.equal(def.startNode, 'main')
  assert.deepEqual(def.returns, ['done'])
  assert.deepEqual(session.draft.layout.children['qa']['main'], { x: 40, y: 40 })
  assert.equal(session.draft.dirtyBusiness, true)
  assert.equal(session.draft.dirtyLayout, true)
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
})

test('T5: 新增子流程拒绝非法/重复/与主流程同名 id', () => {
  const session = freshSession()
  assert.equal(addSubflow(session, 'Bad').ok, false)
  assert.equal(addSubflow(session, 'review').ok, false)
  const sameAsRoot = addSubflow(session, 'mini')
  assert.equal(sameAsRoot.ok, false, JSON.stringify(sameAsRoot))
  assert.equal(session.draft.config.childWorkflows['Bad'], undefined)
  assert.equal(validateDraft(session).ok, true)
})

test('T5: 新增 Child 节点（无 results/Checker）+ 接线后保存前校验通过', () => {
  const session = freshSession()
  mustOk(addChildNode(session, undefined, 'c', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { node: 'p' } },
  }))
  const node = session.draft.config.workflow.nodes['c']
  assert.equal(node.execution.type, 'child-workflow')
  assert.equal(node.execution.workflowId, 'review')
  assert.ok(!('results' in node), 'Child 不声明 results')
  assert.ok(!('checker' in node), 'Child 不配置 Checker')
  assert.deepEqual(node.onReturn, { pass: { return: 'done' }, fail: { node: 'p' } })
  assert.deepEqual(session.draft.layout.main['c'], { x: 480, y: 40 })
  // 尚无入口指向 c：不可达由保存前校验明确诊断（不静默）。
  assert.equal(validateDraft(session).ok, false)
  mustOk(setNodeResult(session, undefined, 'a', 'ok', { target: { node: 'c' } }))
  assert.equal(validateDraft(session).ok, true)
})

test('T5: 新增 Child 拒绝未知/外部/root/自调用与间接调用环', () => {
  const session = freshSession()
  assert.equal(addChildNode(session, undefined, 'c1', { workflowId: 'nope', targets: {} }).ok, false)
  const root = addChildNode(session, undefined, 'c2', { workflowId: 'mini', targets: {} })
  assert.equal(root.ok, false, JSON.stringify(root))
  const self = addChildNode(session, 'review', 'self', { workflowId: 'review', targets: { pass: { return: 'pass' }, fail: { return: 'fail' } } })
  assert.equal(self.ok, false, JSON.stringify(self))
  // 间接环：review → inner 后，inner 再调 review 必须拒绝。
  mustOk(addSubflow(session, 'inner'))
  mustOk(addChildNode(session, 'review', 'to-inner', { workflowId: 'inner', targets: { done: { return: 'pass' } } }))
  const cycle = addChildNode(session, 'inner', 'to-review', { workflowId: 'review', targets: { pass: { return: 'done' }, fail: { return: 'done' } } })
  assert.equal(cycle.ok, false, JSON.stringify(cycle))
  assert.equal(session.draft.config.workflow.nodes['c1'], undefined)
})

test('T5: 新增 Child 映射须一次配齐（缺键/多余键/非法目标拒绝）', () => {
  const session = freshSession()
  const missing = addChildNode(session, undefined, 'c', { workflowId: 'review', targets: { pass: { return: 'done' } } })
  assert.equal(missing.ok, false, JSON.stringify(missing))
  const extra = addChildNode(session, undefined, 'c', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { node: 'a' }, skip: { return: 'done' } },
  })
  assert.equal(extra.ok, false, JSON.stringify(extra))
  const badTarget = addChildNode(session, undefined, 'c', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { node: 'ghost' } },
  })
  assert.equal(badTarget.ok, false, JSON.stringify(badTarget))
  const selfLoop = addChildNode(session, undefined, 'c', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { node: 'c' } },
  })
  assert.equal(selfLoop.ok, false, JSON.stringify(selfLoop))
  assert.equal(session.draft.config.workflow.nodes['c'], undefined)
})

test('T5: 换被调用方保留原映射（错配由保存前校验诊断，不静默猜测）', () => {
  const session = addWiredChild(freshSession())
  mustOk(addSubflow(session, 'qa'))
  mustOk(setChildWorkflowId(session, undefined, 'c', 'qa'))
  assert.deepEqual(
    session.draft.config.workflow.nodes['c'].onReturn,
    { pass: { return: 'done' }, fail: { node: 'p' } },
  )
  const blocked = validateDraft(session)
  assert.equal(blocked.ok, false, JSON.stringify(blocked))
  assert.match(JSON.stringify(blocked), /missing mappings|unknown returns/)
  // 补齐新合同后通过（删旧键、增新键；p 改由 a 的第二结果保持可达）。
  mustOk(setChildReturnTarget(session, undefined, 'c', 'fail', undefined))
  mustOk(setChildReturnTarget(session, undefined, 'c', 'pass', undefined))
  mustOk(setChildReturnTarget(session, undefined, 'c', 'done', { return: 'done' }))
  mustOk(addNodeResult(session, undefined, 'a', 'back', 'Back to program.', { node: 'p' }))
  assert.equal(validateDraft(session).ok, true)
  // 非 Child 节点拒绝；未知/root/成环目标拒绝；同值 noop。
  assert.equal(setChildWorkflowId(session, undefined, 'a', 'qa').ok, false)
  assert.equal(setChildWorkflowId(session, undefined, 'c', 'nope').ok, false)
  assert.equal(setChildWorkflowId(session, undefined, 'c', 'mini').ok, false)
  mustOk(setChildWorkflowId(session, undefined, 'c', 'qa'))
})

test('T5: 单键映射设置/删除守卫（合同外键、悬空调用、自环拒绝）', () => {
  const session = addWiredChild(freshSession())
  // 合同外键拒绝。
  assert.equal(setChildReturnTarget(session, undefined, 'c', 'skip', { return: 'done' }).ok, false)
  // 直接自环拒绝，多节点回路允许（c.fail → a 已是回路的一部分）。
  assert.equal(setChildReturnTarget(session, undefined, 'c', 'pass', { node: 'c' }).ok, false)
  mustOk(setChildReturnTarget(session, undefined, 'c', 'pass', { node: 'a' }))
  assert.equal(validateDraft(session).ok, true)
  // 删除不存在的键拒绝；调用方悬空后编辑映射拒绝。
  assert.equal(setChildReturnTarget(session, undefined, 'c', 'skip', undefined).ok, false)
  mustOk(deleteSubflow(session, 'review'))
  const dangling = setChildReturnTarget(session, undefined, 'c', 'pass', { return: 'done' })
  assert.equal(dangling.ok, false, JSON.stringify(dangling))
})

test('T5: 被调用方增删返回后调用方映射未完成（保存阻止，补映射恢复）', () => {
  const session = addWiredChild(freshSession())
  assert.equal(validateDraft(session).ok, true)
  mustOk(addFlowReturn(session, 'review', 'skip'))
  // 新增返回同时影响被调用方覆盖与调用方映射：先在被调用方内补可达路径，
  // 剩余 unmapped 由调用方补映射（两处诊断都不静默）。
  mustOk(addNodeResult(session, 'review', 'r', 'retry', 'Try again.', { return: 'skip' }))
  const blocked = validateDraft(session)
  assert.equal(blocked.ok, false, JSON.stringify(blocked))
  assert.match(JSON.stringify(blocked), /missing mappings for returns skip/)
  mustOk(setChildReturnTarget(session, undefined, 'c', 'skip', { return: 'done' }))
  assert.equal(validateDraft(session).ok, true)
  mustOk(deleteFlowReturn(session, 'review', 'fail'))
  const extra = validateDraft(session)
  assert.equal(extra.ok, false, JSON.stringify(extra))
  assert.match(JSON.stringify(extra), /unknown returns fail/)
  mustOk(setChildReturnTarget(session, undefined, 'c', 'fail', undefined))
  mustOk(setNodeResult(session, 'review', 'r', 'fail', { target: { return: 'pass' } }))
  // fail 映射删除后 p 改由 a 的第二结果保持可达。
  mustOk(addNodeResult(session, undefined, 'a', 'back', 'Back to program.', { node: 'p' }))
  assert.equal(validateDraft(session).ok, true)
})

test('T5: 子流程改名同步调用方与布局，返回改名同步映射键', () => {
  const session = addWiredChild(freshSession())
  mustOk(setChildReturnTarget(session, undefined, 'c', 'pass', { node: 'a' }))
  const renamed = mustOk(renameSubflow(session, 'review', 'qa'))
  assert.equal(renamed.updated, 1)
  assert.equal(session.draft.config.workflow.nodes['c'].execution.workflowId, 'qa')
  // onReturn 键只关联返回名，子流程改名不影响。
  assert.deepEqual(
    session.draft.config.workflow.nodes['c'].onReturn,
    { pass: { node: 'a' }, fail: { node: 'p' } },
  )
  assert.deepEqual(session.draft.layout.children['qa'], { r: { x: 40, y: 40 } })
  assert.equal(session.draft.layout.children['review'], undefined)
  assert.equal(validateDraft(session).ok, true)
  // 返回改名同步调用方映射键。
  mustOk(renameFlowReturn(session, 'qa', 'pass', 'passed'))
  assert.deepEqual(
    session.draft.config.workflow.nodes['c'].onReturn,
    { passed: { node: 'a' }, fail: { node: 'p' } },
  )
  assert.equal(validateDraft(session).ok, true)
  // 非法改名拒绝。
  assert.equal(renameSubflow(session, 'qa', 'Bad').ok, false)
  assert.equal(renameSubflow(session, 'qa', 'mini').ok, false)
  assert.equal(renameSubflow(session, 'nope', 'qa2').ok, false)
})

test('T5: 删除子流程保留悬空引用（诊断并阻止保存），调用方位置可查', () => {
  const session = addWiredChild(freshSession())
  const callers = findSubflowCallers(session, 'review')
  assert.deepEqual(callers, [{ flowId: undefined, node: 'c' }])
  assert.deepEqual(findSubflowCallers(session, 'nope'), [])
  mustOk(deleteSubflow(session, 'review'))
  assert.equal(session.draft.config.childWorkflows['review'], undefined)
  assert.equal(session.draft.layout.children['review'], undefined)
  // 调用方引用保留悬空，不静默重定向。
  assert.equal(session.draft.config.workflow.nodes['c'].execution.workflowId, 'review')
  const blocked = validateDraft(session)
  assert.equal(blocked.ok, false, JSON.stringify(blocked))
  assert.match(JSON.stringify(blocked), /references unknown child workflow/)
  assert.equal(deleteSubflow(session, 'review').ok, false)
})

test('T5: 多层 Child、同名节点隔离与节点改名同步映射值', () => {
  const session = freshSession()
  mustOk(addSubflow(session, 'outer'))
  // 同名节点隔离：主流程的 a 与各子流程节点互不干扰。
  mustOk(renameNode(session, 'outer', 'main', 'entry'))
  assert.ok('a' in session.draft.config.workflow.nodes)
  assert.ok('entry' in session.draft.config.childWorkflows['outer'].nodes)
  assert.ok(!('main' in session.draft.config.childWorkflows['outer'].nodes))
  mustOk(addActorNode(session, 'outer', 'helper', {
    role: 'developer',
    instruction: 'Help the entry.',
    resultName: 'ok',
    resultCriteria: 'Helped.',
    target: { node: 'entry' },
  }))
  // 多层调用：outer 经 Child 调用 review（entry → helper → call → 返回）。
  mustOk(addChildNode(session, 'outer', 'call', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { return: 'done' } },
  }))
  mustOk(setNodeResult(session, 'outer', 'helper', 'ok', { target: { node: 'call' } }))
  mustOk(setNodeResult(session, 'outer', 'entry', 'done', { target: { node: 'helper' } }))
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  // 主流程节点改名同步 Child 映射值（同流程引用；无关值不动）。
  const wired = addWiredChild(session)
  mustOk(setChildReturnTarget(wired, undefined, 'c', 'pass', { node: 'a' }))
  mustOk(renameNode(wired, undefined, 'a', 'alpha'))
  assert.deepEqual(wired.draft.config.workflow.nodes['c'].onReturn['pass'], { node: 'alpha' })
  assert.deepEqual(wired.draft.config.workflow.nodes['c'].onReturn['fail'], { node: 'p' })
})

test('T5: 撤销/重做覆盖子流程与映射操作', () => {
  const session = addWiredChild(freshSession())
  const before = JSON.stringify(session.draft.config)
  mustOk(addSubflow(session, 'qa'))
  mustOk(setChildReturnTarget(session, undefined, 'c', 'pass', { node: 'a' }))
  assert.equal(undo(session), true)
  assert.equal(undo(session), true)
  assert.equal(JSON.stringify(session.draft.config), before)
  assert.equal(redo(session), true)
  assert.equal(redo(session), true)
  assert.deepEqual(session.draft.config.workflow.nodes['c'].onReturn['pass'], { node: 'a' })
  assert.ok('qa' in (session.draft.config.childWorkflows ?? {}))
})

test('T5: 演示全链路（建子流程→多返回→调用方路由→保存→重载恢复）', () => {
  const session = freshSession()
  mustOk(addSubflow(session, 'qa'))
  mustOk(addFlowReturn(session, 'qa', 'skip'))
  // 子流程内补线：done/skip 返回各须有可达路径。
  mustOk(addActorNode(session, 'qa', 'extra', {
    role: 'developer',
    instruction: 'Cover the skip return.',
    resultName: 'ok',
    resultCriteria: 'Skipped.',
    target: { return: 'skip' },
  }))
  mustOk(addNodeResult(session, 'qa', 'extra', 'alright', 'All done.', { return: 'done' }))
  mustOk(setNodeResult(session, 'qa', 'main', 'done', { target: { node: 'extra' } }))
  mustOk(addChildNode(session, undefined, 'c', {
    workflowId: 'qa',
    targets: { done: { return: 'done' }, skip: { node: 'p' } },
  }))
  mustOk(setNodeResult(session, undefined, 'a', 'ok', { target: { node: 'c' } }))
  assert.equal(validateDraft(session).ok, true)
  // 保存→重载：业务与布局完整恢复。
  const yaml = serializeConfig(session.draft.config)
  const layoutText = serializeDraftLayout(session)
  const reloaded = loadDraft('mini', yaml, layoutText)
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.equal(businessEqual(reloaded.session.draft.config, session.draft.config), true)
  assert.deepEqual(reloaded.session.draft.layout, session.draft.layout)
})

test('T5: 子流程操作不触碰 Program 数据（原样保留）', () => {
  const session = freshSession()
  const programBefore = JSON.stringify(session.draft.config.workflow.nodes['p'])
  mustOk(addSubflow(session, 'qa'))
  mustOk(renameSubflow(session, 'qa', 'qb'))
  mustOk(addChildNode(session, 'qb', 'call', {
    workflowId: 'review',
    targets: { pass: { return: 'done' }, fail: { return: 'done' } },
  }))
  mustOk(setNodeResult(session, 'qb', 'main', 'done', { target: { node: 'call' } }))
  mustOk(deleteSubflow(session, 'qb'))
  assert.equal(JSON.stringify(session.draft.config.workflow.nodes['p']), programBefore)
  assert.equal(validateDraft(session).ok, true)
})
