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
import type { JudgeResult, PendingCorrection } from '../types.ts'
import { LIMITS } from '../types.ts'

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
  nodeInstruction: string
  criteria: string
  workerOutcome: 'completed' | 'failed'
  workerSummary: string
  workspaceCwd: string
  transcript: string
  /**
   * A1 R7/R8: REJECT evidence from a previous correction round on this same
   * node, when present — the Judge sees what was already rejected and why.
   */
  previousRejection?: PendingCorrection
}

const PROMPT_TEMPLATE = `You are an independent workflow judge evaluating ONE completed worker claim against the real workspace/remote facts.

# Judgment duty
- Inspect the actual workspace and repositories; never trust the worker's self-report alone.
- You are READ-ONLY: never modify files, repositories, issues, or any external state.
- Only tools visible to you may be used; if a needed read capability is missing, do not guess — report the limitation.

# Verdict protocol (strict)
Submit your verdict ONLY through the \`judge_claim\` tool, exactly once, with:
- "nodeToken": "{nodeToken}"
- "result": "ACCEPT" | "REJECT" | "NEED_CONTEXT"
- "reason": 1..2000 characters explaining the judgment

- ACCEPT: the worker's claim is consistent with the facts, the node instruction, and the goal criteria. The node then concludes exactly as the worker claimed (completed → PASS edge, failed → FAIL edge).
- REJECT: the claim is incorrect or the evidence is insufficient. Your reason MUST state concretely WHAT is wrong and HOW the work should be corrected — the worker receives it verbatim as the correction instruction for another attempt at the SAME node.
- Use NEED_CONTEXT only when you genuinely cannot judge reliably from this packet and the read-only workspace. The reason MUST state: what information is missing, why it affects the judgment, and what the Manager should provide — never just "cannot judge".

# Current judgment
Node instruction:
{nodeInstruction}

Goal criteria (authoritative):
{criteria}
{previousRejection}
Worker claimed outcome: {workerOutcome}

Worker summary:
{workerSummary}

# Workspace
cwd: {workspaceCwd}

# Node-local context (user/manager/actor-visible only, since this node dispatched)
{transcript}`

/** Render the [previous rejection]/[previous claim] evidence block (A1 §7.1). */
function renderPreviousRejection(pc: PendingCorrection | undefined): string {
  if (pc === undefined) return ''
  const handoff = pc.previousClaim.handoffContext !== undefined
    ? `\nhandoffContext: ${pc.previousClaim.handoffContext}`
    : ''
  return `\n# Previous judgment on this node (REJECTED)\n[judge rejection]\n${pc.judgeReason}\n\n[previous claim]\noutcome: ${pc.previousClaim.outcome}\nsummary: ${pc.previousClaim.summary}${handoff}\n`
}

/** Render the Judgment Packet sent as the Judge's initial user message (A1 R7). */
export function renderJudgePrompt(input: JudgePromptInput): string {
  return PROMPT_TEMPLATE
    .replaceAll('{nodeToken}', input.nodeToken)
    .replace('{nodeInstruction}', input.nodeInstruction)
    .replace('{criteria}', input.criteria)
    .replace('{previousRejection}', renderPreviousRejection(input.previousRejection))
    .replace('{workerOutcome}', input.workerOutcome)
    .replace('{workerSummary}', input.workerSummary)
    .replace('{workspaceCwd}', input.workspaceCwd)
    .replace('{transcript}', input.transcript === '' ? '(no node-local conversation since dispatch)' : input.transcript)
}
