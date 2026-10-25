// #252 运行监控只读布局读取：与编辑器共用 `<catalogDir>/<id>/<id>.layout.json`，
// 监控只读消费；缺失 → undefined（客户端网格补位），损坏 → 空布局，绝不改写文件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRunLayout } from '../src/monitor/layout.ts'

test('#252 readRunLayout：读取布局、缺失/损坏回退、绝不改写', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workflow-252-layout-'))
  try {
    assert.equal(await readRunLayout(home, 'demo'), undefined)
    const workflowDir = join(home, 'workflows', 'demo')
    mkdirSync(workflowDir, { recursive: true })
    const file = join(workflowDir, 'demo.layout.json')
    const text = JSON.stringify({ version: 1, main: { plan: { x: 12, y: 34 } }, children: { sub: { s1: { x: 5, y: 6 } } } })
    writeFileSync(file, text)
    assert.deepEqual(await readRunLayout(home, 'demo'), { version: 1, main: { plan: { x: 12, y: 34 } }, children: { sub: { s1: { x: 5, y: 6 } } } })
    assert.equal(readFileSync(file, 'utf8'), text, '只读读取不改写布局文件')
    writeFileSync(file, '{not json')
    assert.deepEqual(await readRunLayout(home, 'demo'), { version: 1, main: {}, children: {} })
  } finally { rmSync(home, { recursive: true, force: true }) }
})
