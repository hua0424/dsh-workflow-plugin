/**
 * T1 编辑草稿：单一业务数据源（图为投影，坐标另存）。
 *
 * - 加载：严格解析 + 静态校验 + 归一化；直接自环拒绝进入图形编辑（只读诊断，
 *   不改 Runtime 自环合同）；布局自动关联，缺坐标网格补位，损坏警告回退。
 * - T1 只开放公共 actorCommonPersona（设置/清除）与节点位置；T2（#161）追加
 *   roles 增删改名、judgeRole（无 reuse）与模型三态编辑，其余字段原样保留。
 * - 校验/预览/保存一律作用于副本或只读序列化，不原地改写页面草稿
 *  （validateAndNormalize 会原地归一化输入，保存前验证必须先 structuredClone）。
 * - 有上限的页面内撤销/重做（不跨刷新，无持久化）；显式保存直接覆盖，
 *   不检查外部修改；布局与业务分别报告写入结果。
 */
import { stringify } from 'yaml'
import type { RoleDefinition, RoleModel, RoleReuseMode, Target, WorkflowConfig, WorkflowDef } from '../types.ts'
import { ID_PATTERN, LIMITS, nodeOnReturn, nodeResults, RESERVED_ROLE_KEYS, ROLE_REUSE_MODES, roleReuseMode, WorkflowError } from '../types.ts'
import { parseCatalogConfig } from '../catalog/parse.ts'
import { parseWorkflowConfig } from '../catalog/schema.ts'
import { BUILTIN_CHECKER_IDS, validateAndNormalize } from '../catalog/validate.ts'
import { emptyLayout, fillMissingPositions, getPosition, gridPosition, parseLayoutFile, serializeLayout, setPosition, type EditorLayout, type LayoutLoad, type NodePosition } from './layout.ts'

/** 撤销/重做历史上限（页面内，超出丢弃最旧）。 */
export const HISTORY_LIMIT = 50

/** 统一 YAML 输出头部：明确不保留注释与原排版（打开/保存说明的一部分）。 */
export const SERIALIZE_HEADER = '# 由工作流配置编辑器生成：统一格式输出，不保留原注释、字段顺序与排版。\n'

export interface EditorDraft {
  workflowId: string
  config: WorkflowConfig
  layout: EditorLayout
  dirtyBusiness: boolean
  dirtyLayout: boolean
}

interface DraftSnapshot {
  config: WorkflowConfig
  layout: EditorLayout
  dirtyBusiness: boolean
  dirtyLayout: boolean
}

export interface DraftSession {
  draft: EditorDraft
  past: DraftSnapshot[]
  future: DraftSnapshot[]
}

export type LoadDraftResult =
  | { ok: true; session: DraftSession; warnings: string[] }
  | { ok: false; problems: string[] }

/** 统一 YAML 序列化（只读预览与业务保存共用同一输出）。 */
export function serializeConfig(config: WorkflowConfig): string {
  return `${SERIALIZE_HEADER}${stringify(config)}`
}

/** 布局序列化（只写现存节点坐标，陈旧记录自然剪枝）。 */
export function serializeDraftLayout(session: DraftSession): string {
  return serializeLayout(session.draft.config, session.draft.layout)
}

/**
 * 编辑器限制：直接自环（某出口 target 指向自身节点）拒绝进入图形编辑。
 * 这是编辑器限制，不改变 Runtime/validator 的自环合同；多节点回路不受影响。
 */
export function findDirectSelfLoops(config: WorkflowConfig, workflowId: string): string[] {
  const problems: string[] = []
  const flows: Array<{ name: string; nodes: Record<string, import('../types.ts').NodeDef> }> = [
    { name: workflowId, nodes: config.workflow.nodes },
  ]
  for (const [childId, def] of Object.entries(config.childWorkflows ?? {})) {
    flows.push({ name: `${workflowId}/${childId}`, nodes: def.nodes })
  }
  for (const flow of flows) {
    for (const [nodeId, node] of Object.entries(flow.nodes)) {
      for (const [resultName, result] of Object.entries(nodeResults(node) ?? {})) {
        if ('node' in result.target && result.target.node === nodeId) {
          problems.push(`工作流 "${flow.name}" 节点 "${nodeId}" 结果 "${resultName}" 直接指向自身：编辑器拒绝进入图形编辑，请在外部修正后重新加载（不改变 Runtime 自环合同）`)
        }
      }
      for (const [returnName, target] of Object.entries(nodeOnReturn(node) ?? {})) {
        if ('node' in target && target.node === nodeId) {
          problems.push(`工作流 "${flow.name}" 节点 "${nodeId}" 返回映射 "${returnName}" 直接指向自身：编辑器拒绝进入图形编辑，请在外部修正后重新加载（不改变 Runtime 自环合同）`)
        }
      }
    }
  }
  return problems
}

/**
 * 加载一份草稿：workflowId + YAML 文本 + 可选布局文本。
 * 非法配置/未知字段/直接自环 → ok:false + 具体诊断（不静默修复）。
 */
export function loadDraft(workflowId: string, yamlText: string, layoutText?: string): LoadDraftResult {
  if (!ID_PATTERN.test(workflowId)) {
    return { ok: false, problems: [`workflow id "${workflowId}" 不是合法小写 [a-z][a-z0-9-]* 标识符`] }
  }
  let config: WorkflowConfig
  const warnings: string[] = []
  try {
    config = validateAndNormalize(parseCatalogConfig(yamlText), { workflowId, warnings })
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] }
  }
  const selfLoops = findDirectSelfLoops(config, workflowId)
  if (selfLoops.length > 0) return { ok: false, problems: selfLoops }
  let layout: EditorLayout
  if (layoutText === undefined) {
    layout = emptyLayout()
  } else {
    const loaded: LayoutLoad = parseLayoutFile(layoutText)
    layout = loaded.layout
    warnings.push(...loaded.warnings)
  }
  fillMissingPositions(config, layout)
  const session: DraftSession = {
    draft: { workflowId, config, layout, dirtyBusiness: false, dirtyLayout: false },
    past: [],
    future: [],
  }
  return { ok: true, session, warnings }
}

