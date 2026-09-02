/**
 * judge.goal-satisfied: user prompt template + structured output parsing
 * (design §3.1/§10.3). The Judge persona is delivered through the spawn's
 * `persona` option (deployment-persona shadowing); this module owns only the
 * evaluation request text and the strict output protocol.
 */
import { z } from 'zod'
import type { JudgeResult } from '../types.ts'

export const judgeResultSchema = z
  .object({
    result: z.enum(['PASS', 'FAIL']),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()

/** Parse the Judge's final structured output; throws on invalid shape. */
export function parseJudgeResult(text: string): JudgeResult {
  let candidate = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(candidate)
  if (fence !== null) candidate = fence[1]!.trim()
  const parsed: unknown = JSON.parse(candidate)
  const result = judgeResultSchema.parse(parsed)
  return result
}

export interface JudgePromptInput {
  nodeInstruction: string
  criteria: string
  workerSummary: string
  workerOutcome: string
  workspaceCwd: string
  transcript: string
}

const PROMPT_TEMPLATE = `You are an independent workflow judge evaluating ONE completed worker claim against the real workspace/remote facts.

# Judgment duty
- Inspect the actual workspace and repositories; never trust the worker's self-report alone.
- You are READ-ONLY: never modify files, repositories, issues, or any external state.
- Only tools visible to you may be used; if a needed read capability is missing, do not guess — report the limitation.

# Output protocol (strict)
Produce exactly one JSON object with these fields:
- "result": "PASS" or "FAIL"
- "reason": 1..2000 characters explaining the judgment

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

# Manager session context (user/manager-visible only)
{transcript}`

/** Render the evaluation request text sent as the Judge's user message. */
export function renderJudgePrompt(input: JudgePromptInput): string {
  return PROMPT_TEMPLATE
    .replace('{nodeInstruction}', input.nodeInstruction)
    .replace('{criteria}', input.criteria)
    .replace('{workerOutcome}', input.workerOutcome)
    .replace('{workerSummary}', input.workerSummary)
    .replace('{workspaceCwd}', input.workspaceCwd)
    .replace('{transcript}', input.transcript === '' ? '(no prior user/manager conversation)' : input.transcript)
}
