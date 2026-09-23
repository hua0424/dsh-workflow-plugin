/**
 * T1（#160）最小配置编辑与文件保存闭环：真实 parser/schema/validator 行为测试。
 *
 * 覆盖：加载→修改→保存→重载业务等价与全字段保留、布局恢复、无效输入、
 * 部分写入失败、persona/位置编辑、撤销重做、RPC 受限输入。
 * 受控目录句柄只作为 IO 边界：本层只收文本/JSON，不 mock 核心校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  businessEqual, loadDraft, markSaved, previewDraft, redo, savePlan,
  setActorCommonPersona, setNodePosition, undo, validateDraft,
} from '../src/editor/draft.ts'
import {
  emptyLayout, fillMissingPositions, getPosition, layoutFilenameFor,
  parseLayoutFile, serializeLayout,
} from '../src/editor/layout.ts'
import {
  createEditorRpcHandler, EDITOR_RPC_CHANNEL, registerEditorRpc,
  rpcParseText, rpcPreview, rpcResolveLayout, rpcValidateConfig,
} from '../src/editor/rpc.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'

/**
 * T1 丰富合法 v3：公共 persona、显式/缺省模型、effort、reuse、tools、
 * 三类节点、多结果同目标、多节点回路、主/子流程、返回映射、子流程同名节点。
 */
const RICH_CONFIG = `
schemaVersion: agent-workflow/v3
actorCommonPersona: Shared background.
roles:
  developer:
    persona: Implement it.
    model: { provider: test-provider, modelId: test-model, reasoningEffort: high }
    reuse: continuable
    tools: { deny: [terminal] }
  reviewer:
    persona: Review it.
judgeRole:
  persona: Judge it.
  model: { provider: test-provider, modelId: judge-model }
  tools: { deny: [terminal] }
workflow:
  startNode: plan
  returns: [built]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Plan it. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS when planned. } }
      results:
        succeeded: { criteria: Plan exists., target: { node: build } }
        skipped: { criteria: Plan skipped., target: { node: build } }
    build:
      execution: { type: actor-task, role: developer, instruction: Build it. }
      checker: { checkerId: judge.claim-correct }
      results:
        succeeded: { criteria: Built., target: { node: test } }
        failed: { criteria: Build broke., target: { node: ship } }
    test:
      execution: { type: builtin-program, programId: github.all-milestone-issues-complete, config: { milestoneNumber: 25 } }
      results:
        PASS: { criteria: Milestone complete., target: { return: built } }
        FAIL: { criteria: Still open., target: { node: build } }
    ship:
      execution: { type: child-workflow, workflowId: release }
      onReturn: { shipped: { return: built } }
childWorkflows:
  release:
    startNode: rel-plan
    returns: [shipped]
    nodes:
      rel-plan:
        execution: { type: actor-task, role: developer, instruction: Release it. }
        checker: { checkerId: judge.claim-correct }
        results: { done: { criteria: Released., target: { node: build } } }
      build:
        execution: { type: actor-task, role: reviewer, instruction: Check release. }
        checker: { checkerId: judge.claim-correct }
        results: { done: { criteria: Checked., target: { return: shipped } } }
`

function mustLoad(layoutText?: string) {
  const loaded = loadDraft('review', RICH_CONFIG, layoutText)
  assert.equal(loaded.ok, true, `expected load ok, got ${JSON.stringify(loaded)}`)
  if (!loaded.ok) throw new Error('unreachable')
  return loaded
}

test('T1: 合法配置加载并补齐全部节点坐标', () => {
  const { session, warnings } = mustLoad()
  assert.deepEqual(warnings, [])
  assert.equal(session.draft.config.actorCommonPersona, 'Shared background.')
  for (const nodeId of ['plan', 'build', 'test', 'ship']) {
    assert.ok(getPosition(session.draft.layout, undefined, nodeId) !== undefined, `main/${nodeId} 缺坐标`)
  }
  for (const nodeId of ['rel-plan', 'build']) {
    assert.ok(getPosition(session.draft.layout, 'release', nodeId) !== undefined, `release/${nodeId} 缺坐标`)
  }
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: false })
})

