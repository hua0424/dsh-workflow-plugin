/**
 * T4（#163）内置 Program 配置编辑：服务端 `src/editor/draft.ts` 行为。
 *
 * 真实链路：loadDraft（严格解析 + 静态校验）→ Program op → validateDraft
 * （真实 validator）→ serializeConfig 往返。程序与参数合同只读真实
 * `BUILTIN_PROGRAM_METADATA`，无测试内硬编码注册表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addProgramNode,
  businessEqual,
  deleteNode,
  findNodeRefs,
  loadDraft,
  newDraftSession,
  redo,
  renameNode,
  serializeConfig,
  setFlowStartNode,
  setNodeResult,
  setProgramFields,
  setProgramParam,
  setProgramResult,
  undo,
  validateDraft,
} from '../src/editor/draft.ts'
import { BUILTIN_PROGRAM_METADATA } from '../src/programs/metadata.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'

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

/** 新增 Program 并把入口接到它（否则不可达，保存前校验会拦）。 */
function addWiredProgram(session) {
  mustOk(addProgramNode(session, undefined, 'p', {
    programId: 'github.all-milestone-issues-complete',
    passCriteria: 'All issues closed.',
    passTarget: { return: 'done' },
    failCriteria: 'Still open issues.',
    failTarget: { node: 'a' },
  }))
  mustOk(setNodeResult(session, undefined, 'a', 'ok', { target: { node: 'p' } }))
  return session
}

test('T4: 新增 Program 节点（PASS/FAIL 成对）+ 接线后保存前校验通过', () => {
  const session = freshSession()
  const added = addProgramNode(session, undefined, 'p', {
    programId: 'github.all-milestone-issues-complete',
    passCriteria: 'All issues closed.',
    passTarget: { return: 'done' },
    failCriteria: 'Still open issues.',
    failTarget: { node: 'a' },
  })
  assert.equal(added.ok, true, JSON.stringify(added))
  const node = session.draft.config.workflow.nodes['p']
  assert.equal(node.execution.type, 'builtin-program')
  assert.equal(node.execution.programId, 'github.all-milestone-issues-complete')
  assert.ok(!('checker' in node), 'Program 不配置 Checker')
  assert.deepEqual(Object.keys(node.results).sort(), ['FAIL', 'PASS'])
  assert.deepEqual(session.draft.layout.main['p'], { x: 260, y: 40 })
  assert.equal(session.draft.dirtyBusiness, true)
  // 尚无入口指向 p：不可达由保存前校验明确诊断（不静默）。
  const blocked = validateDraft(session)
  assert.equal(blocked.ok, false)
  mustOk(setNodeResult(session, undefined, 'a', 'ok', { target: { node: 'p' } }))
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
})

test('T4: 非法程序与非法初始输入拒绝（节点不创建）', () => {
  const session = freshSession()
  assert.equal(addProgramNode(session, undefined, 'p', {
    programId: 'shell.evil',
    passCriteria: 'Pass.', passTarget: { return: 'done' },
    failCriteria: 'Fail.', failTarget: { node: 'a' },
  }).ok, false)
  assert.equal(addProgramNode(session, undefined, 'p', {
    programId: 'github.all-milestone-issues-complete',
    instruction: '   ',
    passCriteria: 'Pass.', passTarget: { return: 'done' },
    failCriteria: 'Fail.', failTarget: { node: 'a' },
  }).ok, false)
  assert.equal(addProgramNode(session, undefined, 'p', {
    programId: 'github.all-milestone-issues-complete',
    config: { milestoneNumber: 'not-a-number' },
    passCriteria: 'Pass.', passTarget: { return: 'done' },
    failCriteria: 'Fail.', failTarget: { node: 'a' },
  }).ok, false)
  assert.ok(!('p' in session.draft.config.workflow.nodes))
})

test('T4: 协议外结果名拒绝；缺 PASS/FAIL 的存量配置阻止保存', () => {
  const session = addWiredProgram(freshSession())
  const bad = setProgramResult(session, undefined, 'p', 'ok', { criteria: 'Done.' })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /PASS\/FAIL/)
  // 直接构造缺 FAIL 的 Program 草稿：保存前校验必须拦。
  mustOk(addProgramNode(session, undefined, 'q', {
    programId: 'github.all-milestone-issues-complete',
    passCriteria: 'Pass.', passTarget: { return: 'done' },
    failCriteria: 'Fail.', failTarget: { node: 'a' },
  }))
  delete session.draft.config.workflow.nodes['q'].results['FAIL']
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  if (!checked.ok) assert.ok(checked.problems.some((p) => p.includes('FAIL')))
})

