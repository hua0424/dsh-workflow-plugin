/**
 * T3（#162）新建流程与 Actor 结果路由编辑：真实 parser/schema/validator 行为测试。
 *
 * 覆盖：新建文件名守卫与最小起点合法性、Actor 节点增改删改名（含布局隔离与
 * 同流程引用同步）、命名结果增改删改名（含直接自环拦截、多结果同目标、
 * 多节点回路）、入口/返回增改删改名（含 Child 调用方 onReturn 键同步、
 * 删除悬空阻止保存）、Program/Child 字段不丢失、撤销重做、往返业务等价。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addActorNode, addFlowReturn, addNodeResult, businessEqual, deleteFlowReturn,
  deleteNode, deleteNodeResult, findNodeRefs, loadDraft, newDraftSession,
  parseNewFilename, previewDraft, redo, renameFlowReturn, renameNode,
  renameNodeResult, setActorFields, setFlowStartNode, setNodeResult, undo,
  validateDraft,
} from '../src/editor/draft.ts'
import { serializeLayout } from '../src/editor/layout.ts'

const T3_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Build it.
  reviewer:
    persona: Review it.
judgeRole:
  persona: Judge it.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan it. }
      checker: { checkerId: judge.claim-correct, config: { criteria: Planned well. } }
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
        ok: { criteria: Checked., target: { node: probe } }
        redo: { criteria: Needs rework., target: { node: build } }
    probe:
      execution: { type: builtin-program, programId: github.all-milestone-issues-complete, config: { milestoneNumber: 25 } }
      results:
        PASS: { criteria: Complete., target: { node: ship } }
        FAIL: { criteria: Open., target: { node: build } }
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
        results: { done: { criteria: Released., target: { node: build } } }
      build:
        execution: { type: actor-task, role: reviewer, instruction: Check release. }
        checker: { checkerId: judge.claim-correct }
        results: { done: { criteria: Checked., target: { return: shipped } } }
`

function mustLoad() {
  const loaded = loadDraft('t3', T3_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  return loaded.session
}

test('T3: 新建文件名守卫与最小起点合法闭环', () => {
  assert.deepEqual(parseNewFilename('review.yaml'), { ok: true, workflowId: 'review' })
  assert.equal(parseNewFilename('Review.yaml').ok, false)
  assert.equal(parseNewFilename('review.yml').ok, false)
  assert.equal(parseNewFilename('.yaml').ok, false)
  assert.equal(parseNewFilename('a_b.yaml').ok, false)

  const session = newDraftSession('fresh')
  assert.equal(session.draft.workflowId, 'fresh')
  assert.deepEqual(session.draft.config.workflow.returns, ['done'])
  // 最小起点：Manager 入口 + 最小 Judge，不依赖任何 roles。
  assert.deepEqual(Object.keys(session.draft.config.roles), [])
  assert.ok(session.draft.config.judgeRole.persona !== '')
  const entry = session.draft.config.workflow.nodes['main']
  assert.equal(entry?.execution.type === 'actor-task' ? entry.execution.role : undefined, 'manager')
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))
  // 新建后可直接加 Manager 后续节点并连线（新节点先不可达， wired 后合法）。
  assert.deepEqual(
    addActorNode(session, undefined, 'next', {
      role: 'manager', instruction: 'Follow up.', resultName: 'ok', resultCriteria: 'Followed.', target: { return: 'done' },
    }),
    { ok: true },
  )
  assert.equal(validateDraft(session).ok, false)
  assert.deepEqual(setNodeResult(session, undefined, 'main', 'done', { target: { node: 'next' } }), { ok: true })
  assert.equal(validateDraft(session).ok, true)
})

test('T3: 新增 Actor 节点守卫与布局隔离', () => {
  const session = mustLoad()
  assert.deepEqual(
    addActorNode(session, undefined, 'extra', {
      role: 'developer', instruction: ' Extra work. ', checkerId: 'judge.claim-correct',
      commonCriteria: 'Extra well.',
      resultName: 'ok', resultCriteria: 'Extra done.', target: { node: 'build' },
    }),
    { ok: true },
  )
  const node = session.draft.config.workflow.nodes['extra']
  assert.equal(node?.execution.type === 'actor-task' ? node.execution.instruction : undefined, 'Extra work.')
  assert.deepEqual(
    node?.execution.type === 'actor-task' ? node.checker : undefined,
    { checkerId: 'judge.claim-correct', config: { criteria: 'Extra well.' } },
  )
  // 布局：新节点有坐标；子流程同名节点互不覆盖。
  assert.deepEqual(
    addActorNode(session, 'release', 'extra', {
      role: 'reviewer', instruction: 'Sub extra.', resultName: 'ok', resultCriteria: 'Sub done.', target: { return: 'shipped' },
    }),
    { ok: true },
  )
  assert.notDeepEqual(session.draft.layout.main['extra'], undefined)
  assert.notDeepEqual(session.draft.layout.children['release']?.['extra'], undefined)

  assert.equal(addActorNode(session, undefined, 'extra', {
    role: 'developer', instruction: 'dup.', resultName: 'ok', resultCriteria: 'Dup.', target: { node: 'build' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'Bad', {
    role: 'developer', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { node: 'build' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'ghost-role', {
    role: 'ghost', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { node: 'build' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'judge-node', {
    role: 'judge', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { node: 'build' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'blank', {
    role: 'developer', instruction: '  ', resultName: 'ok', resultCriteria: 'X.', target: { node: 'build' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'bad-checker', {
    role: 'developer', instruction: 'x.', checkerId: 'nope', resultName: 'ok', resultCriteria: 'X.', target: { node: 'build' },
  }).ok, false)
  // 目标必须同流程已声明：跨流程节点/未声明返回/直接自环/未知子流程拒绝。
  assert.equal(addActorNode(session, undefined, 'cross', {
    role: 'developer', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { node: 'rel' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'badret', {
    role: 'developer', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { return: 'nope' },
  }).ok, false)
  assert.equal(addActorNode(session, undefined, 'selfish', {
    role: 'developer', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { node: 'selfish' },
  }).ok, false)
  assert.equal(addActorNode(session, 'ghost-flow', 'x', {
    role: 'developer', instruction: 'x.', resultName: 'ok', resultCriteria: 'X.', target: { return: 'shipped' },
  }).ok, false)
  // 新节点暂时不可达：允许编辑，保存前校验阻止。
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  if (!checked.ok) assert.ok(checked.problems.some(p => p.includes('"extra" is not reachable')), JSON.stringify(checked.problems))
})

test('T3: Actor 属性修改与主入口 Manager 限制', () => {
  const session = mustLoad()
  assert.deepEqual(
    setActorFields(session, undefined, 'build', { instruction: ' Build harder. ', commonCriteria: 'Built well.' }),
    { ok: true },
  )
  const build = session.draft.config.workflow.nodes['build']
  assert.equal(build?.execution.type === 'actor-task' ? build.execution.instruction : undefined, 'Build harder.')
  assert.deepEqual(
    build?.execution.type === 'actor-task' ? build.checker.config : undefined,
    { criteria: 'Built well.' },
  )
  assert.deepEqual(setActorFields(session, undefined, 'build', { commonCriteria: null }), { ok: true })
  assert.deepEqual(
    session.draft.config.workflow.nodes['build']?.execution.type === 'actor-task'
      ? (session.draft.config.workflow.nodes['build'] as { checker: unknown }).checker : undefined,
    { checkerId: 'judge.claim-correct', config: {} },
  )
  // noop 不记历史。
  const pastLen = session.past.length
  assert.deepEqual(setActorFields(session, undefined, 'build', { instruction: 'Build harder.' }), { ok: true })
  assert.equal(session.past.length, pastLen)
  // 主入口角色不可改为非 manager；子流程节点不受此限。
  assert.equal(setActorFields(session, undefined, 'plan', { role: 'developer' }).ok, false)
  assert.deepEqual(setActorFields(session, 'release', 'rel', { role: 'reviewer' }), { ok: true })
  assert.equal(setActorFields(session, undefined, 'build', { role: 'ghost' }).ok, false)
  assert.equal(setActorFields(session, undefined, 'build', { checkerId: 'nope' }).ok, false)
  assert.equal(setActorFields(session, undefined, 'build', { instruction: ' ' }).ok, false)
  // Program/Child 节点拒绝且字段不丢失。
  assert.equal(setActorFields(session, undefined, 'probe', { instruction: 'x' }).ok, false)
  assert.equal(setActorFields(session, undefined, 'ship', { instruction: 'x' }).ok, false)
  const probe = session.draft.config.workflow.nodes['probe']
  assert.equal(probe?.execution.type === 'builtin-program' ? probe.execution.programId : undefined, 'github.all-milestone-issues-complete')
  const ship = session.draft.config.workflow.nodes['ship']
  assert.deepEqual(
    ship?.execution.type === 'child-workflow' ? ship.onReturn : undefined,
    { shipped: { return: 'done' } },
  )
})

test('T3: 节点改名同步入口/目标/布局，跨流程同名不受影响', () => {
  const session = mustLoad()
  const beforeChild = JSON.stringify(session.draft.config.childWorkflows?.['release'].nodes['build'])
  assert.deepEqual(renameNode(session, undefined, 'build', 'construct'), { ok: true, updated: 3 })
  assert.ok(!('build' in session.draft.config.workflow.nodes))
  const planOk = session.draft.config.workflow.nodes['plan']?.execution.type === 'actor-task'
    ? (session.draft.config.workflow.nodes['plan'] as { results: Record<string, { target: unknown }> }).results['ok']?.target : undefined
  assert.deepEqual(planOk, { node: 'construct' })
  // 子流程同名 build 节点未被触碰。
  assert.equal(JSON.stringify(session.draft.config.childWorkflows?.['release'].nodes['build']), beforeChild)
  // 布局键随改名迁移。
  assert.notDeepEqual(session.draft.layout.main['construct'], undefined)
  assert.equal(session.draft.layout.main['build'], undefined)

  // 改名入口节点同步 startNode。
  assert.deepEqual(renameNode(session, undefined, 'plan', 'project'), { ok: true, updated: 0 })
  assert.equal(session.draft.config.workflow.startNode, 'project')
  assert.deepEqual(renameNode(session, undefined, 'project', 'project'), { ok: true, updated: 0 })
  assert.equal(renameNode(session, undefined, 'ghost', 'x').ok, false)
  assert.equal(renameNode(session, undefined, 'construct', 'review').ok, false)
  assert.equal(renameNode(session, undefined, 'construct', 'Bad').ok, false)
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))
})

test('T3: 删除节点保留悬空引用并阻止保存', () => {
  const session = mustLoad()
  const refs = findNodeRefs(session, undefined, 'build')
  assert.ok(refs.some(r => r.kind === 'target' && r.node === 'plan'), JSON.stringify(refs))
  assert.deepEqual(deleteNode(session, undefined, 'build'), { ok: true })
  assert.ok(!('build' in session.draft.config.workflow.nodes))
  assert.equal(session.draft.layout.main['build'], undefined)
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  if (!checked.ok) assert.ok(checked.problems.some(p => p.includes('"build" does not exist')), JSON.stringify(checked.problems))
  assert.ok(previewDraft(session).problems.length > 0)
  assert.equal(deleteNode(session, undefined, 'build').ok, false)
})

test('T3: 命名结果增改删改名——多结果同目标、回路、自环拦截', () => {
  const session = mustLoad()
  // 多结果指向同一节点（与 plan 已有 skipped 同目标语义一致）。
  assert.deepEqual(
    addNodeResult(session, undefined, 'build', 'skipped', 'Skipped build.', { node: 'review' }),
    { ok: true },
  )
  // 拖线改目标：ok 改指 probe（Program 节点可作目标，无需改其字段）。
  assert.deepEqual(setNodeResult(session, undefined, 'build', 'ok', { target: { node: 'probe' } }), { ok: true })
  // 多节点回路：review.redo 已指 build；再让 build.ok 指回 review 形成回路。
  assert.deepEqual(setNodeResult(session, undefined, 'build', 'ok', { target: { node: 'review' } }), { ok: true })
  // 直接自环拦截（新建与修改一致）。
  assert.equal(setNodeResult(session, undefined, 'build', 'ok', { target: { node: 'build' } }).ok, false)
  assert.equal(addNodeResult(session, undefined, 'build', 'loop', 'Loop.', { node: 'build' }).ok, false)
  assert.equal(addNodeResult(session, undefined, 'build', 'ok', 'Dup.', { node: 'review' }).ok, false)
  assert.equal(addNodeResult(session, undefined, 'build', 'Bad', 'X.', { node: 'review' }).ok, false)
  assert.equal(addNodeResult(session, undefined, 'build', 'vague', '  ', { node: 'review' }).ok, false)
  assert.equal(addNodeResult(session, undefined, 'build', 'cross', 'X.', { node: 'rel' }).ok, false)
  // Program/Child 节点结果不在本票范围。
  assert.equal(addNodeResult(session, undefined, 'probe', 'extra', 'X.', { node: 'review' }).ok, false)
  assert.equal(setNodeResult(session, undefined, 'ship', 'shipped', { target: { return: 'done' } }).ok, false)
  assert.equal(renameNodeResult(session, undefined, 'probe', 'PASS', 'pass').ok, false)

  assert.deepEqual(renameNodeResult(session, undefined, 'build', 'skipped', 'bypassed'), { ok: true })
  assert.ok('bypassed' in ((session.draft.config.workflow.nodes['build'] as { results: Record<string, unknown> }).results))
  assert.equal(renameNodeResult(session, undefined, 'build', 'bypassed', 'bypassed').ok, true)
  assert.equal(renameNodeResult(session, undefined, 'build', 'bypassed', 'ok').ok, false)
  assert.deepEqual(deleteNodeResult(session, undefined, 'build', 'bypassed'), { ok: true })
  assert.equal(deleteNodeResult(session, undefined, 'build', 'bypassed').ok, false)
  // criteria 修改 trim 后存；相同值 noop。
  assert.deepEqual(setNodeResult(session, undefined, 'build', 'ok', { criteria: '  Rebuilt. ' }), { ok: true })
  assert.equal(
    (session.draft.config.workflow.nodes['build'] as { results: Record<string, { criteria: string }> }).results['ok']?.criteria,
    'Rebuilt.',
  )
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))
})

test('T3: 入口与返回——改名同步目标/端口/Child 调用方，删除悬空阻止保存', () => {
  const session = mustLoad()
  // 子流程入口可设任意存在节点；主流程入口须 manager。
  assert.deepEqual(setFlowStartNode(session, 'release', 'build'), { ok: true })
  assert.equal(setFlowStartNode(session, undefined, 'build').ok, false)
  assert.equal(setFlowStartNode(session, undefined, 'ghost').ok, false)
  assert.deepEqual(setFlowStartNode(session, 'release', 'rel'), { ok: true })

  // 返回改名：本流程目标 + Child 调用方 onReturn 键同步。
  assert.deepEqual(addFlowReturn(session, undefined, 'archived'), { ok: true })
  assert.equal(addFlowReturn(session, undefined, 'archived').ok, false)
  assert.equal(addFlowReturn(session, undefined, 'Bad').ok, false)
  // 无路径的新返回先删回（保存前校验要求每个返回都有可达路径），保持中间态合法。
  assert.deepEqual(deleteFlowReturn(session, undefined, 'archived'), { ok: true })
  const renamed = renameFlowReturn(session, 'release', 'shipped', 'released')
  assert.deepEqual(renamed, { ok: true, updated: 2 })
  assert.deepEqual(session.draft.config.childWorkflows?.['release'].returns, ['released'])
  assert.deepEqual(
    (session.draft.config.childWorkflows?.['release'].nodes['build'] as { results: Record<string, { target: unknown }> }).results['done']?.target,
    { return: 'released' },
  )
  assert.deepEqual(
    session.draft.config.workflow.nodes['ship']?.execution.type === 'child-workflow'
      ? (session.draft.config.workflow.nodes['ship'] as { onReturn: unknown }).onReturn : undefined,
    { released: { return: 'done' } },
  )
  assert.equal(renameFlowReturn(session, 'release', 'released', 'released').updated, 0)
  assert.equal(renameFlowReturn(session, 'release', 'ghost', 'x').ok, false)
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))

  // 非空表删除：目标悬空由 validator 明确诊断（精确引用名）。
  assert.deepEqual(addFlowReturn(session, undefined, 'archived'), { ok: true })
  assert.deepEqual(
    addNodeResult(session, undefined, 'build', 'alt', 'Alt path.', { return: 'archived' }),
    { ok: true },
  )
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))
  assert.deepEqual(deleteFlowReturn(session, undefined, 'archived'), { ok: true })
  const dangling = validateDraft(session)
  assert.equal(dangling.ok, false)
  if (!dangling.ok) assert.ok(dangling.problems.some(p => p.includes('"archived"')), JSON.stringify(dangling.problems))
  assert.deepEqual(deleteNodeResult(session, undefined, 'build', 'alt'), { ok: true })
  assert.equal(validateDraft(session).ok, true, JSON.stringify(validateDraft(session)))
  // 删除返回保留悬空：调用方映射与目标不静默改写，保存被阻止
  // （删至空表时 schema 层先拒，其他情形 validator 以悬空引用拒）。
  assert.deepEqual(deleteFlowReturn(session, 'release', 'released'), { ok: true })
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  if (!checked.ok) assert.ok(checked.problems.length > 0, JSON.stringify(checked.problems))
  assert.equal(deleteFlowReturn(session, 'release', 'released').ok, false)
})

test('T3: 撤销/重做覆盖节点/结果/返回/入口编辑', () => {
  const session = mustLoad()
  assert.deepEqual(
    addActorNode(session, undefined, 'extra', {
      role: 'developer', instruction: 'Extra.', resultName: 'ok', resultCriteria: 'Extra.', target: { return: 'done' },
    }),
    { ok: true },
  )
  assert.deepEqual(renameNode(session, undefined, 'extra', 'aux'), { ok: true, updated: 0 })
  assert.deepEqual(setFlowStartNode(session, 'release', 'build'), { ok: true })
  assert.deepEqual(addFlowReturn(session, undefined, 'archived'), { ok: true })
  assert.equal(undo(session), true)
  assert.deepEqual(session.draft.config.workflow.returns, ['done'])
  assert.equal(undo(session), true)
  assert.equal(session.draft.config.childWorkflows?.['release'].startNode, 'rel')
  assert.equal(undo(session), true)
  assert.ok(!('aux' in session.draft.config.workflow.nodes) && 'extra' in session.draft.config.workflow.nodes)
  assert.equal(undo(session), true)
  assert.ok(!('extra' in session.draft.config.workflow.nodes))
  assert.equal(redo(session), true)
  assert.ok('extra' in session.draft.config.workflow.nodes)
  assert.equal(redo(session), true)
  assert.ok('aux' in session.draft.config.workflow.nodes)
  assert.equal(redo(session), true)
  assert.equal(session.draft.config.childWorkflows?.['release'].startNode, 'build')
  assert.equal(redo(session), true)
  assert.deepEqual(session.draft.config.workflow.returns, ['done', 'archived'])
  assert.equal(redo(session), false)
})

test('T3: 加载→编辑→校验→保存→重载业务等价，Program/Child 不丢失', () => {
  const session = mustLoad()
  assert.deepEqual(
    addActorNode(session, undefined, 'extra', {
      role: 'developer', instruction: 'Extra.', resultName: 'ok', resultCriteria: 'Extra.', target: { node: 'build' },
    }),
    { ok: true },
  )
  assert.deepEqual(setNodeResult(session, undefined, 'plan', 'ok', { target: { node: 'extra' } }), { ok: true })
  assert.deepEqual(renameNodeResult(session, undefined, 'review', 'redo', 'rework'), { ok: true })
  assert.deepEqual(setActorFields(session, undefined, 'review', { instruction: 'Check harder.' }), { ok: true })
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])

  const reloaded = loadDraft('t3', preview.yaml, serializeLayout(session.draft.config, session.draft.layout))
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))
  // Program/Child 原样保留。
  const nodes = reloaded.session.draft.config.workflow.nodes
  assert.equal(
    nodes['probe']?.execution.type === 'builtin-program' ? nodes['probe'].execution.programId : undefined,
    'github.all-milestone-issues-complete',
  )
  assert.deepEqual(
    nodes['ship']?.execution.type === 'child-workflow'
      ? (nodes['ship'] as { onReturn: unknown }).onReturn : undefined,
    { shipped: { return: 'done' } },
  )
  // 布局随重载恢复（含新节点坐标）。
  assert.notDeepEqual(reloaded.session.draft.layout.main['extra'], undefined)
})
