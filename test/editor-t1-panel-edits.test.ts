/**
 * T1（#160 r001 返工 F2/F3）：面板纯状态变迁行为测试。
 *
 * `web-client/src/edits.js` 无 React/DOM/RPC 依赖，node:test 直接断言
 * 面板实际调用的函数：persona 应用/清除、位置移动、撤销/重做脏标记恢复、
 * 保存计划口径，并钉住与服务端 `draft.ts savePlan` / `layout.ts
 * layoutFilenameFor` / `types.ts ID_PATTERN` 的同语义（防手抄漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPersonaEdit, HISTORY_LIMIT, ID_PATTERN as clientIdPattern,
  isDirty, layoutFilenameFor as clientLayoutFilenameFor,
  moveNodeEdit, redoEdit, savePlanOf, undoEdit, renameFlowReturnEdit, deleteFlowReturnEdit, renameNodeEdit, renameNodeResultEdit,
} from '../web-client/src/edits.js'
import { loadDraft, savePlan, setActorCommonPersona, setNodePosition, undo, renameFlowReturn, deleteFlowReturn, renameNode, renameNodeResult } from '../src/editor/draft.ts'
import { layoutFilenameFor as serverLayoutFilenameFor, serializeLayout, parseLayoutFile } from '../src/editor/layout.ts'
import { ID_PATTERN as serverIdPattern } from '../src/types.ts'

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
        ok: { criteria: Done., target: { return: done } }
`

function freshPanel(config: unknown) {
  const draft = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  return {
    draft,
    positions: { main: {}, children: {} },
    personaInput: typeof draft['actorCommonPersona'] === 'string' ? draft['actorCommonPersona'] as string : '',
    dirtyBusiness: false,
    dirtyLayout: false,
    past: [],
    future: [],
    saveResult: null,
    problems: [],
  }
}

test('结束节点位置：布局独立保存、重载、撤销重做及返回改名/删除', () => {
  const loaded = loadDraft('mini', MINI_CONFIG)
  if (!loaded.ok) throw new Error('fixture failed')
  const { session } = loaded
  assert.deepEqual(setNodePosition(session, undefined, 'return:done', { x: 310, y: 240 }), { ok: true })
  const moved = moveNodeEdit(freshPanel(session.draft.config), null, 'return:done', { x: 310, y: 240 })
  assert.ok(moved.ok && moved.state)
  const panel = moved.state!
  assert.deepEqual(savePlanOf(panel), { writeYaml: false, writeLayout: true })
  assert.deepEqual(redoEdit(undoEdit(panel)!)!.positions, panel.positions)
  const reloaded = parseLayoutFile(serializeLayout(session.draft.config, session.draft.layout))
  assert.deepEqual(reloaded.layout.main['return:done'], { x: 310, y: 240 })
  session.draft.config.childWorkflows = { child: structuredClone(session.draft.config.workflow) }
  assert.deepEqual(setNodePosition(session, 'child', 'return:done', { x: 120, y: 420 }), { ok: true })
  session.draft.layout.main['return:stale'] = { x: 1, y: 1 }
  const withChild = parseLayoutFile(serializeLayout(session.draft.config, session.draft.layout)).layout
  assert.deepEqual(withChild.main['return:done'], { x: 310, y: 240 })
  assert.deepEqual(withChild.children['child']?.['return:done'], { x: 120, y: 420 })
  assert.equal(withChild.main['return:stale'], undefined)
  assert.equal(clientIdPattern.test('return:done'), false)
  assert.equal(serverIdPattern.test('return:done'), false)
  assert.equal(setNodePosition(session, 'child', 'return:missing', { x: 1, y: 1 }).ok, false)
  assert.equal(renameFlowReturn(session, 'child', 'done', 'finished').ok, true)
  assert.deepEqual(session.draft.layout.children['child']?.['return:finished'], { x: 120, y: 420 })
  assert.equal(session.draft.layout.children['child']?.['return:done'], undefined)
  assert.deepEqual(session.draft.layout.main['return:done'], { x: 310, y: 240 })
  assert.equal(deleteFlowReturn(session, 'child', 'finished').ok, true)
  assert.equal(session.draft.layout.children['child']?.['return:finished'], undefined)
  assert.equal(undo(session), true)
  assert.deepEqual(session.draft.layout.children['child']?.['return:finished'], { x: 120, y: 420 })
  const renamed = renameFlowReturnEdit(panel, null, 'done', 'finished')
  assert.ok(renamed.ok && renamed.state)
  assert.deepEqual(renamed.state!.positions.main['return:finished'], { x: 310, y: 240 })
  assert.equal(renamed.state!.positions.main['return:done'], undefined)
  const deleted = deleteFlowReturnEdit(renamed.state!, null, 'finished')
  assert.ok(deleted.ok && deleted.state)
  assert.equal(deleted.state!.positions.main['return:finished'], undefined)
  assert.deepEqual(undoEdit(deleted.state!)!.positions.main['return:finished'], { x: 310, y: 240 })
})

test('连线路由位置：主/子流程与 onReturn 保存重载、剪枝、撤销重做', () => {
  const loaded = loadDraft('mini', MINI_CONFIG)
  if (!loaded.ok) throw new Error('fixture failed')
  const config = loaded.session.draft.config
  config.childWorkflows = { child: structuredClone(config.workflow) }
  config.workflow.nodes['call'] = {
    execution: { type: 'child-workflow', workflowId: 'child' },
    onReturn: { done: { return: 'done' } },
  }
  const original = JSON.stringify(config)
  const first = moveNodeEdit(freshPanel(config), null, 'edge:a:ok', { x: -110, y: 340 })
  assert.ok(first.ok && first.state)
  const child = moveNodeEdit(first.state!, 'child', 'edge:a:ok', { x: 440, y: -70 })
  assert.ok(child.ok && child.state)
  const call = moveNodeEdit(child.state!, null, 'edge:call:done', { x: 500, y: 620 })
  assert.ok(call.ok && call.state)
  const panel = call.state!
  assert.deepEqual(savePlanOf(panel), { writeYaml: false, writeLayout: true })
  assert.deepEqual(redoEdit(undoEdit(panel)!)!.positions, panel.positions)
  assert.equal(JSON.stringify(panel.draft), original)
  const layout = { version: 1 as const, ...panel.positions }
  layout.main['edge:missing:ok'] = { x: 1, y: 1 }
  layout.main['edge:a:missing'] = { x: 1, y: 1 }
  layout.children['child']!['edge:a:missing'] = { x: 1, y: 1 }
  layout.children['missing'] = { 'edge:a:ok': { x: 1, y: 1 } }
  const reloaded = parseLayoutFile(serializeLayout(config, layout)).layout
  assert.deepEqual(reloaded.main, { 'edge:a:ok': { x: -110, y: 340 }, 'edge:call:done': { x: 500, y: 620 } })
  assert.deepEqual(reloaded.children, { child: { 'edge:a:ok': { x: 440, y: -70 } } })
})

test('节点/结果/子流程返回改名保留连线路由，前后端一致且可撤销', () => {
  const loaded = loadDraft('mini', MINI_CONFIG)
  if (!loaded.ok) throw new Error('fixture failed')
  const { session } = loaded
  session.draft.config.childWorkflows = { child: structuredClone(session.draft.config.workflow) }
  session.draft.config.workflow.nodes['call'] = {
    execution: { type: 'child-workflow', workflowId: 'child' }, onReturn: { done: { return: 'done' } },
  }
  session.draft.layout = {
    version: 1, main: { 'edge:call:done': { x: 400, y: 100 } },
    children: { child: { 'edge:a:ok': { x: -50, y: 90 } } },
  }
  const initial = structuredClone(session.draft.layout)
  let panel = { ...freshPanel(session.draft.config), positions: structuredClone(session.draft.layout) }
  assert.equal(renameNode(session, 'child', 'a', 'b').ok, true)
  panel = renameNodeEdit(panel, 'child', 'a', 'b').state!
  assert.equal(renameNodeResult(session, 'child', 'b', 'ok', 'yes').ok, true)
  panel = renameNodeResultEdit(panel, 'child', 'b', 'ok', 'yes').state!
  assert.equal(renameFlowReturn(session, 'child', 'done', 'finished').ok, true)
  panel = renameFlowReturnEdit(panel, 'child', 'done', 'finished').state!
  assert.deepEqual(panel.positions, session.draft.layout)
  assert.deepEqual(session.draft.layout, {
    version: 1, main: { 'edge:call:finished': { x: 400, y: 100 } },
    children: { child: { 'edge:b:yes': { x: -50, y: 90 } } },
  })
  assert.equal(panel.dirtyLayout, true)
  assert.equal(session.draft.dirtyLayout, true)
  assert.deepEqual(parseLayoutFile(serializeLayout(session.draft.config, session.draft.layout)).layout, panel.positions)
  for (let i = 0; i < 3; i++) { assert.equal(undo(session), true); panel = undoEdit(panel)! }
  assert.deepEqual(panel.positions, initial)
  assert.deepEqual(session.draft.layout, initial)
})

test('T1-panel: persona 设置/清除/noop/空白拒绝', () => {
  let panel = freshPanel({ workflow: {} })
  const applied = applyPersonaEdit({ ...panel, personaInput: '  New persona. ' }, false)
  assert.equal(applied.ok, true)
  if (!applied.ok || applied.state === undefined) throw new Error('unreachable')
  assert.equal((applied.state.draft as Record<string, unknown>)['actorCommonPersona'], 'New persona.')
  assert.equal(applied.state.personaInput, 'New persona.')
  assert.equal(applied.state.dirtyBusiness, true)
  assert.equal(applied.state.past.length, 1)
  panel = applied.state

  // 与草稿值相同 → noop：不记历史、不置脏。
  const pastLen = panel.past.length
  const noop = applyPersonaEdit(panel, false)
  assert.equal(noop.ok, true)
  if (!noop.ok) throw new Error('unreachable')
  assert.equal(noop.noop, true)
  assert.equal(panel.past.length, pastLen)
  assert.equal(panel.dirtyBusiness, true)

  const cleared = applyPersonaEdit(panel, true)
  assert.equal(cleared.ok, true)
  if (!cleared.ok || cleared.state === undefined) throw new Error('unreachable')
  assert.equal('actorCommonPersona' in cleared.state.draft, false)
  assert.equal(cleared.state.personaInput, '')

  const blank = applyPersonaEdit({ ...panel, personaInput: '   ' }, false)
  assert.equal(blank.ok, false)
  if (blank.ok) throw new Error('unreachable')
  assert.match(blank.reason, /为空/)
})

test('T1-panel: 位置移动 noop/非法坐标/子流程隔离', () => {
  const panel = freshPanel({ workflow: {} })
  const moved = moveNodeEdit(panel, null, 'a', { x: 10, y: 20 })
  assert.equal(moved.ok, true)
  if (!moved.ok || moved.state === undefined) throw new Error('unreachable')
  assert.deepEqual(moved.state.positions.main['a'], { x: 10, y: 20 })
  assert.equal(moved.state.dirtyLayout, true)
  assert.equal(moved.state.dirtyBusiness, false)

  const same = moveNodeEdit(moved.state, null, 'a', { x: 10, y: 20 })
  assert.equal(same.ok, true)
  if (!same.ok) throw new Error('unreachable')
  assert.equal(same.noop, true)

  const bad = moveNodeEdit(panel, null, 'a', { x: NaN, y: 0 })
  assert.equal(bad.ok, false)

  const child = moveNodeEdit(panel, 'sub', 'a', { x: 1, y: 1 })
  assert.equal(child.ok, true)
  if (!child.ok || child.state === undefined) throw new Error('unreachable')
  assert.deepEqual(child.state.positions.children['sub']['a'], { x: 1, y: 1 })
  assert.deepEqual(child.state.positions.main, {})
})

test('T1-panel: 撤销/重做恢复脏标记——纯布局撤销后保存只写布局', () => {
  let panel = freshPanel({ workflow: {} })
  const moved = moveNodeEdit(panel, null, 'a', { x: 11, y: 22 })
  if (!moved.ok || moved.state === undefined) throw new Error('unreachable')
  panel = moved.state
  assert.deepEqual(savePlanOf(panel), { writeYaml: false, writeLayout: true })

  const undone = undoEdit(panel)
  assert.ok(undone !== null)
  assert.deepEqual(savePlanOf(undone!), { writeYaml: false, writeLayout: false })
  const redone = redoEdit(undone!)
  assert.ok(redone !== null)
  assert.deepEqual(savePlanOf(redone!), { writeYaml: false, writeLayout: true })

  // 业务+布局混合：逐级撤销回到每一层的脏状态。
  const withPersona = applyPersonaEdit({ ...redone!, personaInput: 'v2' }, false)
  if (!withPersona.ok || withPersona.state === undefined) throw new Error('unreachable')
  panel = withPersona.state
  assert.deepEqual(savePlanOf(panel), { writeYaml: true, writeLayout: true })
  const back1 = undoEdit(panel)!
  assert.deepEqual(savePlanOf(back1), { writeYaml: false, writeLayout: true })
  const back2 = undoEdit(back1)!
  assert.deepEqual(savePlanOf(back2), { writeYaml: false, writeLayout: false })
  assert.equal(undoEdit(back2), null)
  assert.equal(redoEdit(freshPanel({ workflow: {} })), null)
  assert.ok(isDirty(panel) && !isDirty(back2))
})

test('T1-panel: 历史上限 50', () => {
  let panel = freshPanel({ workflow: {} })
  for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
    const moved = moveNodeEdit(panel, null, 'a', { x: i, y: i })
    if (!moved.ok || moved.state === undefined) throw new Error('unreachable')
    panel = moved.state
  }
  assert.ok(panel.past.length <= HISTORY_LIMIT, `历史超过上限：${panel.past.length}`)
})

test('T1-panel: 保存计划与服务端 savePlan 同语义（双边同操作对比）', () => {
  const loaded = loadDraft('mini', MINI_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  const { session } = loaded
  let panel = freshPanel(session.draft.config)
  const expectSame = () => assert.deepEqual(savePlanOf(panel), savePlan(session))

  expectSame()
  assert.deepEqual(setActorCommonPersona(session, 'v2'), { ok: true })
  const edited = applyPersonaEdit({ ...panel, personaInput: 'v2' }, false)
  if (!edited.ok || edited.state === undefined) throw new Error('unreachable')
  panel = edited.state
  expectSame()
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })

  assert.deepEqual(setNodePosition(session, undefined, 'a', { x: 5, y: 6 }), { ok: true })
  const moved = moveNodeEdit(panel, null, 'a', { x: 5, y: 6 })
  if (!moved.ok || moved.state === undefined) throw new Error('unreachable')
  panel = moved.state
  expectSame()
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })

  assert.equal(undo(session), true)
  panel = undoEdit(panel)!
  expectSame()
  // 回到仅 persona 脏：写 YAML 时布局同写（dirtyBusiness 蕴含 writeLayout）。
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })
})

test('T1-panel: 布局文件名与 ID 规则钉住服务端（防手抄漂移）', () => {
  const names = ['review.yaml', 'my-flow9.yaml', 'review.yml', 'review', '', '.yaml', 'REVIEW.yaml', 'a.yaml.yaml']
  for (const name of names) {
    assert.equal(clientLayoutFilenameFor(name), serverLayoutFilenameFor(name), `layoutFilenameFor 漂移：${name}`)
  }
  const ids = ['review', 'a-b9', 'a', 'A', '9a', 'a_b', '', 'a--b', 'ab-']
  for (const id of ids) {
    assert.equal(clientIdPattern.test(id), serverIdPattern.test(id), `ID_PATTERN 漂移：${id}`)
  }
})