test('T1: 加载→修改→保存→重载业务等价，全字段保留', () => {
  const { session } = mustLoad()
  assert.deepEqual(setActorCommonPersona(session, '  Updated background. '), { ok: true })
  assert.deepEqual(setNodePosition(session, undefined, 'build', { x: 500, y: 300 }), { ok: true })
  assert.deepEqual(setNodePosition(session, 'release', 'build', { x: 60, y: 60 }), { ok: true })
  // 主/子流程同名节点位置隔离。
  assert.notDeepEqual(
    getPosition(session.draft.layout, undefined, 'build'),
    getPosition(session.draft.layout, 'release', 'build'),
  )
  const checked = validateDraft(session)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])
  assert.ok(preview.yaml.includes('Updated background.'))
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })

  // 保存→重载：业务等价（不要求 YAML 文本一致），多结果同目标与回路保留。
  const yamlText = preview.yaml
  const layoutText = serializeLayout(session.draft.config, session.draft.layout)
  const reloaded = loadDraft('review', yamlText, layoutText)
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))
  const nodes = reloaded.session.draft.config.workflow.nodes
  assert.deepEqual(nodes['plan']?.execution.type === 'actor-task' && nodes['plan'] !== undefined
    ? (nodes['plan'] as { results: Record<string, { target: unknown }> }).results['skipped']?.target : undefined,
    { node: 'build' })
  const buildResults = (nodes['build'] as { results: Record<string, { target: unknown }> }).results
  assert.deepEqual(buildResults['succeeded']?.target, { node: 'test' })
  assert.deepEqual(buildResults['failed']?.target, { node: 'ship' })
  // 显式/缺省模型语义保留。
  assert.equal(reloaded.session.draft.config.roles['developer']?.model?.reasoningEffort, 'high')
  assert.equal(reloaded.session.draft.config.roles['reviewer']?.model, undefined)
  assert.equal(reloaded.session.draft.config.judgeRole.model?.reasoningEffort, undefined)
  assert.equal(reloaded.session.draft.config.roles['developer']?.reuse, 'continuable')
  // Program config 全量保留。
  const testNode = nodes['test']
  assert.equal(testNode?.execution.type === 'builtin-program' && testNode.execution.config?.['milestoneNumber'], 25)
  // 布局恢复。
  assert.deepEqual(getPosition(reloaded.session.draft.layout, undefined, 'build'), { x: 500, y: 300 })
  assert.deepEqual(getPosition(reloaded.session.draft.layout, 'release', 'build'), { x: 60, y: 60 })
})

test('T1: persona 清除后省略与非空值区别保留', () => {
  const { session } = mustLoad()
  assert.deepEqual(setActorCommonPersona(session, undefined), { ok: true })
  assert.equal('actorCommonPersona' in session.draft.config, false)
  const preview = previewDraft(session)
  assert.deepEqual(preview.problems, [])
  const reloaded = loadDraft('review', preview.yaml, serializeLayout(session.draft.config, session.draft.layout))
  assert.equal(reloaded.ok, true, JSON.stringify(reloaded))
  if (!reloaded.ok) throw new Error('unreachable')
  assert.equal('actorCommonPersona' in reloaded.session.draft.config, false)
  assert.ok(businessEqual(session.draft.config, reloaded.session.draft.config))
})

test('T1: persona 空白值拒绝，未知节点/流程/非法坐标拒绝', () => {
  const { session } = mustLoad()
  assert.deepEqual(
    setActorCommonPersona(session, '   '),
    { ok: false, reason: 'actorCommonPersona 为空：保留请填非空文本，删除请使用清除操作（省略与非空值区别保留）' },
  )
  assert.match(setNodePosition(session, undefined, 'ghost', { x: 0, y: 0 }).reason ?? '', /不存在/)
  assert.match(setNodePosition(session, 'ghost-flow', 'build', { x: 0, y: 0 }).reason ?? '', /不存在/)
  assert.match(setNodePosition(session, undefined, 'build', { x: NaN, y: 0 }).reason ?? '', /有限数/)
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: false })
})

