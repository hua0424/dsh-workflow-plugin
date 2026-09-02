/**
 * Strict zod schema for agent-workflow/v1 configs (design §2.3/§2.4/§7).
 * Unknown fields are rejected at every level (zod object default = strip;
 * we use .strict()).
 */
import { z } from 'zod'

const nonEmptyTrimmed = z.string().trim().min(1)

const roleModel = z
  .object({
    provider: nonEmptyTrimmed,
    modelId: nonEmptyTrimmed,
  })
  .strict()

const roleDefinition = z
  .object({
    persona: nonEmptyTrimmed,
    model: roleModel.optional(),
    tools: z
      .object({
        deny: z.array(nonEmptyTrimmed).min(1),
      })
      .strict()
      .optional(),
  })
  .strict()

const judgeRoleDefinition = z
  .object({
    persona: nonEmptyTrimmed,
    model: roleModel.optional(),
  })
  .strict()

const actorTaskExecution = z
  .object({
    type: z.literal('actor-task'),
    role: nonEmptyTrimmed,
    instruction: nonEmptyTrimmed,
  })
  .strict()

const builtinProgramExecution = z
  .object({
    type: z.literal('builtin-program'),
    programId: nonEmptyTrimmed,
    instruction: nonEmptyTrimmed.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const childWorkflowExecution = z
  .object({
    type: z.literal('child-workflow'),
    workflowId: nonEmptyTrimmed,
  })
  .strict()

const checkerRef = z
  .object({
    checkerId: nonEmptyTrimmed,
    config: z.record(z.string(), z.unknown()),
  })
  .strict()

const endTarget = z.literal('END')

const actorTaskNode = z
  .object({
    execution: actorTaskExecution,
    checker: checkerRef,
    onPass: nonEmptyTrimmed,
    onFail: nonEmptyTrimmed.optional(),
  })
  .strict()

const builtinProgramNode = z
  .object({
    execution: builtinProgramExecution,
    onPass: nonEmptyTrimmed,
    onFail: nonEmptyTrimmed.optional(),
  })
  .strict()

const childWorkflowNode = z
  .object({
    execution: childWorkflowExecution,
    onPass: nonEmptyTrimmed,
  })
  .strict()

const nodeUnion = z.union([actorTaskNode, builtinProgramNode, childWorkflowNode])

const workflowDef = z
  .object({
    startNode: nonEmptyTrimmed,
    nodes: z.record(z.string(), nodeUnion),
  })
  .strict()

export const workflowConfigSchema = z
  .object({
    schemaVersion: z.literal('agent-workflow/v1'),
    roles: z.record(z.string(), roleDefinition),
    judgeRole: judgeRoleDefinition,
    workflow: workflowDef,
    childWorkflows: z.record(z.string(), workflowDef).optional(),
  })
  .strict()

export type WorkflowConfigRaw = z.infer<typeof workflowConfigSchema>

export class CatalogSchemaError extends Error {
  readonly issues: z.core.$ZodIssue[]
  constructor(issues: z.core.$ZodIssue[]) {
    super(issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '))
    this.name = 'CatalogSchemaError'
    this.issues = issues
  }
}

/** Validate raw JSON against the strict schema. */
export function parseWorkflowConfig(raw: unknown): z.infer<typeof workflowConfigSchema> {
  const result = workflowConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new CatalogSchemaError(result.error.issues)
  }
  return result.data
}
