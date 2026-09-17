/**
 * Static validation + normalization for a parsed v3 workflow config (design
 * §2.4/§7). Runs after the strict schema; returns a normalized snapshot or
 * throws CatalogValidationError listing every structural violation.
 *
 * v3 shape: every workflow declares a non-empty unique `returns` list; every
 * node declares a non-empty `results` map whose entries each carry criteria and
 * one strictly exclusive Target (`{ node }` or `{ return }`). Child callers
 * declare `onReturn` keyed by the callee's returns (接通由后续票负责，本票静态
 * 拒绝未接通的 Child 执行路径，不给旧路径猜测推进的机会)。
 */
import { createHash } from 'node:crypto'
import { ID_PATTERN, LIMITS, RESERVED_ROLE_KEYS, isActorTaskNode, nodeChecker, nodeOnReturn, nodeResults, roleReuseMode, type CheckerRef, type NodeDef, type Target, type WorkflowConfig, type WorkflowDef } from '../types.ts'
// #100：固定 program id 名单从 Program 元数据单源派生，不在这里另维护一份。
import { BUILTIN_PROGRAM_IDS } from '../programs/metadata.ts'

export class CatalogValidationError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`workflow config invalid: ${problems.join('; ')}`)
    this.name = 'CatalogValidationError'
    this.problems = problems
  }
}

/** Builtin checker ids known to this plugin version (design §3). */
export const BUILTIN_CHECKER_IDS = new Set(['judge.claim-correct'])

/**
 * Actor 节点隐含支持的结果名：单结果节点直接声明 `succeeded`。Program 节点的
 * PASS/FAIL 是执行协议而非业务结果，`results` 的键固定为 `PASS`/`FAIL`。
 */
export const ACTOR_SUCCESS_RESULT = 'succeeded'
export const PROGRAM_RESULT_NAMES = ['PASS', 'FAIL'] as const

/** 统一 Target 的目标种类（判定与路由共用同一解释，不各自解析字符串）。 */
export function targetName(target: Target): string {
  return 'node' in target ? target.node : target.return
}

function validTarget(target: Target, def: WorkflowDef): boolean {
  return 'node' in target
    ? Object.prototype.hasOwnProperty.call(def.nodes, target.node)
    : def.returns.includes(target.return)
}

/** 目标在本流程内可达的下一步节点；`return` 目标没有下一步。 */
function nextNode(target: Target, def: WorkflowDef): string | undefined {
  return 'node' in target && Object.prototype.hasOwnProperty.call(def.nodes, target.node) ? target.node : undefined
}

/** 节点的全部静态目标（Child 用 onReturn 的值域）。 */
function nodeTargets(node: NodeDef): Target[] {
  const results = nodeResults(node)
  if (results !== undefined) return Object.values(results).map(result => result.target)
  return Object.values(nodeOnReturn(node) ?? {})
}

/**
 * Normalize (trim persona/instruction/criteria) and deep-validate one config.
 * Blocking problems throw `CatalogValidationError`; #59 non-blocking warnings
 * are appended to `extra.warnings` and never reject the config.
 */
