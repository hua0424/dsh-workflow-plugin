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

/* ------------------------------------------------------------------ *
 * T3（#162）新建流程与 Actor 结果路由编辑镜像：与服务端 `src/editor/draft.ts`
 * 同语义（本地守卫一致，完整语义走服务端 validate RPC）。节点新增同时补
 * positions 坐标并置 dirtyLayout；布局键按主/子流程隔离。删除/改名不静默
 * 修补，悬空引用由保存前校验诊断。Program/Child 节点拒绝编辑，字段不丢失。
 * ------------------------------------------------------------------ */

/** 当前支持的 checker（与服务端 BUILTIN_CHECKER_IDS 同源；对等测试钉住）。 */
export const SUPPORTED_CHECKER_IDS = ['judge.claim-correct']

/** 新建文件名 → workflowId（工作流 ID 来自文件名）。 */
export function parseNewFilenameEdit(yamlName) {
  if (typeof yamlName !== 'string' || !yamlName.endsWith('.yaml')) {
    return { ok: false, reason: `新建文件名 "${yamlName}" 必须以小写 .yaml 结尾` }
  }
  const stem = yamlName.slice(0, -'.yaml'.length)
  if (!ID_PATTERN.test(stem)) {
    return { ok: false, reason: `新建文件名 "${yamlName}" 主体不是合法小写 [a-z][a-z0-9-]* 标识符` }
  }
  return { ok: true, workflowId: stem }
}

/** 最小合法 v3 起点（Manager 入口单节点 + 单返回，不依赖任何 roles）。 */
export function minimalConfigOf() {
  return {
    schemaVersion: 'agent-workflow/v3',
    roles: {},
    judgeRole: { persona: '确认 Actor 结果是否可信；只做 ACCEPT/REJECT/NEED_CONTEXT 判定，不选择业务结果。' },
    workflow: {
      startNode: 'main',
      returns: ['done'],
      nodes: {
        main: {
          execution: { type: 'actor-task', role: 'manager', instruction: '统筹本工作流：拆解任务并组织后续节点。' },
          checker: { checkerId: 'judge.claim-correct', config: {} },
          results: {
            done: { criteria: '工作流目标已达成。', target: { return: 'done' } },
          },
        },
      },
    },
  }
}

function flowDefOf(draft, flowId) {
  if (draft === null) return undefined
  if (flowId === null) return draft.workflow
  return (draft.childWorkflows ?? {})[flowId]
}

function actorRoleError(draft, role) {
  if (role === 'manager') return undefined
  if (role === 'judge') return '角色 "judge" 为保留 Judge 身份，不可作为 Actor worker'
  if (!ID_PATTERN.test(role)) return `角色 "${role}" 不是合法小写 [a-z][a-z0-9-]* 标识符`
  if (!Object.prototype.hasOwnProperty.call(draft.roles ?? {}, role)) {
    return `角色 "${role}" 不存在（已有角色可供选择，新建角色请用角色编辑）`
  }
  return undefined
}

function checkerError(checkerId) {
  if (!SUPPORTED_CHECKER_IDS.includes(checkerId)) {
    return `checker "${checkerId}" 不受支持（当前支持：${SUPPORTED_CHECKER_IDS.join(', ')}）`
  }
  return undefined
}

function criteriaError(criteria) {
  const trimmed = criteria.trim()
  // 长度上限沿用领域 8000（与服务端 LIMITS.criteriaMax 同源；对等测试钉住行为）。
  if (trimmed === '' || trimmed.length > 8000) {
    return `结果 criteria 须为 1..8000 字符（trim 后 ${trimmed.length}）`
  }
  return undefined
}