test('T1: 仅布局变更只写布局；业务变化保存配置和布局；部分失败保留可重试状态', () => {
  const { session } = mustLoad()
  assert.deepEqual(setNodePosition(session, undefined, 'plan', { x: 11, y: 22 }), { ok: true })
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: true })
  // 布局写入失败、YAML 未写（本来也不用写）：脏标记保留。
  markSaved(session, { yaml: false, layout: false })
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: true })
  markSaved(session, { yaml: false, layout: true })
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: false })

  assert.deepEqual(setActorCommonPersona(session, 'v2'), { ok: true })
  assert.deepEqual(setNodePosition(session, undefined, 'ship', { x: 77, y: 77 }), { ok: true })
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })
  // YAML 成功、布局失败：只保留布局脏标记，不误报全部成功。
  markSaved(session, { yaml: true, layout: false })
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: true })
})

test('T1: 撤销/重做覆盖 persona 与位置，有上限', () => {
  const { session } = mustLoad()
  assert.deepEqual(setActorCommonPersona(session, 'v2'), { ok: true })
  assert.deepEqual(setNodePosition(session, undefined, 'plan', { x: 99, y: 99 }), { ok: true })
  assert.equal(undo(session), true)
  assert.notDeepEqual(getPosition(session.draft.layout, undefined, 'plan'), { x: 99, y: 99 })
  assert.equal(undo(session), true)
  assert.equal(session.draft.config.actorCommonPersona, 'Shared background.')
  assert.equal(undo(session), false)
  assert.equal(redo(session), true)
  assert.equal(session.draft.config.actorCommonPersona, 'v2')
  assert.equal(redo(session), true)
  assert.deepEqual(getPosition(session.draft.layout, undefined, 'plan'), { x: 99, y: 99 })
  assert.equal(redo(session), false)

  for (let i = 0; i < 60; i++) {
    assert.deepEqual(setNodePosition(session, undefined, 'plan', { x: i, y: i }), { ok: true })
  }
  assert.ok(session.past.length <= 50, `历史超过上限：${session.past.length}`)
})

test('T1: 撤销/重做恢复脏标记——纯布局撤销后保存只写布局', () => {
  const { session } = mustLoad()
  assert.deepEqual(setNodePosition(session, undefined, 'plan', { x: 11, y: 22 }), { ok: true })
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: true })
  assert.equal(undo(session), true)
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: false })
  assert.equal(redo(session), true)
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: true })

  // 业务改动撤销后回到撤销前的脏状态（此处仍有布局改动，只写布局）。
  assert.deepEqual(setActorCommonPersona(session, 'v2'), { ok: true })
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })
  assert.equal(undo(session), true)
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: true })
  assert.equal(undo(session), true)
  assert.deepEqual(savePlan(session), { writeYaml: false, writeLayout: false })
  assert.equal(redo(session), true)
  assert.equal(redo(session), true)
  assert.deepEqual(savePlan(session), { writeYaml: true, writeLayout: true })
})

test('T1: 保存前验证作用于副本，不原地改写页面草稿', () => {
  const { session } = mustLoad()
  const plan = session.draft.config.workflow.nodes['plan']
  assert.ok(plan !== undefined && plan.execution.type === 'actor-task')
  if (plan.execution.type === 'actor-task') {
    (plan as { results: Record<string, { criteria: string }> }).results['succeeded']!.criteria = '  padded  '
  }
  const before = JSON.stringify(session.draft.config)
  assert.equal(validateDraft(session).ok, true)
  assert.equal(JSON.stringify(session.draft.config), before, '验证改写了页面草稿')
})

test('T1: 非法配置、未知字段、禁用语法、悬空引用、非法入口拒绝进入编辑', () => {
  const bad: Array<[string, string]> = [
    ['旧版本', RICH_CONFIG.replace('agent-workflow/v3', 'agent-workflow/v2')],
    ['未知字段', RICH_CONFIG.replace('actorCommonPersona: Shared background.', 'actorCommonPersona: Shared background.\nbrandNewField: 1')],
    ['禁用锚点', 'anchor: &a [1, 2]\n' + RICH_CONFIG.replace('actorCommonPersona: Shared background.', 'actorCommonPersona: Shared background.\ncopy: *a')],
    ['悬空目标', RICH_CONFIG.replace('target: { node: build } }', 'target: { node: ghost } }')],
    ['非法入口', RICH_CONFIG.replace('startNode: plan', 'startNode: ghost')],
    ['onReturn 缺映射', RICH_CONFIG.replace('onReturn: { shipped: { return: built } }', 'onReturn: {}')],
    ['非法 workflowId', RICH_CONFIG],
  ]
  for (const [label, text] of bad) {
    const id = label === '非法 workflowId' ? 'Bad_Id' : 'review'
    const loaded = loadDraft(id, text)
    assert.equal(loaded.ok, false, `${label} 应当被拒绝`)
    if (!loaded.ok) assert.ok(loaded.problems.length > 0, `${label} 缺少诊断`)
  }
})

