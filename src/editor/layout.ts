/**
 * 编辑器布局文件：`<name>.yaml` 自动关联同目录 `<name>.layout.json`。
 *
 * 只记录坐标，不复制业务数据：
 * `{ version: 1, main: { <nodeId>: {x,y} }, children: { <childId>: { <nodeId>: {x,y} } } }`
 * 主流程与子流程按身份隔离，同名节点互不覆盖。
 */
import type { WorkflowConfig } from '../types.ts'

/** 画布坐标（像素）。 */
export interface NodePosition {
  x: number
  y: number
}

/** 布局文件版本号（单源；不匹配即视为损坏回退）。 */
export const LAYOUT_VERSION = 1 as const

/** 编辑器布局：主流程坐标 + 按子流程 id 隔离的坐标表。 */
export interface EditorLayout {
  version: typeof LAYOUT_VERSION
  main: Record<string, NodePosition>
  children: Record<string, Record<string, NodePosition>>
}

/** 空布局（缺文件时使用，随后按简单网格补位）。 */
export function emptyLayout(): EditorLayout {
  return { version: LAYOUT_VERSION, main: {}, children: {} }
}

/**
 * YAML 文件名 → 自动关联的布局文件名。
 * 只有小写 `.yaml` 候选参与（与 catalog 文件名规则一致）；其他返回 undefined。
 */
export function layoutFilenameFor(yamlName: string): string | undefined {
  if (!yamlName.endsWith('.yaml')) return undefined
  const stem = yamlName.slice(0, -'.yaml'.length)
  if (stem.length === 0) return undefined
  return `${stem}.layout.json`
}

/** 有限数坐标才合法；NaN/Infinity/非数一律丢弃。 */
export function isValidPosition(value: unknown): value is NodePosition {
  if (typeof value !== 'object' || value === null) return false
  const { x, y } = value as Record<string, unknown>
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
}

/** 布局加载结果：损坏时警告并回退空布局（不阻止合法 YAML 编辑）。 */
export interface LayoutLoad {
  layout: EditorLayout
  /** 非空 = 布局损坏/部分丢弃的警告；缺文件时为空（静默简单摆放）。 */
  warnings: string[]
  corrupted: boolean
}

/**
 * 解析布局文件文本。JSON 解析失败、顶层非对象、版本号不匹配 → 整体损坏回退；
 * 单个坐标非法 → 丢弃该条并警告；多余记录（未知流程/节点）在读取时忽略。
 * 权限/IO 错误由调用方如实上报，不得伪装成“文件缺失”（本函数只处理文本）。
 */
export function parseLayoutFile(text: string): LayoutLoad {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { layout: emptyLayout(), warnings: ['布局文件损坏（不是合法 JSON），已回退简单摆放'], corrupted: true }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { layout: emptyLayout(), warnings: ['布局文件损坏（顶层不是对象），已回退简单摆放'], corrupted: true }
  }
  const record = raw as Record<string, unknown>
  if (record['version'] !== LAYOUT_VERSION) {
    return { layout: emptyLayout(), warnings: ['布局文件版本不受支持，已回退简单摆放'], corrupted: true }
  }
  const warnings: string[] = []
  const layout = emptyLayout()
  const main = record['main']
  if (main !== undefined) {
    if (typeof main !== 'object' || main === null || Array.isArray(main)) {
      warnings.push('布局主流程坐标不是对象，已忽略')
    } else {
      for (const [nodeId, pos] of Object.entries(main as Record<string, unknown>)) {
        if (isValidPosition(pos)) layout.main[nodeId] = { x: pos.x, y: pos.y }
        else warnings.push(`布局主流程节点 "${nodeId}" 坐标非法，已忽略`)
      }
    }
  }
  const children = record['children']
  if (children !== undefined) {
    if (typeof children !== 'object' || children === null || Array.isArray(children)) {
      warnings.push('布局子流程坐标不是对象，已忽略')
    } else {
      for (const [childId, table] of Object.entries(children as Record<string, unknown>)) {
        if (typeof table !== 'object' || table === null || Array.isArray(table)) {
          warnings.push(`布局子流程 "${childId}" 坐标不是对象，已忽略`)
          continue
        }
        const flow: Record<string, NodePosition> = {}
        for (const [nodeId, pos] of Object.entries(table as Record<string, unknown>)) {
          if (isValidPosition(pos)) flow[nodeId] = { x: pos.x, y: pos.y }
          else warnings.push(`布局子流程 "${childId}" 节点 "${nodeId}" 坐标非法，已忽略`)
        }
        layout.children[childId] = flow
      }
    }
  }
  return { layout, warnings, corrupted: warnings.length > 0 }
}