/** 同流程目标守卫（恰好 { node } 或 { return } 之一；直接自环拒绝）。 */
function flowTargetError(flowDef, target, selfId) {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return { error: '结果目标须为 { node: <本流程节点> } 或 { return: <本流程返回> }（恰好其一，不支持自由条件表达式）' }
  }
  const hasNode = Object.prototype.hasOwnProperty.call(target, 'node')
  const hasReturn = Object.prototype.hasOwnProperty.call(target, 'return')
  if (hasNode === hasReturn) {
    return { error: '结果目标须恰好为 { node } 或 { return } 之一（一个结果只有一个目标）' }
  }
  if (hasNode) {
    if (typeof target.node !== 'string' || !ID_PATTERN.test(target.node)) {
      return { error: `目标节点 "${String(target.node)}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
    }
    if (target.node === selfId) {
      return { error: `结果目标 "${target.node}" 直接指向自身：编辑器禁止新建直接自环（多节点回路不受影响）` }
    }
    if (!Object.prototype.hasOwnProperty.call(flowDef.nodes ?? {}, target.node)) {
      return { error: `目标节点 "${target.node}" 在本流程中不存在（节点目标只引用同一流程）` }
    }
    return { value: { node: target.node } }
  }
  if (typeof target.return !== 'string' || !ID_PATTERN.test(target.return)) {
    return { error: `目标返回 "${String(target.return)}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  }
  if (!(flowDef.returns ?? []).includes(target.return)) {
    return { error: `目标返回 "${target.return}" 未在本流程 returns 中声明（返回目标是视觉表示，不新增执行节点）` }
  }
  return { value: { return: target.return } }
}

function actorNodeOfEdit(flowDef, nodeId) {
  const node = (flowDef.nodes ?? {})[nodeId]
  if (node === undefined) return { error: `节点 "${nodeId}" 在本流程中不存在` }
  if (node.execution?.type !== 'actor-task') {
    return { error: `节点 "${nodeId}" 为 ${node.execution?.type} 类型，不在本票编辑范围（T4/T5；其字段保持不丢失）` }
  }
  return { node }
}

function gridPositionOf(index) {
  return { x: (index % 4) * 220 + 40, y: Math.floor(index / 4) * 140 + 40 }
}

function withDraftHistory(state) {
  const withHistory = pushHistory(state)
  return { withHistory, draft: clone(withHistory.draft), positions: clone(withHistory.positions) }
}

/** 新建 Actor 节点（含初始命名结果；简单网格摆放）。 */
export function addActorNodeEdit(state, flowId, nodeId, fields) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在（子流程定义的新增留给 T5）` }
  if (!ID_PATTERN.test(nodeId)) return { ok: false, reason: `节点 id "${nodeId}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(flowDef.nodes ?? {}, nodeId)) {
    return { ok: false, reason: `节点 "${nodeId}" 已存在（重命名请使用改名操作）` }
  }
  const badRole = actorRoleError(state.draft, fields.role)
  if (badRole !== undefined) return { ok: false, reason: badRole }
  if (typeof fields.instruction !== 'string' || fields.instruction.trim() === '') {
    return { ok: false, reason: 'Actor instruction 为空：请填非空文本' }
  }
  const checkerId = fields.checkerId ?? 'judge.claim-correct'
  const badChecker = checkerError(checkerId)
  if (badChecker !== undefined) return { ok: false, reason: badChecker }
  let common
  if (fields.commonCriteria !== undefined) {
    const bad = criteriaError(fields.commonCriteria)
    if (bad !== undefined) return { ok: false, reason: bad }
    common = fields.commonCriteria.trim()
  }
  if (!ID_PATTERN.test(fields.resultName)) {
    return { ok: false, reason: `结果名 "${fields.resultName}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  }
  const badCriteria = criteriaError(fields.resultCriteria)
  if (badCriteria !== undefined) return { ok: false, reason: badCriteria }
  const target = flowTargetError(flowDef, fields.target, nodeId)
  if (target.error !== undefined) return { ok: false, reason: target.error }
  const { withHistory, draft, positions } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.nodes[nodeId] = {
    execution: { type: 'actor-task', role: fields.role, instruction: fields.instruction.trim() },
    checker: { checkerId, config: common === undefined ? {} : { criteria: common } },
    results: { [fields.resultName]: { criteria: fields.resultCriteria.trim(), target: target.value } },
  }
  const table = flowId === null ? positions.main : (positions.children[flowId] ??= {})
  table[nodeId] = gridPositionOf(Object.keys(flow.nodes).length - 1)
  return { ok: true, state: { ...withHistory, draft, positions, dirtyBusiness: true, dirtyLayout: true, saveResult: null } }
}

/** 修改 Actor 节点属性（commonCriteria：缺席=保持；null=清除；string=设置）。 */
export function setActorFieldsEdit(state, flowId, nodeId, patch) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOfEdit(flowDef, nodeId)
  if (found.error !== undefined) return { ok: false, reason: found.error }
  const node = found.node
  if (patch.role !== undefined) {
    const bad = actorRoleError(state.draft, patch.role)
    if (bad !== undefined) return { ok: false, reason: bad }
    if (flowId === null && nodeId === flowDef.startNode && patch.role !== 'manager') {
      return { ok: false, reason: `主流程入口节点 "${nodeId}" 角色须为 manager（Manager Actor 限制）` }
    }
  }
  if (patch.instruction !== undefined && (typeof patch.instruction !== 'string' || patch.instruction.trim() === '')) {
    return { ok: false, reason: 'Actor instruction 为空：请填非空文本' }
  }
  if (patch.checkerId !== undefined) {
    const bad = checkerError(patch.checkerId)
    if (bad !== undefined) return { ok: false, reason: bad }
  }
  let common = 'keep'
  if (patch.commonCriteria !== undefined) {
    if (patch.commonCriteria === null) {
      common = null
    } else {
      const bad = criteriaError(patch.commonCriteria)
      if (bad !== undefined) return { ok: false, reason: bad }
      common = patch.commonCriteria.trim()
    }
  }
  const currentCommon = node.checker?.config?.criteria ?? null
  const nextCommon = common === 'keep' ? currentCommon : common
  if ((patch.role ?? node.execution.role) === node.execution.role
    && (patch.instruction === undefined || patch.instruction.trim() === node.execution.instruction)
    && (patch.checkerId ?? node.checker.checkerId) === node.checker.checkerId
    && (nextCommon ?? null) === (currentCommon ?? null)) {
    return { ok: true, noop: true, state }
  }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  const target = flow.nodes[nodeId]
  if (patch.role !== undefined) target.execution.role = patch.role
  if (patch.instruction !== undefined) target.execution.instruction = patch.instruction.trim()
  if (patch.checkerId !== undefined) target.checker.checkerId = patch.checkerId
  if (common !== 'keep') target.checker.config = nextCommon == null ? {} : { criteria: nextCommon }
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 节点改名：同步入口、同流程目标与布局坐标。 */
export function renameNodeEdit(state, flowId, oldId, newId) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!Object.prototype.hasOwnProperty.call(flowDef.nodes ?? {}, oldId)) {
    return { ok: false, reason: `节点 "${oldId}" 在本流程中不存在` }
  }
  if (oldId === newId) return { ok: true, noop: true, updated: 0, state }
  if (!ID_PATTERN.test(newId)) return { ok: false, reason: `节点 id "${newId}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(flowDef.nodes ?? {}, newId)) {
    return { ok: false, reason: `节点 "${newId}" 已存在` }
  }
  const { withHistory, draft, positions } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.nodes[newId] = flow.nodes[oldId]
  delete flow.nodes[oldId]
  if (flow.startNode === oldId) flow.startNode = newId
  let updated = 0
  for (const node of Object.values(flow.nodes ?? {})) {
    for (const result of Object.values(node.results ?? {})) {
      if (result?.target?.node === oldId) {
        result.target = { node: newId }
        updated++
      }
    }
    for (const [key, target] of Object.entries(node.onReturn ?? {})) {
      if (target?.node === oldId) {
        node.onReturn[key] = { node: newId }
        updated++
      }
    }
  }
  const table = flowId === null ? positions.main : positions.children[flowId]
  if (table !== undefined && table[oldId] !== undefined) {
    table[newId] = table[oldId]
    delete table[oldId]
  }
  const dirtyLayout = table !== undefined && table[newId] !== undefined
  return {
    ok: true, updated,
    state: { ...withHistory, draft, positions, dirtyBusiness: true, dirtyLayout: dirtyLayout || withHistory.dirtyLayout, saveResult: null },
  }
}

/** 删除节点（引用保留悬空，由保存前校验诊断；坐标随节点移除）。 */
export function deleteNodeEdit(state, flowId, nodeId) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!Object.prototype.hasOwnProperty.call(flowDef.nodes ?? {}, nodeId)) {
    return { ok: false, reason: `节点 "${nodeId}" 在本流程中不存在` }
  }
  const { withHistory, draft, positions } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  delete flow.nodes[nodeId]
  const table = flowId === null ? positions.main : positions.children[flowId]
  if (table !== undefined) delete table[nodeId]
  return { ok: true, state: { ...withHistory, draft, positions, dirtyBusiness: true, dirtyLayout: true, saveResult: null } }
}

