/** `dsh-workflow-init` 一键安装的契约测试（Issue #209）：落盘语义与薄封装一致性。 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInit, parseInitArgs, resolveInitSources, canonicalJson, MINIMAL_WORKFLOW_IDS, FULL_WORKFLOW_IDS } from '../src/init/install.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = resolveInitSources(REPO_ROOT)

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-init-test-'))
  mkdirSync(join(home, 'workflows'), { recursive: true })
  return home
}

describe('parseInitArgs', () => {
  it('缺省全关', () => {
    assert.deepEqual(parseInitArgs([]), { options: { full: false, force: false, dryRun: false }, home: undefined })
  })

  it('各开关与 --home 生效，未知参数报错', () => {
    const parsed = parseInitArgs(['--full', '--force', '--dry-run', '--home', '/tmp/x'])
    assert.deepEqual(parsed.options, { full: true, force: true, dryRun: true })
    assert.equal(parsed.home, '/tmp/x')
    assert.match(parseInitArgs(['--bogus']).error ?? '', /未知参数/)
    assert.match(parseInitArgs(['--home']).error ?? '', /缺少目录参数/)
  })
})

describe('runInit', () => {
  let home = ''
  beforeEach(() => { home = makeHome() })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('最小集：只装 rapid 模板 + preset，不过装其余模板', () => {
    const result = runInit(home, SOURCES, { full: false, force: false, dryRun: false })
    assert.equal(result.ok, true)
    assert.ok(existsSync(join(home, 'workflows', 'coding-workflow-rapid.yaml')))
    assert.ok(existsSync(join(home, 'cordis.patch.yml')))
    for (const id of FULL_WORKFLOW_IDS) {
      if ((MINIMAL_WORKFLOW_IDS as readonly string[]).includes(id)) continue
      assert.equal(existsSync(join(home, 'workflows', `${id}.yaml`)), false)
    }
  })

  it('全量：装全部生产模板，遗留模板不在安装源内', () => {
    const result = runInit(home, SOURCES, { full: true, force: false, dryRun: false })
    assert.equal(result.ok, true)
    for (const id of FULL_WORKFLOW_IDS) {
      assert.ok(existsSync(join(home, 'workflows', `${id}.yaml`)), id)
    }
    assert.match(result.text, /definitionHash=/)
  })

  it('幂等：第二次跑全部 up-to-date', () => {
    runInit(home, SOURCES, { full: true, force: false, dryRun: false })
    const second = runInit(home, SOURCES, { full: true, force: false, dryRun: false })
    assert.equal(second.ok, true)
    assert.match(second.text, /up-to-date/)
    assert.doesNotMatch(second.text, /installed|overwritten|skipped/)
  })

  it('用户文件：内容不同默认跳过并提示首个差异行；--force 备份后覆盖', () => {
    runInit(home, SOURCES, { full: false, force: false, dryRun: false })
    const target = join(home, 'workflows', 'coding-workflow-rapid.yaml')
    writeFileSync(target, '# 用户手改\nid: custom\n', 'utf8')
    const skipped = runInit(home, SOURCES, { full: false, force: false, dryRun: false })
    assert.equal(skipped.ok, true)
    assert.match(skipped.text, /skipped workflows\/coding-workflow-rapid\.yaml/)
    assert.match(skipped.text, /第 1 行不同/)
    assert.equal(readFileSync(target, 'utf8').startsWith('# 用户手改'), true)
    const forced = runInit(home, SOURCES, { full: false, force: true, dryRun: false })
    assert.match(forced.text, /overwritten workflows\/coding-workflow-rapid\.yaml/)
    assert.match(forced.text, /\.bak-\d+/)
    assert.equal(readFileSync(target, 'utf8').startsWith('# 用户手改'), false)
  })

  it('--dry-run：零写入但报告 would-install', () => {
    const result = runInit(home, SOURCES, { full: false, force: false, dryRun: true })
    assert.equal(result.ok, true)
    assert.match(result.text, /would-install/)
    assert.equal(existsSync(join(home, 'workflows', 'coding-workflow-rapid.yaml')), false)
    assert.equal(existsSync(join(home, 'cordis.patch.yml')), false)
  })

  it('preset 合并：保留用户原有行，只追加声明', () => {
    writeFileSync(join(home, 'cordis.patch.yml'), '- name: user-plugin\n', 'utf8')
    const result = runInit(home, SOURCES, { full: false, force: false, dryRun: false })
    assert.equal(result.ok, true)
    const text = readFileSync(join(home, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /user-plugin/)
    assert.match(text, /id: preset-manager/)
    assert.match(result.text, /OK cordis\.patch\.yml/)
  })

  it('遗留模板不可装：源目录扫描不到 workflow-template', () => {
    const ids = SOURCES.workflows.map(item => item.id)
    assert.equal(ids.includes('workflow-template'), false)
  })
})

describe('canonicalJson', () => {
  it('key 顺序不同视为相同', () => {
    assert.equal(canonicalJson({ b: 1, a: [1, { y: 2, x: 1 }] }), canonicalJson({ a: [1, { x: 1, y: 2 }], b: 1 }))
    assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }))
  })
})

describe('scripts/dsh-workflow-init.mjs 薄封装', () => {
  const script = join(REPO_ROOT, 'scripts', 'dsh-workflow-init.mjs')

  it('--dry-run --home：与库同语义，只报告不写入', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-init-script-'))
    try {
      const minimal = spawnSync(process.execPath, [script, '--dry-run', '--home', home], { encoding: 'utf8' })
      assert.equal(minimal.status, 0, minimal.stderr)
      assert.match(minimal.stdout, /would-install workflows\/coding-workflow-rapid\.yaml/)
      assert.match(minimal.stdout, /would-install cordis\.patch\.yml/)
      assert.deepEqual(readdirSync(home), [], '预演不得写入任何文件')
      const full = spawnSync(process.execPath, [script, '--full', '--dry-run', '--home', home], { encoding: 'utf8' })
      assert.equal(full.status, 0, full.stderr)
      for (const id of FULL_WORKFLOW_IDS) assert.match(full.stdout, new RegExp(`would-install workflows/${id}\\.yaml`), id)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('未知参数 exit 2 且不写入', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-init-script-'))
    try {
      const result = spawnSync(process.execPath, [script, '--bogus', '--home', home], { encoding: 'utf8' })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /未知参数/)
      assert.deepEqual(readdirSync(home), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