export function validateAndNormalize(config: WorkflowConfig, extra?: { workflowId?: string; warnings?: string[] }): WorkflowConfig {
  const problems: string[] = []
  const warnings = extra?.warnings ?? []
  const workflowId = extra?.workflowId

  if (workflowId !== undefined && !ID_PATTERN.test(workflowId)) {
    problems.push(`workflow id "${workflowId}" is not a valid lowercase [a-z][a-z0-9-]* id`)
  }

/** #42 P5 (#46): persona keywords that duplicate the engine-owned submission
 * protocol — the protocol is single-sourced in SUBMISSION_CONSTRAINT.
 * #59: drift risk only, so this is a non-blocking warning, never a problem. */
const PERSONA_PROTOCOL_KEYWORDS = ['node_claim', 'judge_claim', 'send_message']

function checkPersonaProtocol(label: string, persona: string, warnings: string[]): void {
  const hit = PERSONA_PROTOCOL_KEYWORDS.find(keyword => persona.includes(keyword))
  if (hit !== undefined) {
    warnings.push(`${label} persona must not hand-write submission protocol (found "${hit}"); the submission protocol is engine-owned (SUBMISSION_CONSTRAINT) — keep only business discipline in persona (migration: docs/user-guide.md §4)`)
  }
}

  // roles
  for (const [roleKey, role] of Object.entries(config.roles)) {
    if (!ID_PATTERN.test(roleKey)) {
      problems.push(`role key "${roleKey}" is not a valid lowercase [a-z][a-z0-9-]* id`)
    }
    if (RESERVED_ROLE_KEYS.includes(roleKey as (typeof RESERVED_ROLE_KEYS)[number])) {
      problems.push(`role key "${roleKey}" is reserved and cannot be configured`)
    }
    role.persona = role.persona.trim()
    // #60: 缺省 reuse 在此归一化为 `node`，随 definitionSnapshot 一并冻结；
    // 之后修改 YAML 只影响新启动的 Run。
    role.reuse = roleReuseMode(role)
    checkPersonaProtocol(`role "${roleKey}"`, role.persona, warnings)
  }

  // judge role
  config.judgeRole.persona = config.judgeRole.persona.trim()
  checkPersonaProtocol('judgeRole', config.judgeRole.persona, warnings)

  // workflows (root + children)
  const allWorkflows: Record<string, WorkflowDef> = { ...(config.childWorkflows ?? {}) }
  const rootName = workflowId ?? 'root'
  allWorkflows[rootName] = config.workflow

  for (const [name, def] of Object.entries(allWorkflows)) {
    if (!ID_PATTERN.test(name)) {
      problems.push(`workflow id "${name}" is not a valid lowercase [a-z][a-z0-9-]* id`)
    }
    if (!Object.prototype.hasOwnProperty.call(def.nodes, def.startNode)) {
      problems.push(`workflow "${name}" startNode "${def.startNode}" does not exist`)
    }
    // 返回名：非空（schema 已保证）、不重复、合法标识符。
    const returns = def.returns ?? []
    if (returns.length === 0) problems.push(`workflow "${name}" must declare at least one return`)
    if (new Set(returns).size !== returns.length) {
      problems.push(`workflow "${name}" declares duplicate returns: ${returns.filter((r, i) => returns.indexOf(r) !== i).join(', ')}`)
    }
    for (const returnName of returns) {
      if (!ID_PATTERN.test(returnName)) problems.push(`workflow "${name}" return "${returnName}" is not a valid lowercase [a-z][a-z0-9-]* id`)
    }
    // node-id grammar
    for (const nodeId of Object.keys(def.nodes)) {
      if (!ID_PATTERN.test(nodeId)) {
        problems.push(`workflow "${name}" node id "${nodeId}" is not a valid lowercase [a-z][a-z0-9-]* id`)
      }
    }
    // Root startNode must be manager actor-task
    if (name === rootName) {
      const start = def.nodes[def.startNode]
      const isManagerActor = start !== undefined
        && start.execution.type === 'actor-task'
        && start.execution.role === 'manager'
      if (!isManagerActor) {
        problems.push(`root workflow startNode must be an actor-task with role "manager" (got ${start === undefined ? 'missing node' : JSON.stringify(start.execution)})`)
      }
    }
    // per-node checks
    for (const [nodeId, node] of Object.entries(def.nodes)) {
      const label = `workflow "${name}" node "${nodeId}"`
      const execution = node.execution
      if (execution.type === 'actor-task') {
        if (!Object.prototype.hasOwnProperty.call(config.roles, execution.role) && execution.role !== 'manager') {
          problems.push(`${label} references unknown role "${execution.role}"`)
        }
        if (execution.role === 'judge') {
          problems.push(`${label} cannot use reserved role "judge" as a worker`)
        }
        execution.instruction = execution.instruction.trim()
        validateChecker(label, nodeChecker(node)!, problems)
        validateResults(label, node, def, problems)
      } else if (execution.type === 'builtin-program') {
        if (!BUILTIN_PROGRAM_IDS.has(execution.programId)) {
          problems.push(`${label} references unknown builtin program "${execution.programId}"`)
        }
        if (execution.instruction !== undefined) execution.instruction = execution.instruction.trim()
        validateResults(label, node, def, problems)
        const declared = Object.keys(nodeResults(node) ?? {})
        const missing = PROGRAM_RESULT_NAMES.filter(kind => !declared.includes(kind))
        if (missing.length > 0) problems.push(`${label} must declare results ${missing.join(', ')}`)
        const extra = declared.filter(kind => !(PROGRAM_RESULT_NAMES as readonly string[]).includes(kind))
        if (extra.length > 0) problems.push(`${label} declares unknown Program results ${extra.join(', ')}; Program results are PASS and FAIL`)
      } else {
        // child-workflow：数据形状已按 v3 冻结（onReturn ↔ 被调用流程 returns 完全一致），
        // 但嵌套原子返回与显式映射的执行路径由后续票接通；本票在产生任何业务副作用前
        // 明确拒绝，不沿旧路径猜测推进。
        const childName = execution.workflowId
        const child = config.childWorkflows?.[childName]
        if (child === undefined) {
          problems.push(`${label} references unknown child workflow "${childName}"`)
        } else {
          const expected = [...(child.returns ?? [])].sort()
          const declared = Object.keys(nodeOnReturn(node) ?? {}).sort()
          const missing = expected.filter(returnName => !declared.includes(returnName))
          const extra = declared.filter(returnName => !expected.includes(returnName))
          if (missing.length > 0) problems.push(`${label} onReturn is missing mappings for returns ${missing.join(', ')}`)
          if (extra.length > 0) problems.push(`${label} onReturn maps unknown returns ${extra.join(', ')}`)
        }
        if (execution.workflowId === rootName) {
          problems.push(`${label} cannot reference the root workflow as a child`)
        }
        validateTargets(label, nodeTargets(node), def, problems)
        problems.push(`${label} uses child-workflow, which this version does not execute yet (T2); remove the node or wait for explicit Child return support`)
      }
    }
    // reachability: every node reachable from startNode via static targets
    const reachable = new Set<string>()
    const queue = [def.startNode]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (reachable.has(current)) continue
      reachable.add(current)
      const n = def.nodes[current]
      if (n === undefined) continue
      for (const target of nodeTargets(n)) {
        const next = nextNode(target, def)
        if (next !== undefined) queue.push(next)
      }
    }
    for (const nodeId of Object.keys(def.nodes)) {
      if (!reachable.has(nodeId)) {
        problems.push(`workflow "${name}" node "${nodeId}" is not reachable from startNode`)
      }
    }
    // every declared return needs at least one structurally reachable return path
    const reachableReturns = new Set<string>()
    for (const nodeId of reachable) {
      const n = def.nodes[nodeId]
      if (n === undefined) continue
      for (const target of nodeTargets(n)) if ('return' in target) reachableReturns.add(target.return)
    }
    for (const returnName of returns) {
      if (!reachableReturns.has(returnName)) {
        problems.push(`workflow "${name}" return "${returnName}" has no structurally reachable return path`)
      }
    }
  }

  // child reference DAG: no direct/indirect recursion; root not referenced (checked above)
  const childGraph: Record<string, string[]> = {}
  for (const [childId, def] of Object.entries(config.childWorkflows ?? {})) {
    childGraph[childId] = []
    for (const node of Object.values(def.nodes)) {
      if (node.execution.type === 'child-workflow') {
        childGraph[childId]!.push(node.execution.workflowId)
      }
    }
  }
  // DFS cycle detection
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      problems.push(`child workflow reference cycle detected at "${id}"`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    for (const next of childGraph[id] ?? []) visit(next)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of Object.keys(childGraph)) visit(id)

  if (problems.length > 0) throw new CatalogValidationError(problems)
  return config
}

