/**
 * 面板纯状态变迁（无 React、无 DOM、无 RPC；T1 建 persona/位置，T2 #161 追加角色/Judge/模型）。
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

/** 保留角色名（与服务端 RESERVED_ROLE_KEYS 同源；对等测试钉住）。 */
export const RESERVED_ROLE_KEYS = ['manager', 'judge']

/** 复用粒度（与服务端 ROLE_REUSE_MODES 同源；省略 = node）。 */
export const ROLE_REUSE_MODES = ['node', 'continuable']

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

/* ------------------------------------------------------------------ *
 * T2（#161）角色、Judge 与模型编辑镜像：与服务端 `src/editor/draft.ts`
 * 同语义（本地守卫一致，完整语义走服务端 validate RPC）。全部经 pushHistory
 * 接入撤销/重做并置 dirtyBusiness。删除角色保留悬空引用，由保存前校验诊断。
 * ------------------------------------------------------------------ */

function roleKeyError(key) {
  if (!ID_PATTERN.test(key)) return `角色 id "${key}" 不是合法小写 [a-z][a-z0-9-]* 标识符`
  if (RESERVED_ROLE_KEYS.includes(key)) return `角色 id "${key}" 为保留名（manager/judge），不可配置`
  return undefined
}

function normalizeModelInput(model) {
  if (model === undefined) return { ok: true, value: undefined }
  const provider = model.provider.trim()
  const modelId = model.modelId.trim()
  if (provider === '' || modelId === '') {
    return { ok: false, reason: '模型 provider/modelId 须成对填写非空文本，删除请使用清除操作（空字符串不得替代省略）' }
  }
  if (model.reasoningEffort === undefined) return { ok: true, value: { provider, modelId } }
  const effort = model.reasoningEffort.trim()
  if (effort === '') return { ok: false, reason: 'reasoningEffort 为空：保留请填非空档位，删除请省略该键（空字符串不得替代省略）' }
  return { ok: true, value: { provider, modelId, reasoningEffort: effort } }
}

function normalizeDenyInput(deny) {
  if (deny === undefined) return { ok: true, value: undefined }
  if (deny.length === 0) return { ok: false, reason: 'tools.deny 为空列表：保留请填至少一个工具名，删除请使用清除操作（省略与非空列表区别保留）' }
  const trimmed = deny.map((entry) => entry.trim())
  if (trimmed.some((entry) => entry === '')) return { ok: false, reason: 'tools.deny 含空白工具名：请删除该项或填非空文本' }
  return { ok: true, value: trimmed }
}

function hasRole(draft, key) {
  return Object.prototype.hasOwnProperty.call(draft.roles ?? {}, key)
}

