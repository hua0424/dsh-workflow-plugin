import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunLog, appendLine, lineTimestamp, runLogDir, shortId, bounded, jsonField, traceEvent, redact, Escaped } from '../src/engine/tracelog.ts'

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
    assert.equal(appendLine(logPath, 'START workflow=smoke-test run=9e473ab5-0000 fmt=2', new Date(2026, 0, 3, 14, 15, 22)), true)
    assert.equal(appendLine(logPath, 'ROUTE workflow=smoke-test node=hello result=PASS target=END', new Date(2026, 0, 3, 14, 16, 30)), true)
    const content = readFileSync(logPath, 'utf8')
    assert.equal(
      content,
      '[2026-01-03 14:15:22] START workflow=smoke-test run=9e473ab5-0000 fmt=2\n' +
        '[2026-01-03 14:16:30] ROUTE workflow=smoke-test node=hello result=PASS target=END\n',
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

test('appendLine: unwritable target is silently ignored and reports false (A3 §10)', () => {
  withTempDir((tmp) => {
    // Directory does not exist → append fails; must not throw.
    assert.equal(appendLine(join(tmp, 'no-such-dir', 'x.txt'), 'line'), false)
    // Path points at a directory → append fails; must not throw.
    assert.equal(appendLine(tmp, 'line'), false)
  })
})

// ---- A3 fmt=2 event-line helpers ----

test('shortId: first 8 chars', () => {
  assert.equal(shortId('9e473ab5-1234-5678'), '9e473ab5')
  assert.equal(shortId('abc'), 'abc')
})

test('bounded: clamps to the protocol bound and marks truncation (A3 §4)', () => {
  assert.equal(bounded('short', 10), 'short')
  assert.equal(bounded('x'.repeat(11), 10), `${'x'.repeat(10)}…[truncated]`)
  assert.equal(bounded('x'.repeat(10), 10), 'x'.repeat(10))
})

test('jsonField: escapes free text onto one line; null for absent (A3 §3)', () => {
  assert.equal(jsonField('planned', 100).text, '"planned"')
  assert.equal(jsonField('multi\nline "quoted" \\ path', 100).text, '"multi\\nline \\"quoted\\" \\\\ path"')
  assert.equal(jsonField(null, 100).text, 'null')
  assert.equal(jsonField(undefined, 100).text, 'null')
  // Over-bound text is truncated inside the quotes.
  assert.equal(jsonField('y'.repeat(12), 10).text, `"${'y'.repeat(10)}…[truncated]"`)
})

test('traceEvent: key=value tokens in insertion order; undefined omitted, null kept', () => {
  assert.equal(
    traceEvent('CLAIM', { workflow: 'eng-test', node: 'plan', token: 'ab12cd34', role: 'manager', outcome: 'completed', summary: jsonField('planned', 100), handoff: jsonField(null, 100) }),
    'CLAIM workflow=eng-test node=plan token=ab12cd34 role=manager outcome=completed summary="planned" handoff=null',
  )
  assert.equal(traceEvent('MODEL', { workflow: 'w', role: 'judge', provider: undefined, model: 'm1' }), 'MODEL workflow=w role=judge model=m1')
  assert.equal(traceEvent('COMPACT', { ok: true, detail: jsonField(null, 100) }), 'COMPACT ok=true detail=null')
  // Unexpected whitespace in a raw identifier falls back to JSON quoting so
  // the one-event-per-line invariant holds.
  assert.equal(traceEvent('MODEL', { provider: 'a b' }), 'MODEL provider="a b"')
})

test('traceEvent: a raw string LOOKING like escaped JSON is re-checked (A3 review S1: no multi-line injection)', () => {
  // A Manager-supplied provider id containing a quote + newline must never
  // pass through as-is and forge a second event line.
  const line = traceEvent('MODEL', { workflow: 'w', role: 'judge', provider: '"evil\nINJECTED model=m' })
  assert.equal(line, 'MODEL workflow=w role=judge provider="\\"evil\\nINJECTED model=m"')
  assert.ok(!line.includes('\n'), 'single line preserved')
  // Only the Escaped wrapper passes through untouched.
  assert.ok(jsonField('x', 10) instanceof Escaped)
})

test('redact: credential-shaped substrings never survive jsonField (A3 AC10)', () => {
  assert.equal(jsonField('key is sk-abc123XYZ789def456 here', 200).text, '"key is [redacted] here"')
  assert.equal(jsonField('Authorization: Bearer tok1234567890', 200).text, '"Authorization: [redacted]"')
  assert.equal(jsonField('ghp_AbCdEfGhIjKlMnOpQrStUv failed', 200).text, '"[redacted] failed"')
  assert.equal(jsonField('api_key=abc123456789secretXYZ', 200).text, '"api_key=[redacted]"')
  assert.equal(jsonField('GitHub token github_pat_11ABCDEFG0123456789abcdefghijklmnopqrstuv', 200).text, '"GitHub token [redacted]"')
  // Ordinary text is untouched.
  assert.equal(jsonField('no secrets here: token rotation discussed', 200).text, '"no secrets here: token rotation discussed"')
})
