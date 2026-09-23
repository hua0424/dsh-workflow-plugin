/**
 * T1 配置编辑面板（React plain-JS，无 JSX 工具链依赖；画布为最小占位实现）。
 *
 * 范围（#160 T1）：打开授权目录 → 选 YAML → 自动关联布局 → 编辑公共
 * actorCommonPersona → 切换主/子流程查看并移动节点位置 → 只读预览 →
 * 校验后显式保存 → 分别报告 YAML/布局写入结果。
 *
 * 不做：新建配置（T3）、角色/Judge/模型表单（T2）、Program（T4）、Child 映射（T5）、
 * 拓扑增删（均后票）。画布节点拖动用指针事件最小实现；React Flow 画布替换见 README
 * pending（本票不引入 reactflow 打包，保持 bundle 零第三方）。
 *
 * 业务校验与布局规则全部走服务端 RPC（src/editor/* 单源），浏览器不复制规则。
 * 面板编辑变迁（历史/脏标记/保存计划）唯一来源为同目录 `edits.js`
 * （纯函数，可单测；脏语义钉住服务端 `draft.ts savePlan`）。
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { callEditor, rpcErrorMessage } from './rpc.js'
import {
  applyPersonaEdit, ID_PATTERN, isDirty, layoutFilenameFor, moveNodeEdit, redoEdit, savePlanOf, undoEdit,
} from './edits.js'

function workflowIdOf(yamlName) {
  return yamlName.endsWith('.yaml') ? yamlName.slice(0, -'.yaml'.length) : yamlName
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

  const moveNode = useCallback((flowId, nodeId, pos) => {
    setState((prev) => {
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
    h('h2', null, '工作流配置编辑器（T1 最小闭环）'),
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
      flows.length > 0 ? h('div', { className: 'wf-flows' },
        ...flows.map((f) => h('button', {
          key: f.id ?? '__main__',
          onClick: () => setFlow(f.id),
          disabled: activeFlow !== null && f.id === activeFlow.id,
        }, f.label)),
      ) : null,
      activeFlow !== null ? h(NodeCanvas, {
        flowId: activeFlow.id,
        def: activeFlow.def,
        positions: activePositions,
        startNode: activeFlow.def.startNode,
        returns: activeFlow.def.returns,
        onMove: moveNode,
        dragRef,
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

function NodeCanvas({ flowId, def, positions, startNode, returns, onMove, dragRef }) {
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
    h('div', { className: 'wf-canvas' },
      ...nodes.map(([nodeId, node], index) => {
        const pos = positions[nodeId] ?? { x: 40 + (index % 4) * 220, y: 40 + Math.floor(index / 4) * 140 }
        return h('div', {
          key: nodeId,
          className: 'wf-node',
          style: { left: `${pos.x}px`, top: `${pos.y}px` },
          onPointerDown: (event) => onPointerDown(event, nodeId),
          onPointerMove: (event) => onPointerMove(event, nodeId),
          onPointerUp,
        },
          h('div', { className: 'wf-node-title' }, `${nodeId}${nodeId === startNode ? ' ★' : ''}`),
          h('div', { className: 'wf-node-type' }, nodeSummary(node)),
          ...portsOf(node).map((port) => h('div', { key: port.key, className: 'wf-port' }, port.label)),
          h('div', { className: 'wf-pos' }, `(${pos.x}, ${pos.y})`),
        )
      }),
    ),
    h('div', null, '（T1 画布为最小占位实现：拖动改位置，不改拓扑；React Flow 替换见 README pending）'),
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
