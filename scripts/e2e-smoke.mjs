/**
 * Real-code-path e2e smoke: runs the smoke-test workflow through the actual
 * engine + real SQLite store + real catalog loader, with ONLY the model
 * dispatch layer stubbed (steer/sendRoleActor = scripted log, judge =
 * scripted file inspection).
 *
 * ISOLATION (issue #3): the harness NEVER touches the real ~/.dsh home or the
 * repo workspace's real state row. It copies smoke-test.yaml into a fresh
 * temporary DSH home and uses a synthetic workspace directory inside it; all
 * state rows and trace logs live under that temp home, which is removed at
 * the end. If a real state row exists for the repo workspace it is left
 * strictly untouched.
 *
 * Proves the full start → claim → turn-settles-mid-judgment → async verdict →
 * immediate dispatch → END loop on production code paths (the REAL ordering:
 * the worker's turn ends before the continuable Judge's verdict arrives), plus
 * the run trace log (PRD workflow-run-logging AC1/AC2/AC5).
 */
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { StateStore, workspaceKeyOf } from '../src/state/store.ts'
import { WorkflowEngine } from '../src/engine/engine.ts'
import { loadCatalogEntry } from '../src/catalog/loader.ts'
import { topFrame } from '../src/state/invariants.ts'

// ---- Isolated environment (temp DSH home + synthetic workspace) ----
const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-home-'))
const ws = join(home, 'workspace')
mkdirSync(ws, { recursive: true })
const workspaceKey = await workspaceKeyOf(ws)
if (workspaceKey === undefined) throw new Error('no workspace key')

// Copy the REAL catalog entry into the isolated home so the e2e still
// exercises the production smoke-test.yaml verbatim, without writing
// anything into the real home.
const realHome = resolveDshHome()
const realEntry = await loadCatalogEntry(realHome, 'smoke-test')
if (realEntry === undefined) throw new Error('smoke-test not found in the real catalog')
mkdirSync(join(home, 'workflows'), { recursive: true })
copyFileSync(realEntry.path, join(home, 'workflows', 'smoke-test.yaml'))

