/**
 * judge.goal-satisfied: the Judgment Packet prompt template + the `judge_claim`
 * protocol contract (A1 R7/R9–R10).
 *
 * The continuable Judge no longer returns a strict JSON object. It receives a
 * fixed Judgment Packet and submits its verdict through the dedicated
 * `judge_claim({ nodeToken, result, reason })` tool. This module owns only the
 * packet text; the persona is delivered via the spawn's `persona` option.
 */
import type { JudgeResult } from '../types.ts'
import { LIMITS } from '../types.ts'

/** Validate a parsed judge_claim argument into a JudgeResult (A1 R9). */
export function parseJudgeClaim(args: unknown): JudgeResult | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const result = record['result']
  if (result !== 'PASS' && result !== 'FAIL' && result !== 'NEED_CONTEXT') return undefined
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
}

const PROMPT_TEMPLATE = `You are an independent workflow judge evaluating ONE completed worker claim against the real workspace/remote facts.

# Judgment duty
- Inspect the actual workspace and repositories; never trust the worker's self-report alone.
- You are READ-ONLY: never modify files, repositories, issues, or any external state.
- Only tools visible to you may be used; if a needed read capability is missing, do not guess — report the limitation.

# Verdict protocol (strict)
Submit your verdict ONLY through the \`judge_claim\` tool, exactly once, with:
- "nodeToken": "{nodeToken}"
- "result": "PASS" | "FAIL" | "NEED_CONTEXT"
- "reason": 1..2000 characters explaining the judgment

- PASS and FAIL are the only Graph results.
- Use NEED_CONTEXT only when you genuinely cannot judge reliably from this packet and the read-only workspace. The reason MUST state: what information is missing, why it affects PASS/FAIL, and what the Manager should provide — never just "cannot judge".

# Current judgment
Node instruction:
{nodeInstruction}

Goal criteria (authoritative):
{criteria}

Worker claimed outcome: {workerOutcome}

Worker summary:
{workerSummary}

# Workspace
cwd: {workspaceCwd}

# Node-local context (user/manager/actor-visible only, since this node dispatched)
{transcript}`

/** Render the Judgment Packet sent as the Judge's initial user message (A1 R7). */
export function renderJudgePrompt(input: JudgePromptInput): string {
  return PROMPT_TEMPLATE
    .replaceAll('{nodeToken}', input.nodeToken)
    .replace('{nodeInstruction}', input.nodeInstruction)
    .replace('{criteria}', input.criteria)
    .replace('{workerOutcome}', input.workerOutcome)
    .replace('{workerSummary}', input.workerSummary)
    .replace('{workspaceCwd}', input.workspaceCwd)
    .replace('{transcript}', input.transcript === '' ? '(no node-local conversation since dispatch)' : input.transcript)
}
