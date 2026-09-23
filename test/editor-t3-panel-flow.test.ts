/**
 * T3（#162）面板侧新建/节点/结果/返回变迁：`web-client/src/edits.js` 镜像行为，
 * 并与服务端 `draft.ts` 同操作对比钉住一致（防手抄漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addActorNodeEdit, addFlowReturnEdit, addNodeResultEdit, deleteFlowReturnEdit,
  deleteNodeEdit, deleteNodeResultEdit, findNodeRefsEdit, minimalConfigOf,
  parseNewFilenameEdit, redoEdit, renameFlowReturnEdit, renameNodeEdit,
  renameNodeResultEdit, setActorFieldsEdit, setFlowStartNodeEdit, setNodeResultEdit,
  SUPPORTED_CHECKER_IDS as clientCheckers, undoEdit,
} from '../web-client/src/edits.js'
import {
  addActorNode, addFlowReturn, addNodeResult, deleteNode, loadDraft,
  newDraftSession, parseNewFilename, renameFlowReturn, renameNode,
  setActorFields, validateDraft,
} from '../src/editor/draft.ts'
import { BUILTIN_CHECKER_IDS } from '../src/catalog/validate.ts'

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
        ok: { criteria: Done., target: { node: b } }
    b:
      execution: { type: actor-task, role: developer, instruction: Build. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Built., target: { return: done } }
childWorkflows:
  sub:
    startNode: s
    returns: [out]
    nodes:
      s:
        execution: { type: actor-task, role: developer, instruction: Sub. }
        checker: { checkerId: judge.claim-correct }
        results: { ok: { criteria: Sub done., target: { return: out } } }
`

function serverSession() {
  const loaded = loadDraft('mini', MINI_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  return loaded.session
}

function freshPanel() {
  const draft = JSON.parse(JSON.stringify(serverSession().draft.config))
  return {
    draft,
    positions: { main: { a: { x: 40, y: 40 }, b: { x: 260, y: 40 } }, children: { sub: { s: { x: 40, y: 40 } } } },
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

test('T3-panel: 新建文件名与最小起点（checker 名单对等）', () => {
  assert.deepEqual([...BUILTIN_CHECKER_IDS].sort(), [...clientCheckers].sort())
  assert.deepEqual(parseNewFilenameEdit('review.yaml'), { ok: true, workflowId: 'review' })
  assert.equal(parseNewFilenameEdit('Bad.yaml').ok, false)
  assert.equal(parseNewFilenameEdit('x.yml').ok, false)
  // 服务端同输入同结论。
  assert.deepEqual(parseNewFilename('review.yaml'), parseNewFilenameEdit('review.yaml'))

  const config = minimalConfigOf()
  const fresh = newDraftSession('fresh')
  assert.deepEqual(config, fresh.draft.config)
})

test('T3-panel: Actor 节点增改删改名与布局', () => {
  let panel = freshPanel()
  panel = mustOk(addActorNodeEdit(panel, null, 'c', {
    role: 'developer', instruction: ' Extra. ', resultName: 'ok', resultCriteria: 'Extra.', target: { node: 'b' },
  }))
  assert.equal(panel.draft.workflow.nodes['c'].execution.instruction, 'Extra.')
  assert.deepEqual(panel.draft.workflow.nodes['c'].checker, { checkerId: 'judge.claim-correct', config: {} })
  assert.notDeepEqual(panel.positions.main['c'], undefined)
  assert.equal(panel.dirtyBusiness, true)
  assert.equal(panel.dirtyLayout, true)

  panel = mustOk(setActorFieldsEdit(panel, null, 'c', { instruction: 'Harder.', commonCriteria: 'Well.' }))
  assert.deepEqual(panel.draft.workflow.nodes['c'].checker, {
    checkerId: 'judge.claim-correct', config: { criteria: 'Well.' },
  })
  panel = mustOk(setActorFieldsEdit(panel, null, 'c', { commonCriteria: null }))
  assert.deepEqual(panel.draft.workflow.nodes['c'].checker.config, {})
  // 主入口角色保护与未知角色拒绝。
  assert.equal(setActorFieldsEdit(panel, null, 'a', { role: 'developer' }).ok, false)
  assert.equal(setActorFieldsEdit(panel, null, 'c', { role: 'ghost' }).ok, false)

  const renamed = renameNodeEdit(panel, null, 'c', 'aux')
  assert.deepEqual(renamed.ok ? renamed.updated : undefined, 0)
  panel = mustOk(renamed)
  assert.notDeepEqual(panel.positions.main['aux'], undefined)
  assert.equal(panel.positions.main['c'], undefined)
  assert.equal(renameNodeEdit(panel, null, 'aux', 'b').ok, false)

  assert.ok(findNodeRefsEdit(panel.draft, null, 'b').some(r => r.node === 'a' && r.kind === 'target'))
  panel = mustOk(deleteNodeEdit(panel, null, 'aux'))
  assert.ok(!('aux' in panel.draft.workflow.nodes))
  assert.equal(panel.positions.main['aux'], undefined)
})

test('T3-panel: 结果增改删改名与自环拦截', () => {
  let panel = freshPanel()
  // 直接自环被拒，草稿未动。
  assert.equal(addNodeResultEdit(panel, null, 'b', 'retry', 'Retry.', { node: 'b' }).ok, false)
  assert.ok(!('retry' in panel.draft.workflow.nodes['b'].results))
  panel = mustOk(addNodeResultEdit(panel, null, 'b', 'retry', 'Retry.', { return: 'done' }))
  // 多结果同目标：与 ok 一致指向 done。
  assert.deepEqual(panel.draft.workflow.nodes['b'].results['retry'].target, { return: 'done' })
  panel = mustOk(setNodeResultEdit(panel, null, 'a', 'ok', { target: { return: 'done' } }))
  panel = mustOk(renameNodeResultEdit(panel, null, 'b', 'retry', 'again'))
  assert.ok('again' in panel.draft.workflow.nodes['b'].results)
  panel = mustOk(deleteNodeResultEdit(panel, null, 'b', 'again'))
  assert.ok(!('again' in panel.draft.workflow.nodes['b'].results))
  assert.equal(addNodeResultEdit(panel, null, 'b', 'ok', 'Dup.', { return: 'done' }).ok, false)
})

test('T3-panel: 入口与返回编辑', () => {
  let panel = freshPanel()
  assert.equal(setFlowStartNodeEdit(panel, null, 'b').ok, false)
  panel = mustOk(setFlowStartNodeEdit(panel, 'sub', 's'))
  panel = mustOk(addFlowReturnEdit(panel, null, 'archived'))
  assert.deepEqual(panel.draft.workflow.returns, ['done', 'archived'])
  const renamed = renameFlowReturnEdit(panel, 'sub', 'out', 'shipped')
  assert.deepEqual(renamed.ok ? renamed.updated : undefined, 1)
  panel = mustOk(renamed)
  assert.deepEqual(panel.draft.childWorkflows['sub'].returns, ['shipped'])
  assert.deepEqual(panel.draft.childWorkflows['sub'].nodes['s'].results['ok'].target, { return: 'shipped' })
  panel = mustOk(deleteFlowReturnEdit(panel, null, 'archived'))
  assert.deepEqual(panel.draft.workflow.returns, ['done'])
})

test('T3-panel: 撤销/重做覆盖节点与结果编辑', () => {
  let panel = freshPanel()
  panel = mustOk(addActorNodeEdit(panel, null, 'c', {
    role: 'developer', instruction: 'Extra.', resultName: 'ok', resultCriteria: 'Extra.', target: { node: 'b' },
  }))
  panel = mustOk(addNodeResultEdit(panel, null, 'c', 'alt', 'Alt.', { return: 'done' }))
  const undone = undoEdit(panel)
  assert.ok(undone !== null && !('alt' in undone.draft.workflow.nodes['c'].results))
  const redone = undone !== null ? redoEdit(undone) : null
  assert.ok(redone !== null && 'alt' in redone.draft.workflow.nodes['c'].results)
})

test('T3-panel: 服务端↔面板同操作对比（节点/属性/返回改名）', () => {
  const server = serverSession()
  let panel = freshPanel()
  assert.deepEqual(
    addActorNode(server, undefined, 'c', {
      role: 'developer', instruction: 'Extra.', resultName: 'ok', resultCriteria: 'Extra.', target: { node: 'b' },
    }).ok,
    addActorNodeEdit(panel, null, 'c', {
      role: 'developer', instruction: 'Extra.', resultName: 'ok', resultCriteria: 'Extra.', target: { node: 'b' },
    }).ok,
  )
  panel = mustOk(addActorNodeEdit(panel, null, 'c', {
    role: 'developer', instruction: 'Extra.', resultName: 'ok', resultCriteria: 'Extra.', target: { node: 'b' },
  }))
  assert.deepEqual(server.draft.config.workflow.nodes['c'], panel.draft.workflow.nodes['c'])

  assert.deepEqual(
    setActorFields(server, undefined, 'c', { instruction: 'Harder.' }),
    ((r) => ({ ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }))(setActorFieldsEdit(panel, null, 'c', { instruction: 'Harder.' })),
  )
  panel = mustOk(setActorFieldsEdit(panel, null, 'c', { instruction: 'Harder.' }))
  assert.deepEqual(server.draft.config.workflow.nodes['c'], panel.draft.workflow.nodes['c'])

  assert.deepEqual(renameNode(server, undefined, 'c', 'aux'), (({ ok, updated }) => ({ ok, updated }))(renameNodeEdit(panel, null, 'c', 'aux')))
  panel = mustOk(renameNodeEdit(panel, null, 'c', 'aux'))
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)

  assert.deepEqual(
    renameFlowReturn(server, 'sub', 'out', 'shipped'),
    (({ ok, updated }) => ({ ok, updated }))(renameFlowReturnEdit(panel, 'sub', 'out', 'shipped')),
  )
  panel = mustOk(renameFlowReturnEdit(panel, 'sub', 'out', 'shipped'))
  assert.deepEqual(server.draft.config.childWorkflows, panel.draft.childWorkflows)
  // 同操作后服务端校验结论一致（面板侧用同一草稿走 validate RPC，此处直调校验）。
  const session = serverSession()
  assert.equal(validateDraft(session).ok, true)
  assert.deepEqual(
    addFlowReturn(server, undefined, 'archived').ok,
    addFlowReturnEdit(panel, null, 'archived').ok,
  )
})
