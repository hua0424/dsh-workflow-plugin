import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog, appendLine, lineTimestamp, runLogDir } from '../src/engine/tracelog.ts'

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tracelog-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('runLogDir: config path stem becomes sibling directory', () => {
  assert.equal(runLogDir('/home/u/.dsh/workflows/smoke-test.yaml'), join('/home/u/.dsh/workflows', 'smoke-test'))
  assert.equal(runLogDir(join('workflows', 'my-flow.yaml')), join('workflows', 'my-flow'))
})

test('lineTimestamp: [YYYY-MM-DD HH:mm:ss] local-time format', () => {
  const ts = lineTimestamp(new Date(2026, 0, 3, 14, 15, 7))
  assert.equal(ts, '[2026-01-03 14:15:07]')
  assert.match(lineTimestamp(), /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/)
})

test('createRunLog: creates sibling directory and yyyyMMdd-HHmmss-<runId8>.txt file', () => {
  withTempDir((tmp) => {
    const configPath = join(tmp, 'smoke-test.yaml')
    writeFileSync(configPath, 'schemaVersion: agent-workflow/v1\n')
    const logPath = createRunLog(configPath, 'smoke-test', '9e473ab5-1234-5678-9abc-def012345678', new Date(2026, 0, 3, 14, 15, 22))
    assert.ok(logPath !== undefined)
    assert.equal(logPath, join(tmp, 'smoke-test', '20260103-141522-9e473ab5.txt'))
    assert.ok(existsSync(logPath))
    // runId shorter than 8 chars is used as-is
    const short = createRunLog(configPath, 'smoke-test', 'abc', new Date(2026, 0, 3, 14, 15, 23))
    assert.ok(short !== undefined && short.endsWith('-abc.txt'))
  })
})

test('appendLine: appends timestamped lines, accumulating content', () => {
  withTempDir((tmp) => {
    const configPath = join(tmp, 'smoke-test.yaml')
    writeFileSync(configPath, '')
    const logPath = createRunLog(configPath, 'smoke-test', '9e473ab5-0000')
    assert.ok(logPath !== undefined)
    appendLine(logPath, 'workflow "smoke-test" run 9e473ab5-0000 started', new Date(2026, 0, 3, 14, 15, 22))
    appendLine(logPath, 'node hello PASS -> worker-echo', new Date(2026, 0, 3, 14, 16, 1))
    appendLine(logPath, 'node worker-echo PASS -> END', new Date(2026, 0, 3, 14, 16, 30))
    const content = readFileSync(logPath, 'utf8')
    assert.equal(
      content,
      '[2026-01-03 14:15:22] workflow "smoke-test" run 9e473ab5-0000 started\n' +
        '[2026-01-03 14:16:01] node hello PASS -> worker-echo\n' +
        '[2026-01-03 14:16:30] node worker-echo PASS -> END\n',
    )
  })
})

test('createRunLog: unwritable location returns undefined without throwing', () => {
  withTempDir((tmp) => {
    // Put a regular FILE where the log directory's parent must be a directory,
    // so mkdir fails with ENOTDIR on every platform (chmod is unreliable on Windows).
    const blocker = join(tmp, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const logPath = createRunLog(join(blocker, 'flow.yaml'), 'flow', '9e473ab5-0000')
    assert.equal(logPath, undefined)
  })
})

test('appendLine: unwritable target is silently ignored', () => {
  withTempDir((tmp) => {
    // Directory does not exist → append fails; must not throw.
    appendLine(join(tmp, 'no-such-dir', 'x.txt'), 'line')
    // Path points at a directory → append fails; must not throw.
    appendLine(tmp, 'line')
  })
})
