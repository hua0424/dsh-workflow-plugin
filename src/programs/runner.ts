/**
 * Program runner adapters: git subprocess wrapper and gh CLI runner
 * (design §10.1 I1-I3). Zero host dependencies; asynchronous spawn with argument
 * arrays (never a shell string), short timeouts, structured outcomes.
 *
 * Issue #95：子进程改走异步 spawn——sync spawn 期间宿主事件循环被按最长 timeout
 * 阻塞，异步 spawn 期间 timer 与其他 workspace 的 state/inspection 查询可继续推进。
 * 统一合同：stdout/stderr 聚合、退出码、ENOENT、timeout、输出超限、close 后一次
 * 结算并清理；固定 argv / shell:false / windowsHide 不变，各调用点 timeout 预算不变
 * （git 默认 30s、gh 默认 60s、initialize-milestone 的 push 显式 120s）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { ProgramResult } from '../types.ts'

export interface RunOutcome {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  failedToStart: boolean
}

/** git 调用的默认输出上限（原 spawnSync maxBuffer 基线）。 */
export const GIT_OUTPUT_LIMIT = 1024 * 1024
/** gh 调用的默认输出上限（原 spawnSync maxBuffer 基线）。 */
export const GH_OUTPUT_LIMIT = 4 * 1024 * 1024

/** 受控异步子进程合同：只用到 spawn 返回对象的这几件事，便于注入受控实现。 */
export type SpawnedChild = Pick<ChildProcess, 'stdout' | 'stderr' | 'on' | 'kill' | 'removeAllListeners'> & { stdin?: ChildProcess['stdin'] }

export interface SpawnOptionsLike {
  cwd?: string
  windowsHide: boolean
  shell: false
  stdio: ['pipe' | 'ignore', 'pipe', 'pipe']
}

/** 子进程出口（测试可注入受控实现；默认 `child_process.spawn`）。 */
export type SpawnDriver = (cmd: string, args: string[], options: SpawnOptionsLike) => SpawnedChild

export const realSpawn: SpawnDriver = (cmd, args, options) => spawn(cmd, args, options)

export interface SpawnRequest {
  cmd: string
  args: string[]
  cwd?: string
  timeoutMs: number
  limit: number
  /** stdin 内容；undefined 时不写 stdin 直接关闭（保持 spawnSync(input: undefined) 语义）。 */
  input?: string
}

const OUTPUT_LIMIT_MARK = 'output limit exceeded'

const decodeChunk = (chunk: unknown): string =>
  typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''

/**
 * 跑一个受控子进程并聚合出口，**在 close（stdio 全部结束）后一次结算**，因此返回时
 * stdout/stderr 已完整。timeout 到点或输出超限都 kill 子进程并按对应原因返回；
 * 两者的区分不靠退出码（Windows 上 kill 后 status 可能为 null）。ENOENT/启动失败与
 * 非零退出保持可区分（failedToStart）。
 */
export function spawnCollect(driver: SpawnDriver, request: SpawnRequest): Promise<RunOutcome> {
  const { cmd, args, cwd, timeoutMs, limit } = request
  let child: SpawnedChild
  try {
    child = driver(cmd, args, {
      cwd, windowsHide: true, shell: false,
      stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    return Promise.resolve(startFailure(cmd, error))
  }
  if (child === undefined || child === null || typeof child.on !== 'function') {
    return Promise.resolve({ exitCode: -1, stdout: '', stderr: `failed to start ${cmd}: spawn returned no child process`, timedOut: false, failedToStart: true })
  }
  if (request.input !== undefined && child.stdin) {
    child.stdin.on('error', () => {}) // 早退子进程的 EPIPE 是正常收尾，不是失败
    child.stdin.end(request.input)
  }

  return new Promise<RunOutcome>(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overLimit = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      killQuietly(child)
    }, timeoutMs)

    const finish = (exitCode: number, failedToStart: boolean, startError?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeAllListeners('close')
      child.removeAllListeners('error')
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
      if (failedToStart) { resolve(startFailure(cmd, startError)); return }
      if (overLimit) {
        resolve({
          exitCode: -1, stdout, stderr: `${OUTPUT_LIMIT_MARK}: ${cmd} produced more than ${limit} bytes; process killed`,
          timedOut: false, failedToStart: false,
        })
        return
      }
      resolve({ exitCode, stdout, stderr, timedOut, failedToStart: false })
    }

    const collect = (chunk: unknown, into: 'out' | 'err'): void => {
      if (overLimit) return
      if (into === 'out') stdout += decodeChunk(chunk); else stderr += decodeChunk(chunk)
      if (stdout.length + stderr.length > limit) {
        overLimit = true
        killQuietly(child)
      }
    }
    child.stdout?.on('data', chunk => collect(chunk, 'out'))
    child.stderr?.on('data', chunk => collect(chunk, 'err'))
    child.on('error', error => finish(-1, true, error))
    child.on('close', code => finish(code ?? -1, false))
  })
}

