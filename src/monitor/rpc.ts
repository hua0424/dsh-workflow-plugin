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
import {
  isActorTaskNode, nodeOnReturn, nodeResults, roleKeysWithJudge,
  type DelegationRoute, type ExecutionDispatch, type ExecutionJudge, type JudgeResult, type NodeExecution, type RoleRouteStage, type RunState, type StateRow,
} from '../types.ts'
import { resolveRoleModel } from '../roles/roles.ts'
import type { StateMaintenanceDiagnostic } from '../state/store.ts'
import { maintenanceText } from '../state/maintenance.ts'
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

/** 调用栈帧投影（#253）：只暴露路径定位所需字段，不含 nodeToken。 */
export interface MonitorCallFrame {
  workflowId: string
  nodeId: string
  executionId: string
}

/** #274 一次派发的监控事实：只转发落库的值，不按当前配置重算（旧行缺字段 = 未记录）。 */
export interface MonitorDispatchFacts {
  id: string
  /** Host 已确认派发（dispatch.messageId 存在）；false = 已安排未确认。 */
  dispatched: boolean
  /** Actor 的 Turn 已由 Host 收口（用于「等待 Actor 收口 / 待提交」状态，不作为结束时间展示）。 */
  settled: boolean
  model?: MonitorModel
  source?: RoleRouteStage
}

/** #274 Judge 派发事实：同 dispatch，另带本次判定的结论（仅当时判定）。 */
export interface MonitorJudgeFacts extends MonitorDispatchFacts {
  claimId: string
  judgment?: JudgeResult['result']
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
  /** #274 本工作单的 Actor 派发事实（缺字段 = 旧记录未采集）。 */
  dispatch?: MonitorDispatchFacts
  /** #274 同一工作单被重派前的旧轮派发事实（故障切换/换模 resume 留档；缺 = 从未重派）。 */
  previousDispatch?: MonitorDispatchFacts
  /** #274 本工作单已提交的结果（result 为声明结果名；handoff 只给有界预览）。 */
  claim?: { id: string; result: string; handoff: string }
  /** #274 本工作单的 Judge 派发事实。 */
  judge?: MonitorJudgeFacts
}

/** Run 引用（#254 切换器/空态）：带 workspace 标识，供跨目录选择。 */
export interface MonitorRunRef {
  runId: string
  workspaceKey: string
  workflowId: string
  status: RunState['status']
}

export interface MonitorRunStatus {
  mode: 'maintenance' | 'empty' | 'run'
  maintenance?: { kind: StateMaintenanceDiagnostic['kind']; reason: string }
  /** 全部活跃 Run（running/blocked），带 workspace 标识；维护态为空。 */
  runs: MonitorRunRef[]
  run?: {
    runId: string
    workspaceKey: string
    workflowId: string
    status: RunState['status']
    /** 终态 Run：客户端停止轮询，只展示冻结终态图。 */
    terminal: boolean
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
    /** 调用栈（栈底根流程 → 栈顶当前节点），供子流程下钻/自动跟随/面包屑（#253）。 */
    callStack: MonitorCallFrame[]
  }
}

/** 路由快照的 lossless 副本（只拷贝存在的键；undefined 表示未记录，不补空值）。 */
function modelCopy(route: DelegationRoute | undefined): MonitorModel | undefined {
  if (route === undefined) return undefined
  const model: MonitorModel = {}
  if (route.provider !== undefined) model.provider = route.provider
  if (route.modelId !== undefined) model.modelId = route.modelId
  if (route.reasoningEffort !== undefined) model.reasoningEffort = route.reasoningEffort
  return model
}

/**
 * #274 handoff 是自由文本：只读监控只给有界预览，避免 2 秒轮询的 payload 与
 * 历史长度同增长（完整正文归状态库/详情另取）。
 */
const HANDOFF_PREVIEW_MAX = 200
function previewHandoff(text: string): string {
  return text.length <= HANDOFF_PREVIEW_MAX ? text : `${text.slice(0, HANDOFF_PREVIEW_MAX)}…（共 ${text.length} 字）`
}

function modelOf(run: RunState, role: string): MonitorModel {
  return modelCopy(resolveRoleModel(run, role, run.delegationRoute)) ?? {}
}

/** #274 Actor 派发事实：模型/来源直接取落库快照，不从当前 override 反推。 */
function dispatchFactsOf(dispatch: ExecutionDispatch): MonitorDispatchFacts {
  const model = modelCopy(dispatch.model)
  const facts: MonitorDispatchFacts = { id: dispatch.id, dispatched: dispatch.messageId !== undefined, settled: dispatch.settled }
  if (model !== undefined) facts.model = model
  if (dispatch.source !== undefined) facts.source = dispatch.source
  return facts
}

