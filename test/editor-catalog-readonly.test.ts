/**
 * #178 启动弹窗用工作流目录只读接缝：服务端投影/分派 + 客户端拉取封装回归。
 *
 * 覆盖票内 Acceptance 的可测试部分：只读端点返回 workflow-id 与诊断
 * （有效/警告/无效区分）、空载荷外一切路径输入拒绝且不触发扫描、
 * 维护状态如实报告不可用、失败/超时/取消/陈旧行为明确；
 * 不执行命令/不建 Run/不激活空白会话（目录源只复用 list 业务能力，
 * handler 内无命令/引擎/会话调用——以“源 stub 计数 + 产物无副作用”断言）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createEditorRpcHandler, EDITOR_RPC_CHANNEL, editorFetchHandler, rpcCatalogList,
} from '../src/editor/rpc.ts'
import { readWorkflowCatalog } from '../web-client/src/rpc.js'
import { buildClientBundle } from '../web-client/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const readSrc = (name: string) => readFileSync(join(here, '..', 'web-client', 'src', name), 'utf8')

function scan() {
  return {
    entries: [{ workflowId: 'good' }, { workflowId: 'warned' }],
    diagnostics: [
      { workflowId: 'warned', path: '/srv/secret/workflows/warned.yaml', reason: 'hand-written protocol keyword', severity: 'warning' as const },
      { workflowId: 'broken', path: '/srv/secret/workflows/broken.yaml', reason: 'Error: bad yaml', severity: 'error' as const },
    ],
  }
}

test('#178 投影区分有效/警告/无效，不泄漏路径与配置全文', () => {
  const result = rpcCatalogList(scan())
  assert.equal(result.ok, true)
  if (!result.ok) return
  const value = result.value as { items: Array<{ workflowId: string | null; status: string; reasons: string[] }> }
  assert.deepEqual(value.items, [
    { workflowId: 'broken', status: 'invalid', reasons: ['Error: bad yaml'] },
    { workflowId: 'good', status: 'valid', reasons: [] },
    { workflowId: 'warned', status: 'warning', reasons: ['hand-written protocol keyword'] },
  ])
  // 警告不误禁用（仍为 warning 而非 invalid），无效明确不可选（invalid）。
  const leaked = JSON.stringify(value)
  for (const banned of ['/srv/secret', 'path', 'config', 'definitionHash']) {
    assert.ok(!leaked.includes(banned), `投影不得泄漏 ${banned}`)
  }
})

test('#178 空目录返回空列表', () => {
  const result = rpcCatalogList({ entries: [], diagnostics: [] })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual((result.value as { items: unknown[] }).items, [])
})

test('#178 任何路径/目录/文件名输入明确拒绝且不触发扫描', async () => {
  let calls = 0
  const handler = createEditorRpcHandler({ listCatalog: async () => { calls++; return scan() } })
  for (const payload of [
    { path: '/srv/workflows' }, { dir: 'workflows' }, { file: 'demo.yaml' },
    { filename: 'demo.yaml' }, { workflowId: 'good' }, { directory: '/x' },
  ]) {
    const rejected = await handler('catalog', payload)
    assert.equal(rejected.ok, false)
    if (!rejected.ok) assert.equal(rejected.error.code, 'editor/invalid-payload')
  }
  assert.equal(calls, 0, '拒绝路径绝不能触发目录扫描')
  const accepted = await handler('catalog', {})
  assert.equal(accepted.ok, true)
  assert.equal(calls, 1, '空载荷触发且仅触发一次 fresh 扫描')
})

test('#178 维护状态如实报告不可用，失败明确区分', async () => {
  const maintenance = createEditorRpcHandler({
    listCatalog: async () => ({ entries: [], diagnostics: [], ok: false as const, reason: 'maintenance mode' }),
  })
  const unavailable = await maintenance('catalog', {})
  assert.deepEqual(unavailable,
    { ok: false, error: { code: 'editor/unavailable', message: 'maintenance mode', details: {} } })
  const failing = createEditorRpcHandler({
    listCatalog: async () => { throw new Error('EACCES') },
  })
  const failed = await failing('catalog', {})
  assert.equal(failed.ok, false)
  if (!failed.ok) {
    assert.equal(failed.error.code, 'editor/catalog-failed')
    assert.match(failed.error.message, /EACCES/)
  }
  // 未注入目录源 fail-closed，不静默返回空列表。
  const nosource = await createEditorRpcHandler()('catalog', {})
  assert.equal(nosource.ok, false)
  if (!nosource.ok) assert.equal(nosource.error.code, 'editor/unavailable')
})

test('#178 wire 层：空载荷 200 回 items，路径载荷 200 回拒绝信封且不扫描', async () => {
  let calls = 0
  const fetcher = editorFetchHandler(EDITOR_RPC_CHANNEL, createEditorRpcHandler({
    listCatalog: async () => { calls++; return scan() },
  }))
  const post = (rpcId: string, payload: unknown) => fetcher.fetch(new Request(`http://x${EDITOR_RPC_CHANNEL}/catalog`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'catalog', payload }),
  }))
  const okRes = await post('r1', {})
  assert.equal(okRes.status, 200)
  const okBody = JSON.parse(await okRes.text()) as { type: string; rpcId: string; result: { ok: boolean; value: { items: unknown[] } } }
  assert.equal(okBody.type, 'server-response')
  assert.equal(okBody.rpcId, 'r1')
  assert.equal(okBody.result.ok, true)
  assert.equal(okBody.result.value.items.length, 3)
  assert.equal(calls, 1)
  const denied = await post('r2', { path: '/srv/workflows' })
  assert.equal(denied.status, 200)
  const deniedBody = JSON.parse(await denied.text()) as { result: { ok: boolean; error: { code: string } } }
  assert.equal(deniedBody.result.ok, false)
  assert.equal(deniedBody.result.error.code, 'editor/invalid-payload')
  assert.equal(calls, 1, 'wire 层拒绝同样不得触发扫描')
})

test('#178 客户端拉取封装：成功透值，失败/超时/取消抛带 code 的 Error', async () => {
  const value = { items: [] }
  assert.equal(await readWorkflowCatalog(async () => ({ ok: true, value })), value)
  for (const code of ['editor/unavailable', 'editor/catalog-failed']) {
    const error = await readWorkflowCatalog(async () => ({ ok: false, error: { code, message: `${code} boom`, details: {} } })).catch((e) => e)
    assert.ok(error instanceof Error)
    assert.equal(error.code, code)
    assert.match(error.message, /boom/)
  }
  const noChannel = await readWorkflowCatalog(undefined as unknown as () => never).catch((e) => e)
  assert.equal(noChannel.code, 'editor/no-channel')
  const timeout = await readWorkflowCatalog(async () => ({ ok: false, error: { code: 'editor/timeout', message: '超时', details: {} } })).catch((e) => e)
  assert.equal(timeout.code, 'editor/timeout')
  const cancelled = await readWorkflowCatalog(async () => ({ ok: false, error: { code: 'editor/cancelled', message: '取消', details: {} } })).catch((e) => e)
  assert.equal(cancelled.code, 'editor/cancelled')
})

test('#178 客户端拉取封装：无跨调用缓存，并发乱序各自独立（陈旧由调用方守卫）', async () => {
  let calls = 0
  const gates: Array<() => void> = []
  const editorRpc = () => {
    calls++
    const mine = calls
    return new Promise((resolve) => { gates.push(() => resolve({ ok: true, value: { items: [mine] } })) })
  }
  const first = readWorkflowCatalog(editorRpc)
  const second = readWorkflowCatalog(editorRpc)
  assert.equal(calls, 2, '每次调用都触发服务端 fresh 扫描，不得缓存')
  gates[1]()
  assert.deepEqual(await second, { items: [2] })
  gates[0]()
  // 先发后到：调用方按 generation 丢弃本结果即“陈旧响应”行为；封装本身不混值。
  assert.deepEqual(await first, { items: [1] })
})

test('#178 拼合 bundle 导出目录拉取封装与后继调用接缝', () => {
  assert.ok(readSrc('rpc.js').includes('readWorkflowCatalog'), 'rpc.js 应提供 typed 拉取封装')
  assert.ok(readSrc('index.js').includes('loadCatalog'), '注册 inject 应暴露后继弹窗票的调用接缝')
  const outFile = buildClientBundle({ outDir: mkdtempSync(join(tmpdir(), 'wf-catalog-bundle-')) })
  const bundle = readFileSync(outFile, 'utf8')
  assert.ok(bundle.includes('readWorkflowCatalog'), 'bundle 应导出目录拉取封装')
  assert.ok(bundle.includes('loadCatalog'), 'bundle 应含后继调用接缝')
})
