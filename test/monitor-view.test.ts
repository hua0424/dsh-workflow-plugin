// #251 客户端监控视图模型纯函数测试 + bundle 动态注入注册断言。
// 先例：test/editor-start-modal.test.ts（直接 import web-client 纯 JS + buildClientBundle）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildClientBundle } from '../web-client/build.mjs'
import { monitorViewModel, monitorErrorState, PHASE_LABELS } from '../web-client/src/monitor-view.js'

const RUN_PAYLOAD = {
  mode: 'run',
  run: {
    runId: 'r1', workflowId: 'test', status: 'running', blockReason: null,
    businessReturn: null, launchPrompt: '启动原文',
    roles: [{ role: 'reviewer', model: { provider: 'prov', modelId: 'm-review' } }],
    flows: { test: { startNode: 'plan', returns: ['done'], nodes: [] } },
    nodes: [
      { workflowId: 'test', nodeId: 'plan', executionId: 'e1', visit: 1, revision: 3, phase: 'exited', blockReason: null, enteredAt: 't1', exitedAt: 't2', current: false },
      { workflowId: 'test', nodeId: 'review', executionId: 'e2', visit: 2, revision: 1, phase: 'working', blockReason: '等待授权', enteredAt: 't3', exitedAt: null, current: true },
    ],
  },
}

test('#251 monitorViewModel：run 投影（信息条/角色模型/节点行/焦点与 BLOCK）', () => {
  const view = monitorViewModel(RUN_PAYLOAD)
  assert.equal(view.mode, 'run')
  assert.equal(view.run.statusLabel, '运行中')
  assert.equal(view.run.launchPrompt, '启动原文')
  assert.match(view.run.roles, /reviewer=m-review@prov/)
  assert.deepEqual(view.nodes.map(node => [node.label, node.phaseLabel, node.current, node.blocked]), [
    ['test / plan', PHASE_LABELS.exited[0], false, false],
    ['test / review', PHASE_LABELS.working[0], true, true],
  ])
  assert.equal(view.nodes[1].blockReason, '等待授权')
})

test('#251 monitorViewModel：empty / maintenance / 加载中 / blocked 状态', () => {
  assert.deepEqual(monitorViewModel(undefined), { mode: 'loading' })
  assert.equal(monitorViewModel({ mode: 'empty' }).mode, 'empty')
  const maintenance = monitorViewModel({ mode: 'maintenance', maintenance: { kind: 'corrupt', reason: '库损坏' } })
  assert.equal(maintenance.mode, 'maintenance')
  assert.equal(maintenance.reason, '库损坏')
  const blocked = monitorViewModel({ ...RUN_PAYLOAD, run: { ...RUN_PAYLOAD.run, status: 'blocked', blockReason: '等用户' } })
  assert.equal(blocked.run.statusLabel, '已阻塞')
  assert.equal(blocked.run.statusClass, 'run-blocked')
  assert.equal(blocked.run.blockReason, '等用户')
  const done = monitorViewModel({ ...RUN_PAYLOAD, run: { ...RUN_PAYLOAD.run, status: 'completed', businessReturn: { name: 'done', source: 'e2' } } })
  assert.equal(done.run.businessReturn, 'done')
})

test('#251 monitorErrorState：横幅保留语义（新错误覆盖，空错误保留旧值）', () => {
  assert.equal(monitorErrorState('', '网络断开'), '网络断开')
  assert.equal(monitorErrorState('旧错误', ''), '旧错误')
  assert.equal(monitorErrorState('旧错误', '新错误'), '新错误')
})

test('#251 client bundle：动态注入注册 better-sidebar tab（不写静态 inject 导出）', async () => {
  const outFile = buildClientBundle()
  const { readFileSync } = await import('node:fs')
  const bundle = readFileSync(outFile, 'utf8')
  // 动态注入：等待 better-sidebar 服务后注册监控 tab；静态 inject 数组不含 better-sidebar。
  assert.match(bundle, /inject\(\['better-sidebar'\]/)
  assert.match(bundle, /dsh-workflow:monitor/)
  assert.match(bundle, /workflow-run-monitor/)
  assert.match(bundle, /registerTab/)
  // 保留编辑器通道静态注册（未装 better-sidebar 时配置编辑器照常）。
  assert.match(bundle, /PANEL_KEY/)
})
