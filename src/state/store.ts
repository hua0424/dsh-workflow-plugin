/**
 * Minimal SQLite state store (design §5 C1-C4).
 * One DatabaseSync connection, one short mutation queue, STRICT table keyed by
 * the canonical workspace realpath. All mutations serialize through `enqueue`.
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { snapshotJsonValue, isJsonValue } from '@deepseek-ai/dsh-session'
import { CATALOG_DIR_NAME, STATE_DB_NAME, STATE_FORMAT_VERSION, STATE_TABLE_NAME, type RunState, type StateRow } from '../types.ts'

interface RowShape {
  workspace_key: string
  format_version: string
  state_version: number
  snapshot_json: string
  updated_at: string
}

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS ${STATE_TABLE_NAME} (
  workspace_key  TEXT PRIMARY KEY,
  format_version TEXT    NOT NULL,
  state_version  INTEGER NOT NULL,
  snapshot_json  TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT
`

/** Absolute path of the state database under the harness home. */
export function stateDbPath(home: string): string {
  return join(home, CATALOG_DIR_NAME, STATE_DB_NAME)
}

/** Canonical workspace key from the session cwd (design §5). */
export async function workspaceKeyOf(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd.trim() === '') return undefined
  const { realpath } = await import('node:fs/promises')
  return realpath(cwd)
}

export class StateStore {
  private db: DatabaseSync
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(home: string) {
    const path = stateDbPath(home)
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(CREATE_SQL)
  }

  /** Serialize one synchronous mutation. */
  private enqueue<T>(fn: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error('state store is closed'))
    const next = this.queue.then(() => fn())
    this.queue = next.catch(() => {})
    return next
  }

  /** Read one row by workspace key. */
  get(workspaceKey: string): Promise<StateRow | undefined> {
    return this.enqueue(() => {
      const row = this.db.prepare(`SELECT * FROM ${STATE_TABLE_NAME} WHERE workspace_key = ?`).get(workspaceKey) as RowShape | undefined
      if (row === undefined) return undefined
      const parsed: unknown = JSON.parse(row.snapshot_json)
      if (!isJsonValue(parsed) || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`state row for ${workspaceKey} is corrupt`)
      }
      return {
        workspaceKey: row.workspace_key,
        formatVersion: row.format_version as typeof STATE_FORMAT_VERSION,
        stateVersion: row.state_version,
        run: (parsed as { run: RunState }).run,
        updatedAt: row.updated_at,
      }
    })
  }

  /** All rows (status/reset diagnostics). */
  list(): Promise<StateRow[]> {
    return this.enqueue(() => {
      const rows = this.db.prepare(`SELECT * FROM ${STATE_TABLE_NAME}`).all() as unknown as RowShape[]
      return rows.map(row => {
        const parsed = JSON.parse(row.snapshot_json) as { run: RunState }
        return {
          workspaceKey: row.workspace_key,
          formatVersion: row.format_version as typeof STATE_FORMAT_VERSION,
          stateVersion: row.state_version,
          run: parsed.run,
          updatedAt: row.updated_at,
        }
      })
    })
  }

  /**
   * Insert a fresh row (start). Fails when the key already exists and its run
   * is not completed (design A2).
   */
  createRow(workspaceKey: string, run: RunState): Promise<StateRow> {
    return this.enqueue(() => {
      const existing = this.db.prepare(`SELECT * FROM ${STATE_TABLE_NAME} WHERE workspace_key = ?`).get(workspaceKey) as RowShape | undefined
      if (existing !== undefined) {
        const parsed = JSON.parse(existing.snapshot_json) as { run: RunState }
        if (parsed.run.status !== 'completed') {
          throw new StateConflictError(workspaceKey, parsed.run.status)
        }
      }
      return this.writeRow(workspaceKey, run, existing?.state_version ?? 0)
    })
  }

  /**
   * Overwrite an existing row with the next state version. The caller must
   * pass the expected current stateVersion; mismatch throws (stale writer).
   */
  updateRow(workspaceKey: string, run: RunState, expectedVersion: number): Promise<StateRow> {
    return this.enqueue(() => {
      const existing = this.db.prepare(`SELECT * FROM ${STATE_TABLE_NAME} WHERE workspace_key = ?`).get(workspaceKey) as RowShape | undefined
      if (existing === undefined) throw new StateGoneError(workspaceKey)
      if (existing.state_version !== expectedVersion) {
        throw new StateVersionError(workspaceKey, existing.state_version, expectedVersion)
      }
      return this.writeRow(workspaceKey, run, existing.state_version)
    })
  }

  /** Delete one row (reset). Idempotent. */
  deleteRow(workspaceKey: string): Promise<void> {
    return this.enqueue(() => {
      this.db.prepare(`DELETE FROM ${STATE_TABLE_NAME} WHERE workspace_key = ?`).run(workspaceKey)
    })
  }

  private writeRow(workspaceKey: string, run: RunState, previousVersion: number): StateRow {
    const snapshot = snapshotJsonValue({ run })
    if (snapshot === undefined) throw new Error('run state is not lossless JSON')
    const nextVersion = previousVersion + 1
    const updatedAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO ${STATE_TABLE_NAME} (workspace_key, format_version, state_version, snapshot_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        format_version = excluded.format_version,
        state_version = excluded.state_version,
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
    `).run(workspaceKey, STATE_FORMAT_VERSION, nextVersion, JSON.stringify(snapshot), updatedAt)
    return {
      workspaceKey,
      formatVersion: STATE_FORMAT_VERSION,
      stateVersion: nextVersion,
      run,
      updatedAt,
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

export class StateConflictError extends Error {
  readonly status: string
  constructor(workspaceKey: string, status: string) {
    super(`workspace already has a ${status} run (key: ${workspaceKey})`)
    this.name = 'StateConflictError'
    this.status = status
  }
}

export class StateVersionError extends Error {
  constructor(workspaceKey: string, actual: number, expected: number) {
    super(`state version mismatch for ${workspaceKey}: actual ${actual}, expected ${expected}`)
    this.name = 'StateVersionError'
  }
}

export class StateGoneError extends Error {
  constructor(workspaceKey: string) {
    super(`no state row for ${workspaceKey}`)
    this.name = 'StateGoneError'
  }
}
