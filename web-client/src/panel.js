/**
 * 配置编辑面板（React plain-JS，无 JSX 工具链依赖；画布为最小占位实现）。
 *
 * 范围（T3 #162 在 T2 上追加）：新建合法 v3 配置（合法小写 .yaml 文件名、
 * 最小 Manager 入口起点）→ 切换主/子流程 → 编辑入口 startNode 与 returns →
 * Actor 节点新增/属性/改名/删除 → 命名结果 criteria/target 编辑 → 结果端口
 * 点选连线改目标 → 只读预览 → 校验后显式保存 → 分别报告 YAML/布局写入结果。
 *
 * 不做：Program（T4）、Child 映射与子流程定义增删（T5）。
 * 画布节点拖动用指针事件最小实现，结果连线用“端口点选 + 目标点选”最小实现；
 * （本票不引入 reactflow 打包，保持 bundle 零第三方）。
 * 不提供运行控制；保存成功只报告文件写入，不描述模型可用或可启动。
 *
 * 业务校验与布局规则全部走服务端 RPC（src/editor/* 单源），浏览器不复制规则。
 * 面板编辑变迁（历史/脏标记/保存计划）唯一来源为同目录 `edits.js`
 * （纯函数，可单测；脏语义钉住服务端 `draft.ts savePlan`）。
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { callEditor, rpcErrorMessage } from './rpc.js'
import {
  addActorNodeEdit, addFlowReturnEdit, addNodeResultEdit, addRoleEdit, applyPersonaEdit,
  checkNewFilename, deleteFlowReturnEdit, deleteNodeEdit, deleteNodeResultEdit, deleteRoleEdit, findNodeRefsEdit,
  findRoleRefs, ID_PATTERN, isDirty, layoutFilenameFor, minimalConfigOf, moveNodeEdit,
  parseNewFilenameEdit, redoEdit, renameFlowReturnEdit, renameNodeEdit, renameNodeResultEdit,
  renameRoleEdit, savePlanOf, setActorFieldsEdit, setFlowStartNodeEdit, setJudgeDenyEdit,
  setJudgeModelEdit, setJudgePersonaEdit, setNodeResultEdit, setRoleDenyEdit, setRoleModelEdit,
  setRolePersonaEdit, setRoleReuseEdit, SUPPORTED_CHECKER_IDS, undoEdit,
} from './edits.js'

/** deny 文本框解析：逗号/顿号/换行分隔，逐项 trim（空白项保留，由 edits 守卫明确拒绝）。 */
function parseDenyText(text) {
  return text.split(/[,，、\n]/).map((entry) => entry.trim())
}

/** 模型表单 → edits 输入：档位空白即省略该键（显式模型但未设档位）。 */
function modelInputOf(form) {
  return {
    provider: form.provider,
    modelId: form.modelId,
    reasoningEffort: form.effort.trim() === '' ? undefined : form.effort,
  }
}

function workflowIdOf(yamlName) {
  return yamlName.endsWith('.yaml') ? yamlName.slice(0, -'.yaml'.length) : yamlName
}

/** deny 列表 → 文本框（逗号分隔；缺席即空框，应用空框由守卫拒绝，清除请用清除按钮）。 */
function denyTextOf(deny) {
  return (deny ?? []).join(', ')
}

function roleFormOf(draft, sel) {
  const role = (draft.roles ?? {})[sel]
  return {
    sel,
    rename: sel,
    persona: role?.persona ?? '',
    provider: role?.model?.provider ?? '',
    modelId: role?.model?.modelId ?? '',
    effort: role?.model?.reasoningEffort ?? '',
    reuse: role?.reuse ?? 'node',
    deny: denyTextOf(role?.tools?.deny),
  }
}

function judgeFormOf(draft) {
  const judge = draft.judgeRole
  return {
    persona: judge.persona ?? '',
    provider: judge.model?.provider ?? '',
    modelId: judge.model?.modelId ?? '',
    effort: judge.model?.reasoningEffort ?? '',
    deny: denyTextOf(judge.tools?.deny),
  }
}

/** 结果目标表单 → edits/server 输入（kind node/return 二选一，无自由表达式）。 */
function targetOf(kind, value) {
  return kind === 'node' ? { node: value.trim() } : { return: value.trim() }
}

/** Actor 节点编辑表单（选定节点+草稿 → 输入态；业务唯一来源仍是 state.draft）。 */
function nodeEditFormOf(flowDef, nodeId) {
  const node = (flowDef.nodes ?? {})[nodeId]
  const execution = node?.execution ?? {}
  return {
    sel: nodeId,
    rename: nodeId,
    role: execution.role ?? 'manager',
    instruction: execution.instruction ?? '',
    checkerId: node?.checker?.checkerId ?? SUPPORTED_CHECKER_IDS[0],
    common: node?.checker?.config?.criteria ?? '',
  }
}

function emptyAddNodeForm(role) {
  return {
    id: '', role, instruction: '', checkerId: SUPPORTED_CHECKER_IDS[0], common: '',
    resultName: 'ok', resultCriteria: '', targetKind: 'return', targetValue: '',
  }
}

function emptyAddResultForm(flowDef) {
  const firstNode = Object.keys(flowDef.nodes ?? {})[0] ?? ''
  return { name: '', criteria: '', targetKind: 'node', targetValue: firstNode }
}

function targetLabel(target) {
  if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
    if (typeof target.node === 'string') return `→ 节点 ${target.node}`
    if (typeof target.return === 'string') return `→ 返回 ${target.return}`
  }
  return '→ 未知目标'
}

function nodeSummary(node) {
  const execution = node.execution ?? {}
  if (execution.type === 'actor-task') return `Actor/${execution.role ?? '?'}`
  if (execution.type === 'builtin-program') return `Program/${execution.programId ?? '?'}`
  if (execution.type === 'child-workflow') return `Child/${execution.workflowId ?? '?'}`
  return '未知类型'
}

function portsOf(node) {
  if (node.results !== null && typeof node.results === 'object' && !Array.isArray(node.results)) {
    return Object.entries(node.results).map(([name, result]) => ({
      key: name,
      label: `${name} · ${result?.criteria ?? ''} · ${targetLabel(result?.target)}`,
    }))
  }
  if (node.onReturn !== null && typeof node.onReturn === 'object' && !Array.isArray(node.onReturn)) {
    return Object.entries(node.onReturn).map(([name, target]) => ({
      key: name,
      label: `${name} ${targetLabel(target)}`,
    }))
  }
  return []
}

const initialState = {
  dirName: '',
  files: [],
  selected: null,
  workflowId: '',
  draft: null,
  warnings: [],
  problems: [],
  flow: null,
  positions: { main: {}, children: {} },
  personaInput: '',
  preview: null,
  dirtyBusiness: false,
  dirtyLayout: false,
  past: [],
  future: [],
  saveResult: null,
  busy: false,
}

async function readTextFile(dir, name) {
  const handle = await dir.getFileHandle(name)
  const file = await handle.getFile()
  return await file.text()
}

