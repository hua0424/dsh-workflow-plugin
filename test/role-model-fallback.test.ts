/**
 * Issue #235 验收：Role Actor 单备用模型安全恢复闭环
 * （规格 docs/specs/role-model-fallback.md，ADR-0004）。
 *
 * seam：真实 Engine + 临时 SQLite（绝不触真实 DSH home）+ 受控 Host。替身只记录
 * 每次 spawn 的 agentOptions，路由取值直接消费生产决策函数 `resolveRoleModel`，
 * 不复刻优先级。故障事实用生产投影 `turnEndFailure` / `turnEndFailureFacts` 从
 * Host 的 `turn/end` 结构构造，避免测试自造一套分类语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, CatalogValidationError } from '../src/catalog/validate.ts'
import { checkCatalogProviders, collectRoleRoutes } from '../src/catalog/provider-check.ts'
import { classifyActorFailure, describeActorFailure } from '../src/engine/failover.ts'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import { turnEndFailure, turnEndFailureFacts, type TurnEndFact } from '../src/plugin/turn-end.ts'
import { judgeSpawnPlan, resolveRoleModel } from '../src/roles/roles.ts'
import { StateStore } from '../src/state/store.ts'
import { routeToAgentOptions, type RunState, type SpawnAgentOptions, type WorkflowConfig } from '../src/types.ts'
import { businessEqual, loadDraft, previewDraft, setRoleFallbackModel, undo } from '../src/editor/draft.ts'
import { serializeLayout } from '../src/editor/layout.ts'
import { buildClientBundle, bundleSources } from '../web-client/build.mjs'

function load(yaml: string, workflowId = 'role-model-fallback'): WorkflowConfig {
  return validateAndNormalize(parseCatalogConfig(yaml), { workflowId })
}

const CATALOG = (roles: string): string => `
schemaVersion: agent-workflow/v3
roles:
${roles}
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Work is complete., target: { return: done } }
`

const CONFIG = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: primary, modelId: primary-model }
    fallbackModel: { provider: backup, modelId: backup-model }
  plain:
    persona: Plain persona.
    model: { provider: primary, modelId: primary-model }`))

// ---- catalog 校验：配置形状与主备差异 ----

test('#235 备用路由随归档 schema 归一，键序落在主模型之后', () => {
  const config = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: m1 }
    fallbackModel: { provider: p2, modelId: m2, reasoningEffort: "  high  " }`))
  assert.deepEqual(config.roles.worker!.fallbackModel, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' })
  assert.deepEqual(Object.keys(config.roles.worker!), ['persona', 'model', 'fallbackModel', 'reuse', 'compactBeforeReuse'])
})

test('#235 主备只有档位不同不构成备用路由，静态拒绝', () => {
  assert.throws(() => load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: m1, reasoningEffort: low }
    fallbackModel: { provider: p1, modelId: m1, reasoningEffort: high }`)), (error: unknown) => {
    assert.ok(error instanceof CatalogValidationError)
    assert.match(error.message, /worker" fallbackModel must differ from model by provider\/modelId/)
    return true
  })
})

test('#235 不同 provider 的同名 modelId 是合法备用路由', () => {
  const config = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: same-model }
    fallbackModel: { provider: p2, modelId: same-model }`))
  assert.equal(config.roles.worker!.fallbackModel!.provider, 'p2')
})

test('#235 备用路由档位空白值防御性拒绝；judgeRole.fallbackModel 仍属 #236 被 schema 拒绝', () => {
  const handBuilt = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: p1, modelId: m1 }`))
  handBuilt.roles.worker!.fallbackModel = { provider: 'p2', modelId: 'm2', reasoningEffort: '   ' }
  assert.throws(() => validateAndNormalize(handBuilt, { workflowId: 'w' }), CatalogValidationError, /fallbackModel reasoningEffort must be a non-empty string/)

  assert.throws(() => parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  worker: { persona: W. }
judgeRole:
  persona: Judge persona.
  fallbackModel: { provider: p2, modelId: m2 }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: Plan is complete., target: { return: done } }
`), /fallbackModel|Unrecognized/)
})

// ---- 故障资格判定：只按结构化事实分类，不解析 message ----

test('#235 只有 5xx / 429 / 网络 / 请求超时算合格故障', () => {
  assert.deepEqual(classifyActorFailure({ code: 'SERVER', status: 503 }), { eligible: true, kind: 'server-5xx' })
  assert.deepEqual(classifyActorFailure({ code: 'UPSTREAM', status: 502 }), { eligible: true, kind: 'server-5xx' })
  assert.deepEqual(classifyActorFailure({ code: 'RATE_LIMIT', status: 429 }), { eligible: true, kind: 'rate-limited' })
  assert.deepEqual(classifyActorFailure({ code: 'TIMEOUT' }), { eligible: true, kind: 'request-timeout' })
  assert.deepEqual(classifyActorFailure({ code: 'TRANSPORT' }), { eligible: true, kind: 'network-transport' })
})

test('#235 认证/额度/参数/上下文/工具/来源不明一律不合格（fail-closed）', () => {
  assert.deepEqual(classifyActorFailure({ code: 'QUOTA', status: 402 }), { eligible: false, kind: 'quota-exhausted' })
  assert.deepEqual(classifyActorFailure({ code: 'ACCOUNT_QUOTA' }), { eligible: false, kind: 'quota-exhausted' })
  assert.deepEqual(classifyActorFailure({ code: 'AUTH', status: 401 }), { eligible: false, kind: 'auth-failed' })
  assert.deepEqual(classifyActorFailure({ code: 'INVALID_CREDENTIAL' }), { eligible: false, kind: 'auth-failed' })
  assert.deepEqual(classifyActorFailure({ code: 'INVALID_REQUEST', status: 400 }), { eligible: false, kind: 'invalid-request' })
  assert.deepEqual(classifyActorFailure({ code: 'CONTEXT_WINDOW_EXCEEDED' }), { eligible: false, kind: 'context-window' })
  assert.deepEqual(classifyActorFailure({ code: 'IMAGE_OFFLOAD_REQUIRED' }), { eligible: false, kind: 'image-offload' })
  assert.deepEqual(classifyActorFailure({ code: 'UNKNOWN' }), { eligible: false, kind: 'unclassified' })
  assert.deepEqual(classifyActorFailure({ code: 'SOMETHING_NEW', status: 418 }), { eligible: false, kind: 'http-418' })
  assert.deepEqual(classifyActorFailure(undefined), { eligible: false, kind: 'unstructured' })
})

test('#235 诊断串只记 code/status，不落 message 正文', () => {
  assert.equal(describeActorFailure({ code: 'SERVER', status: 503 }), 'code=SERVER status=503')
  assert.equal(describeActorFailure({ code: 'TIMEOUT' }), 'code=TIMEOUT')
})

// ---- 路由阶段解析 ----

test('#235 resolveRoleModel：主/备/人工三态各自生效，缺省状态保持旧优先级', () => {
  const run = new WorkflowEngine(
    { async steerManager() { return { messageId: 'm' } }, async sendRoleActor() { return { messageId: 'm' } }, managerSessionSeq() { return 0 } },
    {} as SubagentHost, { async run() { throw new Error('no programs') } }, { async get() { return undefined }, async put() {}, async create() { return 1 }, async listRuns() { return [] }, async execution() { return undefined }, async events() { return [] }, async historyOwner() { return undefined } },
  ).buildInitialRun('manager', 'role-model-fallback', CONFIG, 'hash')
  const frozen = { provider: 'frozen', modelId: 'frozen-model' }
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'primary', modelId: 'primary-model' })

  run.roleRoutes = { worker: { stage: 'fallback' } }
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'backup', modelId: 'backup-model' })

  run.roleRoutes = { worker: { stage: 'manual' } }
  run.modelOverrides.worker = { provider: 'manual', modelId: 'manual-model' }
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'manual', modelId: 'manual-model' })

  // 旧 Run：没有 roleRoutes 但带 override → 按人工轮解释（不回退到主模型）。
  run.roleRoutes = undefined
  assert.deepEqual(resolveRoleModel(run, 'worker', frozen), { provider: 'manual', modelId: 'manual-model' })
})

test('#235 备用路由进入启动前静态校验行（误配阻断启动）', () => {
  assert.deepEqual(collectRoleRoutes(CONFIG).map(route => route.role), ['worker', 'worker（备用模型）', 'plain', 'judge'])
  const missing = checkCatalogProviders('role-model-fallback', CONFIG, ['primary'])
  assert.equal(missing.ok, false)
  const backup = missing.rows.find(row => row.role === 'worker（备用模型）')!
  assert.equal(backup.ok, false)
  assert.match(backup.reason, /backup.*未在当前 profile 注册/)
  const accepted = checkCatalogProviders('role-model-fallback', CONFIG, ['primary', 'backup'])
  assert.equal(accepted.ok, true)
})

// ---- 引擎：真实 Runtime 接缝 ----

interface Spawn { label: string; agentOptions?: SpawnAgentOptions; text?: string }

function endOf(reason: unknown): { text: string | undefined; facts: { code: string; status?: number } | undefined } {
  const events: TurnEndFact[] = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { id: 'u-dispatch' } },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason } },
  ]
  return { text: turnEndFailure(events, events[2]!), facts: turnEndFailureFacts(events[2]!) }
}

const FAILOVER_503 = endOf({ kind: 'error', error: { message: 'upstream exploded', code: 'SERVER', status: 503 } })
const QUOTA_402 = endOf({ kind: 'error', error: { message: 'insufficient balance', code: 'QUOTA', status: 402 } })

function harness(config: WorkflowConfig = CONFIG) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-role-fallback-'))
  const spawns: Spawn[] = []
  const messages: string[] = []
  let serial = 0
  let store = new StateStore(home)

  function build(forStore: StateStore): WorkflowEngine {
    const subagents: SubagentHost = {
      async ensureRoleActor(run, roleKey, initialText) {
        spawns.push({ label: `role:${roleKey}`, agentOptions: routeToAgentOptions(resolveRoleModel(run, roleKey, run.delegationRoute)), text: initialText })
        return { childId: `child-${++serial}`, messageId: `message-${serial}` }
      },
      async startJudge(run: RunState, input: JudgeSpawnInput) {
        spawns.push({ label: 'judge', agentOptions: routeToAgentOptions(judgeSpawnPlan(run, run.delegationRoute).agentOptions) })
        return { judgeSessionId: input.judgeSessionId, messageId: `message-${++serial}` }
      },
      async followupJudge() { return { messageId: `message-${++serial}` } },
      async judgeSessionAvailability() { return 'available' as const },
      async roleSessionAvailability() { return 'available' as const },
      async retireJudge() {},
      async drainJudge() {},
      async drainRoleActor() {},
      async compactRoleActor() { throw new Error('no cross-node boundary in this fixture') },
      async safeToInspect() { return 'safe' as const },
    }
    const engine = new WorkflowEngine({
      async steerManager(_run, text) { messages.push(text); return { messageId: 'manager-message' } },
      async sendRoleActor(_run, roleKey, text) { spawns.push({ label: `send:${roleKey}`, text }); return { messageId: `message-${++serial}` } },
      managerSessionSeq() { return 0 },
    }, subagents, { async run() { throw new Error('no programs') } }, makeStateHost(forStore))
    engine.cwdResolver = async () => 'cwd'
    return engine
  }

  let engine = build(store)
  const h = {
    home, spawns, messages,
    get store() { return store },
    get engine() { return engine },
    async row() { return (await store.get('ws'))! },
    async start() {
      const run = engine.buildInitialRun('manager', 'role-model-fallback', config, 'hash')
      const outcome = await engine.startRun('ws', run, undefined, 'root request')
      assert.equal(outcome.ok, true, JSON.stringify(outcome))
      const row = await h.row()
      return { sessionId: row.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    },
    /** 把执行推进到 worker 节点的 working 派发，返回该派发的 caller。 */
    async toWorker() {
      const plan = await h.row()
      const planCaller = { sessionId: plan.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([plan.execution.dispatch!.messageId!]) }
      assert.equal((await engine.handleClaim('ws', { result: 'succeeded', handoff: 'plan handoff' }, planCaller)).ok, true)
      await engine.handleTurnEnded('ws', planCaller)
      const checking = await h.row()
      assert.equal(checking.execution.phase, 'checking')
      const judge = { sessionId: checking.execution.judge!.sessionId!, turnUserMessageIds: new Set([checking.execution.judge!.messageId!]) }
      checking.execution.judge!.settled = true
      await store.updateRow('ws', checking.run, checking.stateVersion, [{ execution: checking.execution, expectedRevision: checking.execution.revision, events: [] }])
      assert.equal((await engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
      await engine.drive('ws')
      return h.caller()
    },
    async caller() {
      const row = await h.row()
      return { sessionId: row.execution.dispatch!.sessionId!, turnUserMessageIds: new Set([row.execution.dispatch!.messageId!]) }
    },
    /** 关库重开：同一 home 新建 Store/Engine（预算与激活路由必须来自持久化行）。 */
    reopen() {
      store.close()
      store = new StateStore(home)
      engine = build(store)
    },
    close() { store.close(); rmSync(home, { recursive: true, force: true }) },
  }
  return h
}

