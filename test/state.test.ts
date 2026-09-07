import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { StateStore, StateConflictError, StateVersionError, stateDbPath } from '../src/state/store.ts'
import { checkStateInvariants, newNodeToken, topFrame } from '../src/state/invariants.ts'
import { parseCatalogConfig } from '../src/catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash } from '../src/catalog/validate.ts'
import type { RunState } from '../src/types.ts'

const CONFIG = validateAndNormalize(parseCatalogConfig(`
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
`), { workflowId: 'state-test' })

function makeRun(): RunState {
  return {
    runId: crypto.randomUUID(),
    managerSessionId: 'session-manager',
    catalogWorkflowId: 'state-test',
    definitionHash: computeDefinitionHash(CONFIG),
    definitionSnapshot: CONFIG,
    status: 'running',
    callStack: [{ workflowId: 'state-test', nodeId: 'plan', nodeToken: newNodeToken() }],
    roleActors: {},
    modelOverrides: {},
    blockReason: null,
    nodeBoundary: { dispatchedAt: 0, managerFromSeq: 0 },
  }
}

async function withStore(fn: (store: StateStore, home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'wfstate-'))
  const store = new StateStore(home)
  try {
    await fn(store, home)
  } finally {
    store.close()
    await rm(home, { recursive: true, force: true })
  }
}

test('state db path is under workflows', () => {
  assert.equal(stateDbPath('C:\\home'), join('C:\\home', 'workflows', 'state.sqlite3'))
})

test('create + get roundtrip', async () => {
  await withStore(async (store) => {
    const run = makeRun()
    const row = await store.createRow('ws-1', run)
    assert.equal(row.stateVersion, 1)
    const got = await store.get('ws-1')
    assert.ok(got)
    assert.equal(got!.run.runId, run.runId)
    assert.equal(got!.run.callStack.length, 1)
  })
})

test('incompatible state rejects access and mutations without changing original rows', async () => {
  await withStore(async (store, home) => {
    const raw = new DatabaseSync(stateDbPath(home))
    try {
      for (const status of ['running', 'completed']) {
        const snapshot = JSON.stringify({ run: {
          ...makeRun(), status,
          pendingClaim: { outcome: 'completed', summary: '旧结果', handoffContext: '原始交接\n材料' },
        } }, null, 2)
        raw.prepare('INSERT INTO workflow_state VALUES (?, ?, ?, ?, ?)')
          .run(status, 'agent-workflow-state/v1', 7, snapshot, '2026-01-01T00:00:00.000Z')
      }
      const inspect = () => raw.prepare('SELECT *, hex(snapshot_json) AS snapshot_bytes FROM workflow_state ORDER BY workspace_key').all()
      const original = inspect()
      const incompatible = /incompatible state format.*agent-workflow-state\/v1.*agent-workflow-state\/v2/i
      for (const key of ['running', 'completed']) {
        await assert.rejects(() => store.get(key), incompatible)
        await assert.rejects(() => store.list(), incompatible)
        await assert.rejects(() => store.updateRow(key, makeRun(), 7), incompatible)
        await assert.rejects(() => store.createRow(key, makeRun()), incompatible)
        await assert.rejects(() => store.deleteRow(key), incompatible)
        assert.deepEqual(inspect(), original)
      }
      store.close()
      const reopened = new StateStore(home)
      try {
        await assert.rejects(() => reopened.get('completed'), incompatible)
        assert.deepEqual(inspect(), original)
      } finally {
        reopened.close()
      }
    } finally {
      raw.close()
    }
  })
})

test('create on a running row conflicts', async () => {
  await withStore(async (store) => {
    await store.createRow('ws-1', makeRun())
    await assert.rejects(() => store.createRow('ws-1', makeRun()), StateConflictError)
  })
})

test('completed row allows a new start (overwrite)', async () => {
  await withStore(async (store) => {
    const completed = makeRun()
    completed.status = 'completed'
    completed.callStack = []
    completed.blockReason = null
    await store.createRow('ws-1', completed)
    const row = await store.createRow('ws-1', makeRun())
    assert.equal(row.stateVersion, 2)
    assert.equal(row.run.status, 'running')
  })
})

test('updateRow with stale version throws', async () => {
  await withStore(async (store) => {
    const run = makeRun()
    await store.createRow('ws-1', run)
    const copy = structuredClone(run)
    await store.updateRow('ws-1', copy, 1)
    await assert.rejects(() => store.updateRow('ws-1', copy, 1), StateVersionError)
  })
})

test('deleteRow is idempotent', async () => {
  await withStore(async (store) => {
    await store.createRow('ws-1', makeRun())
    await store.deleteRow('ws-1')
    await store.deleteRow('ws-1')
    assert.equal(await store.get('ws-1'), undefined)
  })
})

test('multiple workspaces are independent', async () => {
  await withStore(async (store) => {
    await store.createRow('ws-a', makeRun())
    await store.createRow('ws-b', makeRun())
    const list = await store.list()
    assert.equal(list.length, 2)
    await store.deleteRow('ws-a')
    assert.equal((await store.list()).length, 1)
  })
})

test('invariants: completed requires empty stack + null reason', async () => {
  const run = makeRun()
  run.status = 'completed'
  run.callStack = []
  run.blockReason = 'leftover'
  assert.ok(checkStateInvariants(run).some(p => p.includes('null blockReason')))
  run.blockReason = null
  assert.deepEqual(checkStateInvariants(run), [])
})

test('invariants: completed with non-empty stack is rejected', async () => {
  const run = makeRun()
  run.status = 'completed'
  run.blockReason = null
  assert.ok(checkStateInvariants(run).some(p => p.includes('empty callStack')))
})

test('invariants: blocked requires non-empty reason', async () => {
  const run = makeRun()
  run.status = 'blocked'
  run.blockReason = ''
  assert.ok(checkStateInvariants(run).some(p => p.includes('blockReason')))
  run.blockReason = 'because'
  assert.deepEqual(checkStateInvariants(run), [])
})

test('invariants: roleActors/modelOverrides keys are validated', async () => {
  const run = makeRun()
  run.roleActors = { ghost: 'x' }
  assert.ok(checkStateInvariants(run).some(p => p.includes('roleActors')))
  run.roleActors = {}
  run.modelOverrides = { ghost: { provider: 'p', modelId: 'm' } }
  assert.ok(checkStateInvariants(run).some(p => p.includes('modelOverrides')))
})

test('invariants: nodeToken must be UUID', async () => {
  const run = makeRun()
  run.callStack[0]!.nodeToken = 'not-a-uuid'
  assert.ok(checkStateInvariants(run).some(p => p.includes('UUID')))
})

test('topFrame returns the deepest frame', () => {
  const run = makeRun()
  run.callStack.push({ workflowId: 'child', nodeId: 'n1', nodeToken: newNodeToken() })
  assert.equal(topFrame(run).workflowId, 'child')
})
