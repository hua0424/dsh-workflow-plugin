# Test Report — Issue #3: 运行日志 e2e 断言与文档同步（含 e2e 隔离事故修复）

- **Issue**: https://github.com/hua0424/dsh-workflow-plugin/issues/3
- **Repository**: https://github.com/hua0424/dsh-workflow-plugin (local: `D:\project\my\dsh-workflow-plugins`)
- **Branch**: `feat/workflow-run-logging`
- **Commit under test**: `2a25e7f test+docs: isolated e2e trace-log assertions and doc sync (issue #3)`
- **Date**: 2026-09-02
- **Environment**: Node v24.16.0, Windows, pnpm
- **Result**: ✅ PASS

## Scope note (intentional deviation from the literal issue text)

The issue text asks the e2e to assert the trace log under the **real**
`~/.dsh/workflows/smoke-test/` and clean that log directory at the end. The
Manager handoff extended this issue with an incident fix: the old
`e2e-smoke.mjs` used the real `~/.dsh` home and **deleted the repo
workspace's real state row** (`deleteRow` on the real workspace key),
destroying an active workflow run's state. The e2e therefore now runs fully
**isolated** and asserts the identical log content there:

- A fresh temporary DSH home is created (`mkdtemp` under `os.tmpdir()`); the
  production `smoke-test.yaml` is **copied** (read-only access to the real
  home) into `<tempHome>/workflows/`.
- The workspace is a synthetic directory inside the temp home, so the SQLite
  state row lives only in the temp home's `state.sqlite3`. The real home's
  state rows are **never** read for mutation and never deleted.
- `startRun` receives the isolated catalog entry path, so the trace log is
  created at `<tempHome>/workflows/smoke-test/` — the same directory rule,
  same file naming, same line format as production.
- Cleanup removes only the temp home (state db + catalog copy + trace logs +
  synthetic workspace). Nothing in the real `~/.dsh` is touched.

Equivalence evidence that production still writes to the real
`~/.dsh/workflows/smoke-test/`: the issue #2 real-host run (see
`issue-2-engine-tracelog-test-report.md`) produced
`C:\Users\hua\.dsh\workflows\smoke-test\20260902-121300-65a7e2a6.txt` with
exactly the START + both PASS routing lines, and live workflow runs since
then keep appending there.

## Verification vs. Issue acceptance criteria

| # | Acceptance item | Verification | Result |
|---|---|---|---|
| 1 | e2e 结束后出现时间戳 txt 日志 | `pnpm run test:e2e` step 6：`<isolatedHome>/workflows/smoke-test/` 下恰好一个文件，名匹配 `^\d{8}-\d{6}-[0-9a-f-]{8}\.txt$` | ✅ |
| 2 | 内容含 START 行 | 正则 `\[[\d :-]+\] START workflow=smoke-test run=<runId>\n` | ✅ |
| 3 | 内容含 `hello PASS -> worker-echo` 行（AC2） | 正则 `NODE smoke-test/hello PASS -> worker-echo\n` | ✅ |
| 4 | 内容含 `worker-echo PASS -> END` 行（AC2） | 正则 `NODE smoke-test/worker-echo PASS -> END\n` | ✅ |
| 5 | 行内时间戳 `[YYYY-MM-DD HH:mm:ss]` | 每行断言带 `\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]` 前缀 | ✅ |
| 6 | harness 结束清理、无残留 | `finally` 仅 `rmSync(<tempHome>)`；临时 home 内一切随之删除；真实 home 零写入 | ✅ |
| 7 | 隔离 bug 修复：不触碰真实 state 行 | e2e 运行期间本仓库 workspace 的活动 run 状态行保持完好（运行后用 `workflow_status` 验证 run 仍 running、call stack 完整） | ✅ |
| 8 | 文档与实现一致 | README 新增 "Run trace logs" 小节；设计文档新增 §5.4 运行轨迹日志；issue #2 报告的旧备注已标记 Superseded | ✅ |
| 9 | `pnpm test`、`pnpm run test:e2e` 全绿（AC5） | 单测 **103/103 pass**；e2e `E2E SMOKE PASS`（含 6.1-6.3 日志断言 OK） | ✅ |

## E2E output (2026-09-02)

```
1. start: true dispatched hello | frame: hello | running
2. claim hello: true checker PASS
3. turn ended: dispatched worker-echo
4. claim worker-echo: true checker PASS
5. FINAL: completed | callStack: []
6.1 trace log line OK: ... START workflow=smoke-test run=2210e168-...
6.2 trace log line OK: ... NODE smoke-test/hello PASS -> worker-echo
6.3 trace log line OK: ... NODE smoke-test/worker-echo PASS -> END
   trace log: <temp>\dsh-e2e-home-...\workflows\smoke-test\20260902-122707-2210e168.txt
E2E SMOKE PASS
```

## Notes (non-blocking)

- Issue #3 remains OPEN on GitHub at test time (closure is a Manager/PM step).
- This completes the `workflow-run-logging` milestone implementation (#1 模块、#2 engine 接入、#3 e2e+docs).