function lastRoleSpawn(spawns: Spawn[]): Spawn {
  const spawn = spawns.filter(entry => entry.label === 'role:worker').at(-1)
  assert.ok(spawn, 'role:worker spawn expected')
  return spawn
}

test('#235 5xx 且已安全收口：自动切备用并重派，Manager 收到通知而非批准请求', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    const failedSession = (await h.row()).execution.dispatch!.sessionId
    const before = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)

    const row = await h.row()
    assert.equal(row.run.status, 'running', '切换后继续运行，不是 BLOCK')
    assert.equal(row.execution.phase, 'working')
    assert.equal(row.execution.nodeId, 'work')
    assert.equal(row.execution.blockReason, null)
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    assert.notEqual(row.run.roleActors.worker, failedSession, '旧路由会话不再被复用')

    const respawn = h.spawns.slice(before)
    assert.equal(respawn.length, 1, '只重新派发一次')
    assert.equal(respawn[0]!.label, 'role:worker')
    assert.equal(respawn[0]!.agentOptions?.provider, 'backup')
    assert.equal(respawn[0]!.agentOptions?.model, 'backup-model')
    assert.equal(respawn[0]!.agentOptions?.reasoningEffort, undefined, '省略档位 = 备用模型默认档位')
    assert.match(respawn[0]!.text!, /\[模型故障切换\]/)
    assert.match(respawn[0]!.text!, /\[中断恢复\]/)
    assert.match(respawn[0]!.text!, /code=SERVER status=503/)
    assert.doesNotMatch(respawn[0]!.text!, /upstream exploded/, '诊断脱敏：不带错误正文')

    const notices = h.messages.filter(message => message.includes('Workflow MODEL FALLBACK'))
    assert.equal(notices.length, 1, '一次切换只通知一次（多生命周期信号不重复切换）')
    assert.match(notices[0]!, /Workflow MODEL FALLBACK: role=worker primary\/primary-model → backup\/backup-model（fallback，本轮第 1 次自动切换，原因 server-5xx code=SERVER status=503）/)
    assert.match(notices[0]!, /无需批准/)
    assert.deepEqual((await h.store.events('ws', row.execution.executionId)).map(event => event.type).slice(-2), ['model-changed', 'actor-arranged'])

    const status = await h.engine.status('ws', 'manager')
    assert.equal(status.ok, true)
    const routes = (status as { status: { routes: Array<Record<string, unknown>> } }).status.routes
    assert.deepEqual(routes, [{ role: 'worker', stage: 'fallback', route: 'backup/backup-model', fallback: 'backup/backup-model', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 }])
  } finally { h.close() }
})