async function readLayoutText(dir, yamlName) {
  const layoutName = layoutFilenameFor(yamlName)
  if (layoutName === undefined) return { text: undefined, missing: true }
  try {
    return { text: await readTextFile(dir, layoutName), missing: false }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return { text: undefined, missing: true }
    throw error
  }
}

async function writeTextFile(dir, name, text) {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  try {
    await writable.write(text)
  } finally {
    await writable.close()
  }
}

export function WorkflowConfigEditorPanel(props) {
  const editorRpc = props.editorRpc
  const [dir, setDir] = useState(null)
  const [capError, setCapError] = useState(null)
  const [state, setState] = useState(initialState)
  const [flow, setFlow] = useState(null)
  const dragRef = useRef(null)
  // T2 表单缓冲（纯输入态，非业务模型；业务唯一来源仍是 state.draft，经 edits.js 变更）。
  const [newRole, setNewRole] = useState({ id: '', persona: '' })
  const [roleForm, setRoleForm] = useState({ sel: '', rename: '', persona: '', provider: '', modelId: '', effort: '', reuse: 'node', deny: '' })
  const [judgeForm, setJudgeForm] = useState({ persona: '', provider: '', modelId: '', effort: '', deny: '' })
  // T3 表单缓冲与选择态（同上：纯输入态；边身份 = 源节点 + 结果名）。
  const [newFileName, setNewFileName] = useState('')
  const [nodeSel, setNodeSel] = useState(null)
  const [addNode, setAddNode] = useState(emptyAddNodeForm('manager'))
  const [nodeEdit, setNodeEdit] = useState({
    sel: '', rename: '', role: 'manager', instruction: '',
    checkerId: SUPPORTED_CHECKER_IDS[0], common: '',
  })
  const [addResult, setAddResult] = useState({ name: '', criteria: '', targetKind: 'node', targetValue: '' })
  const [newReturn, setNewReturn] = useState('')
  const [wire, setWire] = useState(null)
  const lastSyncedFile = useRef(null)

  const dirty = isDirty(state)
  useEffect(() => {
    if (!dirty) return undefined
    const guard = (event) => {
      // 关闭/刷新提醒尽力提供（浏览器可能折叠提示）。
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  const call = useCallback(
    (endpoint, payload, signal) => editorRpc(endpoint, payload, signal),
    [editorRpc],
  )

  const openDirectory = useCallback(async () => {
    setCapError(null)
    // 打开新目录会丢弃当前文件列表与草稿：脏状态下需确认（切换文件已有同类确认）。
    if (isDirty(state) && !window.confirm('有未保存的修改，打开目录将放弃它们。继续吗？')) return
    if (typeof window.showDirectoryPicker !== 'function') {
      setCapError('当前浏览器不支持 File System Access 目录 API（需要 Chrome/Edge 等支持该能力的浏览器），未加载任何文件，也未使用服务端路径替代。')
      return
    }
    try {
      const picked = await window.showDirectoryPicker({ mode: 'readwrite' })
      const permission = await picked.requestPermission({ mode: 'readwrite' }).catch(() => 'denied')
      if (permission !== 'granted') {
        setCapError('目录读写授权被拒绝或撤销：未加载任何文件。请重新授权后重试。')
        return
      }
      const names = []
      for await (const entry of picked.values()) {
        if (entry.kind === 'file' && ID_PATTERN.test(entry.name.slice(0, -'.yaml'.length)) && entry.name.endsWith('.yaml')) {
          names.push(entry.name)
        }
      }
      names.sort()
      setDir(picked)
      setState({ ...initialState, dirName: picked.name ?? '', files: names })
      setFlow(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setCapError(`打开目录失败：${String(error?.message ?? error)}（未使用服务端路径替代）`)
    }
  }, [state])

  const selectFile = useCallback(async (name) => {
    if (dir === null) return
    if (isDirty(state) && !window.confirm('有未保存的修改，切换文件将放弃它们。继续切换吗？')) return
    setState((prev) => ({ ...prev, busy: true, saveResult: null }))
    try {
      const yamlText = await readTextFile(dir, name)
      const workflowId = workflowIdOf(name)
      const parsed = await call('parse', { workflowId, text: yamlText })
      if (!parsed.ok) {
        setState((prev) => ({
          ...prev, busy: false, selected: name, workflowId, draft: null,
          warnings: [], problems: [rpcErrorMessage(parsed)],
        }))
        return
      }
      const { normalized, warnings } = parsed.value
      const { text: layoutText } = await readLayoutText(dir, name)
      const resolved = await call('layout', { config: normalized, layoutText })
      if (!resolved.ok) {
        setState((prev) => ({
          ...prev, busy: false, selected: name, workflowId, draft: null,
          warnings: warnings ?? [], problems: [rpcErrorMessage(resolved)],
        }))
        return
      }
      const draft = normalized
      const positions = { main: {}, children: {}, ...(resolved.value.layout ?? {}) }
      const personaInput = typeof draft.actorCommonPersona === 'string' ? draft.actorCommonPersona : ''
      setFlow(null)
      setState({
        ...initialState, dirName: state.dirName, files: state.files,
        selected: name, workflowId, draft, warnings: [...(warnings ?? []), ...((resolved.value.warnings ?? []))],
        problems: [], flow: null, positions, personaInput,
      })
      await refreshPreview(draft)
    } catch (error) {
      setState((prev) => ({ ...prev, busy: false, problems: [`读取文件失败（权限/IO 错误如实上报，未伪装为文件缺失）：${String(error?.message ?? error)}`] }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, state.dirName, state.files, call])

  const refreshPreview = useCallback(async (draft) => {
    if (draft === null) return
    const previewed = await call('preview', { config: draft })
    if (!previewed.ok) {
      setState((prev) => ({ ...prev, problems: [rpcErrorMessage(previewed)] }))
      return
    }
    setState((prev) => ({ ...prev, preview: previewed.value }))
  }, [call])

  // 切换文件时用草稿重建表单缓冲（文件内编辑不回写缓冲，输入态不受覆盖）。
  useEffect(() => {
    if (state.selected === null || state.draft === null || lastSyncedFile.current === state.selected) return
    lastSyncedFile.current = state.selected
    const ids = Object.keys(state.draft.roles ?? {})
    setRoleForm(roleFormOf(state.draft, ids[0] ?? ''))
    setJudgeForm(judgeFormOf(state.draft))
    setNewRole({ id: '', persona: '' })
    setNodeSel(null)
    setAddNode(emptyAddNodeForm(ids[0] === undefined ? 'manager' : ids[0]))
    setAddResult({ name: '', criteria: '', targetKind: 'node', targetValue: '' })
    setNewReturn('')
    setWire(null)
  }, [state.selected, state.draft])

  /** edits 结果统一处理：失败入 problems；成功换草稿并刷新只读预览（同一草稿源）。 */
  const runEdit = useCallback(async (result, after) => {
    if (!result.ok) {
      setState((prev) => ({ ...prev, problems: [result.reason] }))
      return
    }
    if (result.noop === true) return
    setState(result.state)
    if (after !== undefined) after(result)
    await refreshPreview(result.state.draft)
  }, [refreshPreview])

  const syncRoleForm = useCallback((draft, sel) => {
    setRoleForm(roleFormOf(draft, sel))
  }, [])

  const applyPersona = useCallback(async (clear) => {
    if (state.draft === null) return
    const edited = applyPersonaEdit(state, clear)
    if (!edited.ok) {
      setState((prev) => ({ ...prev, problems: [edited.reason] }))
      return
    }
    if (edited.noop === true) return
    setState(edited.state)
    // 只读预览必须立即反映刚应用的草稿（此前仅加载/保存后刷新，预览滞后）。
    await refreshPreview(edited.state.draft)
  }, [state, refreshPreview])

  /* T2 角色/Judge/模型表单回调（同一草稿 + 同一撤销/预览通道）。 */
  const addNewRole = useCallback(async () => {
    const id = newRole.id.trim()
    await runEdit(addRoleEdit(state, id, { persona: newRole.persona }), (result) => {
      syncRoleForm(result.state.draft, id)
      setNewRole({ id: '', persona: '' })
    })
  }, [state, newRole, runEdit, syncRoleForm])

  const selectRole = useCallback((id) => {
    setRoleForm((prev) => (state.draft === null ? prev : roleFormOf(state.draft, id)))
  }, [state.draft])

  const renameSelectedRole = useCallback(async () => {
    const next = roleForm.rename.trim()
    await runEdit(renameRoleEdit(state, roleForm.sel, next), (result) => {
      syncRoleForm(result.state.draft, next)
    })
  }, [state, roleForm, runEdit, syncRoleForm])

  const applyRolePersona = useCallback(async () => {
    const sel = roleForm.sel
    await runEdit(setRolePersonaEdit(state, sel, roleForm.persona), (result) => {
      syncRoleForm(result.state.draft, sel)
    })
  }, [state, roleForm, runEdit, syncRoleForm])

  const applyRoleReuse = useCallback(async (reuse) => {
    const sel = roleForm.sel
    await runEdit(setRoleReuseEdit(state, sel, reuse), (result) => {
      syncRoleForm(result.state.draft, sel)
    })
  }, [state, roleForm.sel, runEdit, syncRoleForm])

  const applyRoleModel = useCallback(async () => {
    const sel = roleForm.sel
    await runEdit(setRoleModelEdit(state, sel, modelInputOf(roleForm)), (result) => {
      syncRoleForm(result.state.draft, sel)
    })
  }, [state, roleForm, runEdit, syncRoleForm])

  const clearRoleModel = useCallback(async () => {
    const sel = roleForm.sel
    await runEdit(setRoleModelEdit(state, sel, undefined), (result) => {
      syncRoleForm(result.state.draft, sel)
    })
  }, [state, roleForm.sel, runEdit, syncRoleForm])

  const applyRoleDeny = useCallback(async () => {
    const sel = roleForm.sel
    await runEdit(setRoleDenyEdit(state, sel, parseDenyText(roleForm.deny)), (result) => {
      syncRoleForm(result.state.draft, sel)
    })
  }, [state, roleForm, runEdit, syncRoleForm])

  const clearRoleDeny = useCallback(async () => {
    const sel = roleForm.sel
    await runEdit(setRoleDenyEdit(state, sel, undefined), (result) => {
      syncRoleForm(result.state.draft, sel)
    })
  }, [state, roleForm.sel, runEdit, syncRoleForm])

  const deleteSelectedRole = useCallback(async () => {
    const key = roleForm.sel
    const refs = state.draft === null ? [] : findRoleRefs(state.draft, key)
    if (!window.confirm(refs.length > 0
      ? `角色 "${key}" 仍有 ${refs.length} 处 Actor 引用，删除后保存将被阻止（须先修正引用）。继续删除吗？`
      : `删除角色 "${key}" 吗？`)) return
    await runEdit(deleteRoleEdit(state, key), (result) => {
      const ids = Object.keys(result.state.draft.roles ?? {})
      syncRoleForm(result.state.draft, ids[0] ?? '')
    })
  }, [state, roleForm.sel, runEdit, syncRoleForm])

  const applyJudgePersona = useCallback(async () => {
    await runEdit(setJudgePersonaEdit(state, judgeForm.persona), (result) => {
      setJudgeForm(judgeFormOf(result.state.draft))
    })
  }, [state, judgeForm, runEdit])

  const applyJudgeModel = useCallback(async () => {
    await runEdit(setJudgeModelEdit(state, modelInputOf(judgeForm)), (result) => {
      setJudgeForm(judgeFormOf(result.state.draft))
    })
  }, [state, judgeForm, runEdit])

  const clearJudgeModel = useCallback(async () => {
    await runEdit(setJudgeModelEdit(state, undefined), (result) => {
      setJudgeForm(judgeFormOf(result.state.draft))
    })
  }, [state, runEdit])

  const applyJudgeDeny = useCallback(async () => {
    await runEdit(setJudgeDenyEdit(state, parseDenyText(judgeForm.deny)), (result) => {
      setJudgeForm(judgeFormOf(result.state.draft))
    })
  }, [state, judgeForm, runEdit])

  const clearJudgeDeny = useCallback(async () => {
    await runEdit(setJudgeDenyEdit(state, undefined), (result) => {
      setJudgeForm(judgeFormOf(result.state.draft))
    })
  }, [state, runEdit])

  /* T3 新建/流程/Actor/结果表单回调（同一草稿 + 同一撤销/预览通道）。 */
  const createNewFile = useCallback(async () => {
    const name = newFileName.trim()
    const parsed = parseNewFilenameEdit(name)
    if (!parsed.ok) {
      setState((prev) => ({ ...prev, problems: [parsed.reason] }))
      return
    }
    // F-001：已存在文件拒绝新建覆盖（最小模板 save 会直接覆盖 YAML）。
    const conflict = checkNewFilename(state.files, name)
    if (!conflict.ok) {
      setState((prev) => ({ ...prev, problems: [conflict.reason] }))
      return
    }
    if (isDirty(state) && !window.confirm('有未保存的修改，新建文件将放弃它们。继续吗？')) return
    const workflowId = parsed.workflowId
    const draft = minimalConfigOf()
    const positions = { main: { main: { x: 40, y: 40 } }, children: {} }
    const files = state.files.includes(name) ? state.files : [...state.files, name].sort()
    setFlow(null)
    setNodeSel(null)
    setWire(null)
    setState({
      ...initialState, dirName: state.dirName, files,
      selected: name, workflowId, draft, warnings: [], problems: [],
      flow: null, positions, personaInput: '',
      dirtyBusiness: true, dirtyLayout: true,
    })
    await refreshPreview(draft)
  }, [newFileName, state, refreshPreview])

  const syncNodeEdit = useCallback((draft, flowDef, id) => {
    setNodeSel(id)
    setNodeEdit(nodeEditFormOf(flowDef, id))
    setAddResult(emptyAddResultForm(flowDef))
    setWire(null)
  }, [])

  const addActor = useCallback(async (flowId) => {
    const id = addNode.id.trim()
    await runEdit(addActorNodeEdit(state, flowId, id, {
      role: addNode.role,
      instruction: addNode.instruction,
      checkerId: addNode.checkerId,
      commonCriteria: addNode.common.trim() === '' ? undefined : addNode.common,
      resultName: addNode.resultName.trim(),
      resultCriteria: addNode.resultCriteria,
      target: targetOf(addNode.targetKind, addNode.targetValue),
    }), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, id)
      setAddNode((prev) => emptyAddNodeForm(prev.role))
    })
  }, [state, addNode, runEdit, syncNodeEdit])

  const applyNodeFields = useCallback(async (flowId) => {
    const sel = nodeEdit.sel
    await runEdit(setActorFieldsEdit(state, flowId, sel, {
      role: nodeEdit.role,
      instruction: nodeEdit.instruction,
      checkerId: nodeEdit.checkerId,
      commonCriteria: nodeEdit.common.trim() === ''
        ? ((flowId === null ? state.draft?.workflow : state.draft?.childWorkflows?.[flowId])?.nodes?.[sel]?.checker?.config?.criteria === undefined ? undefined : null)
        : nodeEdit.common,
    }), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, sel)
    })
  }, [state, nodeEdit, runEdit, syncNodeEdit])

  const renameSelectedNode = useCallback(async (flowId) => {
    const next = nodeEdit.rename.trim()
    await runEdit(renameNodeEdit(state, flowId, nodeEdit.sel, next), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, next)
    })
  }, [state, nodeEdit, runEdit, syncNodeEdit])

  const deleteSelectedNode = useCallback(async (flowId) => {
    const key = nodeEdit.sel
    const refs = state.draft === null ? [] : findNodeRefsEdit(state.draft, flowId, key)
    const hint = refs.length > 0
      ? `节点 "${key}" 仍有 ${refs.length} 处引用（${refs.map((r) => `${r.node}${r.detail}`).join('、')}），删除后保存将被阻止。继续删除吗？`
      : `删除节点 "${key}" 吗？`
    if (!window.confirm(hint)) return
    await runEdit(deleteNodeEdit(state, flowId, key), () => {
      setNodeSel(null)
      setWire(null)
    })
  }, [state, nodeEdit.sel, runEdit])

  const applyStartNode = useCallback(async (flowId, nodeId) => {
    await runEdit(setFlowStartNodeEdit(state, flowId, nodeId), undefined)
  }, [state, runEdit])

  const addReturn = useCallback(async (flowId) => {
    const name = newReturn.trim()
    await runEdit(addFlowReturnEdit(state, flowId, name), () => {
      setNewReturn('')
    })
  }, [state, newReturn, runEdit])

  const renameReturn = useCallback(async (flowId, oldName, nextName) => {
    await runEdit(renameFlowReturnEdit(state, flowId, oldName, nextName.trim()), undefined)
  }, [state, runEdit])

  const deleteReturn = useCallback(async (flowId, name) => {
    if (!window.confirm(`删除返回 "${name}" 吗？相关目标保留悬空，保存将被阻止（须先修正引用）。`)) return
    await runEdit(deleteFlowReturnEdit(state, flowId, name), undefined)
  }, [state, runEdit])

  const addResultRow = useCallback(async (flowId) => {
    await runEdit(addNodeResultEdit(state, flowId, nodeEdit.sel, addResult.name.trim(), addResult.criteria, targetOf(addResult.targetKind, addResult.targetValue)), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      setAddResult(emptyAddResultForm(flowDef))
    })
  }, [state, nodeEdit.sel, addResult, runEdit])

  const applyResult = useCallback(async (flowId, name, patch) => {
    await runEdit(setNodeResultEdit(state, flowId, nodeEdit.sel, name, patch), undefined)
  }, [state, nodeEdit.sel, runEdit])

  const renameResult = useCallback(async (flowId, name, nextName) => {
    await runEdit(renameNodeResultEdit(state, flowId, nodeEdit.sel, name, nextName.trim()), undefined)
  }, [state, nodeEdit.sel, runEdit])

  const deleteResult = useCallback(async (flowId, name) => {
    await runEdit(deleteNodeResultEdit(state, flowId, nodeEdit.sel, name), (result) => {
      if (wire !== null && wire.node === nodeEdit.sel && wire.result === name) setWire(null)
    })
  }, [state, nodeEdit.sel, wire, runEdit])

  /** 结果连线提交（拖线即只带 target 的 patch；一个结果只有一个目标）。 */
  const commitWire = useCallback(async (flowId, target) => {
    if (wire === null) return
    await runEdit(setNodeResultEdit(state, flowId, wire.node, wire.result, { target }), () => {
      setWire(null)
    })
  }, [state, wire, runEdit])


  const moveNode = useCallback((flowId, nodeId, pos) => {    setState((prev) => {
      const edited = moveNodeEdit(prev, flowId, nodeId, pos)
      if (!edited.ok || edited.noop === true) return prev
      return edited.state
    })
  }, [])

  const doUndo = useCallback(() => {
    setState((prev) => undoEdit(prev) ?? prev)
  }, [])

  const doRedo = useCallback(() => {
    setState((prev) => redoEdit(prev) ?? prev)
  }, [])

  const save = useCallback(async () => {
    if (dir === null || state.draft === null || state.selected === null) return
    setState((prev) => ({ ...prev, busy: true, saveResult: null, problems: [] }))
    // 业务写入前必须通过现有校验及编辑器限制检查（服务端）。
    const validated = await call('validate', { workflowId: state.workflowId, config: state.draft })
    if (!validated.ok) {
      setState((prev) => ({ ...prev, busy: false, problems: [rpcErrorMessage(validated)] }))
      return
    }
    const normalized = validated.value.normalized
    // 保存计划唯一口径：与服务端 draft.ts savePlan 同语义（edits.savePlanOf）。
    const plan = savePlanOf(state)
    const writeYaml = plan.writeYaml
    const writeLayout = plan.writeLayout
    const result = { yaml: null, layout: null }
    try {
      if (writeYaml) {
        const previewed = await call('preview', { config: normalized })
        if (!previewed.ok) throw new Error(rpcErrorMessage(previewed))
        await writeTextFile(dir, state.selected, previewed.value.yaml)
        result.yaml = { ok: true, message: `${state.selected} 已直接覆盖（统一格式，不保留原注释与排版）` }
      }
      if (writeLayout) {
        const resolved = await call('layout', { config: normalized })
        if (!resolved.ok) throw new Error(rpcErrorMessage(resolved))
        // 布局序列化与服务端保持一致：只写现存节点坐标（此处取服务端返回的完整布局）。
        const layoutName = layoutFilenameFor(state.selected)
        await writeTextFile(dir, layoutName, `${JSON.stringify(resolved.value.layout, null, 2)}\n`)
        result.layout = { ok: true, message: `${layoutName} 已写入` }
      }
      // 保存成功后用写入文本重载做业务等价抽查（防序列化漂移）。
      if (writeYaml) {
        const reread = await readTextFile(dir, state.selected)
        const reparsed = await call('parse', { workflowId: state.workflowId, text: reread })
        if (!reparsed.ok || JSON.stringify(reparsed.value.normalized) !== JSON.stringify(normalized)) {
          result.yaml = { ok: false, message: '重载抽查发现业务不一致：已保留未保存状态，请重试保存' }
          setState((prev) => ({ ...prev, busy: false, saveResult: result }))
          return
        }
      }
      setState((prev) => ({
        ...prev, busy: false, saveResult: result,
        draft: normalized,
        dirtyBusiness: result.yaml !== null && !result.yaml.ok,
        dirtyLayout: (result.yaml !== null && !result.yaml.ok) || (result.layout !== null && !result.layout.ok)
          ? true : false,
      }))
      await refreshPreview(normalized)
    } catch (error) {
      if (writeYaml && result.yaml === null) result.yaml = { ok: false, message: `YAML 写入失败：${String(error?.message ?? error)}（未保存状态已保留，可重试）` }
      else if (writeLayout && result.layout === null) result.layout = { ok: false, message: `布局写入失败：${String(error?.message ?? error)}（未保存状态已保留，可重试）` }
      else result.yaml = result.yaml ?? { ok: false, message: `保存失败：${String(error?.message ?? error)}` }
      setState((prev) => ({ ...prev, busy: false, saveResult: result }))
    }
  }, [dir, state.draft, state.selected, state.workflowId, state.dirtyBusiness, state.dirtyLayout, call, refreshPreview])

  const draft = state.draft
  const flows = draft === null
    ? []
    : [{ id: null, label: '主流程', def: draft.workflow }, ...Object.entries(draft.childWorkflows ?? {}).map(([id, def]) => ({ id, label: `子流程 ${id}`, def }))]
  const activeFlow = flows.find((f) => f.id === flow) ?? flows[0] ?? null
  const activePositions = activeFlow === null
    ? {}
    : (activeFlow.id === null ? state.positions.main : (state.positions.children[activeFlow.id] ?? {}))

  return h('div', { className: 'wf-editor' },
    h('h2', null, '工作流配置编辑器'),
    capError !== null ? h('div', { className: 'wf-error', role: 'alert' }, capError) : null,
    h('div', { className: 'wf-toolbar' },
      h('button', { onClick: openDirectory, disabled: state.busy }, '打开目录'),
      state.dirName !== '' ? h('span', null, `目录：${state.dirName}`) : null,
      draft !== null ? h('span', null, dirty ? '● 未保存' : '○ 已保存') : null,
      h('button', { onClick: doUndo, disabled: state.past.length === 0 || state.busy }, '撤销'),
      h('button', { onClick: doRedo, disabled: state.future.length === 0 || state.busy }, '重做'),
      h('button', { onClick: save, disabled: draft === null || !dirty || state.busy }, '保存'),
    ),
    state.files.length > 0 ? h('div', { className: 'wf-files' },
      h('span', null, '文件：'),
      ...state.files.map((name) => h('button', {
        key: name,
        onClick: () => selectFile(name),
        disabled: state.busy || state.selected === name,
      }, name)),
    ) : null,
    state.problems.length > 0 ? h('div', { className: 'wf-error', role: 'alert' },
      ...state.problems.map((message, index) => h('div', { key: index }, message)),
    ) : null,
    state.warnings.length > 0 ? h('div', { className: 'wf-warn' },
      ...state.warnings.map((message, index) => h('div', { key: index }, message)),
    ) : null,
    draft !== null ? h('div', { className: 'wf-main' },
      h('div', { className: 'wf-persona' },
        h('label', null, '公共 actorCommonPersona（省略=未设置）'),
        h('textarea', {
          value: state.personaInput,
          rows: 3,
          onChange: (event) => setState((prev) => ({ ...prev, personaInput: event.target.value })),
        }),
        h('button', { onClick: () => applyPersona(false), disabled: state.busy }, '应用'),
        h('button', { onClick: () => applyPersona(true), disabled: state.busy }, '清除'),
      ),
      h(RoleSection, {
        draft, roleForm, setRoleForm, newRole, setNewRole,
        onAdd: addNewRole, onSelect: selectRole, onRename: renameSelectedRole,
        onPersona: applyRolePersona, onReuse: applyRoleReuse, onModel: applyRoleModel,
        onClearModel: clearRoleModel, onDeny: applyRoleDeny, onClearDeny: clearRoleDeny,
        onDelete: deleteSelectedRole, busy: state.busy,
      }),
      h(JudgeSection, {
        draft, judgeForm, setJudgeForm,
        onPersona: applyJudgePersona, onModel: applyJudgeModel, onClearModel: clearJudgeModel,
        onDeny: applyJudgeDeny, onClearDeny: clearJudgeDeny, busy: state.busy,
      }),
      flows.length > 0 ? h('div', { className: 'wf-flows' },
        ...flows.map((f) => h('button', {
          key: f.id ?? '__main__',
          onClick: () => { setFlow(f.id); setNodeSel(null); setWire(null) },
          disabled: activeFlow !== null && f.id === activeFlow.id,
        }, f.label)),
      ) : null,
      h('div', { className: 'wf-newfile' },
        h('label', null, '新建合法小写 .yaml 文件名（工作流 ID 来自文件名，不写多余字段）'),
        h('input', { value: newFileName, onChange: (event) => setNewFileName(event.target.value), placeholder: 'review.yaml' }),
        h('button', { onClick: createNewFile, disabled: state.busy }, '新建配置'),
      ),
      activeFlow !== null ? h(FlowSection, {
        flowId: activeFlow.id, def: activeFlow.def, newReturn, setNewReturn,
        onStart: applyStartNode, onAddReturn: addReturn, onRenameReturn: renameReturn,
        onDeleteReturn: deleteReturn, busy: state.busy,
      }) : null,
      activeFlow !== null ? h(NodeSection, {
        draft, flowId: activeFlow.id, def: activeFlow.def,
        nodeSel, nodeEdit, setNodeEdit, addNode, setAddNode, addResult, setAddResult,
        onSelect: syncNodeEdit, onAdd: addActor, onFields: applyNodeFields,
        onRename: renameSelectedNode, onDelete: deleteSelectedNode,
        onAddResult: addResultRow, onApplyResult: applyResult,
        onRenameResult: renameResult, onDeleteResult: deleteResult,
        busy: state.busy,
      }) : null,
      activeFlow !== null ? h(NodeCanvas, {
        flowId: activeFlow.id,
        def: activeFlow.def,
        positions: activePositions,
        startNode: activeFlow.def.startNode,
        returns: activeFlow.def.returns,
        selectedNode: nodeSel,
        wire,
        onMove: moveNode,
        dragRef,
        onSelectNode: (id) => {
          const flowDef = activeFlow.def
          if ((flowDef.nodes ?? {})[id] === undefined) return
          syncNodeEdit(draft, flowDef, id)
        },
        onPortStart: (nodeId, result) => setWire({ node: nodeId, result }),
        onWireNode: (nodeId) => commitWire(activeFlow.id, { node: nodeId }),
        onWireReturn: (ret) => commitWire(activeFlow.id, { return: ret }),
        onCancelWire: () => setWire(null),
      }) : null,
      h('div', { className: 'wf-preview' },
        h('h3', null, state.preview !== null && state.preview.problems.length > 0 ? '只读 YAML 预览（草稿：未通过校验）' : '只读 YAML 预览'),
        h('pre', null, state.preview !== null ? state.preview.yaml : '（加载中…）'),
      ),
      state.saveResult !== null ? h('div', { className: 'wf-saveresult' },
        state.saveResult.yaml !== null ? h('div', null, `YAML：${state.saveResult.yaml.message}`) : null,
        state.saveResult.layout !== null ? h('div', null, `布局：${state.saveResult.layout.message}`) : null,
        h('div', null, '（两文件不承诺原子性；失败部分保留未保存状态，可重试）'),
      ) : null,
    ) : null,
  )
}

