# PRD：A1 Claim Admission 与 Judge 确认协议

- 日期：2026-09-03
- 来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 复盘
- 状态：核心语义已确认，待实现
- 关联问题：未实际 dispatch 的节点可以提前 claim；Judge REJECT 原因未传回 Actor；Actor 不应手工填写 nodeToken

## 1. 背景

当前引擎把 Actor 的 `node_claim(outcome)` 与 Judge 的 `judge_claim(PASS|FAIL)` 当成两套相互独立的结果：Actor 的 outcome 仅进入 Judgment Packet，而 Judge 的 PASS/FAIL 直接决定 Graph Edge。该语义使 Judge 实际承担了“重新决定节点结果”的职责，而不是“核实 Actor 的声明是否正确”。

真实 run 暴露了三个相互关联的问题：

1. `initialize-milestone` PASS 后，State 已把 frame 改成 `plan-issues`，但该 Node 尚未真正 dispatch。Manager 通过 `workflow_status` 看到新 token 后成功提前 claim；之后旧 instruction 才到达，造成状态与消息错位。
2. Developer 对 `implement` 连续两次 claim completed。Judge 两次都因“改动未 commit/push，未 published”而 FAIL，但 Judge reason 未传回 Developer；Developer 只能收到自己的旧 handoff，因而重复同一错误。
3. Developer 首次尝试以 `nodeToken: "unknown"` 调用 `node_claim`。当前 dispatch prompt 要求必须 claim，却既不附 token，也不要求先读 `workflow_status`。让模型手工搬运 token 增加摩擦；而 Actor 在迟到时读取 `workflow_status` 又会取得最新 token，无法证明该 claim 属于原 dispatch。

## 2. 已确认目标

1. 只有**已经真实 dispatch 给精确 executor 的 Node**才接受 Actor claim。
2. Actor claim 表达候选业务结果；Judge 只判断该 claim 是否可信，不替 Actor 改写结果。
3. Judge 认为 claim 不正确时，不走 Graph FAIL Edge；当前 Node 返回同一 Actor 修改，并携带完整 Judge 反馈。
4. Actor 调用 `node_claim` 时不再手工提供 nodeToken；Host 将 claim 绑定到产生该调用的精确 Node dispatch。
5. 内部 nodeToken 继续保留，用于 State、Judge、BLOCK/resume、并发与 stale-safety；本 PRD只移除 Actor-facing `node_claim` 参数。

## 3. 新结果模型

### 3.1 Actor Claim

Actor 继续提交：

```ts
node_claim({
  outcome: 'completed' | 'failed',
  summary: string,
  handoffContext?: string,
})
```

`nodeToken` 不再由 Actor/Manager 模型填写。

含义：

- `completed`：Actor 声明节点要求已完成，候选 Graph 结果为 PASS。
- `failed`：Actor 声明节点要求未完成或无法完成，候选 Graph 结果为 FAIL。
- Claim 不是最终 Graph verdict，必须经 Judge 确认。

### 3.2 Judge Confirmation

为消除与 Graph PASS/FAIL 的语义混淆，Judge 协议改为：

```ts
judge_claim({
  nodeToken: string,
  result: 'ACCEPT' | 'REJECT' | 'NEED_CONTEXT',
  reason: string,
})
```

- `ACCEPT`：Actor claim 与真实事实、instruction、criteria 一致。
- `REJECT`：Actor claim 不正确或证据不足以支持其 outcome，但 Judge 已有足够事实指出应如何修改。
- `NEED_CONTEXT`：仅靠当前 packet 与只读现场无法判断 claim 对错，需要 Manager 补充；沿用现有 BLOCK/followup 语义。

Judge 不再直接提交 Graph PASS/FAIL。

### 3.3 路由真值表

| Actor outcome | Judge result | Graph 行为 |
|---|---|---|
| `completed` | `ACCEPT` | 沿 `onPass` 前进 |
| `failed` | `ACCEPT` | 沿 `onFail` 前进；无 `onFail` 则 BLOCK |
| `completed` | `REJECT` | 不走 Graph Edge；重派当前 Node 给原 Actor |
| `failed` | `REJECT` | 不走 Graph Edge；重派当前 Node 给原 Actor |
| 任意 | `NEED_CONTEXT` | 当前 Node BLOCK；保留 pending claim 与 Judge，等待 Manager followup |