test('#235 已执行外部写后故障：材料保留事实，新执行先核验再续作（不盲目重复）', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    // 上一执行（主路由）已经做过外部写（推送分支、合并 PR、改文件）——这些副作用
    // 不随 turn/end 失败回滚，切换后必须让新执行先核验，而不是从材料里“看不出就重做”。
    const before = await h.row()
    const materials = before.execution.input

    // F-2：配置了备用但尚未切换的角色也可见（stage=primary），不必猜是否参与切换链。
    const beforeStatus = (await h.engine.status('ws', 'manager')) as { status: { routes: Array<Record<string, unknown>> } }
    assert.deepEqual(beforeStatus.status.routes, [{ role: 'worker', stage: 'primary', route: 'primary/primary-model', fallback: 'backup/backup-model', reason: null, autoSwitches: 0 }])

    const spawnsBefore = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)

    const row = await h.row()
    assert.equal(row.run.status, 'running', '合格故障 + 安全收口 → 切换而不是 BLOCK')
    const dispatch = h.spawns.slice(spawnsBefore).at(-1)!
    assert.equal(dispatch.label, 'role:worker')
    const text = dispatch.text!
    // 恢复材料保留事实：节点原始材料仍在派发正文里。
    assert.ok(text.includes(materials), '节点材料原样保留')
    assert.equal(row.execution.input, materials, '切换不改写节点材料')
    assert.equal(row.execution.inputVersion, before.execution.inputVersion + 1)
    // 新执行先核验既有外部操作结果，而不是盲目重复。
    assert.match(text, /\[模型故障切换\]/)
    assert.match(text, /先用工具核验已执行外部操作的真实结果/)
    assert.match(text, /已完成的不要重复执行/)
    assert.match(text, /无法核验或存在不确定副作用时保持 BLOCK/)
    assert.match(text, /\[中断恢复\]/)
  } finally { h.close() }
})

