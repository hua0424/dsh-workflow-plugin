# Handoff：A 类问题统一开发（2026-09-02 fixbug）

- 日期：2026-09-02
- 目的：给下一个开发会话提供完整上下文，按本文件顺序启动 A1–A4 的实现。
- 前置：全部十个 e2e 问题的结论已确定，PRD 已写好，CONTEXT.md / design 文档 / pending-discussions 已回写。**本 handoff 只负责 A1–A4 的代码实现与测试**；B/C 类已在文档层面收尾，无需开发。

## 1. 背景

真实 e2e（milestone-delivery）暴露了四个引擎/编排设计问题，均已讨论定案：

| # | 问题 | 方案 | PRD |
|---|---|---|---|
| A1 | Judge 上下文污染崩溃 | Node 边界隔离 + Node 内 continuable + `judge_claim` 协议 | `a1-node-scoped-continuable-judge.md` |
| A2 | Role Actor 上下文耗尽 | Node 边界 `compactNow` | `a2-node-boundary-actor-compaction.md` |
| A3 | Actor 回合未提交结果 BLOCK | 派发注入硬约束 + BLOCK 通知 | `a3-actor-turn-without-result.md` |
| A4 | Judge 失败韧性不足 | `judgeSessionId` 二分恢复 + `judge_respawn` + `pendingClaim` | `a4-judge-fault-resilience.md` |

四个 PRD 在 `docs/prd/20260902-fixbug/` 下，**实现前先读对应 PRD 的「规则」「状态模型」「验收标准」三节**，本 handoff 只给实现顺序与代码定位，不重复 PRD 全部细节。

## 2. 实现顺序（依赖驱动）

**A1 → A4 → A2 → A3**。理由：A4 依赖 A1 的 Judge 生命周期；A2 依赖 A1 的 `NodeContextBoundary`（保留 dispatch messageId）；A3 的 BLOCK 通知复用 A4 的「BLOCK 主动 steer」机制。

每步遵循：**先写测试（把 PRD 的 AC 转成用例）→ 实现 → 全量回归**。

## 3. 各步代码定位

### A1 — Judge Node 边界隔离 + continuable + `judge_claim`

核心：把 one-shot `spawn` + `outputSchema` 的 Judge，改成每 Node 一个 continuable Judge + 专用工具协议 + Node-local projection。

- `src/types.ts`：`JudgeResult` 扩展支持 `NEED_CONTEXT`（或新增 `JudgeVerdict`）；新增 `NodeContextBoundary { dispatchedAt, managerFromSeq, executorSessionId?, executorDispatchMessageId? }`；`RunState` 增加 `nodeBoundary`、`judgeSessionId`。
- `src/judge/projection.ts`：`projectManagerTranscript` 重写为 Node-local projection（A1 R5–R7）：按 `managerFromSeq` 与 `executorDispatchMessageId` 精确筛选，按 `SessionEvent.time` + 稳定 tie-break 跨 Session 合并 Manager/User/Actor 消息，排除 system/tool/notice/旧 Node 历史。
- `src/judge/checker.ts`：去掉 strict JSON output（one-shot），改为 `judge_claim` 协议 prompt（Judge 通过工具提交，不再结构化输出）。
- `src/roles/roles.ts`：移除 `JUDGE_OUTPUT_SCHEMA`（one-shot 契约）；`JUDGE_ALLOW` 增加 `judge_claim`。
- `src/plugin/host.ts`：`runJudge` 改为 `startContinuable`（无 outputSchema）+ 构建 Judgment Packet（A1 R7）；`ensureRoleActor` 保留 `startContinuable`/`followup` 返回的 `messageId`（供 NodeContextBoundary 使用）。
- `src/engine/engine.ts`：`dispatchCurrent` 在**实际派发时**建立 `NodeContextBoundary`（A1 R1）；`handleClaim` 创建 continuable Judge 并投递 Judgment Packet；新增 `handleJudgeClaim`（处理 `judge_claim` 工具，A1 R9–R10）；`handleResume` 在 `NEED_CONTEXT` 时 followup 该 Judge（不重派 Actor）。
- `src/tools/tools.ts` + `src/tools/authz.ts`：新增 `judge_claim` 工具，仅映射到当前 Node 的 Judge Session 可调用，校验 `nodeToken`。
- `src/index.ts`：continuable Judge 的结果不再走 one-shot 结算，改为 `judge_claim` 工具提交；释放 Judge 活跃资源（A1 R11）。

### A4 — Judge 故障韧性

核心：无 `faultKind`，只采集 `detail`；`judgeSessionId` 二分恢复；`judge_respawn`；`pendingClaim`。

- `src/types.ts`：`RunState` 增加 `pendingClaim?: { outcome, summary }`（A4 R9）。
- `src/plugin/host.ts`：`runJudge` 把吞掉的异常/stopReason 捕获为 `detail` 字符串（A4 R1），不再 `catch { return undefined }` 全吞。
- `src/engine/engine.ts`：`handleClaim` 判定阶段持久化 `pendingClaim`；判定结束（PASS/FAIL）清除；技术故障 BLOCK 时写 `blockReason = 'judge fault: <detail>'` 并主动 steer Manager 模板（A4 R2）；`handleResume` 按 `judgeSessionId` 是否存在走 followup 或 spawn 重建（A4 R4，**引擎不做 followup 失败的自动兜底**）；新增 `handleRespawnJudge`。
- `src/tools/tools.ts` + `src/tools/authz.ts`：新增 `judge_respawn({ nodeToken, reason? })`（Manager 专用），清 `judgeSessionId` + spawn 重建 + 重投 packet（用 `pendingClaim`）。

