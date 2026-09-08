/** 三表唯一事实来源；短同步事务，不持有锁等待 Host。 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import { snapshotJsonValue, isJsonValue } from '@deepseek-ai/dsh-util-values'
import { CATALOG_DIR_NAME, STATE_DB_NAME, STATE_FORMAT_VERSION, type ExecutionChange, type NodeExecution, type NodeExecutionEvent, type RunState, type StateRow } from '../types.ts'
import { checkExecutionInvariants, checkStateInvariants } from './invariants.ts'

interface RunRow {
  sequence: number
  run_id: string
  workspace_key: string
  format_version: string
  state_version: number
  status: string
  current_execution_id: string
  snapshot_json: string
  updated_at: string
}
interface ExecutionRow {
  execution_id: string
  run_id: string
  visit: number
  revision: number
  snapshot_json: string
}
const EVENT_TYPES = ['entered', 'actor-arranged', 'claim', 'judge-arranged', 'judgment', 'exited', 'blocked', 'manager-context', 'resumed', 'judge-respawned'] as const
const CREATE_SQL = `
CREATE TABLE runs (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  workspace_key TEXT NOT NULL,
  format_version TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK(state_version > 0),
  status TEXT NOT NULL CHECK(status IN ('running', 'blocked', 'completed')),
  current_execution_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(run_id, current_execution_id) REFERENCES node_executions(run_id, execution_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE UNIQUE INDEX one_active_run_per_workspace ON runs(workspace_key) WHERE status IN ('running', 'blocked');
CREATE INDEX workspace_runs ON runs(workspace_key, sequence DESC);
CREATE TABLE node_executions (
  execution_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  visit INTEGER NOT NULL CHECK(visit > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  UNIQUE(run_id, execution_id),
  UNIQUE(run_id, visit)
) STRICT;
CREATE TABLE node_execution_events (
  execution_id TEXT NOT NULL REFERENCES node_executions(execution_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  type TEXT NOT NULL CHECK(type IN ('entered', 'actor-arranged', 'claim', 'judge-arranged', 'judgment', 'exited', 'blocked', 'manager-context', 'resumed', 'judge-respawned')),
  at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  PRIMARY KEY(execution_id, sequence)
) STRICT;
PRAGMA user_version = 6;
`

function json(value: unknown): string {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new Error('state is not lossless JSON')
  return JSON.stringify(snapshot)
}
function parse<T>(value: string): T {
  const parsed: unknown = JSON.parse(value)
  if (!isJsonValue(parsed) || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('corrupt state JSON')
  return parsed as T
}
function assertValid(problems: string[]): void {
  if (problems.length) throw new Error(`corrupt or invalid state: ${problems.join('; ')}`)
}

export function stateDbPath(home: string): string { return join(home, CATALOG_DIR_NAME, STATE_DB_NAME) }
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
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.assertNoLegacyRows()
      const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
      const names = tables.map(row => row.name).filter(name => name !== 'workflow_state')
      const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (names.length === 0 && version.user_version === 0) {
        this.db.exec('BEGIN IMMEDIATE')
        try { this.db.exec(CREATE_SQL); this.db.exec('COMMIT') } catch (error) { this.db.exec('ROLLBACK'); throw error }
      } else if (version.user_version !== 6 || names.length !== 3 || !['runs', 'node_executions', 'node_execution_events'].every(name => names.includes(name))) {
        throw new Error('incompatible state format; original data retained; authorized backup/reset required')
      }
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000')
      // Fail closed even for an empty database with an unrecognized table layout.
      this.db.prepare('SELECT sequence, run_id, workspace_key, format_version, state_version, status, current_execution_id, snapshot_json, updated_at FROM runs LIMIT 0').all()
      this.db.prepare('SELECT execution_id, run_id, visit, revision, snapshot_json FROM node_executions LIMIT 0').all()
      this.db.prepare('SELECT execution_id, sequence, type, at, snapshot_json FROM node_execution_events LIMIT 0').all()
      const incompatible = this.db.prepare('SELECT run_id FROM runs WHERE format_version <> ? LIMIT 1').get(STATE_FORMAT_VERSION)
      if (incompatible) throw new Error('incompatible state format; original data retained')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private assertNoLegacyRows(): void {
    if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_state'").get() && this.db.prepare('SELECT 1 FROM workflow_state LIMIT 1').get()) {
      throw new Error('incompatible legacy workflow_state contains data; original data retained; authorized backup/reset required')
    }
  }

  /** ponytail: one short connection queue; split by workspace only if contention warrants it. */
  private enqueue<T>(fn: () => T, write = false): Promise<T> {
    if (this.closed) return Promise.reject(new Error('state store is closed'))
    const next = this.queue.then(() => {
      if (this.closed) throw new Error('state store is closed')
      this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
      try {
        this.assertNoLegacyRows()
        const result = fn()
        this.db.exec('COMMIT')
        return result
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    })
    this.queue = next.catch(() => {})
    return next
  }

  private latest(workspaceKey: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE workspace_key = ? ORDER BY sequence DESC LIMIT 1').get(workspaceKey) as RunRow | undefined
  }

  private readExecution(run: RunState, executionId: string): NodeExecution | undefined {
    const row = this.db.prepare('SELECT * FROM node_executions WHERE run_id = ? AND execution_id = ?').get(run.runId, executionId) as ExecutionRow | undefined
    if (!row) return undefined
    const execution = parse<NodeExecution>(row.snapshot_json)
    assertValid(checkExecutionInvariants(run, execution))
    if (execution.executionId !== row.execution_id || execution.runId !== row.run_id || execution.visit !== row.visit || execution.revision !== row.revision) throw new Error('corrupt execution columns/snapshot mismatch')
    return execution
  }

  private decode(row: RunRow): StateRow {
    if (row.format_version !== STATE_FORMAT_VERSION) throw new Error('incompatible state format; original data retained')
    const run = parse<RunState>(row.snapshot_json)
    assertValid(checkStateInvariants(run))
    if (run.runId !== row.run_id || run.status !== row.status || run.currentExecutionId !== row.current_execution_id || !Number.isSafeInteger(row.state_version) || row.state_version < 1) throw new Error('corrupt run columns/snapshot mismatch')
    const execution = this.readExecution(run, run.currentExecutionId)
    if (!execution) throw new Error('corrupt run: current execution is missing')
    assertValid(checkStateInvariants(run, execution))
    return { workspaceKey: row.workspace_key, formatVersion: STATE_FORMAT_VERSION, stateVersion: row.state_version, run, execution, updatedAt: row.updated_at }
  }

  get(workspaceKey: string): Promise<StateRow | undefined> {
    return this.enqueue(() => { const row = this.latest(workspaceKey); return row ? this.decode(row) : undefined })
  }

  /** Each workspace's newest Run; completed history remains in runs. */
  list(): Promise<StateRow[]> {
    return this.enqueue(() => (this.db.prepare('SELECT * FROM runs WHERE sequence IN (SELECT MAX(sequence) FROM runs GROUP BY workspace_key) ORDER BY sequence').all() as unknown as RunRow[]).map(row => this.decode(row)))
  }

  execution(workspaceKey: string, executionId: string): Promise<NodeExecution | undefined> {
    return this.enqueue(() => {
      const row = this.latest(workspaceKey)
      if (!row) return undefined
      return this.readExecution(this.decode(row).run, executionId)
    })
  }

  /** Stable per-execution sequence, exclusive after; next cursor is last sequence. */
  events(workspaceKey: string, executionId: string, after = 0, limit = 50): Promise<NodeExecutionEvent[]> {
    return this.enqueue(() => {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('events requires after >= 0 and limit 1..50')
      const row = this.latest(workspaceKey)
      if (!row) throw new StateGoneError(workspaceKey)
      const run = this.decode(row).run
      const execution = this.readExecution(run, executionId)
      if (!execution) throw new Error('execution is not in the current run')
      const rows = this.db.prepare('SELECT * FROM node_execution_events WHERE execution_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(executionId, after, limit) as { execution_id: string; sequence: number; type: NodeExecutionEvent['type']; at: string; snapshot_json: string }[]
      return rows.map(event => {
        const snapshot = parse<NodeExecution>(event.snapshot_json)
        assertValid(checkExecutionInvariants(run, snapshot))
        if (snapshot.executionId !== executionId || snapshot.input !== execution.input || snapshot.visit !== execution.visit || snapshot.revision < 1 || snapshot.revision > execution.revision || !EVENT_TYPES.includes(event.type) || !Number.isSafeInteger(event.sequence) || event.sequence <= after) throw new Error('corrupt execution event snapshot')
        return { executionId, sequence: event.sequence, type: event.type, at: event.at, snapshot }
      })
    })
  }

  createRow(workspaceKey: string, run: RunState, execution: NodeExecution): Promise<StateRow> {
    // Detach before queueing: caller mutations cannot change pending transaction inputs.
    const savedRun = parse<RunState>(json(run))
    const savedExecution = parse<NodeExecution>(json(execution))
    return this.enqueue(() => {
      if (!workspaceKey.trim()) throw new Error('workspace key is required')
      const existing = this.latest(workspaceKey)
      if (existing) {
        const current = this.decode(existing)
        if (current.run.status !== 'completed') throw new StateConflictError(workspaceKey, current.run.status)
      }
      assertValid(checkStateInvariants(savedRun, savedExecution))
      if (savedExecution.revision !== 0 || savedExecution.phase !== 'ready' || savedExecution.predecessorId || savedRun.status !== 'running') throw new Error('new run requires a ready revision-0 initial execution')
      const at = new Date().toISOString()
      this.db.prepare('INSERT INTO runs (run_id, workspace_key, format_version, state_version, status, current_execution_id, snapshot_json, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)').run(savedRun.runId, workspaceKey, STATE_FORMAT_VERSION, savedRun.status, savedRun.currentExecutionId, json(savedRun), at)
      this.writeExecution(savedRun, { execution: savedExecution, expectedRevision: null, events: ['entered'] }, at)
      return this.decode(this.latest(workspaceKey)!)
    }, true)
  }

  updateRow(workspaceKey: string, run: RunState, expectedVersion: number, changes: ExecutionChange[]): Promise<StateRow> {
    const savedRun = parse<RunState>(json(run))
    const savedChanges = JSON.parse(json(changes)) as ExecutionChange[]
    return this.enqueue(() => {
      const row = this.latest(workspaceKey)
      if (!row) throw new StateGoneError(workspaceKey)
      const current = this.decode(row)
      if (row.state_version !== expectedVersion) throw new StateVersionError(workspaceKey, row.state_version, expectedVersion)
      if (current.run.status === 'completed') throw new Error('completed run is immutable')
      for (const key of ['runId', 'managerSessionId', 'catalogWorkflowId', 'definitionHash', 'definitionSnapshot'] as const) {
        if (!isDeepStrictEqual(current.run[key], savedRun[key])) throw new Error(`${key} is immutable`)
      }
      assertValid(checkStateInvariants(savedRun))
      if (new Set(savedChanges.map(change => change.execution.executionId)).size !== savedChanges.length) throw new Error('duplicate execution change')
      const at = new Date().toISOString()
      for (const change of savedChanges) this.writeExecution(savedRun, change, at)
      const execution = this.readExecution(savedRun, savedRun.currentExecutionId)
      if (!execution) throw new Error('current execution is missing')
      assertValid(checkStateInvariants(savedRun, execution))
      const result = this.db.prepare('UPDATE runs SET state_version = state_version + 1, status = ?, current_execution_id = ?, snapshot_json = ?, updated_at = ? WHERE run_id = ? AND state_version = ?').run(savedRun.status, savedRun.currentExecutionId, json(savedRun), at, savedRun.runId, expectedVersion)
      if (result.changes !== 1) throw new StateVersionError(workspaceKey, row.state_version, expectedVersion)
      return this.decode(this.latest(workspaceKey)!)
    }, true)
  }

  private writeExecution(run: RunState, change: ExecutionChange, at: string): void {
    const { execution, expectedRevision, events } = change
    assertValid(checkExecutionInvariants(run, execution))
    if (!Array.isArray(events) || events.some(type => !EVENT_TYPES.includes(type))) throw new Error('invalid execution events')
    const existing = this.readExecution(run, execution.executionId)
    if (expectedRevision === null) {
      if (existing || execution.revision !== 0 || !events.includes('entered')) throw new Error('new execution requires revision 0 and entered event')
    } else {
      if (!Number.isSafeInteger(expectedRevision) || !existing || existing.revision !== expectedRevision || execution.revision !== expectedRevision) throw new StateVersionError(execution.executionId, existing?.revision ?? 0, expectedRevision)
      if (existing.phase === 'exited') {
        // 离开后只允许真实 Judge 收口回执；不重开或改写终局材料。
        const settled = structuredClone(existing)
        if (settled.judge) settled.judge.settled = true
        if (!isDeepStrictEqual(settled, execution) || events.length) throw new Error('exited execution materials are immutable')
      }
      for (const key of ['executionId', 'runId', 'workflowId', 'nodeId', 'visit', 'input', 'enteredAt', 'predecessorId'] as const) {
        if (!isDeepStrictEqual(existing[key], execution[key])) throw new Error(`execution ${key} is immutable`)
      }
      if (events.includes('entered')) throw new Error('entered event is only valid for new execution')
    }
    const saved = { ...execution, revision: (expectedRevision ?? 0) + 1 }
    if (expectedRevision === null) {
      this.db.prepare('INSERT INTO node_executions (execution_id, run_id, visit, revision, snapshot_json) VALUES (?, ?, ?, ?, ?)').run(saved.executionId, saved.runId, saved.visit, saved.revision, json(saved))
    } else {
      const result = this.db.prepare('UPDATE node_executions SET revision = ?, snapshot_json = ? WHERE execution_id = ? AND run_id = ? AND revision = ?').run(saved.revision, json(saved), saved.executionId, saved.runId, expectedRevision)
      if (result.changes !== 1) throw new StateVersionError(saved.executionId, existing!.revision, expectedRevision)
    }
    const last = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM node_execution_events WHERE execution_id = ?').get(saved.executionId) as { sequence: number }
    let sequence = last.sequence
    for (const type of events) this.db.prepare('INSERT INTO node_execution_events (execution_id, sequence, type, at, snapshot_json) VALUES (?, ?, ?, ?, ?)').run(saved.executionId, ++sequence, type, at, json(saved))
  }

  deleteRow(_workspaceKey: string): Promise<void> { return Promise.reject(new Error('T8 reset not connected; original data retained')) }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
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
  constructor(workspaceKey: string) { super(`no state row for ${workspaceKey}`); this.name = 'StateGoneError' }
}