test('T1: 直接自环拒绝进入图形编辑（编辑器限制，不改 Runtime 合同）', () => {
  // ship 的 onReturn 指向自身：可达性不变（validator 通过），编辑器限制拒绝。
  const looped = RICH_CONFIG.replace(
    'onReturn: { shipped: { return: built } }',
    'onReturn: { shipped: { node: ship } }',
  )
  const loaded = loadDraft('review', looped)
  assert.equal(loaded.ok, false)
  if (!loaded.ok) {
    assert.ok(loaded.problems.some(p => p.includes('直接指向自身')), JSON.stringify(loaded.problems))
    assert.ok(loaded.problems.some(p => p.includes('不改变 Runtime 自环合同')), JSON.stringify(loaded.problems))
  }
  // Runtime 合同本身仍允许直接自环（validateAndNormalize 不拒绝）：反证编辑器限制未外溢。
  const parsed = validateAndNormalize(parseCatalogConfig(looped), { workflowId: 'review' })
  assert.ok(parsed.workflow.nodes['build'] !== undefined)
})

test('T1: 布局文件名自动关联；损坏警告回退；缺坐标补位；陈旧记录剪枝', () => {
  assert.equal(layoutFilenameFor('review.yaml'), 'review.layout.json')
  assert.equal(layoutFilenameFor('review.yml'), undefined)
  assert.equal(layoutFilenameFor('review'), undefined)

  const broken = parseLayoutFile('not json{{{')
  assert.equal(broken.corrupted, true)
  assert.ok(broken.warnings.length > 0)

  const partial = parseLayoutFile(JSON.stringify({
    version: 1,
    main: { plan: { x: 1, y: 2 }, build: { x: 'oops', y: 1 }, stale: { x: 9, y: 9 } },
    children: { release: 'oops' },
  }))
  assert.equal(partial.corrupted, true)
  assert.deepEqual(partial.layout.main['plan'], { x: 1, y: 2 })
  assert.equal('build' in partial.layout.main, false)
  const { session } = mustLoad(JSON.stringify({
    version: 1,
    main: { plan: { x: 1, y: 2 } },
    children: {},
  }))
  // 缺坐标补位完成，陈旧记录读取时忽略。
  assert.ok(getPosition(session.draft.layout, undefined, 'build') !== undefined)
  assert.equal(getPosition(session.draft.layout, undefined, 'stale'), undefined)
  // 保存时陈旧记录被剪枝（不写回未知节点）。
  const text = serializeLayout(session.draft.config, session.draft.layout)
  assert.equal('stale' in (JSON.parse(text).main as Record<string, unknown>), false)
  assert.deepEqual((JSON.parse(text).main as Record<string, unknown>)['plan'], { x: 1, y: 2 })
})

test('T1: fillMissingPositions 覆盖全部流程', () => {
  const config = validateAndNormalize(parseCatalogConfig(RICH_CONFIG), { workflowId: 'review' })
  const layout = emptyLayout()
  const filled = fillMissingPositions(config, layout)
  assert.equal(filled, 6)
})