test('#235 备用也失败 → BLOCK；node_resume 与关库重开都不刷新预算', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const onBackup = await h.caller()
    await h.engine.handleTurnEnded('ws', onBackup, FAILOVER_503.text, FAILOVER_503.facts)

    let row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /^actor-turn-ended-without-result \| turn-end reason=error code=SERVER status=503/)
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    const token = row.execution.nodeToken

    // 关库重开：激活路由与预算来自持久化行。
    h.reopen()
    row = await h.row()
    assert.deepEqual(row.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })

    const before = h.spawns.length
    assert.equal((await h.engine.handleResume('ws', token, '重试一次，先核验实际完成情况', 'manager', 'actor')).ok, true)
    const resumed = await h.row()
    assert.equal(resumed.execution.phase, 'working')
    assert.equal(resolveRoleModel(resumed.run, 'worker', resumed.run.delegationRoute).provider, 'backup', 'resume 仍走备用，不刷新回主模型')
    assert.deepEqual(resumed.run.roleRoutes, { worker: { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 } })
    // 追加断言：复用同一备用会话（不重新物化到主模型）。
    assert.equal(h.spawns.slice(before).filter(entry => entry.label === 'role:worker').length, 0)

    // 备用再次合格故障：预算已耗尽，直接 BLOCK（不消耗别的路由）。
    const retry = await h.caller()
    await h.engine.handleTurnEnded('ws', retry, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
  } finally { h.close() }
})

