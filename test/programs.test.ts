import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import {
  GIT_OUTPUT_LIMIT, GH_PAGE_SIZE, ghApiList, gitHead, gitLocalBranch, gitOriginUrl, gitRemoteBranch, gitStatusShort, gitTopLevel,
  parseOriginRepo, repositoryAdapter, runProgram, shapeGhOutcome, spawnCollect,
  type GhCall, type RepositoryAdapter, type RunOutcome, type SpawnDriver,
} from '../src/programs/runner.ts'
import {
  inspectGithubFacts, inspectGitFact, listIssues, listMilestones, repositoryIdentity,
} from '../src/programs/repository.ts'
import { BUILTIN_PROGRAMS } from '../src/programs/catalog.ts'

// ---- 受控进程适配器：测试不真的 spawn（沙箱下捕获管道会 EPERM），只喂受控出口 ----
const okOut = (stdout: string): RunOutcome => ({ exitCode: 0, stdout, stderr: '', timedOut: false, failedToStart: false })
const failOut = (exitCode: number, stderr: string): RunOutcome => ({ exitCode, stdout: '', stderr, timedOut: false, failedToStart: false })
const spawnFailOut = (): RunOutcome => ({ exitCode: -1, stdout: '', stderr: 'Error: spawnSync git EPERM', timedOut: false, failedToStart: true })
const NOT_A_REPO = 'fatal: not a git repository (or any of the parent directories): .git'

interface Fake {
  adapter: RepositoryAdapter
  gitCalls: string[][]
  /** 每次 git 调用携带的超时预算（未传即 undefined，走默认 30s）；#107 的 push 预算断言据此。 */
  gitTimeouts: Array<number | undefined>
  ghCalls: GhCall[]
  writes: () => number
}

function fakeAdapter(handlers: {
  git?: (args: string[]) => RunOutcome | Promise<RunOutcome>
  gh?: (call: GhCall) => { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string } | Promise<{ kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string }>
}): Fake {
  const gitCalls: string[][] = []
  const gitTimeouts: Array<number | undefined> = []
  const ghCalls: GhCall[] = []
  return {
    gitCalls,
    gitTimeouts,
    ghCalls,
    writes: () => ghCalls.filter(c => c.method !== 'GET').length + gitCalls.filter(a => a[0] === 'push' || a[0] === 'checkout').length,
    adapter: {
      git: async (args, _cwd, opts) => { gitCalls.push(args); gitTimeouts.push(opts?.timeoutMs); return handlers.git?.(args) ?? failOut(128, `unexpected git call: ${args.join(' ')}`) },
      gh: async (call) => { ghCalls.push(call); return handlers.gh?.(call) ?? { kind: 'ERROR', reason: `unexpected gh call: ${call.method} ${call.path}` } },
    },
  }
}

/** 按 git 子命令路由的受控出口；未登记的子命令按读取失败处理（测试里视为缺陷）。 */
function gitRoutes(routes: Record<string, RunOutcome>): (args: string[]) => RunOutcome {
  return args => routes[args[0]!] ?? failOut(128, `unexpected git call: ${args.join(' ')}`)
}

// ---- 只读 git 事实：存在 / 不存在 / 读取失败三态，失败绝不当"不存在" ----
test('gitTopLevel 区分「不是仓库」与「读取失败」', async () => {
  const notRepo = fakeAdapter({ git: gitRoutes({ 'rev-parse': failOut(128, NOT_A_REPO) }) })
  assert.equal((await gitTopLevel(notRepo.adapter, 'ws')).kind, 'none')
  const broken = fakeAdapter({ git: () => spawnFailOut() })
  const failed = await gitTopLevel(broken.adapter, 'ws')
  assert.equal(failed.kind, 'error')
  if (failed.kind === 'error') assert.match(failed.reason, /EPERM/)
  const inside = fakeAdapter({ git: gitRoutes({ 'rev-parse': okOut('D:/repo\n') }) })
  assert.deepEqual(await gitTopLevel(inside.adapter, 'ws'), { kind: 'value', value: 'D:/repo' })
})

test('gitHead 区分分支 / detached / 读取失败', async () => {
  const onBranch = fakeAdapter({ git: gitRoutes({ 'rev-parse': okOut('feat/92-x\n') }) })
  assert.deepEqual(await gitHead(onBranch.adapter, 'ws'), { kind: 'value', value: 'feat/92-x' })
  const detached = fakeAdapter({ git: gitRoutes({ 'rev-parse': okOut('HEAD\n') }) })
  assert.deepEqual(await gitHead(detached.adapter, 'ws'), { kind: 'value', value: null })
  const broken = fakeAdapter({ git: gitRoutes({ 'rev-parse': failOut(128, 'fatal: bad object HEAD') }) })
  assert.equal((await gitHead(broken.adapter, 'ws')).kind, 'error')
})

