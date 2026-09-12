/**
 * Host adapters: wire the real DSH services into the engine's narrow
 * interfaces (design §2.3 deployment / §4 runtime).
 */
import type { Agent, AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ManualCompactionError, type CompactionEngine } from '@deepseek-ai/dsh-compaction'
// Type-only：让 ctx.get('agentPresets') 解析到 preset 服务类型。运行期该服务
// 经 DSH 安装解析；roster 缺席（base-only profile / 旧版 dsh）时 get 返回
// undefined，走宿主平面回退——与 dsh-subagent/child-agent.ts 的用法一致。
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { JobStatus } from '@deepseek-ai/dsh-jobs'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import type { ContinuableStartSpec, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionHandle, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { StateStore } from '../state/store.ts'
import type { RunState } from '../types.ts'
import { WorkflowError } from '../types.ts'
import type { DispatchTargets, StateHost, SubagentHost, ProgramHost } from '../engine/engine.ts'
import { BUILTIN_PROGRAMS } from '../programs/catalog.ts'
import { JUDGE_REQUIRED_TOOLS, JUDGE_DEFAULT_DENY, judgeLabel, judgeSpawnPlan, knownDenyList, resolveRoleModel, roleDenyList } from '../roles/roles.ts'
import { topFrame } from '../state/invariants.ts'
import { DISPATCH_TIMEOUTS, withTimeout } from '../engine/timeouts.ts'
import { projectNodeLocal, type ProjectionSource } from '../judge/projection.ts'
import { renderJudgePrompt } from '../judge/checker.ts'

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(['completed', 'failed', 'killed'])

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

/** Optional Host service used by the continuation manager for cold Session reads. */
function sessionPersistence(ctx: Context): SessionPersistence | undefined {
  return ctx.get('sessionPersistence') as SessionPersistence | undefined
}

/**
 * Read one durable session's events without residency (F9/S2). Service absent
 * → undefined (the packet degrades without the actor surface — logged by the
 * caller). A present-but-failing persistence read is a technical fault (A1
 * R12 "Session/持久化/读取异常"): it throws so the engine fail-closes into a
 * `judge fault: <detail>` BLOCK instead of judging from a silently truncated
 * packet.
 */
async function inspectPersistedSession(ctx: Context, sessionId: string): Promise<ProjectionSource | undefined> {
  const persistence = sessionPersistence(ctx)
  if (persistence === undefined) return undefined
  const controller = new AbortController()
  let handle: SessionHandle | undefined
  try {
    // #32 D-002：controller 必须真正接线，超时即 abort —— 否则留下一个永不中断的
    // 只读观察者。0.1.5 起持久化改为 SessionHandle：open('read') 不取写所有权，
    // read 的 signal 直达后端读（旧 prepareCore 不转发 signal 的缺陷随之消失）；
    // finally 中的 close 保证超时后迟到的读也不泄漏句柄。
    handle = await withTimeout(persistence.open(SessionId(sessionId), 'read', { signal: controller.signal }),
      DISPATCH_TIMEOUTS.availability, 'availability', controller)
    const result = await withTimeout(handle.read(0, undefined, { signal: controller.signal }),
      DISPATCH_TIMEOUTS.availability, 'availability read', controller)
    const events = result.events.slice()
    return {
      id: handle.header.id,
      snapshotEvents: () => events,
      seq: events.length > 0 ? events[events.length - 1]!.seq + 1 : 0,
    }
  } catch (error) {
    if (error instanceof SessionPersistenceNotFoundError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new WorkflowError(`actor session projection failed: ${detail}`)
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Only a typed NotFound proves absence; all other persistence uncertainty preserves identity. */
async function sessionAvailability(ctx: Context, sessionId: string): Promise<import('../engine/engine.ts').SessionAvailability> {
  if (ctx.agents.get(SessionId(sessionId)) !== undefined) return 'available'
  const persistence = sessionPersistence(ctx)
  if (persistence === undefined) return 'unknown'
  try {
    const source = await inspectPersistedSession(ctx, sessionId)
    return source?.id === sessionId ? 'available' : 'unknown'
  } catch (error) {
    return error instanceof SessionPersistenceNotFoundError ? 'missing' : 'unknown'
  }
}

/**
 * Fail-closed Judge tool-surface assertion (design §2.2/E2 + A1 R9, Issue #25).
 *
 * The surface is the full catalog minus the deny list, so the check has two
 * halves: every required tool must be present, and no denied tool may be
 * visible. Own-scope delegation machinery is never visible-filtered (design
 * §2.2) and is exempt from the deny check. Exported for direct unit testing.
 */
export function evaluateJudgeToolSurface(visibleNames: Iterable<string>, deny: readonly string[] = JUDGE_DEFAULT_DENY): string | undefined {
  const visible = new Set(visibleNames)
  for (const required of JUDGE_REQUIRED_TOOLS) {
    if (!visible.has(required)) return `Judge tool surface is missing required tool "${required}"`
  }
  for (const name of visible) {
    if (deny.includes(name)) return `Judge tool surface contains denied tool "${name}"`
  }
  return undefined
}

function assertJudgeToolSurface(childAgent: Agent, deny: readonly string[]): string | undefined {
  return evaluateJudgeToolSurface(childAgent.ctx.tools.schemas(childAgent).map(s => s.name), deny)
}

function textBlocks(text: string) {
  return [{ type: 'text' as const, text }]
}

/** Readable detail for a compaction-path failure (never wraps WorkflowError). */
function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** ManualCompactionError detail (`compaction <code>: <message>`), else the plain message. */
function compactErrorDetail(error: unknown): string {
  if (error instanceof ManualCompactionError) return `compaction ${error.code}: ${error.message}`
  return errorDetail(error)
}

/**
 * 该 agent 会话平面所拥有的压缩后端。
 *
 * dsh 0.1.1-rc.7 引入 agent presets 后，`compaction` 不再挂载在宿主平面
 * （web-app bundle 显式禁用宿主平面副本），而是由每个会话的 preset 在自己
 * 的 isolate 域挂载；宿主插件行 inject 它只会永久 `waiting for service` 并
 * 卡死 boot。按目标 agent 解析：先经 `agentPresets.serviceFor` 取该 agent
 * 自己的 preset 实例（"请求来自会话外部、操作目标是某个会话"的规范读法），
 * preset 未挂或 roster 缺席再回退宿主平面挂载（base-only profile / 旧版
 * dsh）；两者都无 → undefined，调用方按良性跳过处理并告警。
 */
function compactionFor(ctx: Context, agent: Agent): CompactionEngine | undefined {
  const presets = ctx.get('agentPresets')
  return presets?.serviceFor(agent, 'compaction') ?? ctx.get('compaction')
}

/** 无任何压缩后端时的良性跳过（与 "no actor mapped" 同级），附 host 侧告警。 */
function noCompactionBackend(ctx: Context, sessionId: string): { ok: true; detail: string } {
  ctx.logger.warn(`workflow boundary compact skipped: session ${sessionId} has no compaction backend (neither its agent preset nor the host plane mounts one)`)
  return { ok: true, detail: 'no compaction backend; boundary compact skipped' }
}

/** Durable host-authored provenance for every workflow dispatch. */
const PLUGIN_SOURCE = { kind: 'plugin' as const, plugin: 'dsh-agent-team-workflow' }

/**
 * Queue one dispatcher turn to a continuable child, bounded by the `send` SLO.
 * Every send site shares this shape so the timeout and the abort wiring cannot
 * drift apart per caller.
 */
async function queueDispatch(subagents: SubagentRuntime, parent: Agent, childId: string, text: string): Promise<string> {
  const controller = new AbortController()
  return withTimeout(
    queueHostSubagentPrompt(subagents, parent, SessionId(childId), textBlocks(text), PLUGIN_SOURCE, controller.signal),
    DISPATCH_TIMEOUTS.send, 'send', controller)
}

/**
 * Bounded `startContinuable` (首次角色派发 / Judge spawn, #32 D-001). The host
 * contract gives the caller's signal ownership only until inbox acceptance, so
 * a timeout here aborts the still-pending lookup/materialization instead of
 * leaving a dead signal behind.
 */
function startContinuableWithin(subagents: Pick<SubagentRuntime, 'startContinuable'>, spec: Omit<ContinuableStartSpec, 'signal'>, stage: string): ReturnType<SubagentRuntime['startContinuable']> {
  const controller = new AbortController()
  return withTimeout(subagents.startContinuable({ ...spec, signal: controller.signal }), DISPATCH_TIMEOUTS.spawn, stage, controller)
}

/** `drainContinuableChildren` takes no signal: a hang is abandoned, never awaited forever. */
function drainWithin(subagents: Pick<SubagentRuntime, 'drainContinuableChildren'>, parent: Agent, childIds: readonly SessionId[]): Promise<void> {
  return withTimeout(subagents.drainContinuableChildren(parent, childIds), DISPATCH_TIMEOUTS.drain, 'drain')
}

export function makeStateHost(source: StateStore | (() => StateStore)): StateHost {
  const store = (): StateStore => typeof source === 'function' ? source() : source
  return {
    async get(workspaceKey) {
      const row = await store().get(workspaceKey)
      if (row === undefined) return undefined
      return { run: row.run, execution: row.execution, version: row.stateVersion }
    },
    async put(workspaceKey, run, expectedVersion, changes) {
      await store().updateRow(workspaceKey, run, expectedVersion, changes)
    },
    async create(workspaceKey, run, execution) {
      const row = await store().createRow(workspaceKey, run, execution)
      return row.stateVersion
    },
    execution: (workspaceKey, executionId) => store().execution(workspaceKey, executionId),
    events: (workspaceKey, executionId, after, limit) => store().events(workspaceKey, executionId, after, limit),
    historyOwner: (workspaceKey, executionId) => store().historyOwner(workspaceKey, executionId),
    async listRuns() {
      const rows = await store().list()
      return rows.map(row => ({ workspaceKey: row.workspaceKey, run: row.run, execution: row.execution, version: row.stateVersion }))
    },
  }
}

export interface HostAdapters {
  ctx: Context
  managerAgentOf(run: RunState): Agent | undefined
  cwdOfManager(run: RunState): Promise<string | undefined>
  /** Register a fresh Judge session so the plugin can authorize its inspection + judge_claim calls. */
  registerJudgeSession(sessionId: string, cwd: string | undefined): void
  /** Revoke a Judge session's authorization (A1 R11). */
  revokeJudgeSession(sessionId: string): void
  /** Register a role-actor session↔(workspace,roleKey) mapping at creation time. */
  registerRoleActorSession(sessionId: string, roleKey: string, cwd: string | undefined): void
}

export function makeDispatchTargets(adapters: HostAdapters): DispatchTargets {
  return {
    async steerManager(run, text) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      // A1 R3: the message id is assigned synchronously by createUserMessage,
      // so the return is available even though steer() itself is fire-and-forget.
      const message = createUserMessage({
        content: textBlocks(text),
        source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' },
      })
      manager.steer(message)
      return { messageId: message.id }
    },
    async sendRoleActor(run, roleKey, text) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const childId = run.roleActors[roleKey]
      if (childId === undefined) throw new WorkflowError(`no actor mapped for role "${roleKey}"`)
      // Workflow 派发必须是独立 child turn，不可用 nearest-step sendMessage。
      const messageId = await queueDispatch(adapters.ctx.subagents, manager, childId, text)
      return { messageId }
    },
    managerSessionSeq(run) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) return 0
      return manager.session.seq
    },
  }
}

