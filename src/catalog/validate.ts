/**
 * Static validation + normalization for a parsed workflow config (design §2.4/§7).
 * Runs after the strict schema; returns a normalized snapshot or throws
 * CatalogValidationError listing every structural violation.
 */
import { createHash } from 'node:crypto'
import { ID_PATTERN, LIMITS, RESERVED_ROLE_KEYS, type CheckerRef, type NodeDef, type WorkflowConfig, type WorkflowDef } from '../types.ts'

export class CatalogValidationError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`workflow config invalid: ${problems.join('; ')}`)
    this.name = 'CatalogValidationError'
    this.problems = problems
  }
}

/** Builtin program ids known to this plugin version (design §10.1). */
export const BUILTIN_PROGRAM_IDS = new Set([
  'github.initialize-milestone',
  'github.all-milestone-issues-complete',
])

/** Builtin checker ids known to this plugin version (design §3). */
export const BUILTIN_CHECKER_IDS = new Set(['judge.goal-satisfied'])

function isEnd(target: string): boolean {
  return target === 'END'
}

function validNodeTarget(target: string, workflow: WorkflowDef): boolean {
  if (isEnd(target)) return true
  return Object.prototype.hasOwnProperty.call(workflow.nodes, target)
}

/** Normalize (trim persona/instruction/criteria) and deep-validate one config. */
export function validateAndNormalize(config: WorkflowConfig, extra?: { workflowId?: string }): WorkflowConfig {
  const problems: string[] = []
  const workflowId = extra?.workflowId

  if (workflowId !== undefined && !ID_PATTERN.test(workflowId)) {
    problems.push(`workflow id "${workflowId}" is not a valid lowercase [a-z][a-z0-9-]* id`)
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
  }

  // judge role
  config.judgeRole.persona = config.judgeRole.persona.trim()

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
        const checker = (node as Extract<NodeDef, { execution: { type: 'actor-task' } }>).checker
        validateChecker(label, checker, problems)
        validateTargets(label, node, def, problems)
      } else if (execution.type === 'builtin-program') {
        if (!BUILTIN_PROGRAM_IDS.has(execution.programId)) {
          problems.push(`${label} references unknown builtin program "${execution.programId}"`)
        }
        if (execution.instruction !== undefined) execution.instruction = execution.instruction.trim()
        validateTargets(label, node, def, problems)
      } else {
        // child-workflow
        if (!Object.prototype.hasOwnProperty.call(config.childWorkflows ?? {}, execution.workflowId)) {
          problems.push(`${label} references unknown child workflow "${execution.workflowId}"`)
        }
        if (execution.workflowId === rootName) {
          problems.push(`${label} cannot reference the root workflow as a child`)
        }
        if (!validNodeTarget(node.onPass, def)) {
          problems.push(`${label} onPass target "${node.onPass}" does not exist`)
        }
      }
    }
    // reachability: every node reachable from startNode
    const reachable = new Set<string>()
    const queue = [def.startNode]
    while (queue.length > 0) {
      const current = queue.shift()!
      if (reachable.has(current)) continue
      reachable.add(current)
      const n = def.nodes[current]
      if (n === undefined) continue
      if (n.onPass !== undefined && !isEnd(n.onPass) && Object.prototype.hasOwnProperty.call(def.nodes, n.onPass)) queue.push(n.onPass)
      if ('onFail' in n && n.onFail !== undefined && Object.prototype.hasOwnProperty.call(def.nodes, n.onFail)) queue.push(n.onFail)
    }
    for (const nodeId of Object.keys(def.nodes)) {
      if (!reachable.has(nodeId)) {
        problems.push(`workflow "${name}" node "${nodeId}" is not reachable from startNode`)
      }
    }
    // every workflow must have at least one reachable END path
    const seen = new Set<string>()
    const endReachable = hasEndPath(def, def.startNode, seen)
    if (!endReachable) {
      problems.push(`workflow "${name}" has no path from startNode to END`)
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
  if (checker.checkerId === 'judge.goal-satisfied') {
    const criteria = checker.config['criteria']
    if (typeof criteria !== 'string') {
      problems.push(`${label} checker config.criteria must be a non-empty string`)
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

function validateTargets(label: string, node: NodeDef, def: WorkflowDef, problems: string[]): void {
  if (!validNodeTarget(node.onPass, def)) {
    problems.push(`${label} onPass target "${node.onPass}" does not exist`)
  }
  if ('onFail' in node && node.onFail !== undefined) {
    if (isEnd(node.onFail)) {
      problems.push(`${label} onFail cannot target END (FAIL without onFail means BLOCK)`)
    } else if (!validNodeTarget(node.onFail, def)) {
      problems.push(`${label} onFail target "${node.onFail}" does not exist`)
    }
  }
}

function hasEndPath(def: WorkflowDef, nodeId: string, seen: Set<string>): boolean {
  if (seen.has(nodeId)) return false
  seen.add(nodeId)
  const node = def.nodes[nodeId]
  if (node === undefined) return false
  if (node.onPass === 'END') return true
  const next: string[] = []
  if (!isEnd(node.onPass)) next.push(node.onPass)
  if ('onFail' in node && node.onFail !== undefined && !isEnd(node.onFail)) next.push(node.onFail)
  return next.some(n => hasEndPath(def, n, seen))
}

/** Stable definition hash over the normalized snapshot (design §5). */
export function computeDefinitionHash(config: WorkflowConfig): string {
  const canonical = JSON.stringify(config)
  return createHash('sha256').update(canonical).digest('hex')
}