/**
 * T2 角色区：角色不是画布执行节点，只在此表单维护。
 * 全部经 edits.js 作用于同一草稿；改名同步更新 Actor 引用，删除保留悬空引用
 * （保存前校验诊断并阻止，未修正时 problems 明确报错）。
 */
function RoleSection(props) {
  const { draft, roleForm, setRoleForm, newRole, setNewRole } = props
  const setField = (field) => (event) => setRoleForm((prev) => ({ ...prev, [field]: event.target.value }))
  const roleIds = Object.keys(draft.roles ?? {})
  const selected = (draft.roles ?? {})[roleForm.sel]
  const refs = roleForm.sel === '' ? [] : findRoleRefs(draft, roleForm.sel)
  return h('div', { className: 'wf-roles' },
    h('h3', null, '角色（非画布节点）'),
    h('div', { className: 'wf-role-new' },
      h('label', null, '新增角色 id'),
      h('input', { value: newRole.id, onChange: (event) => setNewRole((prev) => ({ ...prev, id: event.target.value })) }),
      h('label', null, 'persona'),
      h('input', { value: newRole.persona, onChange: (event) => setNewRole((prev) => ({ ...prev, persona: event.target.value })) }),
      h('button', { onClick: props.onAdd, disabled: props.busy }, '新增角色'),
    ),
    roleIds.length > 0 ? h('div', { className: 'wf-role-list' },
      h('span', null, '角色：'),
      ...roleIds.map((id) => h('button', {
        key: id,
        onClick: () => props.onSelect(id),
        disabled: props.busy || id === roleForm.sel,
      }, id)),
    ) : h('div', null, '（暂无角色，请新增）'),
    selected === undefined ? null : h('div', { className: 'wf-role-card' },
      h('div', null, `当前：${roleForm.sel}（被 ${refs.length} 处 Actor 引用；改名同步更新，删除后保存将被阻止）`),
      h('div', null,
        h('label', null, '改名'),
        h('input', { value: roleForm.rename, onChange: setField('rename') }),
        h('button', { onClick: props.onRename, disabled: props.busy }, '改名'),
      ),
      h('div', null,
        h('label', null, 'persona'),
        h('textarea', { value: roleForm.persona, rows: 2, onChange: setField('persona') }),
        h('button', { onClick: props.onPersona, disabled: props.busy }, '应用'),
      ),
      h('div', null,
        h('label', null, '复用粒度 reuse（省略 = node）'),
        h('select', {
          value: roleForm.reuse,
          onChange: (event) => props.onReuse(event.target.value),
          disabled: props.busy,
        },
          h('option', { value: 'node' }, 'node'),
          h('option', { value: 'continuable' }, 'continuable'),
        ),
      ),
      h('div', null,
        h('label', null, '模型 provider（省略整模型请用清除按钮）'),
        h('input', { value: roleForm.provider, onChange: setField('provider') }),
        h('label', null, 'modelId'),
        h('input', { value: roleForm.modelId, onChange: setField('modelId') }),
        h('label', null, 'reasoningEffort（留空=显式模型但未设档位，不硬编码枚举）'),
        h('input', { value: roleForm.effort, onChange: setField('effort') }),
        h('button', { onClick: props.onModel, disabled: props.busy }, '应用模型'),
        h('button', { onClick: props.onClearModel, disabled: props.busy }, '清除模型'),
      ),
      h('div', null,
        h('label', null, 'tools.deny（逗号分隔；省略请用清除按钮）'),
        h('input', { value: roleForm.deny, onChange: setField('deny') }),
        h('button', { onClick: props.onDeny, disabled: props.busy }, '应用'),
        h('button', { onClick: props.onClearDeny, disabled: props.busy }, '清除'),
      ),
      h('button', { onClick: props.onDelete, disabled: props.busy }, '删除角色'),
    ),
  )
}