### A2 — Node 边界 compact

核心：派发新 Node 前对 role actor 执行 `ctx.compaction.compactNow`。

- `src/engine/engine.ts` `dispatchCurrent`：非 manager 的 actor-task，在 `followup` 前，若 `roleActors[roleKey]` 已存在，取 resident Agent（`ctx.agents.get(childId)`）后调用 `compactNow`；返回 `null` 继续，抛 `ManualCompactionError` → BLOCK（A2 R4）；无 resident Agent（cold-resume）跳过（A2 R5）。
- `src/plugin/host.ts`：需要暴露「拿 resident Agent + 调 compactNow」的能力（可能加一个 `compactRoleActor` 到 SubagentHost 接口）。
- 结果 best-effort 记一行 trace log（A2 R7）。

### A3 — 派发注入提交硬约束 + BLOCK 通知

核心：actor-task 派发文本统一 append「必须 `node_claim`」；`actor-turn-ended-without-result` 主动通知。

- `src/engine/engine.ts` `dispatchCurrent`：对 `actor-task`（manager + role）在 instruction 末尾 append 固定硬约束（A3 R1，只 append 不替换；builtin-program / child-workflow 不注入）。
- `src/engine/engine.ts` `handleTurnEnded`：`actor-turn-ended-without-result` 分支主动 `steerManager` 固定模板（A3 R3，复用 A4 的 BLOCK 通知框架）。
- 保留安全暂停语义，**不自动重派**。

## 4. 状态模型（四步共享）

最终 `RunState` 增量（相对现状）仅：

```
nodeBoundary: NodeContextBoundary                      // A1，Node 实际派发时建立
judgeSessionId?: string                                // A1/A4，当前 active/pending Judge
pendingClaim?: { outcome, summary, handoffContext? }   // A4，判定阶段持有，判定结束清除
```

`handoffContext` 随 claim 持久化进 `pendingClaim`（评审修正「方案 2」）：仅 `completed` 且非空时写入，判定结束随 claim 一起清除，Host 重启不丢 handoff。

不新增 `faultKind`、Judge 历史映射、跨 Node Decision Context、Manager 摘要。

## 5. 关键约束与非目标（避免实现时跑偏）

- Judge 每 Node 一个新 Session；同一 Node 内 `NEED_CONTEXT` 可 followup；跨 Node 不复用；Node 完成后释放活跃资源（**只撤销授权**，Activation 由 DSH settlement watcher 自动释放；**禁止在 Judge 自己的 `judge_claim` turn 内 drain 自己**，避免 self-cancel 死锁；GUI 历史条目清理**不做**）。
- 技术故障**不自动重试**，一律 BLOCK 升级给 Manager。
- 恢复控制流**只看 `judgeSessionId` 是否存在**，不看故障分类；引擎**不做** followup 失败的自动兜底。
- token 显式传参**保持不动**，不做 turn/message 自动绑定（C1 已知限制）。
- compact 失败 BLOCK，`null`（无历史）继续派发；cold-resume 跳过 compact。

## 6. 验收与门禁

- 每个 PRD 末尾的「验收标准」是硬门禁（A1 AC1–AC11、A4 AC1–AC11、A2 AC1–AC9、A3 AC1–AC7）。**例外：A2 AC1 已按评审修正降级为条件性 AC（resident idle Actor 存在时 best-effort compact），A2 AC8 挂起至 DSH maintenance API 支持后验收（见 `docs/pending-discussions/a2-compact-residency-premise.md`）。**
- 全量回归：现有 10 个测试文件 + `scripts/e2e-smoke.mjs` 必须通过；`pnpm run build` 干净。
- 注意 `scripts/e2e-smoke.mjs` 里的 `runJudge` 是 stub，改 Judge 为 continuable 后该 stub 需要适配（或改 stub 模拟 `judge_claim` 路径），保证 e2e smoke 仍走真实 engine 路径。
- 完成后跑真实 e2e（`milestone-delivery`）验证 A1–A4 的实际效果。**（评审后状态：合成 e2e smoke 已通过；真实 milestone-delivery 由用户人工运行验证。）**

## 7. 已完成的文档回写（无需重做）

- `docs/pending-discussions/live-e2e-issues.md`：已加决策总览表 + 每个问题标「已决策」。
- `CONTEXT.md`：Role Actor / Judge Agent / Run Frame / Judge Decision Checker / BLOCK / Node Claim / Node Resume / State Store 已按目标语义更新。
- `docs/design/configurable-agent-workflow-graph.md`：state 结构、tool 列表（九个 + `judge_respawn`）、Judge 三层模型、中断恢复、Milestone 示例配置已更新（含 gh milestone title/number 语义、`judge_claim` persona、claim 软约束）。

## 8. 参考

- 设计文档：`docs/design/configurable-agent-workflow-graph.md`
- 领域词汇表：`CONTEXT.md`
- 四个 PRD：`docs/prd/20260902-fixbug/a1-*.md`、`a2-*.md`、`a3-*.md`、`a4-*.md`
- DSH 关键 API（已探明）：`ctx.compaction.compactNow(agent, signal)`（要求 idle）、`ctx.agents.get(childId)`（拿 resident Agent）、`startContinuable`/`followup` 返回 `{ childId, messageId }`、`ToolRunContext` 只暴露 `agent`（无 turn/messageId，故不实现自动绑定）。