test('#235 不合格故障（额度耗尽）保留 BLOCK，不消耗路由预算', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    const before = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, QUOTA_402.text, QUOTA_402.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /code=QUOTA status=402/)
    assert.equal(row.run.roleRoutes, undefined)
    assert.equal(h.spawns.length, before, '不额外派发/不重试主模型')
    assert.equal(row.execution.dispatch?.settled, false, '失败派发保持原状，未伪造收口')
  } finally { h.close() }
})

test('#235 已接受 claim 后失败：仍按既有语义判定（不切换、不撤销 claim）', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    assert.equal((await h.engine.handleClaim('ws', { result: 'succeeded', handoff: 'work handoff' }, worker)).ok, true)
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.equal(row.run.roleRoutes, undefined, 'claim 已接受 → 不切换路由')
    assert.equal(row.execution.claim?.result, 'succeeded', '已接受 claim 不被撤销')
    const judge = h.spawns.filter(entry => entry.label === 'judge').at(-1)
    assert.ok(judge, '判定照旧派发（claim 已接受 → 走 Judge，不换模）')
  } finally { h.close() }
})

test('#235 无备用路由的角色完全保持旧行为', async () => {
  const noFallback = load(CATALOG(`  worker:
    persona: Worker persona.
    model: { provider: primary, modelId: primary-model }`))
  const h = harness(noFallback)
  try {
    await h.start()
    const worker = await h.toWorker()
    const before = h.spawns.length
    await h.engine.handleTurnEnded('ws', worker, FAILOVER_503.text, FAILOVER_503.facts)
    const row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.match(row.execution.blockReason!, /^actor-turn-ended-without-result \| turn-end reason=error code=SERVER status=503/)
    assert.equal(row.run.roleRoutes, undefined)
    assert.equal(h.spawns.length, before)
  } finally { h.close() }
})