function killQuietly(child: SpawnedChild): void {
  try { child.kill() } catch { /* 已退出或无法 kill：close 事件照常收尾 */ }
}

/** 启动失败：ENOENT 与"非零退出"必须可区分（读取失败不等于事实不存在）。 */
function startFailure(cmd: string, error: unknown): RunOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return { exitCode: -1, stdout: '', stderr: `command not found: ${cmd}`, timedOut: false, failedToStart: true }
  return { exitCode: -1, stdout: '', stderr: String(error), timedOut: false, failedToStart: true }
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
 * 受控进程适配器（Issue #92/#95）：只读事实与写动作都经此出口，测试注入受控实现，
 * 不在测试里真的 spawn（受限沙箱捕获子进程管道会 EPERM）。异步出口：调用方必须
 * await——漏 await 会被类型检查挡住，不会留下后台游离写。
 */
export interface RepositoryAdapter {
  git(args: string[], cwd: string, opts?: { timeoutMs?: number }): Promise<RunOutcome>
  gh(call: GhCall): Promise<GhApiOutcome>
}

/** 真实适配器；`driver` 可注入受控 SpawnDriver（#119：Program 层端到端用例走真实出口装配，不真 spawn）。 */
export function repositoryAdapter(driver: SpawnDriver = realSpawn): RepositoryAdapter {
  return {
    git: (args, cwd, opts) => runProgram('git', args, { cwd, ...opts }, driver),
    gh: call => ghApi(call, driver),
  }
}

export const realRepositoryAdapter: RepositoryAdapter = repositoryAdapter()

/**
 * 只读事实三态：value=事实；none=事实明确不存在；error=读取失败（绝不能当成不存在/空集合/clean）。
 * none 不携带原因（Issue #119 D-92-2）：调用点只按 kind 分派，原因字符串是无人读取的死载荷，
 * 需要诊断时改由「none 即明确不存在」这一语义本身表达。
 */
export type Fact<T> = { kind: 'value'; value: T } | { kind: 'none' } | { kind: 'error'; reason: string }


/** Run one program without a shell, capturing output with a timeout（Issue #95：异步受控进程，不阻塞宿主事件循环）. */
export function runProgram(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}, driver: SpawnDriver = realSpawn): Promise<RunOutcome> {
  return spawnCollect(driver, { cmd, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 30_000, limit: GIT_OUTPUT_LIMIT })
}

/** 读取失败的统一原因文本（判定"不存在"只用 git 自己的 absent 答复，不用任意非零码）。 */
function readFailed(out: RunOutcome, what: string): string {
  if (out.failedToStart) return `${what}: ${out.stderr.trim() || 'failed to start'}`
  if (out.timedOut) return `${what}: timed out`
  return `${what}: exit ${out.exitCode}${out.stderr.trim() === '' ? '' : ` (${out.stderr.trim().slice(0, 200)})`}`
}

/**
 * ponytail: 只认 git 英文报文的「not a git repository」子串判定"不是仓库"。
 * 天花板：git 输出本地化（LC_ALL/LANG）后该正则失配；方向安全——失配不会误判成"不存在"，
 * 而是落到 error（fail-closed），代价是"不是仓库"降级成读取失败。
 * 升级路径：`git rev-parse --is-inside-work-tree` 退出码判定，退出码与 locale 无关。
 */
const isNotARepo = (out: RunOutcome): boolean => /not a git repository/i.test(`${out.stderr}${out.stdout}`)

/** 仓库根目录：value=路径；none=不是 git 仓库（事实）；error=读取失败。 */
export async function gitTopLevel(adapter: RepositoryAdapter, cwd: string): Promise<Fact<string>> {
  const out = await adapter.git(['rev-parse', '--show-toplevel'], cwd)
  if (out.exitCode === 0 && out.stdout.trim() !== '') return { kind: 'value', value: out.stdout.trim() }
  if (isNotARepo(out)) return { kind: 'none' }
  return { kind: 'error', reason: readFailed(out, 'git rev-parse --show-toplevel') }
}

/** HEAD：value=分支名（null=detached HEAD）；none=不是 git 仓库；error=读取失败。 */
export async function gitHead(adapter: RepositoryAdapter, cwd: string): Promise<Fact<string | null>> {
  const out = await adapter.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (out.exitCode === 0) {
    const name = out.stdout.trim()
    return { kind: 'value', value: name === '' || name === 'HEAD' ? null : name }
  }
  if (isNotARepo(out)) return { kind: 'none' }
  return { kind: 'error', reason: readFailed(out, 'git rev-parse --abbrev-ref HEAD') }
}

