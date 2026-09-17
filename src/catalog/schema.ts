/**
 * Strict zod schema for agent-workflow/v3 configs (design §2.3/§2.4/§7).
 * Unknown fields are rejected at every level (zod object default = strip; we
 * use .strict()). v2 configs are rejected outright — no dual-track runtime and
 * no v2 `failed` → business result guessing.
 */
import { z } from 'zod'
import { ID_PATTERN, LIMITS, ROLE_REUSE_MODES } from '../types.ts'
import { JUDGE_PROTECTED_TOOLS } from '../roles/roles.ts'

const nonEmptyTrimmed = z.string().trim().min(1)

const roleModel = z
  .object({
    // A1 D3 caps, enforced after the trim transform (stored values are trimmed).
    provider: nonEmptyTrimmed.max(LIMITS.providerMax),
    modelId: nonEmptyTrimmed.max(LIMITS.modelIdMax),
  })
  .strict()

const roleDefinition = z
  .object({
    persona: nonEmptyTrimmed,
    model: roleModel.optional(),
    // #60: node | continuable；省略由 validateAndNormalize 归一化为 `node`。
    // 非法取值在这里被拒（strict + enum），只阻塞声明它的那个 catalog 文件。
    reuse: z.enum(ROLE_REUSE_MODES).optional(),
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
    // Issue #25: the Judge inherits the full tool catalog; `deny` narrows it on
    // top of the plugin default deny list. Protected tools stay undeniably
    // present (denying `judge_claim` or the delegation machinery deadlocks the
    // Judge), mirroring the role-level `tools.deny` shape.
    tools: z
      .object({
        deny: z.array(nonEmptyTrimmed).min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const name of value.tools?.deny ?? []) {
      if ((JUDGE_PROTECTED_TOOLS as readonly string[]).includes(name)) {
        ctx.addIssue({ code: 'custom', path: ['tools', 'deny'], message: `Judge tool "${name}" is required and cannot be denied` })
      }
    }
  })

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
    // v3: 共同验收条件可省略（省略 = 本节点没有共同条件）；提供时非空。
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  // 归一化在 schema 边界完成：省略的 config 落成空对象，运行期无需再兜底。
  .transform(value => ({ ...value, config: value.config ?? {} }))

/**
 * 统一 Target：严格互斥的 `{ node }` 或 `{ return }`。恰好一个字段——同时出现
 * node+return、空对象、额外字段以及裸 END 字符串一律被拒。标识符语法与存在性由
 * validateAndNormalize 静态校验。
 */
const nodeTarget = z.object({ node: z.string().regex(ID_PATTERN, 'target node must be a lowercase [a-z][a-z0-9-]* id') }).strict()
const returnTarget = z.object({ return: z.string().regex(ID_PATTERN, 'target return must be a lowercase [a-z][a-z0-9-]* id') }).strict()

/**
 * 按给定形状显式分派（而非裸 union）：union 会把互斥分支的失败混成一句
 * "Invalid input"，看不出真正违规的键（例如 v2 的 `onPass`）。分派后错误直指
 * 具体节点类型与要求的 Target 形状，严格未知字段拒绝不变。
 */
function dispatched<T>(inner: z.ZodType<T>, shapeError: string, ok: (value: unknown) => boolean = () => true) {
  return z.any().superRefine((value, ctx) => {
    if (!ok(value)) {
      ctx.addIssue({ code: 'custom', message: shapeError })
      return
    }
    const parsed = inner.safeParse(value)
    if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue(issue as never)
  })
}

const TARGET_SHAPE = 'target must be exactly { node: <this-flow node> } or { return: <declared return> }'
const target = dispatched(
  z.union([nodeTarget, returnTarget]),
  TARGET_SHAPE,
  value => {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    if (record === undefined) return false
    return Object.prototype.hasOwnProperty.call(record, 'node') !== Object.prototype.hasOwnProperty.call(record, 'return')
  },
)

const resultDef = z
  .object({
    criteria: nonEmptyTrimmed.max(LIMITS.criteriaMax),
    target,
  })
  .strict()

/** 结果名在本节点局部解释；与返回名一样沿用小写标识符规则。 */
const results = z.record(z.string().regex(ID_PATTERN, 'result name must be a lowercase [a-z][a-z0-9-]* id'), resultDef)

const actorTaskNode = z
  .object({
    execution: actorTaskExecution,
    checker: checkerRef,
    results,
  })
  .strict()

const builtinProgramNode = z
  .object({
    execution: builtinProgramExecution,
    results,
  })
  .strict()

const childWorkflowNode = z
  .object({
    execution: childWorkflowExecution,
    onReturn: z.record(z.string().regex(ID_PATTERN, 'return name must be a lowercase [a-z][a-z0-9-]* id'), target),
  })
  .strict()

const nodeUnion = dispatched(
  z.union([actorTaskNode, builtinProgramNode, childWorkflowNode]),
  'node requires execution.type of actor-task | builtin-program | child-workflow',
  value => ['actor-task', 'builtin-program', 'child-workflow'].includes(
    String((value as { execution?: { type?: unknown } } | null)?.execution?.type ?? ''),
  ),
)

const workflowDef = z
  .object({
    startNode: nonEmptyTrimmed,
    returns: z.array(z.string().regex(ID_PATTERN, 'return name must be a lowercase [a-z][a-z0-9-]* id')).min(1),
    nodes: z.record(z.string(), nodeUnion),
  })
  .strict()

export const workflowConfigSchema = z
  .object({
    schemaVersion: z.literal('agent-workflow/v3'),
    roles: z.record(z.string(), roleDefinition),
    judgeRole: judgeRoleDefinition,
    workflow: workflowDef,
    childWorkflows: z.record(z.string(), workflowDef).optional(),
  })
  .strict()

/**
 * 裸 union 的顶层错误只说 "Invalid input"，用户看不到真正违规的键（例如 v2 的
 * `onPass`）。这里把嵌套分支里的 unknown-key 诊断提到顶层，保持严格拒绝的同时
 * 让错误文本可定位。
 */
function collectUnrecognizedKeys(issue: z.core.$ZodIssue, found: Set<string>): void {
  const keys = (issue as { keys?: unknown }).keys
  if (Array.isArray(keys)) for (const key of keys) if (typeof key === 'string') found.add(key)
  const nested = (issue as { errors?: unknown }).errors
  if (Array.isArray(nested)) for (const branch of nested) {
    const list = Array.isArray(branch) ? branch : [branch]
    for (const inner of list) collectUnrecognizedKeys(inner as z.core.$ZodIssue, found)
  }
}

export class CatalogSchemaError extends Error {
  readonly issues: z.core.$ZodIssue[]
  constructor(issues: z.core.$ZodIssue[]) {
    const unrecognized = new Set<string>()
    for (const issue of issues) collectUnrecognizedKeys(issue, unrecognized)
    const detail = unrecognized.size > 0 ? `; unrecognized keys: ${[...unrecognized].sort().join(', ')}` : ''
    super(issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') + detail)
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
