import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'

// #191 T4：0.1.5 写下的存量会话（FORMAT V3）在 0.2.0（V4）下仍可冷读。
// V3 物理形状（header version:3 + turn/start,user/message,turn/end 行）取自宿主
// session-persistence-jsonl 自带的 v3-restart 夹具；FORMAT 迁移由宿主承担，
// 插件侧只验证外部行为：只读 open 解码出当前事件，且 V3 源字节不被改写（单向门）。
test('FORMAT V3 存量日志经只读 open 冷读为当前事件且源字节不变', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-v3-cold-read-'))
  const id = SessionId('v3-cold-read')
  const dir = join(root, '_no-cwd', 'v3-cold-read')
  mkdirSync(dir, { recursive: true })
  const message = {
    id: 'm1', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'V3-COLD-READ-MARKER' }],
  }
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: message, surfaceOp: 'append' },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ].map((event, seq) => ({ ...event, seq, time: seq + 10 }))
  const path = join(dir, 'session.v3.jsonl')
  const header = { type: 'session', version: 3, id: 'v3-cold-read', createdAt: 1, isSeeded: false, delegationDepth: 0 }
  writeFileSync(path, `${JSON.stringify(header)}\n${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
  const before = readFileSync(path)

  const ctx = new Context()
  let after: Buffer
  try {
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await ctx.sessionPersistence.open(id, 'read')
    try {
      assert.equal(handle.header.version, 4, 'V3 存量应以迁移后的 V4 视图呈现')
      const { events } = await handle.read(0)
      assert.deepEqual(events.map(event => event.type), ['turn/start', 'user/message', 'turn/end'])
      assert.match(JSON.stringify(events), /V3-COLD-READ-MARKER/, '存量消息正文冷读后仍在')
    } finally {
      await handle.close()
    }
    after = readFileSync(path)
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
  assert.deepEqual(after!, before, '只读冷读不得发布升级：V3 源字节不变（单向门）')
})
