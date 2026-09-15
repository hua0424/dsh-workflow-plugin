/**
 * 参与者索引（#99）：把「谁属于哪个 Run/workspace、以什么身份、哪一代 Agent、哪些
 * 证据必须保留」收拢成一个深 Module——参与者发现、Run/workspace/role 关联、宿主重启
 * 修复与观察引用寿命都在这里。Store 的当前工作单始终是唯一授权权威，本索引只保存
 * 派生事实，自己不做授权。
 *
 * 三类证据的寿命（#99 改造方法 3/4）：
 * 1. 精确 Agent 引用（`exact`）：强引用，只在该 Session **自己**的 turn/end 结算窗口
 *    内保留，且必须由内存路由或工作单行证明它是参与者；一次无法证明参与的结算
 *    （无关 Session churn）立即释放完整 Agent，只留 id 级事实——不靠 TTL 洗白。
 * 2. 历史路由（`workspaces` / `roles` / `judgeAdmissions`）：id 级字符串，宿主重启后的
 *    授权修复要用；成本与见过的 Session 数同阶，与是否还持有精确引用无关。
 * 3. unsafe/orphan tombstone（`unsafe`）与祖先关系（`parents`）：job 行消失、descriptor
 *    被清空都不能洗白（#54），只在插件卸载时清空。
 *
 * 授权纪律（#99 AC5）：本索引不缓存"已授权"结论。每次判定都以调用方传入的**当前
 * 工作单行**为准（`judgeAdmissionInWorkOrder`），撤权 / Reset 之后旧参与者的历史路由
 * 不会让它重新获得权利。
 *
 * 收口纪律（#99 AC2/AC3/AC6）：Session → turn/end 的同步回调只捕获事实
 * （`observeTurnEnd`）与路由；判定、修复与释放都在调用方 `setImmediate` 之后的异步段
 * 里进行（`resolveTurn`），Judge 从不在这里 drain 自己。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobDoneListener, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type { SafeInspection } from '../engine/engine.ts'

const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'killed'])

/** 0.1.5 起 Inbox 公共接口移除 hasPending：两个 pending 队列均为空即无待处理输入。 */
function inboxEmpty(agent: Agent): boolean {
  return agent.inbox.nextTurn.length === 0 && agent.inbox.nextStep.length === 0
}

/** 从 durable 根集合按 parentSession 线性补齐 live 后代。 */
function liveDescendantIds(seedIds: Iterable<string>, agents: readonly Agent[]): Set<string> {
  const ids = new Set(seedIds)
  const childrenByParent = new Map<string, Agent[]>()
  for (const agent of agents) {
    const parent = agent.session.header.parentSession
    if (!parent) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(agent)
    childrenByParent.set(parent, children)
  }
  const queue = [...ids]
  for (let index = 0; index < queue.length; index++) {
    for (const child of childrenByParent.get(queue[index]!) ?? []) {
      if (ids.has(child.id)) continue
      ids.add(child.id)
      queue.push(child.id)
    }
  }
  return ids
}

/** 参与身份：只有工作单行（或本 Run 自己的派发记录）能证明它。 */
export type ParticipantAdmission = { kind: 'manager' } | { kind: 'role'; roleKey: string } | { kind: 'judge' }

/**
 * 当前工作单里与参与者路由相关的字段（由调用方从 Store 行投影）。授权权威仍是那条行
 * 本身——这里只搬运事实，不解释策略。
 */
export interface WorkOrderFacts {
  runStatus: string
  phase: string
  managerSessionId: string
  roleActors: Readonly<Record<string, string>>
  dispatchSessionId?: string
  judgeSessionId?: string
  /** 当前 Judge 是否已对本 claim 出结果（judgment 与 claim / inputVersion 对齐）。 */
  judgeJudgedCurrentClaim: boolean
  /** `ready` + predecessorId：工作单可能仍在等**前驱执行**的 Judge 收口。 */
  predecessorSettlementPending: boolean
}

