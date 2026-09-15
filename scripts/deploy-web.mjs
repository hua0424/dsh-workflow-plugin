/**
 * 生成/部署插件 bundle：把编译产物 `lib/`、`cordis.patch.yml` 和 bundle `package.json`
 * 放进目标目录（wfgate 同款布局），使 `@deepseek-ai/*` 经 profile 的 node_modules
 * fallback 解析到**宿主自己的实例**，运行依赖（yaml/zod）由 profile 的 pnpm 安装。
 *
 * 用法：
 *   node scripts/deploy-web.mjs                 # 部署到 ~/.dsh/profiles/web/wfdev（需用户授权）
 *   node scripts/deploy-web.mjs --out <目录>    # 只在隔离目录生成产物，用于验收（不碰 profile）
 *
 * `--out` 给了但缺目录（末尾漏写、变量展开为空等）是**用法错误**：只打印用法并以 2 退出，
 * 在任何文件系统写操作之前返回，绝不静默回落到 `~/.dsh/profiles/web/wfdev` 的真实部署路径
 * （Issue #101 M-1）。
 *
 * 元数据单源（Issue #101 AC4）：bundle `package.json` 的必要字段全部从仓库
 * `package.json` 选取，不再手抄一份；`@deepseek-ai/*` 宿主包只允许留在
 * devDependencies（Dependencies 里出现即 fail-closed），运行依赖仍只有 yaml/zod。
 */
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 从仓库 package.json 选取 bundle 需要的字段；宿主包出现在 dependencies 即拒绝。 */
export function bundlePackageJson(pkg) {
  const dependencies = pkg.dependencies ?? {}
  const hostPackages = Object.keys(dependencies).filter(name => name.startsWith('@deepseek-ai/'))
  if (hostPackages.length > 0) {
    throw new Error(`DSH host packages must stay in devDependencies, found in dependencies: ${hostPackages.join(', ')}`)
  }
  return {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    main: pkg.main,
    license: pkg.license,
    dependencies,
    dsh: pkg.dsh,
  }
}

/** 把 repoRoot 的构建产物与方法返回的元数据写进 target；返回写出的 manifest。 */
export function deployBundle({ repoRoot, target }) {
  if (!existsSync(join(repoRoot, 'lib', 'index.js'))) {
    throw new Error('lib/index.js missing — run the build first (`pnpm run build`)')
  }
  const manifest = bundlePackageJson(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')))
  mkdirSync(target, { recursive: true })
  // Replace lib wholesale (removes old junction/copy trees).
  rmSync(join(target, 'lib'), { recursive: true, force: true })
  cpSync(join(repoRoot, 'lib'), join(target, 'lib'), { recursive: true })
  writeFileSync(join(target, 'cordis.patch.yml'), readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8'), 'utf8')
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return { target, manifest }
}

export const DEPLOY_USAGE = '用法：node scripts/deploy-web.mjs [--out <目录>]\n'
  + '不带 --out 时部署到 ~/.dsh/profiles/web/wfdev（需用户显式授权）；'
  + '带 --out 时只在给定目录生成产物，不碰 profile。'

/**
 * 解析 CLI 参数：只有 `--out` 后面跟着真实目录值时才是隔离生成模式。
 * `--out` 出现但缺值一律抛错（fail-closed）——缺值不是"没给 --out"，不得回落到真实部署目标。
 */
export function parseDeployArgs(argv) {
  const outIndex = argv.indexOf('--out')
  if (outIndex === -1) return { out: undefined }
  const value = argv[outIndex + 1]
  if (value === undefined || value === '' || value.startsWith('-')) {
    throw new Error(`--out 缺少目录参数\n${DEPLOY_USAGE}`)
  }
  return { out: value }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  let out
  try {
    out = parseDeployArgs(process.argv.slice(2)).out
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
  const defaultTarget = join(homedir(), '.dsh', 'profiles', 'web', 'wfdev')
  const target = out === undefined ? defaultTarget : resolve(out)
  const { manifest } = deployBundle({ repoRoot, target })
  console.log(`${out === undefined ? 'deployed' : 'generated isolated bundle'} to ${target} (version ${manifest.version})`)
  if (out === undefined) console.log('next: restart DSH; verify with /dsh-flow list')
}
