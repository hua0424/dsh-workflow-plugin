/**
 * Issue #223：`workflow_set_role_model` 保存前三维校验。
 *
 * - 纯判定与 start 矩阵同源（`checkSingleProviderRoute` 即 catalog 每行同源实现）：
 *   覆盖判定矩阵各行，阻断行列出合法档位，放行行注明「未校验」。
 * - Engine 缝（`validateModelRoute`，与 managerRoute / cwdResolver 同款可选依赖）：
 *   拒绝透出 reason、不写 override；放行 note 注明进成功消息；no-op 路径不免检；
 *   judge 与普通角色走同一校验；校验异常 fail-closed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import {
  checkSingleProviderRoute,
  effortRouteKey,
  type EffortFacts,
  type ModelListFacts,
} from '../src/catalog/provider-check.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import type { WorkflowConfig } from '../src/types.ts'
import { StateStore } from '../src/state/store.ts'

const AVAILABLE = ['good-provider']

function listsOf(models: Record<string, readonly string[]>, failures?: Record<string, string>): ModelListFacts {
  return {
    models: new Map(Object.entries(models)),
    ...(failures === undefined ? {} : { failures: new Map(Object.entries(failures)) }),
  }
}

function effortsOf(info: Record<string, { reasoning?: { efforts: Array<{ id: string }> } }>, failures?: Record<string, string>): EffortFacts {
  return {
    info: new Map(Object.entries(info)),
    ...(failures === undefined ? {} : { failures: new Map(Object.entries(failures)) }),
  }
}

const KEY = effortRouteKey('good-provider', 'm1')

test('#223 纯判定：provider 未注册拒绝', () => {
  const row = checkSingleProviderRoute('worker', 'no-such', 'm1', undefined, AVAILABLE)
  assert.equal(row.ok, false)
  assert.match(row.reason, /未在当前 profile 注册/)
  assert.equal(row.modelList, 'provider-unregistered')
})

test('#223 纯判定：listModels 抛错放行并注明 modelId 未校验', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', 'high', AVAILABLE,
    listsOf({}, { 'good-provider': 'boom' }))
  assert.equal(row.ok, true)
  assert.equal(row.modelList, 'list-unavailable')
  assert.match(row.reason, /无法解析.*本地模型列表.*boom/)
  assert.match(row.reason, /跳过 modelId 与后续档位检查/)
})

test('#223 纯判定：本地列表为空拒绝', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', undefined, AVAILABLE,
    listsOf({ 'good-provider': [] }))
  assert.equal(row.ok, false)
  assert.match(row.reason, /本地模型列表为空/)
})

test('#223 纯判定：modelId 不在列表拒绝', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm2', undefined, AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }))
  assert.equal(row.ok, false)
  assert.match(row.reason, /不在 provider "good-provider" 的本地模型列表中/)
})

test('#223 纯判定：未传 effort 接受且不消费档位事实', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', undefined, AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }))
  assert.equal(row.ok, true)
  assert.equal(row.modelList, 'listed')
  assert.equal(row.effort, 'not-configured')
})

test('#223 纯判定：resolveModelInfo 抛错放行并注明档位未校验', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', 'high', AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }),
    effortsOf({}, { [KEY]: 'INVALID_MODEL_REASONING' }))
  assert.equal(row.ok, true)
  assert.equal(row.effort, 'skipped')
  assert.match(row.effortDetail ?? '', /无法解析模型 good-provider\/m1 的思考元数据/)
  assert.match(row.effortDetail ?? '', /已跳过档位检查/)
})

test('#223 纯判定：efforts 为空数组放行并注明（非法元数据非阻断）', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', 'high', AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }),
    effortsOf({ [KEY]: { reasoning: { efforts: [] } } }))
  assert.equal(row.ok, true)
  assert.equal(row.effort, 'skipped')
  assert.match(row.effortDetail ?? '', /efforts 为空/)
})

test('#223 纯判定：resolve 成功但无 reasoning 拒绝', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', 'high', AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }),
    effortsOf({ [KEY]: {} }))
  assert.equal(row.ok, false)
  assert.equal(row.effort, 'blocked')
  assert.match(row.reason, /未声明 reasoning 元数据/)
})

test('#223 纯判定：档位在集中接受', () => {
  const row = checkSingleProviderRoute('worker', 'good-provider', 'm1', 'high', AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }),
    effortsOf({ [KEY]: { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } } }))
  assert.equal(row.ok, true)
  assert.equal(row.effort, 'passed')
})

test('#223 纯判定主案：glm-5.3 传 medium 拒绝并列出 [low, high, max]', () => {
  const row = checkSingleProviderRoute('coordinator', 'good-provider', 'm1', 'medium', AVAILABLE,
    listsOf({ 'good-provider': ['m1'] }),
    effortsOf({ [KEY]: { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] } } }))
  assert.equal(row.ok, false)
  assert.equal(row.effort, 'blocked')
  assert.match(row.reason, /思考档位 "medium" 不在模型 good-provider\/m1 的支持列表中/)
  assert.match(row.reason, /"low"/)
  assert.match(row.reason, /"high"/)
  assert.match(row.reason, /"max"/)
})

// ---- Engine 缝行为（stub 注入）----

const CONFIG: WorkflowConfig = validateAndNormalize(parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles:
  worker:
    persona: Worker persona.
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
        succeeded: { criteria: The plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: worker, instruction: Work. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: The work is complete., target: { return: done } }
`), { workflowId: 'set-role-model-validation' })

function engineFor(store: StateStore): WorkflowEngine {
  const engine = new WorkflowEngine({
    async steerManager() { return { messageId: 'manager-message' } },
    async sendRoleActor() { return { messageId: 'role-message' } },
    managerSessionSeq() { return 0 },
  }, {
    async ensureRoleActor() { return { childId: 'child-1', messageId: 'message-1' } },
    async startJudge(_run, input) { return { judgeSessionId: input.judgeSessionId, messageId: 'message-1' } },
    observeTurnEnd() {},
    async followupJudge() { return { messageId: 'message-1' } },
    async judgeSessionAvailability() { return 'available' as const },
    async roleSessionAvailability() { return 'available' as const },
    async retireJudge() {}, async drainJudge() {},
    async drainRoleActor() {}, async compactRoleActor() { return { ok: true } },
    async safeToInspect() { return 'safe' as const },
  }, { async run() { throw new Error('no programs') } }, makeStateHost(store))
  engine.cwdResolver = async () => 'cwd'
  return engine
}

async function started(engine: WorkflowEngine): Promise<void> {
  assert.equal((await engine.startRun('ws',
    engine.buildInitialRun('manager', 'set-role-model-validation', CONFIG, 'hash'), undefined, 'root request')).ok, true)
}

test('#223 engine：校验拒绝不写 override', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-validation-'))
  const store = new StateStore(home)
  const engine = engineFor(store)
  try {
    await started(engine)
    engine.validateModelRoute = async () => ({ ok: false, reason: '思考档位 "medium" 不在模型 p/m 的支持列表中' })
    const rejected = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'medium')
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason!, /思考档位/)
    assert.equal((await store.get('ws'))!.run.modelOverrides.worker, undefined)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#223 engine：放行 note 注明进成功消息', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-validation-'))
  const store = new StateStore(home)
  const engine = engineFor(store)
  try {
    await started(engine)
    engine.validateModelRoute = async () => ({ ok: true, note: '档位未校验： boom' })
    const set = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'medium')
    assert.equal(set.ok, true)
    assert.match(set.message!, /model override saved for worker/)
    assert.match(set.message!, /档位未校验/)
    assert.deepEqual((await store.get('ws'))!.run.modelOverrides.worker,
      { provider: 'p', modelId: 'm', reasoningEffort: 'medium' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#223 engine：存量非法 override 经 no-op 路径不免检', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-validation-'))
  const store = new StateStore(home)
  const engine = engineFor(store)
  try {
    await started(engine)
    // 缝未装配时存量写法可落库（历史行为）。
    assert.equal((await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'medium')).ok, true)
    // 同一三元组：无校验本是 no-op；装配校验后必须先被拒绝。
    engine.validateModelRoute = async () => ({ ok: false, reason: '思考档位 "medium" 不在模型 p/m 的支持列表中' })
    const second = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'medium')
    assert.equal(second.ok, false)
    assert.notEqual(second.message, 'model override already applied')
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#223 engine：judge 走同一校验、对称拒绝', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-validation-'))
  const store = new StateStore(home)
  const engine = engineFor(store)
  try {
    await started(engine)
    engine.validateModelRoute = async (_provider, _model, effort) =>
      effort === 'medium'
        ? { ok: false, reason: '思考档位 "medium" 不在支持列表中' }
        : { ok: true }
    const rejected = await engine.handleSetRoleModel('ws', 'judge', 'jp', 'jm', 'manager', 'medium')
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason!, /思考档位/)
    assert.equal((await store.get('ws'))!.run.modelOverrides.judge, undefined)
    assert.equal((await engine.handleSetRoleModel('ws', 'judge', 'jp', 'jm', 'manager', 'low')).ok, true)
    assert.deepEqual((await store.get('ws'))!.run.modelOverrides.judge,
      { provider: 'jp', modelId: 'jm', reasoningEffort: 'low' })
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('#223 engine：校验异常 fail-closed，不写 override', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-set-validation-'))
  const store = new StateStore(home)
  const engine = engineFor(store)
  try {
    await started(engine)
    engine.validateModelRoute = async () => { throw new Error('listProviders down') }
    const rejected = await engine.handleSetRoleModel('ws', 'worker', 'p', 'm', 'manager', 'low')
    assert.equal(rejected.ok, false)
    assert.match(rejected.reason!, /model route validation failed/)
    assert.equal((await store.get('ws'))!.run.modelOverrides.worker, undefined)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})