test('gitOriginUrl 无 origin 是 none，读取失败是 error', async () => {
  const noOrigin = fakeAdapter({ git: gitRoutes({ 'remote': failOut(2, "error: No such remote 'origin'") }) })
  assert.equal((await gitOriginUrl(noOrigin.adapter, 'ws')).kind, 'none')
  const broken = fakeAdapter({ git: gitRoutes({ 'remote': spawnFailOut() }) })
  assert.equal((await gitOriginUrl(broken.adapter, 'ws')).kind, 'error')
  const has = fakeAdapter({ git: gitRoutes({ 'remote': okOut('git@github.com:acme/server.git\n') }) })
  assert.deepEqual(await gitOriginUrl(has.adapter, 'ws'), { kind: 'value', value: 'git@github.com:acme/server.git' })
})

test('gitStatusShort 读取失败不会当 clean', async () => {
  const broken = fakeAdapter({ git: gitRoutes({ status: failOut(128, 'fatal: index.lock exists') }) })
  assert.equal((await gitStatusShort(broken.adapter, 'ws')).kind, 'error')
  const clean = fakeAdapter({ git: gitRoutes({ status: okOut('') }) })
  assert.deepEqual(await gitStatusShort(clean.adapter, 'ws'), { kind: 'value', value: '' })
  const dirty = fakeAdapter({ git: gitRoutes({ status: okOut(' M a.ts\n') }) })
  assert.deepEqual(await gitStatusShort(dirty.adapter, 'ws'), { kind: 'value', value: ' M a.ts\n' })
})

test('本地/远端分支查询：不存在是 none，查询失败是 error（不是「不存在」）', async () => {
  const absent = fakeAdapter({ git: gitRoutes({ 'for-each-ref': okOut(''), 'ls-remote': okOut('') }) })
  assert.equal((await gitLocalBranch(absent.adapter, 'ws', 'feat/92-x')).kind, 'none')
  assert.equal((await gitRemoteBranch(absent.adapter, 'ws', 'feat/92-x')).kind, 'none')
  const present = fakeAdapter({ git: gitRoutes({ 'for-each-ref': okOut('refs/heads/feat/92-x\n'), 'ls-remote': okOut('ce19871\trefs/heads/feat/92-x\n') }) })
  assert.deepEqual(await gitLocalBranch(present.adapter, 'ws', 'feat/92-x'), { kind: 'value', value: 'refs/heads/feat/92-x' })
  assert.equal((await gitRemoteBranch(present.adapter, 'ws', 'feat/92-x')).kind, 'value')
  const broken = fakeAdapter({ git: gitRoutes({ 'for-each-ref': spawnFailOut(), 'ls-remote': failOut(128, 'fatal: could not read from remote') }) })
  assert.equal((await gitLocalBranch(broken.adapter, 'ws', 'feat/92-x')).kind, 'error')
  assert.equal((await gitRemoteBranch(broken.adapter, 'ws', 'feat/92-x')).kind, 'error')
})

// ---- gh 读取：严格 JSON + 完整分页，失败不降级成空集合 ----
test('shapeGhOutcome：非零退出 / 空输出 / 无效 JSON 都是 ERROR，不降级成字符串', () => {
  assert.equal(shapeGhOutcome(failOut(1, 'gh: Not Found (HTTP 404)')).kind, 'ERROR')
  assert.equal(shapeGhOutcome(okOut('')).kind, 'ERROR')
  assert.equal(shapeGhOutcome(okOut('  \n')).kind, 'ERROR')
  assert.equal(shapeGhOutcome(okOut('<html>nope</html>')).kind, 'ERROR')
  assert.equal(shapeGhOutcome(okOut('[{]')).kind, 'ERROR')
  assert.equal(shapeGhOutcome({ ...okOut('[]'), timedOut: true }).kind, 'ERROR')
  assert.deepEqual(shapeGhOutcome(okOut('[]')), { kind: 'PASS', details: [] })
  assert.deepEqual(shapeGhOutcome(okOut('{"number":3}')), { kind: 'PASS', details: { number: 3 } })
})

/** 受控分页出口：按 query 里的 page= 返回预置页；canned 项为 {error} 时模拟该页读取失败。 */
function pagedGh(pages: Array<unknown[] | { error: string }>): (call: GhCall) => { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string } {
  return (call) => {
    const page = Number(/(?:^|&)page=(\d+)/.exec(call.query ?? '')?.[1] ?? '1')
    const canned = pages[page - 1]
    if (canned === undefined) return { kind: 'ERROR', reason: `unexpected page ${page}` }
    return Array.isArray(canned) ? { kind: 'PASS', details: canned } : { kind: 'ERROR', reason: canned.error }
  }
}

