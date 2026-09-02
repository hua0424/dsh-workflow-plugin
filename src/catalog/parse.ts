/**
 * Restricted YAML 1.2 parsing for workflow catalog files (design §2.3 / §7 B1).
 *
 * Hard constraints enforced here:
 * - exactly one document
 * - duplicate keys rejected (uniqueKeys)
 * - anchors / aliases / merge keys rejected (AST walk)
 * - custom tags rejected (customTags: [] turns them into warnings; we also
 *   reject every explicit tag to keep the surface minimal)
 * - parse errors AND warnings reject the file
 *
 * Returns plain JSON (no Map/Date/exotic values survive YAML's own
 * materialization; we double-check with a lossless-JSON pass).
 */
import { parseAllDocuments, isAlias, isMap, isScalar, isSeq, isCollection, type Node } from 'yaml'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { WorkflowConfig } from '../types.ts'
import { parseWorkflowConfig } from './schema.ts'

export class CatalogParseError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`catalog parse rejected: ${problems.join('; ')}`)
    this.name = 'CatalogParseError'
    this.problems = problems
  }
}

/** Reject every explicit tag: minimal restricted surface, no semantic surprises. */
function checkTag(node: Node, problems: string[]): void {
  if (isCollection(node) || isScalar(node)) {
    if (node.tag !== undefined) {
      problems.push(`explicit YAML tag "${node.tag}" is forbidden`)
    }
  }
  if (node.anchor !== undefined) {
    problems.push('YAML anchors are forbidden')
  }
}

/** Recursively walk the CST rejecting anchors, aliases, merge keys, explicit tags. */
function walk(node: unknown, problems: string[]): void {
  if (node === null || node === undefined) return
  if (isAlias(node)) {
    problems.push('YAML aliases are forbidden')
    return
  }
  if (isScalar(node) || isCollection(node)) {
    checkTag(node, problems)
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      if (isScalar(pair.key) && pair.key.value === '<<') {
        problems.push('YAML merge keys ("<<") are forbidden')
      }
      walk(pair.key, problems)
      walk(pair.value, problems)
    }
  } else if (isSeq(node)) {
    for (const item of node.items) walk(item, problems)
  }
}

/**
 * Parse one catalog file's text into raw JSON.
 * @throws CatalogParseError with every collected problem.
 */
export function parseCatalogText(text: string): unknown {
  const problems: string[] = []
  let docs: ReturnType<typeof parseAllDocuments>
  try {
    docs = parseAllDocuments(text, { version: '1.2', uniqueKeys: true, customTags: [], prettyErrors: false })
  } catch (error) {
    throw new CatalogParseError([`YAML parse failed: ${String(error)}`])
  }
  if (docs.length === 0) {
    throw new CatalogParseError(['empty document'])
  }
  if (docs.length > 1) {
    throw new CatalogParseError(['exactly one YAML document is required'])
  }
  const doc = docs[0]!
  for (const error of doc.errors) problems.push(String(error))
  for (const warning of doc.warnings) problems.push(String(warning))
  if (doc.contents !== null) walk(doc.contents, problems)
  if (problems.length > 0) throw new CatalogParseError(problems)

  let raw: unknown
  try {
    raw = doc.toJS()
  } catch (error) {
    throw new CatalogParseError([`YAML materialization failed: ${String(error)}`])
  }
  // Lossless-JSON guarantee: no exotic prototypes, cycles, or non-finite numbers.
  const json = snapshotJsonValue(raw)
  if (json === undefined) {
    throw new CatalogParseError(['document is not lossless JSON (exotic value, cycle, or non-finite number)'])
  }
  return json
}

/** Entry point used by the catalog loader: parse + strict-schema validate. */
export function parseCatalogConfig(text: string): WorkflowConfig {
  const raw = parseCatalogText(text)
  return parseWorkflowConfig(raw)
}
