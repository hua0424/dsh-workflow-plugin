# PRD：A4 Judge 技术故障韧性

- 日期：2026-09-02
- 来源问题：`docs/pending-discussions/live-e2e-issues.md` A4
- 状态：方案已确认，等待与其他问题统一梳理后开发
- 依赖：A1（Node 内 continuable Judge 与 `judge_claim` 协议）

## 1. 背景

当前 Judge 是 fail-closed 的一次性 `spawn`：`runJudge` 把一切异常、非 `completed` 停止、structured 缺失统一吞成 `undefined`，Engine 再写死 `judge evaluation produced no result` 并 BLOCK。真实 e2e 中后期严重卡顿，且无法定位失败原因。

A1 已把 Judge 改为「每 Node fresh、Node 内 continuable」，并规定技术故障（spawn 失败、agent 异常、无结果、工具面不符、Session 异常等）仍应 fail-closed 并 BLOCK。本 PRD 决定 BLOCK 之后的行为：如何记录诊断、如何通知 Manager、Manager 如何让 Judge 继续或重建。

## 2. 目标

1. 技术故障一律 fail-closed 并 BLOCK，不自动重试、不自动降级。
2. BLOCK 时记录可读诊断（一个 `detail` 字符串），写进 `blockReason` 与 trace log。
3. BLOCK 时主动向 Manager 发送固定模板话术，说明故障与可选动作。
4. 恢复控制流只依赖 `judgeSessionId` 是否存在：存在则 followup，不存在则 spawn 重建。
5. 提供 `judge_respawn` 工具，让 Manager 显式放弃当前 Judge 并重建。
6. 判定阶段持久化 `pendingClaim`，保证 spawn 重建能重投完整 Judgment Packet。

## 3. 术语

- **技术故障**：A1 R12 所列的 Judge 失败（provider/model 异常、token ceiling、turn 未调 `judge_claim`、工具面不符、Session/持久化/读取异常），区别于语义性 `NEED_CONTEXT`。
- **detail**：一条人类可读的故障描述字符串（异常 message / stopReason 文本），用于 `blockReason`、trace log 与模板展示。
- **判定阶段**：从 Worker 提交 `node_claim` 到 Judge 产出 PASS/FAIL 之间的区间。
- **spawn 重建**：在同一个 Node 内新建一个全新 Judge Session，重新投递完整 Judgment Packet（相当于重新执行一次 claim → checker 判定）。

## 4. 诊断与通知

### R1：无 faultKind，只保留 detail

不引入任何故障分类枚举。引擎只采集一条 `detail` 字符串：

- spawn 同步异常 → 异常 message；
- turn 异步失败（未调 `judge_claim` / agent 异常）→ stopReason 或等效描述。

`detail` 不单独持久化为结构化字段，只进入：

1. `blockReason`（截断到 `LIMITS.blockReasonMax` 以内，格式固定：`judge fault: <detail>`）；
2. trace log 一行；
3. 发给 Manager 的模板话术。

### R2：BLOCK 时主动通知 Manager

当前引擎 BLOCK 是被动的（只写 state）。本 PRD 新增：技术故障 BLOCK 时主动 `steerManager` 一段固定模板：

```text
⚠️ Judge 判定故障（workflow <id> / node <nodeId>）
诊断：<detail>

当前 Node 已 BLOCK，未推进 PASS/FAIL。
可选动作：
  1. node_resume({nodeToken, resolutionContext}) —— 你的补充/指示交给当前 Judge 继续（followup）；
  2. judge_respawn({nodeToken}) —— 放弃当前 Judge，重建新 Judge 重来一次判定；
  3. workflow_set_role_model({roleKey:'judge', ...}) 换模型后再 resume/respawn；
  4. node_block 保留现场等待人工。
```

该模板与 A1 `NEED_CONTEXT` 的通知共用同一框架，仅分类/动作字段不同。

### R3：不自动重试

技术故障不自动 spawn / followup 重试，一律进入 BLOCK 等待 Manager 决定。A1 落地后 Judge 崩溃率应显著下降；若实测仍频繁，另行评估轻量重试（不在本 PRD 范围）。

