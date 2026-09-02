# PRD：A3 Actor 回合结束未提交结果的防护与通知

- 日期：2026-09-02
- 来源问题：`docs/pending-discussions/live-e2e-issues.md` A3
- 状态：方案已确认，等待与其他问题统一梳理后开发

## 1. 背景

Role Actor（或执行 actor-task 的 Manager）输出文字报告后结束回合、但未调用 `node_claim`，引擎按 fail-closed 将其判为可恢复暂停：`handleTurnEnded` 写入 BLOCK，`blockReason='actor-turn-ended-without-result'`。

真实 e2e 中 reviewer 因此 BLOCK。根因是派发文本只含 `instruction`，缺少「必须用 `node_claim` 提交」的硬约束；且该 BLOCK 是被动的——Manager 只能靠 status 发现，产生「为什么没有任务在跑」的困惑。

本调整做三层：**防**（派发时统一注入提交硬约束）、**兜底**（保留无结果 BLOCK 语义）、**可观测**（BLOCK 时主动通知 Manager）。

## 2. 目标

1. 所有 actor-task 派发文本统一携带「必须调用 `node_claim` 提交」的硬约束。
2. 保留 fail-closed 语义：回合结束无结果仍 BLOCK，不自动重派。
3. `actor-turn-ended-without-result` 的 BLOCK 主动通知 Manager，说明原因与可选动作。

## 3. 术语

- **actor-task**：由 Manager 或 continuable Role Actor 执行、必须配置 Checker、由 Worker claim 后交给 Judge 判定的 Node 类型。
- **无结果回合结束**：Actor 的 turn 结束，但该 turn 未调用 `node_claim`（也未 `node_block`）提交任何结果。

## 4. 规则

### R1：派发统一注入提交硬约束

`dispatchCurrent` 对 `actor-task` 类型（含 `role === 'manager'` 与 Role Actor 两种）统一在派发文本末尾 append 固定硬约束：

```text
[提交要求]
完成后必须调用 node_claim 提交结果（outcome: completed | failed，并附 summary）。
仅输出文字不视为提交，会导致当前 Node BLOCK。
```

约束：

- 只 append，不替换 `instruction` / `handoff` 原文；
- `builtin-program` 与 `child-workflow` 的派发不注入该文本；
- 该提示属于引擎注入内容，A1 的 Node-local projection 应照常将其排除在 Judge 投影之外。

### R2：保留安全暂停，不自动重派

`handleTurnEnded` 对「turn 结束但无 `node_claim`/`node_block`」继续写入 BLOCK，`blockReason='actor-turn-ended-without-result'`。**不引入自动重派**——恢复仍是 Manager 通过 `node_resume` 主动发起（与 A4「不自动重试」一致）。

### R3：BLOCK 主动通知 Manager

该 BLOCK 复用 A4 定义的「BLOCK 主动 steer Manager」机制，发送固定模板：

```text
⚠️ Actor 未提交结果（workflow <id> / node <nodeId>）
当前 Actor 结束回合但未调用 node_claim。
当前 Node 已 BLOCK，未推进。
可选动作：
  1. node_resume({nodeToken, resolutionContext}) —— 将你的指示交给当前 Actor 继续并提交；
  2. node_block 保留现场等待人工。
```

### R4：Node 内 resume 不再重复注入

`node_resume` 后重新派发同一 Node 时，提交硬约束仍随派发文本 append（保持一致）；不因重复派发而产生额外状态。

## 5. 与 A4 的关系

- A4 已定义「技术故障 BLOCK 主动 steer Manager 固定模板」的通用机制；A3 的 `actor-turn-ended-without-result` 复用该机制，仅模板文案不同。
- 两者都不自动重试，统一遵循「BLOCK + Manager 兜底」。

## 6. 状态模型

不新增持久化状态字段。派发提示是文本级注入，BLOCK 通知复用现有 `blockReason` 与 A4 的 steer 机制。

## 7. 非目标

- 不自动重派 Actor。
- 不改变 fail-closed 语义或 `actor-turn-ended-without-result` 的 BLOCK 结果。
- 不修改具体 workflow 的 persona（milestone-delivery.yaml 不在本仓库）。
- 不在 Node-local projection 中暴露该派发提示给 Judge。

## 8. 验收标准

- **AC1 统一注入**：actor-task（manager 与 role）派发文本包含「必须调用 `node_claim` 提交」硬约束。
- **AC2 范围正确**：builtin-program 与 child-workflow 派发不包含该约束。
- **AC3 不替换原文**：`instruction` 与 `handoffContext` 原文完整保留，约束以 append 形式存在。
- **AC4 保留安全暂停**：turn 结束无 `node_claim`/`node_block` 仍 BLOCK，reason 为 `actor-turn-ended-without-result`，且不发生自动重派。
- **AC5 主动通知**：该 BLOCK 触发一次 `steerManager`，模板含「未提交结果」与 `node_resume` 指引。
- **AC6 投影排除**：A1 的 Node-local projection 不把派发提示当作用户/Manager 历史喂给 Judge。
- **AC7 回归门禁**：现有单元 / engine / e2e smoke 全过，并新增派发提示注入、BLOCK 通知的覆盖。

## 9. 已确认决策

1. 引擎统一注入「必须 `node_claim`」派发提示（不依赖 yaml persona）。
2. 保留安全暂停语义，不自动重派。
3. `actor-turn-ended-without-result` 复用 A4 的 BLOCK 主动通知机制。
