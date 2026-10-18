#!/usr/bin/env node
/**
 * `dsh-workflow-init` 仓库侧薄封装（Issue #209）：与对话内 `/dsh-flow init`
 * 共享同一套落盘语义（`src/init/install.ts` 的 parseInitArgs/resolveInitSources/runInit），
 * 只多一个对话内不支持的 `--home <目录>`（缺省为当前 DSH home）。
 *
 * 用法：node scripts/dsh-workflow-init.mjs [--full] [--force] [--dry-run] [--home <目录>]
 */
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseInitArgs, resolveInitSources, runInit } from '../src/init/install.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const parsed = parseInitArgs(process.argv.slice(2))
if (parsed.error !== undefined) {
  console.error(parsed.error)
  process.exit(2)
}
if (parsed.help === true) {
  console.log('用法：node scripts/dsh-workflow-init.mjs [--full] [--force] [--dry-run] [--home <目录>]\n'
    + '缺省安装最小集与通用 Manager preset；--full 全量；--force 备份后覆盖；--dry-run 只报告不写入。')
  process.exit(0)
}
let sources
try {
  sources = resolveInitSources(repoRoot)
} catch (error) {
  console.error(`初始化资源缺失，未写入：${String(error)}`)
  process.exit(1)
}
const home = parsed.home ?? resolveDshHome()
const result = runInit(home, sources, parsed.options)
console.log(result.text)
process.exit(result.ok ? 0 : 1)
