/**
 * T1 编辑草稿：单一业务数据源（图为投影，坐标另存）。
 *
 * - 加载：严格解析 + 静态校验 + 归一化；直接自环拒绝进入图形编辑（只读诊断，
 *   不改 Runtime 自环合同）；布局自动关联，缺坐标网格补位，损坏警告回退。
 * - 本票只开放公共 actorCommonPersona（设置/清除）与节点位置；其余字段原样保留。
 * - 校验/预览/保存一律作用于副本或只读序列化，不原地改写页面草稿
 *  （validateAndNormalize 会原地归一化输入，保存前验证必须先 structuredClone）。
 * - 有上限的页面内撤销/重做（不跨刷新，无持久化）；显式保存直接覆盖，
 *   不检查外部修改；布局与业务分别报告写入结果。
 */
import { stringify } from 'yaml'
import type { WorkflowConfig } from '../types.ts'
import { ID_PATTERN, nodeOnReturn, nodeResults } from '../types.ts'
import { parseCatalogConfig } from '../catalog/parse.ts'
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
 * 保存前验证：对副本做现有校验 + 编辑器限制检查（不原地改写页面草稿）。
 * 暂时非法的草稿允许继续编辑，但阻止业务保存。
 */
export function validateDraft(session: DraftSession): ValidateDraftResult {
  const warnings: string[] = []
  try {
    validateAndNormalize(structuredClone(session.draft.config), { workflowId: session.draft.workflowId, warnings })
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
