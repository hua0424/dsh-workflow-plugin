import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { checkCatalogProviders, renderProviderCheckReport } from '../src/catalog/provider-check.ts'

const CONFIG = `
schemaVersion: agent-workflow/v2
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
      onPass: build
    build:
      execution:
        type: actor-task
        role: developer
        instruction: Build it.
      checker:
        checkerId: judge.claim-correct
        config:
          criteria: PASS when built.
      onPass: END
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