function snapshot(session: DraftSession): DraftSnapshot {
  return {
    config: structuredClone(session.draft.config),
    layout: structuredClone(session.draft.layout),
    dirtyBusiness: session.draft.dirtyBusiness,
    dirtyLayout: session.draft.dirtyLayout,
  }
}

/** 记录一次可撤销变更（调用方在修改前调用；清空 redo 栈）。 */
function pushHistory(session: DraftSession): void {
  session.past.push(snapshot(session))
  if (session.past.length > HISTORY_LIMIT) session.past.shift()
  session.future = []
}

/** 撤销：恢复快照的业务/布局与脏标记（纯布局撤销后保存只写布局）。 */
export function undo(session: DraftSession): boolean {
  const prev = session.past.pop()
  if (prev === undefined) return false
  session.future.push(snapshot(session))
  session.draft.config = prev.config
  session.draft.layout = prev.layout
  session.draft.dirtyBusiness = prev.dirtyBusiness
  session.draft.dirtyLayout = prev.dirtyLayout
  return true
}

/** 重做：恢复快照的业务/布局与脏标记。 */
export function redo(session: DraftSession): boolean {
  const next = session.future.pop()
  if (next === undefined) return false
  session.past.push(snapshot(session))
  session.draft.config = next.config
  session.draft.layout = next.layout
  session.draft.dirtyBusiness = next.dirtyBusiness
  session.draft.dirtyLayout = next.dirtyLayout
  return true
}

export type PersonaEditResult = { ok: true } | { ok: false; reason: string }

/**
 * 设置/清除公共 actorCommonPersona。
 * - undefined = 清除（键省略；与“非空值”区别保留）。
 * - 空白字符串 = 拒绝（不清不楚的省略必须走显式清除）。
 */
export function setActorCommonPersona(session: DraftSession, value: string | undefined): PersonaEditResult {
  if (value === undefined) {
    if (session.draft.config.actorCommonPersona === undefined) return { ok: true }
    pushHistory(session)
    delete session.draft.config.actorCommonPersona
    session.draft.dirtyBusiness = true
    return { ok: true }
  }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, reason: 'actorCommonPersona 为空：保留请填非空文本，删除请使用清除操作（省略与非空值区别保留）' }
  if (session.draft.config.actorCommonPersona === trimmed) return { ok: true }
  pushHistory(session)
  session.draft.config.actorCommonPersona = trimmed
  session.draft.dirtyBusiness = true
  return { ok: true }
}

export type PositionEditResult = { ok: true } | { ok: false; reason: string }

/**
 * 移动节点位置（本票不开放拓扑修改：流程与节点必须已存在）。
 * @param flowId undefined = 主流程，否则为子流程 id。
 */
export function setNodePosition(session: DraftSession, flowId: string | undefined, nodeId: string, pos: NodePosition): PositionEditResult {
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    return { ok: false, reason: `节点 "${nodeId}" 坐标必须是有限数` }
  }
  const flow = flowId === undefined ? session.draft.config.workflow : session.draft.config.childWorkflows?.[flowId]
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!Object.prototype.hasOwnProperty.call(flow.nodes, nodeId)) {
    return { ok: false, reason: `节点 "${nodeId}" 在${flowId === undefined ? '主流程' : `子流程 "${flowId}"`}中不存在（本票不开放新增节点）` }
  }
  const current = getPosition(session.draft.layout, flowId, nodeId)
  if (current !== undefined && current.x === pos.x && current.y === pos.y) return { ok: true }
  pushHistory(session)
  setPosition(session.draft.layout, flowId, nodeId, { x: pos.x, y: pos.y })
  session.draft.dirtyLayout = true
  return { ok: true }
}

export type ValidateDraftResult =
  | { ok: true; warnings: string[] }
  | { ok: false; problems: string[] }

/**
 * 保存前验证：对副本做现有校验（schema + validator，与加载/RPC 校验同链）
 * + 编辑器限制检查，不原地改写页面草稿。
 * 暂时非法的草稿允许继续编辑，但阻止业务保存。
 */
export function validateDraft(session: DraftSession): ValidateDraftResult {
  const warnings: string[] = []
  try {
    validateAndNormalize(parseWorkflowConfig(structuredClone(session.draft.config)), { workflowId: session.draft.workflowId, warnings })
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] }
  }
  const selfLoops = findDirectSelfLoops(session.draft.config, session.draft.workflowId)
  if (selfLoops.length > 0) return { ok: false, problems: selfLoops }
  return { ok: true, warnings }
}

/** 只读 YAML 预览（完整草稿；非法时 problems 非空并标记为草稿，由调用方展示）。 */
export function previewDraft(session: DraftSession): { yaml: string; problems: string[]; warnings: string[] } {
  const checked = validateDraft(session)
  return {
    yaml: serializeConfig(session.draft.config),
    problems: checked.ok ? [] : checked.problems,
    warnings: checked.ok ? checked.warnings : [],
  }
}

/** 保存计划：仅布局变化只写布局；业务变化保存配置和布局。不承诺双文件原子性。 */
export function savePlan(session: DraftSession): { writeYaml: boolean; writeLayout: boolean } {
  return {
    writeYaml: session.draft.dirtyBusiness,
    writeLayout: session.draft.dirtyBusiness || session.draft.dirtyLayout,
  }
}

/** 按实际写入结果清除脏标记（部分失败保留未成功部分的可重试状态）。 */
export function markSaved(session: DraftSession, written: { yaml: boolean; layout: boolean }): void {
  if (written.yaml) session.draft.dirtyBusiness = false
  if (written.layout) session.draft.dirtyLayout = false
}