/** T2 Judge 区：persona/可选模型/tools.deny，不提供 reuse。 */
function JudgeSection(props) {
  const { judgeForm, setJudgeForm } = props
  const setField = (field) => (event) => setJudgeForm((prev) => ({ ...prev, [field]: event.target.value }))
  return h('div', { className: 'wf-judge' },
    h('h3', null, 'Judge（无复用配置；必需工具保护由服务端校验）'),
    h('div', null,
      h('label', null, 'persona'),
      h('textarea', { value: judgeForm.persona, rows: 2, onChange: setField('persona') }),
      h('button', { onClick: props.onPersona, disabled: props.busy }, '应用'),
    ),
    h('div', null,
      h('label', null, '模型 provider（省略整模型请用清除按钮）'),
      h('input', { value: judgeForm.provider, onChange: setField('provider') }),
      h('label', null, 'modelId'),
      h('input', { value: judgeForm.modelId, onChange: setField('modelId') }),
      h('label', null, 'reasoningEffort（留空=显式模型但未设档位）'),
      h('input', { value: judgeForm.effort, onChange: setField('effort') }),
      h('button', { onClick: props.onModel, disabled: props.busy }, '应用模型'),
      h('button', { onClick: props.onClearModel, disabled: props.busy }, '清除模型'),
    ),
    h('div', null,
      h('label', null, 'tools.deny（逗号分隔；省略请用清除按钮）'),
      h('input', { value: judgeForm.deny, onChange: setField('deny') }),
      h('button', { onClick: props.onDeny, disabled: props.busy }, '应用'),
      h('button', { onClick: props.onClearDeny, disabled: props.busy }, '清除'),
    ),
  )
}

