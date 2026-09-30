/**
 * Issue #173：派发上下文统一提供 Run 材料目录 `<workspace>/.dsh/.dsh-workflow/runs/<runId>/`。
 *
 * - 纯函数：用绑定 workspace + runId 计算目录，不猜 cwd、不推断 Git 根。
 * - 引擎：每次 actor-task 派发（Manager/Actor）文本统一附带 runId + 目录 + 简短规则。
 * - Judge：packet 携带绑定 workspace，prompt 含同一份材料段。
 * - 投影：材料段不泄漏进 Judge transcript（instruction 后截断），固定后缀剥离不受影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runArtifactsDir, runMaterialsSection, SUBMISSION_CONSTRAINT } from '../src/engine/texts.ts'
import { compressDispatchToHandoff } from '../src/judge/projection.ts'
import { renderJudgePrompt } from '../src/judge/checker.ts'
import { runMaterialsSection as hostSection } from '../src/engine/texts.ts'
import { WorkflowEngine, type JudgeSpawnInput, type SubagentHost } from '../src/engine/engine.ts'
import { StateStore } from '../src/state/store.ts'
import { makeStateHost } from '../src/plugin/host.ts'
import type { ExecutionDispatch, WorkflowConfig } from '../src/types.ts'

test('目录用绑定 workspace + runId 计算，不猜 cwd', () => {
  assert.equal(runArtifactsDir('C:\\ws', 'run-1'), 'C:\\ws/.dsh/.dsh-workflow/runs/run-1/')
  assert.equal(runArtifactsDir('/repo/', 'abc'), '/repo/.dsh/.dsh-workflow/runs/abc/')
  assert.equal(runArtifactsDir('ws', 'x'), 'ws/.dsh/.dsh-workflow/runs/x/')
})

test('材料段含 runId/目录/简短规则，不强制 run.md', () => {
  const section = runMaterialsSection('ws', 'run-9')
  assert.match(section, /runId: run-9/)
  assert.match(section, /dir: ws\/\.dsh\/\.dsh-workflow\/runs\/run-9\//)
  assert.match(section, /按需创建/)
  assert.match(section, /不预建空报告/)
  assert.match(section, /不强制生成 run\.md/)
  assert.match(section, /保持原归属不变/)
})

const config: WorkflowConfig = {
  schemaVersion: 'agent-workflow/v3', roles: { worker: { persona: 'do work' } }, judgeRole: { persona: 'readonly' },
  workflow: { startNode: 'first', returns: ['done'],
    nodes: {
      first: {
        execution: { type: 'actor-task', role: 'manager', instruction: 'Start' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } },
        results: { succeeded: { criteria: 'The start is verified.', target: { node: 'job' } } },
      },
      job: {
        execution: { type: 'actor-task', role: 'worker', instruction: 'Do it' },
        checker: { checkerId: 'judge.claim-correct', config: { criteria: 'verified' } },
        results: { succeeded: { criteria: 'The job is verified.', target: { return: 'done' } } },
      },
    } },
}

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'run-artifacts-'))
  const store = new StateStore(home)
  let sequence = 0
  const managerTexts: string[] = []
  const actorTexts: string[] = []
  const packets: JudgeSpawnInput[] = []
  const subagents: SubagentHost = {
    ensureRoleActor: async (_run, _role, text) => {
      actorTexts.push(text)
      return { childId: 'actor-1', messageId: `actor-${++sequence}` }
    },
    startJudge: async (_run, input) => { packets.push(structuredClone(input)); return { judgeSessionId: input.judgeSessionId, messageId: `judge-${++sequence}` } },
    followupJudge: async (_run, _id, input) => { packets.push(structuredClone(input)); return { messageId: `judge-${++sequence}` } },
    judgeSessionAvailability: async () => 'available', roleSessionAvailability: async () => 'available',
    retireJudge: async () => {}, drainJudge: async () => {}, drainRoleActor: async () => {}, compactRoleActor: async () => ({ ok: true }), safeToInspect: async () => 'safe',
  }
  const engine = new WorkflowEngine({
    steerManager: async (_run, text) => { managerTexts.push(text); return { messageId: `manager-${++sequence}` } },
    sendRoleActor: async () => { throw new Error('unexpected followup') }, managerSessionSeq: () => 0,
  }, subagents, { run: async () => ({ kind: 'ERROR' }) }, makeStateHost(store))
  engine.cwdResolver = async () => `${home}-cwd`
  const caller = (dispatch: ExecutionDispatch) => ({ sessionId: dispatch.sessionId!, turnUserMessageIds: new Set([dispatch.messageId!]) })
  return { engine, managerTexts, actorTexts, packets, caller, home, row: async () => (await store.get('ws'))!, close: () => { store.close(); rmSync(home, { recursive: true, force: true }) } }
}

async function acceptFirst(h: ReturnType<typeof harness>) {
  const engine = h.engine
  await engine.startRun('ws', engine.buildInitialRun('manager', 'test', config, 'hash'))
  const first = await h.row()
  const manager = h.caller(first.execution.dispatch!)
  assert.equal((await engine.handleClaim('ws', { result: 'succeeded', handoff: '起步交付' }, manager)).ok, true)
  await engine.handleTurnEnded('ws', manager)
  const checking = await h.row()
  const judge = h.caller(checking.execution.judge!)
  assert.equal((await engine.handleJudgeClaim('ws', checking.execution.nodeToken, 'ACCEPT', 'verified', judge)).ok, true)
  await engine.handleTurnEnded('ws', judge)
}

test('Manager 与 Actor 派发文本都附带绑定 workspace 算出的材料目录（不用 cwd）', async () => {
  const h = harness()
  try {
    await acceptFirst(h)
    const runId = (await h.row()).run.runId
    assert.equal(h.managerTexts.length, 1)
    assert.equal(h.actorTexts.length, 1)
    for (const text of [...h.managerTexts, ...h.actorTexts]) {
      assert.match(text, /\[run-materials\]/)
      assert.ok(text.includes(`dir: ws/.dsh/.dsh-workflow/runs/${runId}/`))
      assert.ok(!text.includes(h.home), '不得用 cwd 猜测目录')
      // 固定后缀仍在末尾：投影剥离不受影响。
      assert.ok(text.endsWith(SUBMISSION_CONSTRAINT))
    }
  } finally { h.close() }
})

test('Judge packet 携带绑定 workspace；prompt 含同一目录', async () => {
  const h = harness()
  try {
    await acceptFirst(h)
    const engine = h.engine
    // worker 节点已派发：claim 后 turn 结算触发 Judge spawn。
    const working = await h.row()
    const actor = h.caller(working.execution.dispatch!)
    assert.equal((await engine.handleClaim('ws', { result: 'succeeded', handoff: '交付证据' }, actor)).ok, true)
    await engine.handleTurnEnded('ws', actor)
    assert.equal(h.packets.length, 2)
    assert.equal(h.packets[1]!.workspace, 'ws')
    const runId = (await h.row()).run.runId
    const prompt = renderJudgePrompt({
      nodeToken: 'tok', criteria: 'verified', result: 'succeeded', resultCriteria: 'ok',
      workerHandoff: 'done', workspaceCwd: 'cwd', transcript: '',
      runMaterials: runMaterialsSection(h.packets[1]!.workspace, runId).trim(),
    })
    assert.ok(prompt.includes(`dir: ws/.dsh/.dsh-workflow/runs/${runId}/`))
  } finally { h.close() }
})

test('Judge prompt 的材料段与派发侧同一单源', () => {
  const prompt = renderJudgePrompt({
    nodeToken: 'tok', criteria: 'verified', result: 'succeeded', resultCriteria: 'ok',
    workerHandoff: 'done', workspaceCwd: 'C:\\ws', transcript: '',
    runMaterials: hostSection('C:\\ws', 'run-1').trim(),
  })
  assert.ok(prompt.includes('dir: C:\\ws/.dsh/.dsh-workflow/runs/run-1/'))
  assert.ok(prompt.includes('runId: run-1'))
})

test('材料段不进 Judge 投影：instruction 后截断，后缀剥离不受影响', () => {
  const dispatch = `[handoff]\nroot request\n\n[instruction]\nPlan${runMaterialsSection('ws', 'r')}${SUBMISSION_CONSTRAINT}`
  assert.equal(compressDispatchToHandoff(dispatch), '[handoff]\nroot request')
  assert.ok(dispatch.endsWith(SUBMISSION_CONSTRAINT))
})
