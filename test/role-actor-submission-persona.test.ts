/**
 * Issue #226：Role Actor 固定提交协议迁入 system persona，派发去重。
 *
 * 验收边界在本文件内按名称区分：
 * - “协议文本已冻结”：常量覆盖提交/交接/收尾/REJECT 合约，不含 runId 等
 *   易变事实，不含派发尾的 send_message 忽略句，不把"最后一个动作"表述成
 *   宿主自动阻止；
 * - “system persona 已组合”：公共 → 角色 → 固定协议，各恰一次；Judge 与
 *   Manager 不受影响；重复组合不叠加；
 * - “派发已去重”：Role 派发不再带 [提交要求]，Manager 派发保留 manager 变体；
 * - “投影兼容历史”：旧后缀仍被剥离，新 Role 派发投影干净；
 * - “复用路径已确保”：followup 经 sendRoleActor 幂等重建同 id preset
 *   （覆盖不经压缩的复用路径）， persona 协议恰一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import { MessageId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deliverSubagentPrompt, type HostPromptDeliverer } from '@deepseek-ai/dsh-subagent/internal'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize } from '../src/catalog/validate.ts'
import { ROLE_ACTOR_SUBMISSION_PROTOCOL, MANAGER_SUBMISSION_CONSTRAINT, SUBMISSION_CONSTRAINT } from '../src/engine/texts.ts'
import { roleActorPersona, ACTOR_PERSONA_SEPARATOR, judgeSpawnPlan } from '../src/roles/roles.ts'
import { compressDispatchToHandoff, projectSessionSurface } from '../src/judge/projection.ts'
import { makeDispatchTargets, makeStateHost, type HostAdapters } from '../src/plugin/host.ts'
import { RolePresetBook } from '../src/plugin/presets.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { StateStore } from '../src/state/store.ts'
import { newNodeToken } from '../src/state/invariants.ts'
import type { RunState, WorkflowConfig } from '../src/types.ts'
import { testParticipants } from './helpers/participants.ts'

const COMMON = '所有执行角色共同遵守的 system 约定。'
const DEV_PERSONA = '开发角色专属职责。'

function configText(extraTop = ''): string {
  return `schemaVersion: agent-workflow/v3
${extraTop}roles:
  developer:
    persona: ${DEV_PERSONA}
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
        succeeded: { criteria: The plan is complete., target: { node: work } }
    work:
      execution: { type: actor-task, role: developer, instruction: Build it. }
      checker: { checkerId: judge.claim-correct, config: { criteria: PASS. } }
      results:
        succeeded: { criteria: The build is complete., target: { return: done } }
`
}

function normalized(text: string): WorkflowConfig {
  return validateAndNormalize(parseCatalogConfig(text), { workflowId: 'role-submission-persona-wf' })
}

function makeRun(config: WorkflowConfig): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'manager',
    catalogWorkflowId: 'role-submission-persona-wf',
    definitionHash: 'hash',
    definitionSnapshot: config,
    status: 'running',
    callStack: [{ workflowId: 'role-submission-persona-wf', nodeId: 'plan', nodeToken: newNodeToken(), executionId: 'exec-1' }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    currentExecutionId: 'exec-1',
  }
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

// ── 协议文本已冻结 ────────────────────────────────────────────────────

test('#226 协议文本已冻结：覆盖提交/交接/收尾/REJECT 合约', () => {
  for (const clause of [
    'node_claim({ result, handoff })',
    '共用的完整交接',
    '最后一个动作',
    '工具确认成功后立即结束',
    'node_block',
    '不伪报',
    '收到 Judge REJECT 后',
    '可选择另一个合法结果',
    '分歧',
    '文字总结或向父会话汇报不能代替工作流提交',
    '不禁止任务必需的协作通信',
  ]) {
    assert.ok(ROLE_ACTOR_SUBMISSION_PROTOCOL.includes(clause), `固定协议缺条款: ${clause}`)
  }
})

test('#226 协议文本已冻结：无易变事实与派发尾专属表述', () => {
  assert.doesNotMatch(ROLE_ACTOR_SUBMISSION_PROTOCOL, /runId/)
  assert.doesNotMatch(ROLE_ACTOR_SUBMISSION_PROTOCOL, /send_message/)
  assert.doesNotMatch(ROLE_ACTOR_SUBMISSION_PROTOCOL, /以下汇报的说明可以忽略/)
  // "最后一个动作"只表述 Actor 自律，不得表述成宿主会自动阻止或撤销后续输出。
  assert.doesNotMatch(ROLE_ACTOR_SUBMISSION_PROTOCOL, /其余输出全部无效/)
})

// ── system persona 已组合 ─────────────────────────────────────────────

test('#226 system persona 已组合：缺省公共 persona 时角色 persona → 固定协议', () => {
  const run = makeRun(normalized(configText()))
  assert.equal(roleActorPersona(run, 'developer'), `${DEV_PERSONA}${ACTOR_PERSONA_SEPARATOR}${ROLE_ACTOR_SUBMISSION_PROTOCOL}`)
  assert.equal(occurrences(roleActorPersona(run, 'developer'), ROLE_ACTOR_SUBMISSION_PROTOCOL), 1)
})

test('#226 system persona 已组合：公共 → 角色 → 固定协议，各恰一次', () => {
  const run = makeRun(normalized(configText(`actorCommonPersona: ${COMMON}\n`)))
  const persona = roleActorPersona(run, 'developer')
  assert.equal(persona, `${COMMON}${ACTOR_PERSONA_SEPARATOR}${DEV_PERSONA}${ACTOR_PERSONA_SEPARATOR}${ROLE_ACTOR_SUBMISSION_PROTOCOL}`)
  assert.ok(persona.indexOf(COMMON) < persona.indexOf(DEV_PERSONA))
  assert.ok(persona.indexOf(DEV_PERSONA) < persona.indexOf(ROLE_ACTOR_SUBMISSION_PROTOCOL))
  assert.equal(occurrences(persona, COMMON), 1)
  assert.equal(occurrences(persona, DEV_PERSONA), 1)
  assert.equal(occurrences(persona, ROLE_ACTOR_SUBMISSION_PROTOCOL), 1)
})

test('#226 system persona 已组合：重复组合不叠加、快照不被改写', () => {
  const run = makeRun(normalized(configText(`actorCommonPersona: ${COMMON}\n`)))
  const first = roleActorPersona(run, 'developer')
  assert.equal(roleActorPersona(run, 'developer'), first)
  assert.equal(run.definitionSnapshot.roles['developer']!.persona, DEV_PERSONA)
  const reloaded = makeRun(structuredClone(run.definitionSnapshot))
  assert.equal(roleActorPersona(reloaded, 'developer'), first)
})

test('#226 Judge 与 Manager 不受影响：judge persona 不含固定协议', () => {
  const run = makeRun(normalized(configText(`actorCommonPersona: ${COMMON}\n`)))
  assert.equal(judgeSpawnPlan(run).persona, 'Judge persona.')
  assert.equal(judgeSpawnPlan(run).persona.includes(ROLE_ACTOR_SUBMISSION_PROTOCOL), false)
})

// ── 派发已去重 ────────────────────────────────────────────────────────

test('#226 派发已去重：Role 无固定后缀，Manager 保留 manager 变体', async () => {
  const config = normalized(configText())
  const home = mkdtempSync(join(tmpdir(), 'workflow-226-dispatch-'))
  const store = new StateStore(home)
  try {
    const managerTexts: string[] = []
    const actorTexts: string[] = []
    let serial = 0
    const send = () => ({ messageId: `message-${++serial}` })
    const engine = new WorkflowEngine(
      {
        async steerManager(_run, text) { managerTexts.push(text); return send() },
        async sendRoleActor(_run, _role, text) { actorTexts.push(text); return send() },
        managerSessionSeq() { return 0 },
      },
      {
        async ensureRoleActor(_run, _role, text) { actorTexts.push(text); return { ...send(), childId: 'dev-session' } },
        async startJudge(_run, input) { return { ...send(), judgeSessionId: input.judgeSessionId } },
        async followupJudge() { return send() },
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
    const caller = (dispatch: { sessionId?: string; messageId?: string }) => ({
      sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]),
    })
    assert.equal((await engine.startRun('ws', engine.buildInitialRun('manager', 'role-submission-persona-wf', config, 'hash'), undefined, 'root input')).ok, true)
    const first = (await store.get('ws'))!
    const manager = caller(first.execution.dispatch!)
    const claimed = await engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)
    assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.reason)
    await engine.handleTurnEnded('ws', manager)
    const checking = (await store.get('ws'))!
    const judge = caller(checking.execution.judge!)
    const judged = await engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)
    assert.equal(judged.ok, true)
    await engine.handleTurnEnded('ws', judge)

    // Manager 派发行为保持原样（node-event 通知另行计数）。
    const managerDispatches = managerTexts.filter(text => !text.startsWith('[node-event]'))
    assert.equal(managerDispatches.length, 1)
    assert.ok(managerDispatches[0]!.endsWith(MANAGER_SUBMISSION_CONSTRAINT))

    // work 节点派发给 Role：固定提交协议副本已移除，动态材料完整保留。
    assert.equal(actorTexts.length, 1)
    const actorText = actorTexts[0]!
    assert.doesNotMatch(actorText, /\[提交要求\]/)
    assert.doesNotMatch(actorText, /node_claim/)
    assert.match(actorText, /^\[handoff\]\n/)
    assert.match(actorText, /\[instruction\]\nBuild it\./)
    assert.match(actorText, /\[run-materials\]/)
    assert.match(actorText, /\[合法结果与各自条件\]\n- succeeded：The build is complete\./)
  } finally {
    store.close()
    rmSync(home, { recursive: true, force: true })
  }
})

// ── 投影兼容历史 ──────────────────────────────────────────────────────

function sessionWith(text: string): Session {
  const session = Session.create('sess-226' as SessionId)
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  ;(session.append as (t: string, d: unknown, ...opts: unknown[]) => unknown)('user/message', message, { surfaceOp: 'append' } as never)
  return session
}

test('#226 投影兼容历史：旧后缀仍被剥离', () => {
  for (const variant of [SUBMISSION_CONSTRAINT, MANAGER_SUBMISSION_CONSTRAINT]) {
    const out = projectSessionSurface(sessionWith(`[instruction]\nBuild it.${variant}`), 0, 'ACTOR')
    assert.equal(out.length, 1)
    assert.match(out[0]!.text, /Build it\./)
    assert.doesNotMatch(out[0]!.text, /提交要求/)
    assert.doesNotMatch(out[0]!.text, /node_claim/)
  }
})

test('#226 投影兼容历史：新 Role 派发（无后缀）压缩后只留 handoff', () => {
  const dispatch = '[handoff]\nroot request\n\n[instruction]\nBuild it.\n\n[run-materials]\nrunId: r\ndir: ws/.dsh/.dsh-workflow/runs/r/'
  assert.equal(compressDispatchToHandoff(dispatch), '[handoff]\nroot request')
  const out = projectSessionSurface(sessionWith(dispatch), 0, 'ACTOR')
  assert.equal(out.length, 1)
  assert.doesNotMatch(out[0]!.text, /提交要求/)
})

// ── 复用路径已确保 ────────────────────────────────────────────────────

test('#226 复用路径已确保：followup 经 sendRoleActor 幂等重建同 id preset', async () => {
  const run = makeRun(normalized(configText()))
  run.roleActors = { developer: 'sess-dev' }
  const manager = { session: { id: 'manager', seq: 0, snapshotEvents: () => [], header: { cwd: 'cwd' } } } as unknown as Agent
  const deliveries: string[] = []
  const registered: Array<{ id: string; prefix: string }> = []
  const queue: HostPromptDeliverer = {
    async [deliverSubagentPrompt](_parent, childId, _content, _source, _signal) {
      deliveries.push(String(childId))
      return MessageId(`message-${deliveries.length}`)
    },
  }
  const adapters: HostAdapters = {
    ctx: {
      subagents: queue,
      get: (key: string) => key === 'agentPresets' ? {
        composedPreset: () => undefined,
        readDocument: async () => ({ agentPreset: 'parent', content: '' }),
        async register(definition: { id: string; plugins: Array<{ name: string; config?: { prefix?: string } }> }) {
          const persona = definition.plugins.find(row => row.name === '@deepseek-ai/dsh-persona')
          registered.push({ id: definition.id, prefix: persona?.config?.prefix ?? '' })
          return async () => {}
        },
      } : undefined,
      tools: { schemas: () => [] },
      jobs: { events: { subscribe: () => () => {} } },
      effect: () => {},
    } as unknown as Context,
    managerAgentOf: () => manager,
    registerJudgeSession: () => {},
    revokeJudgeSession: () => {},
    registerRoleActorSession: () => {},
    presets: new RolePresetBook(),
  }
  const dispatch = makeDispatchTargets(adapters)
  await dispatch.sendRoleActor(run, 'developer', 'second node')
  await dispatch.sendRoleActor(run, 'developer', 'third node')
  assert.deepEqual(deliveries, ['sess-dev', 'sess-dev'])
  // 同一进程内幂等：只注册一次，persona 协议恰一次。
  assert.equal(registered.length, 1)
  assert.match(registered[0]!.id, /-developer$/)
  assert.equal(occurrences(registered[0]!.prefix, ROLE_ACTOR_SUBMISSION_PROTOCOL), 1)
  assert.ok(registered[0]!.prefix.startsWith(DEV_PERSONA))
  // 进程重启后（新台账）followup 重建同 id preset，内容一致。
  adapters.presets = new RolePresetBook()
  await dispatch.sendRoleActor(run, 'developer', 'after restart')
  assert.equal(registered.length, 2)
  assert.equal(registered[1]!.id, registered[0]!.id)
  assert.equal(registered[1]!.prefix, registered[0]!.prefix)
})

test('#226 复用路径已确保：preset 服务缺席时 followup 仍派发（降级）', async () => {
  const run = makeRun(normalized(configText()))
  run.roleActors = { developer: 'sess-dev' }
  const manager = { session: { id: 'manager', seq: 0, snapshotEvents: () => [] } } as unknown as Agent
  const queue: HostPromptDeliverer = {
    async [deliverSubagentPrompt]() { return MessageId('message-1') },
  }
  const adapters: HostAdapters = {
    ctx: {
      subagents: queue,
      jobs: { events: { subscribe: () => () => {} } },
      effect: () => {},
    } as unknown as Context,
    managerAgentOf: () => manager,
    registerJudgeSession: () => {},
    revokeJudgeSession: () => {},
    registerRoleActorSession: () => {},
    presets: new RolePresetBook(),
  }
  assert.deepEqual(await makeDispatchTargets(adapters).sendRoleActor(run, 'developer', 'next'), { messageId: 'message-1' })
})
