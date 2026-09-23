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
import type { RoleDefinition, RoleModel, RoleReuseMode, WorkflowConfig } from '../types.ts'
import { ID_PATTERN, nodeOnReturn, nodeResults, RESERVED_ROLE_KEYS, ROLE_REUSE_MODES, roleReuseMode } from '../types.ts'
import { parseCatalogConfig } from '../catalog/parse.ts'
import { parseWorkflowConfig } from '../catalog/schema.ts'
import { validateAndNormalize } from '../catalog/validate.ts'
import { emptyLayout, fillMissingPositions, getPosition, parseLayoutFile, serializeLayout, setPosition, type EditorLayout, type LayoutLoad, type NodePosition } from './layout.ts'

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