test('ghApiList 至少跨两页取全，满页继续、短页终止', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => ({ number: i + 1 }))
  const page2 = [{ number: 101 }, { number: 102 }]
  const fake = fakeAdapter({ gh: pagedGh([page1, page2]) })
  const result = await ghApiList({ adapter: fake.adapter, cwd: 'ws', path: 'repos/a/b/issues', query: 'state=all' })
  assert.equal(result.kind, 'PASS')
  assert.equal(result.kind === 'PASS' ? result.items.length : 0, GH_PAGE_SIZE + 2)
  assert.deepEqual(fake.ghCalls.map(c => c.query), [
    `state=all&per_page=${GH_PAGE_SIZE}&page=1`,
    `state=all&per_page=${GH_PAGE_SIZE}&page=2`,
  ])
})

test('ghApiList 首页空数组就是空集合（合法终止）', async () => {
  const fake = fakeAdapter({ gh: pagedGh([[]]) })
  assert.deepEqual(await ghApiList({ adapter: fake.adapter, cwd: 'ws', path: 'repos/a/b/milestones', query: 'state=all' }), { kind: 'PASS', items: [] })
})

test('ghApiList 后页失败 → ERROR，不带回已取到的部分当完整事实', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => ({ number: i + 1 }))
  const fake = fakeAdapter({ gh: pagedGh([page1, { error: 'gh api failed (1): HTTP 502' }]) })
  const result = await ghApiList({ adapter: fake.adapter, cwd: 'ws', path: 'repos/a/b/issues', query: 'state=all' })
  assert.equal(result.kind, 'ERROR')
  assert.match(result.kind === 'ERROR' ? result.reason : '', /page 2/)
})

test('ghApiList 非数组响应 → ERROR，不当空列表', async () => {
  const fake = fakeAdapter({ gh: () => ({ kind: 'PASS', details: { message: 'Not Found' } }) })
  const result = await ghApiList({ adapter: fake.adapter, cwd: 'ws', path: 'repos/a/b/issues', query: 'state=all' })
  assert.equal(result.kind, 'ERROR')
})

test('ghApiList 超过页数上限 → ERROR，不截断后宣称完整', async () => {
  const full = Array.from({ length: GH_PAGE_SIZE }, (_, i) => ({ number: i + 1 }))
  const fake = fakeAdapter({ gh: () => ({ kind: 'PASS', details: full }) })
  const result = await ghApiList({ adapter: fake.adapter, cwd: 'ws', path: 'repos/a/b/issues', query: 'state=all', maxPages: 3 })
  assert.equal(result.kind, 'ERROR')
  assert.equal(fake.ghCalls.length, 3)
})

// ---- 共享 repository 读取层：inspection 与 Program 同源 ----
const REPO_URL = 'git@github.com:acme/server.git'
const issue = (number: number, state = 'closed') => ({ number, title: `issue ${number}`, state, milestone: null })
const prEntry = (number: number) => ({ number, title: `PR ${number}`, state: 'open', milestone: null, pull_request: { url: 'x' } })

/** 受控 gh 出口：按路由 + page= 返回预置页；写方法一律记为意外。 */
function ghRouter(routes: Array<{ match: (call: GhCall) => boolean; pages: Array<unknown[] | { error: string }> }>): (call: GhCall) => { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string } {
  return (call) => {
    const route = routes.find(r => r.match(call))
    if (route === undefined) return { kind: 'ERROR', reason: `unexpected gh call ${call.method} ${call.path}` }
    if (call.method !== 'GET') return { kind: 'ERROR', reason: `unexpected non-GET call ${call.method} ${call.path}` }
    const page = Number(/(?:^|&)page=(\d+)/.exec(call.query ?? '')?.[1] ?? '1')
    const canned = route.pages[page - 1]
    if (canned === undefined) return { kind: 'ERROR', reason: `unexpected page ${page} for ${call.path}` }
    return Array.isArray(canned) ? { kind: 'PASS', details: canned } : { kind: 'ERROR', reason: canned.error }
  }
}

/** 默认「当前 workspace = acme/server」的受控适配器；overrides 按 git 子命令/gh 出口覆盖。 */
function repoFake(overrides: { git?: Record<string, RunOutcome>; gh?: (call: GhCall) => { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string } } = {}): Fake {
  return fakeAdapter({
    gh: overrides.gh,
    git: (args) => {
      const route = overrides.git?.[args[0]!]
      if (route !== undefined) return route
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return okOut('D:/repo\n')
      if (args[0] === 'remote') return okOut(`${REPO_URL}\n`)
      if (args[0] === 'status') return okOut('')
      if (args[0] === 'for-each-ref') return okOut('')
      if (args[0] === 'ls-remote') return okOut('')
      return failOut(128, `unexpected git call: ${args.join(' ')}`)
    },
  })
}

