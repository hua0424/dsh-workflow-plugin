/**
 * #101 工具链验收（现行验收入口的可跑证据）：
 * - `scripts/check-state-rows.mjs`：显式路径 + 真只读 + 当前/旧/未知/坏库分别诊断，
 *   不创建缺失的库、不改写字节，也不把坏库读成空库。
 * - `scripts/deploy-web.mjs`：隔离 bundle 产物元数据取自 package.json，DSH 宿主包
 *   留在 devDependencies（出现在 dependencies 即 fail-closed）；`--out` 缺值 fail-closed
 *   （CLI 层实测非零退出、不写 profile 目标）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { StateStore } from '../src/state/store.ts'
import { inspectStateDb, parseDiagnosticArgs } from '../scripts/check-state-rows.mjs'
import { bundlePackageJson, deployBundle, parseDeployArgs } from '../scripts/deploy-web.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const repoPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('#101 诊断：当前 v9 库被识别为 current，且读取前后字节与目录内容不变', () => {
  const { dir, cleanup } = tempDir('wf101-diag-current-')
  try {
    const store = new StateStore(dir)
    store.close()
    const dbPath = join(dir, 'workflows', 'state.sqlite3')
    const before = sha256(dbPath)
    const filesBefore = readdirSync(join(dir, 'workflows')).sort()
    const report = inspectStateDb(dbPath)
    assert.equal(report.kind, 'current')
    assert.deepEqual(report.tables, ['node_execution_events', 'node_executions', 'runs'])
    assert.deepEqual(report.runs, [])
    assert.equal(sha256(dbPath), before, '诊断不得改写库字节')
    assert.deepEqual(readdirSync(join(dir, 'workflows')).sort(), filesBefore, '诊断不得新增文件（含 WAL）')
  } finally { cleanup() }
})

test('#101 诊断：缺失路径返回 missing 而不创建库，缺参不默认真实 home', () => {
  const { dir, cleanup } = tempDir('wf101-diag-missing-')
  try {
    const missing = join(dir, 'workflows', 'state.sqlite3')
    const report = inspectStateDb(missing)
    assert.equal(report.kind, 'missing')
    assert.equal(existsSync(missing), false, '诊断不得创建缺失的库')
    assert.equal(existsSync(join(dir, 'workflows')), false)
    const usage = parseDiagnosticArgs([])
    assert.equal(usage.target, undefined)
    assert.match(usage.error ?? '', /用法/)
    assert.deepEqual(parseDiagnosticArgs(['--json', 'X:\\state.sqlite3']), { target: 'X:\\state.sqlite3', json: true, error: undefined })
  } finally { cleanup() }
})

test('#101 诊断：旧单表 workflow_state 有明确诊断，不读成空库', () => {
  const { dir, cleanup } = tempDir('wf101-diag-legacy-')
  try {
    const dbPath = join(dir, 'state.sqlite3')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE workflow_state (workspace_key TEXT, snapshot_json TEXT)')
    db.prepare('INSERT INTO workflow_state (workspace_key, snapshot_json) VALUES (?, ?)').run('C:\\ws', JSON.stringify({ run: { schemaVersion: 'agent-workflow-state/v2', status: 'completed' } }))
    db.close()
    const report = inspectStateDb(dbPath)
    assert.equal(report.kind, 'legacy')
    assert.equal(report.rows, 1)
    assert.match(report.detail, /incompatible-store/)
  } finally { cleanup() }
})

test('#101 诊断：未知布局与坏库分别诊断且不改写', () => {
  const { dir, cleanup } = tempDir('wf101-diag-unknown-')
  try {
    const unknownPath = join(dir, 'unknown.sqlite3')
    const db = new DatabaseSync(unknownPath)
    db.exec('CREATE TABLE whatever (x TEXT)')
    db.close()
    const unknownBefore = sha256(unknownPath)
    const unknown = inspectStateDb(unknownPath)
    assert.equal(unknown.kind, 'unknown')
    assert.match(unknown.detail, /未识别/)
    assert.equal(sha256(unknownPath), unknownBefore)

    const corruptPath = join(dir, 'corrupt.sqlite3')
    writeFileSync(corruptPath, 'this is not a sqlite database\n')
    const corruptBefore = sha256(corruptPath)
    const corrupt = inspectStateDb(corruptPath)
    assert.equal(corrupt.kind, 'corrupt')
    assert.match(corrupt.detail, /不可读|只读方式打开/)
    assert.equal(sha256(corruptPath), corruptBefore, '坏库字节必须原样保留')
  } finally { cleanup() }
})

test('#101 隔离 bundle：元数据取自 package.json 且不含 DSH 宿主包', () => {
  const manifest = bundlePackageJson(repoPackage)
  assert.equal(manifest.version, repoPackage.version)
  assert.deepEqual(manifest.dependencies, repoPackage.dependencies)
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['yaml', 'zod'])
  assert.equal(Object.keys(manifest).includes('devDependencies'), false)
  assert.deepEqual(Object.keys(manifest.dependencies).filter(name => name.startsWith('@deepseek-ai/')), [])
  assert.deepEqual(manifest.dsh, repoPackage.dsh)
  assert.throws(() => bundlePackageJson({ ...repoPackage, dependencies: { ...repoPackage.dependencies, '@deepseek-ai/dsh-agent': '0.1.5-rc.2' } }),
    /must stay in devDependencies/)
})

test('#101 隔离 bundle：deployBundle 只写隔离目标，产物版本/依赖与包元数据一致', () => {
  const { dir, cleanup } = tempDir('wf101-bundle-')
  try {
    const fakeRepo = join(dir, 'repo')
    mkdirSync(join(fakeRepo, 'lib', 'nested'), { recursive: true })
    writeFileSync(join(fakeRepo, 'lib', 'index.js'), 'export {}\n')
    writeFileSync(join(fakeRepo, 'lib', 'nested', 'x.js'), 'export {}\n')
    writeFileSync(join(fakeRepo, 'cordis.patch.yml'), '- insert: { id: dsh-agent-team-workflow }\n')
    writeFileSync(join(fakeRepo, 'package.json'), JSON.stringify(repoPackage, null, 2))
    const target = join(dir, 'isolated-bundle')
    const { manifest } = deployBundle({ repoRoot: fakeRepo, target })
    const written = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.deepEqual(written, manifest)
    assert.equal(written.version, repoPackage.version)
    assert.deepEqual(written.dependencies, repoPackage.dependencies)
    assert.equal(existsSync(join(target, 'lib', 'index.js')), true)
    assert.equal(existsSync(join(target, 'lib', 'nested', 'x.js')), true)
    assert.match(readFileSync(join(target, 'cordis.patch.yml'), 'utf8'), /dsh-agent-team-workflow/)
    assert.throws(() => deployBundle({ repoRoot: join(dir, 'empty'), target }), /lib\/index\.js missing/)
  } finally { cleanup() }
})

test('#101 部署参数：--out 缺值是用法错误，只有无 --out 才走默认目标', () => {
  assert.deepEqual(parseDeployArgs([]), { out: undefined }, '不带 --out 才是部署到 profile 默认目标')
  assert.deepEqual(parseDeployArgs(['--out', 'D:\\tmp\\bundle']), { out: 'D:\\tmp\\bundle' })
  for (const argv of [['--out'], ['--out', ''], ['--out', '--json']]) {
    assert.throws(() => parseDeployArgs(argv), /--out 缺少目录参数[\s\S]*用法/, `缺值必须 fail-closed：${JSON.stringify(argv)}`)
  }
})

test('#101 部署 CLI：--out 缺值非零退出，且不创建默认 profile 目标（不碰真实 home）', () => {
  const { dir, cleanup } = tempDir('wf101-deploy-fakehome-')
  try {
    // 把 home 指向一次性临时目录：缺值一旦回落默认目标就会在这里留下产物，从而被抓到
    const fakeHome = join(dir, 'fakehome')
    mkdirSync(fakeHome)
    const run = argv => spawnSync(process.execPath, [join(repoRoot, 'scripts', 'deploy-web.mjs'), ...argv],
      { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome } })
    const target = join(fakeHome, '.dsh', 'profiles', 'web', 'wfdev')
    const missing = run(['--out'])
    assert.equal(missing.status, 2, '--out 缺值必须以用法错误退出')
    assert.equal(existsSync(target), false, '--out 缺值不得回落到 profile 目标并写产物')
    assert.deepEqual(readdirSync(fakeHome), [], '--out 缺值不得产生任何文件系统写入')
    const flagged = run(['--out', '--force'])
    assert.equal(flagged.status, 2, '--out 后面跟的是另一个开关时同样按缺值处理')
    assert.equal(existsSync(target), false)
  } finally { cleanup() }
})