function validateChecker(label: string, checker: CheckerRef, problems: string[]): void {
  if (!BUILTIN_CHECKER_IDS.has(checker.checkerId)) {
    problems.push(`${label} references unknown checker "${checker.checkerId}"`)
    return
  }
  // 归一化：省略的 config 落成空对象（「没有共同条件」），后续读取无需再兜底。
  checker.config ??= {}
  if (checker.checkerId === 'judge.claim-correct') {
    const criteria = checker.config['criteria']
    // v3: 共同条件可省略（省略 = 没有共同条件）；提供时非空且有界。
    if (criteria === undefined) {
      checker.config = {}
      return
    }
    if (typeof criteria !== 'string') {
      problems.push(`${label} checker config.criteria must be a non-empty string when provided`)
    } else {
      const trimmed = criteria.trim()
      if (trimmed.length < LIMITS.criteriaMin || trimmed.length > LIMITS.criteriaMax) {
        problems.push(`${label} checker config.criteria must be ${LIMITS.criteriaMin}..${LIMITS.criteriaMax} characters after trim (got ${trimmed.length})`)
      } else {
        checker.config = { criteria: trimmed }
      }
    }
  }
}

/** 结果集与每个结果的目标/条件校验（Actor 与 Program 共用）。 */
function validateResults(label: string, node: NodeDef, def: WorkflowDef, problems: string[]): void {
  const results = nodeResults(node)
  if (results === undefined) return
  const names = Object.keys(results)
  if (names.length === 0) {
    problems.push(`${label} must declare at least one result`)
    return
  }
  for (const [resultName, result] of Object.entries(results)) {
    if (!ID_PATTERN.test(resultName)) {
      problems.push(`${label} result name "${resultName}" is not a valid lowercase [a-z][a-z0-9-]* id`)
    }
    const criteria = result.criteria.trim()
    if (criteria.length < LIMITS.criteriaMin || criteria.length > LIMITS.criteriaMax) {
      problems.push(`${label} result "${resultName}" criteria must be ${LIMITS.criteriaMin}..${LIMITS.criteriaMax} characters after trim (got ${criteria.length})`)
    } else {
      result.criteria = criteria
    }
  }
  validateTargets(label, Object.values(results).map(result => result.target), def, problems)
}

function validateTargets(label: string, targets: Target[], def: WorkflowDef, problems: string[]): void {
  for (const target of targets) {
    if (validTarget(target, def)) continue
    problems.push('node' in target
      ? `${label} target node "${target.node}" does not exist`
      : `${label} target return "${target.return}" is not declared by this workflow`)
  }
}

/** Stable definition hash over the normalized snapshot (design §5). */
export function computeDefinitionHash(config: WorkflowConfig): string {
  const canonical = JSON.stringify(config)
  return createHash('sha256').update(canonical).digest('hex')
}
