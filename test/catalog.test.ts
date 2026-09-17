import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash, CatalogValidationError } from '../src/catalog/validate.ts'
import { CatalogSchemaError } from '../src/catalog/schema.ts'
import { classifyCatalogFilename } from '../src/catalog/loader.ts'
import { scanCatalog, loadCatalogEntry } from '../src/catalog/loader.ts'
import { roleReuseMode } from '../src/types.ts'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** v3 最小合法配置：单出口 manager 节点 + 一条显式流程返回。 */
const VALID_CONFIG = `
schemaVersion: agent-workflow/v3
roles:
  developer:
    persona: Implement.
judgeRole:
  persona: Judge.
workflow:
  startNode: plan
  returns: [built]
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
      results:
        succeeded: { criteria: The plan exists., target: { node: build } }
    build:
      execution:
        type: actor-task
        role: developer
        instruction: Build it.
      checker:
        checkerId: judge.claim-correct
        config:
          criteria: PASS when built.
      results:
        succeeded: { criteria: The build is complete., target: { return: built } }
`

/** 每个用例只改一处，避免字符串替换互相干扰。 */
const configWith = (from: string, to: string) => VALID_CONFIG.replace(from, to)

function assertSchemaIssue(text: string, needle: string): void {
  try {
    parseCatalogConfig(text)
  } catch (error) {
    assert.ok(error instanceof CatalogSchemaError, `expected CatalogSchemaError, got ${String(error)}`)
    assert.ok(JSON.stringify(error.issues).includes(needle), `issues do not mention ${needle}: ${JSON.stringify(error.issues)}`)
    return
  }
  assert.fail('expected the strict schema to reject this config')
}

test('valid v3 config parses and normalizes', () => {
  const config = parseCatalogConfig(VALID_CONFIG)
  assert.equal(config.schemaVersion, 'agent-workflow/v3')
  assert.deepEqual(Object.keys(config.roles), ['developer'])
  const normalized = validateAndNormalize(config, { workflowId: 'test-wf' })
  assert.equal(normalized.workflow.startNode, 'plan')
  assert.deepEqual(normalized.workflow.returns, ['built'])
})

test('#130: v2 configs are rejected outright (no dual-track runtime)', () => {
  const legacy = VALID_CONFIG.replace('agent-workflow/v3', 'agent-workflow/v2')
  assert.throws(() => parseCatalogConfig(legacy), /schemaVersion/)
})

test('#130: legacy Actor fields (onPass/onFail) are rejected with the offending key named', () => {
  assertSchemaIssue(
    configWith('      results:\n        succeeded: { criteria: The plan exists., target: { node: build } }', '      onPass: build'),
    'onPass',
  )
  assertSchemaIssue(
    configWith('      results:\n        succeeded: { criteria: The plan exists., target: { node: build } }', '      onPass: build\n      onFail: build'),
    'onFail',
  )
})

test('#130: bare END targets are rejected', () => {
  assert.throws(
    () => parseCatalogConfig(configWith('target: { return: built }', 'target: END')),
    /target must be exactly/,
  )
})

test('#130: a Target must be exactly one of node/return', () => {
  assert.throws(
    () => parseCatalogConfig(configWith('target: { return: built }', 'target: { node: plan, return: built }')),
    /target must be exactly/,
  )
  assert.throws(
    () => parseCatalogConfig(configWith('target: { return: built }', 'target: {}')),
    /target must be exactly/,
  )
})

