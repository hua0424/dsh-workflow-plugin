/**
 * #179 对话区启动弹窗与原生命令提交：纯函数语义 + 公开注册接线回归。
 *
 * 断言用户可观察行为与公开调用契约，不渲染 React、不启动真实 Run：
 * 命令组装（workflow-id 提交语义/prompt 归一化/超限拒绝）、可用性闸门
 * （运行中/提交中/子会话/无 workspace/已移除）、提交结果分类（成功/
 * 命令失败保留输入/未知结果指引查状态不重试），以及注册形状（session-scoped
 * input.left，不替换 composer、无 DOM 注入、不碰输入框草稿）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  START_PROMPT_MAX_CHARS, normalizeStartPrompt, startCommandLineOf,
  canStartWorkflow, executeStartWorkflow,
} from '../web-client/src/start-submit.js'
import { buildClientBundle } from '../web-client/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'web-client', 'src')
const readSrc = (name: string) => readFileSync(join(srcDir, name), 'utf8')

test('#179 命令组装：展示 .yaml 不进参数，空 prompt 沿用命令语义', () => {
  assert.deepEqual(startCommandLineOf('demo', ''), { ok: true, line: '/dsh-flow start demo' })
  assert.deepEqual(startCommandLineOf('demo', '   '), { ok: true, line: '/dsh-flow start demo' })
  assert.deepEqual(startCommandLineOf('demo', ' hello '), { ok: true, line: '/dsh-flow start demo hello' })
  const built = startCommandLineOf('my-flow-2', 'do it')
  assert.equal(built.ok, true)
  if (built.ok) assert.ok(!built.line.includes('.yaml'), '提交用 workflow-id，不带扩展名')
})

test('#179 prompt 空白归一化与服务端 join 语义一致，不承诺多行排版', () => {
  assert.equal(normalizeStartPrompt('  a   b\tc\n\nd  '), 'a b c d')
  assert.equal(normalizeStartPrompt(''), '')
  const multi = startCommandLineOf('demo', '第一行\n第二行')
  assert.equal(multi.ok, true)
  if (multi.ok) assert.equal(multi.line, '/dsh-flow start demo 第一行 第二行')
})

test('#179 超限输入被拒绝，非法选择明确拒绝', () => {
  assert.equal(START_PROMPT_MAX_CHARS, 8000, '上限与服务端 handoffMax 同源')
  const over = startCommandLineOf('demo', 'x'.repeat(8001))
  assert.equal(over.ok, false)
  if (!over.ok) assert.match(over.reason, /8000/)
  const edge = startCommandLineOf('demo', 'x'.repeat(8000))
  assert.equal(edge.ok, true)
  for (const bad of [undefined, '', 'Demo', 'demo.yaml', '../x', 'a b']) {
    const rejected = startCommandLineOf(bad as string, '')
    assert.equal(rejected.ok, false, `非法 workflow-id 应拒绝：${String(bad)}`)
  }
})

test('#179 可用性闸门：运行中/提交中/子会话/无 workspace/已移除禁用', () => {
  const base = { session: { removed: false, running: false, subagent: null }, inputPhase: 'plain', hasWorkspace: true }
  assert.equal(canStartWorkflow(base).ok, true, '空闲可用顶层主会话可启动')
  assert.equal(canStartWorkflow({ ...base, session: { ...base.session, running: true } }).ok, false)
  for (const phase of ['submitting', 'adjudicating']) {
    assert.equal(canStartWorkflow({ ...base, inputPhase: phase }).ok, false, `${phase} 应禁用`)
  }
  assert.equal(canStartWorkflow({ ...base, session: { ...base.session, subagent: { address: {} } } }).ok, false, '子会话禁用')
  assert.equal(canStartWorkflow({ ...base, hasWorkspace: false }).ok, false, '无 workspace 禁用')
  assert.equal(canStartWorkflow({ ...base, session: { ...base.session, removed: true } }).ok, false)
  assert.equal(canStartWorkflow({ ...base, session: undefined }).ok, false)
  assert.equal(canStartWorkflow({ ...base, session: null }).ok, false)
})

test('#179 提交分类：仅传输成功+内层 success 算成功', async () => {
  const ok = (result: unknown) => ({ ok: true as const, value: { commandId: 'c1', result } })
  assert.deepEqual(
    await executeStartWorkflow({ runCommand: async () => ok({ kind: 'success', text: 'started' }), sessionId: 's', line: '/dsh-flow start demo' }),
    { kind: 'success' },
  )
  // 内层失败：真实原因透出（调用方保留输入）。
  const failed = await executeStartWorkflow({ runCommand: async () => ok({ kind: 'error', text: 'start 失败：已有活动 Run' }), sessionId: 's', line: 'x' })
  assert.equal(failed.kind, 'command-error')
  if (failed.kind !== 'success') assert.match(failed.message, /已有活动 Run/)
  // 未知命令：value 缺席，保留输入。
  const unknown = await executeStartWorkflow({ runCommand: async () => ({ ok: true as const, value: undefined }), sessionId: 's', line: 'x' })
  assert.equal(unknown.kind, 'command-error')
  // 传输失败与抛错（超时/断连）：未知结果，指引先查状态、不自动重试。
  for (const res of [
    await executeStartWorkflow({ runCommand: async () => ({ ok: false as const, error: { code: 'session/gone', message: 'gone' } }), sessionId: 's', line: 'x' }),
    await executeStartWorkflow({ runCommand: async () => { throw new Error('timeout') }, sessionId: 's', line: 'x' }),
  ]) {
    assert.equal(res.kind, 'unknown')
    if (res.kind !== 'success') {
      assert.match(res.message, /结果未知/)
      assert.match(res.message, /status/)
      assert.match(res.message, /不要自动重试/)
    }
  }
})

test('#179 提交只调同一 Session 的原生命令（参数直传，不改写行文）', async () => {
  const calls: Array<[string, string]> = []
  const runCommand = async (sessionId: string, line: string) => {
    calls.push([sessionId, line])
    return { ok: true as const, value: { commandId: 'c', result: { kind: 'success' as const } } }
  }
  const outcome = await executeStartWorkflow({ runCommand, sessionId: 'sess-1', line: '/dsh-flow start demo hi' })
  assert.deepEqual(outcome, { kind: 'success' })
  assert.deepEqual(calls, [['sess-1', '/dsh-flow start demo hi']])
})

test('#179 注册：session-scoped input.left 按钮，不替换 composer、无 DOM 注入、不碰草稿', () => {
  const index = readSrc('index.js')
  assert.ok(index.includes("'remote.commands'"), '应声明命令通道依赖')
  assert.ok(index.includes("ctx.slots.inject('conversation.input.left'"), '按钮应注册在正式输入工具区 session-scoped slot')
  assert.ok(index.includes('dsh-workflow-start'), '注册 id 应命名空间隔离，不复用宿主条目 id')
  assert.ok(index.includes('StartWorkflowButton'), '应挂载启动弹窗组件')
  const modal = readSrc('start-modal.js')
  for (const banned of ['history.back', 'querySelector(', 'innerHTML', 'inputActions', 'setDraft', '/dsh-flow list', 'reset(']) {
    assert.ok(!modal.includes(banned), `不得引入 ${banned}`)
  }
  // 只读接缝 + 原生命令是唯二外部调用；弹窗自身不执行命令（runCommand 仅经提交封装调用）。
  assert.ok(modal.includes('loadCatalog('), '目录经只读接缝拉取')
  assert.ok(modal.includes('executeStartWorkflow('), '提交走原生命令封装')
  assert.ok(modal.includes('当前会话上下文会追加到 prompt 中'), '上下文提示必须可见')
  assert.ok(modal.includes('不会另行复制历史全文'), '上下文提示须说明实际语义')
  assert.ok(modal.includes('.yaml'), '列表展示 .yaml 文件名')
  assert.ok(modal.includes("aria-haspopup"), '按钮应声明弹窗语义')
  assert.ok(modal.includes('role: \'alert\'') || modal.includes('role:"alert"') || modal.includes("role: 'alert'"), '错误区域可播报')
})

test('#179 会话归属：切换会话关闭清理，陈旧响应双守卫丢弃，陈旧 close 代际守卫', () => {
  const modal = readSrc('start-modal.js')
  assert.ok(modal.includes('openSession'), '应记录弹窗所属 Session')
  assert.ok(modal.includes('sessionId !== openSession.current'), '会话切换/陈旧响应须按所属会话守卫')
  assert.ok(modal.includes('catalogGen'), '只读请求须有 generation 守卫')
  assert.ok(modal.includes('submitGate'), '本地提交闸门防重复派发')
  assert.ok(modal.includes('showModal'), '优先原生 dialog，不新增 UI 框架')
  assert.ok(modal.includes('openSeq') && modal.includes('pendingCloseGen'), '陈旧 close 事件须按打开代际守卫')
  assert.ok(modal.includes('shownSeq'), '打开 effect 不得随目录回调身份变化重开弹窗（F-004 会话切换回归）')
})

test('#179 隔离夹具提供启动弹窗受控页与检查脚本（浏览器证据链）', () => {
  const server = readFileSync(join(here, '..', 'scripts', 'editor-ui-smoke', 'server.mjs'), 'utf8')
  assert.ok(server.includes('/start'), '夹具应提供 /start 受控页')
  assert.ok(server.includes('conversation.input.left'), '夹具应捕获输入工具区注册做真实挂载')
  assert.ok(server.includes('/start-control'), '目录三态（ok/empty/error）应可经控制端点切换')
  assert.ok(server.includes('__runCommand'), '命令应经受控桩响应，不建真实 Run')
  const check = readFileSync(join(here, '..', 'scripts', 'editor-ui-smoke', 'check-start-modal.cjs'), 'utf8')
  for (const key of ['已有活动 Run', '不要自动重试', '__resolveHang', '__renderStart', '快速取消', 'wantEnabled']) {
    assert.ok(check.includes(key), `检查脚本应覆盖 ${key}`)
  }
})

test('#179 拼合 bundle 含启动按钮注册与弹窗实现', () => {
  const outFile = buildClientBundle({ outDir: mkdtempSync(join(tmpdir(), 'wf-start-bundle-')) })
  const bundle = readFileSync(outFile, 'utf8')
  for (const key of ['StartWorkflowButton', 'startCommandLineOf', 'canStartWorkflow', 'executeStartWorkflow', 'conversation.input.left', '启动工作流']) {
    assert.ok(bundle.includes(key), `bundle 应含 ${key}`)
  }
})
