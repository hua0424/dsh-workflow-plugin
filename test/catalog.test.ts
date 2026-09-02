import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash, CatalogValidationError } from '../src/catalog/validate.ts'
import { classifyCatalogFilename } from '../src/catalog/loader.ts'
import { scanCatalog } from '../src/catalog/loader.ts'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const VALID_CONFIG = `
schemaVersion: agent-workflow/v1
roles:
  developer:
    persona: Implement.
judgeRole:
  persona: Judge.
workflow:
  startNode: plan
  nodes:
    plan:
      execution:
        type: actor-task
        role: manager
        instruction: Plan it.
      checker:
        checkerId: judge.goal-satisfied
        config:
          criteria: PASS when a plan exists.
      onPass: build
    build:
      execution:
        type: actor-task
        role: developer
        instruction: Build it.
      checker:
        checkerId: judge.goal-satisfied
        config:
          criteria: PASS when built.
      onPass: END
`

test('valid config parses and normalizes', () => {
  const config = parseCatalogConfig(VALID_CONFIG)
  assert.equal(config.schemaVersion, 'agent-workflow/v1')
  assert.deepEqual(Object.keys(config.roles), ['developer'])
  const normalized = validateAndNormalize(config, { workflowId: 'test-wf' })
  assert.equal(normalized.workflow.startNode, 'plan')
})

test('duplicate keys are rejected', () => {
  assert.throws(() => parseCatalogConfig('a: 1\na: 2\n'), /unique/)
})

test('anchors and aliases are rejected', () => {
  assert.throws(() => parseCatalogConfig('a: &x 1\nb: *x\n'), /alias|anchor/i)
})

test('merge keys are rejected', () => {
  assert.throws(() => parseCatalogConfig('a: &x {k: 1}\nb:\n  <<: *x\n'), /merge|alias|anchor/i)
})

test('custom tags are rejected', () => {
  assert.throws(() => parseCatalogConfig('a: !!foo 1\n'), /tag/i)
})

test('multi-document input is rejected', () => {
  assert.throws(() => parseCatalogConfig('a: 1\n---\nb: 2\n'), /one YAML document/)
})

test('unknown fields are rejected', () => {
  assert.throws(() => parseCatalogConfig('schemaVersion: agent-workflow/v1\nunknownTop: 1\nroles: {}\njudgeRole: {persona: J}\nworkflow: {startNode: x, nodes: {}}'), /unknownTop/)
})

test('root startNode must be a manager actor-task', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: build
  nodes:
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /startNode/)
})

test('onFail END is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: build
      onFail: END
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /onFail/)
})

test('unknown role is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: build
    build:
      execution: { type: actor-task, role: ghost, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown role/)
})

test('unreachable node is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
    orphan:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /not reachable/)
})

test('child workflow cycle is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
childWorkflows:
  a:
    startNode: na
    nodes:
      na:
        execution: { type: child-workflow, workflowId: b }
        onPass: END
  b:
    startNode: nb
    nodes:
      nb:
        execution: { type: child-workflow, workflowId: a }
        onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /cycle/)
})

test('definition hash is stable and content-sensitive', () => {
  const a = parseCatalogConfig(VALID_CONFIG)
  const b = parseCatalogConfig(VALID_CONFIG)
  const na = validateAndNormalize(a, { workflowId: 'test-wf' })
  const nb = validateAndNormalize(b, { workflowId: 'test-wf' })
  assert.equal(computeDefinitionHash(na), computeDefinitionHash(nb))
  nb.judgeRole.persona = 'Changed.'
  assert.notEqual(computeDefinitionHash(na), computeDefinitionHash(nb))
})

test('criteria bounds are enforced', () => {
  const tooLong = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: "${'x'.repeat(9000)}" } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(tooLong, { workflowId: 'w' }), CatalogValidationError, /criteria/)
})

test('classifyCatalogFilename rules', () => {
  assert.equal(classifyCatalogFilename('good-workflow.yaml').kind, 'candidate')
  assert.equal(classifyCatalogFilename('good-workflow.yaml').workflowId, 'good-workflow')
  assert.equal(classifyCatalogFilename('bad.yml').kind, 'ignored')
  assert.equal(classifyCatalogFilename('UPPER.yaml').kind, 'ignored')
  assert.equal(classifyCatalogFilename('notyaml.txt').kind, 'ignored')
  assert.equal(classifyCatalogFilename('9starts-with-digit.yaml').kind, 'ignored')
})

test('scanCatalog ignores invalid files and lists valid ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wfhome-'))
  const dir = join(home, 'workflows')
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(join(dir, 'good.yaml'), VALID_CONFIG)
    await writeFile(join(dir, 'bad.yaml'), 'schemaVersion: agent-workflow/v1\nnope: 1\n')
    await writeFile(join(dir, 'ignored.yml'), VALID_CONFIG)
    const scan = await scanCatalog(home)
    assert.deepEqual(scan.entries.map(e => e.workflowId), ['good'])
    assert.equal(scan.diagnostics.length, 1)
    assert.equal(scan.diagnostics[0]!.workflowId, 'bad')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('scanCatalog on a missing directory returns empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wfhome-'))
  const scan = await scanCatalog(home)
  assert.deepEqual(scan.entries, [])
  assert.deepEqual(scan.diagnostics, [])
})

test('builtin program ids are validated', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: prog
    prog:
      execution: { type: builtin-program, programId: unknown.program }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown builtin program/)
})

test('prototype-pollution role names are rejected (hasOwn checks)', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v1
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: build
    build:
      execution: { type: actor-task, role: constructor, instruction: Do. }
      checker: { checkerId: judge.goal-satisfied, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown role/)
})
