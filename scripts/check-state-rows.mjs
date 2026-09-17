/**
 * 只读诊断工具：读取**显式给定**的 Workflow State DB，报告表结构、格式版本与既有 Run 行。
 *
 * 用法：
 *   node scripts/check-state-rows.mjs <state.sqlite3 的路径>
 *   node scripts/check-state-rows.mjs <path> --json      # 机器可读
 *
 * 边界（Issue #101 AC3）：
 * - 真实 home **不是**默认目标：必须显式给出路径，缺参数只打印用法并以 2 退出，绝不
 *   回退到 `~/.dsh/workflows/state.sqlite3`。
 * - 零副作用：先复制成临时快照（含可能存在的 `-wal`）再以 `readOnly: true` 打开副本，
 *   被诊断的库不被创建、改写，也不在它旁边生成 WAL/shm 索引；缺文件按 `missing`
 *   诊断返回，不是"空库"。
 * - 格式识别：只把 `user_version=10` 且恰好三表（runs / node_executions /
 *   node_execution_events）识别为当前格式；旧单表 `workflow_state`、其它未知布局、
 *   坏库分别给出明确诊断，**不**把它们读成空结果。
 *
 * 退出码：0 = 当前 v10 格式；1 = 有诊断（missing/legacy/unknown/corrupt）；2 = 用法错误。
 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 当前 State 格式的权威常量，与 `src/types.ts` 的 `STATE_FORMAT_VERSION` /
 * `STATE_USER_VERSION` 一致（本脚本是 .mjs，无法直接导入 TS 源码；改格式时两处同步）。
 */
export const CURRENT_STATE_USER_VERSION = 10
export const CURRENT_STATE_FORMAT_VERSION = 'agent-workflow-state/v10'
export const CURRENT_STATE_TABLES = ['node_execution_events', 'node_executions', 'runs']

const message = error => (error instanceof Error ? error.message : String(error))
function parseJson(text) {
  try { return { value: JSON.parse(text) } } catch (error) { return { problem: `snapshot_json 无法解析：${message(error)}` } }
}

/**
 * 只读检查一个 State DB 路径。返回 kind：`current` | `legacy` | `unknown` | `corrupt` | `missing`。
 * 在临时副本上诊断：目标库的字节与所在目录都不被改动，`missing` 也不创建库。
 *
 * ponytail: 快照 = 整库复制（状态库是 MB 级）。若将来出现超大库，再换 SQLite immutable
 * 只读 URI 或流式分块读，不必先为此建抽象。
 */
export function inspectStateDb(dbPath) {
  if (!existsSync(dbPath)) return { kind: 'missing', path: dbPath, detail: '文件不存在（诊断不创建库，也不回退到真实 home）' }
  const scratch = mkdtempSync(join(tmpdir(), 'wf-state-diag-'))
  const copy = join(scratch, 'state.sqlite3')
  let db
  try {
    copyFileSync(dbPath, copy)
    const wal = `${dbPath}-wal`
    if (existsSync(wal)) copyFileSync(wal, `${copy}-wal`)
    db = new DatabaseSync(copy, { readOnly: true })
  } catch (error) {
    db?.close()
    rmSync(scratch, { recursive: true, force: true })
    return { kind: 'corrupt', path: dbPath, detail: `无法以只读方式打开快照副本：${message(error)}` }
  }
  try {
    const userVersion = db.prepare('PRAGMA user_version').get().user_version
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
    if (tables.includes('workflow_state')) {
      let rows = 0
      try { rows = db.prepare('SELECT count(*) AS n FROM workflow_state').get().n } catch { rows = -1 }
      return {
        kind: 'legacy', path: dbPath, userVersion, tables, rows,
        detail: `旧单表格式（workflow_state，${rows < 0 ? '行数不可读' : `${rows} 行`}）：当前 Runtime fail-closed 拒绝读取；`
          + '续跑无关时由 root 会话执行 `/dsh-flow reset --incompatible-store` 备份退出',
      }
    }
    if (userVersion !== CURRENT_STATE_USER_VERSION || tables.join() !== CURRENT_STATE_TABLES.join()) {
      return {
        kind: 'unknown', path: dbPath, userVersion, tables,
        detail: `未识别的 State 格式（user_version=${userVersion}，表=[${tables.join(', ')}]）：`
          + `当前格式要求 user_version=${CURRENT_STATE_USER_VERSION} 且恰好三表 [${CURRENT_STATE_TABLES.join(', ')}]；不做猜测、不迁移`,
      }
    }
    const rows = db.prepare('SELECT run_id, workspace_key, format_version, state_version, status, current_execution_id, snapshot_json, updated_at FROM runs ORDER BY sequence DESC').all()
    return {
      kind: 'current', path: dbPath, userVersion, tables,
      runs: rows.map(row => {
        const parsed = parseJson(row.snapshot_json)
        const run = parsed.value === undefined ? undefined : parsed.value
        return {
          runId: row.run_id, workspaceKey: row.workspace_key, formatVersion: row.format_version,
          stateVersion: row.state_version, status: row.status, currentExecutionId: row.current_execution_id,
          updatedAt: row.updated_at,
          workflowId: run?.catalogWorkflowId, callStack: Array.isArray(run?.callStack) ? run.callStack.length : undefined,
          managerSessionId: run?.managerSessionId,
          problem: parsed.problem ?? (row.format_version === CURRENT_STATE_FORMAT_VERSION ? undefined : `format_version=${row.format_version} 与当前格式不一致`),
        }
      }),
    }
  } catch (error) {
    return { kind: 'corrupt', path: dbPath, detail: `库不可读：${message(error)}（原始库字节与目录原样保留，未被诊断改写）` }
  } finally {
    db.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

const USAGE = '用法：node scripts/check-state-rows.mjs <state.sqlite3 的路径> [--json]\n'
  + '只读诊断；真实 home 不是默认目标，必须显式给出路径。'

/** 解析 CLI 参数：只接受显式路径（可选 `--json`）。缺路径时返回 error，不回退到真实 home。 */
export function parseDiagnosticArgs(argv) {
  const target = argv.find(arg => !arg.startsWith('--'))
  return { target, json: argv.includes('--json'), error: target === undefined ? USAGE : undefined }
}

function printReport(report) {
  console.log(`path: ${report.path}`)
  console.log(`kind: ${report.kind}`)
  if (report.userVersion !== undefined) console.log(`user_version: ${report.userVersion}`)
  if (report.tables !== undefined) console.log(`tables: ${report.tables.join(', ') || '(none)'}`)
  if (report.kind === 'current') {
    console.log(`current-format runs: ${report.runs.length}`)
    for (const run of report.runs) {
      console.log(` - run=${run.runId} status=${run.status} workflow=${run.workflowId ?? 'n/a'}`
        + ` workspace=${String(run.workspaceKey).slice(0, 60)} stateVersion=${run.stateVersion} currentExecution=${run.currentExecutionId}`
        + ` callStack=${run.callStack ?? '?'} manager=${run.managerSessionId ?? 'n/a'} updatedAt=${run.updatedAt}`)
      if (run.problem) console.log(`   诊断: ${run.problem}`)
    }
    return
  }
  console.log(`诊断: ${report.detail}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { target, json, error } = parseDiagnosticArgs(process.argv.slice(2))
  if (error !== undefined) {
    console.error(error)
    process.exit(2)
  }
  const report = inspectStateDb(target)
  if (json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  process.exit(report.kind === 'current' ? 0 : 1)
}