test('T4: instruction 设置/清除/noop；空串拒绝', () => {
  const session = addWiredProgram(freshSession())
  mustOk(setProgramFields(session, undefined, 'p', { instruction: '  Check it. ' }))
  assert.equal(session.draft.config.workflow.nodes['p'].execution.instruction, 'Check it.')
  mustOk(setProgramFields(session, undefined, 'p', { instruction: 'Check it.' }))
  assert.equal(session.past.length > 0, true)
  const before = session.past.length
  mustOk(setProgramFields(session, undefined, 'p', { instruction: 'Check it.' }))
  assert.equal(session.past.length, before, '相同值 noop 不记历史')
  mustOk(setProgramFields(session, undefined, 'p', { instruction: null }))
  assert.ok(!('instruction' in session.draft.config.workflow.nodes['p'].execution))
  assert.equal(setProgramFields(session, undefined, 'p', { instruction: '  ' }).ok, false)
  assert.equal(setProgramFields(session, undefined, 'p', { programId: 'shell.evil' }).ok, false)
})

test('T4: 参数按元数据类型表达；未知键拒绝；删除键；删空省略 config', () => {
  const session = freshSession()
  mustOk(addProgramNode(session, undefined, 'p', {
    programId: 'github.initialize-milestone',
    passCriteria: 'Pass.', passTarget: { return: 'done' },
    failCriteria: 'Fail.', failTarget: { node: 'a' },
  }))
  // 真实元数据驱动：title/branchName 为必填 string。
  assert.equal(BUILTIN_PROGRAM_METADATA['github.initialize-milestone'].parameters['title'].required, true)
  mustOk(setProgramParam(session, undefined, 'p', 'title', 'Sprint 9'))
  mustOk(setProgramParam(session, undefined, 'p', 'branchName', 'milestone/s9'))
  assert.deepEqual(session.draft.config.workflow.nodes['p'].execution.config, { title: 'Sprint 9', branchName: 'milestone/s9' })
  assert.equal(setProgramParam(session, undefined, 'p', 'title', '').ok, false)
  assert.equal(setProgramParam(session, undefined, 'p', 'title', 42).ok, false)
  assert.equal(setProgramParam(session, undefined, 'p', 'nope', 'x').ok, false)
  assert.equal(setProgramParam(session, undefined, 'p', '', 'x').ok, false)
  // number 程序：有限 number 通过，字符串/无穷拒绝。
  mustOk(setProgramFields(session, undefined, 'p', { programId: 'github.all-milestone-issues-complete' }))
  mustOk(setProgramParam(session, undefined, 'p', 'milestoneNumber', 25))
  assert.equal(setProgramParam(session, undefined, 'p', 'milestoneNumber', '25').ok, false)
  assert.equal(setProgramParam(session, undefined, 'p', 'milestoneNumber', Number.POSITIVE_INFINITY).ok, false)
  // 删除：逐键删，删空后 config 键省略。
  mustOk(setProgramParam(session, undefined, 'p', 'milestoneNumber', undefined))
  assert.deepEqual(session.draft.config.workflow.nodes['p'].execution.config, { title: 'Sprint 9', branchName: 'milestone/s9' })
  mustOk(setProgramParam(session, undefined, 'p', 'title', undefined))
  mustOk(setProgramParam(session, undefined, 'p', 'branchName', undefined))
  assert.ok(!('config' in session.draft.config.workflow.nodes['p'].execution))
  assert.equal(setProgramParam(session, undefined, 'p', 'branchName', undefined).ok, false)
})

test('T4: 元数据 required 缺席不阻止保存（运行时可补参）', () => {
  const session = addWiredProgram(freshSession())
  // p 的 milestoneNumber 必填但编辑器内未填：保存前校验仍通过。
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
})

test('T4: 换程序保留 config；Actor 节点上调 Program op 拒绝', () => {
  const session = freshSession()
  mustOk(addProgramNode(session, undefined, 'p', {
    programId: 'github.initialize-milestone',
    config: { title: 'T', branchName: 'b' },
    passCriteria: 'Pass.', passTarget: { return: 'done' },
    failCriteria: 'Fail.', failTarget: { node: 'a' },
  }))
  mustOk(setProgramFields(session, undefined, 'p', { programId: 'github.all-milestone-issues-complete' }))
  assert.deepEqual(
    session.draft.config.workflow.nodes['p'].execution.config,
    { title: 'T', branchName: 'b' },
    '换程序不擅自删除 config',
  )
  assert.equal(setProgramFields(session, undefined, 'a', { instruction: 'x' }).ok, false)
  assert.equal(setProgramParam(session, undefined, 'a', 'title', 'x').ok, false)
  assert.equal(setProgramResult(session, undefined, 'a', 'PASS', { criteria: 'x' }).ok, false)
})

