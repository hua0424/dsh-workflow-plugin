import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import {
  checkCatalogProviders,
  checkCatalogProvidersWithModelLists,
  checkCatalogProvidersWithModelListsAndEfforts,
  effortRouteKey,
  queryEffortInfo,
  queryModelLists,
  renderProviderCheckReport,
  renderStartProviderBlock,
} from '../src/catalog/provider-check.ts'

const CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Implement.
    model: { provider: "good-provider", modelId: "m1" }
  ghost:
    persona: Missing provider.
    model: { provider: "no-such-provider", modelId: "m2" }
  plain:
    persona: No model, inherits Manager route.
judgeRole:
  persona: Judge.
  model: { provider: "good-provider", modelId: "jm" }
workflow:
  startNode: plan
  returns: [built]
  nodes:
    plan:
      execution:
        type: actor-task
        role: manager
        instruction: Plan it.
      checker:
        checkerId: judge.claim-correct
        config:
          criteria: PASS when a plan exists.
      results:
        succeeded: { criteria: The plan exists., target: { node: build } }
    build:
      execution:
        type: actor-task
        role: developer
        instruction: Build it.
      checker:
        checkerId: judge.claim-correct
        config:
          criteria: PASS when built.
      results:
        succeeded: { criteria: The build is complete., target: { return: built } }