test('T1: RPC 只接受受限文本/JSON，拒绝路径式与超限输入', () => {
  const parsed = rpcParseText('review', RICH_CONFIG)
  assert.equal(parsed.ok, true)
  const looped = rpcParseText('review', RICH_CONFIG.replace(
    'onReturn: { shipped: { return: built } }',
    'onReturn: { shipped: { node: ship } }',
  ))
  assert.equal(looped.ok, false)
  if (!looped.ok) assert.equal(looped.error.code, 'editor/self-loop')
  assert.equal(rpcParseText('Bad_Id', RICH_CONFIG).ok, false)
  assert.deepEqual(rpcParseText('review', 'x'.repeat(600 * 1024)),
    { ok: false, error: { code: 'editor/text-too-large', message: '文本超过 524288 字节上限', details: {} } })

  const handler = createEditorRpcHandler()
  return (async () => {
    const unknown = await handler('rm', {})
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.error.code, 'editor/unknown-endpoint')
    // payload 无路径字段可传：多余键被忽略，不会触发任何服务端文件读取。
    const withPath = await handler('parse', { workflowId: 'review', text: RICH_CONFIG, path: '/etc/passwd' })
    assert.equal(withPath.ok, true)
    const validated = await handler('validate', {
      workflowId: 'review',
      config: validateAndNormalize(parseCatalogConfig(RICH_CONFIG), { workflowId: 'review' }),
    })
    assert.equal(validated.ok, true)
  })()
})

test('T1: RPC 校验副本语义——调用方对象不被改写', () => {
  const config = validateAndNormalize(parseCatalogConfig(RICH_CONFIG), { workflowId: 'review' })
  const before = JSON.stringify(config)
  const result = rpcValidateConfig('review', config)
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(config), before, 'RPC 校验改写了调用方对象')
})

test('T1: RPC 预览对暂时非法草稿标记并返回 YAML', () => {
  const config = validateAndNormalize(parseCatalogConfig(RICH_CONFIG), { workflowId: 'review' })
  const good = rpcPreview(config)
  assert.equal(good.ok, true)
  if (good.ok) assert.deepEqual((good.value as { problems: string[] }).problems, [])
  const broken = structuredClone(config) as unknown as Record<string, unknown>
  ;(broken['workflow'] as Record<string, unknown>)['startNode'] = 'ghost'
  const preview = rpcPreview(broken)
  assert.equal(preview.ok, true)
  if (preview.ok) {
    const value = preview.value as { yaml: string; problems: string[] }
    assert.ok(value.problems.length > 0)
    assert.ok(value.yaml.includes('ghost'))
  }
})

test('T1: RPC layout 端点单源解析布局（缺文件补位/损坏回退）', async () => {
  const config = validateAndNormalize(parseCatalogConfig(RICH_CONFIG), { workflowId: 'review' })
  const missing = rpcResolveLayout(config, undefined)
  assert.equal(missing.ok, true)
  if (missing.ok) {
    const value = missing.value as { layout: { main: Record<string, unknown> }; warnings: string[]; filled: number }
    assert.equal(value.filled, 6)
    assert.deepEqual(value.warnings, [])
    assert.ok(value.layout.main['plan'] !== undefined)
  }
  const broken = rpcResolveLayout(config, 'not json{{{')
  assert.equal(broken.ok, true)
  if (broken.ok) {
    assert.ok((broken.value as { warnings: string[] }).warnings.length > 0)
  }
  const bad = rpcResolveLayout({ nope: 1 }, undefined)
  assert.equal(bad.ok, false)
  const handler = createEditorRpcHandler()
  const viaHandler = await handler('layout', { config, layoutText: undefined }, AbortSignal.timeout(5000))
  assert.equal(viaHandler.ok, true)
})

test('T1: RPC 注册在无 connection 时跳过，有 connection 时挂载指定 channel', async () => {
  assert.deepEqual(registerEditorRpc({ get: () => undefined }), { status: 'skipped-no-connection' })
  let seenChannel = ''
  let seenHandler: ((e: string, p: unknown, s: AbortSignal) => Promise<unknown>) | undefined
  const registration = registerEditorRpc({
    get: (name: string) => name === 'connection'
      ? {
        rpc: {
          handle: (channel: string, handler: (e: string, p: unknown, s: AbortSignal) => Promise<unknown>) => {
            seenChannel = channel
            seenHandler = handler
            return async () => {}
          },
        },
      }
      : undefined,
  })
  assert.equal(registration.status, 'registered')
  assert.equal(seenChannel, EDITOR_RPC_CHANNEL)
  assert.ok(typeof (registration as { dispose?: unknown }).dispose === 'function')
  const result = await seenHandler!('parse', { workflowId: 'review', text: RICH_CONFIG }, AbortSignal.timeout(5000))
  assert.equal((result as { ok: boolean }).ok, true)
})