test('T4: PASS/FAIL 复用目标编辑（汇合/回路允许，直接自环阻止）', () => {
  const session = addWiredProgram(freshSession())
  // 直接自环拒绝。
  assert.equal(setProgramResult(session, undefined, 'p', 'PASS', { target: { node: 'p' } }).ok, false)
  // 汇合：FAIL 也指向 done。
  mustOk(setProgramResult(session, undefined, 'p', 'FAIL', { target: { return: 'done' } }))
  assert.deepEqual(session.draft.config.workflow.nodes['p'].results['FAIL'].target, { return: 'done' })
  // 回路：FAIL 指回 a（多节点回路不受影响）。
  mustOk(setProgramResult(session, undefined, 'p', 'FAIL', { criteria: 'Retry.', target: { node: 'a' } }))
  // 改名同步 Program 结果目标与入口。
  const renamed = renameNode(session, undefined, 'a', 'entry')
  assert.equal(renamed.ok, true)
  if (renamed.ok) assert.ok(renamed.updated > 0)
  assert.deepEqual(session.draft.config.workflow.nodes['p'].results['FAIL'].target, { node: 'entry' })
  assert.equal(session.draft.config.workflow.startNode, 'entry')
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
})

test('T4: 删除 Program 引用保留悬空并阻止保存；主入口守卫拒绝 Program', () => {
  const session = addWiredProgram(freshSession())
  assert.deepEqual(findNodeRefs(session, undefined, 'p').length > 0, true)
  mustOk(deleteNode(session, undefined, 'p'))
  const checked = validateDraft(session)
  assert.equal(checked.ok, false)
  assert.equal(setFlowStartNode(session, undefined, 'a').ok, true)
  const session2 = addWiredProgram(freshSession())
  assert.equal(setFlowStartNode(session2, undefined, 'p').ok, false)
})

test('T4: config 全量保留——导入未知字段经编辑往返不删除', () => {
  const withExtra = MINI_CONFIG.replace(
    'ok: { criteria: Done., target: { return: done } }',
    'ok: { criteria: Done., target: { node: p } }',
  ) + `    p:
      execution:
        type: builtin-program
        programId: github.initialize-milestone
        config: { title: T, branchName: b, futureFlag: true }
      results:
        PASS: { criteria: Pass., target: { return: done } }
        FAIL: { criteria: Fail., target: { node: a } }
`
  const loaded = loadDraft('mini', withExtra)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  const session = loaded.session
  mustOk(setProgramFields(session, undefined, 'p', { instruction: 'Check.' }))
  const roundtrip = validateAndNormalize(
    parseCatalogConfig(serializeConfig(session.draft.config).replace(/^#.*\n/, '')),
    { workflowId: 'mini' },
  )
  assert.equal(roundtrip.workflow.nodes['p'].execution.config['futureFlag'], true)
  assert.ok(businessEqual(roundtrip, session.draft.config))
})

test('T4: 撤销/重做覆盖 Program 编辑；整体上限拒绝超大 config', () => {
  const session = addWiredProgram(freshSession())
  mustOk(setProgramParam(session, undefined, 'p', 'milestoneNumber', 25))
  assert.equal(undo(session), true)
  assert.ok(session.draft.config.workflow.nodes['p'].execution.config === undefined)
  assert.equal(redo(session), true)
  assert.equal(session.draft.config.workflow.nodes['p'].execution.config['milestoneNumber'], 25)
  const huge = 'x'.repeat(9000)
  assert.equal(setProgramParam(session, undefined, 'p', 'milestoneNumber', huge).ok, false)
})

test('T4: 最小起点接入 Program 往返（新建→添加→保存重载等价）', () => {
  const session = newDraftSession('demo')
  mustOk(addProgramNode(session, undefined, 'check', {
    programId: 'github.all-milestone-issues-complete',
    config: { milestoneNumber: 25 },
    passCriteria: 'All closed.', passTarget: { return: 'done' },
    failCriteria: 'Open remain.', failTarget: { node: 'main' },
  }))
  mustOk(setNodeResult(session, undefined, 'main', 'done', { target: { node: 'check' } }))
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  const roundtrip = validateAndNormalize(
    parseCatalogConfig(serializeConfig(session.draft.config).replace(/^#.*\n/, '')),
    { workflowId: 'demo' },
  )
  assert.ok(businessEqual(roundtrip, session.draft.config))
  assert.equal(roundtrip.workflow.nodes['check'].execution.config['milestoneNumber'], 25)
})