function withRoleHistory(state) {
  const withHistory = pushHistory(state)
  return { withHistory, draft: clone(withHistory.draft) }
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** 新增角色。 */
export function addRoleEdit(state, key, fields) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const badKey = roleKeyError(key)
  if (badKey !== undefined) return { ok: false, reason: badKey }
  if (hasRole(state.draft, key)) return { ok: false, reason: `角色 "${key}" 已存在（重命名请使用改名操作）` }
  const persona = fields.persona.trim()
  if (persona === '') return { ok: false, reason: '角色 persona 为空：请填非空文本' }
  const model = normalizeModelInput(fields.model)
  if (!model.ok) return model
  if (fields.reuse !== undefined && !ROLE_REUSE_MODES.includes(fields.reuse)) {
    return { ok: false, reason: `角色 reuse 非法：仅支持 ${ROLE_REUSE_MODES.join('/')}（省略 = node）` }
  }
  const deny = normalizeDenyInput(fields.deny)
  if (!deny.ok) return deny
  const { withHistory, draft } = withRoleHistory(state)
  const role = { persona }
  if (model.value !== undefined) role.model = model.value
  if (fields.reuse !== undefined) role.reuse = fields.reuse
  if (deny.value !== undefined) role.tools = { deny: deny.value }
  draft.roles[key] = role
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 修改角色 persona。 */
export function setRolePersonaEdit(state, key, persona) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const role = (state.draft.roles ?? {})[key]
  if (role === undefined) return { ok: false, reason: `角色 "${key}" 不存在` }
  const trimmed = persona.trim()
  if (trimmed === '') return { ok: false, reason: '角色 persona 为空：请填非空文本（删除角色请使用删除操作）' }
  if (role.persona === trimmed) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  draft.roles[key].persona = trimmed
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 设置/清除角色模型。 */
export function setRoleModelEdit(state, key, model) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  if (!hasRole(state.draft, key)) return { ok: false, reason: `角色 "${key}" 不存在` }
  const normalized = normalizeModelInput(model)
  if (!normalized.ok) return normalized
  if (sameJson(state.draft.roles[key].model, normalized.value)) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  if (normalized.value === undefined) delete draft.roles[key].model
  else draft.roles[key].model = normalized.value
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 设置角色复用粒度。 */
export function setRoleReuseEdit(state, key, reuse) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  if (!hasRole(state.draft, key)) return { ok: false, reason: `角色 "${key}" 不存在` }
  if (!ROLE_REUSE_MODES.includes(reuse)) return { ok: false, reason: `角色 reuse 非法：仅支持 ${ROLE_REUSE_MODES.join('/')}` }
  const current = state.draft.roles[key].reuse ?? 'node'
  if (current === reuse) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  if (reuse === 'node') delete draft.roles[key].reuse
  else draft.roles[key].reuse = reuse
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 设置/清除角色 tools.deny。 */
export function setRoleDenyEdit(state, key, deny) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  if (!hasRole(state.draft, key)) return { ok: false, reason: `角色 "${key}" 不存在` }
  const normalized = normalizeDenyInput(deny)
  if (!normalized.ok) return normalized
  if (sameJson(state.draft.roles[key].tools?.deny, normalized.value)) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  if (normalized.value === undefined) delete draft.roles[key].tools
  else draft.roles[key].tools = { deny: normalized.value }
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 角色重命名：同步更新主/子流程内全部 Actor role 引用。 */
export function renameRoleEdit(state, oldKey, newKey) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  if (!hasRole(state.draft, oldKey)) return { ok: false, reason: `角色 "${oldKey}" 不存在` }
  if (oldKey === newKey) return { ok: true, noop: true, updated: 0, state }
  const badKey = roleKeyError(newKey)
  if (badKey !== undefined) return { ok: false, reason: badKey }
  if (hasRole(state.draft, newKey)) return { ok: false, reason: `角色 "${newKey}" 已存在` }
  const { withHistory, draft } = withRoleHistory(state)
  draft.roles[newKey] = draft.roles[oldKey]
  delete draft.roles[oldKey]
  let updated = 0
  const flows = [draft.workflow, ...Object.values(draft.childWorkflows ?? {})]
  for (const flow of flows) {
    for (const node of Object.values(flow.nodes ?? {})) {
      if (node.execution?.type === 'actor-task' && node.execution.role === oldKey) {
        node.execution.role = newKey
        updated++
      }
    }
  }
  return { ok: true, updated, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 删除角色（引用保留悬空，由保存前校验诊断，不静默换角）。 */
export function deleteRoleEdit(state, key) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  if (!hasRole(state.draft, key)) return { ok: false, reason: `角色 "${key}" 不存在` }
  const { withHistory, draft } = withRoleHistory(state)
  delete draft.roles[key]
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 某角色在主/子流程中的 Actor 引用位置（删除前提示、改名计数展示用）。 */
export function findRoleRefs(draft, key) {
  if (draft === null) return []
  const refs = []
  const flows = [{ id: null, def: draft.workflow }, ...Object.entries(draft.childWorkflows ?? {}).map(([id, def]) => ({ id, def }))]
  for (const flow of flows) {
    for (const nodeId of Object.keys(flow.def?.nodes ?? {})) {
      const node = flow.def.nodes[nodeId]
      if (node.execution?.type === 'actor-task' && node.execution.role === key) {
        refs.push({ flow: flow.id, node: nodeId })
      }
    }
  }
  return refs
}

/** 修改 Judge persona（Judge 无 reuse 配置）。 */
export function setJudgePersonaEdit(state, persona) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const trimmed = persona.trim()
  if (trimmed === '') return { ok: false, reason: 'judgeRole persona 为空：请填非空文本' }
  if (state.draft.judgeRole.persona === trimmed) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  draft.judgeRole.persona = trimmed
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 设置/清除 Judge 模型。 */
export function setJudgeModelEdit(state, model) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const normalized = normalizeModelInput(model)
  if (!normalized.ok) return normalized
  if (sameJson(state.draft.judgeRole.model, normalized.value)) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  if (normalized.value === undefined) delete draft.judgeRole.model
  else draft.judgeRole.model = normalized.value
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 设置/清除 Judge tools.deny。 */
export function setJudgeDenyEdit(state, deny) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const normalized = normalizeDenyInput(deny)
  if (!normalized.ok) return normalized
  if (sameJson(state.draft.judgeRole.tools?.deny, normalized.value)) return { ok: true, noop: true, state }
  const { withHistory, draft } = withRoleHistory(state)
  if (normalized.value === undefined) delete draft.judgeRole.tools
  else draft.judgeRole.tools = { deny: normalized.value }
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}
