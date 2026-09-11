/**
 * judge.claim-correct (A1 v2): the Judgment Packet prompt template + the
 * `judge_claim` protocol contract.
 *
 * The continuable Judge receives a fixed Judgment Packet and submits its
 * confirmation through the dedicated `judge_claim({ nodeToken, result, reason })`
 * tool. ACCEPT/REJECT confirm whether the Actor's claim is trustworthy — the
 * Graph verdict (PASS/FAIL) is derived from the claim outcome, never from the
 * Judge. This module owns only the packet text; the persona is delivered via
 * the spawn's `persona` option.
 */
import type { JudgeResult, NodeClaim } from '../types.ts'
import { LIMITS } from '../types.ts'
import { JUDGE_RECOVERY_INSTRUCTION } from '../engine/texts.ts'

/** Validate a parsed judge_claim argument into a JudgeResult (A1 v2). */
export function parseJudgeClaim(args: unknown): JudgeResult | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const result = record['result']
  if (result !== 'ACCEPT' && result !== 'REJECT' && result !== 'NEED_CONTEXT') return undefined
  const reason = record['reason']
  if (typeof reason !== 'string' || reason.trim().length < LIMITS.reasonMin || reason.trim().length > LIMITS.reasonMax) return undefined
  return { result, reason: reason.trim() }
}

export interface JudgePromptInput {
  nodeToken: string
  criteria: string
  workerOutcome: 'completed' | 'failed'
  workerHandoff: string
  workspaceCwd: string
  transcript: string
  /** Judge 中断恢复：只读核验，不补做 Actor 工作（固定协议段，随 packet 下发）。 */
  recovery?: boolean
  /** 最近 REJECT/NEED_CONTEXT 反馈；fresh/followup Judge 读取同一材料。 */
  previousFeedback?: { result: 'REJECT' | 'NEED_CONTEXT'; reason: string; claim: NodeClaim }
  managerContext?: string
}

const PROMPT_TEMPLATE = `You are an independent workflow judge evaluating ONE submitted worker claim against the real workspace/remote facts.

# Judgment duty
- Inspect the actual workspace and repositories; never trust the worker's self-report alone.
- You are READ-ONLY: never modify files, repositories, issues, or any external state.
- Only tools visible to you may be used; if a needed read capability is missing, do not guess — report the limitation.

# Verdict protocol (strict)
Submit your verdict ONLY through the \`judge_claim\` tool, exactly once, with:
- "nodeToken": "{nodeToken}"
- "result": "ACCEPT" | "REJECT" | "NEED_CONTEXT"
- "reason": 1..2000 characters explaining the judgment

- ACCEPT: the worker's claim is consistent with the facts and the goal criteria. The node then concludes exactly as the worker claimed (completed → PASS edge, failed → FAIL edge).
- REJECT: the claim conflicts with an existing criterion or a verifiable fact. Your reason MUST identify that criterion, cite the factual basis, and state concretely HOW to correct the work — the worker receives it verbatim for another attempt at the SAME node.
- Use NEED_CONTEXT when information is insufficient or an existing requirement is unclear. State what is missing, why it affects judgment, and what the Manager should provide — never turn a personal preference into a new criterion and never just say "cannot judge".

# Current judgment
Goal criteria (authoritative and frozen for this execution):
{criteria}
{recovery}{previousFeedback}{managerContext}
Worker claimed outcome: {workerOutcome}

Worker handoff:
{workerHandoff}

# Workspace
cwd: {workspaceCwd}

# Node-local context (user/manager/actor-visible only, since this node dispatched)
{transcript}`

/** Render the latest non-terminal Judge feedback with its exact claim. */
function renderPreviousFeedback(feedback: JudgePromptInput['previousFeedback']): string {
  if (feedback === undefined) return ''
  return `\n# Previous Judge feedback on this node (${feedback.result})\n[judge reason]\n${feedback.reason}\n\n[judged claim]\noutcome: ${feedback.claim.outcome}\nhandoff: ${feedback.claim.handoff}\n`
}

function renderManagerContext(context: string | undefined): string {
  return context === undefined ? '' : `\n# Manager context (clarifies existing inputs; does not change frozen criteria)\n${context}\n`
}

function renderRecovery(recovery: boolean | undefined): string {
  return recovery === true ? `${JUDGE_RECOVERY_INSTRUCTION}\n` : ''
}

/** Render the Judgment Packet sent as the Judge's initial user message (A1 R7). */
export function renderJudgePrompt(input: JudgePromptInput): string {
  const fields: Record<string, string> = {
    ...input,
    recovery: renderRecovery(input.recovery),
    previousFeedback: renderPreviousFeedback(input.previousFeedback),
    managerContext: renderManagerContext(input.managerContext),
    transcript: input.transcript === '' ? '(no node-local conversation since dispatch)' : input.transcript,
  }
  // 单次替换：交付文本中的占位符和 $& 是原文，不再次解释。
  return PROMPT_TEMPLATE.replace(/\{(\w+)\}/g, (placeholder, key: string) => fields[key] ?? placeholder)
}
