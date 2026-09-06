/**
 * Real-code-path e2e smoke: runs the smoke-test workflow through the actual
 * engine + real SQLite store + real catalog loader, with ONLY the model
 * dispatch layer stubbed (steer/sendRoleActor = scripted log, judge =
 * scripted file inspection).
 *
 * ISOLATION (issue #3): the harness NEVER touches the real ~/.dsh home or the
 * repo workspace's real state row. It writes an embedded smoke-test.yaml into
 * a fresh temporary DSH home (hermetic — the real home's catalog may lag the
 * plugin version) and uses a synthetic workspace directory inside it; all
 * state rows and trace logs live under that temp home, which is removed at
 * the end. If a real state row exists for the repo workspace it is left
 * strictly untouched.
 *
 * A1 v2 coverage: the full start → (wrong work → claim → async REJECT →
 * correction re-dispatch → correct work → re-claim → async ACCEPT) → END loop
 * on production code paths for BOTH a Manager node and a Role node —
 * token-less claims bound by the dispatch lease, and the CORRECT trace event.
 */
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

// Embedded v2 catalog: hermetic against the real home's catalog version.
// compactThresholdTokens exercises the optional top-level threshold field
// (Issue #5) through the real restricted-YAML + schema + hash load chain;
// the fake SubagentHost simply receives it on the fresh role dispatch.
const SMOKE_YAML = `schemaVersion: agent-workflow/v2
compactThresholdTokens: 32000
roles:
  worker: { persona: Echo worker. }
judgeRole: { persona: Judge. }
workflow:
  startNode: hello
  nodes:
    hello:
      execution: { type: actor-task, role: manager, instruction: Write the single line "smoke ok" into smoke/result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: smoke/result.txt holds exactly the single line "smoke ok". } }
      onPass: worker-echo
    worker-echo:
      execution: { type: actor-task, role: worker, instruction: Append the single line "worker ok" to smoke/result.txt. }
      checker: { checkerId: judge.claim-correct, config: { criteria: smoke/result.txt holds "smoke ok" then "worker ok", exactly two lines. } }
      onPass: END
`
mkdirSync(join(home, 'workflows'), { recursive: true })
const catalogPath = join(home, 'workflows', 'smoke-test.yaml')
writeFileSync(catalogPath, SMOKE_YAML, 'utf8')

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
  /** Dispatch message ids per session kind — the lease truth for token-less claims. */
  const managerMsgIds = []
  const actorMsgIds = []
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
      const messageId = `actor-msg-${actorMsgIds.length + 1}`
      actorMsgIds.push(messageId)
      return { childId: 'actor-session-1', messageId }
    },
    async startJudge(_run, input) {
      // Scripted judge: inspect the synthetic workspace and submit the
      // confirmation via the engine's judge_claim path (the same code path a
      // real Judge's `judge_claim` tool call drives). A1 v2: the verdict is
      // ACCEPT (claim trustworthy) or REJECT (evidence insufficient) — the
      // Graph PASS comes from the claim outcome, never from this result.
      const path = join(ws, 'smoke', 'result.txt')
      let content = ''
      if (existsSync(path)) content = readFileSync(path, 'utf8')
      const lines = content.split('\n').map(l => l.trim()).filter(l => l !== '')
      const isHello = input.instruction.includes('Write the single line')
      const ok = isHello
        ? lines.length === 1 && lines[0] === 'smoke ok'
        : lines.length === 2 && lines[0] === 'smoke ok' && lines[1] === 'worker ok'
      const verdict = ok ? 'ACCEPT' : 'REJECT'
      const reason = ok ? 'content matches criteria' : `content does not match criteria yet: ${JSON.stringify(content)}`
      // Defer to a macrotask so the verdict lands AFTER handleClaim persists the
      // judgment phase (await continuations are microtasks; setTimeout(0) runs
      // after them), mirroring a real async judge turn. The Judge must use the
      // engine-reserved id already persisted before this child existed (P1).
      setTimeout(() => {
        void engine.handleJudgeClaim(workspaceKey, input.nodeToken, verdict, reason, input.judgeSessionId)
          .then(outcome => { if (outcome.ok) noteVerdict() })
      }, 0)
      return { judgeSessionId: input.judgeSessionId, messageId: 'judge-msg-1' }
    },
    async followupJudge() {},
    async judgeSessionExists() { return true },
    async retireJudge() {},
    async drainJudge() {},
    async compactRoleActor() { return { ok: true, detail: 'no compactable range' } },
  }
  const programs = {
    async run() { return { kind: 'ERROR', reason: 'no programs in smoke-test' } },
  }
  const targets = {
    async steerManager(_run, text) {
      dispatchLog.push(`steer: ${text.split('\n')[0]}`)
      const messageId = `steer-msg-${managerMsgIds.length + 1}`
      managerMsgIds.push(messageId)
      return { messageId }
    },
    async sendRoleActor(_run, role, text) {
      dispatchLog.push(`role[${role}]: ${text.split('\n')[0]}`)
      const messageId = `actor-msg-${actorMsgIds.length + 1}`
      actorMsgIds.push(messageId)
      return { messageId }
    },
    managerSessionSeq() { return 0 },
  }

  const engine = new WorkflowEngine(targets, subagents, programs, stateHost)
  engine.cwdResolver = async () => ws

  const managerCaller = () => ({ sessionId: 'manager-session-e2e', turnUserMessageIds: new Set(managerMsgIds) })
  const actorCaller = () => ({ sessionId: 'actor-session-1', turnUserMessageIds: new Set(actorMsgIds) })

  // 1. start (configPath feeds the run trace log directory)
  const run = engine.buildInitialRun('manager-session-e2e', 'smoke-test', entry.config, entry.definitionHash)
  const started = await engine.startRun(workspaceKey, run, entry.path)
  console.log('1. start:', started.ok, started.message, '| frame:', topFrame(started.run).nodeId, '|', started.run.status)
  console.log('   dispatch:', dispatchLog.at(-1))

  // 2. Manager does WRONG work first: the judge must REJECT, and the SAME
  //    node re-dispatches to the Manager with the correction evidence.
  mkdirSync(join(ws, 'smoke'), { recursive: true })
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'wrong content\n', 'utf8')
  const claim1 = await engine.handleClaim(workspaceKey, { outcome: 'completed', summary: 'wrote smoke/result.txt (wrong)' }, managerCaller())
  console.log('2. claim hello (wrong work):', claim1.ok, claim1.message)
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
  await waitVerdict()
  {
    const row = await stateHost.get(workspaceKey)
    if (row === undefined) throw new Error('row vanished after REJECT')
    if (topFrame(row.run).nodeId !== 'hello') throw new Error(`REJECT moved the node: ${topFrame(row.run).nodeId}`)
    if (row.run.pendingCorrection === undefined) throw new Error('REJECT persisted no pendingCorrection')
    console.log('   REJECT → correction pending | dispatch:', dispatchLog.at(-1))
    if (!(dispatchLog.at(-1) ?? '').includes('[correction]')) throw new Error('correction message missing the [correction] header')
  }
  // The corrected Manager turn does the work correctly and re-claims (the
  // re-claim binds to the CORRECTION dispatch's lease).
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\n', 'utf8')
  const claim1b = await engine.handleClaim(workspaceKey, { outcome: 'completed', summary: 'wrote smoke/result.txt' }, managerCaller())
  console.log('3. re-claim hello (corrected):', claim1b.ok, claim1b.message)
  await engine.handleTurnEnded(workspaceKey, 'manager-session-e2e')
  await waitVerdict()
  let current = await stateHost.get(workspaceKey)
  if (current === undefined) throw new Error('row vanished after verdict')
  console.log('   frame after ACCEPT:', topFrame(current.run).nodeId, '| dispatch:', dispatchLog.at(-1))
  if (topFrame(current.run).nodeId !== 'worker-echo') throw new Error(`verdict did not advance/dispatch: ${topFrame(current.run).nodeId}`)

  // 4. The worker actor does WRONG work: REJECT re-dispatches the correction
  //    to the ORIGINAL actor session (same-node followup).
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\nwrong worker\n', 'utf8')
  const claim2 = await engine.handleClaim(workspaceKey, { outcome: 'completed', summary: 'appended worker ok (wrong)' }, actorCaller())
  console.log('4. claim worker-echo (wrong work):', claim2.ok, claim2.message)
  await engine.handleTurnEnded(workspaceKey, 'actor-session-1')
  await waitVerdict()
  {
    const row = await stateHost.get(workspaceKey)
    if (row === undefined) throw new Error('row vanished after worker REJECT')
    if (topFrame(row.run).nodeId !== 'worker-echo') throw new Error(`worker REJECT moved the node: ${topFrame(row.run).nodeId}`)
    console.log('   REJECT → correction to the original actor | dispatch:', dispatchLog.at(-1))
    if (!(dispatchLog.at(-1) ?? '').includes('[correction]')) throw new Error('actor correction message missing the [correction] header')
  }
  // Corrected actor work → re-claim → ACCEPT → END.
  writeFileSync(join(ws, 'smoke', 'result.txt'), 'smoke ok\nworker ok\n', 'utf8')
  const claim2b = await engine.handleClaim(workspaceKey, { outcome: 'completed', summary: 'appended worker ok' }, actorCaller())
  console.log('5. re-claim worker-echo (corrected):', claim2b.ok, claim2b.message)
  await engine.handleTurnEnded(workspaceKey, 'actor-session-1')
  await waitVerdict()
  const final = await stateHost.get(workspaceKey)
  if (final === undefined) throw new Error('row vanished at the end')
  console.log('6. FINAL:', final.run.status, '| callStack:', JSON.stringify(final.run.callStack))

  let pass = final.run.status === 'completed' && final.run.callStack.length === 0

  // 7. run trace log assertions (workflow-run-logging AC1/AC2 + A3 fmt=2 events + A1 CORRECT)
  const TS = '\\[\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\]'
  const TOK = '[0-9a-f]{8}'
  const logDir = join(dirname(entry.path), 'smoke-test')
  const logFiles = existsSync(logDir) ? readdirSync(logDir).filter(f => f.endsWith('.txt')) : []
  if (logFiles.length !== 1 || !/^\d{8}-\d{6}-[0-9a-f-]{8}\.txt$/.test(logFiles[0])) {
    console.log('7. trace log FAIL: expected one yyyyMMdd-HHmmss-<runId8>.txt in', logDir, '| got:', JSON.stringify(logFiles))
    pass = false
  } else {
    const log = readFileSync(join(logDir, logFiles[0]), 'utf8')
    // The REJECT reasons carry escaped quotes/newlines through jsonField's
    // double JSON-escaping — build those fragments with JSON.stringify +
    // re-escape instead of hand-counting backslashes.
    const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const wrongReason = JSON.stringify('content does not match criteria yet: ' + JSON.stringify('wrong content\n'))
    const expectations = [
      new RegExp(`${TS} START workflow=smoke-test run=${run.runId} fmt=2\\n`),
      new RegExp(`${TS} CLAIM workflow=smoke-test node=hello token=${TOK} role=manager outcome=completed summary="wrote smoke/result.txt \\(wrong\\)" handoff=null\\n`),
      new RegExp(`${TS} JUDGE workflow=smoke-test node=hello token=${TOK} result=REJECT reason=${reEscape(wrongReason)} judge=${TOK}\\n`),
      new RegExp(`${TS} CORRECT workflow=smoke-test node=hello token=${TOK} role=manager judge=${TOK} detail=${reEscape(wrongReason)}\\n`),
      new RegExp(`${TS} CLAIM workflow=smoke-test node=hello token=${TOK} role=manager outcome=completed summary="wrote smoke/result.txt" handoff=null\\n`),
      new RegExp(`${TS} JUDGE workflow=smoke-test node=hello token=${TOK} result=ACCEPT reason="content matches criteria" judge=${TOK}\\n`),
      new RegExp(`${TS} ROUTE workflow=smoke-test node=hello token=${TOK} result=PASS target=worker-echo\\n`),
      new RegExp(`${TS} CLAIM workflow=smoke-test node=worker-echo token=${TOK} role=worker outcome=completed summary="appended worker ok \\(wrong\\)" handoff=null\\n`),
      new RegExp(`${TS} CORRECT workflow=smoke-test node=worker-echo token=${TOK} role=worker judge=${TOK} detail=.+\\n`),
      new RegExp(`${TS} CLAIM workflow=smoke-test node=worker-echo token=${TOK} role=worker outcome=completed summary="appended worker ok" handoff=null\\n`),
      new RegExp(`${TS} JUDGE workflow=smoke-test node=worker-echo token=${TOK} result=ACCEPT reason="content matches criteria" judge=${TOK}\\n`),
      new RegExp(`${TS} ROUTE workflow=smoke-test node=worker-echo token=${TOK} result=PASS target=END\\n`),
    ]
    for (const [i, re] of expectations.entries()) {
      const ok = re.test(log)
      console.log(`7.${i + 1} trace log line ${ok ? 'OK' : 'MISSING'}: ${re.source}`)
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