/** 简单网格补位坐标（ponytail：固定步长网格，不做拓扑自动布局；节点数大时画布滚动查看）。 */
export function gridPosition(index: number): NodePosition {
  return { x: (index % 4) * 220 + 40, y: Math.floor(index / 4) * 140 + 40 }
}

/** 取某流程某节点的坐标（缺坐标返回 undefined，由调用方补位）。 */
export function getPosition(layout: EditorLayout, flow: string | undefined, nodeId: string): NodePosition | undefined {
  const table = flow === undefined ? layout.main : layout.children[flow]
  return table?.[nodeId]
}

/** 写入某流程某节点的坐标（原地修改；历史快照由 draft 层负责）。 */
export function setPosition(layout: EditorLayout, flow: string | undefined, nodeId: string, pos: NodePosition): void {
  if (flow === undefined) {
    layout.main[nodeId] = { x: pos.x, y: pos.y }
  } else {
    layout.children[flow] ??= {}
    layout.children[flow]![nodeId] = { x: pos.x, y: pos.y }
  }
}

/**
 * 按配置补齐缺失坐标（主流程与各子流程分别从网格 0 开始；多余记录保留在原地，
 * 读取时忽略，保存时按当前配置重写即自然剪枝）。
 * @returns 补位的条目数。
 */
export function fillMissingPositions(config: WorkflowConfig, layout: EditorLayout): number {
  let filled = 0
  const flows: Array<{ id: string | undefined; nodes: Record<string, unknown> }> = [
    { id: undefined, nodes: config.workflow.nodes },
  ]
  for (const [childId, def] of Object.entries(config.childWorkflows ?? {})) {
    flows.push({ id: childId, nodes: def.nodes })
  }
  for (const flow of flows) {
    let index = 0
    for (const nodeId of Object.keys(flow.nodes)) {
      if (getPosition(layout, flow.id, nodeId) === undefined) {
        setPosition(layout, flow.id, nodeId, gridPosition(index))
        filled += 1
      }
      index += 1
    }
  }
  return filled
}

/**
 * 按当前配置序列化布局（只写现存节点的坐标，陈旧记录自然丢弃；
 * 子流程空表保留键，便于切换显示）。
 */
export function serializeLayout(config: WorkflowConfig, layout: EditorLayout): string {
  const out: EditorLayout = { version: LAYOUT_VERSION, main: {}, children: {} }
  for (const nodeId of Object.keys(config.workflow.nodes)) {
    const pos = layout.main[nodeId]
    if (pos !== undefined) out.main[nodeId] = { x: pos.x, y: pos.y }
  }
  for (const [childId, def] of Object.entries(config.childWorkflows ?? {})) {
    const table = layout.children[childId] ?? {}
    const flow: Record<string, NodePosition> = {}
    for (const nodeId of Object.keys(def.nodes)) {
      const pos = table[nodeId]
      if (pos !== undefined) flow[nodeId] = { x: pos.x, y: pos.y }
    }
    out.children[childId] = flow
  }
  return `${JSON.stringify(out, undefined, 2)}\n`
}
