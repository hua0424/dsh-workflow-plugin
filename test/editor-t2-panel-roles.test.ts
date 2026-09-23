/**
 * T2（#161）面板侧角色/Judge/模型变迁：`web-client/src/edits.js` 镜像行为，
 * 并与服务端 `draft.ts` 同操作对比钉住一致（防手抄漂移）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addRoleEdit, deleteRoleEdit, findRoleRefs, redoEdit,
  renameRoleEdit, RESERVED_ROLE_KEYS as clientReserved,
  ROLE_REUSE_MODES as clientReuseModes,
  setJudgeDenyEdit, setJudgeModelEdit, setJudgePersonaEdit,
  setRoleDenyEdit, setRoleModelEdit, setRolePersonaEdit, setRoleReuseEdit,
  undoEdit,
} from '../web-client/src/edits.js'
import {
  addRole, deleteRole, loadDraft, renameRole,
  setJudgeDeny, setJudgeModel, setJudgePersona, setRoleDeny, setRoleModel,
  setRolePersona, setRoleReuse,
} from '../src/editor/draft.ts'
import { RESERVED_ROLE_KEYS as serverReserved, ROLE_REUSE_MODES as serverReuseModes } from '../src/types.ts'

const MINI_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Build it.
    model: { provider: test-provider, modelId: test-model }
  reviewer:
    persona: Review it.
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

function serverConfig() {
  const loaded = loadDraft('mini', MINI_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  return loaded.session
}

function freshPanel() {
  const draft = JSON.parse(JSON.stringify(serverConfig().draft.config))
  return {
    draft,
    positions: { main: {}, children: {} },
    personaInput: '',
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

test('T2-panel: 角色增删改名与引用计数', () => {
  let panel = freshPanel()
  panel = mustOk(addRoleEdit(panel, 'tester', { persona: ' Test. ' }))
  assert.equal(panel.draft.roles['tester'].persona, 'Test.')
  assert.equal(panel.dirtyBusiness, true)

  const renamed = renameRoleEdit(panel, 'developer', 'builder')
  assert.deepEqual(renamed.ok ? renamed.updated : undefined, 2)
  if (!renamed.ok || renamed.state === undefined) throw new Error('unreachable')
  panel = renamed.state
  assert.deepEqual(findRoleRefs(panel.draft, 'builder').length, 2)
  assert.deepEqual(findRoleRefs(panel.draft, 'developer'), [])

  // 改名拒绝：重复/保留/非法；相同名 noop。
  assert.equal(renameRoleEdit(panel, 'builder', 'reviewer').ok, false)
  assert.equal(renameRoleEdit(panel, 'builder', 'judge').ok, false)
  assert.equal(renameRoleEdit(panel, 'builder', 'Bad').ok, false)
  const noop = renameRoleEdit(panel, 'builder', 'builder')
  assert.equal(noop.ok, true)
  if (!noop.ok) throw new Error('unreachable')
  assert.equal(noop.noop, true)

  panel = mustOk(deleteRoleEdit(panel, 'builder'))
  assert.ok(!('builder' in panel.draft.roles))
  assert.equal(deleteRoleEdit(panel, 'builder').ok, false)
  assert.equal(deleteRoleEdit(panel, 'manager').ok, false)
})

test('T2-panel: 模型/复用/deny/ persona 镜像与 noop', () => {
  let panel = freshPanel()
  panel = mustOk(setRoleModelEdit(panel, 'reviewer', { provider: 'p', modelId: 'm' }))
  assert.deepEqual(panel.draft.roles['reviewer'].model, { provider: 'p', modelId: 'm' })
  panel = mustOk(setRoleModelEdit(panel, 'reviewer', { provider: 'p', modelId: 'm', reasoningEffort: 'high' }))
  assert.equal(panel.draft.roles['reviewer'].model.reasoningEffort, 'high')
  panel = mustOk(setRoleModelEdit(panel, 'reviewer', undefined))
  assert.ok(!('model' in panel.draft.roles['reviewer']))
  assert.equal(setRoleModelEdit(panel, 'reviewer', { provider: 'p', modelId: '' }).ok, false)

  panel = mustOk(setRoleReuseEdit(panel, 'reviewer', 'continuable'))
  assert.equal(panel.draft.roles['reviewer'].reuse, 'continuable')
  panel = mustOk(setRoleReuseEdit(panel, 'reviewer', 'node'))
  assert.ok(!('reuse' in panel.draft.roles['reviewer']))
  assert.equal(setRoleReuseEdit(panel, 'reviewer', 'sometimes').ok, false)

  panel = mustOk(setRoleDenyEdit(panel, 'reviewer', ['terminal']))
  assert.deepEqual(panel.draft.roles['reviewer'].tools, { deny: ['terminal'] })
  panel = mustOk(setRoleDenyEdit(panel, 'reviewer', undefined))
  assert.ok(!('tools' in panel.draft.roles['reviewer']))
  assert.equal(setRoleDenyEdit(panel, 'reviewer', []).ok, false)

  panel = mustOk(setRolePersonaEdit(panel, 'reviewer', ' Review harder. '))
  assert.equal(panel.draft.roles['reviewer'].persona, 'Review harder.')
  const noop = setRolePersonaEdit(panel, 'reviewer', 'Review harder.')
  assert.equal(noop.ok, true)
  if (!noop.ok) throw new Error('unreachable')
  assert.equal(noop.noop, true)
  assert.equal(setRolePersonaEdit(panel, 'ghost', 'x').ok, false)
})

test('T2-panel: Judge 镜像（无 reuse 由缺席保证）', () => {
  let panel = freshPanel()
  panel = mustOk(setJudgePersonaEdit(panel, ' Judge v2. '))
  assert.equal(panel.draft.judgeRole.persona, 'Judge v2.')
  panel = mustOk(setJudgeModelEdit(panel, { provider: 'p', modelId: 'jm' }))
  assert.deepEqual(panel.draft.judgeRole.model, { provider: 'p', modelId: 'jm' })
  panel = mustOk(setJudgeModelEdit(panel, undefined))
  assert.ok(!('model' in panel.draft.judgeRole))
  panel = mustOk(setJudgeDenyEdit(panel, ['terminal']))
  assert.deepEqual(panel.draft.judgeRole.tools, { deny: ['terminal'] })
  panel = mustOk(setJudgeDenyEdit(panel, undefined))
  assert.ok(!('tools' in panel.draft.judgeRole))
  assert.equal(setJudgePersonaEdit(panel, '  ').ok, false)
})

test('T2-panel: 撤销/重做覆盖角色编辑', () => {
  let panel = freshPanel()
  panel = mustOk(addRoleEdit(panel, 'tester', { persona: 'Test.' }))
  panel = mustOk(renameRoleEdit(panel, 'tester', 'checker'))
  panel = undoEdit(panel)!
  assert.ok('tester' in panel.draft.roles && !('checker' in panel.draft.roles))
  panel = undoEdit(panel)!
  assert.ok(!('tester' in panel.draft.roles))
  panel = redoEdit(panel)!
  panel = redoEdit(panel)!
  assert.ok('checker' in panel.draft.roles)
})

test('T2-panel: 同操作双边对比——面板镜像与服务端结果一致', () => {
  const session = serverConfig()
  let panel = freshPanel()
  const applyBoth = (serverOp, panelOp) => {
    const serverResult = serverOp()
    const panelResult = panelOp()
    assert.equal(serverResult.ok, true, JSON.stringify(serverResult))
    assert.equal(panelResult.ok, true, JSON.stringify(panelResult))
    if (!panelResult.ok || panelResult.state === undefined) throw new Error('unreachable')
    panel = panelResult.state
    assert.deepEqual(panel.draft.roles, session.draft.config.roles)
    assert.deepEqual(panel.draft.judgeRole, session.draft.config.judgeRole)
    assert.deepEqual(
      [panel.draft.workflow, panel.draft.childWorkflows],
      [session.draft.config.workflow, session.draft.config.childWorkflows],
    )
  }
  applyBoth(
    () => addRole(session, 'tester', { persona: 'Test.', reuse: 'continuable' }),
    () => addRoleEdit(panel, 'tester', { persona: 'Test.', reuse: 'continuable' }),
  )
  applyBoth(
    () => setRoleModel(session, 'tester', { provider: 'p', modelId: 'm', reasoningEffort: 'high' }),
    () => setRoleModelEdit(panel, 'tester', { provider: 'p', modelId: 'm', reasoningEffort: 'high' }),
  )
  applyBoth(
    () => setRoleDeny(session, 'tester', ['terminal']),
    () => setRoleDenyEdit(panel, 'tester', ['terminal']),
  )
  applyBoth(
    () => setRolePersona(session, 'tester', 'Test v2.'),
    () => setRolePersonaEdit(panel, 'tester', 'Test v2.'),
  )
  applyBoth(
    () => renameRole(session, 'developer', 'builder'),
    () => renameRoleEdit(panel, 'developer', 'builder'),
  )
  applyBoth(
    () => setJudgePersona(session, 'Judge v2.'),
    () => setJudgePersonaEdit(panel, 'Judge v2.'),
  )
  applyBoth(
    () => setJudgeModel(session, { provider: 'p', modelId: 'jm' }),
    () => setJudgeModelEdit(panel, { provider: 'p', modelId: 'jm' }),
  )
  applyBoth(
    () => setJudgeDeny(session, ['terminal']),
    () => setJudgeDenyEdit(panel, ['terminal']),
  )
  applyBoth(
    () => setRoleReuse(session, 'reviewer', 'continuable'),
    () => setRoleReuseEdit(panel, 'reviewer', 'continuable'),
  )
  applyBoth(
    () => deleteRole(session, 'reviewer'),
    () => deleteRoleEdit(panel, 'reviewer'),
  )
})

test('T2-panel: 保留名与复用枚举钉住服务端（防手抄漂移）', () => {
  assert.deepEqual([...clientReserved].sort(), [...serverReserved].sort())
  assert.deepEqual([...clientReuseModes].sort(), [...serverReuseModes].sort())
})
