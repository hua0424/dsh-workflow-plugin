/**
 * Repository 只读事实层（Issue #92）：inspection 与两个固定 Program 共用同一套
 * repository 识别、分页与过滤结果。读取失败一律 ERROR（Runtime 转 BLOCK），
 * 绝不当成空集合 / clean / "不存在"；本层只做读，不产生任何写动作。
 */
import {
  ghApiList, gitHead, gitOriginUrl, gitStatusShort, gitTopLevel, parseOriginRepo,
  type Fact, type RepositoryAdapter,
} from './runner.ts'

/** 只读结果：PASS 携带事实值，ERROR 携带读取失败原因（调用方必须原样上抛，不得降级）。 */
export type RepoRead<T> = { kind: 'PASS'; value: T } | { kind: 'ERROR'; reason: string }

/** inspection 的操作面（enum，不接受任意命令/URL）。 */
export type GitInspectOperation = 'status' | 'branch' | 'remote' | 'top-level'
export type GithubInspectOperation = 'milestones' | 'issues' | 'milestone-issues'
export type InspectResult = { ok: true; value: unknown } | { ok: false; reason: string }

/** 当前 workspace 的 GitHub repository 身份（owner/repo + 仓库根）。 */
export interface RepositoryIdentity {
  owner: string
  repo: string
  topLevel: string
}

export async function repositoryIdentity(adapter: RepositoryAdapter, cwd: string): Promise<RepoRead<RepositoryIdentity>> {
  const top = await gitTopLevel(adapter, cwd)
  if (top.kind === 'error') return { kind: 'ERROR', reason: `workspace git facts unreadable: ${top.reason}` }
  if (top.kind === 'none') return { kind: 'ERROR', reason: 'workspace is not a git repository' }
  const url = await gitOriginUrl(adapter, cwd)
  if (url.kind === 'error') return { kind: 'ERROR', reason: `origin remote unreadable: ${url.reason}` }
  if (url.kind === 'none') return { kind: 'ERROR', reason: 'no origin remote found' }
  const parsed = parseOriginRepo(url.value)
  if (parsed === undefined) return { kind: 'ERROR', reason: `origin remote is not a GitHub repository: ${url.value}` }
  return { kind: 'PASS', value: { owner: parsed.owner, repo: parsed.repo, topLevel: top.value } }
}

export interface Milestone {
  number: number
  title: string
  state: 'open' | 'closed'
}

export interface RepoIssue {
  number: number
  title: string
  state: 'open' | 'closed'
  /** 所属 Milestone number；无则 null。 */
  milestone: number | null
}

const asRecord = (raw: unknown): Record<string, unknown> | undefined =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined

const brief = (raw: unknown): string => JSON.stringify(raw)?.slice(0, 120) ?? String(raw)

/** 分页取全仓库 milestones（state=all）并校验结构；任一页失败或结构不符 → ERROR。 */
export async function listMilestones(adapter: RepositoryAdapter, cwd: string, owner: string, repo: string): Promise<RepoRead<Milestone[]>> {
  const listed = await ghApiList({ adapter, cwd, path: `repos/${owner}/${repo}/milestones`, query: 'state=all' })
  if (listed.kind === 'ERROR') return listed
  const milestones: Milestone[] = []
  for (const raw of listed.items) {
    const item = asRecord(raw)
    if (item === undefined) return { kind: 'ERROR', reason: `milestone entry is not an object: ${brief(raw)}` }
    const number = item['number']
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) return { kind: 'ERROR', reason: `milestone entry has no integer number: ${brief(raw)}` }
    if (typeof item['title'] !== 'string') return { kind: 'ERROR', reason: `milestone #${number} has no title: ${brief(raw)}` }
    const state = item['state']
    if (state !== 'open' && state !== 'closed') return { kind: 'ERROR', reason: `milestone #${number} has unknown state ${brief(state)}` }
    milestones.push({ number, title: item['title'], state })
  }
  return { kind: 'PASS', value: milestones }
}