/** origin URL：value=URL；none=无 origin（或不是仓库）；error=读取失败。 */
export async function gitOriginUrl(adapter: RepositoryAdapter, cwd: string): Promise<Fact<string>> {
  const out = await adapter.git(['remote', 'get-url', 'origin'], cwd)
  if (out.exitCode === 0) return out.stdout.trim() === ''
    ? { kind: 'none' }
    : { kind: 'value', value: out.stdout.trim() }
  if (isNotARepo(out)) return { kind: 'none' }
  if (/no such remote/i.test(out.stderr)) return { kind: 'none' }
  return { kind: 'error', reason: readFailed(out, 'git remote get-url origin') }
}

/** 工作树状态（porcelain=v1）：value='' 表示干净；none=不是 git 仓库；error=读取失败（不当 clean）。 */
export async function gitStatusShort(adapter: RepositoryAdapter, cwd: string): Promise<Fact<string>> {
  const out = await adapter.git(['status', '--porcelain=v1'], cwd)
  if (out.exitCode === 0) return { kind: 'value', value: out.stdout }
  if (isNotARepo(out)) return { kind: 'none' }
  return { kind: 'error', reason: readFailed(out, 'git status --porcelain=v1') }
}

/** 本地分支（精确比对 refname，避免 pattern 通配）：value=refname；none=不存在；error=读取失败。 */
export async function gitLocalBranch(adapter: RepositoryAdapter, cwd: string, branchName: string): Promise<Fact<string>> {
  const ref = `refs/heads/${branchName}`
  const out = await adapter.git(['for-each-ref', '--format=%(refname)', ref], cwd)
  if (out.exitCode !== 0) return { kind: 'error', reason: readFailed(out, `git for-each-ref ${ref}`) }
  const found = out.stdout.split('\n').map(line => line.trim()).find(line => line === ref)
  return found === undefined ? { kind: 'none' } : { kind: 'value', value: found }
}

/** 远端分支：value=ls-remote 行；none=不存在；error=读取失败（失败不得当成"不存在"后继续 push）。 */
export async function gitRemoteBranch(adapter: RepositoryAdapter, cwd: string, branchName: string): Promise<Fact<string>> {
  const out = await adapter.git(['ls-remote', '--heads', 'origin', branchName], cwd)
  if (out.exitCode !== 0) return { kind: 'error', reason: readFailed(out, `git ls-remote --heads origin ${branchName}`) }
  const lines = out.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.length === 0 ? { kind: 'none' } : { kind: 'value', value: lines[0]! }
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

/** Run `gh api` with method/path/query; structured outcome (Issue #95：异步受控进程). */
export async function ghApi(opts: GhCall, driver: SpawnDriver = realSpawn): Promise<GhApiOutcome> {
  const args = buildGhArgs(opts.path, opts.method, opts.query, opts.input)
  const input = opts.input === undefined ? undefined : JSON.stringify(opts.input)
  const out = await spawnCollect(driver, {
    cmd: 'gh', args, cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 60_000, limit: GH_OUTPUT_LIMIT, input,
  })
  if (out.failedToStart && out.stderr.includes('command not found')) {
    return { kind: 'ERROR', reason: 'gh CLI not found on PATH' }
  }
  return shapeGhOutcome(out)
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
 * 无时间预算形参（Issue #119 D-INT-1）：`GH_PAGE_BUDGET_MS` 是全局完整性上限，不对外开可调口子。
 */
export async function ghApiList(opts: {
  adapter: RepositoryAdapter
  cwd: string
  path: string
  query?: string
  maxPages?: number
}): Promise<{ kind: 'PASS'; items: unknown[] } | { kind: 'ERROR'; reason: string }> {
  const maxPages = opts.maxPages ?? GH_MAX_PAGES
  const budgetMs = GH_PAGE_BUDGET_MS
  const started = Date.now()
  const items: unknown[] = []
  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() - started > budgetMs) {
      return { kind: 'ERROR', reason: `gh list ${opts.path}: exceeded ${budgetMs}ms budget after ${page - 1} pages; completeness is unknown` }
    }
    const prefix = opts.query === undefined || opts.query === '' ? '' : `${opts.query}&`
    const result = await opts.adapter.gh({ cwd: opts.cwd, method: 'GET', path: opts.path, query: `${prefix}per_page=${GH_PAGE_SIZE}&page=${page}` })
    if (result.kind === 'ERROR') return { kind: 'ERROR', reason: `gh list ${opts.path} page ${page}: ${result.reason}` }
    if (!Array.isArray(result.details)) return { kind: 'ERROR', reason: `gh list ${opts.path} page ${page}: response is not a JSON array` }
    items.push(...result.details)
    if (result.details.length < GH_PAGE_SIZE) return { kind: 'PASS', items }
  }
  return { kind: 'ERROR', reason: `gh list ${opts.path}: more than ${maxPages} pages; completeness is unknown` }
}
