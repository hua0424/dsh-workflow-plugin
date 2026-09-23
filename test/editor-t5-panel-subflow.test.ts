/**
 * T5（#164）面板侧子流程与返回映射变迁：`web-client/src/edits.js` 镜像行为，
 * 并与服务端 `draft.ts` 同操作对比钉住一致（防手抄漂移）。
 *
 * 被调用方合同来自草稿自身（子流程 returns），无外部 catalog；保存前语义
 * 走服务端 validate RPC（此处用直引 validateDraft 断言闭环）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addChildNodeEdit, addSubflowEdit, deleteNodeEdit, deleteSubflowEdit,
  findSubflowCallersEdit, minimalFlowDefOf,
  redoEdit, renameNodeEdit, renameSubflowEdit,
  setChildReturnTargetEdit, setChildWorkflowIdEdit, setNodeResultEdit,
  undoEdit,
} from '../web-client/src/edits.js'
import {
  addChildNode, addSubflow, deleteNode, deleteSubflow,
  findSubflowCallers, loadDraft,
  redo, renameNode, renameSubflow,
  setChildReturnTarget, setChildWorkflowId, setNodeResult,
  undo, validateDraft,
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

function serverSession() {
  const loaded = loadDraft('mini', MINI_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  return loaded.session
}

function freshPanel() {
  const session = serverSession()
  return {
    draft: JSON.parse(JSON.stringify(session.draft.config)),
    positions: JSON.parse(JSON.stringify({
      main: session.draft.layout.main,
      children: session.draft.layout.children,
    })),
    personaInput: '',
    workflowId: 'mini',
    dirtyBusiness: false,
    dirtyLayout: false,
    past: [],
    future: [],
    saveResult: null,
    problems: [],
  }
}

function mustOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result))
  if (!result.ok || result.state === undefined) throw new Error('unreachable')
  return result.state
}

const CHILD_FIELDS = {
  workflowId: 'review',
  targets: { pass: { return: 'done' }, fail: { node: 'p' } },
}

test('T5-panel: 子流程增删改名镜像行为（含调用方位置查询）', () => {
  let panel = freshPanel()
  assert.equal(addSubflowEdit(panel, 'Bad').ok, false)
  assert.equal(addSubflowEdit(panel, 'review').ok, false)
  assert.equal(addSubflowEdit(panel, 'mini').ok, false)
  panel = mustOk(addSubflowEdit(panel, 'qa'))
  assert.deepEqual(panel.draft.childWorkflows['qa'], minimalFlowDefOf())
  assert.deepEqual(panel.positions.children['qa'], { main: { x: 40, y: 40 } })
  assert.equal(panel.dirtyBusiness, true)
  assert.deepEqual(findSubflowCallersEdit(panel.draft, 'qa'), [])

  panel = mustOk(addChildNodeEdit(panel, null, 'c', CHILD_FIELDS))
  assert.deepEqual(findSubflowCallersEdit(panel.draft, 'review'), [{ flowId: null, node: 'c' }])
  const renamed = renameSubflowEdit(panel, 'review', 'qa2')
  assert.equal(renamed.ok, true)
  if (!renamed.ok || renamed.state === undefined) throw new Error('unreachable')
  assert.equal(renamed.updated, 1)
  panel = renamed.state
  assert.equal(panel.draft.workflow.nodes['c'].execution.workflowId, 'qa2')
  assert.equal(panel.draft.childWorkflows['review'], undefined)
  assert.ok(panel.positions.children['qa2'] !== undefined)
  assert.equal(panel.positions.children['review'], undefined)
  assert.equal(renameSubflowEdit(panel, 'qa2', 'qa2').noop, true)
  assert.equal(renameSubflowEdit(panel, 'qa2', 'qa').ok, false)
  assert.equal(renameSubflowEdit(panel, 'qa2', 'mini').ok, false)

  panel = mustOk(deleteSubflowEdit(panel, 'qa2'))
  assert.equal(panel.draft.childWorkflows['qa2'], undefined)
  assert.equal(panel.positions.children['qa2'], undefined)
  // 调用方引用保留悬空（与服务端同口径）。
  assert.equal(panel.draft.workflow.nodes['c'].execution.workflowId, 'qa2')
  assert.equal(deleteSubflowEdit(panel, 'qa2').ok, false)
})

test('T5-panel: Child 新增/换调用方/映射镜像行为（含守卫）', () => {
  let panel = freshPanel()
  assert.equal(addChildNodeEdit(panel, null, 'c', { workflowId: 'nope', targets: {} }).ok, false)
  assert.equal(addChildNodeEdit(panel, null, 'c', { workflowId: 'mini', targets: {} }).ok, false)
  assert.equal(addChildNodeEdit(panel, 'review', 'self', {
    workflowId: 'review',
    targets: { pass: { return: 'pass' }, fail: { return: 'fail' } },
  }).ok, false)
  assert.equal(addChildNodeEdit(panel, null, 'c', {
    workflowId: 'review', targets: { pass: { return: 'done' } },
  }).ok, false)
  panel = mustOk(addChildNodeEdit(panel, null, 'c', CHILD_FIELDS))
  const node = panel.draft.workflow.nodes['c']
  assert.equal(node.execution.type, 'child-workflow')
  assert.ok(!('results' in node) && !('checker' in node))
  assert.deepEqual(node.onReturn, CHILD_FIELDS.targets)
  assert.deepEqual(panel.positions.main['c'], { x: 480, y: 40 })

  assert.equal(setChildWorkflowIdEdit(panel, null, 'a', 'review').ok, false)
  assert.equal(setChildWorkflowIdEdit(panel, null, 'c', 'nope').ok, false)
  assert.equal(setChildWorkflowIdEdit(panel, null, 'c', 'review').noop, true)
  panel = mustOk(addSubflowEdit(panel, 'qa'))
  panel = mustOk(setChildWorkflowIdEdit(panel, null, 'c', 'qa'))
  assert.deepEqual(panel.draft.workflow.nodes['c'].onReturn, CHILD_FIELDS.targets)

  assert.equal(setChildReturnTargetEdit(panel, null, 'c', 'skip', { return: 'done' }).ok, false)
  assert.equal(setChildReturnTargetEdit(panel, null, 'c', 'pass', { node: 'c' }).ok, false)
  panel = mustOk(setChildReturnTargetEdit(panel, null, 'c', 'done', { return: 'done' }))
  panel = mustOk(setChildReturnTargetEdit(panel, null, 'c', 'pass', undefined))
  panel = mustOk(setChildReturnTargetEdit(panel, null, 'c', 'fail', undefined))
  assert.deepEqual(panel.draft.workflow.nodes['c'].onReturn, { done: { return: 'done' } })
  assert.equal(setChildReturnTargetEdit(panel, null, 'c', 'fail', undefined).ok, false)
})

test('T5-panel: 服务端↔面板同操作对比（子流程/调用方/映射/改名/删除，含 reason 文本）', () => {
  const server = serverSession()
  let panel = freshPanel()
  const applyBoth = (serverOp, panelOp) => {
    const serverResult = serverOp()
    const panelResult = panelOp()
    assert.equal(panelResult.ok, serverResult.ok, JSON.stringify({ serverResult, panelResult }))
    if (!panelResult.ok || panelResult.state === undefined) {
      assert.equal(panelResult.reason, serverResult.reason)
      return
    }
    assert.equal(serverResult.ok, true)
    panel = panelResult.state
  }
  applyBoth(
    () => addSubflow(server, 'qa'),
    () => addSubflowEdit(panel, 'qa'),
  )
  assert.deepEqual(server.draft.config.childWorkflows['qa'], panel.draft.childWorkflows['qa'])
  applyBoth(
    () => addSubflow(server, 'review'),
    () => addSubflowEdit(panel, 'review'),
  )
  applyBoth(
    () => addChildNode(server, undefined, 'c', CHILD_FIELDS),
    () => addChildNodeEdit(panel, null, 'c', CHILD_FIELDS),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['c'], panel.draft.workflow.nodes['c'])
  applyBoth(
    () => addChildNode(server, undefined, 'd', { workflowId: 'review', targets: { pass: { return: 'done' } } }),
    () => addChildNodeEdit(panel, null, 'd', { workflowId: 'review', targets: { pass: { return: 'done' } } }),
  )
  applyBoth(
    () => setChildWorkflowId(server, undefined, 'c', 'qa'),
    () => setChildWorkflowIdEdit(panel, null, 'c', 'qa'),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['c'], panel.draft.workflow.nodes['c'])
  applyBoth(
    () => setChildReturnTarget(server, undefined, 'c', 'done', { return: 'done' }),
    () => setChildReturnTargetEdit(panel, null, 'c', 'done', { return: 'done' }),
  )
  applyBoth(
    () => setChildReturnTarget(server, undefined, 'c', 'pass', undefined),
    () => setChildReturnTargetEdit(panel, null, 'c', 'pass', undefined),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['c'], panel.draft.workflow.nodes['c'])
  // 拒绝口径一致（含 reason 文本）。
  applyBoth(
    () => setChildReturnTarget(server, undefined, 'c', 'skip', { return: 'done' }),
    () => setChildReturnTargetEdit(panel, null, 'c', 'skip', { return: 'done' }),
  )
  applyBoth(
    () => addChildNode(server, 'qa', 'loop', { workflowId: 'qa', targets: { done: { return: 'done' } } }),
    () => addChildNodeEdit(panel, 'qa', 'loop', { workflowId: 'qa', targets: { done: { return: 'done' } } }),
  )
  // 子流程改名双边同步调用方。
  const serverRenamed = renameSubflow(server, 'review', 'qa2')
  const panelRenamed = renameSubflowEdit(panel, 'review', 'qa2')
  assert.equal(panelRenamed.ok, serverRenamed.ok)
  if (panelRenamed.ok && serverRenamed.ok) {
    assert.equal(panelRenamed.updated, serverRenamed.updated)
    panel = panelRenamed.state
    assert.deepEqual(server.draft.config.childWorkflows, panel.draft.childWorkflows)
    assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  }
  // 通用节点改名同步映射值；删除子流程双边悬空一致。
  applyBoth(
    () => renameNode(server, undefined, 'a', 'alpha'),
    () => renameNodeEdit(panel, null, 'a', 'alpha'),
  )
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  applyBoth(
    () => deleteSubflow(server, 'qa2'),
    () => deleteSubflowEdit(panel, 'qa2'),
  )
  assert.deepEqual(server.draft.config.childWorkflows, panel.draft.childWorkflows)
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  // 调用方位置查询一致。
  assert.deepEqual(findSubflowCallers(server, 'qa2'), findSubflowCallersEdit(panel.draft, 'qa2'))
})

test('T5-panel: 镜像撤销/重做与服务端一致', () => {
  const server = serverSession()
  let panel = freshPanel()
  assert.equal(addSubflow(server, 'qa').ok, true)
  panel = mustOk(addSubflowEdit(panel, 'qa'))
  assert.equal(addChildNode(server, undefined, 'c', CHILD_FIELDS).ok, true)
  panel = mustOk(addChildNodeEdit(panel, null, 'c', CHILD_FIELDS))
  assert.equal(undo(server), true)
  const rewound = undoEdit(panel)
  assert.ok(rewound !== null)
  if (rewound === null) throw new Error('unreachable')
  panel = rewound
  assert.deepEqual(server.draft.config, panel.draft)
  assert.equal(redo(server), true)
  panel = redoEdit(panel)
  assert.deepEqual(server.draft.config, panel.draft)
})

test('T5-panel: 面板草稿经服务端 validate 闭环（未完成映射阻止保存）', () => {
  let panel = freshPanel()
  panel = mustOk(addChildNodeEdit(panel, null, 'c', CHILD_FIELDS))
  panel = mustOk(setNodeResultEdit(panel, null, 'a', 'ok', { target: { node: 'c' } }))
  // 面板草稿直送服务端 validate（保存按钮同链）：接线后通过。
  const server = serverSession()
  assert.equal(addChildNode(server, undefined, 'c', CHILD_FIELDS).ok, true)
  assert.equal(setNodeResult(server, undefined, 'a', 'ok', { target: { node: 'c' } }).ok, true)
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  assert.equal(validateDraft(server).ok, true)
  // 删映射键即未完成：面板侧同样可删，服务端 validate 阻止保存。
  panel = mustOk(setChildReturnTargetEdit(panel, null, 'c', 'fail', undefined))
  assert.equal(setChildReturnTarget(server, undefined, 'c', 'fail', undefined).ok, true)
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  const blocked = validateDraft(server)
  assert.equal(blocked.ok, false, JSON.stringify(blocked))
  assert.match(JSON.stringify(blocked), /missing mappings for returns fail/)
})