/** 分页取全仓库 issues（state=all，可选 milestone 过滤）；先排除 PR，再校验结构。 */
export async function listIssues(adapter: RepositoryAdapter, cwd: string, owner: string, repo: string, milestoneNumber?: number): Promise<RepoRead<RepoIssue[]>> {
  const query = milestoneNumber === undefined ? 'state=all' : `state=all&milestone=${milestoneNumber}`
  const listed = await ghApiList({ adapter, cwd, path: `repos/${owner}/${repo}/issues`, query })
  if (listed.kind === 'ERROR') return listed
  const issues: RepoIssue[] = []
  for (const raw of listed.items) {
    const item = asRecord(raw)
    if (item !== undefined && item['pull_request'] !== undefined) continue // PR 排除规则：issues 端点会混入 PR
    if (item === undefined) return { kind: 'ERROR', reason: `issue entry is not an object: ${brief(raw)}` }
    const number = item['number']
    if (typeof number !== 'number' || !Number.isSafeInteger(number)) return { kind: 'ERROR', reason: `issue entry has no integer number: ${brief(raw)}` }
    if (typeof item['title'] !== 'string') return { kind: 'ERROR', reason: `issue #${number} has no title: ${brief(raw)}` }
    const state = item['state']
    if (state !== 'open' && state !== 'closed') return { kind: 'ERROR', reason: `issue #${number} has unknown state ${brief(state)}` }
    const rawMilestone = item['milestone']
    let milestone: number | null = null
    if (rawMilestone !== null && rawMilestone !== undefined) {
      const m = asRecord(rawMilestone)
      if (m === undefined || typeof m['number'] !== 'number' || !Number.isSafeInteger(m['number'])) {
        return { kind: 'ERROR', reason: `issue #${number} has a malformed milestone: ${brief(rawMilestone)}` }
      }
      milestone = m['number']
    }
    issues.push({ number, title: item['title'], state, milestone })
  }
  return { kind: 'PASS', value: issues }
}

const factValue = (fact: Fact<unknown>): InspectResult =>
  fact.kind === 'error' ? { ok: false, reason: fact.reason } : { ok: true, value: fact.kind === 'value' ? fact.value : null }

/** Judge 只读 inspection：git 单个事实；按 operation 只读该事实，不附带其他查询。 */
export async function inspectGitFact(adapter: RepositoryAdapter, cwd: string, operation: GitInspectOperation): Promise<InspectResult> {
  switch (operation) {
    case 'status': return factValue(await gitStatusShort(adapter, cwd))
    case 'remote': return factValue(await gitOriginUrl(adapter, cwd))
    case 'top-level': return factValue(await gitTopLevel(adapter, cwd))
    case 'branch': {
      const head = await gitHead(adapter, cwd)
      if (head.kind === 'error') return { ok: false, reason: head.reason }
      return { ok: true, value: head.kind === 'value' ? head.value ?? '(detached)' : null }
    }
  }
}

/** Judge 只读 inspection：GitHub 列表；与 Program 共用同一 repository 识别、分页与过滤结果。 */
export async function inspectGithubFacts(adapter: RepositoryAdapter, cwd: string, operation: GithubInspectOperation, milestoneNumber?: number): Promise<InspectResult> {
  const identity = await repositoryIdentity(adapter, cwd)
  if (identity.kind === 'ERROR') return { ok: false, reason: identity.reason }
  const { owner, repo } = identity.value
  if (operation === 'milestones') {
    const listed = await listMilestones(adapter, cwd, owner, repo)
    return listed.kind === 'ERROR' ? { ok: false, reason: listed.reason } : { ok: true, value: listed.value }
  }
  if (operation === 'issues') {
    const listed = await listIssues(adapter, cwd, owner, repo)
    return listed.kind === 'ERROR' ? { ok: false, reason: listed.reason } : { ok: true, value: listed.value }
  }
  if (milestoneNumber === undefined) return { ok: false, reason: 'milestoneNumber is required for milestone-issues' }
  const listed = await listIssues(adapter, cwd, owner, repo, milestoneNumber)
  return listed.kind === 'ERROR' ? { ok: false, reason: listed.reason } : { ok: true, value: listed.value }
}