## 5. 恢复语义

### R4：唯一控制信号 = `judgeSessionId`

`node_resume` 处于判定阶段的 BLOCK 时：

- `judgeSessionId` 存在 → followup 同一 Judge（附 `resolutionContext`），不重派 Actor、不重建；
- `judgeSessionId` 不存在 → spawn 重建，重投完整 Judgment Packet。

为避免首次 Judge admission 竞态，Engine 在 `startJudge` 调用前预留并持久化 `judgeSessionId`，Host 必须把它作为 caller-reserved `childId`。若 spawn/admission 失败，该未成功建立的 id 必须清除，仍保留 `pendingClaim`；这样后续 `node_resume` 才按 A4 R8 自动 spawn 重建，而不会 followup 不存在的 Judge。

`NEED_CONTEXT` 与技术故障的 followup 路径统一：两者都有 `judgeSessionId`，都 followup，仅 followup 文本附注不同。

### R5：引擎不做 followup 失败的自动兜底

followup 之后的异步 turn 若再次失败（再次未调 `judge_claim` / agent 异常），引擎只再次 BLOCK 并记录 detail，**不自动清 `judgeSessionId`、不自动转 spawn**。是否继续 followup、还是改走 spawn，由 Manager 依据 detail 自行判断。

## 6. `judge_respawn` 工具

### R6：工具定义

新增 Manager 专用工具：

```ts
judge_respawn({
  nodeToken: string,
  reason?: string   // 可选，写入 trace log，说明为何重建
})
```

语义：

1. 校验 `run.status === 'blocked'`、`nodeToken` 匹配当前 top frame token、调用者是 Manager；
2. 校验当前处于判定阶段（`pendingClaim` 存在）；
3. drain 旧 Judge（如有 `judgeSessionId`），清掉映射、撤销授权；
4. 用 `pendingClaim` 恢复判定阶段并重新计算 Node-local projection，spawn 新 Judge 并重投完整 packet（packet 仍只含 A1 R7 的 outcome/summary；`handoffContext` 保留在 State，PASS 后交给下一 Node）；
5. 写回新 `judgeSessionId`，`status = 'running'`，`blockReason = null`。

一次调用完成重建，无需再 `node_resume`。

### R7：权限

- Manager 可用（沿用 authz 的 Manager 全放行分支）。
- Role Actor 被 `ROLE_ALLOWED` 拒绝。
- Judge 被 `JUDGE_ALLOWED` 拒绝（Judge 只读，不得重建自己）。

### R8：与 `node_resume` 分工

| 场景 | 工具 | 动作 |
|---|---|---|
| 无 `judgeSessionId`（首次 spawn 即失败） | `node_resume` | 自动 spawn 重建 |
| 有 `judgeSessionId`，Manager 认为可续 | `node_resume` | followup |
| 有 `judgeSessionId`，Manager 判断不可续 | `judge_respawn` | 清映射 + spawn 重建 |

## 7. `pendingClaim` 状态

### R9：判定阶段持有

Worker 的 `node_claim` 目前是 transient。为保证 spawn 重建能重投完整 Judgment Packet，claim 一旦进入判定阶段即持久化 `{ outcome, summary, handoffContext? }`：

- 判定阶段开始（claim 接受、进入 Judge 判定）→ 写入 `pendingClaim`；
- Judge 产出 PASS/FAIL → 清除 `pendingClaim`；
- BLOCK（含 `NEED_CONTEXT` 与技术故障）期间 → 保留，供 resume / respawn 重建使用。

`pendingClaim` 记录的是 **Worker 提交的 claim 结果**，不是 Judge 历史；spawn 重建不读取、不续接任何旧 Judge Session 的内容。

### R10：handoffContext 持久化（评审修正，方案 2）

`handoffContext` 不再走进程内 `handoffByToken` 内存映射，而是随 claim 一并写入 `pendingClaim.handoffContext`：

