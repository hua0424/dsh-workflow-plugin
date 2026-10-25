/**
 * #251 运行监控只读 RPC（host 侧）：`status` 一次返回当前 workspace 最新 Run 的
 * 完整只读投影——冻结快照图结构、每节点 phase/角色/生效模型、BLOCK 原因、
 * 启动 prompt（Run 首个工作单 input 快照）与 Run 级返回信息。
 *
 * ADR-0005：只读，无任何控制入口；通道独立于编辑器通道（MONITOR_RPC_CHANNEL）；
 * 不接受文件路径输入——payload 只收可选 `cwd` 字符串，workspace 解析经注入的
 * `status`/`executions` 依赖完成；维护态短路返回诊断，绝不触碰状态库。
 * `projectRunStatus` 是纯函数：单测直接喂 StateRow/工作单快照，不需要 Store。
 */
import { isActorTaskNode, nodeOnReturn, nodeResults, roleKeysWithJudge, type NodeExecution, type RunState, type StateRow } from '../types.ts'
import { resolveRoleModel } from '../roles/roles.ts'
import type { StateMaintenanceDiagnostic } from '../state/store.ts'
import { LAYOUT_VERSION, emptyLayout, fillMissingPositions, type EditorLayout } from '../editor/layout.ts'

/** RPC channel（Connection 单段绝对路径规则；独立于编辑器通道）。 */
export const MONITOR_RPC_CHANNEL = '/workflow-run-monitor'

/** 生效模型投影（DelegationRoute 的 lossless JSON 形状）。 */
export type MonitorModel = { provider?: string; modelId?: string; reasoningEffort?: string }

/** 节点结果目标（与编辑器布局/画布同形：节点 id 或流程返回名）。 */
export type MonitorTarget = { node?: string; return?: string }

/** 节点图投影：kind + 执行目标（actor 的 role/program 的 id/子流程 id）+ 生效模型 + 结果端口。 */
export interface MonitorNodeDef {
  id: string
  kind: 'actor-task' | 'builtin-program' | 'child-workflow'
  role?: string
  programId?: string
  childWorkflowId?: string
  model?: MonitorModel
  /** Actor/Program 的声明结果（键 + 目标），供只读画布绘制结果端口与连线。 */
  results?: Record<string, { criteria: string; target: MonitorTarget }>
  /** Child 的 onReturn（返回名 → 本层目标）。 */
  onReturn?: Record<string, MonitorTarget>
}

export interface MonitorFlowDef {
  startNode: string
  returns: string[]
  nodes: MonitorNodeDef[]
}

export interface MonitorNodeExecution {
  workflowId: string
  nodeId: string
  executionId: string
  visit: number
  revision: number
  phase: NodeExecution['phase']
  blockReason: string | null
  enteredAt: string
  exitedAt: string | null
  /** 调用栈栈顶帧（当前焦点节点）标记。 */
  current: boolean
}

export interface MonitorRunStatus {
  mode: 'maintenance' | 'empty' | 'run'
  maintenance?: { kind: StateMaintenanceDiagnostic['kind']; reason: string }
  run?: {
    runId: string
    workflowId: string
    status: RunState['status']
    blockReason: string | null
    businessReturn: { name: string; source: string } | null
    /** Run 首个工作单的 input 快照原文（visit 最小的工作单）。 */
    launchPrompt: string | null
    roles: Array<{ role: string; model: MonitorModel }>
    /** 根流程与全部子流程的冻结图结构（key=workflowId，根为 catalogWorkflowId）。 */
    flows: Record<string, MonitorFlowDef>
    /** 编辑器布局坐标（缺失节点由客户端按网格补位；布局缺失时为空布局）。 */
    layout: EditorLayout
    /** 全部工作单（含历史 visit），按 visit 升序。 */
    nodes: MonitorNodeExecution[]
  }
}

function modelOf(run: RunState, role: string): MonitorModel {
  const route = resolveRoleModel(run, role, run.delegationRoute)
  const model: MonitorModel = {}
  if (route.provider !== undefined) model.provider = route.provider
  if (route.modelId !== undefined) model.modelId = route.modelId
  if (route.reasoningEffort !== undefined) model.reasoningEffort = route.reasoningEffort
  return model
}

function flowOf(workflowId: string, def: RunState['definitionSnapshot']['workflow'], run: RunState): MonitorFlowDef {
  return {
    startNode: def.startNode,
    returns: [...def.returns],
    nodes: Object.entries(def.nodes).map(([id, node]) => {
      const projection: MonitorNodeDef = { id, kind: node.execution.type }
      if (isActorTaskNode(node)) {
        projection.role = node.execution.role
        projection.model = modelOf(run, node.execution.role)
      } else if (node.execution.type === 'builtin-program') {
        projection.programId = node.execution.programId
      } else {
        projection.childWorkflowId = node.execution.workflowId
      }
      // #252：结果端口与连线所需的声明结果/Child 映射（只读副本）。
      const results = nodeResults(node)
      if (results !== undefined) {
        projection.results = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { criteria: result.criteria, target: { ...result.target } }]))
      }
      const onReturn = nodeOnReturn(node)
      if (onReturn !== undefined) {
        projection.onReturn = Object.fromEntries(Object.entries(onReturn).map(([name, target]) => [name, { ...target }]))
      }
      return projection
    }),
  }
}

