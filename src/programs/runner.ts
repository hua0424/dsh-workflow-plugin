/**
 * Program runner adapters: git subprocess wrapper and gh CLI runner
 * (design §10.1 I1-I3). Zero host dependencies; spawnSync with argument arrays
 * (never a shell string), short timeouts, structured outcomes.
 */
import { spawnSync } from 'node:child_process'
import type { ProgramResult } from '../types.ts'

export interface RunOutcome {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  failedToStart: boolean
}

/** 一次 gh 调用的入参（受控适配器的调用形状）。 */
export interface GhCall {
  cwd: string
  method: string
  path: string
  query?: string
  input?: unknown
  timeoutMs?: number
}

export type GhApiOutcome = { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string }

/**
 * 受控进程适配器（Issue #92）：只读事实与写动作都经此出口，测试注入受控实现，
 * 不在测试里真的 spawn（受限沙箱捕获子进程管道会 EPERM）。
 */
export interface RepositoryAdapter {
  git(args: string[], cwd: string): RunOutcome
  gh(call: GhCall): GhApiOutcome
}

export const realRepositoryAdapter: RepositoryAdapter = {
  git: (args, cwd) => runProgram('git', args, { cwd }),
  gh: call => ghApi(call),
}

/** 只读事实三态：value=事实；none=事实明确不存在；error=读取失败（绝不能当成不存在/空集合/clean）。 */
export type Fact<T> = { kind: 'value'; value: T } | { kind: 'none'; reason: string } | { kind: 'error'; reason: string }


/** Run one program without a shell, capturing output with a timeout. */
export function runProgram(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): RunOutcome {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const started = Date.now()
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error), timedOut: false, failedToStart: true }
  }
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { exitCode: -1, stdout: '', stderr: `command not found: ${cmd}`, timedOut: false, failedToStart: true }
    return { exitCode: -1, stdout: '', stderr: String(result.error), timedOut: false, failedToStart: true }
  }
  return {
    exitCode: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    timedOut: Date.now() - started >= timeoutMs && (result.signal === 'SIGTERM' || result.signal === 'SIGKILL'),
    failedToStart: false,
  }
}

/** 读取失败的统一原因文本（判定"不存在"只用 git 自己的 absent 答复，不用任意非零码）。 */
function readFailed(out: RunOutcome, what: string): string {
  if (out.failedToStart) return `${what}: ${out.stderr.trim() || 'failed to start'}`
  if (out.timedOut) return `${what}: timed out`
  return `${what}: exit ${out.exitCode}${out.stderr.trim() === '' ? '' : ` (${out.stderr.trim().slice(0, 200)})`}`
}

const isNotARepo = (out: RunOutcome): boolean => /not a git repository/i.test(`${out.stderr}${out.stdout}`)

/** 仓库根目录：value=路径；none=不是 git 仓库（事实）；error=读取失败。 */
export function gitTopLevel(adapter: RepositoryAdapter, cwd: string): Fact<string> {
  const out = adapter.git(['rev-parse', '--show-toplevel'], cwd)
  if (out.exitCode === 0 && out.stdout.trim() !== '') return { kind: 'value', value: out.stdout.trim() }
  if (isNotARepo(out)) return { kind: 'none', reason: 'not a git repository' }
  return { kind: 'error', reason: readFailed(out, 'git rev-parse --show-toplevel') }
}

/** HEAD：value=分支名（null=detached HEAD）；none=不是 git 仓库；error=读取失败。 */
export function gitHead(adapter: RepositoryAdapter, cwd: string): Fact<string | null> {
  const out = adapter.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (out.exitCode === 0) {
    const name = out.stdout.trim()
    return { kind: 'value', value: name === '' || name === 'HEAD' ? null : name }
  }
  if (isNotARepo(out)) return { kind: 'none', reason: 'not a git repository' }
  return { kind: 'error', reason: readFailed(out, 'git rev-parse --abbrev-ref HEAD') }
}

/** origin URL：value=URL；none=无 origin（或不是仓库）；error=读取失败。 */
export function gitOriginUrl(adapter: RepositoryAdapter, cwd: string): Fact<string> {
  const out = adapter.git(['remote', 'get-url', 'origin'], cwd)
  if (out.exitCode === 0) return out.stdout.trim() === ''
    ? { kind: 'none', reason: 'no origin remote' }
    : { kind: 'value', value: out.stdout.trim() }
  if (isNotARepo(out)) return { kind: 'none', reason: 'not a git repository' }
  if (/no such remote/i.test(out.stderr)) return { kind: 'none', reason: 'no origin remote' }
  return { kind: 'error', reason: readFailed(out, 'git remote get-url origin') }
}

/** 工作树状态（porcelain=v1）：value='' 表示干净；none=不是 git 仓库；error=读取失败（不当 clean）。 */
export function gitStatusShort(adapter: RepositoryAdapter, cwd: string): Fact<string> {
  const out = adapter.git(['status', '--porcelain=v1'], cwd)
  if (out.exitCode === 0) return { kind: 'value', value: out.stdout }
  if (isNotARepo(out)) return { kind: 'none', reason: 'not a git repository' }
  return { kind: 'error', reason: readFailed(out, 'git status --porcelain=v1') }
}

/** 本地分支（精确比对 refname，避免 pattern 通配）：value=refname；none=不存在；error=读取失败。 */
export function gitLocalBranch(adapter: RepositoryAdapter, cwd: string, branchName: string): Fact<string> {
  const ref = `refs/heads/${branchName}`
  const out = adapter.git(['for-each-ref', '--format=%(refname)', ref], cwd)
  if (out.exitCode !== 0) return { kind: 'error', reason: readFailed(out, `git for-each-ref ${ref}`) }
  const found = out.stdout.split('\n').map(line => line.trim()).find(line => line === ref)
  return found === undefined ? { kind: 'none', reason: 'local branch does not exist' } : { kind: 'value', value: found }
}

