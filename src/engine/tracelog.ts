/**
 * Workflow run trace log (PRD docs/prd/workflow-run-logging.md, R1/R4;
 * A3 docs/prd/20260903-workflow-hardening/a3-workflow-trace-observability.md).
 *
 * Each run gets a UTF-8 text log beside the workflow's catalog config file:
 * `~/.dsh/workflows/<workflow-id>.yaml` → `~/.dsh/workflows/<workflow-id>/`
 * containing `yyyyMMdd-HHmmss-<runId前8位>.txt` files (local time).
 *
 * Event line format (A3 §3, `fmt=2`, announced on the START line): a single
 * line of space-separated `key=value` tokens. Identifier values (ids, enum
 * names) are written raw; free-text values are JSON-string escaped so the
 * one-event-per-line invariant survives newlines/quotes/backslashes and stays
 * machine-parseable.
 *
 * Everything here is best-effort: no function throws, failures return
 * `undefined` / no-op / `false` so logging can never break a workflow run.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local-time filename timestamp: `yyyyMMdd-HHmmss`. */
function fileTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  )
}

/** Local-time per-line timestamp prefix: `[YYYY-MM-DD HH:mm:ss]`. */
export function lineTimestamp(now: Date = new Date()): string {
  return (
    `[${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}]`
  )
}

/**
 * Directory that holds all run logs of one workflow: same directory as the
 * catalog config file, named after the config file stem (`.yaml` stripped).
 */
export function runLogDir(configPath: string): string {
  const stem = basename(configPath).replace(/\.yaml$/, '')
  return join(dirname(configPath), stem)
}

/**
 * Create the log directory (if missing) and an empty log file for a run.
 * Returns the absolute log file path, or `undefined` on any failure —
 * never throws (R4 failure tolerance).
 */
export function createRunLog(
  configPath: string,
  workflowId: string,
  runId: string,
  now: Date = new Date(),
): string | undefined {
  try {
    const dir = runLogDir(configPath)
    mkdirSync(dir, { recursive: true })
    const logPath = join(dir, `${fileTimestamp(now)}-${runId.slice(0, 8)}.txt`)
    writeFileSync(logPath, '', { encoding: 'utf8', flag: 'wx' })
    return logPath
  } catch {
    return undefined
  }
}

/**
 * Append one timestamped line (`[YYYY-MM-DD HH:mm:ss] <line>`) to a log file.
 * Best-effort: swallows every error, never throws. Returns whether the line
 * was written (A3 §10: the caller may warn ONCE on the first failure).
 */
export function appendLine(logPath: string, line: string, now: Date = new Date()): boolean {
  try {
    appendFileSync(logPath, `${lineTimestamp(now)} ${line}\n`, 'utf8')
    return true
  } catch {
    // best-effort logging must not affect the workflow
    return false
  }
}

// ---- A3 §3/§4 event-line format helpers (fmt=2) ----

/** Short stable prefix of an id (nodeToken / session id) for trace lines. */
export function shortId(id: string): string {
  return id.slice(0, 8)
}

/** A3 §4: clamp free text to its protocol bound, marking truncation. */
export function bounded(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

/**
 * Free-text field value: JSON-string escaped (newlines/quotes stay on one
 * line and reversible) and bounded to the field's protocol max. `null` /
 * `undefined` render as the JSON `null` literal.
 */
export function jsonField(text: string | null | undefined, max: number): string {
  if (text === null || text === undefined) return 'null'
  return JSON.stringify(bounded(text, max))
}

/** A raw (identifier-like) field value; whitespace forces JSON quoting. */
function rawField(value: string | number | boolean): string {
  const text = String(value)
  // Values pre-escaped by `jsonField` (free text) always start with a quote;
  // pass them through untouched. Raw identifiers never start with a quote.
  if (text.startsWith('"')) return text
  // Identifiers never contain whitespace; if unexpected data does, keep the
  // line single-line by falling back to JSON quoting.
  if (/[\s"\\]/.test(text)) return JSON.stringify(text)
  return text
}

/**
 * Build one fmt=2 event line: `EVENT k=v k=v …` in field insertion order.
 * - `undefined` fields are omitted entirely;
 * - `null` renders as `null`;
 * - free-text fields must be pre-escaped via `jsonField`.
 */
export function traceEvent(event: string, fields: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${value === null ? 'null' : rawField(value)}`)
  }
  return parts.join(' ')
}
