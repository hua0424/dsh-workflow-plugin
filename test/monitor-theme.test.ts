import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * #282 监控面板展示契约：主题色、记录表滚动、运行图高度。
 * 这些是纯 CSS 事实（无 DOM 可测），直接断言内联样式表文本；行为侧断言在 monitor-poll-lifecycle。
 */
function monitorStyles(): string {
  const source = readFileSync(new URL('../web-client/src/monitor.js', import.meta.url), 'utf8')
  const start = source.indexOf('export const MONITOR_STYLES')
  const end = source.indexOf('export function useMonitorPolling')
  assert.ok(start >= 0 && end > start, 'monitor.js 里应能找到内联样式表')
  // 去掉注释：注释里会说明「不再用 --dsh-text/#ddd」，不是样式规则本身。
  return source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
}

test('#282 主题契约：改用宿主 --dsw-alias-* 语义色，不再依赖未定义的 --dsh-* 与 #ddd 兜底', () => {
  const styles = monitorStyles()
  assert.doesNotMatch(styles, /--dsh-(text|muted)/, '宿主只定义 --dsw-* token，--dsh-* 永远取不到值')
  assert.doesNotMatch(styles, /#ddd\b/i, '不再用浅灰兜底（深色主题下会出现浅灰字压浅灰底）')
  assert.match(styles, /color: var\(--dsw-alias-label-primary, currentColor\)/, '正文色接宿主主文字色')
  assert.match(styles, /color: var\(--dsw-alias-label-secondary, currentColor\)/, '次要文字接宿主次文字色')
  // 状态文字由宿主状态色与正文色混合：浅色混近黑、深色混近白，两套主题都保持 >=4.5:1（宿主原生
  // --dsw-alias-state-success-primary 等在浅色下仅 2.28:1，不能直接当文字色）。
  assert.match(styles, /color-mix\(in srgb, var\(--dsw-alias-state-success-primary, #22c55e\) 45%, var\(--dsw-alias-label-primary, currentColor\)\)/)
  assert.match(styles, /color-mix\(in srgb, var\(--dsw-alias-state-error-primary, #ec1313\) 60%, var\(--dsw-alias-label-primary, currentColor\)\)/)
  // 旧的写死浅色文字全部引入 token 体系。
  assert.doesNotMatch(styles, /color: (#9fc8ff|#ffb4b4|#9fdca4|#ffd479|#c9a6ff|#1d4ed8)\b/i)
  // 共享画布在监控内跟随主题（独立编辑器面板不受影响，选择器限定在 .wf-monitor-graph 下）。
  assert.match(styles, /\.wf-monitor-graph \.wf-editor\.wf-monitor-canvas \{[^}]*--wf-text: var\(--dsw-alias-label-primary/)
})

test('#282 执行记录表只保留横向滚动，不再有独立限高的纵向滚动区', () => {
  const styles = monitorStyles()
  const rule = /\.wf-monitor-records-scroll \{[^}]*\}/.exec(styles)?.[0] ?? ''
  assert.match(rule, /overflow-x: auto/)
  assert.match(rule, /overflow-y: hidden/)
  assert.doesNotMatch(rule, /max-height/, '内层纵向限高会让整栏滚动路径断裂：记录被困在 360px 盒子里')
  assert.doesNotMatch(styles, /max-height:\s*360px/)
})

test('#282 运行图默认高度适中，并用更高特异度压过共享编辑器的 460px 覆盖', () => {
  const styles = monitorStyles()
  // 共享编辑器 @container (max-width: 880px) 的 .wf-editor .wf-canvas 规则会在窄侧栏赢下同特异度监控规则。
  assert.match(styles, /\.wf-monitor-graph \.wf-editor\.wf-monitor-canvas \.wf-canvas \{ height: 260px; min-height: 220px; \}/)
  assert.doesNotMatch(styles, /\.wf-monitor-graph \.wf-canvas \{\s*height: 420px/)
})