test('model route caps: provider ≤64 / modelId ≤128 after trim (A1 D3)', () => {
  const withModel = (provider: string, modelId: string) => parseCatalogConfig(configWith(
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
  const withReuse = (line: string) => parseCatalogConfig(configWith(
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
  const invalid = configWith(
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
  const config = parseCatalogConfig(configWith(
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
  assertSchemaIssue('schemaVersion: agent-workflow/v3\nunknownTop: 1\nroles: {}\njudgeRole: {persona: J}\nworkflow: {startNode: x, returns: [a], nodes: {}}', 'unknownTop')
})

test('root startNode must be a manager actor-task', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: build
  returns: [done]
  nodes:
    build:
      execution: { type: actor-task, role: developer, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { return: done } }
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /startNode/)
})

test('#130: a workflow must declare a non-empty, unique returns list', () => {
  // 空 returns：schema 拒绝
  assertSchemaIssue(configWith('  returns: [built]', '  returns: []'), 'returns')
  // 重复返回名：静态校验拒绝，并点名重复项
  const duplicated = parseCatalogConfig(configWith('  returns: [built]', '  returns: [built, built]'))
  assert.throws(() => validateAndNormalize(duplicated, { workflowId: 'w' }), CatalogValidationError, /duplicate returns/)
  // 非法标识符
  assertSchemaIssue(configWith('  returns: [built]', '  returns: [Built]'), 'returns')
})

test('#130: every declared return needs a structurally reachable return path', () => {
  // built 只声明、没有任何 Target 指向它（build 回到 plan 形成环）
  const unreachable = parseCatalogConfig(configWith('target: { return: built }', 'target: { node: plan }'))
  assert.throws(() => validateAndNormalize(unreachable, { workflowId: 'w' }), CatalogValidationError, /no structurally reachable return path/)
})

test('#130: results and their criteria are required and bounded', () => {
  // 没有任何结果
  assertSchemaIssue(
    configWith('        succeeded: { criteria: The plan exists., target: { node: build } }', '        succeeded: { criteria: The plan exists. }'),
    'target',
  )
  // 空 results 映射
  assert.throws(() => validateAndNormalize(parseCatalogConfig(configWith(
    '      results:\n        succeeded: { criteria: The plan exists., target: { node: build } }',
    '      results: {}',
  )), { workflowId: 'w' }), CatalogValidationError, /must declare at least one result/)
  // 空 criteria
  assert.throws(() => parseCatalogConfig(configWith('criteria: The plan exists.', 'criteria: "  "')), /criteria/)
  // criteria 超过上界：schema 与静态校验都拒绝（下界/上界同源 LIMITS）
  assert.throws(
    () => parseCatalogConfig(configWith('criteria: The plan exists.', `criteria: "${'x'.repeat(9000)}"`)),
    (error: unknown) => error instanceof CatalogSchemaError || error instanceof CatalogValidationError,
  )
  // 非法 result 名（大写）
  assertSchemaIssue(configWith('        succeeded: { criteria: The plan exists.', '        Succeeded: { criteria: The plan exists.'), 'Succeeded')
})

test('#130: unknown Target references are rejected at catalog validation', () => {
  const unknownNode = parseCatalogConfig(configWith('target: { node: build }', 'target: { node: ghost }'))
  assert.throws(() => validateAndNormalize(unknownNode, { workflowId: 'w' }), CatalogValidationError, /target node "ghost" does not exist/)
  const unknownReturn = parseCatalogConfig(configWith('target: { return: built }', 'target: { return: ghost }'))
  assert.throws(() => validateAndNormalize(unknownReturn, { workflowId: 'w' }), CatalogValidationError, /target return "ghost" is not declared/)
})

test('unknown role is rejected', () => {
  const config = parseCatalogConfig(configWith('        role: developer', '        role: ghost'))
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown role/)
})

test('unreachable node is rejected', () => {
  const config = parseCatalogConfig(configWith(
    '        succeeded: { criteria: The build is complete., target: { return: built } }',
    '        succeeded: { criteria: The build is complete., target: { node: plan } }',
  ).replace('target: { node: build }', 'target: { return: built }'))
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /not reachable/)
})

test('#131: a v3 Child caller is accepted once onReturn matches the called workflow returns', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: call } }
    call:
      execution: { type: child-workflow, workflowId: child-a }
      onReturn: { finished: { return: done } }
childWorkflows:
  child-a:
    startNode: work
    returns: [finished]
    nodes:
      work:
        execution: { type: actor-task, role: developer, instruction: Work. }
        checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
        results:
          succeeded: { criteria: ok, target: { return: finished } }
`)
  const normalized = validateAndNormalize(config, { workflowId: 'w' })
  assert.deepEqual(normalized.workflow.nodes.call?.execution.type, 'child-workflow')
  // onReturn 的值是本层 Target：未知节点/未声明返回仍静态拒绝
  const unknownTarget = parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: call } }
    call:
      execution: { type: child-workflow, workflowId: child-a }
      onReturn: { finished: { node: ghost } }
childWorkflows:
  child-a:
    startNode: work
    returns: [finished]
    nodes:
      work:
        execution: { type: actor-task, role: developer, instruction: Work. }
        checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
        results:
          succeeded: { criteria: ok, target: { return: finished } }
`)
  assert.throws(() => validateAndNormalize(unknownTarget, { workflowId: 'w' }), CatalogValidationError, /target node "ghost" does not exist/)
  // v2 的 onPass 在 Child caller 上被严格拒绝
  assert.throws(() => parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: call } }
    call:
      execution: { type: child-workflow, workflowId: child-a }
      onPass: done
