# Test Report — Issue #2: engine 接入运行日志（启动行 + 节点 PASS/FAIL 路由行）

- **Issue**: https://github.com/hua0424/dsh-workflow-plugin/issues/2
- **Repository**: https://github.com/hua0424/dsh-workflow-plugin (local: `D:\project\my\dsh-workflow-plugins`)
- **Branch**: `feat/workflow-run-logging`
- **Commit under test**: `3e5791c feat(engine): wire run trace log into run lifecycle (issue #2)`
- **Date**: 2026-09-02
- **Environment**: Node v24.16.0, Windows, pnpm
- **Result**: ✅ PASS

## Implementation under test

- `src/engine/engine.ts`: `startRun(workspaceKey, run, configPath?)` creates the trace log via #1's `createRunLog` and writes the START line; `advance()` logs `NODE <workflowId>/<nodeId> PASS|FAIL -> <target|END|BLOCK>`; child push logged as `NODE <wf>/<node> PUSH -> <childId>`; in-memory `runId → logPath` map, dropped on completion/reset.
- `src/index.ts`: `/dsh-flow start` passes `entry.path` (catalog config path) into `startRun`.
- `test/engine.test.ts`: +150 lines, 5 new engine tests.

## Verification vs. Issue acceptance criteria

| # | Acceptance item | Verification | Result |
|---|---|---|---|
| 1 | run 创建成功后写 START 行 `[ts] START workflow=<id> run=<runId>`（R2） | 单测 `startRun creates the trace log and writes the START line (AC1)` + e2e 实机验证 | ✅ |
| 2 | PASS 路由行 `NODE <nodeId> PASS -> <nextNodeId|END>`（R3） | 单测 `trace log records a PASS routing line (AC2)`；行内含 `workflowId/nodeId` | ✅ |
| 3 | FAIL 路由行 `NODE <nodeId> FAIL -> <onFailNodeId>`（AC3）；无 onFail 时 BLOCK | 单测 `trace log records a FAIL routing line to onFail (AC3), and FAIL -> BLOCK without one` | ✅ |
| 4 | child-workflow 压栈/出栈路由也记录，行内含所属 workflowId | 单测 `trace log covers child push/pop routing with owning workflow ids (AC2)`：断言 `child-test/call-child PUSH -> child-a`、`child-a/child-step PASS -> END`、父流程 pop 行 | ✅ |
| 5 | engine 能拿到 catalog entry 的 config path | `src/index.ts` 传 `entry.path`；e2e 实机验证日志落在真实 `~/.dsh/workflows/smoke-test/` | ✅ |
| 6 | 日志失败不得影响 run 推进（R4/AC4） | 单测 `log creation/append failure never breaks run startup or routing (AC4)`（普通文件占位使 mkdir ENOTDIR，start 与 PASS 路由照常） | ✅ |
| 7 | `pnpm test` 全绿 | **103/103 pass, 0 fail**（duration ~509ms） | ✅ |

## End-to-end validation (PRD AC1/AC2, real host)

A temporary script (same real-host harness as `scripts/e2e-smoke.mjs`, but passing `entry.path` to `startRun` like `src/index.ts` does) ran the smoke-test workflow against the **real** `~/.dsh` home, catalog, and SQLite store:

```
catalog entry path: C:\Users\hua\.dsh\workflows\smoke-test.yaml
trace log created: C:\Users\hua\.dsh\workflows\smoke-test\20260902-121300-65a7e2a6.txt
filename matches yyyyMMdd-HHmmss-<runId8>.txt: true
--- trace log content ---
[2026-09-02 12:13:00] START workflow=smoke-test run=65a7e2a6-b099-4d4f-9da6-dcdf33892ded
[2026-09-02 12:13:00] NODE smoke-test/hello PASS -> worker-echo
[2026-09-02 12:13:00] NODE smoke-test/worker-echo PASS -> END
-------------------------
PASS: AC1 START line
PASS: AC2 hello PASS -> worker-echo
PASS: AC2 worker-echo PASS -> END
TRACE-LOG E2E PASS
```

The script cleaned up after itself (state row, `smoke/` dir, created log file) and was deleted after the run; working tree is clean.

Also run: `pnpm run test:e2e` → **E2E SMOKE PASS** (unchanged harness, still green). Note: `e2e-smoke.mjs` calls `startRun` without `configPath`, so it does not itself exercise the trace log — the temporary script above covers that gap. **[Superseded by issue #3 / commit 2a25e7f: `e2e-smoke.mjs` now passes `entry.path` and asserts the full trace log (START + both PASS routing lines) in an isolated temporary DSH home; the real `~/.dsh` is never modified.]**

## Additional checks

- `pnpm build`（tsc）— clean, no type errors.
- `git status` — working tree clean; all changes committed.

## Notes (non-blocking observations)

- `logFiles` map is in-memory only: after a host restart/cold resume, a resumed run will not resume logging to its file (no re-attachment). Acceptable for this milestone (PRD 非目标: 不改变状态模型), worth noting for issue #3 or a follow-up.
- FAIL -> BLOCK line is an extension beyond the issue's literal spec (issue specifies only FAIL -> onFailNodeId); it is consistent with R3's intent and covered by tests.
- `handleReset` now performs a `state.get` before `remove` to drop the log mapping — slightly more I/O on reset; negligible.
- Issue #2 remains OPEN on GitHub at test time (closure is a Manager/PM step). Issue #3 depends on this one; this PASS unblocks it.
