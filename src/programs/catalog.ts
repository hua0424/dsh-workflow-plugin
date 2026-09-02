/**
 * Builtin program catalog (design §10.1/§10.2): fixed id → implementation map.
 * Two programs in v1, both operating on the CURRENT workspace repository.
 */
import { inspectGit, parseOriginRepo, ghApi, runProgram } from './runner.ts'
import type { ProgramResult } from '../types.ts'

export interface ProgramContext {
  cwd: string
}

export interface ProgramDefinition {
  programId: string
  description: string
  parameters: Record<string, { type: 'string' | 'number'; required: boolean; description: string }>
  run: (ctx: ProgramContext, parameters: Record<string, unknown>) => Promise<ProgramResult>
}

/** github.initialize-milestone: create/verify Milestone + exact local/remote branch. */
async function initializeMilestone(ctx: ProgramContext, parameters: Record<string, unknown>): Promise<ProgramResult> {
  const title = parameters['title']
  const branchName = parameters['branchName']
  if (typeof title !== 'string' || title.trim() === '') return { kind: 'ERROR', reason: 'title is required' }
  if (typeof branchName !== 'string' || branchName.trim() === '') return { kind: 'ERROR', reason: 'branchName is required' }

  const git = inspectGit(ctx.cwd)
  if (!git.inRepo) return { kind: 'ERROR', reason: 'workspace is not a git repository' }
  if (git.originUrl === undefined || git.originUrl === '') return { kind: 'ERROR', reason: 'no origin remote found' }
  const parsed = parseOriginRepo(git.originUrl)
  if (parsed === undefined) return { kind: 'ERROR', reason: `origin remote is not a GitHub repository: ${git.originUrl}` }
  const { owner, repo } = parsed

  // 1. Inspect-first: milestone already exists?
  const listResult = ghApi({ cwd: ctx.cwd, method: 'GET', path: `repos/${owner}/${repo}/milestones`, query: 'state=all&per_page=100' })
  if (listResult.kind === 'ERROR') return listResult
  const milestones = Array.isArray(listResult.details) ? listResult.details as Array<{ number: number; title: string; state: string }> : []
  const existing = milestones.find(m => m.title === title.trim())
  let milestoneNumber: number
  if (existing !== undefined) {
    if (existing.state !== 'open') return { kind: 'FAIL', reason: `milestone "${title}" exists but is ${existing.state}` }
    milestoneNumber = existing.number
  } else {
    const create = ghApi({
      cwd: ctx.cwd, method: 'POST', path: `repos/${owner}/${repo}/milestones`,
      input: { title: title.trim(), state: 'open' },
    })
    if (create.kind === 'ERROR') return create
    const created = create.details as { number?: number }
    if (typeof created.number !== 'number') return { kind: 'ERROR', reason: 'milestone create response has no number' }
    milestoneNumber = created.number
  }

  // 2. Local branch: create if absent (must start from a clean tree)
  const local = runProgram('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], { cwd: ctx.cwd })
  const branchExists = local.exitCode === 0
  if (!branchExists) {
    if ((git.statusShort ?? '') !== '') return { kind: 'ERROR', reason: 'working tree is dirty; cannot create a milestone branch' }
    const created = runProgram('git', ['checkout', '-b', branchName], { cwd: ctx.cwd })
    if (created.exitCode !== 0) return { kind: 'ERROR', reason: `git checkout -b failed: ${created.stderr.trim().slice(0, 300)}` }
  }

  // 3. Remote branch: push if absent
  const remote = runProgram('git', ['ls-remote', '--heads', 'origin', branchName], { cwd: ctx.cwd })
  const remoteExists = remote.exitCode === 0 && remote.stdout.trim() !== ''
  if (!remoteExists) {
    const push = runProgram('git', ['push', '-u', 'origin', branchName], { cwd: ctx.cwd, timeoutMs: 120_000 })
    if (push.exitCode !== 0) return { kind: 'ERROR', reason: `git push failed: ${push.stderr.trim().slice(0, 300)}` }
  }

  return {
    kind: 'PASS',
    details: { milestoneNumber, milestoneTitle: title.trim(), branchName, owner, repo },
  }
}

/** github.all-milestone-issues-complete: open issues ⇒ FAIL, all closed ⇒ PASS. */
async function allMilestoneIssuesComplete(ctx: ProgramContext, parameters: Record<string, unknown>): Promise<ProgramResult> {
  const raw = parameters['milestoneNumber']
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { kind: 'ERROR', reason: 'milestoneNumber must be an integer' }

  const git = inspectGit(ctx.cwd)
  if (!git.inRepo) return { kind: 'ERROR', reason: 'workspace is not a git repository' }
  if (git.originUrl === undefined || git.originUrl === '') return { kind: 'ERROR', reason: 'no origin remote found' }
  const parsed = parseOriginRepo(git.originUrl)
  if (parsed === undefined) return { kind: 'ERROR', reason: `origin remote is not a GitHub repository: ${git.originUrl}` }
  const { owner, repo } = parsed

  // state=all + milestone filter + per_page; exclude pull requests.
  const result = ghApi({
    cwd: ctx.cwd, method: 'GET', path: `repos/${owner}/${repo}/issues`,
    query: `state=all&milestone=${raw}&per_page=100`,
  })
  if (result.kind === 'ERROR') return result
  const issues = Array.isArray(result.details)
    ? (result.details as Array<{ number: number; state: string; pull_request?: unknown }>).filter(i => i.pull_request === undefined)
    : []
  const open = issues.filter(i => i.state === 'open')
  const closed = issues.filter(i => i.state === 'closed')
  if (issues.length === 0 || open.length > 0) {
    return { kind: 'FAIL', reason: `${open.length} open of ${issues.length} milestone issues` }
  }
  return { kind: 'PASS', details: { total: issues.length, open: 0, closed: closed.length } }
}

export const BUILTIN_PROGRAMS: Record<string, ProgramDefinition> = {
  'github.initialize-milestone': {
    programId: 'github.initialize-milestone',
    description: 'Create or verify the Milestone and the exact local+remote branch for the current workspace repository.',
    parameters: {
      title: { type: 'string', required: true, description: 'Milestone title' },
      branchName: { type: 'string', required: true, description: 'Branch name for the milestone work' },
    },
    run: initializeMilestone,
  },
  'github.all-milestone-issues-complete': {
    programId: 'github.all-milestone-issues-complete',
    description: 'Check whether every issue in the milestone is closed.',
    parameters: {
      milestoneNumber: { type: 'number', required: true, description: 'Milestone number (from initialize-milestone or the GitHub UI)' },
    },
    run: allMilestoneIssuesComplete,
  },
}
