/**
 * Strict zod schema for agent-workflow/v3 configs (design §2.3/§2.4/§7).
 * Unknown fields are rejected at every level (zod object default = strip; we
 * use .strict()). v2 configs are rejected outright — no dual-track runtime and
 * no v2 `failed` → business result guessing.
 */
import { z } from 'zod'
import { ID_PATTERN, LIMITS, ROLE_REUSE_MODES, type NodeDef } from '../types.ts'
import { JUDGE_PROTECTED_TOOLS } from '../roles/roles.ts'

const nonEmptyTrimmed = z.string().trim().min(1)

const roleModel = z
  .object({
    // A1 D3 caps, enforced after the trim transform (stored values are trimmed).
    provider: nonEmptyTrimmed.max(LIMITS.providerMax),
    modelId: nonEmptyTrimmed.max(LIMITS.modelIdMax),
    // #149 T1: 可选思考强度——适配器自有 opaque 档位 id，只做 trim/非空/长度
    // 约束，不 hardcode 档位枚举。Role 与 JudgeRole 共用同一 schema（对称支持）；
    // 旧 YAML 无该键照常加载。
    reasoningEffort: nonEmptyTrimmed.max(LIMITS.reasoningEffortMax).optional(),
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
 *
 * 注意：`z.record(键, 值)` 的**值位置同样会执行值 schema 上的 refine**（见下方
 * `onReturn` 的值就是 `target`，互斥性与裸 END 拒绝照常生效），所以这里不放在 record
 * 值位置的真实理由是**错误文本可定位**：整表分派能把节点 id 写进 issue path 与消息，
 * 裸 union 只会剩下 "Invalid input"。
 */
function dispatched<T>(inner: z.ZodType<T>, shapeError: string, ok: (value: unknown) => boolean = () => true) {
  // 用 z.unknown().superRefine：z.custom 的校验器在 Zod v4 只收到 value，拿不到 ctx。
  return z.unknown().superRefine((value, ctx) => {
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

/** 结果名在本节点局部解释；Actor 沿用小写标识符规则。 */
const results = z.record(z.string().regex(ID_PATTERN, 'result name must be a lowercase [a-z][a-z0-9-]* id'), resultDef)
/**
 * Program 的结果键是执行协议固定的 PASS/FAIL（不是业务结果名）；键的合法性与
 * 「PASS 与 FAIL 都必须声明」都由静态校验给出——若在 schema 用 enum 作 record 键，
 * Zod 会一次性要求全部键，报错就变成"缺键"而不是"两个结果都必须声明"的语义。
 */
const programResults = z.record(nonEmptyTrimmed, resultDef)

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
    results: programResults,
  })
  .strict()

const childWorkflowNode = z
  .object({
    execution: childWorkflowExecution,
    onReturn: z.record(z.string().regex(ID_PATTERN, 'return name must be a lowercase [a-z][a-z0-9-]* id'), target),
  })
  .strict()

/**
 * 节点表：整表一个 custom，逐节点按 `execution.type` 分派到对应 schema。
 * 放在这里（而不是 `z.record` 的值位置）是为了**错误文本可定位**：逐节点分派把节点 id
 * 写进 issue path，并直指该节点类型要求的形状。值位置并不会剥离 refine（见 `onReturn`），
 * 但 `z.record` 无法给每个值补上节点 id 这类上下文。
 */
const nodeTable = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.addIssue({ code: 'custom', message: 'nodes must be a mapping of node id to node' })
    return
  }
  for (const [nodeId, node] of Object.entries(value as Record<string, unknown>)) {
    if (!ID_PATTERN.test(nodeId)) {
      ctx.addIssue({ code: 'custom', path: [nodeId], message: `node id "${nodeId}" must be a lowercase [a-z][a-z0-9-]* id` })
    }
    const type = (node as { execution?: { type?: unknown } } | null)?.execution?.type
    const schema = type === 'actor-task' ? actorTaskNode : type === 'builtin-program' ? builtinProgramNode : type === 'child-workflow' ? childWorkflowNode : undefined
    if (schema === undefined) {
      ctx.addIssue({ code: 'custom', path: [nodeId], message: `node requires execution.type of actor-task | builtin-program | child-workflow (got ${JSON.stringify(type)})` })
      continue
    }
    const parsed = schema.safeParse(node)
    if (parsed.success) continue
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: [nodeId, ...issue.path] } as never)
  }
}) as unknown as z.ZodType<Record<string, NodeDef>>

const workflowDef = z
  .object({
    startNode: nonEmptyTrimmed,
    returns: z.array(z.string().regex(ID_PATTERN, 'return name must be a lowercase [a-z][a-z0-9-]* id')).min(1),
    nodes: nodeTable,
  })
  .strict()

export const workflowConfigSchema = z
  .object({
    schemaVersion: z.literal('agent-workflow/v3'),
    // Issue #140：可选非空字符串；trim 后存，空白值在此被拒（min 1 在 trim 后生效）。
    actorCommonPersona: nonEmptyTrimmed.optional(),
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
