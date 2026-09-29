import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callEditor, EDITOR_RPC_CHANNEL } from '../web-client/src/rpc.js'

test('编辑器 RPC：无响应请求在 15 秒后结束并允许重试', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let transportSignal: AbortSignal | undefined
  const pending = callEditor({ rpc: { call(_channel, _endpoint, _payload, signal) {
    transportSignal = signal
    return new Promise(() => {})
  } } }, 'parse', { workflowId: 'demo', text: '' })
  let settled = false
  void pending.then(() => { settled = true })
  t.mock.timers.tick(15_000)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  assert.equal(settled, true, '无响应 RPC 必须结束，不能一直卡在加载中')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'editor/timeout')
  assert.match(result.error.message, /重试/)
  assert.equal(transportSignal?.aborted, true)
})

test('编辑器 RPC：保留调用参数、this 与外部取消能力', async () => {
  const abort = new AbortController()
  let transportSignal: AbortSignal | undefined
  const rpc = { call(channel, endpoint, payload, signal) {
    assert.equal(this, rpc)
    assert.equal(channel, EDITOR_RPC_CHANNEL)
    assert.equal(endpoint, 'layout')
    assert.deepEqual(payload, { config: {} })
    transportSignal = signal
    return new Promise(() => {})
  } }
  const pending = callEditor({ rpc }, 'layout', { config: {} }, abort.signal)
  abort.abort()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'editor/cancelled')
  assert.equal(transportSignal?.aborted, true)
})

test('编辑器 RPC：成功响应清理计时器，已取消请求不派发', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let dispatched = 0
  let transportSignal: AbortSignal | undefined
  const connection = { rpc: { async call(_channel, _endpoint, _payload, signal) {
    dispatched++
    transportSignal = signal
    return { ok: true, value: { programs: {} } }
  } } }
  assert.equal((await callEditor(connection, 'metadata', {})).ok, true)
  t.mock.timers.tick(15_000)
  assert.equal(transportSignal?.aborted, false)
  const abort = new AbortController()
  abort.abort()
  assert.equal((await callEditor(connection, 'metadata', {}, abort.signal)).error.code, 'editor/cancelled')
  assert.equal(dispatched, 1)
})
