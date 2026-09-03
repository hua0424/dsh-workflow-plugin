# Test Report — Issue #4: Judge subagent label 携带当前 nodeId

- **Issue**: https://github.com/hua0424/dsh-workflow-plugin/issues/4
- **Repository**: https://github.com/hua0424/dsh-workflow-plugin (local: `D:\project\my\dsh-workflow-plugins`)
- **Branch**: `feat/judge-label-nodeid`
- **Commit under test**: `349f0dd feat: Judge subagent label 携带当前 nodeId`
- **Date**: 2026-09-03
- **Environment**: Node v24.16.0, pnpm 10.10.0, Windows
- **Result**: ✅ PASS

## Scope

按 PRD `docs/prd/judge-label-nodeid.md` 执行验收：spawn Judge 时 subagent
`label` 由固定 `'workflow-judge'` 改为 `workflow-judge:<nodeId>`（nodeId =
spawn 时点 call stack 顶帧 `topFrame(run).nodeId`），构造逻辑提取为
`roles.ts` 纯函数 `judgeLabel`，且测试全程隔离（不触碰真实 `~/.dsh`、真实
state 行、真实 workspace）。

改动文件（3 个）：`src/roles/roles.ts`、`src/plugin/host.ts`、
`test/roles.test.ts`（与 PRD §3 范围完全一致，共 +17 / -3 行）。

## Verification vs. Acceptance Criteria

| # | Acceptance item | Verification | Result |
|---|---|---|---|
| AC1 | `judgeLabel('implement')` 返回 `'workflow-judge:implement'`，单测覆盖 | `test/roles.test.ts:75` `judge label carries the current node id` 断言相等；`roles.ts:33-35` 纯函数 `return \`workflow-judge:${nodeId}\`` | ✅ |
| AC2 | `host.ts` `startJudge` 不再出现字面量 `'workflow-judge'`，label 由 `judgeLabel` 生成且含当前顶帧 nodeId | grep `src/`：`workflow-judge` 字面量仅剩 `roles.ts` 纯函数 1 处；`host.ts:244` `label: judgeLabel(topFrame(run).nodeId)`，`topFrame` 自 `src/state/invariants.ts:47` 导入（取 `run.callStack` 末帧）；`childId: SessionId(input.judgeSessionId)` 未动 | ✅ |
| AC3 | `pnpm test` 全绿 | **135/135 pass**（新增用例 + 既有回归），0 fail / 0 skipped | ✅ |
| AC4 | `pnpm run test:e2e` 全绿且仍走隔离临时 home | `E2E SMOKE PASS`，exit 0；trace log 落在 `C:\Users\hua\AppData\Local\Temp\dsh-e2e-home-*` 隔离 home，`finally` 仅 `rmSync(<tempHome>)`，真实 `~/.dsh` 零写入 | ✅ |

## Non-Goals 确认（PRD §4 / §6）

- Judge `childId` / `judgeSessionId` 未改：`host.ts:248` 仍为 `SessionId(input.judgeSessionId)`（engine 预留 UUID），唯一性不受影响。
- 未新增 spawn 序号/时间戳等判别式；未改 Role Actor label。
- 改动局限于 `roles.ts` + `host.ts` + `roles.test.ts`，未侵入 engine / state / checker / catalog（`git show --stat 349f0dd` 仅 3 文件）。
- nodeId 命名约束 `[a-z][a-z0-9-]*`：e2e 实际节点 `hello` / `worker-echo` 均满足，拼接产物无空格等非法字符。

## 测试执行证据

- `pnpm test` → `tests 135 / pass 135 / fail 0`（含新用例 `judge label carries the current node id`）。
- `pnpm run build`（`tsc -p tsconfig.json`）→ exit 0，无类型错误。
- `pnpm run test:e2e` → `E2E SMOKE PASS`，exit 0：

```
1. start: true dispatched hello | frame: hello | running
2. claim hello: true judge spawned for node hello
   turn settled mid-judgment: no false BLOCK ✓
   frame after verdict: worker-echo | dispatch: role[worker](create): ...
3. claim worker-echo: true judge spawned for node worker-echo
4. FINAL: completed | callStack: []
5.1-5.3 trace log line OK (START / hello PASS -> worker-echo / worker-echo PASS -> END)
   trace log: <temp>\dsh-e2e-home-*\workflows\smoke-test\20260903-*.txt
E2E SMOKE PASS
```

注：e2e 的 subagent 层被脚本化 stub（`scripts/e2e-smoke.mjs`），label 不在此路径被直接观测；AC2 的接线正确性由单测（纯函数）+ 源码静态检查覆盖，符合 PRD R2/R3「纯函数可无宿主测试、e2e 不触真实 home」约定。

## 工作树状态

- `git status` 干净，`HEAD = 349f0dd`，分支 `feat/judge-label-nodeid` 与 `origin` 同步。
- 本报告新增文件：`docs/test-reports/issue-4-judge-label-nodeid-test-report.md`（未提交，仅供流转）。

## Conclusion

AC1–AC4 全部满足，实现与 PRD 范围/非目标一致，判定 **PASS**。
