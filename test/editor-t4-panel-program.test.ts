/**
 * T4（#163）面板侧 Program 变迁：`web-client/src/edits.js` 镜像行为，
 * 并与服务端 `draft.ts` 同操作对比钉住一致（防手抄漂移）。
 *
 * 程序单源：镜像以显形 `programCatalog` 参数接收元数据，本文件传入真实
 * `BUILTIN_PROGRAM_METADATA`（与面板经 RPC `metadata` 端点取到的同一份）；
 * 面板不硬编码程序注册表。`PROGRAM_PARAMETERS_MAX` 与服务端 LIMITS 同值钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addProgramNodeEdit, deleteNodeEdit, redoEdit, renameNodeEdit,
  setNodeResultEdit,
  setProgramFieldsEdit, setProgramParamEdit, setProgramResultEdit,
  undoEdit, PROGRAM_PARAMETERS_MAX,
} from '../web-client/src/edits.js'
import {
  addProgramNode, deleteNode, loadDraft,
  redo, renameNode, setNodeResult,
  setProgramFields, setProgramParam, setProgramResult,
  undo, validateDraft,
} from '../src/editor/draft.ts'
import { createEditorRpcHandler, rpcProgramMetadata } from '../src/editor/rpc.ts'
import { BUILTIN_PROGRAM_METADATA } from '../src/programs/metadata.ts'
import { LIMITS } from '../src/types.ts'

const CATALOG = BUILTIN_PROGRAM_METADATA

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
    positions: { main: { a: { x: 40, y: 40 } }, children: {} },
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

const PROGRAM_FIELDS = {
  programId: 'github.all-milestone-issues-complete',
  passCriteria: 'All issues closed.',
  passTarget: { return: 'done' },
  failCriteria: 'Still open issues.',
  failTarget: { node: 'a' },
}

test('T4-panel: metadata 端点直出真实元数据（面板单源，无硬编码注册表）', async () => {
  const direct = rpcProgramMetadata()
  assert.equal(direct.ok, true)
  if (!direct.ok) throw new Error('unreachable')
  assert.deepEqual(direct.value.programs, BUILTIN_PROGRAM_METADATA)
  const handler = createEditorRpcHandler()
  const viaHandler = await handler('metadata', {}, AbortSignal.timeout(5000))
  assert.equal(viaHandler.ok, true)
  if (!viaHandler.ok) throw new Error('unreachable')
  assert.deepEqual(viaHandler.value.programs, BUILTIN_PROGRAM_METADATA)
  assert.ok(Object.keys(viaHandler.value.programs).length > 0)
  const unknown = await handler('rm', {})
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.error.message, /metadata/)
  assert.equal(PROGRAM_PARAMETERS_MAX, LIMITS.programParametersMax)
})

test('T4-panel: 新增/属性/参数/结果镜像行为（真实 catalog）', () => {
  let panel = freshPanel()
  assert.equal(addProgramNodeEdit(panel, null, 'p', { ...PROGRAM_FIELDS, programId: 'shell.evil' }, CATALOG).ok, false)
  panel = mustOk(addProgramNodeEdit(panel, null, 'p', PROGRAM_FIELDS, CATALOG))
  const node = panel.draft.workflow.nodes['p']
  assert.equal(node.execution.type, 'builtin-program')
  assert.deepEqual(Object.keys(node.results).sort(), ['FAIL', 'PASS'])
  assert.deepEqual(panel.positions.main['p'], { x: 260, y: 40 })
  assert.equal(panel.dirtyBusiness, true)

  panel = mustOk(setProgramFieldsEdit(panel, null, 'p', { instruction: 'Check.' }, CATALOG))
  assert.equal(panel.draft.workflow.nodes['p'].execution.instruction, 'Check.')
  panel = mustOk(setProgramFieldsEdit(panel, null, 'p', { instruction: null }, CATALOG))
  assert.ok(!('instruction' in panel.draft.workflow.nodes['p'].execution))
  assert.equal(setProgramFieldsEdit(panel, null, 'p', { instruction: '' }, CATALOG).ok, false)

  panel = mustOk(setProgramParamEdit(panel, null, 'p', 'milestoneNumber', 25, CATALOG))
  assert.equal(panel.draft.workflow.nodes['p'].execution.config['milestoneNumber'], 25)
  assert.equal(setProgramParamEdit(panel, null, 'p', 'milestoneNumber', '25', CATALOG).ok, false)
  assert.equal(setProgramParamEdit(panel, null, 'p', 'nope', 1, CATALOG).ok, false)
  panel = mustOk(setProgramParamEdit(panel, null, 'p', 'milestoneNumber', undefined, CATALOG))
  assert.ok(!('config' in panel.draft.workflow.nodes['p'].execution))

  panel = mustOk(setProgramResultEdit(panel, null, 'p', 'FAIL', { target: { return: 'done' } }))
  assert.deepEqual(panel.draft.workflow.nodes['p'].results['FAIL'].target, { return: 'done' })
  assert.equal(setProgramResultEdit(panel, null, 'p', 'PASS', { target: { node: 'p' } }).ok, false)
  assert.equal(setProgramResultEdit(panel, null, 'p', 'ok', { criteria: 'Done.' }).ok, false)
})

test('T4-panel: 服务端↔面板同操作对比（新增/属性/参数/结果/改名/删除）', () => {
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
    () => addProgramNode(server, undefined, 'p', PROGRAM_FIELDS),
    () => addProgramNodeEdit(panel, null, 'p', PROGRAM_FIELDS, CATALOG),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['p'], panel.draft.workflow.nodes['p'])
  applyBoth(
    () => setProgramFields(server, undefined, 'p', { instruction: 'Check.' }),
    () => setProgramFieldsEdit(panel, null, 'p', { instruction: 'Check.' }, CATALOG),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['p'], panel.draft.workflow.nodes['p'])
  applyBoth(
    () => setProgramParam(server, undefined, 'p', 'milestoneNumber', 25),
    () => setProgramParamEdit(panel, null, 'p', 'milestoneNumber', 25, CATALOG),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['p'], panel.draft.workflow.nodes['p'])
  applyBoth(
    () => setProgramResult(server, undefined, 'p', 'FAIL', { criteria: 'Retry.', target: { node: 'a' } }),
    () => setProgramResultEdit(panel, null, 'p', 'FAIL', { criteria: 'Retry.', target: { node: 'a' } }, ),
  )
  assert.deepEqual(server.draft.config.workflow.nodes['p'], panel.draft.workflow.nodes['p'])
  // 拒绝口径一致（含 reason 文本）。
  applyBoth(
    () => addProgramNode(server, undefined, 'q', { ...PROGRAM_FIELDS, programId: 'shell.evil' }),
    () => addProgramNodeEdit(panel, null, 'q', { ...PROGRAM_FIELDS, programId: 'shell.evil' }, CATALOG),
  )
  applyBoth(
    () => setProgramParam(server, undefined, 'p', 'nope', 1),
    () => setProgramParamEdit(panel, null, 'p', 'nope', 1, CATALOG),
  )
  applyBoth(
    () => setProgramResult(server, undefined, 'p', 'ok', { criteria: 'Done.' }),
    () => setProgramResultEdit(panel, null, 'p', 'ok', { criteria: 'Done.' }),
  )
  // 通用改名/删除同步 Program 结果目标。
  applyBoth(
    () => renameNode(server, undefined, 'a', 'entry'),
    () => renameNodeEdit(panel, null, 'a', 'entry'),
  )
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  applyBoth(
    () => deleteNode(server, undefined, 'p'),
    () => deleteNodeEdit(panel, null, 'p'),
  )
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
})

test('T4-panel: 镜像 config 全量保留 + 撤销/重做', () => {
  let panel = freshPanel()
  panel.draft.workflow.nodes['p'] = {
    execution: {
      type: 'builtin-program',
      programId: 'github.initialize-milestone',
      config: { title: 'T', branchName: 'b', futureFlag: true },
    },
    results: {
      PASS: { criteria: 'Pass.', target: { return: 'done' } },
      FAIL: { criteria: 'Fail.', target: { node: 'a' } },
    },
  }
  panel = mustOk(setProgramFieldsEdit(panel, null, 'p', { instruction: 'Check.' }, CATALOG))
  assert.equal(panel.draft.workflow.nodes['p'].execution.config['futureFlag'], true)
  panel = mustOk(setProgramParamEdit(panel, null, 'p', 'title', 'T2', CATALOG))
  const undone = undoEdit(panel)
  assert.ok(undone !== null && undone.draft.workflow.nodes['p'].execution.config['title'] === 'T')
  if (undone === null) throw new Error('unreachable')
  panel = redoEdit(undone)!
  assert.equal(panel.draft.workflow.nodes['p'].execution.config['title'], 'T2')
})

test('T4-panel: 镜像 required 缺席不阻止保存（与服务端同口径）', () => {
  const server = serverSession()
  let panel = freshPanel()
  assert.equal(addProgramNode(server, undefined, 'p', PROGRAM_FIELDS).ok, true)
  panel = mustOk(addProgramNodeEdit(panel, null, 'p', PROGRAM_FIELDS, CATALOG))
  assert.deepEqual(server.draft.config.workflow.nodes['p'], panel.draft.workflow.nodes['p'])
  // 接线使 p 可达（双边同操作），随后 milestoneNumber 必填但未填仍通过。
  assert.equal(setNodeResult(server, undefined, 'a', 'ok', { target: { node: 'p' } }).ok, true)
  panel = mustOk(setNodeResultEdit(panel, null, 'a', 'ok', { target: { node: 'p' } }))
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  // milestoneNumber 必填但未填：面板草稿经服务端 validate 同样通过。
  const checked = validateDraft(server)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  assert.equal(undo(server), true)
  const rewound = undoEdit(panel)
  assert.ok(rewound !== null)
  if (rewound === null) throw new Error('unreachable')
  panel = rewound
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
  assert.equal(redo(server), true)
  panel = redoEdit(panel)!
  assert.deepEqual(server.draft.config.workflow.nodes, panel.draft.workflow.nodes)
})
