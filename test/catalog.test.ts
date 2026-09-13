import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash, CatalogValidationError } from '../src/catalog/validate.ts'
import { classifyCatalogFilename } from '../src/catalog/loader.ts'
import { scanCatalog } from '../src/catalog/loader.ts'
import { roleReuseMode } from '../src/types.ts'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const VALID_CONFIG = `
schemaVersion: agent-workflow/v2
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
        checkerId: judge.claim-correct
        config:
          criteria: PASS when a plan exists.
      onPass: build
    build:
      execution:
        type: actor-task
        role: developer
        instruction: Build it.
      checker:
        checkerId: judge.claim-correct
        config:
          criteria: PASS when built.
      onPass: END
`

test('valid config parses and normalizes', () => {
  const config = parseCatalogConfig(VALID_CONFIG)
  assert.equal(config.schemaVersion, 'agent-workflow/v2')
  assert.deepEqual(Object.keys(config.roles), ['developer'])
  const normalized = validateAndNormalize(config, { workflowId: 'test-wf' })
  assert.equal(normalized.workflow.startNode, 'plan')
})

test('v1 schemaVersion is rejected (A1 D1: in-place upgrade, no dual-track)', () => {
  const legacy = VALID_CONFIG.replace('agent-workflow/v2', 'agent-workflow/v1')
  assert.throws(() => parseCatalogConfig(legacy), /schemaVersion/)
})

test('model route caps: provider ≤64 / modelId ≤128 after trim (A1 D3)', () => {
  const withModel = (provider: string, modelId: string) => parseCatalogConfig(VALID_CONFIG.replace(
    '  developer:\n    persona: Implement.',
    `  developer:\n    persona: Implement.\n    model: { provider: "${provider}", modelId: "${modelId}" }`,
  ))
  assert.throws(() => withModel('p'.repeat(65), 'm'), /provider.*64/)
  assert.throws(() => withModel('p', 'm'.repeat(129)), /modelId.*128/)
  // Boundary values parse fine (≤ caps) and arrive trimmed (stored trimmed).
  const capped = validateAndNormalize(withModel(' p2 ', ' m2 '), { workflowId: 'caps-wf' })
  assert.deepEqual(capped.roles['developer']!.model, { provider: 'p2', modelId: 'm2' })
})

test('#60: role reuse defaults to node and survives into the frozen snapshot', () => {
  const withReuse = (line: string) => parseCatalogConfig(VALID_CONFIG.replace(
    '  developer:\n    persona: Implement.',
    `  developer:\n    persona: Implement.\n${line}`,
  ))
  // 省略 → 归一化为 node（快照里显式存在，不再依赖读取方各自兜底）。
  const defaulted = validateAndNormalize(withReuse(''), { workflowId: 'reuse-wf' })
  assert.equal(defaulted.roles['developer']!.reuse, 'node')
  // 显式 continuable 原样保留。
  const continuable = validateAndNormalize(withReuse('    reuse: continuable'), { workflowId: 'reuse-wf' })
  assert.equal(continuable.roles['developer']!.reuse, 'continuable')
  // 解析结果参与 definitionHash ⇒ 缺省值与显式值一样被定义快照冻结。
  assert.notEqual(computeDefinitionHash(defaulted), computeDefinitionHash(continuable))
  assert.equal(roleReuseMode(undefined), 'node')
  assert.equal(roleReuseMode({ persona: 'P' }), 'node')
  assert.equal(roleReuseMode({ persona: 'P', reuse: 'continuable' }), 'continuable')
})

