// 只读检查真实 home 的 workflow 状态库：表结构与既有 run 行的 schemaVersion/status
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('C:/Users/hua/.dsh/workflows/state.sqlite3')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name)
console.log('tables:', tables.join(', '))
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
  console.log(`table ${t}: cols = ${cols.join(', ')}`)
}
const runTable = tables.find((t) => /run|state/i.test(t))
if (runTable) {
  const rows = db.prepare(`SELECT * FROM ${runTable}`).all()
  console.log(`rows in ${runTable}: ${rows.length}`)
  for (const r of rows) {
    const key = r.workspace_key ?? '?'
    let info = ''
    try {
      const run = JSON.parse(r.snapshot_json ?? '{}').run ?? {}
      info = `schema=${run.schemaVersion ?? 'n/a'} status=${run.status ?? 'n/a'} workflow=${run.workflowId ?? 'n/a'} callStack=${Array.isArray(run.callStack) ? run.callStack.length : '?'}`
      console.log('   snapshot keys:', Object.keys(run).join(', '))
    } catch { info = '(unparseable)' }
    console.log(' -', String(key).slice(0, 60), '|', info)
  }
}
db.close()
