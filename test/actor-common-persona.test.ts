/**
 * Issue #140：工作流级 actorCommonPersona 注入 Role Actor system prompt。
 *
 * 验收边界在本文件内按名称区分：
 * - “Role Actor system prompt 已组合”：组合顺序 / 固定分隔符 / 缺省行为 / spawn
 *   路径 / 冷恢复一致 / 冻结快照；
 * - “Manager/Judge 未覆盖”：judgeRole.persona 与 Manager 派发文本不含公共 persona。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash, CatalogValidationError } from '../src/catalog/validate.ts'
import { CatalogSchemaError } from '../src/catalog/schema.ts'
import { roleActorPersona, ACTOR_PERSONA_SEPARATOR, judgeSpawnPlan } from '../src/roles/roles.ts'
import { makeSubagentHost, makeStateHost, type HostAdapters } from '../src/plugin/host.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { StateStore } from '../src/state/store.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState, WorkflowConfig } from '../src/types.ts'
import { testParticipants } from './helpers/participants.ts'

const COMMON = '所有执行角色共同遵守的 system 约定。'
const DEV_PERSONA = '开发角色专属职责。'
const REVIEWER_PERSONA = '审查角色专属职责。'

function configText(extraTop = ''): string {
  return `schemaVersion: agent-workflow/v3
${extraTop}roles:
  developer:
    persona: ${DEV_PERSONA}
  reviewer:
    persona: ${REVIEWER_PERSONA}
judgeRole:
  persona: Judge persona.
workflow:
  startNode: plan
  returns: [done]
  nodes:
    plan:
      execution: { type: actor-task, role: manager, instruction: Do. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: The plan is complete., target: { return: done } }
`
}

const withCommon = `actorCommonPersona: ${COMMON}\n`
const blankCommon = 'actorCommonPersona: "   "\n'
const nonStringCommon = 'actorCommonPersona: 42\n'

function normalized(text: string): WorkflowConfig {
  return validateAndNormalize(parseCatalogConfig(text), { workflowId: 'common-persona-wf' })
}

function makeRun(config: WorkflowConfig): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'manager',
    catalogWorkflowId: 'common-persona-wf',
    definitionHash: computeDefinitionHash(config),
    definitionSnapshot: config,
    status: 'running',
    callStack: [{ workflowId: 'common-persona-wf', nodeId: 'plan', nodeToken: newNodeToken(), executionId: 'exec-1' }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    currentExecutionId: 'exec-1',
  }
}

// ── Role Actor system prompt 已组合 ───────────────────────────────────────────

test('Role Actor system prompt 已组合：公共在前、角色在后、单一固定分隔符（两个角色）', () => {
  const run = makeRun(normalized(configText(withCommon)))
  assert.equal(ACTOR_PERSONA_SEPARATOR, '\n\n')
  assert.equal(roleActorPersona(run, 'developer'), `${COMMON}\n\n${DEV_PERSONA}`)
  assert.equal(roleActorPersona(run, 'reviewer'), `${COMMON}\n\n${REVIEWER_PERSONA}`)
})

test('Role Actor system prompt 缺省行为：未配置时角色 persona 原样返回', () => {
  const config = normalized(configText())
  assert.equal('actorCommonPersona' in config, false)
  const run = makeRun(config)
  assert.equal(roleActorPersona(run, 'developer'), DEV_PERSONA)
  assert.equal(roleActorPersona(run, 'reviewer'), REVIEWER_PERSONA)
})

test('Role Actor system prompt 已组合：存在时 trim 并冻结进 definition 快照', () => {
  const config = normalized(configText('actorCommonPersona: "  前后空格约定。  "\n'))
  assert.equal(config.actorCommonPersona, '前后空格约定。')
  const run = makeRun(config)
  assert.equal(roleActorPersona(run, 'developer'), '前后空格约定。\n\n开发角色专属职责。')
  // 冻结：含字段与缺省配置的 definitionHash 不同
  assert.notEqual(computeDefinitionHash(config), computeDefinitionHash(normalized(configText())))
})

test('Role Actor system prompt 已组合：公共 persona 手写提交协议关键词只警告、不阻塞', () => {
  const parsed = parseCatalogConfig(configText('actorCommonPersona: Report only through node_claim.\n'))
  const warnings: string[] = []
  const config = validateAndNormalize(parsed, { workflowId: 'w', warnings })
  assert.equal(config.actorCommonPersona, 'Report only through node_claim.')
  assert.deepEqual(warnings.length, 1)
  assert.match(warnings[0]!, /actorCommonPersona persona must not hand-write submission protocol/)
  assert.match(warnings[0]!, /node_claim/)
})

test('Role Actor system prompt 严格拒绝：空白值（schema）', () => {
  assert.throws(() => parseCatalogConfig(configText(blankCommon)), CatalogSchemaError, /actorCommonPersona/)
})

test('Role Actor system prompt 严格拒绝：非字符串（schema）', () => {
  assert.throws(() => parseCatalogConfig(configText(nonStringCommon)), CatalogSchemaError, /actorCommonPersona/)
})

test('Role Actor system prompt 严格拒绝：未知字段', () => {
  assert.throws(() => parseCatalogConfig(configText('actorCommonPersonaX: foo\n')), CatalogSchemaError, /actorCommonPersonaX/)
})

test('Role Actor system prompt 严格拒绝：绕过 schema 的空白值在静态校验期被拒', () => {
  const handBuilt = parseCatalogConfig(configText())
  handBuilt.actorCommonPersona = '   '
  assert.throws(() => validateAndNormalize(handBuilt, { workflowId: 'w' }), CatalogValidationError, /actorCommonPersona/)
})

test('Role Actor system prompt 冷恢复一致：重复组合不叠加、快照角色 persona 不被改写', () => {
  const run = makeRun(normalized(configText(withCommon)))
  const first = roleActorPersona(run, 'developer')
  const second = roleActorPersona(run, 'developer')
  assert.equal(first, second)
  assert.equal(run.definitionSnapshot.roles['developer']!.persona, DEV_PERSONA)
  // 快照重载（关库重开 / 冷物化后）得到同一组合结果
  const reloaded = makeRun(structuredClone(run.definitionSnapshot))
  assert.equal(roleActorPersona(reloaded, 'developer'), first)
})

test('Role Actor system prompt 已组合：spawn 路径使用同一组合结果（两个角色）', async () => {
  const run = makeRun(normalized(configText(withCommon)))
  const seen: string[] = []
  const manager = { session: { id: 'manager', seq: 0, snapshotEvents: () => [], header: { cwd: 'cwd' } } } as unknown as Agent
  const adapters: HostAdapters = {
    ctx: {
      subagents: {
        async startContinuable(spec: { label: string; request: { persona: string } }) {
          seen.push(`${spec.label}::${spec.request.persona}`)
          return { childId: `sess-${seen.length}`, messageId: `message-${seen.length}` }
        },
      },
      jobs: { onJobDone: () => () => {} },
      effect: () => {},
    } as unknown as Context,
    managerAgentOf: () => manager,
    registerJudgeSession: () => {},
    revokeJudgeSession: () => {},
    registerRoleActorSession: () => {},
  }
  const host = makeSubagentHost(adapters, testParticipants(adapters.ctx))
  await host.ensureRoleActor(run, 'developer', 'initial')
  await host.ensureRoleActor(run, 'reviewer', 'initial')
  assert.deepEqual(seen, [
    `workflow-role:developer::${COMMON}\n\n${DEV_PERSONA}`,
    `workflow-role:reviewer::${COMMON}\n\n${REVIEWER_PERSONA}`,
  ])
})

// ── Manager/Judge 未覆盖 ────────────────────────────────────────────────────

test('Manager/Judge 未覆盖：judge persona 与 Manager 派发文本都不含公共 persona', async () => {
  const config = normalized(configText(withCommon))
  const run = makeRun(config)
  assert.equal(judgeSpawnPlan(run).persona, 'Judge persona.')
  assert.equal(judgeSpawnPlan(run).persona.includes(COMMON), false)

  const home = mkdtempSync(join(tmpdir(), 'workflow-common-persona-'))
  const store = new StateStore(home)
  try {
    const steered: string[] = []
    const engine = new WorkflowEngine(
      {
        async steerManager(_run, text) { steered.push(text); return { messageId: 'm1' } },
        async sendRoleActor() { throw new Error('no role dispatch expected') },
        managerSessionSeq() { return 0 },
      },
      {
        async ensureRoleActor() { throw new Error('no role spawn expected') },
        async startJudge() { throw new Error('no judge expected') },
        async followupJudge() { throw new Error('no judge expected') },
        async judgeSessionAvailability() { return 'available' as const },
        async roleSessionAvailability() { return 'available' as const },
        async safeToInspect() { return 'safe' as const },
        async retireJudge() {},
        async drainJudge() {},
        async drainRoleActor() {},
        async compactRoleActor() { return { ok: true } },
      },
      { async run() { throw new Error('no programs expected') } },
      makeStateHost(store),
    )
    engine.cwdResolver = async () => home
    const started = await engine.startRun('ws', engine.buildInitialRun('manager', 'common-persona-wf', config, 'hash'), undefined, 'root input')
    assert.equal(started.ok, true)
    assert.equal(steered.length, 1)
    assert.equal(steered[0]!.includes(COMMON), false, 'Manager 派发文本不得包含公共 persona')
  } finally {
    store.close()
    rmSync(home, { recursive: true, force: true })
  }
})