`

function loadConfig() {
  return validateAndNormalize(parseCatalogConfig(CONFIG), { workflowId: 'check-me' })
}

test('误配 provider 被逐角色点名（含角色/provider/原因），合法角色 OK', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider'])
  assert.equal(report.ok, false)
  const ghost = report.rows.find(row => row.role === 'ghost')!
  assert.equal(ghost.ok, false)
  assert.equal(ghost.provider, 'no-such-provider')
  assert.match(ghost.reason, /no-such-provider/)
  assert.equal(report.rows.find(row => row.role === 'developer')!.ok, true)
  assert.equal(report.rows.find(row => row.role === 'judge')!.ok, true)
  const text = renderProviderCheckReport(report)
  assert.match(text, /ghost.*no-such-provider.*不可用/)
  assert.match(text, /developer.*OK/)
})

test('合法 catalog 全过；未配 model 的角色视为继承而不报错', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider', 'no-such-provider'])
  assert.equal(report.ok, true)
  assert.equal(report.rows.find(row => row.role === 'plain')!.ok, true)
  assert.match(renderProviderCheckReport(report), /全过/)
})

test('检查不影响正常加载：同一份配置仍可通过严格校验', () => {
  assert.doesNotThrow(() => validateAndNormalize(parseCatalogConfig(CONFIG), { workflowId: 'check-me' }))
})

// ---- #151 T2：modelId 本地列表判定矩阵（纯函数，注入事实）----

test('T2 列表包含：显式路由 listed 通过，继承角色跳过', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider', 'no-such-provider'],
    { models: new Map([['good-provider', ['m1', 'jm']], ['no-such-provider', ['m2']]]) })
  assert.equal(report.ok, true)
  assert.equal(report.rows.find(row => row.role === 'developer')!.modelList, 'listed')
  assert.equal(report.rows.find(row => row.role === 'judge')!.modelList, 'listed')
  assert.equal(report.rows.find(row => row.role === 'plain')!.modelList, 'inherited')
  const text = renderProviderCheckReport(report)
  assert.match(text, /developer.*OK.*本地列表/)
  assert.match(text, /全过.*4 个角色/)
  assert.doesNotMatch(text, /跳过/)
})

test('T2 unlisted 阻断：逐角色点名 modelId 与本地声明修复方向', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider', 'no-such-provider'],
    { models: new Map([['good-provider', ['other']], ['no-such-provider', ['m2']]]) })
  assert.equal(report.ok, false)
  for (const role of ['developer', 'judge']) {
    const row = report.rows.find(r => r.role === role)!
    assert.equal(row.ok, false)
    assert.equal(row.modelList, 'unlisted')
    assert.match(row.reason, /settings\/config/)
  }
  const block = renderStartProviderBlock(report)
  assert.match(block, /developer.*m1/)
  assert.match(block, /judge.*jm/)
  assert.match(block, /settings\/config/)
  assert.match(renderProviderCheckReport(report), /不可用/)
})

test('T2 成功空列表阻断：未实现 listModels 的 provider 视为不可用', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider', 'no-such-provider'],
    { models: new Map([['good-provider', []], ['no-such-provider', ['m2']]]) })
  assert.equal(report.ok, false)
  const row = report.rows.find(r => r.role === 'developer')!
  assert.equal(row.modelList, 'empty-list')
  assert.match(row.reason, /本地模型列表为空/)
  assert.match(renderStartProviderBlock(report), /developer.*good-provider/)
})

test('T2 查询失败 fail-open：跳过两维并注明原因，不误报空列表', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider', 'no-such-provider'],
    { models: new Map([['no-such-provider', ['m2']]]), failures: new Map([['good-provider', 'boom']]) })
  assert.equal(report.ok, true)
  const row = report.rows.find(r => r.role === 'developer')!
  assert.equal(row.ok, true)
  // T3 消费该语义进入档位检查决策：列表失败 + 配置 effort 的组合由 T3 验收。
  assert.equal(row.modelList, 'list-unavailable')
  assert.match(row.reason, /无法解析.*本地模型列表.*boom/)
  assert.match(row.reason, /跳过 modelId 与后续档位检查/)
  const text = renderProviderCheckReport(report)
  assert.match(text, /developer.*跳过.*boom/)
  assert.match(text, /其中 2 个跳过 modelId 检查/)
})

test('T2 确定误配与查询失败并存：后者不掩盖前者，前者仍阻断', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider'],
    { failures: new Map([['good-provider', 'boom']]) })
  assert.equal(report.ok, false)
  assert.equal(report.rows.find(r => r.role === 'ghost')!.ok, false)
  assert.equal(report.rows.find(r => r.role === 'developer')!.ok, true)
  const block = renderStartProviderBlock(report)
  assert.match(block, /ghost.*no-such-provider/)
  assert.match(block, /已拒绝/)
})

test('T2 未传查询事实：已注册路由按跳过处理（历史调用兼容），继承/误配不变', () => {
  const report = checkCatalogProviders('check-me', loadConfig(), ['good-provider'])
  assert.equal(report.ok, false)
  assert.equal(report.rows.find(r => r.role === 'developer')!.modelList, 'list-unavailable')
  assert.equal(report.rows.find(r => r.role === 'plain')!.modelList, 'inherited')
  assert.equal(report.rows.find(r => r.role === 'ghost')!.modelList, 'provider-unregistered')
})

test('T2 装配层：同步抛错与异步拒绝都转为故障事实，空数组保留为阻断事实', async () => {
  const calls: string[] = []
  const { models, failures } = await queryModelLists(
    ['sync-boom', 'async-boom', 'empty', 'sync-boom'],
    async (provider) => {
      calls.push(provider)
      if (provider === 'sync-boom') throw new Error('sync fail')
      if (provider === 'async-boom') return await Promise.reject(new Error('async fail'))
      return []
    },
  )
  assert.deepEqual(calls, ['sync-boom', 'async-boom', 'empty'])
  assert.equal(failures.get('sync-boom'), 'sync fail')
  assert.equal(failures.get('async-boom'), 'async fail')
  assert.deepEqual(models.get('empty'), [])
  assert.equal(models.has('sync-boom'), false)
})

test('T2 装配体串联：judgeRole unlisted 同样被点名阻断', async () => {
  const report = await checkCatalogProvidersWithModelLists('check-me', loadConfig(),
    ['good-provider', 'no-such-provider'],
    async provider => (provider === 'good-provider' ? ['m1'] : ['m2']))
  assert.equal(report.ok, false)
  const judge = report.rows.find(r => r.role === 'judge')!
  assert.equal(judge.modelList, 'unlisted')
  assert.match(renderStartProviderBlock(report), /judge.*jm/)
})

// ---- #152 T3：reasoningEffort 档位判定矩阵（纯函数，注入事实）----

const EFFORT_CONFIG = CONFIG
  .replace(
    'model: { provider: "good-provider", modelId: "m1" }',
    'model: { provider: "good-provider", modelId: "m1", reasoningEffort: "high" }')
  .replace(
    'model: { provider: "good-provider", modelId: "jm" }',
    'model: { provider: "good-provider", modelId: "jm", reasoningEffort: "low" }')

function loadEffortConfig() {
  return validateAndNormalize(parseCatalogConfig(EFFORT_CONFIG), { workflowId: 'check-me' })
}

/** 档位事实 helper：与宿主 LlmResolvedModelInfo.reasoning 子集同构（efforts 按 id 比较）。 */
function effortInfo(efforts: string[], noReasoning = false) {
  return noReasoning ? {} : { reasoning: { efforts: efforts.map(id => ({ id })) } }
}

const LISTS = { models: new Map([['good-provider', ['m1', 'jm']], ['no-such-provider', ['m2']]]) }

test('T3 档位通过：listed + 配置值在 efforts id 集中；未配置 effort 无新增输出', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider', 'no-such-provider'],
    LISTS,
    { info: new Map([[effortRouteKey('good-provider', 'm1'), effortInfo(['low', 'high'])], [effortRouteKey('good-provider', 'jm'), effortInfo(['low'])]]) })
  assert.equal(report.ok, true)
  const developer = report.rows.find(r => r.role === 'developer')!
  assert.equal(developer.effort, 'passed')
  assert.match(renderProviderCheckReport(report), /developer.*OK.*思考档位 "high"/)
  // 未配置 effort 的 ghost（listed）不新增档位输出，与 T2 行为一致。
  assert.equal(report.rows.find(r => r.role === 'ghost')!.effort, 'not-configured')
  assert.equal(report.rows.find(r => r.role === 'plain')!.effort, 'not-applicable')
  assert.match(renderProviderCheckReport(report), /ghost.*OK.*本地列表/)
  assert.doesNotMatch(renderProviderCheckReport(report), /ghost.*档位/)
})

test('T3 档位越界阻断：点名角色/模型/档位，start 渲染可定位修复', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider', 'no-such-provider'],
    LISTS,
    { info: new Map([[effortRouteKey('good-provider', 'm1'), effortInfo(['low'])], [effortRouteKey('good-provider', 'jm'), effortInfo(['low'])]]) })
  assert.equal(report.ok, false)
  const developer = report.rows.find(r => r.role === 'developer')!
  assert.equal(developer.effort, 'blocked')
  assert.match(developer.reason, /思考档位 "high"/)
  assert.match(developer.reason, /good-provider\/m1/)
  assert.match(developer.reason, /reasoningEffort/)
  const block = renderStartProviderBlock(report)
  assert.match(block, /developer.*high/)
  assert.match(block, /已拒绝/)
})

test('T3 成功但缺 reasoning 阻断：与解析失败区分，点名宿主必然拒绝', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider', 'no-such-provider'],
    LISTS,
    { info: new Map([[effortRouteKey('good-provider', 'm1'), effortInfo([], true)], [effortRouteKey('good-provider', 'jm'), effortInfo(['low'])]]) })
  assert.equal(report.ok, false)
  const developer = report.rows.find(r => r.role === 'developer')!
  assert.equal(developer.effort, 'blocked')
  assert.match(developer.reason, /未声明 reasoning 元数据/)
  assert.match(developer.reason, /UNSUPPORTED_REASONING_EFFORT/)
  // 缺 reasoning 是确定误配，不是可兼容放行。
  assert.match(renderStartProviderBlock(report), /developer.*high/)
})

test('T3 解析失败 fail-open：跳过档位检查并注明，不误判成不支持或通过', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider', 'no-such-provider'],
    LISTS,
    {
      info: new Map([[effortRouteKey('good-provider', 'jm'), effortInfo(['low'])]]),
      failures: new Map([[effortRouteKey('good-provider', 'm1'), 'INVALID_MODEL_REASONING']]),
    })
  assert.equal(report.ok, true)
  const developer = report.rows.find(r => r.role === 'developer')!
  assert.equal(developer.effort, 'skipped')
  assert.match(developer.effortDetail ?? '', /无法解析模型 good-provider\/m1 的思考元数据.*INVALID_MODEL_REASONING/)
  assert.match(developer.effortDetail ?? '', /已跳过档位检查/)
  const text = renderProviderCheckReport(report)
  assert.match(text, /developer.*OK.*档位检查已跳过.*INVALID_MODEL_REASONING/)
  assert.match(text, /1 个跳过档位检查/)
})

test('T3 未传档位事实：listed + 已配置 effort 按跳过处理（历史调用兼容）', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider', 'no-such-provider'], LISTS)
  assert.equal(report.ok, true)
  const developer = report.rows.find(r => r.role === 'developer')!
  assert.equal(developer.effort, 'skipped')
  assert.match(developer.effortDetail ?? '', /未查询模型.*思考元数据/)
})

test('T3 列表失败 + 已配置 effort：跳过两维，effort 不再进入判定', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider', 'no-such-provider'],
    { models: new Map([['no-such-provider', ['m2']]]), failures: new Map([['good-provider', 'boom']]) },
    { info: new Map([[effortRouteKey('good-provider', 'm1'), effortInfo(['high'])]]) })
  assert.equal(report.ok, true)
  const developer = report.rows.find(r => r.role === 'developer')!
  assert.equal(developer.modelList, 'list-unavailable')
  // 即使档位事实存在，未过列表关的路由也不消费它。
  assert.equal(developer.effort, 'not-applicable')
  assert.equal(developer.effortDetail, null)
})

test('T3 确定误配与档位跳过并存：后者不掩盖前者，前者仍阻断', () => {
  const report = checkCatalogProviders('check-me', loadEffortConfig(), ['good-provider'],
    { models: new Map([['good-provider', ['m1', 'jm']]]) },
    { failures: new Map([[effortRouteKey('good-provider', 'm1'), 'boom']]) })
  assert.equal(report.ok, false)
  assert.equal(report.rows.find(r => r.role === 'ghost')!.ok, false)
  assert.equal(report.rows.find(r => r.role === 'developer')!.effort, 'skipped')
  assert.match(renderStartProviderBlock(report), /ghost.*no-such-provider/)
})

test('T3 装配层：同步抛错与异步拒绝都转为故障事实，同路由去重只查一次', async () => {
  const calls: Array<[string, string]> = []
  const { info, failures } = await queryEffortInfo(
    [
      { provider: 'p', modelId: 'sync-boom' },
      { provider: 'p', modelId: 'async-boom' },
      { provider: 'p', modelId: 'ok' },
      { provider: 'p', modelId: 'ok' },
    ],
    async (provider, modelId) => {
      calls.push([provider, modelId])
      if (modelId === 'sync-boom') throw new Error('sync fail')
      if (modelId === 'async-boom') return await Promise.reject(new Error('async fail'))
      return { reasoning: { efforts: [{ id: 'high' }] } }
    },
  )
  assert.deepEqual(calls, [['p', 'sync-boom'], ['p', 'async-boom'], ['p', 'ok']])
  assert.equal(failures.get(effortRouteKey('p', 'sync-boom')), 'sync fail')
  assert.equal(failures.get(effortRouteKey('p', 'async-boom')), 'async fail')
  assert.deepEqual(info.get(effortRouteKey('p', 'ok')), { reasoning: { efforts: [{ id: 'high' }] } })
  assert.equal(info.has(effortRouteKey('p', 'sync-boom')), false)
})

test('T3 装配体串联：judgeRole 越界同样被点名阻断；未配置 effort 不查询元数据', async () => {
  const resolved: Array<[string, string]> = []
  const report = await checkCatalogProvidersWithModelListsAndEfforts('check-me', loadEffortConfig(),
    ['good-provider', 'no-such-provider'],
    async provider => (provider === 'good-provider' ? ['m1', 'jm'] : ['m2']),
    async (provider, modelId) => {
      resolved.push([provider, modelId])
      return effortInfo(['low'])
    })
  assert.equal(report.ok, false)
  // developer 配置 high 但 efforts 只有 low → 阻断；judge 配置 low 且在集中 → 通过。
  assert.equal(report.rows.find(r => r.role === 'judge')!.effort, 'passed')
  assert.equal(report.rows.find(r => r.role === 'developer')!.effort, 'blocked')
  assert.match(renderStartProviderBlock(report), /developer.*high/)
  // ghost 未配置 effort：不查询其元数据。
  assert.deepEqual(resolved, [['good-provider', 'm1'], ['good-provider', 'jm']])
})

test('T3 装配体串联：列表失败的路由不再 resolveModelInfo', async () => {
  const resolved: Array<[string, string]> = []
  const report = await checkCatalogProvidersWithModelListsAndEfforts('check-me', loadEffortConfig(),
    ['good-provider', 'no-such-provider'],
    async provider => {
      if (provider === 'good-provider') throw new Error('connection refused')
      return ['m2']
    },
    async (provider, modelId) => {
      resolved.push([provider, modelId])
      return effortInfo(['high'])
    })
  assert.equal(report.ok, true)
  assert.deepEqual(resolved, [])
  assert.equal(report.rows.find(r => r.role === 'developer')!.effort, 'not-applicable')
})
