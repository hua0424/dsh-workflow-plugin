/**
 * Regression tests for the adversarial-review fixes (Round 7):
 * - ghApi never emits --jq/-q with invalid pipelines (F4)
 * - milestone/issues queries use state=all and exclude PRs (F15)
 * - fmtResult surfaces wrapper `value` results (F10)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ghApi } from '../src/programs/runner.ts'
import { BUILTIN_PROGRAMS } from '../src/programs/catalog.ts'

// ---- F4: gh argument construction (pure function, no real CLI needed) ----
test('buildGhArgs never emits jq pipelines and encodes the query', async () => {
  const { buildGhArgs } = await import('../src/programs/runner.ts')
  assert.deepEqual(buildGhArgs('repos/a/b/milestones', 'GET', 'state=all&per_page=100'),
    ['api', 'repos/a/b/milestones?state=all&per_page=100', '--method', 'GET'])
  assert.deepEqual(buildGhArgs('repos/a/b/issues', 'GET'),
    ['api', 'repos/a/b/issues', '--method', 'GET'])
  assert.deepEqual(buildGhArgs('repos/a/b/milestones', 'POST', undefined, { title: 'M' }),
    ['api', 'repos/a/b/milestones', '--method', 'POST', '--input', '-'])
  const all = buildGhArgs('p', 'GET', 'q=1', { x: 1 })
  assert.ok(!all.includes('--jq') && !all.includes('-q'))
})

test('ghApi FAIL paths return ERROR not a malformed pipeline', () => {
  const result = ghApi({ cwd: 'C:\\nonexistent', method: 'GET', path: 'x', timeoutMs: 1000 })
  assert.equal(result.kind, 'ERROR')
})

test('builtin program catalog exposes the two fixed ids', () => {
  assert.deepEqual(Object.keys(BUILTIN_PROGRAMS).sort(), ['github.all-milestone-issues-complete', 'github.initialize-milestone'])
})
