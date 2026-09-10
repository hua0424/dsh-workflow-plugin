import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateJudgeToolSurface } from '../src/plugin/host.ts'
import { JUDGE_DEFAULT_DENY, JUDGE_MACHINERY_EXEMPT, JUDGE_REQUIRED_TOOLS, knownDenyList } from '../src/roles/roles.ts'

/** The surface the default deny list is supposed to leave behind. */
const ALLOWED_SURFACE = [...JUDGE_REQUIRED_TOOLS, ...JUDGE_MACHINERY_EXEMPT, 'pwsh', 'gh']

test('judge surface passes when the required tools are present and no denied tool is visible', () => {
  assert.equal(evaluateJudgeToolSurface(ALLOWED_SURFACE, JUDGE_DEFAULT_DENY), undefined)
  // A run that adds catalog denies narrows the surface further — still fine.
  assert.equal(evaluateJudgeToolSurface(ALLOWED_SURFACE.filter(name => name !== 'pwsh'), [...JUDGE_DEFAULT_DENY, 'pwsh']), undefined)
})

test('judge surface fails when a denied tool is visible', () => {
  for (const denied of JUDGE_DEFAULT_DENY) {
    assert.equal(evaluateJudgeToolSurface([...ALLOWED_SURFACE, denied], JUDGE_DEFAULT_DENY), `Judge tool surface contains denied tool "${denied}"`, denied)
  }
})

test('judge surface still fails when a required tool is missing (half kept from the allow-list era)', () => {
  for (const required of JUDGE_REQUIRED_TOOLS) {
    const visible = ALLOWED_SURFACE.filter(name => name !== required)
    assert.equal(evaluateJudgeToolSurface(visible, JUDGE_DEFAULT_DENY), `Judge tool surface is missing required tool "${required}"`, required)
  }
})

test('delegation machinery is exempt from the deny check (never visible-filtered)', () => {
  assert.equal(evaluateJudgeToolSurface([...JUDGE_REQUIRED_TOOLS, ...JUDGE_MACHINERY_EXEMPT], JUDGE_DEFAULT_DENY), undefined)
})

// Regression (A30 real Host): `ctx.tools.restrict()` faults on unknown global
// names, so a default entry this profile does not ship (`edit`/`write` in a
// minimal profile) must be dropped instead of faulting every Judge spawn.
test('deny entries the profile does not ship are dropped, not passed to restrict()', () => {
  // A minimal profile: the read-only fixtures plus the plugin's own workflow
  // tools, but no host `edit`/`write`.
  const profile = [...JUDGE_REQUIRED_TOOLS, ...JUDGE_MACHINERY_EXEMPT, 'node_claim', 'node_block', 'judge_respawn']
  const deny = knownDenyList(JUDGE_DEFAULT_DENY, profile)
  assert.equal(deny.includes('edit'), false)
  assert.equal(deny.includes('write'), false)
  assert.deepEqual(deny, ['node_claim', 'node_block', 'judge_respawn'])
  // The surface the Judge ends up with satisfies the assertion.
  const visible = profile.filter(name => !deny.includes(name))
  assert.equal(evaluateJudgeToolSurface(visible, deny), undefined)
  // A profile that does ship them keeps denying them.
  assert.deepEqual(knownDenyList(JUDGE_DEFAULT_DENY, [...JUDGE_DEFAULT_DENY, 'read']), [...JUDGE_DEFAULT_DENY])
})
