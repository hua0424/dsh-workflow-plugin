/**
 * Workflow run trace log (PRD docs/prd/workflow-run-logging.md, R1/R4).
 *
 * Each run gets a UTF-8 text log beside the workflow's catalog config file:
 * `~/.dsh/workflows/<workflow-id>.yaml` → `~/.dsh/workflows/<workflow-id>/`
 * containing `yyyyMMdd-HHmmss-<runId前8位>.txt` files (local time).
 *
 * Everything here is best-effort: no function throws, failures return
 * `undefined` / no-op so logging can never break a workflow run.
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
 * Best-effort: swallows every error, never throws.
 */
export function appendLine(logPath: string, line: string, now: Date = new Date()): void {
  try {
    appendFileSync(logPath, `${lineTimestamp(now)} ${line}\n`, 'utf8')
  } catch {
    // best-effort logging must not affect the workflow
  }
}
