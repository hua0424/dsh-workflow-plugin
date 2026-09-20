import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply } from '../src/index.ts'
import { StateStore } from '../src/state/store.ts'
import { readRoleDefModel } from '../src/types.ts'
import { resolveRoleModel } from '../src/roles/roles.ts'
import { checkCatalogProviders, renderProviderCheckReport, renderStartProviderBlock } from '../src/catalog/provider-check.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState } from '../src/types.ts'

const CATALOG = `
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
  returns: [planned]
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
        succeeded: { criteria: The plan exists., target: { return: planned } }
`

function loadConfig() {
  return validateAndNormalize(parseCatalogConfig(CATALOG), { workflowId: 'guard-me' })
}

function makeRun(config = loadConfig()): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'manager',
    catalogWorkflowId: 'guard-me',
    definitionHash: 'hash',
    definitionSnapshot: config,
    status: 'running',
    callStack: [{ workflowId: 'guard-me', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
}

/** 真实 apply + 可控 llm 清单：start 前置检查走 production 代码路径。 */
function applyWithProviders(
  home: string,
  providerIds: string[],
  lists?: { models?: Record<string, string[]>; failures?: Record<string, string> },
) {
  const cleanups: Array<() => void> = []
  let command: CommandDefinition | undefined
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = {
    effect(register: () => void | (() => void)) { const cleanup = register(); if (cleanup) cleanups.push(cleanup) },
    get() { return undefined },
    on() {},
    logger: { warn() {} },
    commands: { register(definition: CommandDefinition) { command = definition; return () => {} } },
    tools: { register() { return () => {} }, schemas() { return [] } },
    jobs: { onJobDone() { return () => {} }, list() { return [] } },
    agents: {
      get() { return undefined },
      list() { return [] },
      currentInitiator() { return undefined },
    },
    subagents: {},
    compaction: {},
    sessions: {},
    llm: {
      listProviders: () => providerIds.map(id => ({ id })),
      listModels: async (provider: string) => {
        if (lists?.failures?.[provider] !== undefined) throw new Error(lists.failures[provider])
        return (lists?.models?.[provider] ?? []).map(id => ({ provider, id, name: id }))
      },
    },
  }
  apply(ctx as never)
  return {
    command: command!,
    restore() {
      for (const cleanup of cleanups) cleanup()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    },
  }
}

function seedCatalog(home: string, catalog: string = CATALOG) {
  mkdirSync(join(home, 'workflows'), { recursive: true })
  writeFileSync(join(home, 'workflows', 'guard-me.yaml'), catalog)
}

/** T2：catalog 变体按需替换路由；GOOD_LISTS 为合法 catalog 的本地列表事实。 */
const GOOD_LISTS = { models: { 'good-provider': ['m1', 'jm'] } }

test('start 前置检查：误配 provider 被拒，逐角色点名且不创建 Run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t41-'))
  try {
    seedCatalog(home)
    const { command, restore } = applyWithProviders(home, ['good-provider'], GOOD_LISTS)
    try {
      const agent = { session: { id: 'manager', header: { cwd: home } } }
      const result = await command.handler({ commandId: 'x' as never, agent: agent as never, rawInput: 'start guard-me go', attachments: [], signal: new AbortController().signal })
      assert.equal(result.kind, 'error')
      assert.match(result.text ?? '', /ghost/)
      assert.match(result.text ?? '', /no-such-provider/)
      assert.match(result.text ?? '', /未在当前 profile 注册/)
      assert.match(result.text ?? '', /\/dsh-flow check guard-me/)
      // 拒绝发生在创建 Run 之前：state 无行。
      const store = new StateStore(home)
      try {
        assert.equal(await store.get(home), undefined)
      } finally { store.close() }
    } finally { restore() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('start 前置检查：合法 catalog 正常启动，未配 model 角色不误报', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t41-'))
  try {
    seedCatalog(home)
    const { command, restore } = applyWithProviders(home, ['good-provider', 'no-such-provider'],
      { models: { 'good-provider': ['m1', 'jm'], 'no-such-provider': ['m2'] } })
    const store = new StateStore(home)
    try {
      const agent = { session: { id: 'manager', header: { cwd: home } } }
      const result = await command.handler({ commandId: 'x' as never, agent: agent as never, rawInput: 'start guard-me go', attachments: [], signal: new AbortController().signal })
      assert.equal(result.kind, 'success')
      assert.match(result.text ?? '', /started guard-me/)
      const row = await store.get(home)
      assert.equal(row?.run.catalogWorkflowId, 'guard-me')
    } finally { store.close(); restore() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('check 命令保持非阻断纯诊断（Issue #41 Out of Scope 回归）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t41-'))
  try {
    seedCatalog(home)
    const { command, restore } = applyWithProviders(home, ['good-provider'], GOOD_LISTS)
    try {
      const agent = { session: { id: 'manager', header: { cwd: home } } }
      const result = await command.handler({ commandId: 'x' as never, agent: agent as never, rawInput: 'check guard-me', attachments: [], signal: new AbortController().signal })
      assert.equal(result.kind, 'success')
      assert.match(result.text ?? '', /ghost.*不可用/)
      assert.match(result.text ?? '', /不阻断/)
    } finally { restore() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('start 拒绝渲染与 check 诊断渲染区分：同 report 两种文案', () => {
  const report = checkCatalogProviders('guard-me', loadConfig(), ['good-provider'])
  assert.equal(report.ok, false)
  assert.match(renderStartProviderBlock(report), /已拒绝/)
  assert.match(renderStartProviderBlock(report), /ghost.*no-such-provider/)
  assert.match(renderProviderCheckReport(report), /仅报告，不阻断/)
})

test('三方共用同一 def 读取单源：override > def > frozen 不变', () => {
  const run = makeRun()
  // 单源直读
  assert.deepEqual(readRoleDefModel(run.definitionSnapshot, 'developer'), { provider: 'good-provider', modelId: 'm1' })
  assert.deepEqual(readRoleDefModel(run.definitionSnapshot, 'judge'), { provider: 'good-provider', modelId: 'jm' })
  assert.equal(readRoleDefModel(run.definitionSnapshot, 'plain'), undefined)
  assert.equal(readRoleDefModel(run.definitionSnapshot, 'nobody'), undefined)
  // resolveRoleModel：def 分支委托单源，优先级不变；三条分支统一返回 DelegationRoute
  assert.deepEqual(resolveRoleModel(run, 'developer'), { provider: 'good-provider', modelId: 'm1' })
  assert.deepEqual(resolveRoleModel(run, 'plain'), {})
  assert.deepEqual(resolveRoleModel(run, 'judge', { provider: 'frozen-p', modelId: 'frozen-m' }), { provider: 'good-provider', modelId: 'jm' })
  const noJudgeModel = makeRun(validateAndNormalize(parseCatalogConfig(CATALOG.replace('  model: { provider: "good-provider", modelId: "jm" }', '  tools: { deny: [edit] }')), { workflowId: 'guard-me' }))
  assert.deepEqual(resolveRoleModel(noJudgeModel, 'judge', { provider: 'frozen-p', modelId: 'frozen-m' }), { provider: 'frozen-p', modelId: 'frozen-m' })
  run.modelOverrides['developer'] = { provider: 'p2', modelId: 'm2' }
  assert.deepEqual(resolveRoleModel(run, 'developer'), { provider: 'p2', modelId: 'm2' })
})

// ---- #151 T2：真实命令入口的 modelId 列表守卫（非纯函数矩阵代替）----

async function runRaw(command: CommandDefinition, home: string, rawInput: string) {
  const agent = { session: { id: 'manager', header: { cwd: home } } }
  return command.handler({ commandId: 'x' as never, agent: agent as never, rawInput, attachments: [], signal: new AbortController().signal })
}

async function withHome(catalog: string, fn: (home: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'workflow-t2-'))
  try {
    seedCatalog(home, catalog)
    await fn(home)
  } finally { rmSync(home, { recursive: true, force: true }) }
}

test('T2 命令入口：unlisted modelId 被拒，逐角色点名+修复指引且无新 Run', async () => {
  await withHome(CATALOG.replace('"m1"', '"m-typo"'), async (home) => {
    const { command, restore } = applyWithProviders(home, ['good-provider', 'no-such-provider'],
      { models: { 'good-provider': ['m1', 'jm'], 'no-such-provider': ['m2'] } })
    const store = new StateStore(home)
    try {
      const result = await runRaw(command, home, 'start guard-me go')
      assert.equal(result.kind, 'error')
      assert.match(result.text ?? '', /developer/)
      assert.match(result.text ?? '', /m-typo/)
      assert.match(result.text ?? '', /settings\/config/)
      assert.equal(await store.get(home), undefined)
    } finally { store.close(); restore() }
  })
})

test('T2 命令入口：成功空列表被拒且无新 Run', async () => {
  await withHome(CATALOG, async (home) => {
    const { command, restore } = applyWithProviders(home, ['good-provider', 'no-such-provider'],
      { models: { 'good-provider': [], 'no-such-provider': ['m2'] } })
    const store = new StateStore(home)
    try {
      const result = await runRaw(command, home, 'start guard-me go')
      assert.equal(result.kind, 'error')
      assert.match(result.text ?? '', /developer/)
      assert.match(result.text ?? '', /本地模型列表为空/)
      assert.equal(await store.get(home), undefined)
    } finally { store.close(); restore() }
  })
})

test('T2 命令入口：judgeRole unlisted 同样被点名拒绝', async () => {
  await withHome(CATALOG.replace('"jm"', '"jm-missing"'), async (home) => {
    const { command, restore } = applyWithProviders(home, ['good-provider', 'no-such-provider'],
      { models: { 'good-provider': ['m1', 'jm'], 'no-such-provider': ['m2'] } })
    const store = new StateStore(home)
    try {
      const result = await runRaw(command, home, 'start guard-me go')
      assert.equal(result.kind, 'error')
      assert.match(result.text ?? '', /judge/)
      assert.match(result.text ?? '', /jm-missing/)
      assert.equal(await store.get(home), undefined)
    } finally { store.close(); restore() }
  })
})

test('T2 命令入口：listModels 拒绝则 fail-open——check 注明跳过原因，可启动且档位检查被跳过', async () => {
  // 列表失败 + 配置 effort 的组合：T2 只建立跳过事实，组合验收由 T3 完成。
  const effortCatalog = CATALOG.replace(
    'model: { provider: "good-provider", modelId: "m1" }',
    'model: { provider: "good-provider", modelId: "m1", reasoningEffort: "high" }')
  await withHome(effortCatalog, async (home) => {
    const { command, restore } = applyWithProviders(home, ['good-provider', 'no-such-provider'],
      { models: { 'no-such-provider': ['m2'] }, failures: { 'good-provider': 'connection refused' } })
    const store = new StateStore(home)
    try {
      const check = await runRaw(command, home, 'check guard-me')
      assert.equal(check.kind, 'success')
      assert.match(check.text ?? '', /developer.*跳过/)
      assert.match(check.text ?? '', /无法解析.*本地模型列表.*connection refused/)
      const started = await runRaw(command, home, 'start guard-me go')
      assert.equal(started.kind, 'success')
      assert.match(started.text ?? '', /started guard-me/)
      assert.equal((await store.get(home))?.run.catalogWorkflowId, 'guard-me')
    } finally { store.close(); restore() }
  })
})

test('T2 命令入口：查询失败不掩盖其他角色的确定误配', async () => {
  await withHome(CATALOG, async (home) => {
    const { command, restore } = applyWithProviders(home, ['good-provider'],
      { failures: { 'good-provider': 'boom' } })
    const store = new StateStore(home)
    try {
      const result = await runRaw(command, home, 'start guard-me go')
      assert.equal(result.kind, 'error')
      assert.match(result.text ?? '', /ghost/)
      assert.equal(await store.get(home), undefined)
      const check = await runRaw(command, home, 'check guard-me')
      assert.equal(check.kind, 'success')
      assert.match(check.text ?? '', /ghost.*不可用/)
      assert.match(check.text ?? '', /developer.*跳过/)
    } finally { store.close(); restore() }
  })
})