因此，“Actor completed、Judge 不认可”不再被解释为 Graph FAIL；它只是 claim correction。

## 4. Claim Admission Gate

### R1：已 dispatch 才可 claim

`handleClaim()` 在现有 status/token/kind/executor 检查之外，必须验证：

- 当前 Node 已建立有效 `NodeContextBoundary`；
- 当前 Node token/generation 与实际 dispatched token/generation 一致；
- 当前 caller 是该 dispatch 的精确 executor；
- caller 的当前 turn 确实由该 Node 的 dispatch message 启动，而不是同一复用 Actor 的旧 turn。

仅 State 已 advance 到新 Node 不代表 Node 已 dispatch，不得接受 claim。

### R2：显式 Dispatch Lease

引擎为每次 actor-task dispatch 建立内部 `ActorDispatchLease`（名称可调整）：

```ts
interface ActorDispatchLease {
  workspaceKey: string
  workflowId: string
  nodeId: string
  nodeToken: string
  executorSessionId: string
  dispatchMessageId: string
  consumed: boolean
}
```

要求：

- lease 在 dispatch 成功后才发布；dispatch 失败不得产生可 claim lease。
- 每个 lease 最多接受一个 `node_claim` 或 `node_block`。
- claim 接受后立即标记 consumed；Judge pending 期间再次 claim 必须拒绝。
- Node 离开、reset、restart reconciliation 时 lease 失效。
- Host restart 后 running run 仍按现有规则 BLOCK，不尝试从不完整的内存 lease 猜测恢复。

### R3：caller turn 与 dispatch 绑定

仅依赖 `executorSessionId` 不够：Role Actor 会跨 Node 复用，同一 session 的迟到 tool call 可能落到该 role 的后续 Node。

Host 必须把 tool call 绑定到 dispatch message/turn generation：

- Role Actor：使用 `nodeBoundary.executorDispatchMessageId` 与 caller 当前 turn 的起始 user message 建立关联。
- Manager：`steerManager` 需要返回或记录 dispatch message id/seq，使 Manager claim 同样能绑定到具体 Node dispatch。
- 若现有 Host tool-call context 无法取得 caller turn 起点，则实现前必须先补该观测 seam；不得退化为“直接取当前 topFrame token”并宣称 stale-safe。

## 5. Actor-facing nodeToken 变更

### R4：node_claim 不再要求 nodeToken

- Tool schema 移除必填 `nodeToken`。
- Host 从有效、未消费的 `ActorDispatchLease` 解析内部 nodeToken，再调用 Engine。
- 没有唯一有效 lease 时 fail-closed，返回“当前调用无法绑定到一个已 dispatch Node”。
- 不允许通过 `workflow_status` 取最新 token 来修复旧 turn 的 claim；正确性由 dispatch binding 决定。

### R5：保留 token 的范围

以下协议继续保留 nodeToken：

- `judge_claim`：Judge 可能迟到，必须校验当前 Node/Judge 映射。
- `node_resume`、`judge_respawn`、`node_resolve_program`：Manager 控制动作仍需显式确认当前现场。
- `node_block` 暂不在本 PRD 中移除 token；后续可复用 Dispatch Lease 再评估。
- `CallFrame.nodeToken` 与持久 State 保留。

## 6. REJECT → Actor Correction

### R6：不走 Graph Edge

Judge `REJECT` 时：

1. 清除/退役当前 Judge。
2. 清除当前 `pendingClaim`。
3. 保持 workflowId/nodeId 不变。
4. 为本次 correction 生成新的内部 nodeToken 与 dispatch lease。
5. 将 Judge reason 与 Actor 上次 claim 内容作为 transient correction context 发给原 Actor。
6. 不读取 `onFail`，不写 `NODE ... FAIL -> ...` Graph 路由日志。