/** 该 Session 在这份工作单里的参与身份；`undefined` = 工作单不引用它。 */
export function participantInWorkOrder(facts: WorkOrderFacts, sessionId: string): ParticipantAdmission | undefined {
  if (facts.managerSessionId === sessionId) return { kind: 'manager' }
  for (const [roleKey, actorId] of Object.entries(facts.roleActors)) if (actorId === sessionId) return { kind: 'role', roleKey }
  if (facts.judgeSessionId === sessionId) return { kind: 'judge' }
  return undefined
}

/** Judge 授权：工作单仍在等它（running + checking + 尚未对本 claim 出结果）。 */
export function judgeAdmissionInWorkOrder(facts: WorkOrderFacts, sessionId: string): boolean {
  return facts.judgeSessionId === sessionId && facts.runStatus === 'running' && facts.phase === 'checking'
    && !facts.judgeJudgedCurrentClaim
}

/**
 * 该 Session 的 turn/end 是否**可能**结算这份工作单。除参与身份外还必须覆盖引擎按
 * 「前驱执行的 Judge」结算的分支（`ready` + predecessorId）：那里无法廉价归因到具体
 * Session，因此保守保留证据，而不是把可能还要用的引用释放掉。
 */
export function workOrderMayAwaitTurn(facts: WorkOrderFacts, sessionId: string): boolean {
  return participantInWorkOrder(facts, sessionId) !== undefined
    || facts.dispatchSessionId === sessionId
    || facts.predecessorSettlementPending
}

/** Host 服务切片：本索引只读这些服务，从不派发、不注册。 */
export interface ParticipantServices {
  agents: { get(id: SessionId): Agent | undefined; list(): Agent[] }
  subagents: { listDescendants(sessionId: SessionId, signal?: AbortSignal): Promise<readonly SubagentDescendantListEntry[]> }
  jobs: { list(caller?: Agent): readonly JobSnapshot[]; onJobDone(listener: JobDoneListener): () => void }
  effect(factory: () => () => void): void
}

/**
 * 工作单读取端口。`facts` 是单行读——#99 移除了「无关 Session 每个 turn/end 扫一次
 * 全表」的路径；`factsBySession` 只在 cwd 推导不出所属行时兜底（冷恢复/重启修复）。
 */
export interface WorkOrderPort {
  workspaceKeyOf(cwd: string | undefined): Promise<string | undefined>
  facts(workspaceKey: string): Promise<WorkOrderFacts | undefined>
  /** 兜底全表扫：按 Session 找它所属的行（与 cwd 推导对不上时的冷恢复路径）。 */
  factsBySession(sessionId: string): Promise<{ workspaceKey: string; facts: WorkOrderFacts } | undefined>
}

/** #99 可复查计数：证据保留/释放与工作单探针开销。 */
export interface ParticipantStats {
  /** 仍保留的完整 Agent 引用数（= 已确认的参与者）。 */
  exactAgents: number
  /** 观察窗口内尚未判定的引用数（每个 turn/end 只应短暂 > 0）。 */
  provisional: number
  routes: number
  roles: number
  judgeAdmissions: number
  tombstones: number
  lineage: number
  /** AC1 的可复查证据：确认保留 / 释放无关 Session 的次数。 */
  retainDecisions: number
  releaseUnrelated: number
  releaseOnDispose: number
  /** AC7：单行工作单读、兜底全表扫、cwd realpath 的次数。 */
  rowProbes: number
  scanFallbacks: number
  realpathCalls: number
}

