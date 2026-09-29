import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { bundleSources } from '../web-client/build.mjs'

function modelModule() {
  return runInNewContext(`${bundleSources().modelSelector}\n({ modelChoices, readModelCatalog })`, {
    require: () => ({}), setTimeout, clearTimeout,
  })
}

test('模型目录保留未知配置值，选择项按 provider 隔离', () => {
  const { modelChoices } = modelModule()
  const groups = [{ id: 'a', name: 'A', models: [{ id: 'a-model', name: 'A model' }] },
    { id: 'b', name: 'B', models: [{ id: 'b-model', name: 'B model' }] }]
  const known = modelChoices(groups, 'a', 'a-model')
  assert.equal(known.models.length, 1)
  assert.equal(known.models[0].id, 'a-model')
  const unknown = modelChoices(groups, 'custom-provider', 'custom-model')
  assert.equal(unknown.providers.length, 3)
  assert.equal(unknown.models[0].id, 'custom-model')
  assert.equal(groups.length, 2)
  assert.equal(groups[0].models.length, 1)
})

test('模型目录使用公开会话 API 并显示失败，不需要 sessionId', async () => {
  const { readModelCatalog } = modelModule()
  const value = { groups: [], failures: [] }
  const session = { async modelCatalog(...args: unknown[]) {
    assert.equal(this, session)
    assert.equal(args.length, 0)
    return { ok: true, value }
  } }
  assert.equal(await readModelCatalog({ session }), value)
  await assert.rejects(readModelCatalog({ session: { modelCatalog: async () => ({ ok: false, error: { message: 'offline' } }) } }), /offline/)
  await assert.rejects(readModelCatalog({}), /未提供模型目录/)
})