childWorkflows:
  child-a:
    startNode: work
    returns: [finished]
    nodes:
      work:
        execution: { type: actor-task, role: developer, instruction: Work. }
        checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
        results:
          succeeded: { criteria: ok, target: { return: finished } }
`), CatalogSchemaError, /unrecognized keys: onPass/)
})

test('#131: onReturn must match the called workflow returns exactly', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: { developer: { persona: D } }
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: call } }
    call:
      execution: { type: child-workflow, workflowId: child-a }
      onReturn: { finished: { return: done }, extra: { return: done } }
childWorkflows:
  child-a:
    startNode: work
    returns: [finished, cancelled]
    nodes:
      work:
        execution: { type: actor-task, role: developer, instruction: Work. }
        checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
        results:
          succeeded: { criteria: ok, target: { return: finished } }
          cancelled: { criteria: stop, target: { return: cancelled } }
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /onReturn is missing mappings for returns cancelled/)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /onReturn maps unknown returns extra/)
})

test('child workflow cycle is rejected', () => {
  // 递归引用（直接或间接）必须在静态校验期被拒绝，不依赖运行期栈深度。
  const cyclic = {
    schemaVersion: 'agent-workflow/v3' as const,
    roles: { developer: { persona: 'D' } },
    judgeRole: { persona: 'J' },
    workflow: {
      startNode: 'plan',
      returns: ['done'],
      nodes: {
        plan: {
          execution: { type: 'actor-task' as const, role: 'manager', instruction: 'Do.' },
          checker: { checkerId: 'judge.claim-correct', config: { criteria: 'PASS.' } },
          results: { succeeded: { criteria: 'ok', target: { return: 'done' } } },
        },
      },
    },
    childWorkflows: {
      a: { startNode: 'na', returns: ['done'], nodes: { na: { execution: { type: 'child-workflow' as const, workflowId: 'b' }, onReturn: { done: { return: 'done' } } } } },
      b: { startNode: 'nb', returns: ['done'], nodes: { nb: { execution: { type: 'child-workflow' as const, workflowId: 'a' }, onReturn: { done: { return: 'done' } } } } },
    },
  }
  assert.throws(() => validateAndNormalize(structuredClone(cyclic), { workflowId: 'w' }), CatalogValidationError, /cycle/)
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
    await writeFile(join(dir, 'bad.yaml'), 'schemaVersion: agent-workflow/v3\nnope: 1\n')
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
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: prog } }
    prog:
      execution: { type: builtin-program, programId: unknown.program }
      results:
        PASS: { criteria: The program reported success., target: { return: done } }
        FAIL: { criteria: The program reported failure., target: { return: done } }
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown builtin program/)
})

test('#130: a Program node must declare exactly PASS and FAIL results', () => {
  const config = parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: prog } }
    prog:
      execution: { type: builtin-program, programId: github.initialize-milestone }
      results:
        PASS: { criteria: The program reported success., target: { return: done } }
`)
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /must declare results FAIL/)
})

test('#132: Program 结果固定为 PASS/FAIL 且各带统一 Target，错误目标/缺失业务边/ERROR 路由都在校验期拒绝', () => {
  const withProgram = (programBody: string) => parseCatalogConfig(`
schemaVersion: agent-workflow/v3
roles: {}
judgeRole: { persona: J }
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: ok, target: { node: prog } }
    prog:
      execution: { type: builtin-program, programId: github.all-milestone-issues-complete }
${programBody}
`)
  const accepted = withProgram(`      results:
        PASS: { criteria: The program reported success., target: { return: done } }
        FAIL: { criteria: The program reported failure., target: { node: plan } }
`)
  const normalized = validateAndNormalize(accepted, { workflowId: 'w' })
  assert.deepEqual(normalized.workflow.nodes['prog']!.results, {
    PASS: { criteria: 'The program reported success.', target: { return: 'done' } },
    FAIL: { criteria: 'The program reported failure.', target: { node: 'plan' } },
  })

  const reject = (programBody: string, needle: RegExp) => {
    assert.throws(() => validateAndNormalize(withProgram(programBody), { workflowId: 'w' }), CatalogValidationError, needle)
  }
  // ERROR 不是可路由的业务边：异常交 Manager 事实确认，不配置路由
  reject(`      results:
        PASS: { criteria: The program reported success., target: { return: done } }
        FAIL: { criteria: The program reported failure., target: { node: plan } }
        ERROR: { criteria: The program could not determine the state., target: { node: plan } }
`, /declares unknown Program results ERROR/)
  // 缺失业务边：PASS/FAIL 都必须在图上有静态目标
  reject(`      results:
        FAIL: { criteria: The program reported failure., target: { return: done } }
`, /must declare results PASS/)
  // 错误目标：不存在的节点 / 未声明的流程返回
  reject(`      results:
        PASS: { criteria: The program reported success., target: { node: nope } }
        FAIL: { criteria: The program reported failure., target: { return: done } }
`, /target node "nope" does not exist/)
  reject(`      results:
        PASS: { criteria: The program reported success., target: { return: nope } }
        FAIL: { criteria: The program reported failure., target: { return: done } }
`, /target return "nope" is not declared by this workflow/)
})

