#!/usr/bin/env node
/**
 * Validate one workflow catalog YAML with the plugin's own restricted parser,
 * strict schema and static validation (schema/static review per PRD A2 §11).
 *
 * Usage: node scripts/validate-catalog.mjs <path-to-yaml> [workflowId]
 */
import { readFileSync } from 'node:fs'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash } from '../src/catalog/validate.ts'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scripts/validate-catalog.mjs <path-to-yaml> [workflowId]')
  process.exit(2)
}
const workflowId = process.argv[3] ?? 'milestone-delivery'

try {
  const text = readFileSync(file, 'utf8')
  const parsed = parseCatalogConfig(text)
  const normalized = validateAndNormalize(structuredClone(parsed), { workflowId })
  const hash = computeDefinitionHash(normalized)
  const root = normalized.workflow
  const countNodes = def => Object.keys(def.nodes).length
  console.log(`OK ${file}`)
  console.log(`workflowId=${workflowId} definitionHash=${hash}`)
  console.log(`root: startNode=${root.startNode}, ${countNodes(root)} nodes`)
  for (const [id, def] of Object.entries(normalized.childWorkflows ?? {})) {
    console.log(`child ${id}: startNode=${def.startNode}, ${countNodes(def)} nodes`)
  }
} catch (error) {
  console.error(`INVALID ${file}: ${String(error)}`)
  process.exit(1)
}