/** 某节点在本流程内的引用位置（删除前提示用）。 */
export function findNodeRefsEdit(draft, flowId, nodeId) {
  const flowDef = flowDefOf(draft, flowId)
  if (flowDef === undefined) return []
  const refs = []
  if (flowDef.startNode === nodeId) refs.push({ node: nodeId, kind: 'start', detail: '流程入口 startNode' })
  for (const [fromId, node] of Object.entries(flowDef.nodes ?? {})) {
    for (const [resultName, result] of Object.entries(node.results ?? {})) {
      if (result?.target?.node === nodeId) refs.push({ node: fromId, kind: 'target', detail: `结果 "${resultName}"` })
    }
    for (const [returnName, target] of Object.entries(node.onReturn ?? {})) {
      if (target?.node === nodeId) refs.push({ node: fromId, kind: 'onReturn', detail: `返回映射 "${returnName}"` })
    }
  }
  return refs
}

/** 新增命名结果。 */
export function addNodeResultEdit(state, flowId, nodeId, name, criteria, target) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOfEdit(flowDef, nodeId)
  if (found.error !== undefined) return { ok: false, reason: found.error }
  if (!ID_PATTERN.test(name)) return { ok: false, reason: `结果名 "${name}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(found.node.results ?? {}, name)) {
    return { ok: false, reason: `结果 "${name}" 已存在（重命名请使用改名操作）` }
  }
  const badCriteria = criteriaError(criteria)
  if (badCriteria !== undefined) return { ok: false, reason: badCriteria }
  const checked = flowTargetError(flowDef, target, nodeId)
  if (checked.error !== undefined) return { ok: false, reason: checked.error }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.nodes[nodeId].results[name] = { criteria: criteria.trim(), target: checked.value }
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 修改命名结果的 criteria 和/或 target（拖线即只带 target 的 patch）。 */
export function setNodeResultEdit(state, flowId, nodeId, name, patch) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOfEdit(flowDef, nodeId)
  if (found.error !== undefined) return { ok: false, reason: found.error }
  const result = (found.node.results ?? {})[name]
  if (result === undefined) return { ok: false, reason: `节点 "${nodeId}" 结果 "${name}" 不存在` }
  let nextCriteria = result.criteria
  if (patch.criteria !== undefined) {
    const bad = criteriaError(patch.criteria)
    if (bad !== undefined) return { ok: false, reason: bad }
    nextCriteria = patch.criteria.trim()
  }
  let nextTarget = result.target
  if (patch.target !== undefined) {
    const checked = flowTargetError(flowDef, patch.target, nodeId)
    if (checked.error !== undefined) return { ok: false, reason: checked.error }
    nextTarget = checked.value
  }
  if (nextCriteria === result.criteria && JSON.stringify(nextTarget) === JSON.stringify(result.target)) {
    return { ok: true, noop: true, state }
  }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.nodes[nodeId].results[name] = { criteria: nextCriteria, target: nextTarget }
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 结果改名（结果名只在所属节点内解释）。 */
export function renameNodeResultEdit(state, flowId, nodeId, oldName, newName) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOfEdit(flowDef, nodeId)
  if (found.error !== undefined) return { ok: false, reason: found.error }
  if (!Object.prototype.hasOwnProperty.call(found.node.results ?? {}, oldName)) {
    return { ok: false, reason: `节点 "${nodeId}" 结果 "${oldName}" 不存在` }
  }
  if (oldName === newName) return { ok: true, noop: true, state }
  if (!ID_PATTERN.test(newName)) return { ok: false, reason: `结果名 "${newName}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(found.node.results ?? {}, newName)) {
    return { ok: false, reason: `节点 "${nodeId}" 结果 "${newName}" 已存在` }
  }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.nodes[nodeId].results[newName] = flow.nodes[nodeId].results[oldName]
  delete flow.nodes[nodeId].results[oldName]
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 删除命名结果。 */
export function deleteNodeResultEdit(state, flowId, nodeId, name) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOfEdit(flowDef, nodeId)
  if (found.error !== undefined) return { ok: false, reason: found.error }
  if (!Object.prototype.hasOwnProperty.call(found.node.results ?? {}, name)) {
    return { ok: false, reason: `节点 "${nodeId}" 结果 "${name}" 不存在` }
  }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  delete flow.nodes[nodeId].results[name]
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 设置流程入口（主流程入口须为 manager Actor）。 */
export function setFlowStartNodeEdit(state, flowId, nodeId) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const node = (flowDef.nodes ?? {})[nodeId]
  if (node === undefined) return { ok: false, reason: `节点 "${nodeId}" 在本流程中不存在` }
  if (flowId === null && !(node.execution?.type === 'actor-task' && node.execution?.role === 'manager')) {
    return { ok: false, reason: `主流程入口须为 role "manager" 的 Actor 节点（"${nodeId}" 为 ${node.execution?.type === 'actor-task' ? `role "${node.execution?.role}"` : node.execution?.type}）` }
  }
  if (flowDef.startNode === nodeId) return { ok: true, noop: true, state }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.startNode = nodeId
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 新增流程返回。 */
export function addFlowReturnEdit(state, flowId, name) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!ID_PATTERN.test(name)) return { ok: false, reason: `返回名 "${name}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if ((flowDef.returns ?? []).includes(name)) return { ok: false, reason: `返回 "${name}" 已声明（重命名请使用改名操作）` }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.returns.push(name)
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 流程返回改名：同步本流程 { return } 目标与 Child 调用方 onReturn 键。 */
export function renameFlowReturnEdit(state, flowId, oldName, newName) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!(flowDef.returns ?? []).includes(oldName)) return { ok: false, reason: `返回 "${oldName}" 未在本流程声明` }
  if (oldName === newName) return { ok: true, noop: true, updated: 0, state }
  if (!ID_PATTERN.test(newName)) return { ok: false, reason: `返回名 "${newName}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if ((flowDef.returns ?? []).includes(newName)) return { ok: false, reason: `返回 "${newName}" 已声明` }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.returns = flow.returns.map((name) => (name === oldName ? newName : name))
  let updated = 0
  for (const node of Object.values(flow.nodes ?? {})) {
    for (const result of Object.values(node.results ?? {})) {
      if (result?.target?.return === oldName) {
        result.target = { return: newName }
        updated++
      }
    }
    for (const [key, target] of Object.entries(node.onReturn ?? {})) {
      if (target?.return === oldName) {
        node.onReturn[key] = { return: newName }
        updated++
      }
    }
  }
  const calleeKey = flowId === null ? state.workflowId : flowId
  for (const callerFlow of [draft.workflow, ...Object.values(draft.childWorkflows ?? {})]) {
    for (const node of Object.values(callerFlow.nodes ?? {})) {
      if (node.execution?.type !== 'child-workflow' || node.execution?.workflowId !== calleeKey) continue
      if (Object.prototype.hasOwnProperty.call(node.onReturn ?? {}, oldName)) {
        node.onReturn[newName] = node.onReturn[oldName]
        delete node.onReturn[oldName]
        updated++
      }
    }
  }
  return { ok: true, updated, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}

/** 删除流程返回（相关目标/映射键保留悬空，由保存前校验诊断）。 */
export function deleteFlowReturnEdit(state, flowId, name) {
  if (state.draft === null) return { ok: false, reason: '尚未加载配置' }
  const flowDef = flowDefOf(state.draft, flowId)
  if (flowDef === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!(flowDef.returns ?? []).includes(name)) return { ok: false, reason: `返回 "${name}" 未在本流程声明` }
  const { withHistory, draft } = withDraftHistory(state)
  const flow = flowId === null ? draft.workflow : draft.childWorkflows[flowId]
  flow.returns = flow.returns.filter((entry) => entry !== name)
  return { ok: true, state: { ...withHistory, draft, dirtyBusiness: true, saveResult: null } }
}
