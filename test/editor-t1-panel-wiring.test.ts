/**
 * T1（#160 r002 返工 F5）：面板↔edits 接线完整性。
 *
 * r002 根因：`panel.js` 引用 `ID_PATTERN` 却未引入——拼合打包（build.mjs）
 * 只按 import 行改写，未引入的标识符在源码与 bundle 中均为运行时
 * ReferenceError，而 `node --check` / edits 单测 / 工厂桩冒烟都拦不住。
 * 本文件静态断言：panel 实际使用的 edits 导出名 ⊆ import 列表，
 * 且 ⊆ build.mjs `__edits` 返回列表（任一漏写都会复现 F5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'web-client', 'src')
const readSrc = (name: string) => readFileSync(join(srcDir, name), 'utf8')
const readBuild = () => readFileSync(join(here, '..', 'web-client', 'build.mjs'), 'utf8')

function exportNames(source: string): string[] {
  return [...source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1])
}

/** `import { a, b as c } from './edits.js'` → 本地绑定名 [a, c]。 */
function importedFromEdits(source: string): string[] {
  const block = source.match(/^import\s*\{([^}]*)\}\s*from\s*['"]\.\/edits\.js['"];?/m)?.[1] ?? ''
  return block.split(',').map((part) => {
    const alias = part.trim().match(/^(\w+)\s+as\s+(\w+)$/)
    return alias?.[2] ?? part.trim()
  }).filter((name) => name !== '')
}

/** 去 import 块（可跨行）/注释/字符串（模板字面量保留 ${} 内插）后，`name` 是否成词出现。 */
function usedInCode(source: string, name: string): boolean {
  const stripped = source
    .replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, (lit) => [...lit.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(' '))
  return new RegExp(`\\b${name}\\b`).test(stripped)
}

test('panel 引用的 edits 导出名 ⊆ import 列表且 ⊆ __edits 返回列表（F5 防回归）', () => {
  const panel = readSrc('panel.js')
  const editsExports = exportNames(readSrc('edits.js'))
  assert.ok(editsExports.length > 0, 'edits.js 应有具名导出')
  const used = editsExports.filter((name) => usedInCode(panel, name))
  assert.ok(used.length > 0, 'panel 应实际使用 edits 导出（否则本检查无意义）')
  const missingImport = used.filter((name) => !importedFromEdits(panel).includes(name))
  assert.deepStrictEqual(missingImport, [], `panel 使用但未从 ./edits.js 引入：${missingImport.join(', ')}`)
  const returned = readBuild().match(/var __edits = \(function \(\) \{[\s\S]*?return \{([^}]*)\}/)?.[1] ?? ''
  const returnedNames = returned.split(',').map((part) => part.trim()).filter((name) => name !== '')
  const missingReturn = used.filter((name) => !returnedNames.includes(name))
  assert.deepStrictEqual(missingReturn, [], `panel 使用但未进 __edits 返回列表：${missingReturn.join(', ')}`)
})
