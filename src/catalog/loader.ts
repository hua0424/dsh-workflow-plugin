/**
 * Catalog directory scanning (design §2.3 A1/A2).
 * Fresh, non-recursive scan of `${DSH_HOME}/workflows`; only regular lowercase
 * `[a-z][a-z0-9-]*.yaml` files are candidates. Symlinks/junctions and `.yml`
 * are rejected or ignored per filename class.
 */
import { readdir, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { CATALOG_DIR_NAME, ID_PATTERN, type WorkflowConfig } from '../types.ts'
import { parseCatalogConfig } from './parse.ts'
import { validateAndNormalize, computeDefinitionHash } from './validate.ts'

export interface CatalogEntry {
  workflowId: string
  path: string
  config: WorkflowConfig
  definitionHash: string
}

export interface CatalogDiagnostic {
  workflowId: string | null
  path: string
  reason: string
}

export interface CatalogScan {
  entries: CatalogEntry[]
  diagnostics: CatalogDiagnostic[]
}

/** Filename → (kind, workflowId | null). */
export function classifyCatalogFilename(name: string): { kind: 'candidate' | 'ignored'; workflowId: string | null; reason?: string } {
  if (name.endsWith('.yml')) {
    return { kind: 'ignored', workflowId: null, reason: 'only .yaml is accepted' }
  }
  if (!name.endsWith('.yaml')) return { kind: 'ignored', workflowId: null, reason: 'not a .yaml file' }
  const stem = name.slice(0, -'.yaml'.length)
  if (!ID_PATTERN.test(stem)) {
    return { kind: 'ignored', workflowId: null, reason: `filename stem "${stem}" is not a valid lowercase [a-z][a-z0-9-]* workflow id` }
  }
  return { kind: 'candidate', workflowId: stem }
}

/** Directory of the workflow catalog under the resolved harness home. */
export function catalogDir(home: string): string {
  return join(home, CATALOG_DIR_NAME)
}

/**
 * Scan the catalog directory once, fresh. Invalid files only block themselves
 * and surface as diagnostics; other workflows stay usable.
 */
export async function scanCatalog(home: string): Promise<CatalogScan> {
  const dir = catalogDir(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return { entries: [], diagnostics: [] }
    throw error
  }
  const entries: CatalogEntry[] = []
  const diagnostics: CatalogDiagnostic[] = []
  for (const name of names) {
    const classified = classifyCatalogFilename(name)
    if (classified.kind !== 'candidate') continue
    const path = join(dir, name)
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        diagnostics.push({ workflowId: classified.workflowId, path, reason: 'symlinks are not accepted' })
        continue
      }
      if (!stat.isFile()) {
        diagnostics.push({ workflowId: classified.workflowId, path, reason: 'not a regular file' })
        continue
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') continue // vanished between readdir and lstat
      diagnostics.push({ workflowId: classified.workflowId, path, reason: `cannot stat: ${String(error)}` })
      continue
    }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      diagnostics.push({ workflowId: classified.workflowId, path, reason: `cannot read: ${String(error)}` })
      continue
    }
    try {
      const parsed = parseCatalogConfig(text)
      const normalized = validateAndNormalize(parsed, { workflowId: classified.workflowId! })
      entries.push({
        workflowId: classified.workflowId!,
        path,
        config: normalized,
        definitionHash: computeDefinitionHash(normalized),
      })
    } catch (error) {
      diagnostics.push({ workflowId: classified.workflowId, path, reason: String(error) })
    }
  }
  entries.sort((a, b) => a.workflowId.localeCompare(b.workflowId))
  diagnostics.sort((a, b) => (a.workflowId ?? '').localeCompare(b.workflowId ?? ''))
  return { entries, diagnostics }
}

/** Load exactly one workflow by id; returns undefined when absent. */
export async function loadCatalogEntry(home: string, workflowId: string): Promise<CatalogEntry | undefined> {
  if (!ID_PATTERN.test(workflowId)) return undefined
  const scan = await scanCatalog(home)
  return scan.entries.find(entry => entry.workflowId === workflowId)
}
