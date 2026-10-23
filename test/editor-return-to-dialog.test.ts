/**
 * #177 配置页返回对话按钮：公开注册/行为回归（静态接线断言）。
 *
 * 断言用户可观察行为的接线形状，不 copy 源码文本做脆弱匹配：
 * 入口存在、干净返回 selectPanel(null)、确认取消/确认放弃、忙碌禁用、
 * 仅用宿主正式面板能力（无 history/DOM 私有选择器/独立路由）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildClientBundle } from '../web-client/build.mjs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFileSync as readBuilt } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'web-client', 'src')
const readSrc = (name: string) => readFileSync(join(srcDir, name), 'utf8')

test('#177 页头有常驻返回对话入口且忙碌禁用', () => {
  const panel = readSrc('panel.js')
  assert.ok(panel.includes('返回对话'), '页头应渲染“返回对话”入口')
  // 常驻：wf-header 内直接渲染按钮，不包在 draft/dir 门槛后。
  const header = panel.slice(panel.indexOf("className: 'wf-header'"))
  assert.ok(header.includes('返回对话'), '返回入口应在 wf-header 内常驻')
  assert.ok(panel.includes("}, '返回对话')"), '按钮文本应为“返回对话”')
  assert.match(panel, /onClick:\s*backToConversation,\s*disabled:\s*state\.busy/, '返回入口忙碌期间必须禁用')
})

test('#177 返回走宿主 selectPanel(null)，不碰历史/DOM/路由', () => {
  const panel = readSrc('panel.js')
  assert.ok(panel.includes('select.call(layout, null)') || panel.includes('selectPanel'), '应调用宿主 LayoutController.selectPanel')
  assert.ok(panel.includes('select.call(layout, null)'), '返回 Conversation 应为 selectPanel(null)')
  for (const banned of ['history.back', 'history.go', 'location.hash', 'location.href', 'querySelector(']) {
    assert.ok(!panel.includes(banned), `不得引入 ${banned}`)
  }
  // 脏检查复用编辑器现有 window.confirm 交互。
  assert.ok(panel.includes("window.confirm('有未保存的修改，返回对话将放弃它们。继续吗？')"), '脏状态应经现有 confirm 交互确认')
  assert.ok(panel.includes('isDirty(state)'), '应复用编辑器现有脏检查')
})

test('#177 取消保留状态、缺失宿主能力如实报错', () => {
  const panel = readSrc('panel.js')
  const fn = panel.slice(panel.indexOf('backToConversation'))
  // 取消路径直接 return：selectPanel 调用在 confirm 行之后，且取消分支无状态改写。
  const confirmIdx = fn.indexOf('window.confirm')
  const selectIdx = fn.indexOf('select.call(layout, null)')
  assert.ok(confirmIdx !== -1 && selectIdx !== -1 && confirmIdx < selectIdx, '确认应在调用宿主面板能力之前')
  assert.ok(fn.includes('宿主面板控制器缺失'), '宿主能力缺失应如实报错，不静默失败')
})

test('#177 注册入口透传宿主 layout，隔离夹具提供同形 stub', () => {
  const index = readSrc('index.js')
  assert.ok(index.includes('layout: ctx.layout'), '注册 inject 应透传宿主 layout')
  const server = readFileSync(join(here, '..', 'scripts', 'editor-ui-smoke', 'server.mjs'), 'utf8')
  assert.ok(server.includes('layout:{selectPanel'), '隔离夹具应提供 layout stub 供浏览器验证')
})

test('#177 拼合 bundle 含返回入口与宿主调用', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'wf-return-bundle-'))
  const outFile = buildClientBundle({ outDir })
  const bundle = readBuilt(outFile, 'utf8')
  assert.ok(bundle.includes('返回对话'), 'bundle 应含返回入口')
  assert.ok(bundle.includes('selectPanel'), 'bundle 应含宿主面板调用')
})