const store = new StateStore(home)
try {
  // The temp home is fresh, so no state row exists; never delete rows from
  // any home we do not own.
  const entry = await loadCatalogEntry(home, 'smoke-test')
  if (entry === undefined) throw new Error('smoke-test not found in the isolated catalog')

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
  /** Per-verdict settlement: each scripted judge verdict resolves its own waiter. */
  let verdictsApplied = 0
  const verdictWaiters = []
  function waitVerdict() {
    if (verdictsApplied > 0) {
      verdictsApplied -= 1
      return Promise.resolve()
    }
    return new Promise(resolve => verdictWaiters.push(resolve))
  }
  function noteVerdict() {
    const waiter = verdictWaiters.shift()
    if (waiter !== undefined) waiter()
    else verdictsApplied += 1
  }
  const subagents = {
    async ensureRoleActor(_run, role, initialText) {
      dispatchLog.push(`role[${role}](create): ${initialText.split('\n')[0]}`)
      return { childId: 'actor-session-1', messageId: 'actor-msg-1' }
    },
    async startJudge(_run, input) {
      // Scripted judge: inspect the synthetic workspace and submit the verdict
      // via the engine's judge_claim path (the same code path a real Judge's
      // `judge_claim` tool call drives).
      const path = join(ws, 'smoke', 'result.txt')
      let content = ''
      if (existsSync(path)) content = readFileSync(path, 'utf8')
      const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '')
      const isHello = input.instruction.includes('Write the single line')
      const ok = isHello
        ? lines.length === 1 && lines[0] === 'smoke ok'
        : lines.length === 2 && lines[0] === 'smoke ok' && lines[1] === 'worker ok'
      const verdict = ok ? 'PASS' : 'FAIL'
      const reason = ok ? 'content matches criteria' : `content: ${JSON.stringify(content)}`
      // Defer to a macrotask so the verdict lands AFTER handleClaim persists the
      // judgment phase (await continuations are microtasks; setTimeout(0) runs
      // after them), mirroring a real async judge turn.
      setTimeout(() => {
        void engine.handleJudgeClaim(workspaceKey, input.nodeToken, verdict, reason, 'judge-session-1')
          .then(outcome => { if (outcome.ok) noteVerdict() })
      }, 0)
      return { judgeSessionId: 'judge-session-1', messageId: 'judge-msg-1' }
    },
    async followupJudge() {},
    async retireJudge() {},
    async drainJudge() {},
    async compactRoleActor() { return { ok: true, detail: 'no compactable range' } },
  }
  const programs = {
    async run() { return { kind: 'ERROR', reason: 'no programs in smoke-test' } },
  }
  const targets = {
    async steerManager(_run, text) { dispatchLog.push(`steer: ${text.split('\n')[0]}`) },
    async sendRoleActor(_run, role, text) { dispatchLog.push(`role[${role}]: ${text.split('\n')[0]}`); return { messageId: 'actor-msg-1' } },
    managerSessionSeq() { return 0 },
  }

  const engine = new WorkflowEngine(targets, subagents, programs, stateHost)
  engine.cwdResolver = async () => ws

  // 1. start (configPath feeds the run trace log directory)
  const run = engine.buildInitialRun('manager-session-e2e', 'smoke-test', entry.config, entry.definitionHash)
  const started = await engine.startRun(workspaceKey, run, entry.path)
  console.log('1. start:', started.ok, started.message, '| frame:', topFrame(started.run).nodeId, '|', started.run.status)
  console.log('   dispatch:', dispatchLog.at(-1))

  // 2. manager writes the file and claims completed
  mkdirSync(join(ws, 'smoke'), { recursive: true })
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\n', 'utf8')
  const claim1 = await engine.handleClaim(workspaceKey, {
    nodeToken: topFrame(started.run).nodeToken, outcome: 'completed', summary: 'wrote smoke/result.txt',
  }, 'manager-session-e2e')
  console.log('2. claim hello:', claim1.ok, claim1.message)
  // PRODUCTION ORDERING (F1/F2 regression): the worker's own turn ends
  // IMMEDIATELY after node_claim, while the async Judge is still evaluating.
  const settle1 = await engine.handleTurnEnded(workspaceKey, 'manager-session-e2e')
  if (settle1 !== undefined) throw new Error(`unexpected turn settlement result: ${JSON.stringify(settle1)}`)
  {
    const row = await stateHost.get(workspaceKey)
    if (row === undefined) throw new Error('row vanished after turn end')
    if (row.run.status !== 'running') throw new Error(`false BLOCK after a claiming turn: ${row.run.status} / ${row.run.blockReason}`)
    console.log('   turn settled mid-judgment: no false BLOCK ✓')
  }
  // The scripted judge verdict lands asynchronously; await its application
  // (deterministic — no fixed-time sleeps).
  await waitVerdict()
  let current = await stateHost.get(workspaceKey)
  if (current === undefined) throw new Error('row vanished after verdict')
  console.log('   frame after verdict:', topFrame(current.run).nodeId, '| dispatch:', dispatchLog.at(-1))
  if (topFrame(current.run).nodeId !== 'worker-echo') throw new Error(`verdict did not advance/dispatch: ${topFrame(current.run).nodeId}`)

  // 3. worker appends and claims (the worker-echo node was dispatched above)
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\nworker ok\n', 'utf8')
  const claim2 = await engine.handleClaim(workspaceKey, {
    nodeToken: topFrame(current.run).nodeToken, outcome: 'completed', summary: 'appended worker ok',
  }, 'actor-session-1')
  console.log('3. claim worker-echo:', claim2.ok, claim2.message)
  // Same production ordering: the actor's turn settles before the verdict.
  const settle2 = await engine.handleTurnEnded(workspaceKey, 'actor-session-1')
  if (settle2 !== undefined) throw new Error(`unexpected actor turn settlement: ${JSON.stringify(settle2)}`)
  await waitVerdict()
  const final = await stateHost.get(workspaceKey)
  if (final === undefined) throw new Error('row vanished at the end')
  console.log('4. FINAL:', final.run.status, '| callStack:', JSON.stringify(final.run.callStack))

  let pass = final.run.status === 'completed' && final.run.callStack.length === 0

  // 5. run trace log assertions (PRD workflow-run-logging AC1/AC2)
  const TS = '\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\]'
  const logDir = join(dirname(entry.path), 'smoke-test')
  const logFiles = existsSync(logDir) ? readdirSync(logDir).filter(f => f.endsWith('.txt')) : []
  if (logFiles.length !== 1 || !/^\d{8}-\d{6}-[0-9a-f-]{8}\.txt$/.test(logFiles[0])) {
    console.log('5. trace log FAIL: expected one yyyyMMdd-HHmmss-<runId8>.txt in', logDir, '| got:', JSON.stringify(logFiles))
    pass = false
  } else {
    const log = readFileSync(join(logDir, logFiles[0]), 'utf8')
    const expectations = [
      new RegExp(`${TS} START workflow=smoke-test run=${run.runId}\\n`),
      new RegExp(`${TS} NODE smoke-test/hello PASS -> worker-echo\\n`),
      new RegExp(`${TS} NODE smoke-test/worker-echo PASS -> END\\n`),
    ]
    for (const [i, re] of expectations.entries()) {
      const ok = re.test(log)
      console.log(`5.${i + 1} trace log line ${ok ? 'OK' : 'MISSING'}: ${re.source}`)
      if (!ok) pass = false
    }
    if (pass) console.log('   trace log:', join(logDir, logFiles[0]))
  }

  console.log(pass ? 'E2E SMOKE PASS' : 'E2E SMOKE FAIL')
  if (!pass) process.exitCode = 1
} finally {
  store.close()
  // Remove ONLY the isolated temp home (state db + catalog copy + trace logs
  // + synthetic workspace). The real ~/.dsh home is never modified.
  rmSync(home, { recursive: true, force: true })
}
