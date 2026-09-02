/**
 * Program runner adapters: git subprocess wrapper and gh CLI runner
 * (design §10.1 I1-I3). Zero host dependencies; spawnSync with argument arrays
 * (never a shell string), short timeouts, structured outcomes.
 */
import { spawnSync } from 'node:child_process'
import type { ProgramResult } from '../types.ts'

export interface GitFacts {
  /** Whether the cwd is inside a git work tree. */
  inRepo: boolean
  /** Absolute repository root (git rev-parse --show-toplevel). */
  topLevel?: string
  /** Current branch name ('' when detached). */
  branch?: string
  /** Detached HEAD. */
  detached: boolean
  /** origin remote URL ('' when absent). */
  originUrl?: string
  /** Short porcelain status; empty string means clean. */
  statusShort?: string
}

export interface RunOutcome {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  failedToStart: boolean
}

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

/** Inspect the git repository at cwd (read-only, no side effects). */
export function inspectGit(cwd: string): GitFacts {
  const top = runProgram('git', ['rev-parse', '--show-toplevel'], { cwd })
  const facts: GitFacts = { inRepo: top.exitCode === 0 && top.stdout.trim() !== '', detached: false }
  if (!facts.inRepo) return facts
  facts.topLevel = top.stdout.trim()
  const branch = runProgram('git', ['symbolic-ref', '--short', 'HEAD'], { cwd })
  if (branch.exitCode === 0) {
    facts.branch = branch.stdout.trim()
  } else {
    facts.detached = true
    facts.branch = ''
  }
  const origin = runProgram('git', ['remote', 'get-url', 'origin'], { cwd })
  facts.originUrl = origin.exitCode === 0 ? origin.stdout.trim() : ''
  const status = runProgram('git', ['status', '--porcelain=v1'], { cwd })
  facts.statusShort = status.exitCode === 0 ? status.stdout : undefined
  return facts
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

/** Run `gh api` with method/path/query; structured outcome (PASS carries the full parsed JSON, ERROR carries reason; ghApi never returns FAIL). */
export function ghApi(opts: { cwd: string; method: string; path: string; query?: string; input?: unknown; timeoutMs?: number }): { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string } {
  const args = buildGhArgs(opts.path, opts.method, opts.query, opts.input)
  const started = Date.now()
  let result: ReturnType<typeof spawnSync>
  try {
    result = spawnSync('gh', args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 60_000,
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
  if (Date.now() - started >= (opts.timeoutMs ?? 60_000)) {
    return { kind: 'ERROR', reason: `gh api timed out: ${args[1]}` }
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.status !== 0) {
    return { kind: 'ERROR', reason: `gh api failed (${result.status}): ${(stderr || stdout).trim().slice(0, 400)}` }
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(stdout)
  } catch {
    parsed = stdout.trim()
  }
  return { kind: 'PASS', details: parsed }
}