/** 远端分支：value=ls-remote 行；none=不存在；error=读取失败（失败不得当成"不存在"后继续 push）。 */
export function gitRemoteBranch(adapter: RepositoryAdapter, cwd: string, branchName: string): Fact<string> {
  const out = adapter.git(['ls-remote', '--heads', 'origin', branchName], cwd)
  if (out.exitCode !== 0) return { kind: 'error', reason: readFailed(out, `git ls-remote --heads origin ${branchName}`) }
  const lines = out.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.length === 0 ? { kind: 'none', reason: 'remote branch does not exist' } : { kind: 'value', value: lines[0]! }
}

/** Parse an origin URL like git@github.com:owner/repo.git or https://github.com/owner/repo.git. */
export function parseOriginRepo(originUrl: string): { owner: string; repo: string } | undefined {
  const m = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(originUrl.trim())
    ?? /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(originUrl.trim())
  if (m === null) return undefined
  const owner = m[1]!.trim()
  const repo = m[2]!.trim().replace(/\/$/, '')
  if (owner === '' || repo === '') return undefined
  return { owner, repo }
}

/** Pure argv construction for one gh api invocation (exported for tests). */
export function buildGhArgs(path: string, method: string, query?: string, input?: unknown): string[] {
  const endpoint = query !== undefined && query !== '' ? `${path}?${query}` : path
  const args = ['api', endpoint, '--method', method]
  if (input !== undefined) args.push('--input', '-')
  return args
}

/**
 * 纯函数：把一次 gh 子进程出口收成结构化结果（测试 seam，避免真的 spawn）。
 * 失败/空输出/无效 JSON 一律 ERROR——把无效 JSON 降级成字符串或空集合会让
 * 调用方把"读不到"误当成"读到空"。
 */
export function shapeGhOutcome(out: RunOutcome): GhApiOutcome {
  if (out.failedToStart) return { kind: 'ERROR', reason: out.stderr.trim() || 'gh CLI failed to start' }
  if (out.timedOut) return { kind: 'ERROR', reason: 'gh api timed out' }
  if (out.exitCode !== 0) return { kind: 'ERROR', reason: `gh api failed (${out.exitCode}): ${(out.stderr || out.stdout).trim().slice(0, 400)}` }
  if (out.stdout.trim() === '') return { kind: 'ERROR', reason: 'gh api returned no output' }
  try {
    return { kind: 'PASS', details: JSON.parse(out.stdout) }
  } catch {
    return { kind: 'ERROR', reason: `gh api returned invalid JSON: ${out.stdout.trim().slice(0, 200)}` }
  }
}

/** Run `gh api` with method/path/query; structured outcome (PASS carries the full parsed JSON, ERROR carries reason; ghApi never returns FAIL). */
export function ghApi(opts: GhCall): GhApiOutcome {
  const args = buildGhArgs(opts.path, opts.method, opts.query, opts.input)
  const timeoutMs = opts.timeoutMs ?? 60_000
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('gh', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
      input: opts.input === undefined ? undefined : JSON.stringify(opts.input),
    })
  } catch (error) {
    return { kind: 'ERROR', reason: String(error) }
  }
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'ERROR', reason: 'gh CLI not found on PATH' }
    return { kind: 'ERROR', reason: String(result.error) }
  }
  return shapeGhOutcome({
    exitCode: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    timedOut: result.signal !== null,
    failedToStart: false,
  })
}

/** 分页大小：与既有查询一致（首批 per_page=100）。 */
export const GH_PAGE_SIZE = 100
/** 分页页数上限；达到上限仍未见短页 → ERROR，绝不截断后宣称完整。 */
export const GH_MAX_PAGES = 50
/** 分页总时间预算（每页自身另有 60s 上限）。 */
export const GH_PAGE_BUDGET_MS = 120_000

/**
 * 分页读取一个 GitHub 列表端点，返回**完整**数组。
 * 任一页失败、响应不是 JSON 数组、超页数或时间上限，都返回 ERROR；不返回部分结果。
 */
export function ghApiList(opts: {
  adapter: RepositoryAdapter
  cwd: string
  path: string
  query?: string
  maxPages?: number
  budgetMs?: number
}): { kind: 'PASS'; items: unknown[] } | { kind: 'ERROR'; reason: string } {
  const maxPages = opts.maxPages ?? GH_MAX_PAGES
  const budgetMs = opts.budgetMs ?? GH_PAGE_BUDGET_MS
  const started = Date.now()
  const items: unknown[] = []
  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() - started > budgetMs) {
      return { kind: 'ERROR', reason: `gh list ${opts.path}: exceeded ${budgetMs}ms budget after ${page - 1} pages; completeness is unknown` }
    }
    const prefix = opts.query === undefined || opts.query === '' ? '' : `${opts.query}&`
    const result = opts.adapter.gh({ cwd: opts.cwd, method: 'GET', path: opts.path, query: `${prefix}per_page=${GH_PAGE_SIZE}&page=${page}` })
    if (result.kind === 'ERROR') return { kind: 'ERROR', reason: `gh list ${opts.path} page ${page}: ${result.reason}` }
    if (!Array.isArray(result.details)) return { kind: 'ERROR', reason: `gh list ${opts.path} page ${page}: response is not a JSON array` }
    items.push(...result.details)
    if (result.details.length < GH_PAGE_SIZE) return { kind: 'PASS', items }
  }
  return { kind: 'ERROR', reason: `gh list ${opts.path}: more than ${maxPages} pages; completeness is unknown` }
}
