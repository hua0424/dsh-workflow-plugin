/**
 * Real-host e2e smoke: runs the smoke-test workflow through the actual
 * engine + real SQLite store + real catalog (the REAL ~/.dsh home), with ONLY
 * the model dispatch layer stubbed (steer/sendRoleActor = scripted log,
 * judge = scripted file inspection).
 *
 * Proves the full start → claim → judge → advance → deferred dispatch → END
 * loop on production code paths and the production state database.
 */
import { join } from 'node:path'
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { StateStore, workspaceKeyOf } from '../src/state/store.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { loadCatalogEntry } from '../src/catalog/loader.ts'
import { topFrame } from '../src/state/invariants.ts'

const home = resolveDshHome()
const ws = process.cwd() // run from the repo workspace
const workspaceKey = await workspaceKeyOf(ws)
if (workspaceKey === undefined) throw new Error('no workspace key')

const store = new StateStore(home)
try {
  // Fresh e2e row for the repo workspace: reset first.
  await store.deleteRow(workspaceKey)

  // Load smoke-test from the REAL catalog in the REAL home.
  const entry = await loadCatalogEntry(home, 'smoke-test')
  if (entry === undefined) throw new Error('smoke-test not found in catalog')

  const stateHost = {
    async get(key) {
      const row = await store.get(key)
      return row === undefined ? undefined : { run: row.run, version: row.stateVersion }
    },
    async put(key, run, expectedVersion) { await store.updateRow(key, run, expectedVersion) },
    async create(key, run) { const row = await store.createRow(key, run); return row.stateVersion },
    async remove(key) { await store.deleteRow(key) },
    async listRuns() { return (await store.list()).map(r => ({ workspaceKey: r.workspaceKey, run: r.run, version: r.stateVersion })) },
  }

  const dispatchLog = []
  const subagents = {
    async ensureRoleActor(_run, role, initialText) {
      dispatchLog.push(`role[${role}](create): ${initialText.split('\n')[0]}`)
      return 'actor-session-1'
    },
    async runJudge(_run, input) {
      const path = join(ws, 'smoke', 'result.txt')
      let content = ''
      if (existsSync(path)) content = readFileSync(path, 'utf8')
      const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '')
      const isHello = input.instruction.includes('Write the single line')
      const ok = isHello
        ? lines.length === 1 && lines[0] === 'smoke ok'
        : lines.length === 2 && lines[0] === 'smoke ok' && lines[1] === 'worker ok'
      return { result: ok ? 'PASS' : 'FAIL', reason: ok ? 'content matches criteria' : `content: ${JSON.stringify(content)}` }
    },
  }
  const programs = {
    async run() { return { kind: 'ERROR', reason: 'no programs in smoke-test' } },
  }
  const targets = {
    async steerManager(_run, text) { dispatchLog.push(`steer: ${text.split('\n')[0]}`) },
    async sendRoleActor(_run, role, text) { dispatchLog.push(`role[${role}]: ${text.split('\n')[0]}`) },
  }

  const engine = new WorkflowEngine(targets, subagents, programs, stateHost)
  engine.cwdResolver = async () => ws

  // 1. start
  const run = engine.buildInitialRun('manager-session-e2e', 'smoke-test', entry.config, entry.definitionHash)
  const started = await engine.startRun(workspaceKey, run)
  console.log('1. start:', started.ok, started.message, '| frame:', topFrame(started.run).nodeId, '|', started.run.status)
  console.log('   dispatch:', dispatchLog.at(-1))

  // 2. manager writes the file and claims completed
  mkdirSync(join(ws, 'smoke'), { recursive: true })
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\n', 'utf8')
  const claim1 = await engine.handleClaim(workspaceKey, {
    nodeToken: topFrame(started.run).nodeToken, outcome: 'completed', summary: 'wrote smoke/result.txt',
  }, 'manager-session-e2e')
  console.log('2. claim hello:', claim1.ok, claim1.message)
  let current = await stateHost.get(workspaceKey)
  if (current === undefined) throw new Error('row vanished after claim')
  console.log('   frame after:', topFrame(current.run).nodeId, '| deferred dispatch')

  // 3. old turn settles → dispatch the advanced node
  const settled1 = await engine.handleTurnEnded(workspaceKey, 'manager-session-e2e')
  if (settled1 !== undefined) console.log('3. turn ended:', settled1.message)
  current = await stateHost.get(workspaceKey)
  if (current === undefined) throw new Error('row vanished after turn end')
  console.log('   frame:', topFrame(current.run).nodeId, '| dispatch:', dispatchLog.at(-1))

  // 4. worker appends and claims
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\nworker ok\n', 'utf8')
  const claim2 = await engine.handleClaim(workspaceKey, {
    nodeToken: topFrame(current.run).nodeToken, outcome: 'completed', summary: 'appended worker ok',
  }, 'actor-session-1')
  console.log('4. claim worker-echo:', claim2.ok, claim2.message)
  const final = await stateHost.get(workspaceKey)
  if (final === undefined) throw new Error('row vanished at the end')
  console.log('5. FINAL:', final.run.status, '| callStack:', JSON.stringify(final.run.callStack))

  const pass = final.run.status === 'completed' && final.run.callStack.length === 0
  console.log(pass ? 'E2E SMOKE PASS' : 'E2E SMOKE FAIL')
  if (!pass) process.exitCode = 1
} finally {
  store.close()
  // Remove the synthetic harness row so the real user's run starts clean.
  const cleanup = new StateStore(home)
  await cleanup.deleteRow(workspaceKey)
  cleanup.close()
  rmSync(join(ws, 'smoke'), { recursive: true, force: true })
}
