import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import {
  checkCatalogProviders,
  checkCatalogProvidersWithModelLists,
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