export interface ParticipantIndex {
  /** 记录/覆盖一个 Session 的 workspace 路由（Manager 启动、子会话创建、cold 修复）。 */
  rememberWorkspace(sessionId: string, workspaceKey: string): void
  /** 记录 Role Actor 身份（+ 可选 workspace 路由）。 */
  rememberRole(sessionId: string, roleKey: string, workspaceKey?: string): void
  /** Judge 准入：同时记准入 workspace 与路由；无 workspace 时只表明"本 Run 派发过它"。 */
  admitJudge(sessionId: string, workspaceKey?: string): void
  /** 撤权只删准入映射，历史路由保留（授权只认当前工作单）。 */
  revokeJudge(sessionId: string): void
  /** 按工作单身份修复/补齐关联（宿主重启后的 cold 参与者）。 */
  adopt(sessionId: string, workspaceKey: string, admission: ParticipantAdmission): void
  workspaceOf(sessionId: string): string | undefined
  roleOf(sessionId: string): string | undefined
  judgeWorkspaceOf(sessionId: string): string | undefined
  /** 同步事实捕获：记录该 Session 的**当代** Agent 与祖先关系，不做任何判定。 */
  observeTurnEnd(sessionId: string): void
  /**
   * 一次 turn/end 的归属判定：内存路由优先；未命中才探一次工作单（单行读 + realpath，
   * 推导不出时兜底扫一次），并按结果确认（保留）或释放观察引用。返回该 Turn 归属的
   * workspace；`undefined` = 连 workspace 都推导不出来，没有可结算的工作单。
   */
  resolveTurn(sessionId: string, cwd: string | undefined): Promise<string | undefined>
  safeToInspect(sessionId: string): Promise<SafeInspection>
  stats(): ParticipantStats
}

/** 生产与测试同一条装配路径：宿主 Context（结构上就是服务切片）→ 本索引的服务面。 */
export function participantServicesOf(host: ParticipantServices): ParticipantServices {
  return { agents: host.agents, subagents: host.subagents, jobs: host.jobs, effect: factory => { host.effect(factory) } }
}

