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
  type DelegationRoute, type ExecutionDispatch, type ExecutionJudge, type JudgeResult, type NodeExecution, type NodeExecutionEvent, type RoleRouteStage, type RunState, type StateRow,
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

/** #275 一轮 Actor 提交（及与之配对的 Judge 判定）；同一工作单内可有多轮。 */
export interface MonitorRound {
  claimId: string
  /** 本轮提交的声明结果名。 */
  result: string
  /** 提交发生时间（claim 事件时间；无事件留档 = 未记录，不按当前时刻推算）。 */
  submittedAt: string
  /** 本轮提交时面向的 Actor 派发事实（模型/来源；旧记录缺 = 未记录）。 */
  actor?: MonitorDispatchFacts
  /** 本轮判定（按 claimId 配对，不跨轮配时间；未判定则缺）。 */
  judgment?: { result: JudgeResult['result']; at: string; judge?: MonitorDispatchFacts }
}

/** #275 一个工作单（一次进入）的 Actor/Judge 轮次事实。 */
export interface MonitorHistory {
  /** 多轮提交/判定：按发生顺序。 */
  rounds: MonitorRound[]
  /** 最新一次派发尚未形成新一轮提交（REJECT/换模后的重派）：待提交那一轮的事实。 */
  pending?: MonitorDispatchFacts
  /** 发生过但未形成提交的派发（故障切换/超时重派/被覆盖的旧轮；时间未知为 null）。 */
  abandoned: Array<{ at: string | null; dispatch: MonitorDispatchFacts }>
  /** 换模时间线（model-changed 事件；模型差分已含在各轮事实里，这里只给时间与角色；角色无法认定时为 null）。 */
  switches: Array<{ at: string; role: 'actor' | 'judge' | null }>
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
  /** #275 多轮提交/判定事实（旧记录无事件回放时缺 = 未记录）。 */
  history?: MonitorHistory
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

/**
 * #275 工作单内多轮事实：从该工作单的关键事件（派发/提交/判定/换模）还原，
 * 按 claimId 配对提交与判定、按事件时间给时间戳，绝不跨轮借模型或时间。
 * 无事件（旧记录/未派发）返回 undefined，视图显式降级为「未记录」而不是补当前配置。
 */
/**
 * 换模角色：事件快照里只有 NodeExecution，能证明的只有 Judge 侧（判定方模型/id 变化）。
 * Actor 故障切换/人工换模在快照里不带新路由（新模型在 Run 行 modelOverrides/roleRoutes），
 * 因此不猜角色，交给视图显示不带角色的「换模」。
 */
function switchedRoleOf(previous: NodeExecution | undefined, current: NodeExecution): 'actor' | 'judge' | null {
  if (previous === undefined) return null
  if (JSON.stringify(previous.judge?.model ?? null) !== JSON.stringify(current.judge?.model ?? null)) return 'judge'
  if (current.judge !== undefined && previous.judge?.id !== current.judge.id) return 'judge'
  if ((previous.dispatch?.id ?? null) !== (current.dispatch?.id ?? null)) return 'actor'
  return null
}
function historyOf(execution: NodeExecution, events: readonly NodeExecutionEvent[]): MonitorHistory | undefined {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence)
  const judges = new Map<string, MonitorDispatchFacts>()
  const attempts: Array<{ at: string | null; dispatch: MonitorDispatchFacts }> = []
  const rounds: MonitorRound[] = []
  const switches: MonitorHistory['switches'] = []
  let previous: NodeExecution | undefined
  for (const event of ordered) {
    const snapshot = event.snapshot
    if (event.type === 'actor-arranged' && snapshot.dispatch !== undefined) {
      attempts.push({ at: event.at, dispatch: dispatchFactsOf(snapshot.dispatch) })
    } else if (event.type === 'judge-arranged' && snapshot.judge !== undefined) {
      // REJECT 的判定事件快照里 judge 已清空（回到 ready），所以判定方的派发事实按 id 留档。
      judges.set(snapshot.judge.id, dispatchFactsOf(snapshot.judge))
    } else if (event.type === 'claim' && snapshot.claim !== undefined) {
      const claim = snapshot.claim
      if (!rounds.some(round => round.claimId === claim.id)) {
        const round: MonitorRound = { claimId: claim.id, result: claim.result, submittedAt: event.at }
        if (snapshot.dispatch !== undefined) round.actor = dispatchFactsOf(snapshot.dispatch)
        rounds.push(round)
      }
    } else if (event.type === 'judgment' && snapshot.judgment !== undefined && snapshot.judgment !== null) {
      const judgment = snapshot.judgment
      const round = rounds.find(item => item.claimId === judgment.claimId)
      // 判定必须落在同 claimId 的那一轮：找不到就不硬塞给当前轮。
      if (round !== undefined) {
        const entry: NonNullable<MonitorRound['judgment']> = { result: judgment.result, at: event.at }
        const judge = judges.get(judgment.judgeDispatchId)
          ?? (snapshot.judge === undefined ? undefined : dispatchFactsOf(snapshot.judge))
        if (judge !== undefined) entry.judge = judge
        round.judgment = entry
      }
    } else if (event.type === 'model-changed') {
      // 事件快照只有 NodeExecution：只有 Judge 侧有可证差分时才标角色，其余如实留空（不猜）。
      switches.push({ at: event.at, role: switchedRoleOf(previous, snapshot) })
    }
    previous = snapshot
  }
  // 被覆盖的旧轮只在工作单留档（failover/换模 resume）：事件里没有也补一条未提交派发。
  if (execution.previousDispatch !== undefined && !attempts.some(attempt => attempt.dispatch.id === execution.previousDispatch!.id)) {
    attempts.unshift({ at: null, dispatch: dispatchFactsOf(execution.previousDispatch) })
  }
  const consumed = new Set(rounds.map(round => round.actor?.id).filter((id): id is string => id !== undefined))
  if (execution.claim !== undefined) consumed.add(execution.claim.dispatchId)
  const live = execution.dispatch
  const pending = live !== undefined && !consumed.has(live.id) ? dispatchFactsOf(live) : undefined
  const abandoned = attempts.filter(attempt => !consumed.has(attempt.dispatch.id) && attempt.dispatch.id !== live?.id)
  if (rounds.length === 0 && pending === undefined && abandoned.length === 0 && switches.length === 0) return undefined
  return {
    rounds,
    ...(pending !== undefined ? { pending } : {}),
    abandoned,
    switches,
  }
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
export function projectRunStatus(row: StateRow | undefined, executions: readonly NodeExecution[] | undefined, maintenance: StateMaintenanceDiagnostic | undefined, layout?: EditorLayout, runs: readonly StateRow[] = [], events: readonly NodeExecutionEvent[] = []): MonitorRunStatus {
  if (maintenance) return { mode: 'maintenance', maintenance: { kind: maintenance.kind, reason: maintenanceText(maintenance) }, runs: [] }
  const refs = runs.map(runRefOf)
  // empty 只表示「当前 cwd 没有可投影的 Run」：其他 workspace 仍可能有活跃 Run（见 runs），
  // 终态历史也仍在状态库中、经 runId 可复盘（#263 删除 recent 摘要链后语义不变）。
  if (row === undefined) return { mode: 'empty', runs: refs }
  const run = row.run
  const snapshot = run.definitionSnapshot
  const ordered = [...(executions ?? [])].sort((a, b) => a.visit - b.visit)
  const histories = new Map<string, NodeExecutionEvent[]>()
  for (const event of events) {
    const list = histories.get(event.executionId)
    if (list === undefined) histories.set(event.executionId, [event])
    else list.push(event)
  }
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
      nodes: ordered.map(execution => {
        const history = historyOf(execution, histories.get(execution.executionId) ?? [])
        return {
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
          // #275：多轮提交/判定下钻（事件回放；旧记录无事件 = 缺，不补当前配置）。
          ...(history !== undefined ? { history } : {}),
        }
      }),
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
  /** runId → 提交/判定/派发/换模事件（#275 执行记录表的多轮事实来源；缺省视为无事件）。 */
  events?: (runId: string) => Promise<NodeExecutionEvent[]>
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
      const events = row === undefined || deps.events === undefined ? [] : await deps.events(row.run.runId)
      const layout = row === undefined ? undefined : await deps.layout(row.run.catalogWorkflowId).catch(() => undefined)
      return { ok: true as const, value: projectRunStatus(row, executions, undefined, layout, active, events) }
    } catch (error) {
      return { ok: false as const, error: { code: 'monitor/status-failed', message: `运行状态读取失败：${error instanceof Error ? error.message : String(error)}`, details: {} } }
    }
  }
}
