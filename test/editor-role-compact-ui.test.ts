import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { bundleSources } from '../web-client/build.mjs'
import { findRoleRefs } from '../web-client/src/edits.js'
import { EDITOR_STYLES } from '../web-client/src/styles.js'

// 执行真实 RoleSection 渲染，不复制可见性逻辑，也不依赖浏览器或 React 安装。
function renderRole(reuse?: string, compactBeforeReuse = false, busy = false) {
  const { RoleSection } = runInNewContext(`${bundleSources().panel}\n({ RoleSection })`, {
    require: () => ({ createElement: (type, props, ...children) => ({ type, props, children }) }),
    __rpc: {}, __edits: { findRoleRefs }, __styles: {}, __modelSelector: {}, __graphCanvas: { NodeCanvas: () => null },
  })
  const changes: boolean[] = []
  const tree = RoleSection({
    draft: { roles: { worker: { persona: 'Work.', reuse, compactBeforeReuse } }, workflow: { nodes: {} } },
    roleForm: { sel: 'worker', reuse: reuse ?? 'node', compactBeforeReuse },
    newRole: { id: '', persona: '' }, busy,
    onCompact: (value: boolean) => changes.push(value),
  })
  const nodes: typeof tree[] = []
  function walk(node: typeof tree) {
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  return { nodes, changes }
}

test('角色 node（含缺省）不渲染复用前压缩，continuable 才显示', () => {
  for (const reuse of [undefined, 'node', 'continuable']) {
    const { nodes } = renderRole(reuse)
    assert.equal(nodes.filter(node => node.props?.type === 'checkbox').length,
      reuse === 'continuable' ? 1 : 0, `reuse=${reuse}`)
  }
})

test('压缩复选框在可点击标签内，保留关闭值、变更回调和忙碌禁用', () => {
  const { nodes, changes } = renderRole('continuable')
  const checkbox = nodes.find(node => node.props?.type === 'checkbox')!
  const label = nodes.find(node => node.type === 'label' && node.children.includes(checkbox))
  assert.ok(label, '文字和复选框应在同一个 label 内')
  assert.equal(label.props.className, 'wf-compact-toggle')
  assert.equal(checkbox.props.checked, false)
  checkbox.props.onChange({ target: { checked: true } })
  assert.deepEqual(changes, [true])
  assert.equal(renderRole('continuable', true, true).nodes.find(node => node.props?.type === 'checkbox').props.disabled, true)
  assert.match(EDITOR_STYLES, /label\.wf-compact-toggle\s*\{[^}]*display:\s*flex/)
  assert.match(EDITOR_STYLES, /\.wf-compact-toggle input\[type="checkbox"\]\s*\{[^}]*width:\s*auto/)
})