/** 业务等价（重载后比较用；不要求 YAML 文本一致）。 */
export function businessEqual(a: WorkflowConfig, b: WorkflowConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ------------------------------------------------------------------ *
 * T2（#161）角色、Judge 与模型配置编辑。
 *
 * 全部作用于同一草稿、经 pushHistory 接入撤销/重做并置 dirtyBusiness。
 * setter 只做本地守卫（ID 形状、保留名、非空、枚举、成对性）；完整语义
 * （引用存在性、Judge 必需工具保护、复用/长度上限等）由保存前的
 * validateDraft（真实 validator）统一裁决。删除角色刻意保留悬空引用，
 * 由 validator 以“unknown role”明确诊断并阻止保存，不静默换角。
 * ------------------------------------------------------------------ */

export type RoleEditResult = { ok: true } | { ok: false; reason: string }

/** 模型表单输入：undefined = 整个 model 省略；effort 缺席 = 显式模型但未设档位。 */
export interface RoleModelInput {
  provider: string
  modelId: string
  reasoningEffort?: string
}

function checkRoleKey(key: string): string | undefined {
  if (!ID_PATTERN.test(key)) return `角色 id "${key}" 不是合法小写 [a-z][a-z0-9-]* 标识符`
  if ((RESERVED_ROLE_KEYS as readonly string[]).includes(key)) return `角色 id "${key}" 为保留名（manager/judge），不可配置`
  return undefined
}

/** 模型输入归一化（trim 后存；空串不得替代省略；effort 不可脱离 provider/modelId 单设）。 */
function normalizeModelInput(model: RoleModelInput | undefined): { ok: true; value?: RoleModel } | { ok: false; reason: string } {
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

/** tools.deny 输入归一化：undefined = 整键省略；数组须非空且逐项非空（trim 后存）。 */
function normalizeDenyInput(deny: string[] | undefined): { ok: true; value?: string[] } | { ok: false; reason: string } {
  if (deny === undefined) return { ok: true, value: undefined }
  if (deny.length === 0) return { ok: false, reason: 'tools.deny 为空列表：保留请填至少一个工具名，删除请使用清除操作（省略与非空列表区别保留）' }
  const trimmed = deny.map(entry => entry.trim())
  if (trimmed.some(entry => entry === '')) return { ok: false, reason: 'tools.deny 含空白工具名：请删除该项或填非空文本' }
  return { ok: true, value: trimmed }
}

function hasRole(config: WorkflowConfig, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config.roles, key)
}

export interface NewRoleFields {
  persona: string
  model?: RoleModelInput
  reuse?: RoleReuseMode
  deny?: string[]
}

/** 新增角色（id/persona/model/reuse/deny 一次建成；合法性不足由保存前校验裁决）。 */
export function addRole(session: DraftSession, key: string, fields: NewRoleFields): RoleEditResult {
  const badKey = checkRoleKey(key)
  if (badKey !== undefined) return { ok: false, reason: badKey }
  if (hasRole(session.draft.config, key)) return { ok: false, reason: `角色 "${key}" 已存在（重命名请使用改名操作）` }
  const persona = fields.persona.trim()
  if (persona === '') return { ok: false, reason: '角色 persona 为空：请填非空文本' }
  const model = normalizeModelInput(fields.model)
  if (!model.ok) return model
  if (fields.reuse !== undefined && !(ROLE_REUSE_MODES as readonly string[]).includes(fields.reuse)) {
    return { ok: false, reason: `角色 reuse 非法：仅支持 ${ROLE_REUSE_MODES.join('/')}（省略 = node）` }
  }
  const deny = normalizeDenyInput(fields.deny)
  if (!deny.ok) return deny
  pushHistory(session)
  const role: RoleDefinition = { persona }
  if (model.value !== undefined) role.model = model.value
  if (fields.reuse !== undefined) role.reuse = fields.reuse
  if (deny.value !== undefined) role.tools = { deny: deny.value }
  session.draft.config.roles[key] = role
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 修改角色 persona（空白拒绝；相同值为 noop）。 */
export function setRolePersona(session: DraftSession, key: string, persona: string): RoleEditResult {
  const role = session.draft.config.roles[key]
  if (role === undefined) return { ok: false, reason: `角色 "${key}" 不存在` }
  const trimmed = persona.trim()
  if (trimmed === '') return { ok: false, reason: '角色 persona 为空：请填非空文本（删除角色请使用删除操作）' }
  if (role.persona === trimmed) return { ok: true }
  pushHistory(session)
  role.persona = trimmed
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 设置/清除角色模型（undefined = 整键省略；三态区别保留）。 */
export function setRoleModel(session: DraftSession, key: string, model: RoleModelInput | undefined): RoleEditResult {
  const role = session.draft.config.roles[key]
  if (role === undefined) return { ok: false, reason: `角色 "${key}" 不存在` }
  const normalized = normalizeModelInput(model)
  if (!normalized.ok) return normalized
  if (JSON.stringify(role.model ?? null) === JSON.stringify(normalized.value ?? null)) return { ok: true }
  pushHistory(session)
  if (normalized.value === undefined) delete role.model
  else role.model = normalized.value
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 设置角色复用粒度（node 省略归一：缺省即 node，不写多余键）。 */
export function setRoleReuse(session: DraftSession, key: string, reuse: RoleReuseMode): RoleEditResult {
  const role = session.draft.config.roles[key]
  if (role === undefined) return { ok: false, reason: `角色 "${key}" 不存在` }
  if (!(ROLE_REUSE_MODES as readonly string[]).includes(reuse)) {
    return { ok: false, reason: `角色 reuse 非法：仅支持 ${ROLE_REUSE_MODES.join('/')}` }
  }
  if (roleReuseMode(role) === reuse) return { ok: true }
  pushHistory(session)
  if (reuse === 'node') delete role.reuse
  else role.reuse = reuse
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 设置/清除角色 tools.deny（undefined = 整键省略）。 */
export function setRoleDeny(session: DraftSession, key: string, deny: string[] | undefined): RoleEditResult {
  const role = session.draft.config.roles[key]
  if (role === undefined) return { ok: false, reason: `角色 "${key}" 不存在` }
  const normalized = normalizeDenyInput(deny)
  if (!normalized.ok) return normalized
  if (JSON.stringify(role.tools?.deny ?? null) === JSON.stringify(normalized.value ?? null)) return { ok: true }
  pushHistory(session)
  if (normalized.value === undefined) delete role.tools
  else role.tools = { deny: normalized.value }
  session.draft.dirtyBusiness = true
  return { ok: true }
}

export type RenameRoleResult = { ok: true; updated: number } | { ok: false; reason: string }

/** 角色重命名：同步更新主/子流程内全部 Actor role 引用，返回更新计数。 */
export function renameRole(session: DraftSession, oldKey: string, newKey: string): RenameRoleResult {
  const roles = session.draft.config.roles
  if (!hasRole(session.draft.config, oldKey)) return { ok: false, reason: `角色 "${oldKey}" 不存在` }
  if (oldKey === newKey) return { ok: true, updated: 0 }
  const badKey = checkRoleKey(newKey)
  if (badKey !== undefined) return { ok: false, reason: badKey }
  if (hasRole(session.draft.config, newKey)) return { ok: false, reason: `角色 "${newKey}" 已存在` }
  pushHistory(session)
  roles[newKey] = roles[oldKey]!
  delete roles[oldKey]
  let updated = 0
  const flows = [session.draft.config.workflow, ...Object.values(session.draft.config.childWorkflows ?? {})]
  for (const flow of flows) {
    for (const node of Object.values(flow.nodes)) {
      if (node.execution.type === 'actor-task' && node.execution.role === oldKey) {
        node.execution.role = newKey
        updated++
      }
    }
  }
  session.draft.dirtyBusiness = true
  return { ok: true, updated }
}

/**
 * 删除角色：引用刻意保留悬空（不静默换角），未修正时 validateDraft
 * 以“references unknown role”明确诊断并阻止保存。
 */
export function deleteRole(session: DraftSession, key: string): RoleEditResult {
  if (!hasRole(session.draft.config, key)) return { ok: false, reason: `角色 "${key}" 不存在` }
  pushHistory(session)
  delete session.draft.config.roles[key]
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 修改 Judge persona（无 reuse：Judge 不提供复用配置）。 */
export function setJudgePersona(session: DraftSession, persona: string): RoleEditResult {
  const trimmed = persona.trim()
  if (trimmed === '') return { ok: false, reason: 'judgeRole persona 为空：请填非空文本' }
  if (session.draft.config.judgeRole.persona === trimmed) return { ok: true }
  pushHistory(session)
  session.draft.config.judgeRole.persona = trimmed
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 设置/清除 Judge 模型（三态区别保留；必需工具保护由保存前校验裁决）。 */
export function setJudgeModel(session: DraftSession, model: RoleModelInput | undefined): RoleEditResult {
  const normalized = normalizeModelInput(model)
  if (!normalized.ok) return normalized
  const current = session.draft.config.judgeRole.model ?? null
  if (JSON.stringify(current) === JSON.stringify(normalized.value ?? null)) return { ok: true }
  pushHistory(session)
  if (normalized.value === undefined) delete session.draft.config.judgeRole.model
  else session.draft.config.judgeRole.model = normalized.value
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 设置/清除 Judge tools.deny（必需工具保护沿用现有服务端校验）。 */
export function setJudgeDeny(session: DraftSession, deny: string[] | undefined): RoleEditResult {
  const normalized = normalizeDenyInput(deny)
  if (!normalized.ok) return normalized
  const current = session.draft.config.judgeRole.tools?.deny ?? null
  if (JSON.stringify(current) === JSON.stringify(normalized.value ?? null)) return { ok: true }
  pushHistory(session)
  if (normalized.value === undefined) delete session.draft.config.judgeRole.tools
  else session.draft.config.judgeRole.tools = { deny: normalized.value }
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * T3（#162）新建流程与 Actor 结果路由编辑。
 *
 * 全部作用于同一草稿、经 pushHistory 接入撤销/重做并置 dirtyBusiness
 * （新增节点同时补布局坐标，一并置 dirtyLayout；布局键按主/子流程隔离，
 * 同名节点互不覆盖）。setter 只做本地守卫（ID 形状、存在性、同流程引用、
 * Manager 入口、直接自环拦截）；完整语义（可达性、返回覆盖、Child 映射等）
 * 由保存前的 validateDraft 统一裁决。删除/改名不静默修补：悬空引用保留，
 * 由 validator 明确诊断并阻止保存。Program/Child 节点不在本票编辑范围：
 * 相关 op 遇到非 Actor 节点明确拒绝，不触碰其字段（不丢失）。
 * ------------------------------------------------------------------ */

/** 新建文件名 → workflowId（工作流 ID 来自文件名，不写非法 YAML 字段）。 */
export function parseNewFilename(yamlName: string): { ok: true; workflowId: string } | { ok: false; reason: string } {
  if (!yamlName.endsWith('.yaml')) return { ok: false, reason: `新建文件名 "${yamlName}" 必须以小写 .yaml 结尾` }
  const stem = yamlName.slice(0, -'.yaml'.length)
  if (!ID_PATTERN.test(stem)) return { ok: false, reason: `新建文件名 "${yamlName}" 主体不是合法小写 [a-z][a-z0-9-]* 标识符` }
  return { ok: true, workflowId: stem }
}

/**
 * 最小合法 v3 起点：Manager 入口单节点 + 单返回。
 * 不依赖任何 roles（新建闭环无需等待 T2），Judge 取最小 persona。
 */
export function newDraftSession(workflowId: string): DraftSession {
  if (!ID_PATTERN.test(workflowId)) throw new WorkflowError(`workflow id "${workflowId}" 不是合法小写 [a-z][a-z0-9-]* 标识符`)
  const config: WorkflowConfig = {
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
  // 构造期即走真实校验链：最小起点自身必须合法（有问题是实现 bug，早爆）。
  validateAndNormalize(parseWorkflowConfig(structuredClone(config)), { workflowId, warnings: [] })
  const layout = emptyLayout()
  fillMissingPositions(config, layout)
  return {
    draft: { workflowId, config, layout, dirtyBusiness: false, dirtyLayout: false },
    past: [],
    future: [],
  }
}

/** 取某流程定义（undefined = 主流程）；子流程定义的新增/删除留给 T5。 */
function flowOf(session: DraftSession, flowId: string | undefined): WorkflowDef | undefined {
  if (flowId === undefined) return session.draft.config.workflow
  return session.draft.config.childWorkflows?.[flowId]
}

/** 流程引用键（返回改名时定位 Child 调用方用；主流程即 workflowId）。 */
function flowKeyOf(session: DraftSession, flowId: string | undefined): string {
  return flowId ?? session.draft.workflowId
}

/** Actor 角色引用守卫：manager 或已配置角色；judge 保留不可作 worker。 */
function checkActorRole(session: DraftSession, role: string): string | undefined {
  if (role === 'manager') return undefined
  if (role === 'judge') return '角色 "judge" 为保留 Judge 身份，不可作为 Actor worker'
  if (!ID_PATTERN.test(role)) return `角色 "${role}" 不是合法小写 [a-z][a-z0-9-]* 标识符`
  if (!hasRole(session.draft.config, role)) return `角色 "${role}" 不存在（已有角色可供选择，新建角色请用角色编辑）`
  return undefined
}

function checkInstruction(instruction: string): string | undefined {
  if (instruction.trim() === '') return 'Actor instruction 为空：请填非空文本'
  return undefined
}

function checkCheckerId(checkerId: string): string | undefined {
  if (!BUILTIN_CHECKER_IDS.has(checkerId)) {
    return `checker "${checkerId}" 不受支持（当前支持：${[...BUILTIN_CHECKER_IDS].join(', ')}）`
  }
  return undefined
}

/** 共同 criteria：undefined = 保持；null = 清除；string = 设置（trim 后存）。 */
function checkCommonCriteria(criteria: string | null): { ok: true; value?: string } | { ok: false; reason: string } {
  if (criteria === null) return { ok: true, value: undefined }
  const trimmed = criteria.trim()
  if (trimmed.length < LIMITS.criteriaMin || trimmed.length > LIMITS.criteriaMax) {
    return { ok: false, reason: `共同 criteria 须为 ${LIMITS.criteriaMin}..${LIMITS.criteriaMax} 字符（trim 后 ${trimmed.length}），清除请使用清除操作` }
  }
  return { ok: true, value: trimmed }
}

/** 结果 criteria 本地守卫（trim 后存；长度沿用领域上限）。 */
function checkResultCriteria(criteria: string): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = criteria.trim()
  if (trimmed.length < LIMITS.criteriaMin || trimmed.length > LIMITS.criteriaMax) {
    return { ok: false, reason: `结果 criteria 须为 ${LIMITS.criteriaMin}..${LIMITS.criteriaMax} 字符（trim 后 ${trimmed.length}）` }
  }
  return { ok: true, value: trimmed }
}

/**
 * 同流程目标守卫：形状恰好 { node } 或 { return } 之一，引用本流程已声明项；
 * 直接自环（target.node === selfId）按编辑器限制拒绝（多节点回路不受影响）。
 */
function checkFlowTarget(flow: WorkflowDef, target: unknown, selfId?: string): { ok: true; value: Target } | { ok: false; reason: string } {
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    return { ok: false, reason: '结果目标须为 { node: <本流程节点> } 或 { return: <本流程返回> }（恰好其一，不支持自由条件表达式）' }
  }
  const record = target as Record<string, unknown>
  const hasNode = Object.prototype.hasOwnProperty.call(record, 'node')
  const hasReturn = Object.prototype.hasOwnProperty.call(record, 'return')
  if (hasNode === hasReturn) {
    return { ok: false, reason: '结果目标须恰好为 { node } 或 { return } 之一（一个结果只有一个目标）' }
  }
  if (hasNode) {
    if (typeof record['node'] !== 'string' || !ID_PATTERN.test(record['node'])) {
      return { ok: false, reason: `目标节点 "${String(record['node'])}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
    }
    const nodeId = record['node'] as string
    if (selfId !== undefined && nodeId === selfId) {
      return { ok: false, reason: `结果目标 "${nodeId}" 直接指向自身：编辑器禁止新建直接自环（多节点回路不受影响，不改变 Runtime 合同）` }
    }
    if (!Object.prototype.hasOwnProperty.call(flow.nodes, nodeId)) {
      return { ok: false, reason: `目标节点 "${nodeId}" 在本流程中不存在（节点目标只引用同一流程）` }
    }
    return { ok: true, value: { node: nodeId } }
  }
  if (typeof record['return'] !== 'string' || !ID_PATTERN.test(record['return'])) {
    return { ok: false, reason: `目标返回 "${String(record['return'])}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  }
  const returnName = record['return'] as string
  if (!flow.returns.includes(returnName)) {
    return { ok: false, reason: `目标返回 "${returnName}" 未在本流程 returns 中声明（返回目标是视觉表示，不新增执行节点）` }
  }
  return { ok: true, value: { return: returnName } }
}

/** 本流程内指向某节点的引用位置（删除前提示用；含入口/结果目标/返回映射值）。 */
export interface NodeRef {
  node: string
  kind: 'start' | 'target' | 'onReturn'
  detail: string
}

export function findNodeRefs(session: DraftSession, flowId: string | undefined, nodeId: string): NodeRef[] {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return []
  const refs: NodeRef[] = []
  if (flow.startNode === nodeId) refs.push({ node: nodeId, kind: 'start', detail: '流程入口 startNode' })
  for (const [fromId, node] of Object.entries(flow.nodes)) {
    for (const [resultName, result] of Object.entries(nodeResults(node) ?? {})) {
      if ('node' in result.target && result.target.node === nodeId) {
        refs.push({ node: fromId, kind: 'target', detail: `结果 "${resultName}"` })
      }
    }
    for (const [returnName, target] of Object.entries(nodeOnReturn(node) ?? {})) {
      if ('node' in target && target.node === nodeId) {
        refs.push({ node: fromId, kind: 'onReturn', detail: `返回映射 "${returnName}"` })
      }
    }
  }
  return refs
}

/** 仅 Actor 节点可编辑（Program/Child 留给 T4/T5，字段不得丢失）。 */
function actorNodeOf(flow: WorkflowDef, nodeId: string): { ok: true; node: import('../types.ts').ActorTaskNode } | { ok: false; reason: string } {
  const node = flow.nodes[nodeId]
  if (node === undefined) return { ok: false, reason: `节点 "${nodeId}" 在本流程中不存在` }
  if (node.execution.type !== 'actor-task') {
    return { ok: false, reason: `节点 "${nodeId}" 为 ${node.execution.type} 类型，不在本票编辑范围（T4/T5；其字段保持不丢失）` }
  }
  return { ok: true, node: node as import('../types.ts').ActorTaskNode }
}

export interface NewActorNodeFields {
  role: string
  instruction: string
  checkerId?: string
  /** 共同 criteria：缺席 = 无共同条件；空串拒绝（用清除语义无意义，新建即无）。 */
  commonCriteria?: string
  resultName: string
  resultCriteria: string
  target: unknown
}

/** 新增 Actor 节点（简单网格摆放；可暂时不可达，保存前校验裁决）。 */
export function addActorNode(session: DraftSession, flowId: string | undefined, nodeId: string, fields: NewActorNodeFields): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在（子流程定义的新增留给 T5）` }
  if (!ID_PATTERN.test(nodeId)) return { ok: false, reason: `节点 id "${nodeId}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(flow.nodes, nodeId)) {
    return { ok: false, reason: `节点 "${nodeId}" 已存在（重命名请使用改名操作）` }
  }
  const badRole = checkActorRole(session, fields.role)
  if (badRole !== undefined) return { ok: false, reason: badRole }
  const badInstruction = checkInstruction(fields.instruction)
  if (badInstruction !== undefined) return { ok: false, reason: badInstruction }
  const checkerId = fields.checkerId ?? 'judge.claim-correct'
  const badChecker = checkCheckerId(checkerId)
  if (badChecker !== undefined) return { ok: false, reason: badChecker }
  let common: string | undefined
  if (fields.commonCriteria !== undefined) {
    const checked = checkCommonCriteria(fields.commonCriteria)
    if (!checked.ok) return checked
    common = checked.value
  }
  if (!ID_PATTERN.test(fields.resultName)) {
    return { ok: false, reason: `结果名 "${fields.resultName}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  }
  const criteria = checkResultCriteria(fields.resultCriteria)
  if (!criteria.ok) return criteria
  const target = checkFlowTarget(flow, fields.target, nodeId)
  if (!target.ok) return target
  pushHistory(session)
  flow.nodes[nodeId] = {
    execution: { type: 'actor-task', role: fields.role, instruction: fields.instruction.trim() },
    checker: { checkerId, config: common === undefined ? {} : { criteria: common } },
    results: { [fields.resultName]: { criteria: criteria.value, target: target.value } },
  }
  // ponytail：固定步长网格补位，不引入自动布局引擎。
  setPosition(session.draft.layout, flowId, nodeId, gridPosition(Object.keys(flow.nodes).length - 1))
  session.draft.dirtyBusiness = true
  session.draft.dirtyLayout = true
  return { ok: true }
}

export interface ActorFieldPatch {
  role?: string
  instruction?: string
  checkerId?: string
  /** 共同 criteria：缺席 = 保持；null = 清除；string = 设置。 */
  commonCriteria?: string | null
}

/** 修改 Actor 节点属性（主流程入口节点角色须保持 manager）。 */
export function setActorFields(session: DraftSession, flowId: string | undefined, nodeId: string, patch: ActorFieldPatch): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOf(flow, nodeId)
  if (!found.ok) return found
  const node = found.node
  if (patch.role !== undefined) {
    const badRole = checkActorRole(session, patch.role)
    if (badRole !== undefined) return { ok: false, reason: badRole }
    if (flowId === undefined && nodeId === flow.startNode && patch.role !== 'manager') {
      return { ok: false, reason: `主流程入口节点 "${nodeId}" 角色须为 manager（Manager Actor 限制）` }
    }
  }
  if (patch.instruction !== undefined) {
    const bad = checkInstruction(patch.instruction)
    if (bad !== undefined) return { ok: false, reason: bad }
  }
  if (patch.checkerId !== undefined) {
    const bad = checkCheckerId(patch.checkerId)
    if (bad !== undefined) return { ok: false, reason: bad }
  }
  let common: string | undefined | null
  if (patch.commonCriteria !== undefined) {
    if (patch.commonCriteria === null) {
      common = null
    } else {
      const checked = checkCommonCriteria(patch.commonCriteria)
      if (!checked.ok) return checked
      common = checked.value
    }
  }
  const nextRole = patch.role ?? node.execution.role
  const nextInstruction = patch.instruction === undefined ? node.execution.instruction : patch.instruction.trim()
  const nextChecker = patch.checkerId ?? node.checker.checkerId
  const currentCommon = (node.checker.config?.['criteria'] as string | undefined) ?? null
  const nextCommon = common === undefined ? currentCommon : common
  if (nextRole === node.execution.role
    && nextInstruction === node.execution.instruction
    && nextChecker === node.checker.checkerId
    && (nextCommon ?? null) === (currentCommon ?? null)) return { ok: true }
  pushHistory(session)
  node.execution.role = nextRole
  node.execution.instruction = nextInstruction
  node.checker.checkerId = nextChecker
  node.checker.config = nextCommon == null ? {} : { criteria: nextCommon }
  session.draft.dirtyBusiness = true
  return { ok: true }
}

export type NodeRenameResult = { ok: true; updated: number } | { ok: false; reason: string }

/**
 * 节点改名：同步入口、同流程全部结果目标/返回映射值与布局坐标。
 * 目标只引用同一流程，跨流程同名节点不受影响。
 */
export function renameNode(session: DraftSession, flowId: string | undefined, oldId: string, newId: string): NodeRenameResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!Object.prototype.hasOwnProperty.call(flow.nodes, oldId)) {
    return { ok: false, reason: `节点 "${oldId}" 在${flowId === undefined ? '主流程' : `子流程 "${flowId}"`}中不存在` }
  }
  if (oldId === newId) return { ok: true, updated: 0 }
  if (!ID_PATTERN.test(newId)) return { ok: false, reason: `节点 id "${newId}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(flow.nodes, newId)) {
    return { ok: false, reason: `节点 "${newId}" 已存在` }
  }
  pushHistory(session)
  flow.nodes[newId] = flow.nodes[oldId]!
  delete flow.nodes[oldId]
  if (flow.startNode === oldId) flow.startNode = newId
  let updated = 0
  for (const node of Object.values(flow.nodes)) {
    for (const result of Object.values(nodeResults(node) ?? {})) {
      if ('node' in result.target && result.target.node === oldId) {
        result.target = { node: newId }
        updated++
      }
    }
    const onReturn = nodeOnReturn(node)
    if (onReturn !== undefined) {
      for (const [returnName, target] of Object.entries(onReturn)) {
        if ('node' in target && target.node === oldId) {
          onReturn[returnName] = { node: newId }
          updated++
        }
      }
    }
  }
  const pos = getPosition(session.draft.layout, flowId, oldId)
  if (pos !== undefined) {
    setPosition(session.draft.layout, flowId, newId, pos)
    const table = flowId === undefined ? session.draft.layout.main : session.draft.layout.children[flowId]
    if (table !== undefined) delete table[oldId]
    session.draft.dirtyLayout = true
  }
  session.draft.dirtyBusiness = true
  return { ok: true, updated }
}

/**
 * 删除节点：引用刻意保留悬空（不静默选替代目标），未修正时 validateDraft
 * 明确诊断并阻止保存；布局坐标随节点移除（撤销可恢复）。
 */
export function deleteNode(session: DraftSession, flowId: string | undefined, nodeId: string): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!Object.prototype.hasOwnProperty.call(flow.nodes, nodeId)) {
    return { ok: false, reason: `节点 "${nodeId}" 在本流程中不存在` }
  }
  pushHistory(session)
  delete flow.nodes[nodeId]
  const table = flowId === undefined ? session.draft.layout.main : session.draft.layout.children[flowId]
  if (table !== undefined) delete table[nodeId]
  session.draft.dirtyBusiness = true
  session.draft.dirtyLayout = true
  return { ok: true }
}

/** 新增命名结果（Judge verdict 不是 Node Result：本 op 只作用于 Actor 节点结果表）。 */
export function addNodeResult(session: DraftSession, flowId: string | undefined, nodeId: string, name: string, criteria: string, target: unknown): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOf(flow, nodeId)
  if (!found.ok) return found
  if (!ID_PATTERN.test(name)) return { ok: false, reason: `结果名 "${name}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(found.node.results, name)) {
    return { ok: false, reason: `结果 "${name}" 已存在（重命名请使用改名操作）` }
  }
  const checkedCriteria = checkResultCriteria(criteria)
  if (!checkedCriteria.ok) return checkedCriteria
  const checkedTarget = checkFlowTarget(flow, target, nodeId)
  if (!checkedTarget.ok) return checkedTarget
  pushHistory(session)
  found.node.results[name] = { criteria: checkedCriteria.value, target: checkedTarget.value }
  session.draft.dirtyBusiness = true
  return { ok: true }
}

export interface ResultPatch {
  criteria?: string
  target?: unknown
}

/** 修改命名结果的 criteria 和/或 target（拖线即只带 target 的 patch）。 */
export function setNodeResult(session: DraftSession, flowId: string | undefined, nodeId: string, name: string, patch: ResultPatch): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOf(flow, nodeId)
  if (!found.ok) return found
  const result = found.node.results[name]
  if (result === undefined) return { ok: false, reason: `节点 "${nodeId}" 结果 "${name}" 不存在` }
  let nextCriteria = result.criteria
  if (patch.criteria !== undefined) {
    const checked = checkResultCriteria(patch.criteria)
    if (!checked.ok) return checked
    nextCriteria = checked.value
  }
  let nextTarget = result.target
  if (patch.target !== undefined) {
    const checked = checkFlowTarget(flow, patch.target, nodeId)
    if (!checked.ok) return checked
    nextTarget = checked.value
  }
  if (nextCriteria === result.criteria && JSON.stringify(nextTarget) === JSON.stringify(result.target)) return { ok: true }
  pushHistory(session)
  result.criteria = nextCriteria
  result.target = nextTarget
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 结果改名（结果名只在所属节点内解释，边身份随之同步，无跨节点引用）。 */
export function renameNodeResult(session: DraftSession, flowId: string | undefined, nodeId: string, oldName: string, newName: string): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOf(flow, nodeId)
  if (!found.ok) return found
  if (!Object.prototype.hasOwnProperty.call(found.node.results, oldName)) {
    return { ok: false, reason: `节点 "${nodeId}" 结果 "${oldName}" 不存在` }
  }
  if (oldName === newName) return { ok: true }
  if (!ID_PATTERN.test(newName)) return { ok: false, reason: `结果名 "${newName}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (Object.prototype.hasOwnProperty.call(found.node.results, newName)) {
    return { ok: false, reason: `节点 "${nodeId}" 结果 "${newName}" 已存在` }
  }
  pushHistory(session)
  found.node.results[newName] = found.node.results[oldName]!
  delete found.node.results[oldName]
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 删除命名结果（无跨节点引用；空结果表由保存前校验阻止）。 */
export function deleteNodeResult(session: DraftSession, flowId: string | undefined, nodeId: string, name: string): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const found = actorNodeOf(flow, nodeId)
  if (!found.ok) return found
  if (!Object.prototype.hasOwnProperty.call(found.node.results, name)) {
    return { ok: false, reason: `节点 "${nodeId}" 结果 "${name}" 不存在` }
  }
  pushHistory(session)
  delete found.node.results[name]
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 设置流程入口（主流程入口须为 manager Actor；可暂时不可达由校验裁决）。 */
export function setFlowStartNode(session: DraftSession, flowId: string | undefined, nodeId: string): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  const node = flow.nodes[nodeId]
  if (node === undefined) return { ok: false, reason: `节点 "${nodeId}" 在本流程中不存在` }
  if (flowId === undefined && !(node.execution.type === 'actor-task' && node.execution.role === 'manager')) {
    return { ok: false, reason: `主流程入口须为 role "manager" 的 Actor 节点（"${nodeId}" 为 ${node.execution.type === 'actor-task' ? `role "${node.execution.role}"` : node.execution.type}）` }
  }
  if (flow.startNode === nodeId) return { ok: true }
  pushHistory(session)
  flow.startNode = nodeId
  session.draft.dirtyBusiness = true
  return { ok: true }
}

/** 新增流程返回（声明即可；尚无路径指向时保存前校验提示补线）。 */
export function addFlowReturn(session: DraftSession, flowId: string | undefined, name: string): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!ID_PATTERN.test(name)) return { ok: false, reason: `返回名 "${name}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (flow.returns.includes(name)) return { ok: false, reason: `返回 "${name}" 已声明（重命名请使用改名操作）` }
  pushHistory(session)
  flow.returns.push(name)
  session.draft.dirtyBusiness = true
  return { ok: true }
}

export type FlowReturnRenameResult = { ok: true; updated: number } | { ok: false; reason: string }

/**
 * 流程返回改名：同步本流程内全部 { return } 目标、返回端口，
 * 以及已有 Child 调用方对该返回名的 onReturn 引用键（不留隐蔽失配）。
 */
export function renameFlowReturn(session: DraftSession, flowId: string | undefined, oldName: string, newName: string): FlowReturnRenameResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!flow.returns.includes(oldName)) return { ok: false, reason: `返回 "${oldName}" 未在本流程声明` }
  if (oldName === newName) return { ok: true, updated: 0 }
  if (!ID_PATTERN.test(newName)) return { ok: false, reason: `返回名 "${newName}" 不是合法小写 [a-z][a-z0-9-]* 标识符` }
  if (flow.returns.includes(newName)) return { ok: false, reason: `返回 "${newName}" 已声明` }
  pushHistory(session)
  flow.returns = flow.returns.map(name => name === oldName ? newName : name)
  let updated = 0
  for (const node of Object.values(flow.nodes)) {
    for (const result of Object.values(nodeResults(node) ?? {})) {
      if ('return' in result.target && result.target.return === oldName) {
        result.target = { return: newName }
        updated++
      }
    }
    const onReturn = nodeOnReturn(node)
    if (onReturn !== undefined) {
      for (const [key, target] of Object.entries(onReturn)) {
        if ('return' in target && target.return === oldName) {
          onReturn[key] = { return: newName }
          updated++
        }
      }
    }
  }
  // 已有 Child 调用方对该子流程返回名的 onReturn 引用键同步改名。
  const calleeKey = flowKeyOf(session, flowId)
  const allFlows = [session.draft.config.workflow, ...Object.values(session.draft.config.childWorkflows ?? {})]
  for (const callerFlow of allFlows) {
    for (const node of Object.values(callerFlow.nodes)) {
      if (node.execution.type !== 'child-workflow' || node.execution.workflowId !== calleeKey) continue
      const onReturn = nodeOnReturn(node)
      if (onReturn !== undefined && Object.prototype.hasOwnProperty.call(onReturn, oldName)) {
        onReturn[newName] = onReturn[oldName]!
        delete onReturn[oldName]
        updated++
      }
    }
  }
  session.draft.dirtyBusiness = true
  return { ok: true, updated }
}

/**
 * 删除流程返回：相关目标/映射键刻意保留悬空（不静默选替代），
 * 未修正时 validateDraft 明确诊断并阻止保存。
 */
export function deleteFlowReturn(session: DraftSession, flowId: string | undefined, name: string): RoleEditResult {
  const flow = flowOf(session, flowId)
  if (flow === undefined) return { ok: false, reason: `子流程 "${flowId}" 不存在` }
  if (!flow.returns.includes(name)) return { ok: false, reason: `返回 "${name}" 未在本流程声明` }
  pushHistory(session)
  flow.returns = flow.returns.filter(entry => entry !== name)
  session.draft.dirtyBusiness = true
  return { ok: true }
}