/**
 * T3 流程区：入口 startNode 与 returns 增删改名。
 * 子流程定义的新增/删除留给 T5；返回改名同步 Child 调用方 onReturn 键。
 */
function FlowSection(props) {
  const { flowId, def, newReturn, setNewReturn } = props
  const nodeIds = Object.keys(def.nodes ?? {})
  return h('div', { className: 'wf-flowconf' },
    h('h3', null, flowId === null ? '主流程入口与返回' : `子流程 ${flowId} 入口与返回`),
    h('div', null,
      h('label', null, '入口 startNode（主流程须为 manager Actor）'),
      h('select', {
        value: def.startNode,
        onChange: (event) => props.onStart(flowId, event.target.value),
        disabled: props.busy,
      }, ...nodeIds.map((id) => h('option', { key: id, value: id }, id))),
    ),
    h('div', null,
      h('span', null, '返回 returns（改名同步目标与调用方映射，删除保留悬空）：'),
      ...(def.returns ?? []).map((name) => h(ReturnRow, {
        key: name, name, flowId,
        onRename: props.onRenameReturn, onDelete: props.onDeleteReturn, busy: props.busy,
      })),
    ),
    h('div', null,
      h('label', null, '新增返回'),
      h('input', { value: newReturn, onChange: (event) => setNewReturn(event.target.value) }),
      h('button', { onClick: () => props.onAddReturn(flowId), disabled: props.busy }, '新增返回'),
    ),
  )
}

