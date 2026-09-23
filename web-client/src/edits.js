/**
 * T1 面板纯状态变迁（无 React、无 DOM、无 RPC）。
 *
 * 面板曾手抄一套历史/脏标记逻辑，与服务端 `src/editor/draft.ts` 分叉
 * （撤销双置 dirty、保存计划另算）。本模块是面板侧唯一的编辑变迁来源，
 * 可在 node:test 直接断言行为；`panel.js` 只剩 React 接线与 RPC 调用。
 *
 * 脏标记语义与服务端 `savePlan` 同源：writeYaml = dirtyBusiness；
 * writeLayout = dirtyBusiness || dirtyLayout。撤销/重做恢复快照时的脏标记，
 * 纯布局撤销后保存只写布局，不重写 YAML。
 */

/** 撤销/重做历史上限（页面内，超出丢弃最旧；与服务端 HISTORY_LIMIT 同值）。 */
export const HISTORY_LIMIT = 50

/** 合法 YAML 文件名：小写 [a-z][a-z0-9-]* + .yaml（与服务端 ID_PATTERN 同语义）。 */
export const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 布局文件名自动关联（与服务端 layoutFilenameFor 同语义）。 */
export function layoutFilenameFor(yamlName) {
  if (typeof yamlName !== 'string' || !yamlName.endsWith('.yaml')) return undefined
  const stem = yamlName.slice(0, -'.yaml'.length)
  return stem === '' ? undefined : `${stem}.layout.json`
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function isDirty(state) {
  return state.dirtyBusiness || state.dirtyLayout
}

/** 保存计划唯一口径（面板侧；语义钉住服务端 `savePlan`，见 panel-edits 测试）。 */
export function savePlanOf(state) {
  return {
    writeYaml: state.dirtyBusiness,
    writeLayout: state.dirtyBusiness || state.dirtyLayout,
  }
}

export function snapshotOf(state) {
  return {
    draft: clone(state.draft),
    positions: clone(state.positions),
    personaInput: state.personaInput,
    dirtyBusiness: state.dirtyBusiness,
    dirtyLayout: state.dirtyLayout,
  }
}

export function pushHistory(state) {
  const past = [...state.past, snapshotOf(state)]
  while (past.length > HISTORY_LIMIT) past.shift()
  return { ...state, past, future: [] }
}

/**
 * 公共 actorCommonPersona 设置/清除（undefined=清除；空白拒绝）。
 * 与草稿值相同时为 noop（不记历史、不置脏，避免无故重写 YAML）。
 */
export function applyPersonaEdit(state, clear) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const raw = clear ? undefined : state.personaInput
  if (raw !== undefined && raw.trim() === '') {
    return { ok: false, reason: 'actorCommonPersona 为空：保留请填非空文本，删除请使用清除操作（省略与非空值区别保留）' }
  }
  const next = clear ? undefined : raw.trim()
  if ((state.draft.actorCommonPersona ?? undefined) === next) return { ok: true, noop: true, state }
  const withHistory = pushHistory(state)
  const draft = clone(withHistory.draft)
  if (next === undefined) delete draft.actorCommonPersona
  else draft.actorCommonPersona = next
  return {
    ok: true,
    state: { ...withHistory, draft, personaInput: next ?? '', dirtyBusiness: true, saveResult: null, problems: [] },
  }
}

/** 节点位置移动（仅位置；同坐标为 noop；非法坐标拒绝）。 */
export function moveNodeEdit(state, flowId, nodeId, pos) {
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    return { ok: false, reason: `节点 "${nodeId}" 坐标必须是有限数` }
  }
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const table = flowId === null ? state.positions.main : (state.positions.children[flowId] ?? {})
  const current = table[nodeId]
  if (current !== undefined && current.x === pos.x && current.y === pos.y) {
    return { ok: true, noop: true, state }
  }
  const withHistory = pushHistory(state)
  const positions = clone(withHistory.positions)
  if (flowId === null) positions.main[nodeId] = { x: pos.x, y: pos.y }
  else positions.children[flowId] = { ...(positions.children[flowId] ?? {}), [nodeId]: { x: pos.x, y: pos.y } }
  return { ok: true, state: { ...withHistory, positions, dirtyLayout: true, saveResult: null } }
}

/** 撤销：恢复快照（含脏标记）；无可撤销内容返回 null。 */
export function undoEdit(state) {
  if (state.past.length === 0 || state.draft === null) return null
  const last = state.past[state.past.length - 1]
  return {
    ...state,
    past: state.past.slice(0, -1),
    future: [...state.future, snapshotOf(state)],
    draft: last.draft,
    positions: last.positions,
    personaInput: last.personaInput,
    dirtyBusiness: last.dirtyBusiness,
    dirtyLayout: last.dirtyLayout,
    saveResult: null,
  }
}

/** 重做：恢复快照（含脏标记）；无可重做内容返回 null。 */
export function redoEdit(state) {
  if (state.future.length === 0 || state.draft === null) return null
  const next = state.future[state.future.length - 1]
  return {
    ...state,
    future: state.future.slice(0, -1),
    past: [...state.past, snapshotOf(state)],
    draft: next.draft,
    positions: next.positions,
    personaInput: next.personaInput,
    dirtyBusiness: next.dirtyBusiness,
    dirtyLayout: next.dirtyLayout,
    saveResult: null,
  }
}
