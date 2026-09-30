/**
 * #179 对话区启动弹窗与原生命令提交（父 #176，依赖 #178 只读目录接缝）。
 *
 * 会话输入工具区（`conversation.input.left`，session-scoped list）的启动按钮 +
 * 归属当前 Session 的原生 `<dialog>` 模态弹窗：只读目录选配置（展示
 * `<workflow-id>.yaml`，提交不带扩展名的 workflow-id）、可选启动 prompt、
 * 上下文提示，确认经宿主原生命令通道执行与手写 `/dsh-flow start` 等效的
 * 同一 Session 启动。
 *
 * 边界（与 #176 规格一致）：
 * - 打开/刷新/取消只读目录，不执行命令、不创建 Run、不激活空白会话；
 * - 不碰对话输入框草稿（不读不写不清空未提交文字）；
 * - 切换会话或卸载关闭弹窗并清理，旧选择/prompt 不用于另一会话，陈旧
 *   目录响应按 generation + 会话双守卫丢弃，陈旧 close 按打开代际守卫丢弃；
 * - 本地提交闸门防重复派发；关闭 UI 不取消已发生的服务端启动（执行 promise
 *   不绑定弹窗 abort）；
 * - 只有传输成功且内层命令 result 为 success 才算成功；失败保留输入并显示
 *   真实原因；未知结果明确指引先查状态、不自动重试；Run 冲突不 reset/接管。
 * - UI 禁用不是权限边界：实际校验仍由服务端命令链路执行。
 *
 * 提交纯函数（命令组装/闸门/结果分类）见同目录 `start-submit.js`（无 React
 * 依赖，可单测）；本文件只含会话归属弹窗组件与自包含样式。
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import { START_PROMPT_MAX_CHARS, normalizeStartPrompt, startCommandLineOf, canStartWorkflow, executeStartWorkflow } from './start-submit.js'

/** 自包含样式：随 bundle 下发，不依赖宿主全局 CSS；窄屏不溢出，明暗主题跟随系统。 */
export const START_MODAL_STYLES = `
.wf-start-dialog { color-scheme: light dark; max-width: min(560px, 92vw); width: 480px; border: 1px solid #dbe3ec; border-radius: 12px; padding: 18px 20px; font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.wf-start-dialog::backdrop { background: rgba(0, 0, 0, .35); }
.wf-start-dialog h2 { margin: 0 0 8px; font-size: 16px; }
.wf-start-dialog button, .wf-start-dialog textarea { font: inherit; }
.wf-start-dialog button { min-height: 32px; padding: 5px 12px; border: 1px solid #dbe3ec; border-radius: 7px; background: #fff; cursor: pointer; }
.wf-start-dialog button:disabled { cursor: default; opacity: .45; }
.wf-start-dialog textarea { display: block; width: 100%; min-height: 64px; resize: vertical; }
.wf-start-dialog label { display: block; margin: 10px 0 5px; }
.wf-start-dialog .wf-start-hint { margin: 0 0 4px; font-size: 12px; opacity: .75; }
.wf-start-dialog .wf-start-list { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; max-height: 260px; overflow: auto; }
.wf-start-dialog .wf-start-item { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; border: 1px solid #dbe3ec; border-radius: 8px; }
.wf-start-dialog .wf-start-item code { overflow-wrap: anywhere; }
.wf-start-dialog .wf-start-reasons { font-size: 12px; opacity: .8; }
.wf-start-dialog .wf-start-error { margin: 10px 0; padding: 8px 10px; border-radius: 8px; border: 1px solid #f4c7ce; background: #fff0f1; color: #b42336; overflow-wrap: anywhere; }
.wf-start-dialog .wf-start-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
@media (prefers-color-scheme: dark) {
  .wf-start-dialog { background: #1c2530; color: #e6edf4; border-color: #33414f; }
  .wf-start-dialog button { background: #243041; color: #e6edf4; border-color: #33414f; }
  .wf-start-dialog .wf-start-item { border-color: #33414f; }
  .wf-start-dialog .wf-start-error { background: #3a1f26; border-color: #7a2f3c; color: #ffc9d1; }
}
`

/**
 * 会话输入工具区启动按钮 + 归属当前 Session 的模态弹窗。
 *
 * 标准 slot props（`useSession`/`useInput`/`useWorkspaces`/`sessionId`）由宿主
 * 按 `conversation.input.left` 契约提供；`loadCatalog`（#178 只读接缝）与
 * `runCommand`（原生命令通道）由注册闭包注入。无 DOM 注入，不替换 composer，
 * 不读写对话输入框草稿。
 */