test('repositoryIdentity：不是仓库 / 无 origin / 非 GitHub 远端都 ERROR，不当空身份', async () => {
  const notRepo = fakeAdapter({ git: gitRoutes({ 'rev-parse': failOut(128, NOT_A_REPO) }) })
  assert.equal((await repositoryIdentity(notRepo.adapter, 'ws')).kind, 'ERROR')
  const noOrigin = repoFake({ git: { 'remote': failOut(2, "error: No such remote 'origin'") } })
  assert.equal((await repositoryIdentity(noOrigin.adapter, 'ws')).kind, 'ERROR')
  const otherHost = repoFake({ git: { 'remote': okOut('git@gitlab.com:acme/server.git\n') } })
  assert.equal((await repositoryIdentity(otherHost.adapter, 'ws')).kind, 'ERROR')
  const ok = await repositoryIdentity(repoFake().adapter, 'ws')
  assert.deepEqual(ok, { kind: 'PASS', value: { owner: 'acme', repo: 'server', topLevel: 'D:/repo' } })
})

test('listMilestones：分页取全并校验结构，缺字段 / 未知 state 都 ERROR', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => ({ number: i + 1, title: `M${i + 1}`, state: 'closed' }))
  const page2 = [{ number: 101, title: 'target', state: 'open' }]
  const fake = repoFake({ gh: ghRouter([{ match: () => true, pages: [page1, page2] }]) })
  const listed = await listMilestones(fake.adapter, 'ws', 'acme', 'server')
  assert.equal(listed.kind === 'PASS' ? listed.value.length : 0, GH_PAGE_SIZE + 1)
  assert.equal(listed.kind === 'PASS' ? listed.value.find(m => m.title === 'target')?.number : undefined, 101)

  const missingNumber = repoFake({ gh: ghRouter([{ match: () => true, pages: [[{ title: 'M', state: 'open' }]] }]) })
  assert.equal((await listMilestones(missingNumber.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
  const badState = repoFake({ gh: ghRouter([{ match: () => true, pages: [[{ number: 1, title: 'M', state: 'merged' }]] }]) })
  assert.equal((await listMilestones(badState.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
  const brokenPage = repoFake({ gh: ghRouter([{ match: () => true, pages: [page1, { error: 'gh api failed (1): HTTP 502' }] }]) })
  assert.equal((await listMilestones(brokenPage.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
})

test('listIssues：排除 PR，未知 state / 缺字段 / 结构不符都 ERROR', async () => {
  const fake = repoFake({ gh: ghRouter([{ match: () => true, pages: [[issue(1), prEntry(2), issue(3, 'open')]] }]) })
  const listed = await listIssues(fake.adapter, 'ws', 'acme', 'server', 16)
  assert.deepEqual(listed.kind === 'PASS' ? listed.value.map(i => i.number) : [], [1, 3])
  assert.match(fake.ghCalls[0]!.query ?? '', /state=all&milestone=16&per_page=/)

  const unknownState = repoFake({ gh: ghRouter([{ match: () => true, pages: [[{ number: 1, title: 'x', state: 'merged', milestone: null }]] }]) })
  assert.equal((await listIssues(unknownState.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
  const missingTitle = repoFake({ gh: ghRouter([{ match: () => true, pages: [[{ number: 1, state: 'open', milestone: null }]] }]) })
  assert.equal((await listIssues(missingTitle.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
  const badMilestone = repoFake({ gh: ghRouter([{ match: () => true, pages: [[{ number: 1, title: 'x', state: 'open', milestone: { title: 'M' } }]] }]) })
  assert.equal((await listIssues(badMilestone.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
  const notArray = repoFake({ gh: () => ({ kind: 'PASS', details: { message: 'Not Found' } }) })
  assert.equal((await listIssues(notArray.adapter, 'ws', 'acme', 'server')).kind, 'ERROR')
})

test('inspectGithubFacts 与 Program 同源：多页取全、排除 PR、只读', async () => {
  const page1 = [...Array.from({ length: 99 }, (_, i) => issue(i + 1)), prEntry(200)]
  const fake = repoFake({ gh: ghRouter([{ match: () => true, pages: [page1, [issue(101)]] }]) })
  const result = await inspectGithubFacts(fake.adapter, 'ws', 'issues')
  assert.equal(result.ok, true)
  assert.equal(Array.isArray(result.value) ? (result.value as unknown[]).length : -1, 100)
  assert.ok(fake.ghCalls.every(c => c.method === 'GET'))
  assert.equal(fake.writes(), 0)
  const milestoneIssues = await inspectGithubFacts(fake.adapter, 'ws', 'milestone-issues')
  assert.equal(milestoneIssues.ok, false)
  const broken = repoFake({ gh: ghRouter([{ match: () => true, pages: [{ error: 'gh api failed (1): HTTP 500' }] }]) })
  const failed = await inspectGithubFacts(broken.adapter, 'ws', 'milestones')
  assert.equal(failed.ok, false)
  assert.match(failed.ok ? '' : failed.reason, /HTTP 500/)
})

test('inspectGitFact：按 operation 只读必要事实，读取失败返回 ok:false 而不是 null', async () => {
  const fake = repoFake()
  assert.deepEqual(await inspectGitFact(fake.adapter, 'ws', 'remote'), { ok: true, value: REPO_URL })
  assert.deepEqual(fake.gitCalls, [['remote', 'get-url', 'origin']])
  const statusFake = repoFake({ git: { 'status': failOut(128, 'fatal: index.lock exists') } })
  assert.equal((await inspectGitFact(statusFake.adapter, 'ws', 'status')).ok, false)
  const dirtyFake = repoFake({ git: { 'status': okOut(' M a.ts\n') } })
  assert.deepEqual(await inspectGitFact(dirtyFake.adapter, 'ws', 'status'), { ok: true, value: ' M a.ts\n' })
  const detachedFake = repoFake({ git: { 'rev-parse': okOut('HEAD\n') } })
  assert.deepEqual(await inspectGitFact(detachedFake.adapter, 'ws', 'branch'), { ok: true, value: '(detached)' })
})

// ---- 固定 Program：读取事实不可靠时不产生任何写动作 ----
type GhOut = { kind: 'PASS'; details: unknown } | { kind: 'ERROR'; reason: string }
const pageOf = (call: GhCall): number => Number(/(?:^|&)page=(\d+)/.exec(call.query ?? '')?.[1] ?? '1')

/** GET 走预置页（支持 {error} 模拟某页失败），POST 走 onPost。 */
function pagesHandler(pages: Array<unknown[] | { error: string }>, onPost?: (call: GhCall) => GhOut): (call: GhCall) => GhOut {
  return (call) => {
    if (call.method !== 'GET') return onPost?.(call) ?? { kind: 'ERROR', reason: `unexpected ${call.method} ${call.path}` }
    const canned = pages[pageOf(call) - 1]
    if (canned === undefined) return { kind: 'ERROR', reason: `unexpected page ${pageOf(call)}` }
    return Array.isArray(canned) ? { kind: 'PASS', details: canned } : { kind: 'ERROR', reason: canned.error }
  }
}

const milestone = (number: number, title: string, state = 'open') => ({ number, title, state })
const initProgram = BUILTIN_PROGRAMS['github.initialize-milestone']!
const completeProgram = BUILTIN_PROGRAMS['github.all-milestone-issues-complete']!
const BRANCH = 'feat/92-x'
const runInit = (fake: Fake, overrides: Record<string, unknown> = {}) =>
  initProgram.run({ cwd: 'ws', adapter: fake.adapter }, { title: 'M16', branchName: BRANCH, ...overrides })
const runComplete = (fake: Fake, parameters: Record<string, unknown> = {}) =>
  completeProgram.run({ cwd: 'ws', adapter: fake.adapter }, { milestoneNumber: 16, ...parameters })

test('initialize-milestone：同名 milestone 在后页也要复用，不重复 POST', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => milestone(i + 1, `other-${i + 1}`))
  const fake = repoFake({
    gh: pagesHandler([page1, [milestone(101, 'M16')]]),
    git: { 'for-each-ref': okOut(`refs/heads/${BRANCH}\n`), 'ls-remote': okOut(`ce19871\trefs/heads/${BRANCH}\n`) },
  })
  const result = await runInit(fake)
  assert.equal(result.kind, 'PASS')
  assert.equal(result.kind === 'PASS' ? (result.details as { milestoneNumber: number }).milestoneNumber : 0, 101)
  assert.equal(fake.writes(), 0)
})

test('initialize-milestone：读取失败时零写动作（不创建 milestone、不建分支、不 push）', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => milestone(i + 1, `other-${i + 1}`))
  const fake = repoFake({
    gh: pagesHandler([page1, { error: 'gh api failed (1): HTTP 502' }]),
    git: { 'status': okOut(''), 'for-each-ref': okOut(''), 'ls-remote': okOut('') },
  })
  const result = await runInit(fake)
  assert.equal(result.kind, 'ERROR')
  assert.equal(fake.writes(), 0)
})

test('initialize-milestone：ls-remote 失败不当「远端不存在」而继续 push', async () => {
  const fake = repoFake({
    gh: pagesHandler([[milestone(7, 'M16')]]),
    git: { 'for-each-ref': okOut(`refs/heads/${BRANCH}\n`), 'ls-remote': failOut(128, 'fatal: could not read from remote repository') },
  })
  const result = await runInit(fake)
  assert.equal(result.kind, 'ERROR')
  assert.equal(fake.gitCalls.filter(args => args[0] === 'push').length, 0)
})

test('initialize-milestone：status 读取失败不当 clean，脏树不当可建分支', async () => {
  const baseGit = { 'for-each-ref': okOut(''), 'ls-remote': okOut('') }
  const statusFailed = repoFake({ gh: pagesHandler([[milestone(7, 'M16')]]), git: { ...baseGit, 'status': failOut(128, 'fatal: index.lock exists') } })
  assert.equal((await runInit(statusFailed)).kind, 'ERROR')
  assert.equal(statusFailed.gitCalls.filter(args => args[0] === 'checkout').length, 0)
  const dirty = repoFake({ gh: pagesHandler([[milestone(7, 'M16')]]), git: { ...baseGit, 'status': okOut(' M a.ts\n') } })
  const dirtyResult = await runInit(dirty)
  assert.equal(dirtyResult.kind, 'ERROR')
  assert.equal(dirty.gitCalls.filter(args => args[0] === 'checkout').length, 0)
})

test('initialize-milestone：事实可读时正常创建 milestone + 本地/远端分支', async () => {
  const fake = repoFake({
    gh: pagesHandler([[]], () => ({ kind: 'PASS', details: { number: 42, title: 'M16', state: 'open' } })),
    git: { 'for-each-ref': okOut(''), 'ls-remote': okOut(''), 'status': okOut(''), 'checkout': okOut(''), 'push': okOut('') },
  })
  const result = await runInit(fake)
  assert.equal(result.kind, 'PASS')
  assert.equal(result.kind === 'PASS' ? (result.details as { milestoneNumber: number }).milestoneNumber : 0, 42)
  // 先取全只读事实，再按依赖顺序写：milestone → 本地分支 → 远端分支。
  // #107（集成 r001-F1）：只有建远端分支的 push 携带显式 120s 预算（基线值），其余调用不传预算（默认为 30s）。
  assert.deepEqual(
    fake.gitCalls.map((args, i) => [args[0], fake.gitTimeouts[i]]),
    [['rev-parse', undefined], ['remote', undefined], ['for-each-ref', undefined], ['ls-remote', undefined], ['status', undefined], ['checkout', undefined], ['push', 120_000]],
  )
  assert.deepEqual(fake.ghCalls.map(call => call.method), ['GET', 'POST'])
})

test('all-milestone-issues-complete：后页存在 open 时不 PASS', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => issue(i + 1))
  const fake = repoFake({ gh: pagesHandler([page1, [issue(101, 'open')]]) })
  const result = await runComplete(fake)
  assert.equal(result.kind, 'FAIL')
  assert.match(result.kind === 'FAIL' ? result.reason ?? '' : '', /1 open of 101/)
  assert.match(fake.ghCalls[0]!.query ?? '', /state=all&milestone=16&per_page=/)
})

test('all-milestone-issues-complete：全部 closed 正确计数并 PASS，PR 不参与计数', async () => {
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => issue(i + 1))
  const fake = repoFake({ gh: pagesHandler([page1, [issue(101), prEntry(202)]]) })
  const result = await runComplete(fake)
  assert.equal(result.kind, 'PASS')
  assert.deepEqual(result.kind === 'PASS' ? result.details : undefined, { total: 101, open: 0, closed: 101 })
})

test('all-milestone-issues-complete：空 milestone 保持既定 FAIL 语义', async () => {
  const fake = repoFake({ gh: pagesHandler([[]]) })
  assert.equal((await runComplete(fake)).kind, 'FAIL')
})

test('all-milestone-issues-complete：无效 JSON / 未知 state / 后页失败都是 ERROR', async () => {
  const notArray = repoFake({ gh: () => ({ kind: 'PASS', details: { message: 'Not Found' } }) })
  assert.equal((await runComplete(notArray)).kind, 'ERROR')
  const badState = repoFake({ gh: pagesHandler([[{ number: 1, title: 'x', state: 'reopened', milestone: null }]]) })
  assert.equal((await runComplete(badState)).kind, 'ERROR')
  const page1 = Array.from({ length: GH_PAGE_SIZE }, (_, i) => issue(i + 1))
  const brokenPage = repoFake({ gh: pagesHandler([page1, { error: 'gh api failed (1): HTTP 502' }]) })
  assert.equal((await runComplete(brokenPage)).kind, 'ERROR')
})

// ---- #119 D-92-1：Program 层端到端——受控进程出口里的无效 JSON 一路走到 ERROR 三态 ----
/**
 * 真实适配器的受控出口：每个 spawn 拿一个独立假子进程，按 <cmd> <子命令> 取预置出口，
 * 未登记的调用人为失败。走的是真实的 spawnCollect + shapeGhOutcome + repository 读取层。
 */
function outcomeDriver(routes: Record<string, RunOutcome>): SpawnDriver {
  return (cmd, args) => {
    const out = routes[`${cmd} ${args[0] ?? ''}`] ?? failOut(128, `unexpected ${cmd} call: ${args.join(' ')}`)
    const self = new EventEmitter()
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    setImmediate(() => {
      if (out.stdout !== '') stdout.emit('data', out.stdout)
      if (out.stderr !== '') stderr.emit('data', out.stderr)
      self.emit('close', out.exitCode)
    })
    return Object.assign(self, { stdout, stderr, kill: () => true }) as never
  }
}

/** Program 层端到端基线：workspace 是 acme/server，milestone 查询走 gh 列表端点。 */
const e2eRoutes = (ghStdout: string): Record<string, RunOutcome> => ({
  'git rev-parse': okOut('D:/repo\n'),
  'git remote': okOut(`${REPO_URL}\n`),
  'gh api': okOut(ghStdout),
})

/** 经真实适配器装配（受控 SpawnDriver 出口）跑 all-milestone-issues-complete 全链路。 */
const runCompleteWith = (routes: Record<string, RunOutcome>) =>
  completeProgram.run({ cwd: 'ws', adapter: repositoryAdapter(outcomeDriver(routes)) }, { milestoneNumber: 16 })

test('#119 D-92-1：受控出口返回无效 JSON → Program 端到端 ERROR（不降级成空集合/部分结果）', async () => {
  const invalidJson = await runCompleteWith(e2eRoutes('<html>nope</html>'))
  assert.equal(invalidJson.kind, 'ERROR')
  assert.match(invalidJson.kind === 'ERROR' ? invalidJson.reason : '', /invalid JSON/)

  // 同一条出口装配下合法 JSON 数组仍正常走完：证明 ERROR 来自 JSON 解析这一环，不是装配本身坏了。
  const ok = await runCompleteWith(e2eRoutes(JSON.stringify([issue(1)])))
  assert.deepEqual(ok.kind === 'PASS' ? ok.details : undefined, { total: 1, open: 0, closed: 1 })

  // 非零退出同样端到端落到 ERROR，且不带回部分结果。
  const failed = await runCompleteWith({ ...e2eRoutes('[]'), 'gh api': failOut(1, 'gh: Not Found (HTTP 404)') })
  assert.equal(failed.kind, 'ERROR')
  assert.match(failed.kind === 'ERROR' ? failed.reason : '', /404/)
})

test('parseOriginRepo handles git ssh form', () => {
  assert.deepEqual(parseOriginRepo('git@github.com:acme/server.git'), { owner: 'acme', repo: 'server' })
})

test('parseOriginRepo handles https form', () => {
  assert.deepEqual(parseOriginRepo('https://github.com/acme/server.git'), { owner: 'acme', repo: 'server' })
  assert.deepEqual(parseOriginRepo('https://github.com/acme/server/'), { owner: 'acme', repo: 'server' })
})

test('parseOriginRepo rejects non-github remotes', () => {
  assert.equal(parseOriginRepo('git@gitlab.com:acme/server.git'), undefined)
  assert.equal(parseOriginRepo(''), undefined)
  assert.equal(parseOriginRepo('not a url'), undefined)
})

// ---- Issue #95：异步受控进程（spawnCollect）——全部走注入的受控 SpawnDriver，不真的 spawn ----

/** 受控子进程：EventEmitter 假体，按脚本推进 stdout/stderr/close/error，记录 kill。脚本里的
 * 事件发射必须在 setImmediate/timer 回调里做——同步发射会在 spawnCollect 挂监听前丢失。 */
function fakeChild(script: (child: { stdout: EventEmitter; stderr: EventEmitter; self: EventEmitter; killCount: () => number }) => void): { driver: SpawnDriver; killed: () => number } {
  const self = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  let kills = 0
  const shaped = Object.assign(self, {
    stdout, stderr,
    // 模拟真实 kill：被杀后子进程异步 close（真实场景 kill 后 close 事件随之到来）。
    kill: () => { kills++; setTimeout(() => self.emit('close', null), 0); return true },
  })
  script({ stdout, stderr, self, killCount: () => kills })
  return { driver: () => shaped as never, killed: () => kills }
}

test('#95 长进程执行中宿主事件循环不被阻塞（heartbeat 推进）', async () => {
  // 受控延时进程：300ms 后才给输出并 close；期间 10ms heartbeat timer 应多次推进。
  const { driver } = fakeChild(({ stdout, self }) => {
    setTimeout(() => { stdout.emit('data', 'git version 9.9.9'); self.emit('close', 0) }, 300)
  })
  let beats = 0
  const beat = setInterval(() => { beats++ }, 10)
  const started = Date.now()
  const result = await spawnCollect(driver, { cmd: 'git', args: ['--version'], timeoutMs: 5_000, limit: GIT_OUTPUT_LIMIT })
  clearInterval(beat)
  assert.equal(result.exitCode, 0)
  assert.match(result.stdout, /git version/)
  assert.equal(result.failedToStart, false)
  // 300ms 的 10ms heartbeat 至少应推进十几次；若 spawn 阻塞事件循环，beats 会是 0~1。
  assert.ok(beats >= 10, `heartbeat only beat ${beats} times in ${Date.now() - started}ms`)
})

test('#95 timeout：到点 kill 子进程并按 timedOut 结算', async () => {
  const { driver, killed } = fakeChild(() => { /* 永不 close：挂死子进程 */ })
  const result = await spawnCollect(driver, { cmd: 'git', args: ['fetch'], timeoutMs: 50, limit: GIT_OUTPUT_LIMIT })
  assert.equal(result.timedOut, true)
  assert.equal(result.failedToStart, false)
  assert.equal(killed(), 1)
})

test('#95 输出超限：kill 子进程并给出明确 ERROR 标记，不当成功', async () => {
  const { driver, killed } = fakeChild(({ stdout, self }) => {
    setImmediate(() => { stdout.emit('data', 'x'.repeat(2 * 1024 * 1024)); self.emit('close', 0) })
  })
  const result = await spawnCollect(driver, { cmd: 'git', args: ['log'], timeoutMs: 5_000, limit: GIT_OUTPUT_LIMIT })
  assert.equal(result.timedOut, false)
  assert.match(result.stderr, /output limit exceeded/)
  assert.equal(killed(), 1)
})

test('#95 启动失败：ENOENT 映射为 command not found，与非零退出可区分', async () => {
  const err = Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' })
  const { driver } = fakeChild(({ self }) => {
    setTimeout(() => self.emit('error', err), 0)
  })
  const result = await spawnCollect(driver, { cmd: 'nope', args: ['--x'], timeoutMs: 1_000, limit: GIT_OUTPUT_LIMIT })
  assert.equal(result.failedToStart, true)
  assert.match(result.stderr, /command not found: nope/)
  // 非零退出：不是 failedToStart，exitCode 保留
  const { driver: okDriver } = fakeChild(({ stderr, self }) => {
    setImmediate(() => { stderr.emit('data', 'fatal: bad'); self.emit('close', 128) })
  })
  const failedExit = await spawnCollect(okDriver, { cmd: 'git', args: ['x'], timeoutMs: 1_000, limit: GIT_OUTPUT_LIMIT })
  assert.equal(failedExit.failedToStart, false)
  assert.equal(failedExit.exitCode, 128)
  assert.match(failedExit.stderr, /fatal: bad/)
})

test('#95 stdin：input 写入后关闭，未传 input 不写', async () => {
  const writes: string[] = []
  const makeDriver = (withStdin: boolean): SpawnDriver => {
    const self = new EventEmitter()
    setTimeout(() => self.emit('close', 0), 0)
    return () => Object.assign(self, {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: () => true,
      stdin: withStdin ? { on: () => undefined, end: (d?: string) => { writes.push(d ?? '') } } : undefined,
    }) as never
  }
  const r1 = await spawnCollect(makeDriver(true), { cmd: 'gh', args: ['api'], timeoutMs: 500, limit: 1024, input: '{"title":"M"}' })
  assert.deepEqual(writes, ['{"title":"M"}'])
  assert.equal(r1.failedToStart, false)
  // 未传 input：不触碰 stdin
  await spawnCollect(makeDriver(false), { cmd: 'git', args: ['x'], timeoutMs: 500, limit: 1024 })
  assert.equal(writes.length, 1)
})

// 下面两个用例是唯一真的 spawn 子进程的用例（契约就是捕获真实输出与 ENOENT 映射）。
// 受限沙箱（DSH agent node 进程）禁止打开捕获管道，异步 spawn 同步抛 `spawn EPERM`
// （由 spawnCollect 收敛为 failedToStart）；探测到该环境就跳过，非沙箱环境应通过。
// Issue #92/#95 的其余用例一律走受控进程适配器/受控 SpawnDriver，不依赖真实 spawn。
const canRealSpawn = await new Promise<boolean>(resolve => {
  try {
    const probe = spawn('node', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    probe.on('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'EPERM'))
    probe.on('close', () => resolve(true))
  } catch (error) {
    resolve((error as NodeJS.ErrnoException).code !== 'EPERM')
  }
})

test('runProgram captures output of a real command', { skip: canRealSpawn ? false : 'sandbox forbids piped spawn (EPERM)' }, async () => {
  const result = await runProgram('git', ['--version'])
  assert.equal(result.failedToStart, false)
  assert.match(result.stdout, /git version/)
  assert.equal(result.exitCode, 0)
})

test('runProgram reports ENOENT for missing commands', { skip: canRealSpawn ? false : 'sandbox forbids piped spawn (EPERM)' }, async () => {
  const result = await runProgram('definitely-not-a-real-command-xyz', ['--x'])
  assert.equal(result.failedToStart, true)
  assert.match(result.stderr, /not found/i)
})