export function makeParticipantIndex(services: ParticipantServices, workOrder: WorkOrderPort): ParticipantIndex {
  /** 历史路由（id 级）：授权修复与 turn/end 归属判定用。 */
  const workspaces = new Map<string, string>()
  const roles = new Map<string, string>()
  const judgeAdmissions = new Map<string, string>()
  /** 精确 Agent 引用：只在本 Session 自己的结算窗口内保留。 */
  const exact = new Map<string, Agent>()
  /** 尚未结算的观察；只有它们允许被释放（已确认参与者永不因结算而丢引用）。 */
  const provisional = new Set<string>()
  /** #54：orphan 证据；job 行消失不能洗白。 */
  const unsafe = new Set<string>()
  /** 已知祖先关系：middle Agent 不可观测、descriptor 消失后仍要能追到父 Role。 */
  const parents = new Map<string, string>()
  let retainDecisions = 0
  let releaseUnrelated = 0
  let releaseOnDispose = 0
  let rowProbes = 0
  let scanFallbacks = 0
  let realpathCalls = 0

  const recordParentSession = (agent: Agent): void => {
    const parentId = agent.session.header.parentSession
    if (parentId !== undefined) parents.set(agent.id, parentId)
  }

  const stopObservingJobs = services.jobs.onJobDone((job, owner) => {
    if (!owner || !job.detail?.includes('work may be orphaned')) return
    recordParentSession(owner)
    // 保留 exact owner 与当时已知祖先；descriptor 消失不能洗白父 Role。
    const seen = new Set<string>()
    for (let id: string | undefined = owner.id; id !== undefined && !seen.has(id); id = parents.get(id)) {
      seen.add(id)
      unsafe.add(id)
      const agent = exact.get(id) ?? services.agents.get(SessionId(id))
      if (agent !== undefined) recordParentSession(agent)
    }
  })
  services.effect(() => () => {
    stopObservingJobs()
    releaseOnDispose = exact.size
    exact.clear()
    provisional.clear()
    parents.clear()
    unsafe.clear()
  })

  /** 确认这次观察属于某个 Run：保留精确引用。 */
  const confirmObservation = (sessionId: string): void => {
    provisional.delete(sessionId)
    retainDecisions += 1
  }
  /** 释放：只对尚未确认的观察生效——无关 Session 的完整 Agent 引用不再无限保留。 */
  const releaseObservation = (sessionId: string): void => {
    if (!provisional.delete(sessionId)) return
    exact.delete(sessionId)
    releaseUnrelated += 1
  }

  const probe = async (workspaceKey: string): Promise<WorkOrderFacts | undefined> => {
    rowProbes += 1
    return await workOrder.facts(workspaceKey)
  }

  const adopt = (sessionId: string, workspaceKey: string, admission: ParticipantAdmission): void => {
    workspaces.set(sessionId, workspaceKey)
    if (admission.kind === 'role') roles.set(sessionId, admission.roleKey)
    else if (admission.kind === 'judge') judgeAdmissions.set(sessionId, workspaceKey)
  }

  return {
    rememberWorkspace(sessionId, workspaceKey) { workspaces.set(sessionId, workspaceKey) },
    rememberRole(sessionId, roleKey, workspaceKey) {
      roles.set(sessionId, roleKey)
      if (workspaceKey !== undefined) workspaces.set(sessionId, workspaceKey)
    },
    admitJudge(sessionId, workspaceKey) {
      if (workspaceKey === undefined) return
      judgeAdmissions.set(sessionId, workspaceKey)
      workspaces.set(sessionId, workspaceKey)
    },
    revokeJudge(sessionId) { judgeAdmissions.delete(sessionId) },
    adopt,
    workspaceOf(sessionId) { return workspaces.get(sessionId) },
    roleOf(sessionId) { return roles.get(sessionId) },
    judgeWorkspaceOf(sessionId) { return judgeAdmissions.get(sessionId) },

    observeTurnEnd(sessionId) {
      const agent = services.agents.get(SessionId(sessionId))
      if (agent === undefined) return
      exact.set(sessionId, agent)
      provisional.add(sessionId)
      recordParentSession(agent)
    },

    async resolveTurn(sessionId, cwd) {
      const known = workspaces.get(sessionId)
      if (known !== undefined) {
        // 本 Run 自己记下的路由就是参与证据（派发/准入时写入），无需再探工作单。
        confirmObservation(sessionId)
        return known
      }
      try {
        realpathCalls += 1
        const workspaceKey = await workOrder.workspaceKeyOf(cwd)
        if (workspaceKey !== undefined) {
          const facts = await probe(workspaceKey)
          if (facts !== undefined) {
            if (!workOrderMayAwaitTurn(facts, sessionId)) {
              releaseObservation(sessionId)
              return workspaceKey
            }
            const admission = participantInWorkOrder(facts, sessionId)
            if (admission !== undefined) adopt(sessionId, workspaceKey, admission)
            confirmObservation(sessionId)
            return workspaceKey
          }
          // cwd 能解析、但该 workspace 没有工作单行：参与者的 cwd 就是它 Run 的
          // workspace（Manager 在 start 处、子会话继承），所以它不可能属于别的
          // workspace —— 直接判定无关，不再兜底全表扫（#99 AC7）。
          releaseObservation(sessionId)
          return workspaceKey
        }
        // cwd 推导不出的冷 Session：旧路径按 Session 全表找一次（只可能命中
        // Judge 行），保留该兜底——冷恢复的 Judge 是唯一这样才找得到的参与者。
        scanFallbacks += 1
        const found = await workOrder.factsBySession(sessionId)
        if (found === undefined || !workOrderMayAwaitTurn(found.facts, sessionId)) {
          releaseObservation(sessionId)
          return undefined
        }
        const admission = participantInWorkOrder(found.facts, sessionId)
        if (admission !== undefined) adopt(sessionId, found.workspaceKey, admission)
        confirmObservation(sessionId)
        return found.workspaceKey
      } catch (error) {
        // 探针失败不是"可释放"的证据：fail-closed 保留，交给调用方记录。
        confirmObservation(sessionId)
        throw error
      }
    },

    async safeToInspect(sessionId): Promise<SafeInspection> {
      // #54：`waiting` 只在"唯一阻碍是仍在跑的已知后代"时返回；其余一律 fail-closed。
      // 该会话的 turn 结束没有 claim，只说明它在等并行子代理，不是异常闭合。
      let waiting = false
      // 精确引用优先：宿主自然 dispose 后仍能完成精确收口；同 Session ID 的**另一代**
      // Agent 永远不会被当作这一代的证据（末尾的 `current === candidate` 复查）。
      const agent = exact.get(sessionId) ?? services.agents.get(SessionId(sessionId))
      if (!agent || unsafe.has(sessionId)) return 'unsafe'
      try {
        await agent.whenIdle()
        const descendants = await services.subagents.listDescendants(SessionId(sessionId))
        if (descendants.some(child => child.kind === 'diagnostic')) return 'unsafe'
        for (const child of descendants) parents.set(String(child.id), String(child.parentId))
        const durableIds = new Set([sessionId, ...descendants.map(child => String(child.id))])
        if ([...durableIds].some(id => unsafe.has(id))) return 'unsafe'
        const requiredIds = new Set([sessionId, ...descendants
          .filter(child => child.kind === 'child' && child.activity === 'running')
          .map(child => String(child.id))])
        for (const id of durableIds) if (exact.has(id)) requiredIds.add(id)

        // Durable inactive 后代没有 Activation；registry 补齐 descriptor
        // 发布窗口中的 live 后代，以及 cold parent 之下的 live 后代。
        const live = services.agents.list()
        for (const candidate of live) recordParentSession(candidate)
        const treeIds = liveDescendantIds(durableIds, live)
        for (const child of live) if (treeIds.has(child.id)) requiredIds.add(child.id)

        const agents: Agent[] = []
        // #54：只有 `kind: 'child'` 的 durable 后代才是并行子代理的等待对象。
        // tree/exact 补齐的会话（例如 Manager 自己的 Session）属于同一收口
        // closure，非 idle 时仍是 fail-closed，不能算"等待"。
        const waitableIds = new Set(descendants
          .filter(child => child.kind === 'child')
          .map(child => String(child.id)))
        for (const id of requiredIds) {
          const candidate = exact.get(id) ?? services.agents.get(SessionId(id))
          if (!candidate || unsafe.has(id)) return 'unsafe'
          if (candidate.status !== 'idle' || !inboxEmpty(candidate)) {
            // #54：非 waitable 的 busy 成员（会话自身、tree/exact 补齐的会话、
            // descriptor 发布窗口期的 live 后代）仍属"收口未知"，必须 fail-closed。
            if (!waitableIds.has(id)) return 'unsafe'
            waiting = true
            continue
          }
          agents.push(candidate)
        }
        await Promise.all(agents.map(candidate => candidate.whenIdle()))

        const currentDescendants = await services.subagents.listDescendants(SessionId(sessionId))
        for (const child of currentDescendants) parents.set(String(child.id), String(child.parentId))
        if (currentDescendants.some(child => child.kind === 'diagnostic'
          || unsafe.has(String(child.id))
          || (child.activity === 'running' && !requiredIds.has(String(child.id))))) return 'unsafe'
        const currentLive = services.agents.list()
        for (const candidate of currentLive) recordParentSession(candidate)
        const currentTreeIds = liveDescendantIds([sessionId, ...currentDescendants.map(child => String(child.id))], currentLive)
        if (currentLive.some(child => currentTreeIds.has(child.id) && !requiredIds.has(child.id))) return 'unsafe'
        const settled = agents.every(candidate => {
          const current = services.agents.get(candidate.id)
          return (current === undefined || current === candidate) && candidate.status === 'idle' && inboxEmpty(candidate) && !unsafe.has(candidate.id)
            && services.jobs.list(candidate).filter(job => job.ownerSession === candidate.id)
              .every(job => TERMINAL_JOB_STATUSES.has(job.status) && !job.detail?.includes('work may be orphaned'))
        })
        return settled ? (waiting ? 'waiting' : 'safe') : 'unsafe'
      } catch { return 'unsafe' }
    },

    stats(): ParticipantStats {
      return {
        exactAgents: exact.size,
        provisional: provisional.size,
        routes: workspaces.size,
        roles: roles.size,
        judgeAdmissions: judgeAdmissions.size,
        tombstones: unsafe.size,
        lineage: parents.size,
        retainDecisions,
        releaseUnrelated,
        releaseOnDispose,
        rowProbes,
        scanFallbacks,
        realpathCalls,
      }
    },
  }
}