test('#60: invalid reuse is rejected by the schema (only that file is blocked)', async () => {
  const invalid = VALID_CONFIG.replace(
    '  developer:\n    persona: Implement.',
    '  developer:\n    persona: Implement.\n    reuse: always',
  )
  assert.throws(() => parseCatalogConfig(invalid), /reuse/)

  const home = await mkdtemp(join(tmpdir(), 'wfhome-'))
  const dir = join(home, 'workflows')
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(join(dir, 'good.yaml'), VALID_CONFIG)
    await writeFile(join(dir, 'bad-reuse.yaml'), invalid)
    const scan = await scanCatalog(home)
    assert.deepEqual(scan.entries.map(e => e.workflowId), ['good'])
    assert.deepEqual(scan.diagnostics.map(d => d.workflowId), ['bad-reuse'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('#60: manager cannot configure reuse (reserved roleKey is rejected)', () => {
  const config = parseCatalogConfig(VALID_CONFIG.replace(
    '  developer:\n    persona: Implement.',
    '  manager:\n    persona: Implement.\n    reuse: node',
  ))
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /reserved/)
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
  assert.throws(() => parseCatalogConfig('schemaVersion: agent-workflow/v2\nunknownTop: 1\nroles: {}\njudgeRole: {persona: J}\nworkflow: {startNode: x, nodes: {}}'), /unknownTop/)
})

test('root startNode must be a manager actor-task', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: build
  nodes:
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /startNode/)
})

test('onFail END is accepted (#17); unknown target and truly endless graphs still rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: build
      onFail: END
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`)
  const normalized = validateAndNormalize(config, { workflowId: 'w' })
  assert.equal(normalized.workflow.nodes.plan.onFail, 'END')

  // 仅 onFail 可到 END 的图可通过校验。
  const onlyFailToEnd = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: build
      onFail: END
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: plan
`)
  validateAndNormalize(onlyFailToEnd, { workflowId: 'w2' })

  // 未知目标仍拒绝。
  const unknown = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
      onFail: ghost
`)
  assert.throws(() => validateAndNormalize(unknown, { workflowId: 'w3' }), CatalogValidationError, /onFail target/)

  // 真正无终点图仍拒绝（onPass/onFail 均不成环到 END）。
  const endless = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: build
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: plan
`)
  assert.throws(() => validateAndNormalize(endless, { workflowId: 'w4' }), CatalogValidationError, /no path.*END/)
})

test('unknown role is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: build
    build:
      execution: { type: actor-task, role: ghost, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown role/)
})

test('unreachable node is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
    orphan:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /not reachable/)
})

test('child workflow cycle is rejected', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
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
schemaVersion: agent-workflow/v2
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: "${'x'.repeat(9000)}" } }
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
    await writeFile(join(dir, 'bad.yaml'), 'schemaVersion: agent-workflow/v2\nnope: 1\n')
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
schemaVersion: agent-workflow/v2
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: prog
    prog:
      execution: { type: builtin-program, programId: unknown.program }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown builtin program/)
})

test('prototype-pollution role names are rejected (hasOwn checks)', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v2
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: build
    build:
      execution: { type: actor-task, role: constructor, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      onPass: END
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown role/)
})

test('#46 P5: persona hand-written submission protocol keywords are rejected', () => {
  for (const keyword of ['node_claim', 'judge_claim', 'send_message']) {
    const roleHit = parseCatalogConfig(VALID_CONFIG.replace(
      '  developer:\n    persona: Implement.',
      `  developer:\n    persona: Finish work then ${keyword} it.`,
    ))
    assert.throws(() => validateAndNormalize(roleHit, { workflowId: 'w' }), CatalogValidationError, /must not hand-write submission protocol/)
    const judgeHit = parseCatalogConfig(VALID_CONFIG.replace(
      '  persona: Judge.',
      `  persona: Verify then ${keyword} it.`,
    ))
    assert.throws(() => validateAndNormalize(judgeHit, { workflowId: 'w' }), CatalogValidationError, /judgeRole.*must not hand-write submission protocol/)
  }
})

test('#46 P5: business-discipline personas without protocol keywords still pass', () => {
  const config = parseCatalogConfig(VALID_CONFIG)
  const normalized = validateAndNormalize(config, { workflowId: 'w' })
  assert.equal(normalized.roles['developer']!.persona, 'Implement.')
  assert.equal(normalized.judgeRole.persona, 'Judge.')
})