export function makeSubagentHost(adapters: HostAdapters, frozenRoute: () => { provider?: string; model?: string }): SubagentHost & { observeTurnEnd(sessionId: string): void } {
  // ponytail: plugin-lifetime保留当代Agent/祖先/unsafe证据；若长期进程的Session churn实测成问题，再随Run完成/Reset显式清理。
  const observed = new Map<string, Agent>()
  const parents = new Map<string, string>()
  const unsafe = new Set<string>()
  const recordParentSession = (agent: Agent): void => {
    const parentId = agent.session.header.parentSession
    if (parentId !== undefined) parents.set(agent.id, parentId)
  }
  const stopObservingJobs = adapters.ctx.jobs.onJobDone((job, owner) => {
    if (!owner || !job.detail?.includes('work may be orphaned')) return
    recordParentSession(owner)
    // 保留 exact owner 与当时已知祖先；descriptor 消失不能洗白父 Role。
    const seen = new Set<string>()
    for (let id: string | undefined = owner.id; id !== undefined && !seen.has(id); id = parents.get(id)) {
      seen.add(id)
      unsafe.add(id)
      const agent = observed.get(id) ?? adapters.ctx.agents.get(SessionId(id))
      if (agent !== undefined) recordParentSession(agent)
    }
  })
  adapters.ctx.effect(() => () => {
    stopObservingJobs()
    observed.clear()
    parents.clear()
    unsafe.clear()
  })
  async function judgePrompt(run: RunState, input: import('../engine/engine.ts').JudgeSpawnInput): Promise<string> {
    const manager = adapters.managerAgentOf(run)
    if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
    const executorSessionId = input.boundary.executorSessionId
    let actorSession: ProjectionSource | undefined
    if (executorSessionId !== undefined) {
      const actorAgent = adapters.ctx.agents.get(SessionId(executorSessionId))
      actorSession = actorAgent?.session ?? await inspectPersistedSession(adapters.ctx, executorSessionId)
    }
    return renderJudgePrompt({
      nodeToken: input.nodeToken,
      criteria: input.criteria,
      recovery: input.recovery,
      workerOutcome: input.claim.outcome,
      workerHandoff: input.claim.handoff,
      workspaceCwd: input.cwd,
      transcript: projectNodeLocal(manager.session, input.boundary, actorSession),
      previousFeedback: input.previousFeedback,
      managerContext: input.managerContext,
    })
  }
  return {
    observeTurnEnd(sessionId) {
      const agent = adapters.ctx.agents.get(SessionId(sessionId))
      if (agent) {
        observed.set(sessionId, agent)
        recordParentSession(agent)
      }
    },
    async safeToInspect(sessionId) {
      const agent = observed.get(sessionId) ?? adapters.ctx.agents.get(SessionId(sessionId))
      if (!agent || unsafe.has(sessionId)) return false
      try {
        await agent.whenIdle()
        const descendants = await adapters.ctx.subagents.listDescendants(SessionId(sessionId))
        if (descendants.some(child => child.kind === 'diagnostic')) return false
        for (const child of descendants) parents.set(String(child.id), String(child.parentId))
        const durableIds = new Set([sessionId, ...descendants.map(child => String(child.id))])
        if ([...durableIds].some(id => unsafe.has(id))) return false
        const requiredIds = new Set([sessionId, ...descendants
          .filter(child => child.kind === 'child' && child.activity === 'running')
          .map(child => String(child.id))])
        for (const id of durableIds) if (observed.has(id)) requiredIds.add(id)

        // Durable inactive 后代没有 Activation；registry 补齐 descriptor
        // 发布窗口中的 live 后代，以及 cold parent 之下的 live 后代。
        const live = adapters.ctx.agents.list()
        for (const candidate of live) recordParentSession(candidate)
        const treeIds = liveDescendantIds(durableIds, live)
        for (const child of live) if (treeIds.has(child.id)) requiredIds.add(child.id)

        const agents: Agent[] = []
        for (const id of requiredIds) {
          const candidate = observed.get(id) ?? adapters.ctx.agents.get(SessionId(id))
          if (!candidate || candidate.status !== 'idle' || !inboxEmpty(candidate) || unsafe.has(id)) return false
          agents.push(candidate)
        }
        await Promise.all(agents.map(candidate => candidate.whenIdle()))

        const currentDescendants = await adapters.ctx.subagents.listDescendants(SessionId(sessionId))
        for (const child of currentDescendants) parents.set(String(child.id), String(child.parentId))
        if (currentDescendants.some(child => child.kind === 'diagnostic'
          || unsafe.has(String(child.id))
          || (child.activity === 'running' && !requiredIds.has(String(child.id))))) return false
        const currentLive = adapters.ctx.agents.list()
        for (const candidate of currentLive) recordParentSession(candidate)
        const currentTreeIds = liveDescendantIds([sessionId, ...currentDescendants.map(child => String(child.id))], currentLive)
        if (currentLive.some(child => currentTreeIds.has(child.id) && !requiredIds.has(child.id))) return false
        return agents.every(candidate => {
          const current = adapters.ctx.agents.get(candidate.id)
          return (current === undefined || current === candidate) && candidate.status === 'idle' && inboxEmpty(candidate) && !unsafe.has(candidate.id)
            && adapters.ctx.jobs.list(candidate).filter(job => job.ownerSession === candidate.id)
              .every(job => TERMINAL_JOB_STATUSES.has(job.status) && !job.detail?.includes('work may be orphaned'))
        })
      } catch { return false }
    },
    async ensureRoleActor(run, roleKey, initialText) {
      const existing = run.roleActors[roleKey]
      if (existing !== undefined) {
        // Not expected: the engine checks this before calling. Followup is the
        // correct continuation for an existing mapping.
        const manager = adapters.managerAgentOf(run)
        if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
        const messageId = await queueDispatch(adapters.ctx.subagents, manager, existing, initialText)
        return { childId: existing, messageId }
      }
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const roleDef = run.definitionSnapshot.roles[roleKey]
      if (roleDef === undefined) throw new WorkflowError(`unknown role "${roleKey}"`)
      const route = resolveRoleModel(run, roleKey, frozenRoute())
      const deny = roleDenyList(run, roleKey)
      const started = await startContinuableWithin(adapters.ctx.subagents, {
        provider: 'spawn',
        label: `workflow-role:${roleKey}`,
        request: {
          prompt: textBlocks(initialText),
          parent: manager,
          persona: roleDef.persona,
          toolFilter: deny.length > 0 ? { deny } : undefined,
          agentOptions: route.provider !== undefined || route.model !== undefined
            ? { provider: route.provider, model: route.model }
            : undefined,
        },
      }, `spawn role ${roleKey}`)
      // Record the session mapping IMMEDIATELY at creation — the child's first
      // turn may end before the engine persists roleActors, and its node_claim
      // authorization needs this mapping.
      adapters.registerRoleActorSession(started.childId, roleKey, manager.session.header.cwd)
      return { childId: started.childId, messageId: started.messageId }
    },

    async startJudge(run, input) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const plan = judgeSpawnPlan(run, frozenRoute())

      // 首次、followup 与 respawn 都从同一当前工作单材料重建完整 packet。
      const prompt = await judgePrompt(run, input)

      // `ctx.tools.restrict()` 拒绝它不认识的 global 工具名并抛错（fail-closed
      // dispatch fault）。默认 deny 清单里的宿主工具（如 `edit`/`write`）在精简
      // profile 中并不存在，deny 一个不存在的工具本就是 no-op，因此按 Judge 继承
      // 到的实际工具面求交集，而不是让 spawn 直接 fault。
      const deny = knownDenyList(plan.toolFilter.deny, adapters.ctx.tools.schemas(manager).map(schema => schema.name))

      const started = await startContinuableWithin(adapters.ctx.subagents, {
        provider: 'spawn',
        label: judgeLabel(topFrame(run).nodeId),
        // P1: use the engine-reserved id, which was persisted BEFORE child
        // admission; the child may begin judging as soon as the prompt is
        // accepted, so an Engine-returned id would arrive too late.
        childId: SessionId(input.judgeSessionId),
        request: {
          prompt: textBlocks(prompt),
          parent: manager,
          persona: plan.persona,
          toolFilter: deny.length > 0 ? { deny } : undefined,
          agentOptions: plan.agentOptions.provider !== undefined || plan.agentOptions.model !== undefined
            ? { provider: plan.agentOptions.provider, model: plan.agentOptions.model }
            : undefined,
        },
      }, 'spawn judge')

      // Fail-closed tool-surface assertion over the freshly published child
      // (CONTEXT.md "每次 spawn 后对 Judge final visible schema 做 fail-closed
      // 断言"): an unobservable child is itself a fault, never a pass.
      const childAgent = adapters.ctx.agents.get(started.childId)
      if (childAgent === undefined) {
        await drainWithin(adapters.ctx.subagents, manager, [started.childId]).catch(() => {})
        adapters.revokeJudgeSession(started.childId)
        throw new WorkflowError('judge child agent is not observable after spawn')
      }
      const surfaceProblem = assertJudgeToolSurface(childAgent, deny)
      if (surfaceProblem !== undefined) {
        // Drain the judge we just spawned and surface the detail.
        await drainWithin(adapters.ctx.subagents, manager, [started.childId]).catch(() => {})
        adapters.revokeJudgeSession(started.childId)
        throw new WorkflowError(surfaceProblem)
      }
      adapters.registerJudgeSession(started.childId, input.cwd)
      return { judgeSessionId: started.childId, messageId: started.messageId }
    },

    async judgeSessionAvailability(judgeSessionId) {
      return sessionAvailability(adapters.ctx, judgeSessionId)
    },

    async roleSessionAvailability(roleSessionId) {
      return sessionAvailability(adapters.ctx, roleSessionId)
    },

    async followupJudge(run, judgeSessionId, input) {
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      const messageId = await queueDispatch(adapters.ctx.subagents, manager, judgeSessionId, await judgePrompt(run, input))
      adapters.registerJudgeSession(judgeSessionId, input.cwd)
      return { messageId }
    },

    async retireJudge(run, judgeSessionId) {
      // A1 R11: revoke authorization only. Never drain from inside the Judge's
      // own judge_claim tool call — DSH's dispose() cancels the caller's turn
      // and awaits its quiescence (a self-deadlock); the settlement watcher
      // releases the Activation automatically once the Judge's turn ends.
      void run
      adapters.revokeJudgeSession(judgeSessionId)
    },

    async drainJudge(run, judgeSessionId) {
      const manager = adapters.managerAgentOf(run)
      adapters.revokeJudgeSession(judgeSessionId)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      // #32 D-001：drain 无 signal 形参，挂起只能放弃等待（fail-closed），不能永久 pending。
      await drainWithin(adapters.ctx.subagents, manager, [SessionId(judgeSessionId)])
    },

    async drainRoleActor(run, roleKey) {
      const childId = run.roleActors[roleKey]
      if (childId === undefined) return
      const manager = adapters.managerAgentOf(run)
      if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
      // 与 Judge 同一条有界路径：`drainContinuableChildren` 无 signal，挂起即放弃等待；
      // 失败由引擎降级为仅删映射撤权（reuse: node 的离开节点释放）。冷会话是 no-op。
      await drainWithin(adapters.ctx.subagents, manager, [SessionId(childId)])
    },

    async compactRoleActor(run, roleKey) {
      const childId = run.roleActors[roleKey]
      if (childId === undefined) return { ok: true, detail: 'no actor mapped' }
      // #21 F1：这条链上的每一段都可能有真实模型调用/静默拆卸，全部加超时并把
      // signal 接成真实中断源（此前 abort 从不触发，signal 形同装饰）。
      const controller = new AbortController()
      const signal = controller.signal
      // A4 plan A (docs/prd/20260903-workflow-hardening/a4-code-findings.md §3):
      // the settlement watcher releases the actor's Activation right after its
      // turn, and the next dispatch always follows a full Judge cycle, so the
      // actor is cold at this point on every cross-node path. Compact a COLD
      // actor by materializing it WITHOUT a prompt (no turn starts), running
      // compactNow on the idle agent (its result is durably flushed before it
      // resolves), then releasing the handle so the dispatch followup
      // cold-resumes the compacted surface.
      const resident = adapters.ctx.agents.get(childId as SessionId)
      if (resident !== undefined) {
        const compaction = compactionFor(adapters.ctx, resident)
        if (compaction === undefined) return noCompactionBackend(adapters.ctx, childId)
        // 收口后仍可能被外部唤醒；busy 必须拒绝，不能以FIFO排队冒充compact通过。
        try {
          const result = await withTimeout(compaction.compactNow(resident, signal), DISPATCH_TIMEOUTS.compactNow, 'compactNow', controller)
          if (result === null) return { ok: true, detail: 'no compactable range' }
          return { ok: true, detail: `compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens)` }
        } catch (error) {
          if (error instanceof ManualCompactionError && error.code === 'busy') {
            return { ok: false, detail: 'resident actor busy' }
          }
          return { ok: false, detail: compactErrorDetail(error) }
        }
      }
      const route = resolveRoleModel(run, roleKey, frozenRoute())
      const manager = adapters.managerAgentOf(run)
      const resuming = adapters.ctx.agents.resume({
          resumeSessionId: childId as SessionId,
          // Mirrors the agentOptions the continuation manager re-applies when
          // IT cold-resumes this child. This is only the summarizer's LAST
          // fallback (compaction summarization* config > the session's own
          // latest routed request), so the summary model may differ from the
          // actor's model.
          agentOptions: route.provider !== undefined || route.model !== undefined ? route : undefined,
          // Maintenance materialization must join the parent preset too: the
          // compaction backend (and every model-facing row) lives in the
          // preset's isolate domain, and an unjoined agent resolves no backend
          // via serviceFor (dsh also warns about publishing unjoined agents).
          // Mirrors applyChildComposition's join step only — persona/tool
          // filter are turn-facing and irrelevant to a compact-only surface.
          // Join failure degrades to the host-plane fallback / skip below, so
          // it is logged rather than failing the resume.
          ...(manager === undefined ? {} : {
            setup: ((agentCtx: Context) => {
              try {
                agentCtx.get('agentPresets')?.composeFrom(agentCtx, manager.ctx)
              } catch (error) {
                agentCtx.logger.warn(`workflow maintenance preset join skipped: ${errorDetail(error)}`)
              }
            }) satisfies AgentSetup,
          }),
      })
      let handle: AgentHandle
      try {
        handle = await withTimeout(resuming, DISPATCH_TIMEOUTS.coldMaterialize, 'coldMaterialize', controller)
      } catch (error) {
        // 超时后迟到的物化同样必须释放：遗留 resident agent 会让后续冷 resume
        // 在 registry id 上冲突（见下方 teardown 注释）。#32 D-004：释放本身也要收口，
        // 否则一个卡住的 dispose 会变成后台永久 pending 的 promise。
        resuming.then(late => void withTimeout(late.dispose(), DISPATCH_TIMEOUTS.dispose, 'dispose late').catch(() => {}), () => {})
        return { ok: false, detail: `cold materialize failed: ${errorDetail(error)}` }
      }
      let outcome: { ok: boolean; detail: string }
      try {
        const compaction = compactionFor(adapters.ctx, handle.agent)
        if (compaction === undefined) {
          outcome = noCompactionBackend(adapters.ctx, childId)
        } else {
          const result = await withTimeout(compaction.compactNow(handle.agent, signal), DISPATCH_TIMEOUTS.compactNow, 'compactNow', controller)
          outcome = result === null
            ? { ok: true, detail: 'cold: no compactable range' }
            : { ok: true, detail: `cold compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens)` }
        }
      } catch (error) {
        outcome = { ok: false, detail: compactErrorDetail(error) }
      }
      // ALWAYS tear the materialization down: a leaked resident agent would
      // collide on the registry id inside the dispatch followup's cold resume.
      try {
        await withTimeout(handle.dispose(), DISPATCH_TIMEOUTS.dispose, 'dispose', controller)
      } catch (error) {
        return { ok: false, detail: `cold materialize teardown failed: ${errorDetail(error)}` }
      }
      return outcome
    },
  }
}

export function makeProgramHost(adapters: HostAdapters): ProgramHost {
  return {
    async run(_run, programId, parameters, cwd) {
      const def = BUILTIN_PROGRAMS[programId]
      if (def === undefined) return { kind: 'ERROR', reason: `unknown program ${programId}` }
      return def.run({ cwd }, parameters)
    },
  }
}