### R7：反馈格式

重派 Actor 的消息至少包含：

```text
[judge rejection]
<完整、长度受限的 Judge reason>

[previous claim]
outcome: <completed|failed>
summary: <summary>
handoffContext: <handoffContext when present>

[instruction]
<原 Node instruction>
```

Actor 必须能明确知道：哪里不正确、需要补什么、重新 claim 的条件是什么。

### R8：边界与上下文

REJECT 属于同一业务 Node 的 claim revision，而不是 Graph 自环：

- workflowId/nodeId 保持不变；
- Node-local boundary 默认保留，使下一 Judge 能看到该 Node 内先前 Actor claim、Judge rejection 与修正过程；
- 新 Actor turn 使用新 dispatch lease；
- 是否在多次 correction 后执行 compact 由 A4 Cold-resume 调查结论决定，不在本 PRD 直接引入计数上限。

## 7. 配置与版本兼容

该变更修改了 `judge.goal-satisfied` 的既有语义：原来 Judge PASS/FAIL 直接决定 Graph Edge，新协议由 Actor outcome 决定候选 Edge、Judge 仅 ACCEPT/REJECT。

实施时必须在以下方案中做显式版本决定：

- 推荐：新增 `agent-workflow/v2` 与 checker `judge.claim-correct`，v1 保持旧语义；提供 milestone-delivery v2 配置。
- 若项目确认 v1 尚未形成兼容承诺，也可原地升级，但必须同步 `CONTEXT.md`、设计文档、工具 schema、所有示例和 tests，并在 release note 标为 breaking semantic change。

禁止在不记录兼容决策的情况下静默改变 v1。

## 8. 非目标

- 不让 Judge 修改实现文件或执行 Graph 控制动作。
- 不让 Judge 把 `REJECT` 映射到 `onFail`。
- 不删除内部 nodeToken 或 Judge stale-safety。
- 不在本 PRD 解决 provider 额度重试、cold-resume compaction、GitHub 集成策略。
- 不自动限制 Actor correction 次数；若真实运行仍出现无反馈循环，再单独设计策略。

## 9. 验收标准

- **AC1 未 dispatch claim 被拒**：State 已 advance、Node 尚未 dispatch 时，Manager/Role Actor claim 必须失败，且不 spawn Judge、不改变 State。
- **AC2 dispatch 后可 claim**：同一 Node dispatch 成功后，不传 nodeToken 的精确 executor claim 被接受并绑定内部 token。
- **AC3 迟到 Actor 安全**：复用同一 role session 的旧 turn tool call 不能污染该 role 的后续 Node。
- **AC4 单次 lease**：同一 dispatch 的第二个 claim/block 被拒绝。
- **AC5 completed+ACCEPT**：走 `onPass`。
- **AC6 failed+ACCEPT**：走 `onFail`；无 `onFail` 时 BLOCK。
- **AC7 completed+REJECT**：不走 `onFail`，重派同一 Node，Actor 收到 Judge reason 与上次 claim。
- **AC8 failed+REJECT**：不走任何 Edge，重派同一 Node。
- **AC9 NEED_CONTEXT**：维持现有 Judge followup/BLOCK 恢复语义。
- **AC10 Judge stale safety**：旧 Judge、旧 Judge token、已退役 Judge 的结果仍被拒绝。
- **AC11 Manager/Role 一致**：Manager actor-task 与 Role Actor 使用同一 dispatch-admission 原则。
- **AC12 回归**：补齐 engine/tools/host 测试；现有 unit/e2e 全绿。

## 10. 建议实现顺序

1. 为 Manager 与 Role dispatch 都建立可观测的 dispatch message/turn identity。
2. 增加 ActorDispatchLease 与 claim admission 测试。
3. 改 Actor `node_claim` schema，Host 自动绑定 token。
4. 引入 Judge `ACCEPT|REJECT|NEED_CONTEXT` 协议与路由真值表。
5. 实现 REJECT correction context。
6. 更新日志事件（与 A3 PRD 协同）。
7. 更新 schema/version、CONTEXT、设计文档与 milestone 配置。