test('#235 Manager 显式设置模型开新一轮：C → 主模型 → 备用 → BLOCK', async () => {
  const h = harness()
  try {
    await h.start()
    const worker = await h.toWorker()
    await h.engine.handleTurnEnded('ws', worker, QUOTA_402.text, QUOTA_402.facts)

    // C 可与主/备用相同：先钉住「相同也接受」，再走真正的 C。
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'primary', 'primary-model', 'manager')).ok, true)
    let row = await h.row()
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'manual', reason: 'manager-set', autoSwitches: 0 })
    assert.equal((await h.engine.handleSetRoleModel('ws', 'worker', 'manual', 'manual-model', 'manager')).ok, true)
    row = await h.row()
    assert.deepEqual(row.run.modelOverrides.worker, { provider: 'manual', modelId: 'manual-model' })

    const token = row.execution.nodeToken
    assert.equal((await h.engine.handleResume('ws', token, '换模型后继续', 'manager', 'actor')).ok, true)
    assert.equal(lastRoleSpawn(h.spawns).agentOptions?.provider, 'manual')

    // C 合格故障 → 回主模型 A（预算 1）。
    const manual = await h.caller()
    await h.engine.handleTurnEnded('ws', manual, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'primary', reason: 'server-5xx code=SERVER status=503', autoSwitches: 1 })
    assert.equal(row.run.modelOverrides.worker, undefined, '离开人工轮即清 override')
    assert.equal(lastRoleSpawn(h.spawns).agentOptions?.provider, 'primary')

    // 主模型 A 再合格故障 → 升备用 B（预算 2）。
    const backOnPrimary = await h.caller()
    await h.engine.handleTurnEnded('ws', backOnPrimary, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'running')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 2 })
    assert.equal(lastRoleSpawn(h.spawns).agentOptions?.provider, 'backup')

    // 备用 B 再失败 → BLOCK（链终点）。
    const onBackup = await h.caller()
    await h.engine.handleTurnEnded('ws', onBackup, FAILOVER_503.text, FAILOVER_503.facts)
    row = await h.row()
    assert.equal(row.run.status, 'blocked')
    assert.deepEqual(row.run.roleRoutes?.worker, { stage: 'fallback', reason: 'server-5xx code=SERVER status=503', autoSwitches: 2 })
  } finally { h.close() }
})

test('#235 继承主路由时备用与之相同：启动即拒绝（冻结后才能判定）', async () => {
  const clash = load(CATALOG(`  worker:
    persona: Worker persona.
    fallbackModel: { provider: inherited, modelId: inherited-model }`))
  const h = harness(clash)
  try {
    h.engine.managerRoute = async () => ({ provider: 'inherited', model: 'inherited-model' })
    const run = h.engine.buildInitialRun('manager', 'role-model-fallback', clash, 'hash')
    const outcome = await h.engine.startRun('ws', run, undefined, 'root request')
    assert.equal(outcome.ok, false)
    assert.match((outcome as { reason: string }).reason, /worker" fallbackModel duplicates its primary route \(inherited\/inherited-model\)/)
  } finally { h.close() }
})

// ---- 编辑器与 GUI：备用模型的往返 ----

const EDITOR_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Build it.
    model: { provider: p1, modelId: m1 }
judgeRole:
  persona: Judge it.
workflow:
  startNode: a
  returns: [done]
  nodes:
    a:
      execution: { type: actor-task, role: manager, instruction: Do it. }
      checker: { checkerId: judge.claim-correct }
      results:
        ok: { criteria: Done., target: { return: done } }
`

test('#235 编辑器：设置/清除/撤销备用模型，保存-重载业务等价', () => {
  const loaded = loadDraft('fallback', EDITOR_CONFIG)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  if (!loaded.ok) throw new Error('unreachable')
  const session = loaded.session

  assert.equal(setRoleFallbackModel(session, 'developer', { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' }).ok, true)
  assert.deepEqual(session.draft.config.roles.developer!.fallbackModel, { provider: 'p2', modelId: 'm2', reasoningEffort: 'high' })
  assert.equal(undo(session), true)
  assert.equal(session.draft.config.roles.developer!.fallbackModel, undefined)

  assert.equal(setRoleFallbackModel(session, 'developer', { provider: 'p2', modelId: 'm2' }).ok, true)
  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])
  assert.match(preview.yaml, /fallbackModel:\n\s+provider: p2\n\s+modelId: m2/)
  const reloaded = loadDraft('fallback', preview.yaml, serializeLayout(session.draft.config, session.draft.layout))
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))

  assert.equal(setRoleFallbackModel(session, 'developer', undefined).ok, true)
  assert.equal(session.draft.config.roles.developer!.fallbackModel, undefined)
  assert.equal(setRoleFallbackModel(session, 'missing', undefined).ok, false)
  assert.equal(setRoleFallbackModel(session, 'developer', { provider: 'p2', modelId: '' }).ok, false)
})

test('#235 GUI：Role 面板区分主/备用模型并披露无限重试限制', () => {
  const bundle = bundleSources().panel
  assert.match(bundle, /title: '主模型'/)
  assert.match(bundle, /title: '备用模型（可选）'/)
  assert.match(bundle, /应用备用模型/)
  assert.match(bundle, /清除备用模型/)
  assert.match(bundle, /无限重试则收不到终止失败，本角色 fallback 不会被触发/)
  // 备用控件只加在 Role 面板；Judge 备用路由属 #236，本轮不得出现代理入口。
  assert.doesNotMatch(bundle, /judgeFallback|备用模型.*judgeRole/)
})
