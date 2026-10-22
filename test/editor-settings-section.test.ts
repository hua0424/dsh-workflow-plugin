/**
 * #219 配置编辑器入口迁入设置页：公开注册形状回归（静态接线断言 + bundle 拼合）。
 *
 * 断言用户可观察的接线形状，不 copy 源码文本做脆弱匹配：入口是 `settings.section`
 * 一页（id 沿用 workflow-config-editor、label「工作流配置」、order 在宿主现有
 * section 之后），侧栏 `sidebar.panellist` 与 root `main` keyed 注册不再存在，
 * 「返回对话」入口与宿主 `layout.selectPanel` 调用彻底消失，编辑器能力原样保留。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildClientBundle } from '../web-client/build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'web-client', 'src')
const readSrc = (name: string) => readFileSync(join(srcDir, name), 'utf8')

test('#219 入口注册为设置页 settings.section 一页', () => {
  const index = readSrc('index.js')
  assert.ok(index.includes("ctx.slots.inject('settings.section'"), '应依赖宿主 settings.section 声明后注册')
  assert.ok(index.includes("name: 'settings.section'"), '注册目标应为 settings.section list slot')
  assert.ok(index.includes('id: PANEL_KEY'), 'section id 应沿用现有 workflow-config-editor')
  assert.ok(index.includes("label: '工作流配置'"), '导航文本应为「工作流配置」')
  assert.ok(index.includes('WorkflowConfigEditorPanel'), '设置页内容应为编辑器面板本体')
  // order 放设置导航后段：宿主现有 section 为 account(-10)/general(0)/models(10)/plugins(15)/agent-presets(20)。
  const order = index.match(/SETTINGS_SECTION_ORDER\s*=\s*(\d+)/)
  assert.ok(order !== null, '应显式声明 section order 常量')
  assert.ok(Number(order[1]) > 20, `order 应排在宿主现有 section 之后，实际 ${order[1]}`)
})

test('#219 侧栏入口与 root main keyed 注册已移除', () => {
  const index = readSrc('index.js')
  for (const gone of ['sidebar.panellist', "name: 'main'", 'ctx.layout', 'WorkflowConfigEditorIcon']) {
    assert.ok(!index.includes(gone), `不应再出现 ${gone}`)
  }
  const injectList = index.match(/export const inject = \[([^\]]*)\]/)
  assert.ok(injectList !== null, '应声明浏览器侧 inject 列表')
  assert.ok(!injectList[1].includes("'layout'"), 'layout 依赖应随入口迁移一并收窄')
  for (const kept of ["'slots'", "'connection'", "'remote'", "'remote.session'", "'remote.commands'"]) {
    assert.ok(injectList[1].includes(kept), `inject 列表应保留 ${kept}`)
  }
  // 启动按钮是另一条入口链路，本次不动。
  assert.ok(index.includes("ctx.slots.inject('conversation.input.left'"), '对话输入区启动按钮应保持注册')
})

test('#219 返回对话入口与宿主面板调用彻底删除', () => {
  const panel = readSrc('panel.js')
  for (const gone of ['返回对话', 'selectPanel', 'backToConversation', 'props.layout']) {
    assert.ok(!panel.includes(gone), `编辑器不应再出现 ${gone}`)
  }
  for (const banned of ['history.back', 'history.go', 'location.hash', 'location.href', 'querySelector(']) {
    assert.ok(!panel.includes(banned), `不得引入 ${banned}`)
  }
})

test('#219 编辑器能力原样保留', () => {
  const panel = readSrc('panel.js')
  for (const kept of ['打开目录', '恢复上次目录', '新建配置', '保存', 'wf-canvas']) {
    assert.ok(panel.includes(kept), `设置页内编辑器应保留 ${kept}`)
  }
  assert.ok(panel.includes('export function WorkflowConfigEditorPanel'), '面板组件仍应导出')
})

test('#219 隔离夹具按 settings.section 挂载，无 layout stub', () => {
  const server = readFileSync(join(here, '..', 'scripts', 'editor-ui-smoke', 'server.mjs'), 'utf8')
  assert.ok(server.includes("spec.name==='settings.section'"), '浏览器夹具应挂载设置页注册内容')
  assert.ok(!server.includes('selectPanel'), '夹具不应再提供 layout stub')
})

test('#219 拼合 bundle 含设置页注册且无旧入口痕迹', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'wf-settings-bundle-'))
  const outFile = buildClientBundle({ outDir })
  const bundle = readFileSync(outFile, 'utf8')
  assert.ok(bundle.includes("name: 'settings.section'"), 'bundle 应含设置页注册')
  assert.ok(bundle.includes('工作流配置'), 'bundle 应含设置页导航文本')
  for (const gone of ['返回对话', 'selectPanel', 'sidebar.panellist']) {
    assert.ok(!bundle.includes(gone), `bundle 不应含 ${gone}`)
  }
})
