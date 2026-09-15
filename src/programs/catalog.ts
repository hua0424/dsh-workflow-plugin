/**
 * Builtin program catalog (design §10.1/§10.2): fixed id → implementation map.
 * Two programs in v1, both operating on the CURRENT workspace repository.
 *
 * 读取合同（Issue #92）：两个 Program 只经 repository 只读事实层取事实，事实不可靠
 * （读取失败、结构不符、分页不完整）一律 ERROR（Runtime 转 BLOCK），绝不当成
 * 空集合 / clean / "不存在"；写动作只在依赖的读取事实全部可靠后才执行。
 */
import { gitLocalBranch, gitRemoteBranch, gitStatusShort, realRepositoryAdapter, type RepositoryAdapter } from './runner.ts'
import { listIssues, listMilestones, repositoryIdentity } from './repository.ts'
import { BUILTIN_PROGRAM_METADATA, type ProgramMetadata } from './metadata.ts'
import type { ProgramResult } from '../types.ts'

export interface ProgramContext {
  cwd: string
  /** 受控进程适配器（测试注入）；缺省走真实 git/gh 子进程。 */
  adapter?: RepositoryAdapter
}

/** 固定 id 的**执行实现**挂载：元数据（id/描述/参数合同）来自 `./metadata.ts` 单源。 */
export interface ProgramDefinition extends ProgramMetadata {
  run: (ctx: ProgramContext, parameters: Record<string, unknown>) => Promise<ProgramResult>
}

/** github.initialize-milestone: create/verify Milestone + exact local/remote branch. */
async function initializeMilestone(ctx: ProgramContext, parameters: Record<string, unknown>): Promise<ProgramResult> {
  const title = parameters['title']
  const branchName = parameters['branchName']
  if (typeof title !== 'string' || title.trim() === '') return { kind: 'ERROR', reason: 'title is required' }
  if (typeof branchName !== 'string' || branchName.trim() === '') return { kind: 'ERROR', reason: 'branchName is required' }
  const adapter = ctx.adapter ?? realRepositoryAdapter

  const identity = await repositoryIdentity(adapter, ctx.cwd)
  if (identity.kind === 'ERROR') return identity
  const { owner, repo } = identity.value

  // 预检（只读）：任一事实读取失败就 ERROR，绝不带着未知事实进入写动作。
  const milestones = await listMilestones(adapter, ctx.cwd, owner, repo)
  if (milestones.kind === 'ERROR') return milestones
  const existing = milestones.value.find(m => m.title === title.trim())
  if (existing !== undefined && existing.state !== 'open') {
    return { kind: 'FAIL', reason: `milestone "${title}" exists but is ${existing.state}` }
  }
  const local = await gitLocalBranch(adapter, ctx.cwd, branchName)
  if (local.kind === 'error') return { kind: 'ERROR', reason: `cannot read local branch ${branchName}: ${local.reason}` }
  const remote = await gitRemoteBranch(adapter, ctx.cwd, branchName)
  if (remote.kind === 'error') return { kind: 'ERROR', reason: `cannot read remote branch ${branchName}: ${remote.reason}` }
  const createLocal = local.kind === 'none'
  if (createLocal) {
    const status = await gitStatusShort(adapter, ctx.cwd)
    if (status.kind !== 'value') return { kind: 'ERROR', reason: `cannot read workspace status: ${status.reason}` }
    if (status.value !== '') return { kind: 'ERROR', reason: 'working tree is dirty; cannot create a milestone branch' }
  }

  // 写动作：事实已确认可靠后按依赖顺序执行（外部动作非事务，不做自动回滚）。
  let milestoneNumber: number
  if (existing !== undefined) {
    milestoneNumber = existing.number
  } else {
    const create = await adapter.gh({
      cwd: ctx.cwd, method: 'POST', path: `repos/${owner}/${repo}/milestones`,
      input: { title: title.trim(), state: 'open' },
    })
    if (create.kind === 'ERROR') return create
    const created = create.details as { number?: unknown }
    if (typeof created?.number !== 'number' || !Number.isSafeInteger(created.number)) {
      return { kind: 'ERROR', reason: 'milestone create response has no number' }
    }
    milestoneNumber = created.number
  }

  if (createLocal) {
    const created = await adapter.git(['checkout', '-b', branchName], ctx.cwd)
    if (created.exitCode !== 0) return { kind: 'ERROR', reason: `git checkout -b failed: ${created.stderr.trim().slice(0, 300)}` }
  }
  if (remote.kind === 'none') {
    // push 需要认证握手 + 传输，基线即显式给 120s 预算（同处其余 git 调用走默认 30s）。
    const push = await adapter.git(['push', '-u', 'origin', branchName], ctx.cwd, { timeoutMs: 120_000 })
    if (push.exitCode !== 0) return { kind: 'ERROR', reason: `git push failed: ${push.stderr.trim().slice(0, 300)}` }
  }

  return {
    kind: 'PASS',
    handoff: `GitHub milestone #${milestoneNumber} "${title.trim()}" is open; branch "${branchName}" exists locally and on origin for ${owner}/${repo}.`,
    details: { milestoneNumber, milestoneTitle: title.trim(), branchName, owner, repo },
  }
}

/** github.all-milestone-issues-complete: open issues ⇒ FAIL, all closed ⇒ PASS. */
async function allMilestoneIssuesComplete(ctx: ProgramContext, parameters: Record<string, unknown>): Promise<ProgramResult> {
  const raw = parameters['milestoneNumber']
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { kind: 'ERROR', reason: 'milestoneNumber must be an integer' }
  const adapter = ctx.adapter ?? realRepositoryAdapter

  const identity = await repositoryIdentity(adapter, ctx.cwd)
  if (identity.kind === 'ERROR') return identity
  const { owner, repo } = identity.value

  // 分页取全 + 结构校验 + PR 排除都在共享读取层完成；失败即 ERROR，不降级成空集合。
  const listed = await listIssues(adapter, ctx.cwd, owner, repo, raw)
  if (listed.kind === 'ERROR') return listed
  const open = listed.value.filter(i => i.state === 'open')
  if (listed.value.length === 0 || open.length > 0) {
    return {
      kind: 'FAIL',
      reason: `${open.length} open of ${listed.value.length} milestone issues`,
      handoff: `Milestone #${raw} has ${open.length} open of ${listed.value.length} issues.`,
    }
  }
  return {
    kind: 'PASS',
    handoff: `Milestone #${raw} has ${listed.value.length} closed issues and no open issues.`,
    details: { total: listed.value.length, open: 0, closed: listed.value.length },
  }
}

export const BUILTIN_PROGRAMS: Record<string, ProgramDefinition> = {
  'github.initialize-milestone': {
    programId: 'github.initialize-milestone',
    ...BUILTIN_PROGRAM_METADATA['github.initialize-milestone'],
    run: initializeMilestone,
  },
  'github.all-milestone-issues-complete': {
    programId: 'github.all-milestone-issues-complete',
    ...BUILTIN_PROGRAM_METADATA['github.all-milestone-issues-complete'],
    run: allMilestoneIssuesComplete,
  },
}