function ReturnRow(props) {
  const [rename, setRename] = useState(props.name)
  return h('span', { className: 'wf-return' },
    h('code', null, props.name),
    h('input', { value: rename, onChange: (event) => setRename(event.target.value), disabled: props.busy }),
    h('button', { onClick: () => props.onRename(props.flowId, props.name, rename), disabled: props.busy }, '改名'),
    h('button', { onClick: () => props.onDelete(props.flowId, props.name), disabled: props.busy }, '删除'),
  )
}

/**
 * T3 Actor 节点区：节点不是角色——画布执行节点在此增删改名并编辑属性，
 * 命名结果的 criteria/target 在结果行内编辑。Program/Child 节点只读展示，
 * 不提供编辑入口（T4/T5；字段保持不丢失）。
 */
function NodeSection(props) {
  const { draft, flowId, def, nodeSel, nodeEdit, setNodeEdit, addNode, setAddNode, addResult, setAddResult } = props
  const setEdit = (field) => (event) => setNodeEdit((prev) => ({ ...prev, [field]: event.target.value }))
  const roleOptions = ['manager', ...Object.keys(draft.roles ?? {}).filter((r) => r !== 'manager')]
  const nodeIds = Object.keys(def.nodes ?? {})
  const selected = (def.nodes ?? {})[nodeSel]
  const isActor = selected?.execution?.type === 'actor-task'
  const results = isActor ? Object.entries(selected.results ?? {}) : []
  return h('div', { className: 'wf-nodes' },
    h('h3', null, 'Actor 节点与结果路由'),
    h('div', { className: 'wf-node-new' },
      h('label', null, '新增节点 id'),
      h('input', { value: addNode.id, onChange: (event) => setAddNode((prev) => ({ ...prev, id: event.target.value })) }),
      h('label', null, '角色（已有角色可选）'),
      h('select', { value: addNode.role, onChange: (event) => setAddNode((prev) => ({ ...prev, role: event.target.value })) },
        ...roleOptions.map((r) => h('option', { key: r, value: r }, r))),
      h('label', null, '指令'),
      h('input', { value: addNode.instruction, onChange: (event) => setAddNode((prev) => ({ ...prev, instruction: event.target.value })) }),
      h('label', null, 'checker'),
      h('select', { value: addNode.checkerId, onChange: (event) => setAddNode((prev) => ({ ...prev, checkerId: event.target.value })) },
        ...SUPPORTED_CHECKER_IDS.map((c) => h('option', { key: c, value: c }, c))),
      h('label', null, '共同 criteria（留空=无）'),
      h('input', { value: addNode.common, onChange: (event) => setAddNode((prev) => ({ ...prev, common: event.target.value })) }),
      h('label', null, '初始结果名'),
      h('input', { value: addNode.resultName, onChange: (event) => setAddNode((prev) => ({ ...prev, resultName: event.target.value })) }),
      h('label', null, '初始结果 criteria'),
      h('input', { value: addNode.resultCriteria, onChange: (event) => setAddNode((prev) => ({ ...prev, resultCriteria: event.target.value })) }),
      h('label', null, '初始目标'),
      h('select', { value: addNode.targetKind, onChange: (event) => setAddNode((prev) => ({ ...prev, targetKind: event.target.value })) },
        h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
      h('input', { value: addNode.targetValue, onChange: (event) => setAddNode((prev) => ({ ...prev, targetValue: event.target.value })) }),
      h('button', { onClick: () => props.onAdd(flowId), disabled: props.busy }, '新增节点'),
    ),
    nodeIds.length > 0 ? h('div', { className: 'wf-node-list' },
      h('span', null, '节点：'),
      ...nodeIds.map((id) => h('button', {
        key: id,
        onClick: () => props.onSelect(draft, def, id),
        disabled: props.busy || id === nodeSel,
      }, `${id}${id === def.startNode ? ' ★' : ''}`)),
    ) : h('div', null, '（暂无节点）'),
    selected === undefined ? null : h('div', { className: 'wf-node-card' },
      h('div', null, `当前：${nodeSel}（${selected.execution?.type ?? '未知类型'}；边身份 = 源节点 + 结果名）`),
      !isActor ? h('div', null, '（Program/Child 节点不在本票编辑范围，只读；其字段保持不丢失）') : h('div', null,
        h('div', null,
          h('label', null, '改名'),
          h('input', { value: nodeEdit.rename, onChange: setEdit('rename') }),
          h('button', { onClick: () => props.onRename(flowId), disabled: props.busy }, '改名'),
        ),
        h('div', null,
          h('label', null, '角色'),
          h('select', { value: nodeEdit.role, onChange: setEdit('role'), disabled: props.busy },
            ...roleOptions.map((r) => h('option', { key: r, value: r }, r))),
          h('label', null, '指令'),
          h('textarea', { value: nodeEdit.instruction, rows: 2, onChange: setEdit('instruction') }),
        ),
        h('div', null,
          h('label', null, 'checker'),
          h('select', { value: nodeEdit.checkerId, onChange: setEdit('checkerId'), disabled: props.busy },
            ...SUPPORTED_CHECKER_IDS.map((c) => h('option', { key: c, value: c }, c))),
          h('label', null, '共同 criteria（留空=清除/保持无）'),
          h('input', { value: nodeEdit.common, onChange: setEdit('common') }),
          h('button', { onClick: () => props.onFields(flowId), disabled: props.busy }, '应用属性'),
        ),
        h('div', { className: 'wf-results' },
          h('span', null, '命名结果（每结果一端口，点选连线改目标；Judge verdict 不是结果）：'),
          ...results.map(([name, result]) => h(ResultRow, {
            key: `${flowId ?? '__main__'}:${nodeSel}:${name}`,
            flowId, nodeId: nodeSel, name, result,
            returns: def.returns ?? [], nodeIds,
            onApply: props.onApplyResult, onRename: props.onRenameResult,
            onDelete: props.onDeleteResult, busy: props.busy,
          })),
        ),
        h('div', { className: 'wf-result-new' },
          h('label', null, '新增结果名'),
          h('input', { value: addResult.name, onChange: (event) => setAddResult((prev) => ({ ...prev, name: event.target.value })) }),
          h('label', null, 'criteria'),
          h('input', { value: addResult.criteria, onChange: (event) => setAddResult((prev) => ({ ...prev, criteria: event.target.value })) }),
          h('label', null, '目标'),
          h('select', { value: addResult.targetKind, onChange: (event) => setAddResult((prev) => ({ ...prev, targetKind: event.target.value })) },
            h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
          h('input', { value: addResult.targetValue, onChange: (event) => setAddResult((prev) => ({ ...prev, targetValue: event.target.value })) }),
          h('button', { onClick: () => props.onAddResult(flowId), disabled: props.busy }, '新增结果'),
        ),
        h('button', { onClick: () => props.onDelete(flowId), disabled: props.busy }, '删除节点'),
      ),
    ),
  )
}

/** 单个命名结果行：本地缓冲 criteria/目标/改名，应用时一次性 patch。 */
function ResultRow(props) {
  const { flowId, nodeId, name, result } = props
  const initialKind = result?.target?.node !== undefined ? 'node' : 'return'
  const initialValue = result?.target?.node ?? result?.target?.return ?? ''
  const [criteria, setCriteria] = useState(result?.criteria ?? '')
  const [kind, setKind] = useState(initialKind)
  const [value, setValue] = useState(initialValue)
  const [rename, setRename] = useState(name)
  const targetText = result?.target?.node !== undefined ? `→ 节点 ${result.target.node}` : `→ 返回 ${result.target.return}`
  return h('div', { className: 'wf-result-row' },
    h('code', null, `${name} · ${targetText}`),
    h('label', null, 'criteria'),
    h('input', { value: criteria, onChange: (event) => setCriteria(event.target.value), disabled: props.busy }),
    h('label', null, '目标'),
    h('select', { value: kind, onChange: (event) => setKind(event.target.value), disabled: props.busy },
      h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
    h('input', { value, onChange: (event) => setValue(event.target.value), disabled: props.busy }),
    h('button', {
      onClick: () => props.onApply(flowId, name, {
        criteria, target: kind === 'node' ? { node: value.trim() } : { return: value.trim() },
      }),
      disabled: props.busy,
    }, '应用'),
    h('input', { value: rename, onChange: (event) => setRename(event.target.value), disabled: props.busy }),
    h('button', { onClick: () => props.onRename(flowId, name, rename), disabled: props.busy }, '改名'),
    h('button', { onClick: () => props.onDelete(flowId, name), disabled: props.busy }, '删除'),
  )
}

function NodeCanvas(props) {
  const { flowId, def, positions, startNode, returns, onMove, dragRef } = props
  const { selectedNode, wire, onSelectNode, onPortStart, onWireNode, onWireReturn, onCancelWire } = props
  const nodes = Object.entries(def.nodes ?? {})
  const onPointerDown = (event, nodeId) => {
    const start = positions[nodeId] ?? { x: 0, y: 0 }
    dragRef.current = { nodeId, startX: event.clientX, startY: event.clientY, origin: start }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event, nodeId) => {
    const drag = dragRef.current
    if (drag === null || drag.nodeId !== nodeId) return
    onMove(flowId, nodeId, {
      x: Math.round(drag.origin.x + (event.clientX - drag.startX)),
      y: Math.round(drag.origin.y + (event.clientY - drag.startY)),
    })
  }
  const onPointerUp = () => {
    dragRef.current = null
  }
  return h('div', { className: 'wf-flow' },
    h('div', null, `入口：${startNode}　返回：${(returns ?? []).join(', ')}（返回为视觉标记，非执行节点）`),
    wire !== null ? h('div', { className: 'wf-wire' },
      h('span', null, `连线中：${wire.node} · ${wire.result} → 点击目标节点或返回（一个结果只有一个目标）`),
      h('button', { onClick: onCancelWire }, '取消连线'),
    ) : null,
    h('div', null,
      h('span', null, '返回目标：'),
      ...(returns ?? []).map((ret) => h('button', {
        key: ret,
        onClick: () => (wire !== null ? onWireReturn(ret) : null),
        disabled: wire === null,
        title: wire === null ? '先点击结果端口再选择返回目标' : `将 ${wire.node} · ${wire.result} 指向返回 ${ret}`,
      }, `⇥ ${ret}`)),
    ),
    h('div', { className: 'wf-canvas' },
      ...nodes.map(([nodeId, node], index) => {
        const pos = positions[nodeId] ?? { x: 40 + (index % 4) * 220, y: 40 + Math.floor(index / 4) * 140 }
        return h('div', {
          key: nodeId,
          className: `wf-node${nodeId === selectedNode ? ' wf-selected' : ''}`,
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onPointerDown: (event) => onPointerDown(event, nodeId),
          onPointerMove: (event) => onPointerMove(event, nodeId),
          onPointerUp,
          onClick: (event) => {
            // 连线中点击节点 = 选择连线目标；否则选中节点进属性表单。
            if (wire !== null) onWireNode(nodeId)
            else if (event.target === event.currentTarget) onSelectNode(nodeId)
          },
        },
          h('div', {
            className: 'wf-node-title',
            onClick: () => {
              if (wire !== null) onWireNode(nodeId)
              else onSelectNode(nodeId)
            },
          }, `${nodeId}${nodeId === startNode ? ' ★' : ''}`),
          h('div', { className: 'wf-node-type' }, nodeSummary(node)),
          ...portsOf(node).map((port) => h('div', {
            key: port.key,
            className: `wf-port${wire !== null && wire.node === nodeId && wire.result === port.key ? ' wf-wiring' : ''}`,
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.stopPropagation()
              onPortStart(nodeId, port.key)
            },
            title: '点击开始连线，再点击目标节点或返回',
          }, `○ ${port.label}`)),
          h('div', { className: 'wf-pos' }, `(${pos.x}, ${pos.y})`),
        )
      }),
    ),
    h('div', null, '（T3 画布：拖动改位置，点击节点进属性表单；结果端口点选后再点目标完成连线，不支持自由条件表达式）'),
  )
}

export function WorkflowConfigEditorIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
    h('rect', { x: 2, y: 2, width: 5, height: 5, fill: 'currentColor' }),
    h('rect', { x: 9, y: 2, width: 5, height: 5, fill: 'currentColor', opacity: 0.5 }),
    h('rect', { x: 2, y: 9, width: 5, height: 5, fill: 'currentColor', opacity: 0.5 }),
    h('rect', { x: 9, y: 9, width: 5, height: 5, fill: 'currentColor' }),
  )
}
