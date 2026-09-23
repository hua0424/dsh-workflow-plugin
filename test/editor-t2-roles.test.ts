/**
 * T2（#161）角色、Judge 与模型配置编辑：真实 parser/schema/validator 行为测试。
 *
 * 覆盖：角色新增/重命名（主+子流程引用同步更新）/删除（悬空引用阻止保存）、
 * 可选字段与模型三态（未设/显式未设档位/显式档位，空串不得替代省略）、
 * reuse 双合同、deny 省略与非空列表、Judge 禁止项（reuse 缺席、必需工具保护
 * 沿用服务端校验）、撤销重做、加载→编辑→校验→保存→重载业务等价。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addRole, businessEqual, deleteRole, loadDraft, previewDraft, redo, renameRole,
  setJudgeDeny, setJudgeModel, setJudgePersona, setRoleDeny, setRoleModel,
  setRolePersona, setRoleReuse, undo, validateDraft,
} from '../src/editor/draft.ts'
import { serializeLayout } from '../src/editor/layout.ts'
import { RESERVED_ROLE_KEYS, roleReuseMode, routeToAgentOptions } from '../src/types.ts'

const T2_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Build it.
    model: { provider: test-provider, modelId: test-model }
  reviewer:
    persona: Review it.
    reuse: continuable
    tools: { deny: [terminal] }
judgeRole:
  persona: Judge it.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan it. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Planned., target: { node: build } }
    build:
      execution: { type: actor-task, role: developer, instruction: Build it. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Built., target: { node: review } }
    review:
      execution: { type: actor-task, role: reviewer, instruction: Check it. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Checked., target: { node: ship } }
    ship:
      execution: { type: child-workflow, workflowId: release }
      onReturn: { shipped: { return: done } }
childWorkflows:
  release:
    startNode: rel
    returns: [shipped]
    nodes:
      rel:
        execution: { type: actor-task, role: developer, instruction: Release it. }
        checker: { checkerId: judge.claim-correct }
        results: { done: { criteria: Released., target: { return: shipped } } }
`

function mustLoad() {
  const loaded = loadDraft('t2', T2_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  return loaded.session
}

function actorRoles(session) {
  const roles = []
  for (const flow of [session.draft.config.workflow, ...Object.values(session.draft.config.childWorkflows ?? {})]) {
    for (const node of Object.values(flow.nodes)) {
      if (node.execution.type === 'actor-task' && node.execution.role !== 'manager') {
        roles.push(node.execution.role)
      }
    }
  }
  return roles.sort()
}

test('T2: 新增角色全字段与守卫（保留名/重复/非法id/空白persona）', () => {
  const session = mustLoad()
  assert.deepEqual(
    addRole(session, 'tester', {
      persona: ' Test it. ',
      model: { provider: 'p', modelId: 'm', reasoningEffort: 'high' },
      reuse: 'continuable',
      deny: ['terminal'],
    }),
    { ok: true },
  )
  const role = session.draft.config.roles['tester']
  assert.equal(role?.persona, 'Test it.')
  assert.deepEqual(role?.model, { provider: 'p', modelId: 'm', reasoningEffort: 'high' })
  assert.equal(role?.reuse, 'continuable')
  assert.deepEqual(role?.tools, { deny: ['terminal'] })
  assert.equal(validateDraft(session).ok, true)

  assert.deepEqual(addRole(session, 'tester', { persona: 'dup' }).ok, false)
  for (const reserved of [...RESERVED_ROLE_KEYS, 'Bad_Id', '9x']) {
    assert.equal(addRole(session, reserved, { persona: 'x' }).ok, false, reserved)
  }
  assert.equal(addRole(session, 'blank', { persona: '   ' }).ok, false)
  // 空串模型/空列表 deny 不得替代省略。
  assert.equal(addRole(session, 'm1', { persona: 'x', model: { provider: '', modelId: 'm' } }).ok, false)
  assert.equal(addRole(session, 'm2', { persona: 'x', model: { provider: 'p', modelId: 'm', reasoningEffort: ' ' } }).ok, false)
  assert.equal(addRole(session, 'd1', { persona: 'x', deny: [] }).ok, false)
  assert.equal(addRole(session, 'd2', { persona: 'x', deny: ['terminal', ' '] }).ok, false)
  assert.equal(addRole(session, 'r1', { persona: 'x', reuse: 'sometimes' as never }).ok, false)
})

test('T2: 重命名同步更新主/子流程全部 Actor 引用', () => {
  const session = mustLoad()
  assert.deepEqual(actorRoles(session), ['developer', 'developer', 'reviewer'])
  const renamed = renameRole(session, 'developer', 'builder')
  assert.deepEqual(renamed, { ok: true, updated: 2 })
  assert.deepEqual(actorRoles(session), ['builder', 'builder', 'reviewer'])
  assert.ok(session.draft.config.roles['builder'] !== undefined)
  assert.ok(!('developer' in session.draft.config.roles))
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))

  assert.deepEqual(renameRole(session, 'builder', 'builder'), { ok: true, updated: 0 })
  assert.equal(renameRole(session, 'ghost', 'x').ok, false)
  assert.equal(renameRole(session, 'builder', 'reviewer').ok, false)
  assert.equal(renameRole(session, 'builder', 'judge').ok, false)
  assert.equal(renameRole(session, 'builder', 'Bad').ok, false)
})

test('T2: 删除不静默换角——悬空引用明确诊断并阻止保存', () => {
  const session = mustLoad()
  assert.deepEqual(deleteRole(session, 'developer'), { ok: true })
  assert.ok(!('developer' in session.draft.config.roles))
  // 引用原样悬空，未被换成其他角色。
  assert.deepEqual(actorRoles(session), ['developer', 'developer', 'reviewer'])
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  if (!checked.ok) assert.ok(checked.problems.some(p => p.includes('unknown role "developer"')), JSON.stringify(checked.problems))
  // 预览同样标记草稿非法（面板保存前可见诊断）。
  assert.ok(previewDraft(session).problems.length > 0)
  assert.equal(deleteRole(session, 'developer').ok, false)
})

test('T2: 模型三态——未设/显式未设档位/显式档位，空串不得替代省略', () => {
  const session = mustLoad()
  // 初态：reviewer 未设模型（省略）。
  assert.equal(session.draft.config.roles['reviewer']?.model, undefined)
  // 显式模型但未设档位：无 reasoningEffort 键。
  assert.deepEqual(setRoleModel(session, 'reviewer', { provider: 'p', modelId: 'm' }), { ok: true })
  assert.deepEqual(session.draft.config.roles['reviewer']?.model, { provider: 'p', modelId: 'm' })
  assert.ok(!('reasoningEffort' in (session.draft.config.roles['reviewer']?.model ?? {})))
  // 显式档位。
  assert.deepEqual(
    setRoleModel(session, 'reviewer', { provider: 'p', modelId: 'm', reasoningEffort: 'high' }),
    { ok: true },
  )
  assert.equal(session.draft.config.roles['reviewer']?.model?.reasoningEffort, 'high')
  // 清除 = 整键省略，回未设态。
  assert.deepEqual(setRoleModel(session, 'reviewer', undefined), { ok: true })
  assert.equal('model' in (session.draft.config.roles['reviewer'] ?? {}), false)
  // 空串拒绝（provider/modelId 成对、effort 非空）。
  assert.equal(setRoleModel(session, 'reviewer', { provider: 'p', modelId: '' }).ok, false)
  assert.equal(setRoleModel(session, 'reviewer', { provider: 'p', modelId: 'm', reasoningEffort: '' }).ok, false)
  assert.equal(setRoleModel(session, 'ghost', { provider: 'p', modelId: 'm' }).ok, false)

  // 缺省语义胶水：显式模型未设档位 → 派发边界显式清除继承档位（回模型默认）；
  // 完全未设 → 保留 Manager 继承（undefined）。
  assert.deepEqual(setRoleModel(session, 'reviewer', { provider: 'p', modelId: 'm' }), { ok: true })
  const explicit = routeToAgentOptions(session.draft.config.roles['reviewer']?.model)
  assert.ok(explicit !== undefined && 'reasoningEffort' in explicit && explicit.reasoningEffort === undefined)
  assert.deepEqual(setRoleModel(session, 'reviewer', undefined), { ok: true })
  assert.equal(routeToAgentOptions(session.draft.config.roles['reviewer']?.model), undefined)
})

test('T2: reuse 双合同与 deny 省略/列表语义', () => {
  const session = mustLoad()
  // 加载时省略已按 #60 归一为 node（与线上行为一致，内存态不保留省略形）。
  assert.equal(roleReuseMode(session.draft.config.roles['developer']), 'node')
  assert.deepEqual(setRoleReuse(session, 'developer', 'node'), { ok: true })
  assert.deepEqual(setRoleReuse(session, 'developer', 'continuable'), { ok: true })
  assert.equal(session.draft.config.roles['developer']?.reuse, 'continuable')
  // 指回 node 时删多余键（仍等价归一），非法值与未知角色拒绝。
  assert.deepEqual(setRoleReuse(session, 'developer', 'node'), { ok: true })
  assert.equal(roleReuseMode(session.draft.config.roles['developer']), 'node')
  assert.equal(setRoleReuse(session, 'developer', 'sometimes' as never).ok, false)
  assert.equal(setRoleReuse(session, 'ghost', 'node').ok, false)

  // deny：省略 ↔ 非空列表；空列表/空白项拒绝。
  assert.deepEqual(setRoleDeny(session, 'reviewer', undefined), { ok: true })
  assert.equal('tools' in (session.draft.config.roles['reviewer'] ?? {}), false)
  assert.deepEqual(setRoleDeny(session, 'reviewer', [' terminal ']), { ok: true })
  assert.deepEqual(session.draft.config.roles['reviewer']?.tools, { deny: ['terminal'] })
  assert.equal(setRoleDeny(session, 'reviewer', []).ok, false)
  assert.equal(setRoleDeny(session, 'reviewer', ['ok', ' ']).ok, false)
  assert.equal(validateDraft(session).ok, true)
})

test('T2: 角色 persona 修改与 noop', () => {
  const session = mustLoad()
  assert.deepEqual(setRolePersona(session, 'developer', '  Build harder. '), { ok: true })
  assert.equal(session.draft.config.roles['developer']?.persona, 'Build harder.')
  const pastLen = session.past.length
  assert.deepEqual(setRolePersona(session, 'developer', 'Build harder.'), { ok: true })
  assert.equal(session.past.length, pastLen)
  assert.equal(setRolePersona(session, 'developer', '  ').ok, false)
  assert.equal(setRolePersona(session, 'ghost', 'x').ok, false)
})

test('T2: Judge 编辑 persona/模型/deny，无 reuse；必需工具保护沿用服务端校验', () => {
  const session = mustLoad()
  assert.deepEqual(setJudgePersona(session, '  Judge harder. '), { ok: true })
  assert.equal(session.draft.config.judgeRole.persona, 'Judge harder.')
  assert.equal(setJudgePersona(session, ' ').ok, false)

  assert.deepEqual(setJudgeModel(session, { provider: 'p', modelId: 'jm', reasoningEffort: 'low' }), { ok: true })
  assert.deepEqual(session.draft.config.judgeRole.model, { provider: 'p', modelId: 'jm', reasoningEffort: 'low' })
  assert.deepEqual(setJudgeModel(session, undefined), { ok: true })
  assert.equal('model' in session.draft.config.judgeRole, false)
  assert.equal(setJudgeModel(session, { provider: '', modelId: 'jm' }).ok, false)

  assert.deepEqual(setJudgeDeny(session, ['terminal']), { ok: true })
  assert.deepEqual(validateDraft(session).ok, true)
  // 必需工具（judge_claim）不可 deny：保存前校验明确拒绝。
  assert.deepEqual(setJudgeDeny(session, ['judge_claim']), { ok: true })
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  if (!checked.ok) assert.ok(checked.problems.some(p => p.includes('judge_claim')), JSON.stringify(checked.problems))
  // Judge 无 reuse setter（AC 禁止项）：恢复合法 deny 后整体通过。
  assert.deepEqual(setJudgeDeny(session, undefined), { ok: true })
  assert.equal(validateDraft(session).ok, true)
})

test('T2: 撤销/重做覆盖角色与 Judge 编辑（含脏标记）', () => {
  const session = mustLoad()
  assert.deepEqual(addRole(session, 'tester', { persona: 'Test.' }), { ok: true })
  assert.deepEqual(renameRole(session, 'tester', 'checker'), { ok: true, updated: 0 })
  assert.deepEqual(setJudgePersona(session, 'J2.'), { ok: true })
  assert.equal(undo(session), true)
  assert.equal(session.draft.config.judgeRole.persona, 'Judge it.')
  assert.equal(undo(session), true)
  assert.ok(!('checker' in session.draft.config.roles) && 'tester' in session.draft.config.roles)
  assert.equal(undo(session), true)
  assert.ok(!('tester' in session.draft.config.roles))
  assert.equal(redo(session), true)
  assert.ok('tester' in session.draft.config.roles)
  assert.equal(redo(session), true)
  assert.ok('checker' in session.draft.config.roles)
  assert.equal(redo(session), true)
  assert.equal(session.draft.config.judgeRole.persona, 'J2.')
  assert.equal(redo(session), false)
})

test('T2: 加载→编辑→校验→保存→重载业务等价，其他节点/结果/布局不破坏', () => {
  const session = mustLoad()
  assert.deepEqual(renameRole(session, 'developer', 'builder'), { ok: true, updated: 2 })
  assert.deepEqual(setRoleModel(session, 'builder', { provider: 'p', modelId: 'm' }), { ok: true })
  assert.deepEqual(setRoleDeny(session, 'reviewer', ['terminal', 'write']), { ok: true })
  assert.deepEqual(setJudgePersona(session, 'Judge v2.'), { ok: true })
  assert.deepEqual(setJudgeModel(session, { provider: 'p', modelId: 'jm' }), { ok: true })
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])

  const reloaded = loadDraft('t2', preview.yaml, serializeLayout(session.draft.config, session.draft.layout))
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))
  // 引用与模型语义在重载后保持。
  const nodes = reloaded.session.draft.config.workflow.nodes
  assert.equal(
    nodes['build']?.execution.type === 'actor-task' ? nodes['build'].execution.role : undefined,
    'builder',
  )
  assert.deepEqual(reloaded.session.draft.config.roles['builder']?.model, { provider: 'p', modelId: 'm' })
  assert.deepEqual(reloaded.session.draft.config.roles['reviewer']?.tools, { deny: ['terminal', 'write'] })
  assert.equal(reloaded.session.draft.config.judgeRole.persona, 'Judge v2.')
  assert.equal(reloaded.session.draft.config.judgeRole.model?.reasoningEffort, undefined)
  // 非目标内容原样：结果目标、checker、子流程、布局坐标。
  const planResults = nodes['plan']?.execution.type === 'actor-task' && nodes['plan'] !== undefined
    ? (nodes['plan'] as { results: Record<string, { target: unknown }> }).results : undefined
  assert.deepEqual(planResults?.['ok']?.target, { node: 'build' })
  assert.ok(reloaded.session.draft.config.childWorkflows?.['release'] !== undefined)
})
