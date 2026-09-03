# Pending Discussion：A2 Node 边界 compact 的前提与 DSH continuable 语义不符

- 日期：2026-09-03
- 来源：20260902-fixbug A1–A4 修复的 review 核实（对照 `deepseek-harness` 源码）
- 状态：待议（当前决策：保留代码 + 记录，真实 e2e 验证后再定）

## 问题

A2 PRD（`docs/prd/20260902-fixbug/a2-node-boundary-actor-compaction.md`）的核心前提是：

> 在 `dispatchCurrent` 中……当前 Node 已 mapping 到已有 Role Actor 时，在 followup 之前对其执行 compact……取 resident Agent（`ctx.agents.get(childId)`）后调用 `compactNow`

但 DSH 的 continuable subagent 语义（`packages/subagent/subagent/src/continuation.ts` + README "Continuable children and Activations"）是：

- 每个 continuable child 有一个 durable Session 和至多一个进程内 **Activation**（residency epoch）；
- residency 三态：`running` / `waiting` / `settled` —— **`settled`（quiescent 且无 owned children）时 continuation manager 自动 dispose `AgentHandle` 并移除 Activation**（`watchSettlement`，`continuation.ts:1295`）；
- 即 Actor 的 turn 一结束（提交 `node_claim` 后），Activation 在微任务级被自动释放；
- `compactNow`（`packages/compaction/compaction-basic/src/index.ts:368`）要求活的 idle `Agent`（走 `agent.runMaintenance`），无法对持久化 Session 直接操作。

而 Engine 的下一个 Node 派发发生在 Judge verdict 之后（至少一次 LLM 往返，秒级），届时 `ctx.agents.get(childId)` 几乎必然返回 `undefined` → `compactRoleActor` 返回 `cold-resume skip` → **A2 的显式 Node 边界 compact 在真实运行中几乎永不触发**。Actor 的上下文控制实际仍由 DSH 的 pressure-based auto-compaction 兜底（A2 之前的现状）。

影响：A2 AC1（"已有历史的 Role Actor 在派发新 Node 前被执行一次 compactNow"）与 AC8（"上下文受控在 summary + 当前 Node"）在当前框架语义下不可达成。

## 已核实证据

- `continuation.ts:932-936` `stateOf`：`settled` = idle + 无 accepted inbox + 无 owned children；
- `continuation.ts:1136` `watchSettlement(activation)` 在 materialization 时无条件安装；
- `continuation.ts:1295-1330` settled → `dispose(activation)`（自动释放）；
- `compaction-basic/src/index.ts:368` `compactNow(agent, signal)` 需要活 Agent；
- README:76 "settled (quiescent with every owned child disposed, so the manager disposes the AgentHandle and removes the Activation)"。

## 当前处理（已决策）

1. **保留现有实现**：resident 时才 compact（无害 no-op），cold-resume 跳过路径不变；
2. compact 失败仍然 BLOCK 并主动通知 Manager（A2 R4/AC5，已实现）；
3. 真实 e2e（milestone-delivery）观察长 run 下 Actor 的实际 token/上下文行为，由数据驱动下一步。

## 备选方向（真实 e2e 后再议）

- **(a) 接受现状**：文档明确 A2 目标由 DSH auto-compaction 实际承担，移除 compact 调用或保持 no-op；
- **(b) turn 结算点竞速 compact**：在 Actor 的 `turn/end` 结算处（`handleTurnEnded`）best-effort 尝试 compact——与 `watchSettlement` 的 dispose 竞速，可靠性无保证；
- **(c) 向 DSH 提需求**：例如公开的 maintenance-resume API（cold-resume 一个 Agent 仅用于 `compactNow` 后立即释放），或「followup 前钩子」，使 Node 边界 compact 可靠化。

## 关联

- `CONTEXT.md` → Role Actor 词条已按现状更新；
- A2 PRD 的 AC1/AC8 在方向确定前视为「受框架能力限制」。