test('prototype-pollution role names are rejected (hasOwn checks)', () => {
  const config = parseCatalogConfig(configWith('        role: developer', '        role: constructor'))
  assert.throws(() => validateAndNormalize(config, { workflowId: 'w' }), CatalogValidationError, /unknown role/)
})

test('#59: persona hand-written submission protocol keywords warn but never block', async () => {
  for (const keyword of ['node_claim', 'judge_claim', 'send_message']) {
    const roleHit = parseCatalogConfig(configWith(
      '  developer:\n    persona: Implement.',
      `  developer:\n    persona: Finish work then ${keyword} it.`,
    ))
    const roleWarnings: string[] = []
    const normalized = validateAndNormalize(roleHit, { workflowId: 'w', warnings: roleWarnings })
    assert.equal(normalized.roles['developer']!.persona, `Finish work then ${keyword} it.`)
    assert.deepEqual(roleWarnings.length, 1)
    assert.match(roleWarnings[0]!, /role "developer" persona must not hand-write submission protocol/)
    assert.match(roleWarnings[0]!, new RegExp(keyword))
    assert.match(roleWarnings[0]!, /docs\/user-guide\.md/)

    const judgeHit = parseCatalogConfig(configWith('  persona: Judge.', `  persona: Verify then ${keyword} it.`))
    const judgeWarnings: string[] = []
    validateAndNormalize(judgeHit, { workflowId: 'w', warnings: judgeWarnings })
    assert.deepEqual(judgeWarnings.length, 1)
    assert.match(judgeWarnings[0]!, /judgeRole persona must not hand-write submission protocol/)
  }
})

test('#59: keyword-hit catalog loads with a warning diagnostic and is not blocked', async () => {
  const warned = configWith('  developer:\n    persona: Implement.', '  developer:\n    persona: Report only via node_claim.')
  const home = await mkdtemp(join(tmpdir(), 'wfhome-'))
  const dir = join(home, 'workflows')
  await mkdir(dir, { recursive: true })
  try {
    await writeFile(join(dir, 'warned.yaml'), warned)
    await writeFile(join(dir, 'broken.yaml'), 'schemaVersion: agent-workflow/v3\nnope: 1\n')
    const scan = await scanCatalog(home)
    assert.deepEqual(scan.entries.map(e => e.workflowId), ['warned'])
    assert.deepEqual(scan.diagnostics.map(d => [d.workflowId, d.severity]), [['broken', 'error'], ['warned', 'warning']])
    const entry = await loadCatalogEntry(home, 'warned')
    assert.ok(entry, 'warning 不阻止加载')
    assert.equal(entry.config.roles['developer']!.persona, 'Report only via node_claim.')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('#59: parse/schema/validation errors stay blocking errors', async () => {
  const cases: Array<[string, string]> = [
    ['parse-error.yaml', 'a: 1\na: 2\n'],
    ['schema-error.yaml', 'schemaVersion: agent-workflow/v3\nnope: 1\n'],
    ['validation-error.yaml', configWith('        role: developer', '        role: ghost')],
  ]
  const home = await mkdtemp(join(tmpdir(), 'wfhome-'))
  const dir = join(home, 'workflows')
  await mkdir(dir, { recursive: true })
  try {
    for (const [name, text] of cases) await writeFile(join(dir, name), text)
    const scan = await scanCatalog(home)
    assert.deepEqual(scan.entries, [])
    assert.deepEqual(scan.diagnostics.map(d => [d.workflowId, d.severity]), cases.map(([name]) => [name.slice(0, -5), 'error']))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('#46 P5: business-discipline personas without protocol keywords warn nothing', () => {
  const config = parseCatalogConfig(VALID_CONFIG)
  const warnings: string[] = []
  const normalized = validateAndNormalize(config, { workflowId: 'w', warnings })
  assert.deepEqual(warnings, [])
  assert.equal(normalized.roles['developer']!.persona, 'Implement.')
  assert.equal(normalized.judgeRole.persona, 'Judge.')
})
