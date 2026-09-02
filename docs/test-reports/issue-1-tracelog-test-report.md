# Test Report — Issue #1: workflow run trace log 模块

- **Issue**: https://github.com/hua0424/dsh-workflow-plugin/issues/1
- **Repository**: https://github.com/hua0424/dsh-workflow-plugin (local: `D:\project\my\dsh-workflow-plugins`)
- **Branch**: `feat/workflow-run-logging`
- **Commit under test**: `3ab0a03 feat(engine): workflow run trace log module (issue #1)`
- **Date**: 2026-09-02
- **Environment**: Node v24.16.0, Windows, pnpm
- **Result**: ✅ PASS

## Implementation under test

- `src/engine/tracelog.ts` (75 lines): `createRunLog(configPath, workflowId, runId)`, `appendLine(logPath, line)`, plus exported helpers `runLogDir`, `lineTimestamp`. Best-effort throughout — no function throws.
- `test/tracelog.test.ts` (79 lines): 6 unit tests.

## Verification vs. Issue acceptance criteria

| # | Acceptance item | Verification | Result |
|---|---|---|---|
| 1 | 目录规则：config 同级同名目录（去 `.yaml`） | `runLogDir: config path stem becomes sibling directory` | ✅ |
| 2 | 文件命名 `yyyyMMdd-HHmmss-<runId前8位>.txt`，追加写入，UTF-8 | `createRunLog: creates sibling directory and yyyyMMdd-HHmmss-<runId8>.txt file`（断言精确路径 `20260103-141522-9e473ab5.txt`；短 runId 原样使用）；`appendFileSync` 追加 + `utf8` 编码 | ✅ |
| 3 | `createRunLog` 返回路径、失败返回 `undefined` 绝不抛错 | `createRunLog: unwritable location returns undefined without throwing`（以普通文件占位制造 ENOTDIR，跨平台稳定） | ✅ |
| 4 | `appendLine` best-effort | `appendLine: unwritable target is silently ignored`（目录不存在 / 路径为目录两种失败均不抛错） | ✅ |
| 5 | 行内时间戳 `[YYYY-MM-DD HH:mm:ss]`（本地时间） | `lineTimestamp: [YYYY-MM-DD HH:mm:ss] local-time format` + `appendLine: appends timestamped lines` 断言逐字节日志内容 | ✅ |
| 6 | 单测覆盖：命名规则、目录创建、追加内容、目录不可写静默 | 以上 6 条测试全覆盖（对应 PRD AC4/AC5 的单元测试部分） | ✅ |
| 7 | `pnpm test` 全绿 | **98/98 pass, 0 fail**（含新增 6 条 tracelog 测试，duration 513ms） | ✅ |

## Additional checks

- `pnpm build`（tsc）— clean, no type errors.
- `git status` — working tree clean; all changes committed on the branch.

## Notes (non-blocking observations)

- `createRunLog` uses `flag: 'wx'` — a same-second duplicate filename returns `undefined` rather than overwriting, consistent with failure tolerance.
- `appendLine` swallows errors silently (no warning log); PRD R4 says "仅记录 warning", but the issue scope (R1/R4 module only) accepts best-effort silent behavior; warning emission belongs to the engine hook issue.
- Out of scope for this issue (covered by later issues): R2 启动日志、R3 节点路由日志 hook、e2e 冒烟（AC5 的 `pnpm run test:e2e` 部分）。
