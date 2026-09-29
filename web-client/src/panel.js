/**
 * 配置编辑面板（React plain-JS，无 JSX 工具链依赖；画布与属性面板分区显示）。
 *
 * 范围（T5 #164 在 T4 上追加）：子流程新增/改名/删除与画布切换、Child
 * 节点新增/改名/删除与 execution.workflowId 编辑、按被调用流程 returns 显示
 * 输出端口并编辑 onReturn 映射（未完成映射明确提示，不静默猜测）。
 * T4 Program 能力沿用：程序与参数合同只读服务端 metadata RPC 单源。
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
import { ModelFields } from './model-selector.js'
import { EDITOR_STYLES } from './styles.js'
import {
  addActorNodeEdit, addChildNodeEdit, addFlowReturnEdit, addNodeResultEdit, addProgramNodeEdit, addRoleEdit, addSubflowEdit, applyPersonaEdit,
  checkNewFilename, deleteFlowReturnEdit, deleteNodeEdit, deleteNodeResultEdit, deleteRoleEdit, deleteSubflowEdit, findNodeRefsEdit,
  findRoleRefs, findSubflowCallersEdit, ID_PATTERN, isDirty, layoutFilenameFor, minimalConfigOf, moveNodeEdit,
  parseNewFilenameEdit, redoEdit, renameFlowReturnEdit, renameNodeEdit, renameNodeResultEdit, renameSubflowEdit,
  renameRoleEdit, savePlanOf, setActorFieldsEdit, setChildReturnTargetEdit, setChildWorkflowIdEdit, setFlowStartNodeEdit, setJudgeDenyEdit,
  setJudgeModelEdit, setJudgePersonaEdit, setNodeResultEdit, setProgramFieldsEdit, setProgramParamEdit,
  setProgramResultEdit, setRoleDenyEdit, setRoleModelEdit,
  setRolePersonaEdit, setRoleReuseEdit, SUPPORTED_CHECKER_IDS, undoEdit,
} from './edits.js'

/** deny 文本框解析：逗号/顿号/换行分隔，逐项 trim（空白项保留，由 edits 守卫明确拒绝）。 */
function LongTextField({ value, onChange, title, disabled }) {
  const dialog = useRef(null)
  const [buffer, setBuffer] = useState('')
  return h('div', { className: 'wf-long-text' },
    h('button', {
      type: 'button', disabled, className: 'wf-text-preview',
      'aria-label': `编辑${title}`, title: value || `编辑${title}`,
      onClick: () => { setBuffer(value ?? ''); dialog.current.showModal() },
    }, value || '未设置 · 点击编辑'),
    h('dialog', { ref: dialog, className: 'wf-text-dialog', 'aria-label': title },
      h('h3', null, title),
      h('textarea', { value: buffer, autoFocus: true, spellCheck: false, 'aria-label': title,
        onChange: (event) => setBuffer(event.target.value) }),
      h('div', { className: 'wf-dialog-actions' },
        h('span', { className: 'wf-hint' }, '确认后点击表单的应用按钮，再保存配置文件。'),
        h('button', { type: 'button', onClick: () => dialog.current.close() }, '取消'),
        h('button', { type: 'button', className: 'wf-primary', onClick: () => {
          onChange({ target: { value: buffer } }); dialog.current.close()
        } }, '确认'),
      ),
    ),
  )
}

function parseDenyText(text) {
  return text.split(/[,，、\n]/).map((entry) => entry.trim())
}

/* 上次授权目录句柄的持久化（IndexedDB 单键 kv）。ponytail: 浏览器安全模型不允许
   无授权预选路径；仅记住用户已授权的句柄，权限仍为 granted 才恢复，任何失败静默
   回落手动「打开目录」。升级路径：多目录列表 + 每目录最近文件。 */
function idbOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('wf-editor-prefs', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('kv')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function rememberDirHandle(handle) {
  try {
    const db = await idbOpenDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite')
      tx.objectStore('kv').put(handle, 'lastDir')
      tx.oncomplete = () => resolve(undefined)
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch { /* 持久化失败不影响本次会话 */ }
}

async function readRememberedDirHandle() {
  try {
    const db = await idbOpenDb()
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction('kv').objectStore('kv').get('lastDir')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return handle ?? null
  } catch { return null }
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

/** Program 节点编辑表单（选定节点+草稿 → 输入态；业务唯一来源仍是 state.draft）。 */
function programEditFormOf(flowDef, nodeId, programIds) {
  const node = (flowDef.nodes ?? {})[nodeId]
  const execution = node?.execution ?? {}
  return {
    sel: nodeId,
    rename: nodeId,
    programId: execution.programId ?? programIds[0] ?? '',
    instruction: execution.instruction ?? '',
  }
}

function emptyAddProgramForm(programIds) {
  return {
    id: '', programId: programIds[0] ?? '', instruction: '',
    passCriteria: '', passTargetKind: 'return', passTargetValue: '',
    failCriteria: '', failTargetKind: 'return', failTargetValue: '',
  }
}

/** Child 节点编辑表单（选定节点+草稿 → 输入态；业务唯一来源仍是 state.draft）。 */
function childEditFormOf(flowDef, nodeId) {
  const node = (flowDef.nodes ?? {})[nodeId]
  return { sel: nodeId, rename: nodeId, callee: node?.execution?.workflowId ?? '' }
}

function emptyAddChildForm(subflowIds) {
  return { id: '', callee: subflowIds[0] ?? '' }
}

/** 单个返回映射的目标输入初值（留空待用户逐项填写，不静默猜测）。 */
function emptyChildTargetForm() {
  return { kind: 'return', value: '' }
}

/**
 * Child 映射完成状态（派生展示，不写回草稿）：被调用方缺席即悬空；
 * missing/extra 明确提示未完成映射，由保存前校验阻止保存。
 */
function childMappingStatus(draft, node) {
  const calleeId = node.execution?.workflowId
  const callee = (draft.childWorkflows ?? {})[calleeId]
  if (callee === undefined) return { dangling: true, calleeId, missing: [], extra: [] }
  const contract = callee.returns ?? []
  const keys = Object.keys(node.onReturn ?? {})
  return {
    dangling: false,
    calleeId,
    missing: contract.filter((name) => !keys.includes(name)),
    extra: keys.filter((name) => !contract.includes(name)),
  }
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
  const [restoreCandidate, setRestoreCandidate] = useState(null)
  const [state, setState] = useState(initialState)
  const [flow, setFlow] = useState(null)
  const [tab, setTab] = useState('nodes')
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false)
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
  // T4 Program 表单缓冲与元数据（程序/参数合同只读服务端 metadata RPC，不硬编码）。
  const [addProgram, setAddProgram] = useState(emptyAddProgramForm([]))
  const [programEdit, setProgramEdit] = useState({ sel: '', rename: '', programId: '', instruction: '' })
  const [programCatalog, setProgramCatalog] = useState(null)
  const [programCatalogError, setProgramCatalogError] = useState(null)
  // T5 子流程与 Child 表单缓冲（纯输入态；被调用方合同来自草稿自身）。
  const [newSubflow, setNewSubflow] = useState('')
  const [renameSubflow, setRenameSubflow] = useState('')
  const [addChild, setAddChild] = useState({ id: '', callee: '' })
  const [addChildTargets, setAddChildTargets] = useState({})
  const [childEdit, setChildEdit] = useState({ sel: '', rename: '', callee: '' })
  const lastSyncedFile = useRef(null)
  const previewRequest = useRef(0)
  const fileRequest = useRef(0)
  const [formRevision, setFormRevision] = useState(0)

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

  /* 列出目录内合法命名 YAML 并整体重置编辑状态（打开与恢复共用）。 */
  const adoptDirectory = useCallback(async (picked) => {
    ++fileRequest.current
    ++previewRequest.current
    lastSyncedFile.current = null
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
  }, [])

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
      await adoptDirectory(picked)
      await rememberDirHandle(picked)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setCapError(`打开目录失败：${String(error?.message ?? error)}（未使用服务端路径替代）`)
    }
    // state 仅用于脏检查；adoptDirectory 自带完整状态重置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, adoptDirectory])

  /* 打开面板时自动恢复上次授权目录：权限仍为 granted 直接恢复；退回 prompt 时
     记下候选句柄，渲染「恢复上次目录」按钮——requestPermission 需要用户手势，
     浏览器安全模型不允许无授权静默恢复。 */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const saved = await readRememberedDirHandle()
      if (saved === null || cancelled) return
      let permission = 'denied'
      try { permission = await saved.queryPermission({ mode: 'readwrite' }) } catch { /* 句柄失效按未授权处理 */ return }
      if (cancelled) return
      if (permission === 'granted') await adoptDirectory(saved)
      else setRestoreCandidate(saved)
    })()
    return () => { cancelled = true }
  }, [adoptDirectory])

  const restoreDirectory = useCallback(async () => {
    const saved = restoreCandidate
    if (saved === null) return
    setRestoreCandidate(null)
    try {
      const permission = await saved.requestPermission({ mode: 'readwrite' }).catch(() => 'denied')
      if (permission !== 'granted') {
        setCapError('恢复目录授权被拒绝：请点「打开目录」重新选择。')
        return
      }
      await adoptDirectory(saved)
    } catch (error) {
      setCapError(`恢复上次目录失败：${String(error?.message ?? error)}`)
    }
  }, [restoreCandidate, adoptDirectory])

  const selectFile = useCallback(async (name) => {
    if (dir === null) return
    if (isDirty(state) && !window.confirm('有未保存的修改，切换文件将放弃它们。继续切换吗？')) return
    const request = ++fileRequest.current
    ++previewRequest.current
    setState((prev) => ({ ...prev, busy: true, saveResult: null }))
    try {
      const [yamlText, { text: layoutText }] = await Promise.all([
        readTextFile(dir, name), readLayoutText(dir, name),
      ])
      const workflowId = workflowIdOf(name)
      const parsed = await call('parse', { workflowId, text: yamlText })
      if (request !== fileRequest.current) return
      if (!parsed.ok) {
        setState((prev) => ({
          ...prev, busy: false, selected: name, workflowId, draft: null,
          warnings: [], problems: [rpcErrorMessage(parsed)],
        }))
        return
      }
      const { normalized, warnings } = parsed.value
      const resolved = await call('layout', { config: normalized, layoutText })
      if (request !== fileRequest.current) return
      if (!resolved.ok) {
        setState((prev) => ({
          ...prev, busy: false, selected: name, workflowId, draft: null,
          warnings: warnings ?? [], problems: [rpcErrorMessage(resolved)],
        }))
        return
      }
      lastSyncedFile.current = null
      const draft = normalized
      const positions = { main: {}, children: {}, ...(resolved.value.layout ?? {}) }
      const personaInput = typeof draft.actorCommonPersona === 'string' ? draft.actorCommonPersona : ''
      setFlow(null)
      setState({
        ...initialState, dirName: state.dirName, files: state.files,
        selected: name, workflowId, draft, warnings: [...(warnings ?? []), ...((resolved.value.warnings ?? []))],
        problems: [], flow: null, positions, personaInput,
      })
    } catch (error) {
      if (request !== fileRequest.current) return
      setState((prev) => ({ ...prev, busy: false, problems: [`读取文件失败（权限/IO 错误如实上报，未伪装为文件缺失）：${String(error?.message ?? error)}`] }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, state, call])

  const refreshPreview = useCallback(async (draft) => {
    if (draft === null) return
    const request = ++previewRequest.current
    const previewed = await call('preview', { config: draft })
    if (request !== previewRequest.current) return
    if (!previewed.ok) {
      setState((prev) => ({ ...prev, problems: [rpcErrorMessage(previewed)] }))
      return
    }
    setState((prev) => ({ ...prev, preview: previewed.value }))
  }, [call])

  // 预览跟随草稿，包括撤销/重做；过期响应不能覆盖新文件或新编辑。
  useEffect(() => {
    void refreshPreview(state.draft)
    return () => { ++previewRequest.current }
  }, [state.draft, refreshPreview])

  /** T4 程序元数据单源直读（失败则禁用 Program 编辑，不用硬编码兜底）。 */
  const refreshProgramCatalog = useCallback(async () => {
    setProgramCatalogError(null)
    const meta = await call('metadata', {})
    if (!meta.ok) {
      setProgramCatalog(null)
      setProgramCatalogError(rpcErrorMessage(meta))
      return null
    }
    const programs = meta.value?.programs
    if (programs === null || typeof programs !== 'object' || Array.isArray(programs)) {
      setProgramCatalog(null)
      setProgramCatalogError('程序元数据形状异常（非对象），Program 编辑已禁用')
      return null
    }
    setProgramCatalog(programs)
    setProgramCatalogError(null)
    return programs
  }, [call])

  // 程序目录与文件无关：面板打开时独立加载，不阻塞配置与画布。
  useEffect(() => { void refreshProgramCatalog() }, [refreshProgramCatalog])
  useEffect(() => {
    if (programCatalog !== null) setAddProgram(emptyAddProgramForm(Object.keys(programCatalog)))
  }, [programCatalog])

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
    setProgramEdit({ sel: '', rename: '', programId: '', instruction: '' })
    setAddProgram(emptyAddProgramForm(Object.keys(programCatalog ?? {})))
    setNewSubflow('')
    setRenameSubflow('')
    setAddChild(emptyAddChildForm(Object.keys(state.draft.childWorkflows ?? {})))
    setAddChildTargets({})
    setChildEdit({ sel: '', rename: '', callee: '' })
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
  }, [])

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
  }, [state])

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
    ++fileRequest.current
    ++previewRequest.current
    lastSyncedFile.current = null
    setFlow(null)
    setNodeSel(null)
    setWire(null)
    setState({
      ...initialState, dirName: state.dirName, files,
      selected: name, workflowId, draft, warnings: [], problems: [],
      flow: null, positions, personaInput: '',
      dirtyBusiness: true, dirtyLayout: true,
    })
    setNewSubflow('')
    setRenameSubflow('')
    setAddChild(emptyAddChildForm([]))
    setAddChildTargets({})
    setChildEdit({ sel: '', rename: '', callee: '' })
  }, [newFileName, state])

  const syncNodeEdit = useCallback((draft, flowDef, id) => {
    setNodeSel(id)
    setTab('nodes')
    setNodeEdit(nodeEditFormOf(flowDef, id))
    setProgramEdit(programEditFormOf(flowDef, id, Object.keys(programCatalog ?? {})))
    setChildEdit(childEditFormOf(flowDef, id))
    setAddResult(emptyAddResultForm(flowDef))
    setWire(null)
  }, [programCatalog])

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

  /* T4 Program 节点/参数/PASS-FAIL 表单回调（同一草稿 + 同一撤销/预览通道）。 */
  const addProgramNode = useCallback(async (flowId) => {
    const id = addProgram.id.trim()
    await runEdit(addProgramNodeEdit(state, flowId, id, {
      programId: addProgram.programId,
      instruction: addProgram.instruction.trim() === '' ? undefined : addProgram.instruction,
      passCriteria: addProgram.passCriteria,
      passTarget: targetOf(addProgram.passTargetKind, addProgram.passTargetValue),
      failCriteria: addProgram.failCriteria,
      failTarget: targetOf(addProgram.failTargetKind, addProgram.failTargetValue),
    }, programCatalog), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, id)
      setAddProgram((prev) => emptyAddProgramForm(Object.keys(programCatalog ?? {})))
    })
  }, [state, addProgram, programCatalog, runEdit, syncNodeEdit])

  const applyProgramFields = useCallback(async (flowId) => {
    const sel = programEdit.sel
    await runEdit(setProgramFieldsEdit(state, flowId, sel, {
      programId: programEdit.programId,
      instruction: programEdit.instruction,
    }, programCatalog), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, sel)
    })
  }, [state, programEdit, programCatalog, runEdit, syncNodeEdit])

  const clearProgramInstruction = useCallback(async (flowId) => {
    const sel = programEdit.sel
    await runEdit(setProgramFieldsEdit(state, flowId, sel, { instruction: null }, programCatalog), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, sel)
    })
  }, [state, programEdit.sel, programCatalog, runEdit, syncNodeEdit])

  const applyProgramParam = useCallback(async (flowId, nodeId, key, text, specType) => {
    // number 参数的文本输入转数值（空串/非数值由 edits 类型守卫明确拒绝，不静默成 0）。
    const value = specType === 'number' && text.trim() !== '' ? Number(text) : text
    await runEdit(setProgramParamEdit(state, flowId, nodeId, key, value, programCatalog), undefined)
  }, [state, programCatalog, runEdit])

  const deleteProgramParam = useCallback(async (flowId, nodeId, key) => {
    await runEdit(setProgramParamEdit(state, flowId, nodeId, key, undefined, programCatalog), undefined)
  }, [state, programCatalog, runEdit])

  const applyProgramResult = useCallback(async (flowId, nodeId, name, patch) => {
    await runEdit(setProgramResultEdit(state, flowId, nodeId, name, patch), undefined)
  }, [state, runEdit])

  /** Program 改名（改名框在 Program 卡上，读 programEdit；引用同步复用通用改名）。 */
  const renameProgramNode = useCallback(async (flowId) => {
    const next = programEdit.rename.trim()
    await runEdit(renameNodeEdit(state, flowId, programEdit.sel, next), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, next)
    })
  }, [state, programEdit, runEdit, syncNodeEdit])

  /** Child 改名（改名框在 Child 卡上，读 childEdit；引用同步复用通用改名）。 */
  const renameChildNode = useCallback(async (flowId) => {
    const next = childEdit.rename.trim()
    await runEdit(renameNodeEdit(state, flowId, childEdit.sel, next), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, next)
    })
  }, [state, childEdit, runEdit, syncNodeEdit])

  /** 结果连线提交（Child 端口走 onReturn 映射 patch，Program 走 PASS/FAIL，Actor 走命名结果）。 */
  const commitWire = useCallback(async (flowId, target) => {
    if (wire === null) return
    const flowDef = flowId === null ? state.draft?.workflow : state.draft?.childWorkflows?.[flowId]
    const wired = flowDef?.nodes?.[wire.node]
    const edit = wired?.execution?.type === 'builtin-program'
      ? setProgramResultEdit(state, flowId, wire.node, wire.result, { target })
      : wired?.execution?.type === 'child-workflow'
        ? setChildReturnTargetEdit(state, flowId, wire.node, wire.result, target)
        : setNodeResultEdit(state, flowId, wire.node, wire.result, { target })
    await runEdit(edit, () => {
      setWire(null)
    })
  }, [state, wire, runEdit])

  /* T5 子流程与 Child 表单回调（同一草稿 + 同一撤销/预览通道）。 */
  const addNewSubflow = useCallback(async () => {
    const id = newSubflow.trim()
    await runEdit(addSubflowEdit(state, id), (result) => {
      setNewSubflow('')
      setRenameSubflow(id)
      setFlow(id)
      setNodeSel(null)
      setWire(null)
      setAddChild(emptyAddChildForm([...Object.keys(result.state.draft.childWorkflows ?? {})]))
      setAddChildTargets({})
    })
  }, [state, newSubflow, runEdit])

  const renameActiveSubflow = useCallback(async (flowId) => {
    const next = renameSubflow.trim()
    await runEdit(renameSubflowEdit(state, flowId, next), (result) => {
      setRenameSubflow(next)
      setFlow(next)
      setAddChild(emptyAddChildForm([...Object.keys(result.state.draft.childWorkflows ?? {})]))
      setAddChildTargets({})
    })
  }, [state, renameSubflow, runEdit])

  const deleteActiveSubflow = useCallback(async (flowId) => {
    if (flowId === null || state.draft === null) return
    const callers = findSubflowCallersEdit(state.draft, flowId)
    const hint = callers.length > 0
      ? `子流程 "${flowId}" 仍有 ${callers.length} 处 Child 调用（${callers.map((c) => `${c.flowId ?? '主流程'}:${c.node}`).join('、')}），删除后保存将被阻止。继续删除吗？`
      : `删除子流程 "${flowId}" 吗？`
    if (!window.confirm(hint)) return
    await runEdit(deleteSubflowEdit(state, flowId), (result) => {
      setFlow(null)
      setNodeSel(null)
      setWire(null)
      setAddChild(emptyAddChildForm([...Object.keys(result.state.draft.childWorkflows ?? {})]))
      setAddChildTargets({})
    })
  }, [state, runEdit])

  const addChildNode = useCallback(async (flowId) => {
    const id = addChild.id.trim()
    const calleeDef = (state.draft?.childWorkflows ?? {})[addChild.callee]
    if (calleeDef === undefined) {
      setState((prev) => ({ ...prev, problems: [`子流程 "${addChild.callee}" 不存在：先新建子流程，再创建调用方`] }))
      return
    }
    const targets = {}
    for (const ret of calleeDef.returns ?? []) {
      const form = addChildTargets[ret] ?? emptyChildTargetForm()
      targets[ret] = targetOf(form.kind, form.value)
    }
    await runEdit(addChildNodeEdit(state, flowId, id, { workflowId: addChild.callee, targets }), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, id)
      setAddChild((prev) => ({ id: '', callee: prev.callee }))
      setAddChildTargets({})
    })
  }, [state, addChild, addChildTargets, runEdit, syncNodeEdit])

  const applyChildCallee = useCallback(async (flowId) => {
    const sel = childEdit.sel
    await runEdit(setChildWorkflowIdEdit(state, flowId, sel, childEdit.callee), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, sel)
    })
  }, [state, childEdit, runEdit, syncNodeEdit])

  const applyChildReturn = useCallback(async (flowId, nodeId, ret, target) => {
    await runEdit(setChildReturnTargetEdit(state, flowId, nodeId, ret, target), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, nodeId)
    })
  }, [state, runEdit, syncNodeEdit])

  const deleteChildReturn = useCallback(async (flowId, nodeId, ret) => {
    await runEdit(setChildReturnTargetEdit(state, flowId, nodeId, ret, undefined), (result) => {
      const flowDef = flowId === null ? result.state.draft.workflow : result.state.draft.childWorkflows[flowId]
      syncNodeEdit(result.state.draft, flowDef, nodeId)
    })
  }, [state, runEdit, syncNodeEdit])


  const moveNode = useCallback((flowId, nodeId, pos) => {    setState((prev) => {
      const edited = moveNodeEdit(prev, flowId, nodeId, pos)
      if (!edited.ok || edited.noop === true) return prev
      return edited.state
    })
  }, [])

  const restoreHistory = (edit) => {
    const next = edit(state)
    if (next === null) return
    ++previewRequest.current
    setState(next)
    setRoleForm(roleFormOf(next.draft, next.draft.roles?.[roleForm.sel] ? roleForm.sel : Object.keys(next.draft.roles ?? {})[0] ?? ''))
    setJudgeForm(judgeFormOf(next.draft))
    const def = flow === null ? next.draft.workflow : next.draft.childWorkflows?.[flow]
    if (def?.nodes?.[nodeSel]) syncNodeEdit(next.draft, def, nodeSel)
    else { setNodeSel(null); setWire(null) }
    if (def === undefined) setFlow(null)
    setFormRevision((value) => value + 1)
  }
  const doUndo = () => restoreHistory(undoEdit)
  const doRedo = () => restoreHistory(redoEdit)

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
        const resolved = await call('layout', { config: normalized, layoutText: JSON.stringify({ ...state.positions, version: 1 }) })
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
    } catch (error) {
      if (writeYaml && result.yaml === null) result.yaml = { ok: false, message: `YAML 写入失败：${String(error?.message ?? error)}（未保存状态已保留，可重试）` }
      else if (writeLayout && result.layout === null) result.layout = { ok: false, message: `布局写入失败：${String(error?.message ?? error)}（未保存状态已保留，可重试）` }
      else result.yaml = result.yaml ?? { ok: false, message: `保存失败：${String(error?.message ?? error)}` }
      setState((prev) => ({ ...prev, busy: false, saveResult: result }))
    }
  }, [dir, state.draft, state.selected, state.workflowId, state.dirtyBusiness, state.dirtyLayout, state.positions, call])

  const draft = state.draft
  const flows = draft === null
    ? []
    : [{ id: null, label: '主流程', def: draft.workflow }, ...Object.entries(draft.childWorkflows ?? {}).map(([id, def]) => ({ id, label: `子流程 ${id}`, def }))]
  const activeFlow = flows.find((f) => f.id === flow) ?? flows[0] ?? null
  const activePositions = activeFlow === null
    ? {}
    : (activeFlow.id === null ? state.positions.main : (state.positions.children[activeFlow.id] ?? {}))

  return h('div', { className: 'wf-editor' },
    h('style', null, EDITOR_STYLES),
    h('div', { className: 'wf-header' },
      h('div', null, h('h2', null, '工作流配置'), h('p', null, '在画布上连接节点，在右侧编辑执行属性。')),
      h('span', { className: 'wf-badge' }, state.selected ?? '配置编辑器'),
    ),
    capError !== null ? h('div', { className: 'wf-error', role: 'alert' }, capError) : null,
    h('div', { className: 'wf-toolbar' },
      h('button', { onClick: openDirectory, disabled: state.busy }, '打开目录'),
      restoreCandidate !== null && dir === null ? h('button', { onClick: restoreDirectory, disabled: state.busy },
        `恢复上次目录（${restoreCandidate.name ?? '未知'}）`) : null,
      state.dirName !== '' ? h('span', null, `目录：${state.dirName}`) : null,
      draft !== null ? h('span', null, dirty ? '● 未保存' : '○ 已保存') : null,
      h('button', { onClick: doUndo, disabled: state.past.length === 0 || state.busy }, '撤销'),
      h('button', { onClick: doRedo, disabled: state.future.length === 0 || state.busy }, '重做'),
      h('button', { className: 'wf-primary', onClick: save, disabled: draft === null || !dirty || state.busy }, '保存'),
    ),
    state.busy ? h('div', { className: 'wf-loading', role: 'status' }, '正在处理配置，请稍候…') : null,
    draft === null && !state.busy ? h('div', { className: 'wf-empty' }, h('h3', null, '创建你的工作流'), h('p', null, '打开配置目录，选择一个 YAML 文件，或新建配置开始编辑。')) : null,
    state.files.length > 0 ? h('div', { className: 'wf-files' },
      h('span', null, '文件：'),
      ...state.files.map((name) => h('button', {
        key: name,
        onClick: () => selectFile(name),
        disabled: state.busy || (state.selected === name && draft !== null),
      }, name)),
    ) : null,
    /* 新建配置不依赖已加载草稿：目录打开即可用（此前藏在 draft 门槛后，
       RPC 故障导致 draft 恒空时新建入口完全不可见）。 */
    dir !== null ? h('details', { className: 'wf-newfile' },
      h('summary', null, '新建配置文件'),
      h('label', null, '文件名（小写 .yaml）'),
      h('input', { value: newFileName, onChange: (event) => setNewFileName(event.target.value), placeholder: 'review.yaml' }),
      h('button', { onClick: createNewFile, disabled: state.busy }, '新建配置'),
    ) : null,
    state.problems.length > 0 ? h('div', { className: 'wf-error', role: 'alert' },
      ...state.problems.map((message, index) => h('div', { key: index }, message)),
    ) : null,
    state.warnings.length > 0 ? h('div', { className: 'wf-warn' },
      ...state.warnings.map((message, index) => h('div', { key: index }, message)),
    ) : null,
    draft !== null ? h('div', { className: `wf-main${inspectorCollapsed ? ' wf-inspector-collapsed' : ''}` },
      flows.length > 0 ? h('div', { className: 'wf-flows' },
        ...flows.map((f) => h('button', {
          key: f.id ?? '__main__',
          onClick: () => { setFlow(f.id); setNodeSel(null); setWire(null); setRenameSubflow(f.id ?? '') },
          disabled: activeFlow !== null && f.id === activeFlow.id,
        }, f.label)),
      ) : null,
      activeFlow !== null ? h(NodeCanvas, {
        key: `${state.selected}:${activeFlow.id ?? '__main__'}`,
        busy: state.busy,
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
      h('aside', { className: 'wf-inspector', 'aria-label': '配置属性' },
        h('button', {
          className: 'wf-inspector-toggle', 'aria-expanded': !inspectorCollapsed,
          onClick: () => setInspectorCollapsed((value) => !value),
          title: inspectorCollapsed ? '展开属性面板' : '收起属性面板',
        }, inspectorCollapsed ? '展开属性' : '收起属性'),
        h('div', { className: 'wf-tabs', hidden: inspectorCollapsed, role: 'tablist', 'aria-label': '属性分类' },
          ...[['nodes', '节点'], ['roles', '角色'], ['flow', '流程'], ['yaml', 'YAML']].map(([id, label]) => h('button', {
            key: id, role: 'tab', 'aria-selected': tab === id, onClick: () => setTab(id),
          }, label)),
        ),
        h('fieldset', { className: 'wf-inspector-content', hidden: inspectorCollapsed, disabled: state.busy, key: formRevision, style: { border: 0, margin: 0 } },
          h('div', { hidden: tab !== 'nodes' },
      activeFlow !== null ? h(NodeSection, {
        draft, flowId: activeFlow.id, def: activeFlow.def,
        nodeSel, nodeEdit, setNodeEdit, addNode, setAddNode, addResult, setAddResult,
        onSelect: syncNodeEdit, onAdd: addActor, onFields: applyNodeFields,
        onRename: renameSelectedNode, onDelete: deleteSelectedNode,
        onAddResult: addResultRow, onApplyResult: applyResult,
        onRenameResult: renameResult, onDeleteResult: deleteResult,
        programCatalog, programCatalogError, onRetryCatalog: refreshProgramCatalog, addProgram, setAddProgram,
        programEdit, setProgramEdit, onAddProgram: addProgramNode,
        onProgramFields: applyProgramFields, onClearProgramInstruction: clearProgramInstruction,
        onProgramParam: applyProgramParam, onDeleteProgramParam: deleteProgramParam,
        onApplyProgramResult: applyProgramResult, onRenameProgram: renameProgramNode,
        subflowIds: Object.keys(draft.childWorkflows ?? {}),
        addChild, setAddChild, addChildTargets, setAddChildTargets,
        childEdit, setChildEdit,
        onAddChild: addChildNode, onChildCallee: applyChildCallee,
        onChildReturn: applyChildReturn, onDeleteChildReturn: deleteChildReturn,
        onRenameChild: renameChildNode,
        busy: state.busy,
      }) : null,
          ),
          h('div', { hidden: tab !== 'roles' },
      h('div', { className: 'wf-persona' },
        h('label', null, '公共 actorCommonPersona（省略=未设置）'),
        h(LongTextField, { title: '公共 actorCommonPersona',
          value: state.personaInput,
          onChange: (event) => setState((prev) => ({ ...prev, personaInput: event.target.value })),
        }),
        h('button', { onClick: () => applyPersona(false), disabled: state.busy }, '应用'),
        h('button', { onClick: () => applyPersona(true), disabled: state.busy }, '清除'),
      ),
      h(RoleSection, {
        draft, roleForm, setRoleForm, newRole, setNewRole, loadModels: props.loadModels,
        onAdd: addNewRole, onSelect: selectRole, onRename: renameSelectedRole,
        onPersona: applyRolePersona, onReuse: applyRoleReuse, onModel: applyRoleModel,
        onClearModel: clearRoleModel, onDeny: applyRoleDeny, onClearDeny: clearRoleDeny,
        onDelete: deleteSelectedRole, busy: state.busy,
      }),
      h(JudgeSection, {
        draft, judgeForm, setJudgeForm, loadModels: props.loadModels,
        onPersona: applyJudgePersona, onModel: applyJudgeModel, onClearModel: clearJudgeModel,
        onDeny: applyJudgeDeny, onClearDeny: clearJudgeDeny, busy: state.busy,
      }),
          ),
          h('div', { hidden: tab !== 'flow' },
      draft !== null ? h(SubflowSection, {
        subflowIds: Object.keys(draft.childWorkflows ?? {}),
        activeFlowId: activeFlow === null ? null : activeFlow.id,
        newSubflow, setNewSubflow, renameSubflow, setRenameSubflow,
        onAdd: addNewSubflow, onRename: renameActiveSubflow, onDelete: deleteActiveSubflow,
        busy: state.busy,
      }) : null,
      activeFlow !== null ? h(FlowSection, {
        flowId: activeFlow.id, def: activeFlow.def, newReturn, setNewReturn,
        onStart: applyStartNode, onAddReturn: addReturn, onRenameReturn: renameReturn,
        onDeleteReturn: deleteReturn, busy: state.busy,
      }) : null,
          ),
          h('div', { hidden: tab !== 'yaml' },
      h('div', { className: 'wf-preview' },
        h('h3', null, state.preview !== null && state.preview.problems.length > 0 ? '只读 YAML 预览（草稿：未通过校验）' : '只读 YAML 预览'),
        h('pre', null, state.preview !== null ? state.preview.yaml : '（加载中…）'),
      ),
          ),
        ),
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
    h('h3', null, '执行角色'),
    h('div', { className: 'wf-role-new' },
      h('label', null, '新增角色 id'),
      h('input', { value: newRole.id, onChange: (event) => setNewRole((prev) => ({ ...prev, id: event.target.value })) }),
      h('label', null, 'persona'),
      h(LongTextField, { title: '新角色 persona', value: newRole.persona, onChange: (event) => setNewRole((prev) => ({ ...prev, persona: event.target.value })) }),
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
        h(LongTextField, { title: '角色 persona', value: roleForm.persona, onChange: setField('persona') }),
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
      h(ModelFields, { form: roleForm, setForm: setRoleForm, loadModels: props.loadModels, busy: props.busy, onApply: props.onModel, onClear: props.onClearModel }),
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
    h('h3', null, 'Judge · 验收角色'),
    h('div', null,
      h('label', null, 'persona'),
      h(LongTextField, { title: 'Judge persona', value: judgeForm.persona, onChange: setField('persona') }),
      h('button', { onClick: props.onPersona, disabled: props.busy }, '应用'),
    ),
    h(ModelFields, { form: judgeForm, setForm: setJudgeForm, loadModels: props.loadModels, busy: props.busy, onApply: props.onModel, onClear: props.onClearModel }),
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
 * T5 子流程区：子流程定义增删改名（各流程单独维护入口/返回/节点与坐标，
 * 画布切换走流程页签；删除有调用时确认，未修正引用保存将被阻止）。
 */
function SubflowSection(props) {
  const { subflowIds, activeFlowId, newSubflow, setNewSubflow, renameSubflow, setRenameSubflow } = props
  return h('div', { className: 'wf-subflows' },
    h('h3', null, '子流程'),
    subflowIds.length > 0
      ? h('div', null, `已声明：${subflowIds.join(', ')}`)
      : h('div', null, '（暂无子流程）'),
    h('div', null,
      h('label', null, '新增子流程 id'),
      h('input', { value: newSubflow, onChange: (event) => setNewSubflow(event.target.value), placeholder: 'review' }),
      h('button', { onClick: props.onAdd, disabled: props.busy }, '新增子流程'),
    ),
    activeFlowId === null
      ? h('div', null, '（当前为主流程画布；切到子流程画布后可改名/删除）')
      : h('div', null,
        h('label', null, `子流程 ${activeFlowId} 改名`),
        h('input', { value: renameSubflow, onChange: (event) => setRenameSubflow(event.target.value) }),
        h('button', { onClick: () => props.onRename(activeFlowId), disabled: props.busy }, '改名'),
        h('button', { onClick: () => props.onDelete(activeFlowId), disabled: props.busy }, '删除子流程'),
      ),
  )
}

/**
 * T3 Actor 节点区：节点不是角色——画布执行节点在此增删改名并编辑属性，
 * 命名结果的 criteria/target 在结果行内编辑。未知类型节点只读展示，
 * 不提供编辑入口（字段保持不丢失）。
 */
function NodeSection(props) {
  const { draft, flowId, def, nodeSel, nodeEdit, setNodeEdit, addNode, setAddNode, addResult, setAddResult } = props
  const { programCatalog, programCatalogError, addProgram, setAddProgram, programEdit } = props
  const { subflowIds, addChild, setAddChild, addChildTargets, setAddChildTargets } = props
  const { childEdit, setChildEdit } = props
  const setEdit = (field) => (event) => setNodeEdit((prev) => ({ ...prev, [field]: event.target.value }))
  const setAddProg = (field) => (event) => setAddProgram((prev) => ({ ...prev, [field]: event.target.value }))
  const setAddCh = (field) => (event) => setAddChild((prev) => ({ ...prev, [field]: event.target.value }))
  const roleOptions = ['manager', ...Object.keys(draft.roles ?? {}).filter((r) => r !== 'manager')]
  const programIds = Object.keys(programCatalog ?? {})
  const nodeIds = Object.keys(def.nodes ?? {})
  const selected = (def.nodes ?? {})[nodeSel]
  const isActor = selected?.execution?.type === 'actor-task'
  const isProgram = selected?.execution?.type === 'builtin-program'
  const isChild = selected?.execution?.type === 'child-workflow'
  const results = isActor ? Object.entries(selected.results ?? {}) : []
  const addChildCalleeDef = (draft.childWorkflows ?? {})[addChild.callee]
  const addChildReturns = addChildCalleeDef?.returns ?? []
  return h('div', { className: 'wf-nodes' },
    h('h3', null, nodeSel === null ? '节点属性' : `节点 · ${nodeSel}`),
    programCatalogError !== null ? h('div', { className: 'wf-warn' }, programCatalogError,
      h('button', { onClick: props.onRetryCatalog }, '重试程序目录')) : null,
    nodeSel === null ? h('p', { className: 'wf-hint' }, '点击画布节点编辑属性，或在下方新增节点。') : null,
    nodeIds.length > 0 ? h('div', { className: 'wf-node-list' },
      h('span', null, '节点：'),
      ...nodeIds.map((id) => h('button', {
        key: id,
        onClick: () => props.onSelect(draft, def, id),
        disabled: props.busy || id === nodeSel,
      }, `${id}${id === def.startNode ? ' ★' : ''}`)),
    ) : h('div', null, '（暂无节点）'),
    selected === undefined ? null : h('div', { className: 'wf-node-card' },
      !isActor && !isProgram && !isChild ? h('div', null, '（未知节点类型，只读；其字段保持不丢失）') : isProgram ? h(ProgramCard, {
        key: `${flowId ?? '__main__'}:${nodeSel}:${selected.execution?.programId ?? ''}:${programCatalog === null ? 'loading' : 'ready'}`,
        flowId, nodeId: nodeSel, node: selected,
        catalog: programCatalog, catalogError: programCatalogError,
        programEdit, setProgramEdit: props.setProgramEdit,
        returns: def.returns ?? [], nodeIds,
        onRenameProgram: props.onRenameProgram, onDelete: props.onDelete,
        onFields: props.onProgramFields, onClearInstruction: props.onClearProgramInstruction,
        onParam: props.onProgramParam, onDeleteParam: props.onDeleteProgramParam,
        onApplyResult: props.onApplyProgramResult, busy: props.busy,
      }) : isChild ? h(ChildCard, {
        key: `${flowId ?? '__main__'}:${nodeSel}:${selected.execution?.workflowId ?? ''}`,
        draft, flowId, nodeId: nodeSel, node: selected,
        subflowIds, childEdit, setChildEdit,
        onCallee: props.onChildCallee, onReturn: props.onChildReturn,
        onDeleteReturn: props.onDeleteChildReturn,
        onRenameChild: props.onRenameChild, onDelete: props.onDelete,
        busy: props.busy,
      }) : h('div', null,
        h('div', null,
          h('label', null, '改名'),
          h('input', { value: nodeEdit.rename, onChange: setEdit('rename') }),
          h('button', { onClick: () => props.onRename(flowId), disabled: props.busy }, '改名'),
        ),
        h('div', null,
          h('label', null, '角色'),
          h('select', { value: nodeEdit.role, onChange: setEdit('role'), disabled: props.busy || (flowId === null && nodeSel === def.startNode), title: flowId === null && nodeSel === def.startNode ? '主流程初始节点固定由 manager 执行' : undefined },
            ...roleOptions.map((r) => h('option', { key: r, value: r }, r))),
          h('label', null, '指令'),
          h(LongTextField, { title: '节点指令', value: nodeEdit.instruction, onChange: setEdit('instruction') }),
        ),
        h('div', null,
          h('label', null, '检查器'),
          h('select', { value: nodeEdit.checkerId, onChange: setEdit('checkerId'), disabled: props.busy },
            ...SUPPORTED_CHECKER_IDS.map((c) => h('option', { key: c, value: c }, c))),
          h('label', null, '共同验收条件（可选，所有结果共用）'),
          h(LongTextField, { title: '共同验收条件', value: nodeEdit.common, onChange: setEdit('common') }),
          h('button', { onClick: () => props.onFields(flowId), disabled: props.busy }, '应用属性'),
        ),
        h('div', { className: 'wf-results' },
          h('span', null, '结果与流向'),
          ...results.map(([name, result]) => h(ResultRow, {
            key: `${flowId ?? '__main__'}:${nodeSel}:${name}:${JSON.stringify(result)}`,
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
          h(LongTextField, { title: '新结果 criteria', value: addResult.criteria, onChange: (event) => setAddResult((prev) => ({ ...prev, criteria: event.target.value })) }),
          h('label', null, '目标'),
          h('select', { value: addResult.targetKind, onChange: (event) => setAddResult((prev) => ({ ...prev, targetKind: event.target.value })) },
            h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
          h('input', { value: addResult.targetValue, onChange: (event) => setAddResult((prev) => ({ ...prev, targetValue: event.target.value })) }),
          h('button', { onClick: () => props.onAddResult(flowId), disabled: props.busy }, '新增结果'),
        ),
        h('button', { onClick: () => props.onDelete(flowId), disabled: props.busy }, '删除节点'),
      ),
    ),
    h('details', { className: 'wf-node-new' },
      h('summary', null, '＋ Actor 节点'),
      h('label', null, '新增节点 id'),
      h('input', { value: addNode.id, onChange: (event) => setAddNode((prev) => ({ ...prev, id: event.target.value })) }),
      h('label', null, '角色（已有角色可选）'),
      h('select', { value: addNode.role, onChange: (event) => setAddNode((prev) => ({ ...prev, role: event.target.value })) },
        ...roleOptions.map((r) => h('option', { key: r, value: r }, r))),
      h('label', null, '指令'),
      h(LongTextField, { title: '新节点指令', value: addNode.instruction, onChange: (event) => setAddNode((prev) => ({ ...prev, instruction: event.target.value })) }),
      h('label', null, '检查器'),
      h('select', { value: addNode.checkerId, onChange: (event) => setAddNode((prev) => ({ ...prev, checkerId: event.target.value })) },
        ...SUPPORTED_CHECKER_IDS.map((c) => h('option', { key: c, value: c }, c))),
      h('label', null, '共同 criteria（留空=无）'),
      h(LongTextField, { title: '共同验收条件', value: addNode.common, onChange: (event) => setAddNode((prev) => ({ ...prev, common: event.target.value })) }),
      h('label', null, '初始结果名'),
      h('input', { value: addNode.resultName, onChange: (event) => setAddNode((prev) => ({ ...prev, resultName: event.target.value })) }),
      h('label', null, '初始结果 criteria'),
      h(LongTextField, { title: '初始结果 criteria', value: addNode.resultCriteria, onChange: (event) => setAddNode((prev) => ({ ...prev, resultCriteria: event.target.value })) }),
      h('label', null, '初始目标'),
      h('select', { value: addNode.targetKind, onChange: (event) => setAddNode((prev) => ({ ...prev, targetKind: event.target.value })) },
        h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
      h('input', { value: addNode.targetValue, onChange: (event) => setAddNode((prev) => ({ ...prev, targetValue: event.target.value })) }),
      h('button', { onClick: () => props.onAdd(flowId), disabled: props.busy }, '新增节点'),
    ),
    h('details', { className: 'wf-program-new' },
      h('summary', null, '＋ Program 节点'),
      h('h4', null, '新增 Program 节点（PASS/FAIL 成对声明；参数建后逐项填写，必填缺席不阻止保存）'),
      programCatalog === null
        ? h('div', null, programCatalogError ?? '程序元数据加载中…')
        : h('div', null,
          h('label', null, '新增节点 id'),
          h('input', { value: addProgram.id, onChange: setAddProg('id') }),
          h('label', null, '程序（固定名单，不可配任意脚本）'),
          h('select', { value: addProgram.programId, onChange: setAddProg('programId') },
            ...programIds.map((p) => h('option', { key: p, value: p }, p))),
          h('label', null, 'instruction（可选，留空=无）'),
          h(LongTextField, { title: 'Program 指令', value: addProgram.instruction, onChange: setAddProg('instruction') }),
          h('label', null, 'PASS criteria'),
          h(LongTextField, { title: 'PASS criteria', value: addProgram.passCriteria, onChange: setAddProg('passCriteria') }),
          h('label', null, 'PASS 目标'),
          h('select', { value: addProgram.passTargetKind, onChange: setAddProg('passTargetKind') },
            h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
          h('input', { value: addProgram.passTargetValue, onChange: setAddProg('passTargetValue') }),
          h('label', null, 'FAIL criteria'),
          h(LongTextField, { title: 'FAIL criteria', value: addProgram.failCriteria, onChange: setAddProg('failCriteria') }),
          h('label', null, 'FAIL 目标'),
          h('select', { value: addProgram.failTargetKind, onChange: setAddProg('failTargetKind') },
            h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
          h('input', { value: addProgram.failTargetValue, onChange: setAddProg('failTargetValue') }),
          h('button', { onClick: () => props.onAddProgram(flowId), disabled: props.busy }, '新增 Program 节点'),
        ),
    ),
    h('details', { className: 'wf-child-new' },
      h('summary', null, '＋ Child 节点'),
      h('h4', null, '新增 Child 节点（只引用本文件子流程；返回映射一次配齐，不静默猜测）'),
      subflowIds.length === 0
        ? h('div', null, '（暂无子流程，请先在子流程区新增子流程）')
        : h('div', null,
          h('label', null, '新增节点 id'),
          h('input', { value: addChild.id, onChange: setAddCh('id') }),
          h('label', null, '被调用子流程'),
          h('select', {
            value: addChild.callee,
            onChange: (event) => {
              setAddChild((prev) => ({ ...prev, callee: event.target.value }))
              setAddChildTargets({})
            },
          }, ...subflowIds.map((id) => h('option', { key: id, value: id }, id))),
          ...addChildReturns.map((ret) => {
            const form = addChildTargets[ret] ?? emptyChildTargetForm()
            const setTarget = (field) => (event) => setAddChildTargets((prev) => ({
              ...prev, [ret]: { ...(prev[ret] ?? emptyChildTargetForm()), [field]: event.target.value },
            }))
            return h('div', { key: ret },
              h('code', null, `返回 ${ret} →`),
              h('select', { value: form.kind, onChange: setTarget('kind') },
                h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
              h('input', { value: form.value, onChange: setTarget('value'), placeholder: '目标节点/返回（必填）' }),
            )
          }),
          h('button', { onClick: () => props.onAddChild(flowId), disabled: props.busy }, '新增 Child 节点'),
        ),
    ),
  )
}

/** Program 节点卡：改名/程序与 instruction/参数/PASS-FAIL（结果行固定，不可改名删除）。 */
function ProgramCard(props) {
  const { flowId, nodeId, node, catalog, catalogError, programEdit, setProgramEdit } = props
  const execution = node.execution ?? {}
  const spec = catalog?.[execution.programId]
  const params = spec?.parameters ?? {}
  const config = execution.config ?? {}
  const knownKeys = Object.keys(params)
  const extraKeys = Object.keys(config).filter((key) => !Object.prototype.hasOwnProperty.call(params, key))
  const [inputs, setInputs] = useState(() => Object.fromEntries(
    knownKeys.map((key) => [key, config[key] === undefined ? '' : String(config[key])]),
  ))
  const setEdit = (field) => (event) => setProgramEdit((prev) => ({ ...prev, [field]: event.target.value }))
  const setInput = (key) => (event) => setInputs((prev) => ({ ...prev, [key]: event.target.value }))
  return h('div', null,
    h('div', null,
      h('label', null, '改名'),
      h('input', { value: programEdit.rename, onChange: setEdit('rename') }),
      h('button', { onClick: () => props.onRenameProgram(flowId), disabled: props.busy }, '改名'),
    ),
    catalog === null
      ? h('div', null, catalogError ?? '程序元数据加载中…')
      : h('div', null,
        h('label', null, '程序（固定名单，不可配任意脚本）'),
        h('select', { value: programEdit.programId, onChange: setEdit('programId'), disabled: props.busy },
          ...Object.keys(catalog).map((p) => h('option', { key: p, value: p }, p))),
        h('div', null, spec?.description ?? '（未知程序：元数据无描述，字段保持不删除）'),
      ),
    h('div', null,
      h('label', null, 'instruction（可选；应用空值被拒绝，清除请用清除按钮）'),
      h(LongTextField, { title: 'Program 指令', value: programEdit.instruction, onChange: setEdit('instruction') }),
      h('button', { onClick: () => props.onFields(flowId), disabled: props.busy || catalog === null }, '应用属性'),
      h('button', { onClick: () => props.onClearInstruction(flowId), disabled: props.busy || catalog === null }, '清除 instruction'),
    ),
    spec === undefined ? null : h('div', { className: 'wf-program-params' },
      h('span', null, '参数（类型按元数据表达；必填 * 缺席不阻止保存，运行时可补参）：'),
      ...knownKeys.map((key) => h('div', { key },
        h('code', { title: params[key].description }, `${key}${params[key].required ? ' *' : ''}（${params[key].type}）`),
        h('span', null, params[key].description),
        h('input', {
          value: inputs[key] ?? '',
          onChange: setInput(key),
          disabled: props.busy,
          title: `当前值：${JSON.stringify(config[key] ?? null)}`,
        }),
        h('button', { onClick: () => props.onParam(flowId, nodeId, key, inputs[key] ?? '', params[key].type), disabled: props.busy }, '应用'),
        h('button', { onClick: () => props.onDeleteParam(flowId, nodeId, key), disabled: props.busy }, '删除'),
      )),
    ),
    extraKeys.length === 0 ? null : h('div', null,
      h('span', null, '导入保留字段（只读，编辑器不删除）：'),
      ...extraKeys.map((key) => h('div', { key }, h('code', null, `${key} = ${JSON.stringify(config[key])}`))),
    ),
    h('div', { className: 'wf-results' },
      h('span', null, 'PASS/FAIL（协议固定结果，点选连线改目标；不可改名/删除）：'),
      ...['PASS', 'FAIL'].map((name) => {
        const result = (node.results ?? {})[name]
        return result === undefined
          ? h('div', { key: name }, `结果 "${name}" 缺失：PASS/FAIL 须成对声明，未修正时保存将被阻止`)
          : h(ResultRow, {
            key: `${flowId ?? '__main__'}:${nodeId}:${name}:${JSON.stringify(result)}`,
            flowId, nodeId, name, result, fixed: true,
            returns: props.returns ?? [], nodeIds: props.nodeIds ?? [],
            onApply: (fid, n, patch) => props.onApplyResult(fid, nodeId, n, patch),
            busy: props.busy,
          })
      }),
    ),
    h('button', { onClick: () => props.onDelete(flowId), disabled: props.busy }, '删除节点'),
  )
}

/** 单个命名结果行：本地缓冲 criteria/目标/改名，应用时一次性 patch（fixed 隐藏改名删除）。 */
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
    h(LongTextField, { title: '结果 criteria', value: criteria, onChange: (event) => setCriteria(event.target.value), disabled: props.busy }),
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
    props.fixed === true ? null : h('div', { className: 'wf-result-rename' },
      h('input', { value: rename, onChange: (event) => setRename(event.target.value), disabled: props.busy }),
      h('button', { onClick: () => props.onRename(flowId, name, rename), disabled: props.busy }, '改名'),
      h('button', { onClick: () => props.onDelete(flowId, name), disabled: props.busy }, '删除'),
    ),
  )
}

/** 单个返回映射行：本地缓冲目标，应用时一次性 patch（extra 键只读 + 删除）。 */
function ChildReturnRow(props) {
  const { flowId, nodeId, ret, target, missing, extra } = props
  const initialKind = target?.node !== undefined ? 'node' : 'return'
  const initialValue = target?.node ?? target?.return ?? ''
  const [kind, setKind] = useState(initialKind)
  const [value, setValue] = useState(initialValue)
  const targetText = target === undefined
    ? '（无目标）'
    : target.node !== undefined ? `→ 节点 ${target.node}` : `→ 返回 ${target.return}`
  if (extra === true) {
    return h('div', { className: 'wf-result-row' },
      h('code', null, `${ret} · ${targetText}（多余映射键，与被调用流程 returns 不一致）`),
      h('button', { onClick: () => props.onDelete(flowId, nodeId, ret), disabled: props.busy }, '删除'),
    )
  }
  return h('div', { className: 'wf-result-row' },
    h('code', null, `${ret} · ${targetText}${missing === true ? '（未完成映射）' : ''}`),
    h('label', null, '目标'),
    h('select', { value: kind, onChange: (event) => setKind(event.target.value), disabled: props.busy },
      h('option', { value: 'node' }, '节点'), h('option', { value: 'return' }, '返回')),
    h('input', { value, onChange: (event) => setValue(event.target.value), disabled: props.busy }),
    h('button', {
      onClick: () => props.onApply(flowId, nodeId, ret, kind === 'node' ? { node: value.trim() } : { return: value.trim() }),
      disabled: props.busy,
    }, '应用'),
    target === undefined ? null
      : h('button', { onClick: () => props.onDelete(flowId, nodeId, ret), disabled: props.busy }, '删除'),
  )
}

/** Child 节点卡：改名/被调用方/onReturn 端口（按被调用流程 returns 显示）。 */
function ChildCard(props) {
  const { draft, flowId, nodeId, node, subflowIds, childEdit, setChildEdit } = props
  const status = childMappingStatus(draft, node)
  const contract = status.dangling ? [] : ((draft.childWorkflows ?? {})[status.calleeId]?.returns ?? [])
  const onReturn = node.onReturn ?? {}
  const calleeOptions = [...new Set([...subflowIds, childEdit.callee].filter((id) => id !== ''))]
  return h('div', { className: 'wf-child-card' },
    h('div', null,
      h('label', null, '改名'),
      h('input', { value: childEdit.rename, onChange: (event) => setChildEdit((prev) => ({ ...prev, rename: event.target.value })) }),
      h('button', { onClick: () => props.onRenameChild(flowId), disabled: props.busy }, '改名'),
    ),
    h('div', null,
      h('label', null, '被调用子流程（只引用本文件，不支持外部/ root）'),
      h('select', { value: childEdit.callee, onChange: (event) => setChildEdit((prev) => ({ ...prev, callee: event.target.value })), disabled: props.busy },
        ...calleeOptions.map((id) => h('option', { key: id, value: id }, id))),
      h('button', { onClick: () => props.onCallee(flowId), disabled: props.busy }, '应用调用方'),
    ),
    status.dangling
      ? h('div', { className: 'wf-error' }, `调用的子流程 "${status.calleeId}" 不存在：先修正调用目标，再编辑返回映射（保存将被阻止）`)
      : null,
    status.dangling ? null : h('div', { className: 'wf-returns' },
      h('span', null, '输出端口（被调用流程 returns；每端口一目标，点选连线改目标）：'),
      status.missing.length > 0
        ? h('div', { className: 'wf-warn' }, `未完成映射：缺少返回 ${status.missing.join('、')} 的目标（保存将被阻止，不静默猜测）`)
        : null,
      status.extra.length > 0
        ? h('div', { className: 'wf-warn' }, `多余映射键：${status.extra.join('、')}（与被调用流程 returns 不一致，请删除；保存将被阻止）`)
        : null,
      ...contract.map((ret) => h(ChildReturnRow, {
        key: `${flowId ?? '__main__'}:${nodeId}:${ret}:${JSON.stringify(node.onReturn?.[ret])}`,
        flowId, nodeId, ret,
        target: onReturn[ret],
        missing: status.missing.includes(ret),
        extra: false,
        onApply: (fid, nid, r, target) => props.onReturn(fid, nid, r, target),
        onDelete: props.onDeleteReturn,
        busy: props.busy,
      })),
      ...status.extra.map((ret) => h(ChildReturnRow, {
        key: `${flowId ?? '__main__'}:${nodeId}:${ret}:extra`,
        flowId, nodeId, ret,
        target: onReturn[ret],
        missing: false,
        extra: true,
        onApply: (fid, nid, r, target) => props.onReturn(fid, nid, r, target),
        onDelete: props.onDeleteReturn,
        busy: props.busy,
      })),
    ),
    h('button', { onClick: () => props.onDelete(flowId), disabled: props.busy }, '删除节点'),
  )
}

function NodeCanvas(props) {
  const { flowId, def, positions, startNode, returns = [], onMove, dragRef, busy } = props
  const { selectedNode, wire, onSelectNode, onPortStart, onWireNode, onWireReturn, onCancelWire } = props
  const [dragPosition, setDragPosition] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [camera, setCamera] = useState({ x: 0, y: 0 })
  const [selectedEdge, setSelectedEdge] = useState(null)
  const edgeDragRef = useRef(null)
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const suppressClick = useRef(false)
  const nodes = Object.entries(def.nodes ?? {})
  const nodePoint = (id) => positions[id] ?? { x: 40 + (Math.max(0, nodes.findIndex(([key]) => key === id)) % 4) * 220, y: 40 + Math.floor(Math.max(0, nodes.findIndex(([key]) => key === id)) / 4) * 140 }
  const returnX = Math.max(360, ...nodes.map(([id]) => nodePoint(id).x + 270))
  const point = (id) => dragPosition?.id === id ? dragPosition.pos : positions[id] ?? (id.startsWith('return:') ? { x: returnX, y: 40 + returns.indexOf(id.slice(7)) * 64 } : nodePoint(id))
  const itemIds = [...nodes.map(([id]) => id), ...returns.map((ret) => `return:${ret}`)]
  // 视口平移与节点的世界坐标分离，空白区域没有滚动边界。
  const displayPoint = point
  const width = Math.max(570, ...itemIds.map((id) => displayPoint(id).x + 240))
  const height = Math.max(420, ...returns.map((ret) => displayPoint(`return:${ret}`).y + 80), ...nodes.map(([id, node]) => displayPoint(id).y + 100 + portsOf(node).length * 32))
  const onPointerDown = (event, nodeId) => {
    if (busy || wire !== null || event.button !== 0) return
    const start = point(nodeId)
    suppressClick.current = false
    dragRef.current = { nodeId, startX: event.clientX, startY: event.clientY, origin: start, pos: start }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event, nodeId) => {
    const drag = dragRef.current
    if (drag === null || drag.nodeId !== nodeId) return
    const dx = (event.clientX - drag.startX) / zoom
    const dy = (event.clientY - drag.startY) / zoom
    if (!suppressClick.current && Math.abs(dx) + Math.abs(dy) < 4) return
    suppressClick.current = true
    drag.pos = { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) }
    setDragPosition({ id: nodeId, pos: drag.pos })
  }
  const endDrag = (cancelled) => {
    const drag = dragRef.current
    dragRef.current = null
    setDragPosition(null)
    // 一次拖动只写一条历史，避免每个 pointermove 克隆完整配置并挤满撤销栈。
    if (!cancelled && drag !== null && suppressClick.current) onMove(flowId, drag.nodeId, drag.pos)
  }
  const selectNode = (nodeId) => {
    if (busy || suppressClick.current) { suppressClick.current = false; return }
    if (wire !== null) onWireNode(nodeId)
    else onSelectNode(nodeId)
  }
  const fit = () => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const elements = viewport.querySelectorAll('.wf-node, .wf-return-marker')
    // 使用真实内容边界；节点整体位于远处时不把世界原点纳入范围。
    const bounds = itemIds.map((id, index) => ({ ...point(id), width: elements[index]?.offsetWidth ?? 196, height: elements[index]?.offsetHeight ?? 100 }))
    const left = bounds.length ? Math.min(...bounds.map((item) => item.x)) : 0
    const top = bounds.length ? Math.min(...bounds.map((item) => item.y)) : 0
    const contentWidth = Math.max(1, ...bounds.map((item) => item.x + item.width - left))
    const contentHeight = Math.max(1, ...bounds.map((item) => item.y + item.height - top))
    const nextZoom = Math.min(1, Math.max(1, viewport.clientWidth - 48) / contentWidth, Math.max(1, viewport.clientHeight - 48) / contentHeight)
    setZoom(nextZoom)
    setCamera({ x: 24 - left * nextZoom, y: 24 - top * nextZoom })
  }
  useEffect(() => { fit(); setSelectedEdge(null) }, [flowId])
  useEffect(() => {
    const viewport = viewportRef.current
    const panWheel = (event) => {
      if (event.ctrlKey || event.metaKey) return
      event.preventDefault()
      setCamera((value) => ({ x: value.x - event.deltaX - (event.shiftKey ? event.deltaY : 0), y: value.y - (event.shiftKey ? 0 : event.deltaY) }))
    }
    viewport?.addEventListener('wheel', panWheel, { passive: false })
    return () => viewport?.removeEventListener('wheel', panWheel)
  }, [])
  const changeZoom = (nextZoom) => {
    const viewport = viewportRef.current
    const center = { x: (viewport?.clientWidth ?? 0) / 2, y: (viewport?.clientHeight ?? 0) / 2 }
    setCamera({ x: center.x - (center.x - camera.x) * nextZoom / zoom, y: center.y - (center.y - camera.y) * nextZoom / zoom })
    setZoom(nextZoom)
  }
  const startEdgeDrag = (event, key, route, axis) => {
    if (busy || wire !== null || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    edgeDragRef.current = { key, axis, x: event.clientX, y: event.clientY, origin: route, pos: route, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveEdge = (event) => {
    const drag = edgeDragRef.current
    if (drag === null) return
    const delta = (drag.axis === 'x' ? event.clientX - drag.x : event.clientY - drag.y) / zoom
    if (!drag.moved && Math.abs(delta) < 3) return
    drag.moved = true
    drag.pos = { ...drag.origin, [drag.axis]: Math.round(drag.origin[drag.axis] + delta) }
    setDragPosition({ id: drag.key, pos: drag.pos })
  }
  const endEdgeDrag = (cancelled) => {
    const drag = edgeDragRef.current
    edgeDragRef.current = null
    setDragPosition(null)
    if (!cancelled && drag?.moved) onMove(flowId, drag.key, drag.pos)
  }
  return h('section', { className: 'wf-flow', 'aria-label': '工作流画布' },
    h('div', { className: 'wf-canvas-toolbar' },
      h('div', null, h('strong', null, flowId === null ? '主流程' : flowId), h('span', { className: 'wf-hint' }, ` · ${nodes.length} 个节点`)),
      h('div', null,
        h('button', { onClick: () => changeZoom(Math.max(Math.min(0.25, zoom), zoom - 0.1)), 'aria-label': '缩小画布' }, '−'),
        h('button', { onClick: () => changeZoom(1), title: '恢复原始大小' }, `${Math.round(zoom * 100)}%`),
        h('button', { onClick: () => changeZoom(Math.min(1.5, zoom + 0.1)), 'aria-label': '放大画布' }, '＋'),
        h('button', { onClick: fit }, '适应画布'),
      ),
    ),
    wire !== null ? h('div', { className: 'wf-wire', role: 'status' },
      h('span', null, `${wire.node} · ${wire.result} → 请选择目标节点或返回`),
      h('button', { onClick: onCancelWire }, '取消连线'),
    ) : null,
    h('div', {
      className: 'wf-canvas', ref: viewportRef,
      style: { backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${20 * zoom}px ${20 * zoom}px` },
      onClick: (event) => { if (!event.target.closest('.wf-node, .wf-return-marker, .wf-edge')) setSelectedEdge(null) },
      onPointerDown: (event) => {
        if ((event.button !== 1 && event.button !== 2) || event.target.closest('.wf-node, .wf-return-marker')) return
        event.preventDefault()
        const viewport = event.currentTarget
        panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: camera }
        viewport.setPointerCapture(event.pointerId)
        viewport.classList.add('wf-panning')
      },
      onPointerMove: (event) => {
        const pan = panRef.current
        if (pan === null || pan.id !== event.pointerId) return
        setCamera({ x: pan.origin.x + event.clientX - pan.x, y: pan.origin.y + event.clientY - pan.y })
      },
      onPointerUp: (event) => {
        if (panRef.current?.id !== event.pointerId) return
        event.currentTarget.releasePointerCapture(event.pointerId)
      },
      onLostPointerCapture: (event) => {
        if (panRef.current?.id !== event.pointerId) return
        panRef.current = null
        event.currentTarget.classList.remove('wf-panning')
      },
      onContextMenu: (event) => {
        if (!event.target.closest('.wf-node, .wf-return-marker')) event.preventDefault()
      },
      onAuxClick: (event) => {
        if (!event.target.closest('.wf-node, .wf-return-marker')) event.preventDefault()
      },
    },
      h('div', { style: { position: 'absolute', inset: 0 } },
        h('div', { className: 'wf-canvas-surface', style: { width: `${width}px`, height: `${height}px`, transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})`, transformOrigin: 'top left' } },
          h('svg', { className: 'wf-edges', width, height, 'aria-label': '节点连线' },
            ...nodes.flatMap(([id, node]) => portsOf(node).map((port, index) => {
              const target = node.results?.[port.key]?.target ?? node.onReturn?.[port.key]
              const source = displayPoint(id)
              const targetIndex = returns.indexOf(target?.return)
              const destination = target?.node !== undefined && def.nodes[target.node] !== undefined
                ? { x: displayPoint(target.node).x, y: displayPoint(target.node).y + 22 }
                : targetIndex >= 0 ? { x: displayPoint(`return:${target.return}`).x, y: displayPoint(`return:${target.return}`).y + 16 } : null
              if (destination === null) return null
              const x = source.x + 196, y = source.y + 88 + index * 32
              const key = `edge:${id}:${port.key}`
              const backward = destination.x < x + 48
              const route = dragPosition?.id === key ? dragPosition.pos : positions[key] ?? {
                x: backward ? x + 36 + index * 12 : (x + destination.x) / 2,
                y: backward ? Math.max(source.y + 100 + portsOf(node).length * 32, destination.y + 64) : destination.y,
              }
              const leadX = destination.x - 24
              const path = `M ${x} ${y} H ${route.x} V ${route.y} H ${leadX} V ${destination.y} H ${destination.x}`
              const selected = selectedEdge === key
              return h('g', { key, className: `wf-edge${selected ? ' wf-edge-selected' : ''}`, 'data-edge': key },
                h('path', { d: path, className: 'wf-edge-line', fill: 'none' }),
                h('path', { d: `M ${destination.x - 7} ${destination.y - 4} L ${destination.x} ${destination.y} L ${destination.x - 7} ${destination.y + 4}`, fill: 'none' }),
                h('path', { d: path, className: 'wf-edge-hit', tabIndex: 0, role: 'button', 'aria-label': `选择连线 ${id} ${port.key}`, 'aria-pressed': selected,
                  onClick: (event) => { event.stopPropagation(); setSelectedEdge(key) },
                  onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedEdge(key) } },
                }),
                ...(selected ? [
                  { axis: 'x', cx: route.x, cy: (y + route.y) / 2, label: '左右拖动竖直线段' },
                  { axis: 'y', cx: (route.x + leadX) / 2, cy: route.y, label: '上下拖动水平线段' },
                ].map((handle) => h('circle', {
                  key: handle.axis, className: `wf-edge-handle wf-edge-handle-${handle.axis}`, cx: handle.cx, cy: handle.cy, r: 6,
                  tabIndex: busy ? -1 : 0, role: 'button', 'aria-label': `${handle.label}（方向键调整，Shift 加速）`, 'aria-disabled': busy,
                  onPointerDown: (event) => startEdgeDrag(event, key, route, handle.axis), onPointerMove: moveEdge,
                  onPointerUp: () => endEdgeDrag(false), onPointerCancel: () => endEdgeDrag(true), onLostPointerCapture: () => endEdgeDrag(true),
                  onClick: (event) => event.stopPropagation(),
                  onKeyDown: (event) => {
                    const keys = handle.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
                    const direction = keys.indexOf(event.key)
                    if (direction < 0) return
                    event.preventDefault()
                    event.stopPropagation()
                    if (busy || wire !== null) return
                    onMove(flowId, key, { ...route, [handle.axis]: route[handle.axis] + (direction === 0 ? -1 : 1) * (event.shiftKey ? 40 : 10) })
                  },
                }, h('title', null, handle.label))) : []),
              )
            })),
          ),
          ...nodes.map(([nodeId, node]) => {
            const pos = displayPoint(nodeId)
            return h('div', {
              key: nodeId, className: `wf-node${nodeId === selectedNode ? ' wf-selected' : ''}`,
              style: { left: `${pos.x}px`, top: `${pos.y}px` },
              onClick: () => selectNode(nodeId),
            },
              h('button', {
                className: 'wf-node-title', disabled: busy, 'aria-label': `编辑节点 ${nodeId}`,
                onPointerDown: (event) => onPointerDown(event, nodeId),
                onPointerMove: (event) => onPointerMove(event, nodeId),
                onPointerUp: () => endDrag(false), onPointerCancel: () => endDrag(true),
                title: '点击编辑，拖动调整位置',
              }, `${nodeId}${nodeId === startNode ? ' ★' : ''}`),
              h('div', { className: 'wf-node-type', title: nodeSummary(node) }, nodeSummary(node)),
              ...portsOf(node).map((port) => h('button', {
                key: port.key,
                className: `wf-port${wire !== null && wire.node === nodeId && wire.result === port.key ? ' wf-wiring' : ''}`,
                disabled: busy,
                onClick: (event) => { event.stopPropagation(); onPortStart(nodeId, port.key) },
                title: `${port.label}；点击后选择目标节点或返回`,
              }, h('span', { className: 'wf-port-label', 'aria-hidden': true }, '结果'), `${port.key} → ${node.results?.[port.key]?.target?.node ?? node.results?.[port.key]?.target?.return ?? node.onReturn?.[port.key]?.node ?? node.onReturn?.[port.key]?.return ?? '未连接'}`)),
            )
          }),
          ...returns.map((ret) => h('button', {
            key: ret, className: 'wf-return-marker', style: { position: 'absolute', left: `${displayPoint(`return:${ret}`).x}px`, top: `${displayPoint(`return:${ret}`).y}px`, touchAction: 'none', cursor: wire === null ? 'grab' : 'pointer' },
            onPointerDown: (event) => onPointerDown(event, `return:${ret}`),
            onPointerMove: (event) => onPointerMove(event, `return:${ret}`),
            onPointerUp: () => endDrag(false), onPointerCancel: () => endDrag(true),
            onClick: () => { if (suppressClick.current) { suppressClick.current = false; return }; if (wire !== null) onWireReturn(ret) }, disabled: busy,
            title: wire === null ? '拖动调整结束节点位置；点击结果端口后可连接到此处' : `连接到返回 ${ret}`,
          }, `⇥ ${ret}`)),
        ),
      ),
    ),
    h('div', { className: 'wf-canvas-help' }, '空白处右键/中键自由平移 · 滚轮平移 · 拖动标题移动节点 · 点击连线高亮，拖动圆点调整折线 · ★ 入口'),
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