/** 纯投影：StateRow + 全部工作单快照 + 可选布局 → 监控 payload（校验副本，不改写输入）。 */
export function projectRunStatus(row: StateRow | undefined, executions: readonly NodeExecution[] | undefined, maintenance: StateMaintenanceDiagnostic | undefined, layout?: EditorLayout): MonitorRunStatus {
  if (maintenance) return { mode: 'maintenance', maintenance: { kind: maintenance.kind, reason: maintenance.reason } }
  if (row === undefined) return { mode: 'empty' }
  const run = row.run
  const snapshot = run.definitionSnapshot
  const ordered = [...(executions ?? [])].sort((a, b) => a.visit - b.visit)
  const top = run.callStack.at(-1)
  const flows: Record<string, MonitorFlowDef> = { [run.catalogWorkflowId]: flowOf(run.catalogWorkflowId, snapshot.workflow, run) }
  for (const [workflowId, def] of Object.entries(snapshot.childWorkflows ?? {})) flows[workflowId] = flowOf(workflowId, def, run)
  // 布局是显示增强：复制后按冻结图补位，绝不改写磁盘内容或输入对象。
  const positions: EditorLayout = layout === undefined
    ? emptyLayout()
    : { version: LAYOUT_VERSION, main: { ...layout.main }, children: Object.fromEntries(Object.entries(layout.children).map(([id, table]) => [id, { ...table }])) }
  fillMissingPositions(snapshot, positions)
  return {
    mode: 'run',
    run: {
      runId: run.runId,
      workflowId: run.catalogWorkflowId,
      status: run.status,
      blockReason: run.blockReason ?? null,
      businessReturn: run.businessReturn ? { ...run.businessReturn } : null,
      launchPrompt: ordered[0]?.input ?? null,
      roles: roleKeysWithJudge(snapshot).map(role => ({ role, model: modelOf(run, role) })),
      flows,
      layout: positions,
      nodes: ordered.map(execution => ({
        workflowId: execution.workflowId,
        nodeId: execution.nodeId,
        executionId: execution.executionId,
        visit: execution.visit,
        revision: execution.revision,
        phase: execution.phase,
        blockReason: execution.blockReason ?? null,
        enteredAt: execution.enteredAt,
        exitedAt: execution.exitedAt ?? null,
        current: top !== undefined && top.workflowId === execution.workflowId && top.nodeId === execution.nodeId && top.executionId === execution.executionId,
      })),
    },
  }
}

export interface MonitorRpcDeps {
  /** 维护诊断（StateAccess.maintenanceDiagnostic 克隆）；非 undefined 时短路。 */
  maintenance: () => StateMaintenanceDiagnostic | undefined
  /** cwd → 最新 Run 行（含维护态之外的 undefined=无 Run）。 */
  status: (cwd?: string) => Promise<StateRow | undefined>
  /** cwd → 最新 Run 全部工作单快照（visit 升序；无 Run 空数组）。 */
  executions: (cwd?: string) => Promise<NodeExecution[]>
  /** workflowId → 只读布局；缺失/损坏返回 undefined（显示增强，读取失败不阻断 status）。 */
  layout: (workflowId: string) => Promise<EditorLayout | undefined>
}

/** 按 endpoint 分派（只支持 status；payload 只收可选 cwd 字符串）。 */
export function createMonitorRpcHandler(deps: MonitorRpcDeps) {
  return async (endpoint: string, payload: unknown) => {
    if (endpoint !== 'status') {
      return { ok: false as const, error: { code: 'monitor/unknown-endpoint', message: `未知 endpoint "${endpoint}"（仅支持 status）`, details: {} } }
    }
    if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
      return { ok: false as const, error: { code: 'monitor/invalid-payload', message: 'payload 必须是对象或缺席', details: {} } }
    }
    const body = (payload ?? {}) as Record<string, unknown>
    const cwd = body['cwd']
    if (cwd !== undefined && typeof cwd !== 'string') {
      return { ok: false as const, error: { code: 'monitor/invalid-payload', message: 'cwd 必须是字符串或缺席', details: {} } }
    }
    const maintenance = deps.maintenance()
    if (maintenance) return { ok: true as const, value: projectRunStatus(undefined, undefined, maintenance) }
    try {
      const [row, executions] = await Promise.all([deps.status(cwd), deps.executions(cwd)])
      const layout = row === undefined ? undefined : await deps.layout(row.run.catalogWorkflowId).catch(() => undefined)
      return { ok: true as const, value: projectRunStatus(row, executions, undefined, layout) }
    } catch (error) {
      return { ok: false as const, error: { code: 'monitor/status-failed', message: `运行状态读取失败：${error instanceof Error ? error.message : String(error)}`, details: {} } }
    }
  }
}