/** #274 Judge 派发事实：只认属于本次 Judge 派发的判定（历史判定不冒充当前结论）。 */
function judgeFactsOf(judge: ExecutionJudge, judgment: NodeExecution['judgment']): MonitorJudgeFacts {
  const facts: MonitorJudgeFacts = { ...dispatchFactsOf(judge), claimId: judge.claimId }
  if (judgment !== undefined && judgment.judgeDispatchId === judge.id) facts.judgment = judgment.result
  return facts
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

function runRefOf(row: StateRow): MonitorRunRef {
  return { runId: row.run.runId, workspaceKey: row.workspaceKey, workflowId: row.run.catalogWorkflowId, status: row.run.status }
}

/**
 * 纯投影：StateRow + 全部工作单快照 + 可选布局 + 活跃清单
 * → 监控 payload（校验副本，不改写输入）。维护态短路且不读任何状态。
 */
export function projectRunStatus(row: StateRow | undefined, executions: readonly NodeExecution[] | undefined, maintenance: StateMaintenanceDiagnostic | undefined, layout?: EditorLayout, runs: readonly StateRow[] = []): MonitorRunStatus {
  if (maintenance) return { mode: 'maintenance', maintenance: { kind: maintenance.kind, reason: maintenanceText(maintenance) }, runs: [] }
  const refs = runs.map(runRefOf)
  // empty 只表示「当前 cwd 没有可投影的 Run」：其他 workspace 仍可能有活跃 Run（见 runs），
  // 终态历史也仍在状态库中、经 runId 可复盘（#263 删除 recent 摘要链后语义不变）。
  if (row === undefined) return { mode: 'empty', runs: refs }
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
    runs: refs,
    run: {
      runId: run.runId,
      workspaceKey: row.workspaceKey,
      workflowId: run.catalogWorkflowId,
      status: run.status,
      terminal: run.status === 'completed' || run.status === 'terminated',
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
        // #274：派发/claim/判定事实只来自本工作单的落库快照（旧行缺字段 = 未记录）。
        ...(execution.dispatch !== undefined ? { dispatch: dispatchFactsOf(execution.dispatch) } : {}),
        // 重派前的旧轮单独转发，供卡片显示「上一轮」；不覆盖、不推算。
        ...(execution.previousDispatch !== undefined ? { previousDispatch: dispatchFactsOf(execution.previousDispatch) } : {}),
        ...(execution.claim !== undefined ? { claim: { id: execution.claim.id, result: execution.claim.result, handoff: previewHandoff(execution.claim.handoff) } } : {}),
        ...(execution.judge !== undefined ? { judge: judgeFactsOf(execution.judge, execution.judgment) } : {}),
      })),
      callStack: run.callStack.map(frame => ({ workflowId: frame.workflowId, nodeId: frame.nodeId, executionId: frame.executionId })),
    },
  }
}

export interface MonitorRpcDeps {
  /** 维护诊断（StateAccess.maintenanceDiagnostic 克隆）；非 undefined 时短路。 */
  maintenance: () => StateMaintenanceDiagnostic | undefined
  /** cwd → canonical workspace key（缺省/无法解析 → undefined，不回退 process.cwd）。 */
  resolveWorkspace: (cwd?: string) => Promise<string | undefined>
  /** workspace 最新 Run（活跃优先；无历史 → undefined）。 */
  latest: (workspaceKey: string) => Promise<StateRow | undefined>
  /** 全部活跃 Run（running/blocked）。 */
  active: () => Promise<StateRow[]>
  /** runId → Run 行（切换器跨 workspace）。 */
  byRunId: (runId: string) => Promise<StateRow | undefined>
  /** runId → 全部工作单快照（visit 升序；无 Run 空数组）。 */
  executions: (runId: string) => Promise<NodeExecution[]>
  /** workflowId → 只读布局；缺失/损坏返回 undefined（显示增强，读取失败不阻断 status）。 */
  layout: (workflowId: string) => Promise<EditorLayout | undefined>
}

/** 按 endpoint 分派（只支持 status；payload 只收可选 cwd/runId 字符串）。 */
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
    const runId = body['runId']
    if (runId !== undefined && typeof runId !== 'string') {
      return { ok: false as const, error: { code: 'monitor/invalid-payload', message: 'runId 必须是字符串或缺席', details: {} } }
    }
    const maintenance = deps.maintenance()
    if (maintenance) return { ok: true as const, value: projectRunStatus(undefined, undefined, maintenance) }
    try {
      const [active, workspaceKey] = await Promise.all([deps.active(), deps.resolveWorkspace(cwd)])
      // 显式 runId 优先（切换器跨 workspace）；失效/缺失时回退当前 cwd 默认。
      let row = runId === undefined ? undefined : await deps.byRunId(runId)
      if (row === undefined && workspaceKey !== undefined) row = await deps.latest(workspaceKey)
      const executions = row === undefined ? [] : await deps.executions(row.run.runId)
      const layout = row === undefined ? undefined : await deps.layout(row.run.catalogWorkflowId).catch(() => undefined)
      return { ok: true as const, value: projectRunStatus(row, executions, undefined, layout, active) }
    } catch (error) {
      return { ok: false as const, error: { code: 'monitor/status-failed', message: `运行状态读取失败：${error instanceof Error ? error.message : String(error)}`, details: {} } }
    }
  }
}
