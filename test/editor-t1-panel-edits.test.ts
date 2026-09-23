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
  moveNodeEdit, redoEdit, savePlanOf, undoEdit,
} from '../web-client/src/edits.js'
import { loadDraft, savePlan, setActorCommonPersona, setNodePosition, undo } from '../src/editor/draft.ts'
import { layoutFilenameFor as serverLayoutFilenameFor } from '../src/editor/layout.ts'
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