- `completed` claim 且 `handoffContext` 非空 → 持久化；
- Host 在判定期间重启 → handoff 不丢失；respawn / spawn 重建后 Judge PASS，handoff 仍能投递到下一 Node；
- 判定结束（PASS/FAIL）随 `pendingClaim` 一起清除；
- 判定阶段 BLOCK 后 Worker **重新 claim** 会覆盖 `pendingClaim`（含 handoff）——这正是「重新 claim 必须重新提供 handoff」的语义。

## 8. 状态模型

在 A1 的 `judgeSessionId` 与 `NodeContextBoundary` 之外，A4 新增：

```ts
pendingClaim?: { outcome: 'completed' | 'failed'; summary: string; handoffContext?: string }
```

`handoffContext` 字段只有在 `completed` 且非空时才写入（lossless JSON 序列化要求：不写 `undefined` 值）。

不新增：

- `faultKind` / 故障分类枚举；
- 独立持久化的 `detail` 字段（`detail` 只进 `blockReason` + trace log）；
- 旧 Judge 历史映射；
- 自动重试 / 降级解析策略。

## 9. 非目标

- 不引入故障分类枚举，不按 fault kind 驱动控制流。
- 不在引擎层自动判断 followup 是否可续、不自动清 `judgeSessionId` 兜底。
- 不记录、不复用旧 Judge Session 的上下文。
- 不自动重试 Judge。
- 不把 Judge 异常降级为文本解析（A1 已用 `judge_claim` 协议取代 one-shot structured output）。
- 不改变 Graph 的 PASS/FAIL edge schema。

## 10. 验收标准

- **AC1 诊断可读**：技术故障 BLOCK 时 `blockReason` 以 `judge fault: <detail>` 形式包含具体异常 / stopReason，trace log 记一行。
- **AC2 无 faultKind**：state 不出现任何故障分类枚举；控制流只读取 `judgeSessionId` 是否存在。
- **AC3 followup 恢复**：有 `judgeSessionId` 时 `node_resume` → followup 同一 Judge（附 `resolutionContext`），不重派 Actor、不重建。
- **AC4 spawn 恢复**：无 `judgeSessionId` 时 `node_resume` → spawn 新 Judge 并重投 packet（instruction + criteria + `pendingClaim` 的 outcome/summary + projection；`handoffContext` 保留在 State，PASS 后交给下一 Node）。
- **AC5 respawn 重建**：有 `judgeSessionId` 时 `judge_respawn` → 清映射 + drain 旧 Judge + spawn 新 Judge 重投 packet，`status` 转 `running`。
- **AC6 pendingClaim 生命周期**：claim 进入判定时持久化 `outcome`+`summary`；PASS/FAIL 后清除；BLOCK 期间保留可供重建。
- **AC7 旧 Judge 退役**：spawn 重建后不再 followup 旧 Judge；旧 Session 仅作历史保留，不再授权。
- **AC8 权限隔离**：`judge_respawn` 仅 Manager 可用；Role Actor 与 Judge 调用被拒绝。
- **AC9 stale 安全**：旧 token 的 `judge_respawn` 被拒绝，不修改 state。
- **AC10 不自动重试**：技术故障一律 BLOCK，不自动 spawn / followup 重试。
- **AC11 回归门禁**：现有单元 / engine / e2e smoke 全过，并新增 fault 诊断、respawn 重建、`pendingClaim` 生命周期的覆盖。

## 11. 已确认决策

1. 不引入 faultKind，仅保留可读 `detail` 字符串。
2. 恢复控制流只看 `judgeSessionId` 是否存在。
3. 引擎不做 followup 失败的自动兜底，由 Manager 判断。
4. 新增 `judge_respawn` 工具（而非给 `node_resume` 加参数）作为显式重建渠道。
5. spawn 重建 = 重新执行一次 claim → checker 判定，不记录旧 Judge 历史。
6. 判定阶段持有 `pendingClaim`，判定完成清除。
7. 不自动重试；诊断仅进 `blockReason` + trace log + 模板。