export function StartWorkflowButton(props) {
  const { sessionId, useSession, useInput, useWorkspaces, loadCatalog, runCommand } = props
  const session = useSession((snapshot) => snapshot)
  const input = useInput((snapshot) => snapshot)
  const workspaces = useWorkspaces((snapshot) => snapshot)
  const hasWorkspace = sessionId !== undefined && Array.isArray(workspaces?.items)
    && workspaces.items.some((view) => Array.isArray(view.sessionIds) && view.sessionIds.includes(sessionId))
  const gate = canStartWorkflow({ session, inputPhase: input?.phase, hasWorkspace })
  const channelReady = typeof loadCatalog === 'function' && typeof runCommand === 'function'

  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState({ status: 'idle', items: [], error: null })
  const [selection, setSelection] = useState(null)
  const [prompt, setPrompt] = useState('')
  const [submit, setSubmit] = useState({ status: 'idle', message: '' })

  const entryRef = useRef(null)
  const dialogRef = useRef(null)
  const catalogGen = useRef(0)
  const catalogAbort = useRef(null)
  const submitGate = useRef(false)
  const openSession = useRef(undefined)
  /* F-001 打开代际：每次 openModal 递增；显式关闭/Escape 标记待处理 close 所属代际，陈旧 close 到达时丢弃。 */
  const openSeq = useRef(0)
  const pendingCloseGen = useRef(null)
  const submitRef = useRef(submit)
  submitRef.current = submit

  const closeDialog = useCallback(() => {
    catalogAbort.current?.abort()
    catalogAbort.current = null
    catalogGen.current += 1
    const dialog = dialogRef.current
    if (dialog?.open) {
      pendingCloseGen.current = openSeq.current
      dialog.close()
    } else setOpen(false)
  }, [])

  /* 切换会话：关闭弹窗并清理，不把旧选择用于另一会话；进行中的提交不取消服务端启动。 */
  useEffect(() => {
    if (open && sessionId !== openSession.current) closeDialog()
  }, [open, sessionId, closeDialog])

  /* 卸载清理：只读请求可取消，服务端启动不受影响。 */
  useEffect(() => () => {
    catalogAbort.current?.abort()
    catalogGen.current += 1
  }, [])

  const refreshCatalog = useCallback(async () => {
    if (typeof loadCatalog !== 'function') {
      setCatalog({ status: 'error', items: [], error: { code: 'workflow/no-channel', message: '当前页面没有可用的目录读取通道' } })
      return
    }
    const gen = ++catalogGen.current
    catalogAbort.current?.abort()
    catalogAbort.current = new AbortController()
    setCatalog({ status: 'loading', items: [], error: null })
    try {
      const value = await loadCatalog(catalogAbort.current.signal)
      if (gen !== catalogGen.current || sessionId !== openSession.current) return
      const items = Array.isArray(value?.items) ? value.items : []
      setCatalog({ status: 'ready', items, error: null })
      setSelection((prev) => (items.some((item) => item?.workflowId === prev && item?.status !== 'invalid') ? prev : null))
    } catch (error) {
      if (gen !== catalogGen.current || sessionId !== openSession.current) return
      setCatalog({ status: 'error', items: [], error: { code: error?.code ?? 'unknown', message: error instanceof Error ? error.message : String(error) } })
    }
  }, [loadCatalog, sessionId])

  const openModal = useCallback(() => {
    if (!gate.ok || !channelReady) return
    openSeq.current += 1
    openSession.current = sessionId
    setPrompt('')
    setSelection(null)
    if (submitGate.current) {
      setSubmit({ status: 'working', message: '已有启动请求进行中，请等待其落定后再提交' })
    } else {
      setSubmit({ status: 'idle', message: '' })
    }
    setOpen(true)
    /* F-001 快速取消→重开：旧 close 事件尚未派发时 open 仍为 true，
       置位 effect 不会重跑；原生 dialog 已被同步 close，需在此同步重开并重拉目录。 */
    if (open) {
      const dlg = dialogRef.current
      if (dlg !== null && !dlg.open) {
        try { dlg.showModal() } catch { /* 已打开时忽略重复调用 */ }
        void refreshCatalog()
      }
    }
  }, [gate.ok, channelReady, sessionId, refreshCatalog, open])

  /* 打开落定：原生顶层弹窗 + 只读目录拉取（不执行命令）。 */
  useEffect(() => {
    if (!open) return undefined
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.open) {
      try { dialog.showModal() } catch { /* 已打开时忽略重复调用 */ }
    }
    void refreshCatalog()
    return () => {
      catalogAbort.current?.abort()
      catalogAbort.current = null
    }
  }, [open, refreshCatalog])

  /* 原生 dialog 事件：提交中禁止 Escape 关闭；关闭按打开代际守卫同步 React 状态并回焦。 */
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return undefined
    const onCancel = (event) => {
      if (submitRef.current.status === 'working' || submitGate.current) {
        event.preventDefault()
        return
      }
      /* Escape 将随后触发 close：标记所属代际，供 onClose 区分陈旧事件。 */
      pendingCloseGen.current = openSeq.current
    }
    const onClose = () => {
      const pending = pendingCloseGen.current
      const current = openSeq.current
      pendingCloseGen.current = null
      /* F-001 陈旧 close（快速取消→重开后旧事件到达）不得回落新打开状态。 */
      if (pending !== null && pending !== current) return
      setOpen(false)
      entryRef.current?.focus?.()
    }
    dialog.addEventListener('cancel', onCancel)
    dialog.addEventListener('close', onClose)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
      dialog.removeEventListener('close', onClose)
    }
  }, [])

  const confirmStart = useCallback(async () => {
    if (submitGate.current) return
    const fresh = canStartWorkflow({ session, inputPhase: input?.phase, hasWorkspace })
    if (!fresh.ok) {
      setSubmit({ status: 'failed', message: fresh.reason })
      return
    }
    const built = startCommandLineOf(selection, prompt)
    if (!built.ok) {
      setSubmit({ status: 'failed', message: built.reason })
      return
    }
    submitGate.current = true
    setSubmit({ status: 'working', message: '' })
    try {
      const outcome = await executeStartWorkflow({ runCommand, sessionId, line: built.line })
      if (sessionId !== openSession.current) return
      if (outcome.kind === 'success') {
        setSubmit({ status: 'idle', message: '' })
        closeDialog()
        return
      }
      setSubmit({ status: outcome.kind === 'unknown' ? 'unknown' : 'failed', message: outcome.message })
    } finally {
      submitGate.current = false
    }
  }, [session, input?.phase, hasWorkspace, selection, prompt, runCommand, sessionId, closeDialog])

  const selectable = catalog.items.filter((item) => item?.status !== 'invalid')
  const entryDisabled = !gate.ok || !channelReady
  const confirmDisabled = !gate.ok || catalog.status !== 'ready' || selection === null
    || submit.status === 'working' || submitGate.current
  const hintId = 'wf-start-context-hint'

  return h('span', { className: 'wf-start-entry' },
    h('style', null, START_MODAL_STYLES),
    h('button', {
      type: 'button', ref: entryRef, onClick: openModal, disabled: entryDisabled,
      'aria-haspopup': 'dialog', title: entryDisabled ? (gate.reason ?? '启动工作流不可用') : '启动工作流',
    }, '启动工作流'),
    h('dialog', { ref: dialogRef, className: 'wf-start-dialog', 'aria-label': '启动工作流' },
      h('h2', null, '启动工作流'),
      catalog.status === 'loading' ? h('p', { role: 'status' }, '正在读取工作流目录…') : null,
      catalog.status === 'error' ? h('div', { role: 'alert' },
        h('p', null, `读取目录失败（${catalog.error?.code ?? 'unknown'}）：${catalog.error?.message ?? '未知错误'}`),
        h('button', { type: 'button', onClick: refreshCatalog }, '刷新重试'),
      ) : null,
      catalog.status === 'ready' && catalog.items.length === 0 ? h('div', null,
        h('p', null, '工作流目录为空：请先在配置编辑器中创建并保存工作流，再刷新重试。'),
        h('button', { type: 'button', onClick: refreshCatalog }, '刷新'),
      ) : null,
      catalog.status === 'ready' && catalog.items.length > 0 ? h('div', null,
        h('button', { type: 'button', onClick: refreshCatalog, disabled: submit.status === 'working' }, '刷新'),
        h('div', { className: 'wf-start-list', role: 'radiogroup', 'aria-label': '选择工作流配置' },
          ...catalog.items.map((item) => {
            const id = item?.workflowId
            const invalid = item?.status === 'invalid'
            const reasons = Array.isArray(item?.reasons) ? item.reasons : []
            return h('label', { key: String(id), className: 'wf-start-item' },
              h('input', {
                type: 'radio', name: 'wf-start-choice', value: String(id),
                checked: selection === id, disabled: invalid || submit.status === 'working',
                onChange: () => setSelection(id),
              }),
              h('span', null,
                h('code', null, `${String(id)}.yaml`),
                item?.status === 'warning' ? h('span', { className: 'wf-start-reasons' }, `（警告仍可启动：${reasons.join('；')}）`) : null,
                invalid ? h('span', { className: 'wf-start-reasons' }, `（不可选：${reasons.join('；')}）`) : null,
              ),
            )
          }),
        ),
        selectable.length === 0 ? h('p', { role: 'status' }, '目录中没有可启动的有效配置（全部无效），请修正配置后刷新。') : null,
      ) : null,
      h('p', { id: hintId, className: 'wf-start-hint' }, '当前会话上下文会追加到 prompt 中。启动沿用当前会话上下文，不会另行复制历史全文。'),
      h('label', { htmlFor: 'wf-start-prompt' }, '启动 prompt（可选，空值沿用命令现有语义）'),
      h('textarea', {
        id: 'wf-start-prompt', value: prompt, 'aria-describedby': hintId,
        disabled: submit.status === 'working',
        onChange: (event) => setPrompt(event.target.value),
      }),
      submit.status === 'failed' || submit.status === 'unknown'
        ? h('div', { className: 'wf-start-error', role: 'alert' }, submit.message)
        : null,
      submit.status === 'working' ? h('p', { role: 'status' }, submit.message === '' ? '正在提交启动请求…' : submit.message) : null,
      !gate.ok ? h('p', { role: 'status' }, `当前不可确认：${gate.reason}`) : null,
      h('div', { className: 'wf-start-actions' },
        h('button', { type: 'button', onClick: closeDialog, disabled: submit.status === 'working' }, '取消'),
        h('button', { type: 'button', onClick: confirmStart, disabled: confirmDisabled }, '确定启动'),
      ),
    ),
  )
}
