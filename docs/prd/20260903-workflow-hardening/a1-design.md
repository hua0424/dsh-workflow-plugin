# A1 设计：Claim Admission 与 Judge 确认协议

- 日期：2026-09-05
- 上游 PRD：`a1-claim-admission-and-judge-confirmation.md`（核心语义以 PRD 为准，本文只定机制）
- 状态：已定稿并实现（两轮设计评审修正后定稿，2026-09-05；同日按 §11 落地，实现记录见 PRD §13）
- 范围：Dispatch Lease 与 claim admission、caller turn 绑定、Judge ACCEPT/REJECT 协议、REJECT correction 流、v2 原地升级落地

## 0. 决策记录

| # | 决策 | 结论 | 出处 |
|---|---|---|---|
| D1 | §7 版本方案 | **原地升级**：`SCHEMA_VERSION` → `agent-workflow/v2`，checker 更名 `judge.claim-correct`，全量迁移配置/示例/测试/文档，release note 标 breaking semantic change。不维护 v1/v2 双轨 | 用户 2026-09-05 拍板 |
| D2 | Judge `revision` 字段（A3 遗留 AC4） | **不加**。REJECT 轮换 nodeToken 并退役 Judge（清 `judgeSessionId`），旧 Judge 重复提交被 token/judgeSession 双重拒绝；trace 去重继续用 token 前缀，另增 `CORRECT` 事件标记重派边界。A3 遗留项就此关闭 | 本设计 §6.6 |
| D3 | MODEL provider/modelId 长度上限（A3 遗留） | catalog 校验 + `handleSetRoleModel` 增加 LIMITS：provider ≤ 64、modelId ≤ 128 字符，统一 trim-后-规范化 | 本设计 §9 |
| D4 | correction 证据通道 | **持久化 `pendingCorrection`**（judge reason + previous claim 快照，随 RunState 落库），下一 Judgment Packet 直接携带 `[previous rejection]` 段；**不改** projection 的 source 过滤（避免 judgeFault 等机械通知泄漏进 packet）。同时解决 Manager 路径 projection 缺口（评审阻塞2）与 correction 派发失败后证据丢失（评审中5） | 评审修正，本设计 §6.4 |
| D5 | lease 存放位置 | **并入现有 per-workspace `DispatchBook`**（不另设 Map）：`dispatchCurrent` 返回派发身份、经 child-workflow 递归透传，全部发布收敛在 `dispatchNow` 单点，失效沿用 `dispatchBook.delete` 既有清理点（评审中6） | 评审修正，本设计 §3 |

D1 理由摘要（详见讨论记录）：工具 schema 全局单份，双轨会把 `judge_claim` enum 污染成五值并集、`node_claim` 的 nodeToken 变成按 run 版本分叉的运行时分支；双语义引擎路径是永久测试矩阵成本；唯一真实 catalog（milestone-delivery）部署配置只影响新 run；现存 v1 运行行在 host 重启后本就被 restart-reconcile BLOCK。旧 v1 行为见 §8.3。

## 1. Host seam 验证结论（R3 前提，已核实）

PRD R3 要求"若现有 Host tool-call context 无法取得 caller turn 起点，则实现前必须先补该观测 seam"。结论：**现有 DSH Host 已提供全部观测，无需改 DSH 核心**。

| # | 事实 | 依据 |
|---|---|---|
| F1 | 每次工具调用的 `exec`（`ToolRunContext`）携带 `callId` / `rootCallId` / `agent` | `@deepseek-ai/dsh-tools` types：`ToolRunContext extends ToolExecution` |
| F2 | `tool/call` 事件（带 `turn`、`callId`）在工具体执行**前**已 append | `dsh-agent-loop` `appendToolCall()`：call 事件先落 log，`tool/result` 引用其 seq；skipped call 也成对补记 |
| F3 | caller 的 session log 可同步读 | `Agent.session.events: readonly SessionEvent[]`（内存全量，append 同步可见） |
| F4 | `NodeContextBoundary.executorDispatchMessageId` 已存 followup/startContinuable 返回的 `messageId`，且该 id 就是子 session 对应 `user/message` 事件的 `message.id` | `dsh-subagent` `ContinuableStart.messageId`（"the accepted initial prompt's inbox message id"）；`Message.id` 跨边界稳定 |
| F5 | `steer()` 返回 void，但消息由插件构造——`createUserMessage` 当场分配 UUID id | `dsh-llm` `createMessage`：`id: MessageId(crypto.randomUUID())` |
| F6 | **Code Mode 嵌套调用不走 `tool/call`**：`run_code` 子派发只写 `tool/code-dispatch-start`（无 turn 字段），嵌套 `exec.callId = <parent>:code:<n>`，`exec.rootCallId` 指向根 `run_code` 调用；start 事件先于工具体落 log | `dsh-tools` code-mode `start()`；`CodeDispatchStartEventData` |

**绑定判定**：claim 所在 turn 的 `user/message` id **集合**包含当前 dispatch 的 message id，即视为绑定成功（R3"caller 的当前 turn 确实由该 Node 的 dispatch message 启动"）。

取"集合包含"而非"turn 首消息相等"的原因：steer 可能落在 Manager 正在运行的 turn 中段（进入下一步而非新 turn）。turn 内消息按 step 顺序被模型消费，工具调用发生在消费之后，因果上必然晚于 dispatch 抵达；而旧 turn 的 tool call 其 turn 内不含新 dispatch id，天然被拒。语义上两者等价，"集合包含"对 steer 时序更鲁棒。

## 2. Caller turn 绑定 helper（plugin 层）

新文件 `src/plugin/turnbind.ts`，纯函数、可独立单测。**必须覆盖 Code Mode 嵌套调用**（评审阻塞1）：`run_code` 内的子派发在 session log 中只写 `tool/code-dispatch-start`（携带 `rootCallId/parentCallId/subCallId/name`，**无 turn 字段**），不存在同 callId 的 `tool/call`；嵌套 `exec.callId` 形如 `<parent>:code:<n>`，根 `run_code` 调用才有普通 `tool/call`。

```ts
/**
 * 本次工具调用所在 turn 内全部 user/message 的 message id；无法推导时
 * undefined（fail-closed）。callId/rootCallId 取自工具 exec。
 */
export function callerTurnUserMessageIds(
  events: ReadonlyArray<{ type: string; seq: number; data: unknown }>,
  callId: string,
  rootCallId: string,
): ReadonlySet<string> | undefined
```

解析顺序：

1. **原生路径**：存在 `tool/call` 且 `data.callId === callId` → 以该事件的 `turn` 为准（原生 `tool/call` 恒在工具体执行前落 log，此分支必然命中）。
2. **Code Mode 路径**（原生分支未命中时）：须存在 `tool/code-dispatch-start` 且 **同时满足** `data.subCallId === callId` 与 `data.rootCallId === rootCallId`（证明本次调用确实是该根调用的代码内子派发，防伪造 callId 蹭根调用；root 关联使异常日志的 fail-closed 定义完整——评审第二轮中4），再以 `data.callId === rootCallId` 的 `tool/call`（根 `run_code`）定位 turn。两者任一缺失 → undefined。
3. 无论哪个分支定位到 turn `T`：单次倒序扫描自命中事件回溯，收集沿途 `user/message` 的 `data.id`，直到 `turn/start` 且 `turn === T` 为止；若先越过 turn 边界仍未命中起点 → undefined（log 异常，fail-closed）。

时序保证：`tool/code-dispatch-start` 由 code-mode 的 start() 在 scheduler.prepare（即工具体执行）**之前** append，因此工具体运行期间两个定位事件都已在 log 中。

接线：`src/tools/tools.ts` 的 `node_claim` / `node_block` 在 authorize 通过后，用 `exec.agent.session.events` + `exec.callId` + `exec.rootCallId` 计算集合（enqueue 之前快照——turn 内 id 集合只增不改，快照安全），随 caller 传给 host → engine。

## 3. ActorDispatchLease（R2）——并入 DispatchBook（D5）

lease 不单独建 Map（评审中6：`dispatchCurrent(run, transientContext)` 无 workspaceKey 且递归派发 child，独立 Map 需要另行传参与双套清理）。**并入现有 per-workspace `DispatchBook`**：

```ts
/** 一次性 transient 派发上下文（评审中4：kind 必须贯穿延迟派发）。 */
type TransientDispatch =
  | { kind: 'handoff'; text: string }
  | { kind: 'correction'; text: string }

interface DispatchBook {
  dispatchedToken: string
  executorSessionId: string
  pendingDispatch: boolean
  transientContext: TransientDispatch | null   // 原 string | null
  workerSettled: boolean
  /** A1 R2：本次实际派发的 user message id；仅真实 dispatch 后存在（即 lease 主体）。 */
  dispatchMessageId?: string
  /** lease 已被一个 node_claim/node_block 消费。 */
  leaseConsumed: boolean
}
```

lease 有效判据（admission 使用，单一真值来源）：

```
book 存在 && !book.pendingDispatch && !book.leaseConsumed
&& book.dispatchMessageId !== undefined
&& book.dispatchedToken === topFrame(run).nodeToken
&& book.executorSessionId === caller.sessionId
&& book.dispatchMessageId ∈ caller.turnUserMessageIds
```

失效语义完全复用既有 `dispatchBook.delete` 调用点（handleBlock / blockOnJudgeFault / handleJudgeTurnEnded / program ERROR BLOCK / restart-reconcile clear / handleReset / 完成），且 `persistDeferred` 覆盖 book 时天然丢弃旧 lease（token 已轮换，防御性判据兜底）——**零新增清理点**。不持久化：host 重启后 running run 一律 BLOCK（现有 restart-reconcile），恢复必经 resume → 重新 dispatch → 新 lease，符合 R2"不尝试从不完整的内存 lease 猜测恢复"。

### 3.1 发布（dispatchNow 单点）

`dispatchCurrent` 签名改为**返回派发身份**：

```ts
interface DispatchIdentity {
  executorSessionId: string
  dispatchMessageId: string   // steer/followup/startContinuable 的 user message id
}

async dispatchCurrent(run, transient): Promise<DispatchIdentity | undefined>
```

- manager actor-task / role followup / role 新建三条路径各返回 `{executorSessionId, dispatchMessageId}`；
- builtin-program 节点返回 `undefined`（不产生 lease：program 节点不接受 claim）；
- child-workflow 分支**透传内层递归的返回值**（lease 属于最内层真实 actor-task 派发）。

发布点收敛在 `dispatchNow()`（现有四个调用方 startRun / handleJudgeClaim / handleResume / handleTurnEnded 全部经过它）：dispatchCurrent 成功返回 `DispatchIdentity` 后写入 book 的 `dispatchMessageId` + `leaseConsumed = false`，与现有 `dispatchBook.set` 同一处完成。send 抛错 → dispatchCurrent 抛出 → dispatchNow BLOCK → book 删除——"dispatch 失败不得产生可 claim lease"。

**无 lease 节点的显式初始化（评审第二轮阻塞1）**：`DispatchIdentity === undefined`（builtin-program 节点）时，book 必须显式初始化为无 lease 态：`dispatchMessageId: undefined, leaseConsumed: true`——"无 lease"是一等状态而非字段缺省，防止后续逻辑把"字段缺失"误读为"尚未发布"。

同时 manager 节点补写 `nodeBoundary.executorDispatchMessageId`（字段已存在，此前仅 role 路径填写）——manager 节点 boundary 的其余语义（`dispatchedAt`/`managerFromSeq`）不变。

### 3.2 消费（一次性；acceptance 边界在持久化之后——评审第二轮中2）

- `handleClaim`：**`leaseConsumed = true` 的时点在 `state.put`（pendingClaim + judgeSessionId 持久化）成功之后、`startJudge` 之前**。完整顺序：最终 re-read → log CLAIM → `state.put` 成功 → `book.leaseConsumed = true` → startJudge。put 失败（故障注入 `failNextPuts` 可模拟）时 State 未接受 claim，lease 保持未消费，同一 Actor 可原样重试——workspace mutation 本身经 enqueue 串行，无需提前消费防并发。同一 lease 的第二个 claim 在持久化成功后被拒（AC4）。
- `node_block`：现状即"持久化成功后 `dispatchBook.delete`"——BLOCK 使 lease 随 book 消失，不留 consumed 残留；put 失败时 book 原样保留（可重试）。

### 3.3 失效

见上——沿用 `dispatchBook.delete` 既有调用点；admission 判据中的 token/executor 匹配为防御性双保险，清理是收敛加速而非正确性依赖。

## 4. steerManager 变更（R3 Manager 侧）

`DispatchTargets.steerManager(run, text)` 返回值 `void` → `Promise<{ messageId: string }>`：

```ts
async steerManager(run, text) {
  const manager = adapters.managerAgentOf(run)
  if (manager === undefined) throw new WorkflowError('manager agent is not live in this process')
  const message = createUserMessage({
    content: textBlocks(text),
    source: { kind: 'plugin', plugin: 'dsh-agent-team-workflow' },
  })
  manager.steer(message)
  return { messageId: message.id }
}
```

- 通知类调用（judgeFault/needContext/actorNoResult/compactFault/completion）忽略返回值，行为不变。
- 已知限制（记录，不处理）：steer 在 cancellation/disposal 时可能被丢弃——消息从未进 session log，claim 永远无法绑定 → fail-closed 拒绝；节点停摆由现有 `actor-turn-ended-without-result` BLOCK（turn 若启动过）或 Manager 人工介入兜底。这与"dispatch 失败不产生 lease"一致。

## 5. Claim Admission Gate

### 5.1 `node_claim`（R1 + R4）

Tool schema：移除 `nodeToken` 参数（AC2）。`NodeClaim` 类型去掉 `nodeToken` 字段。

`handleClaim(workspaceKey, claim, caller)` 第三参从 `callerSessionId: string` 改为：

```ts
interface ClaimCaller {
  sessionId: string
  turnUserMessageIds: ReadonlySet<string>   // §2 快照
}
```

准入顺序（fail-closed，返回 R4 指定文案族）：

1. `state.get` → 无 run 拒绝；
2. `run.status !== 'running'` 拒绝；
3. `currentNodeKind !== 'actor-task'` 拒绝；
4. checker 存在且为 `judge.claim-correct`（§8）；
5. **lease 准入**（§3 判据，读 DispatchBook）：book 缺失 / `pendingDispatch` / `leaseConsumed` / 无 `dispatchMessageId` / token 不匹配 / executor 不匹配 / `dispatchMessageId ∉ caller.turnUserMessageIds` → 拒绝，文案：`当前调用无法绑定到一个已 dispatch 的 Node`（显式覆盖 PRD 问题 1：State 已 advance、Node 未 dispatch 时 book 处于 pendingDispatch 或 dispatchMessageId 缺失，必然落此分支，不改 State、不 spawn Judge——AC1）；
6. `run.pendingClaim !== undefined` / inFlight 检查（现状保留）；
7. 最终 re-read（entered 状态复核）中 token 校验改用 book 的 `dispatchedToken`（此时与 topFrame 必相等，防御性保留）；
8. 通过后走现有 judge spawn 流程；`book.leaseConsumed = true` 在 `state.put` 成功之后、`startJudge` 之前置位（§3.2 acceptance 边界——put 失败时 lease 未消费，Actor 可重试）。

executor 精确性由 lease 隐含（book.executorSessionId 即 dispatch 目标）。**实现注（评审修正）**：`handleClaim` 中原 `executorSessionOf` 显式检查已并入 lease 判据而非保留为独立断言——lease 用 dispatch 时的真实 executor（与漂移中的 `roleActors` 映射无关），重复一道基于映射的检查只会在映射缺失时弱化语义；`executorSessionOf` 仅保留给 turn 结算等不涉及准入的路径。

`workflow_status` 返回的 `currentFrame.nodeToken` 保留（node_resume / judge_respawn / node_resolve_program 仍需，R5）；仅 `node_claim` 不再消费它。

### 5.2 `node_block`（评审第二轮阻塞1修正分类）

- 参数保留 `nodeToken`（R5），现有 status/token/executor 检查不变。
- **lease 绑定只适用于 `actor-task` 节点**：当前节点为 actor-task 且 caller 是其精确 executor（Manager-executor 或 role Actor）时，须通过与 claim 相同的 lease 绑定检查（同 turn、未消费）并消费——同一 dispatch 的第二个 claim/block 被拒（AC4），旧 turn 的迟到 block 也被拒（AC3 同源）。
- **builtin-program / child-workflow 节点上的 Manager `node_block`：控制面动作**，不走 lease。理由：`executorSessionOf()` 对这两类节点返回 Manager Session（Manager 驱动 program 参数/child 准入），但它们**不发布 lease**（§3.1 DispatchIdentity 为 undefined）——若按"精确 executor"归类会因无 lease 而永久拒绝，破坏现有语义。这两类节点只校验 status/token/caller（现状）。
- **Manager 对 role-executor 的 actor-task 节点调用 `node_block`**：同样控制面（与 node_resume 同类），不走 lease，现状语义保留；BLOCK 使 lease 随 book 消失（§3.2）。

> **实现评审修正（fail-closed）**：初版实现以 `executorSessionOf()` 判定"精确 executor"，但该函数读的是会漂移的 `roleActors` 映射——当前 role 映射缺失时返回 `''`，executor 检查与 lease 门槛双双短路（fail-open）。最终实现改为**按 Node role 分类**：program/child 节点拒绝一切非 Manager caller；manager-executor 节点拒绝一切非 Manager caller 且 Manager 须过 lease；role-executor 节点上 Manager 走控制面、任意非 Manager caller 必须过 lease（book.executorSessionId 即 dispatch 真值，与映射无关）。映射缺失时 `''` 不再是任何逃生门。

### 5.3 判定阶段的一致性

claim 被接受后进入 judgment phase（`pendingClaim` + `judgeSessionId` 已持久化）：`leaseConsumed` 已置位，同 turn/新 turn 的重复 claim 在第 5 步被拒——与现状 `a judgment is already pending` 双保险，拒绝理由更早更准。

## 6. REJECT → Actor Correction（R6–R8）

### 6.1 `handleJudgeClaim` 路由真值表

| Actor outcome（`pendingClaim.outcome`） | Judge result | 行为 |
|---|---|---|
| completed | ACCEPT | `advance(run, 'PASS', reason, 'judge')` → onPass（AC5） |
| failed | ACCEPT | `advance(run, 'FAIL', reason, 'judge')` → onFail；无 onFail 则 BLOCK（AC6，BLOCK 文案沿用 `checker FAIL…`） |
| 任意 | REJECT | correction 流（§6.2），不读任何 Edge、不发 ROUTE 日志（AC7/AC8） |
| 任意 | NEED_CONTEXT | 现状不变：BLOCK + 保留 judge/pendingClaim/boundary/pendingCorrection（AC9） |

关键变化：`advance()` 的 verdict 不再取 Judge result，而是由 **Actor claim outcome 映射**（completed→PASS、failed→FAIL）——Judge 只确认，不改写结果（PRD §2 目标 2/3）。`advance()` 内部追加 `delete run.pendingCorrection`（节点离开即清，见 §6.4）。

### 6.2 correction 流（按序）

1. `logJudge(result=REJECT, reason)`（A3 §10：validate → trace → persist）；
2. **先快照再清除**（评审补充3）：`const previousClaim = { …run.pendingClaim }`、`const oldJudgeId = judgeSessionId`；
3. `retireJudge(oldJudgeId)` + `delete run.judgeSessionId` + `delete run.pendingClaim`（R6.1/6.2）；
4. **写入 `run.pendingCorrection = { judgeReason: reason, previousClaim }`**（§6.4）；
5. `frame.nodeToken = newNodeToken()`；workflowId/nodeId 不变（R6.3）；
6. `nodeBoundary` **保留**（R8）：correction 重派以 `nodeBoundary.executorSessionId` 解析原 Actor（§6.5），重派走 role followup 时 `isSameNodeResume` 判定为真 → 不 compact、boundary 不重置；manager 路径 `establishManagerBoundary` 见 `dispatchedAt !== 0` 提前返回；
7. 写 trace 新事件 **`CORRECT`**（§7.2，`judge=` 用步骤 2 快照的 oldJudgeId）；
8. 构造 correction 消息（R7 格式，§6.3，body 取自 `pendingCorrection` + 原 instruction）；
9. 派发决策复用现有 workerSettled/book 机制：actor turn 仍活跃 → `persistDeferred(workspaceKey, run, version, { kind: 'correction', text: body })`；已 settle → `dispatchNow(..., { kind: 'correction', text: body })`（与 PASS/FAIL 后的下一节点派发完全同构，F13 语义不变；TransientDispatch 联合类型贯穿 DispatchBook/persistDeferred/dispatchNow/dispatchCurrent——评审中4）；
10. 重派成功 → `dispatchNow` 发布新 lease（§3.1）；旧 lease 因 token 轮换失配。

### 6.3 correction 消息格式（R7）

`dispatchCurrent` 的 transient 包装按 `TransientDispatch.kind` 选头：`[handoff]`（现状不变）/ `[correction]`。correction 的完整消息：

```text
[correction]
[judge rejection]
<Judge reason（≤ reasonMax 2000）>

[previous claim]
outcome: <completed|failed>
summary: <summary（≤ summaryMax 4000）>
handoffContext: <有则附，≤ handoffMax 8000>

[instruction]
<原 Node instruction>
```

长度上界由既有 LIMITS 链式保证（reason/summary/handoffContext 均在入口受限），correction 消息总长 ≤ ~14k + instruction，不新增上限。

**R8 证据通道（评审阻塞2的修正）**：下一 Judge 对先前 claim/rejection 的可见性**不再依赖 projection**——

- Role Actor 路径：correction followup 是 actor session 的 `user/message`（source kind `coordinator`），ACTOR 投影策略保留之，transcript 天然可见（维持原判断）；
- Manager 路径：MANAGER 投影只保留 `source.kind === 'user'`（`projection.ts` 既有策略，judgeFault 等机械通知被刻意排除），plugin correction 消息**不会**投影——因此改由 §6.4 的 `pendingCorrection` 直接进入下一 Judgment Packet 的 `[previous rejection]` 段（§7.1），Manager 路径证据不缺失；
- **不放宽** projection 的 source 过滤：放宽会把 judgeFault/needContext 等机械通知泄漏进 packet，违背旧 A1 R5 的排除决策。

### 6.4 `pendingCorrection`（D4，持久化）

```ts
// RunState 新增（随行落库；State 闭集文档同步，见 §8.2）
pendingCorrection?: {
  judgeReason: string                              // ≤ reasonMax
  previousClaim: { outcome: ClaimOutcome; summary: string; handoffContext?: string }
}
```

> **实现评审修正（trim-后-存储）**：LIMITS 的边界语义是"trim 后长度"——tool 层校验 trim 后长度但不得把原始串下传；`node_claim`/`judge_claim`/`node_block`/`node_resume`/`node_resolve_program` 一律传 trim 结果，engine 侧对 `summary`/`handoffContext`/`reason`/`resolutionContext` 再做防御性 trim 才落 State/trace/correction 消息。否则首尾海量空白可绕过长度上限把近 MB 级文本写入 State 与 correction prompt。

生命周期：

| 事件 | 动作 |
|---|---|
| REJECT | 写入/覆盖（新一轮 REJECT 用新的 reason+claim 覆盖旧值） |
| 再次 claim | **保留**——`pendingClaim` 更新，`pendingCorrection` 继续供 packet 引用 |
| ACCEPT（advance 离开节点） | `advance()` 内清除（与 `delete pendingClaim/judgeSessionId` 同点） |
| NEED_CONTEXT / judge fault BLOCK | 保留（respawn/spawn-rebuild 重建 packet 时同样携带 `[previous rejection]` 段） |
| correction 派发失败 → BLOCK → resume | **重建**：`handleResume` actor 分支检测 `pendingCorrection !== undefined && pendingClaim === undefined` → transient = `{ kind: 'correction', text: 由 pendingCorrection 重建的 [judge rejection]+[previous claim] 段 + [manager resolution] 段 }`——Actor 在 resume 后仍收到完整 R7 证据（评审中5），不依赖 Manager 从 trace 手工复制 |
| reset / 行删除 | 随行消失 |

### 6.5 判定期保护原 Actor（评审阻塞3 + 第二轮中3修正）

`handleSetRoleModel` 现状：actor idle 即 `delete run.roleActors[roleKey]`——而 claim 后等 Judge 期间 actor 恰为 idle，Manager 此刻切模型会删映射，REJECT 重派将新建 replacement Actor、boundary 被重置、原 Actor 修正历史丢失。三重机制：

1. **守卫（主，不依赖 mapping）**：`handleSetRoleModel` 在以下条件全部成立时拒绝（`role "x" 的 actor 正在等待判定/修正；override 被拒绝`）：
   - 当前节点为 actor-task 且 `node.execution.role === roleKey`（**按 Node role + boundary 判断，不比较 `roleActors` 映射**——映射缺失/漂移时守卫必须同样命中，否则 override 静默成功而 correction 又把旧 Actor 回写映射，本次 override 完全不生效）；
   - `run.nodeBoundary.dispatchedAt !== 0 && run.nodeBoundary.executorSessionId !== undefined`；
   - `run.pendingClaim !== undefined || run.pendingCorrection !== undefined`；
   - `run.status === 'running'`（blocked 例外见第 3 条）。
2. **解析（辅）**：correction 重派（§6.2 步骤 9）与 resume 重建派发一律以 `nodeBoundary.executorSessionId` 为该 Node 的 executor 真值：映射缺失/漂移时先回写 `roleActors[roleKey] = nodeBoundary.executorSessionId` 再 followup，保证 R6.4"重派给原 Actor"是机制不变量而非守卫的副产品。manager 节点 executor 恒为 managerSessionId，天然成立。
3. **恢复通道（blocked 例外）**：`run.status === 'blocked'` 时守卫不适用——节点已暂停，Manager 有处置权：
   - **blocked + pendingCorrection**（correction 派发失败态）：若原 Actor 因 provider/model 故障不可继续，Manager 显式 `workflow_set_role_model` 被接受，且 handler 额外**重置 boundary**（`nodeBoundary = { dispatchedAt: 0, managerFromSeq: 0 }`）并照常删除映射——resume 的 correction 重派因 boundary 无 executor 而走 `ensureRoleActor` 用新路由创建 replacement，correction 消息（含 `[previous rejection]`/`[previous claim]`）与 `pendingCorrection` 证据照常送达新 Actor。trace 侧 MODEL 行 + boundary 重置共同构成显式替换的持久记录。
   - **blocked + pendingClaim**（NEED_CONTEXT / judge fault 态）：override 走现状 idle-replacement 语义（影响该 role 的后续节点）；当前节点的判定由 judge followup/respawn 收尾，不涉及 correction 重派。若 judge 随后 REJECT，correction 重派按第 2 条回到原 Actor（boundary 未动）——此角落下 override 对当前修正不生效、对后续节点生效，符合"idle 可替换"的既有语义，记录在案。

### 6.6 不加 revision 字段（D2）

REJECT 后：token 轮换 + judgeSessionId 清空 + Judge 授权撤销（`retireJudge`）。旧 Judge 若再次 `judge_claim`：token stale（`frame.nodeToken !== nodeToken`）或 judge session 不匹配，双重拒绝；trace 侧 JUDGE 行带各自 token 前缀、CORRECT 行标记重派边界，无去重歧义。

## 7. Judge 协议 v2 与 trace 事件

### 7.1 协议面（breaking，D1）

| 位置 | 变更 |
|---|---|
| `types.ts` `JudgeVerdict` | `'PASS' \| 'FAIL' \| 'NEED_CONTEXT'` → `'ACCEPT' \| 'REJECT' \| 'NEED_CONTEXT'`（Graph verdict 的 `'PASS' \| 'FAIL'` 作为独立内部类型保留于 `advance()`） |
| `judge_claim` tool schema | enum 改三新值；description 改为"确认 Actor 声明是否可信" |
| `parseJudgeClaim` | 同步新 enum |
| `PROMPT_TEMPLATE` | Verdict protocol 段重写：ACCEPT = claim 与事实/instruction/criteria 一致；REJECT = 不正确或证据不足，且 reason 必须指出应如何修改（可供 correction 直接引用）；NEED_CONTEXT 语义与 reason 要求不变 |
| Judgment Packet 输入 | `renderJudgePrompt` 增加可选 `previousRejection`（取自 `run.pendingCorrection`）：存在时在 Worker claim 段之前渲染 `[previous rejection]`（judge reason）+ `[previous claim]` 段，`startJudge`/respawn/spawn-rebuild 三处 packet 构造统一携带（§6.4） |
| `index.ts` / `ToolHost.judgeClaim` | result 类型联动 |
| `node_resolve_program` | **不动**（program 人工裁决，PASS/FAIL 语义无关本 PRD） |

### 7.2 trace 事件

- `JUDGE` 行 `result=` 取值改为 ACCEPT/REJECT/NEED_CONTEXT（字段结构与 fmt=2 不变，不 bump fmt；README/设计文档 §5.4 的取值说明同步更新）。
- 新增 **`CORRECT`** 事件（REJECT 重派时，在持久化前写入）：

```text
[ts] CORRECT workflow=<wf> node=<id> token=<新 token 8> role=<roleKey> judge=<旧 judge id 8> detail=<judge reason 经 jsonField>
```

  不复用 ROUTE（无 Edge 读取）、不写 `NODE … FAIL`（PRD R6.6 明令禁止）。A3 PRD §13.2 事件覆盖表补一行（随本 PRD 实现提交一起更新，标注"A1 新增"）。

### 7.3 SUBMISSION_CONSTRAINT 文案

`node_claim` 不再携带 token，dispatch 约束更新为：

```text
[提交要求]
完成后必须调用 node_claim 提交结果（outcome: completed | failed，并附 summary）；无需任何 token，绑定由派发自动完成。
仅输出文字不视为提交，会导致当前 Node BLOCK。
```

（Judge projection 对该约束的排除逻辑不变。）

## 8. 版本原地升级落地（D1）

### 8.1 代码面

- `types.ts`：`SCHEMA_VERSION = 'agent-workflow/v2'`。
- `catalog/schema.ts`：`z.literal('agent-workflow/v2')`。
- `catalog/validate.ts`：`BUILTIN_CHECKER_IDS = new Set(['judge.claim-correct'])`（`goal-satisfied` 移除），checker config 校验（criteria 必填等）平移。
- `engine.ts` `handleClaim`：checkerId 检查改 `judge.claim-correct`。

### 8.2 配置/文档迁移（同一提交系列；覆盖所有 v1/旧 checker 文案——评审补充2）

- `docs/prd/20260903-workflow-hardening/milestone-delivery.yaml`（及 `.orig.yaml` 仅作历史快照不改）；
- e2e smoke 与全部测试夹具中的 YAML；
- `CONTEXT.md`：`agent-workflow/v1`、`judge.goal-satisfied`、Judge `PASS/FAIL` 结果语义等全部相关词条（不止一条），并新增 `pendingCorrection`、`ActorDispatchLease`（DispatchBook lease 字段）、`ACCEPT/REJECT/NEED_CONTEXT` 词条；State 闭集同步；
- `docs/design/configurable-agent-workflow-graph.md`：§2.2 Judge 职责与流程图、§5.2 工具协议（node_claim 参数、judge_claim enum）、§5.4 trace 事件（JUDGE 取值 + CORRECT）、State 闭集（pendingCorrection/traceLogPath）、示例 YAML（checker id 与 schemaVersion）；
- `README.md`：协议示例、trace JUDGE 取值、Judge 语义描述；
- 部署侧：`~/.dsh/workflows/milestone-delivery.yaml` 随批末统一 build+deploy 重新生成（definitionHash 变化只影响新 run）。

### 8.3 旧 v1 行为（记录为 breaking 后果）

- 旧 v1 catalog 文件被 loader 拒绝（schemaVersion literal 不匹配）——预期。
- 状态库中存量 v1 run 快照：`workflow_status`/`/dsh-flow reset` 正常；其 checker `judge.goal-satisfied` 在新代码下 claim 得到 `unknown checker` 拒绝（fail-closed），v1 运行行实际不可续跑，退出路径为 reset。现存唯一真实 run（b2697138）已完结，无实际影响。

### 8.4 A3 文档 revision 收口（评审补充1，随本 PRD 实现提交）

D2 关闭 A3 遗留的 revision 事项，以下位置的"revision 待 A1"表述同步改为已决（不加字段；token 前缀 + CORRECT 事件覆盖）：

- `a3-workflow-trace-observability.md`：状态行（AC4 措辞）、§5 R2（Claim correction revision）、§10 建议、AC4、§13.1 决策记录；
- `docs/design/configurable-agent-workflow-graph.md` §5.4 的"`revision` 序号留给 A1…补充"注释；
- `TODO.md` A3 行与 §4 A1 待办的"同步 revision 字段"字样。

## 9. MODEL 长度上限（D3，评审中7修正字段名与规范化）

- `LIMITS` 新增 `providerMax = 64`、`modelIdMax = 128`。
- 实际配置字段是 **`roles[*].model` 与 `judgeRole.model`**（`roleModel = { provider, modelId }`；初稿误写为 `modelRoute`）。
- **统一规范化 helper**（types 或 engine 内）：`normalizeModelRoute(provider, modelId)` → trim → 空/超限拒绝（错误信息含上限）→ 返回 trim 后值；两个入口共用：
  - catalog：`roleModel` 的 provider/modelId 在 `nonEmptyTrimmed` 基础上加 max 校验（zod `.max()`，trim 变换后存储的已是 trim 值）；
  - `handleSetRoleModel`：现状**没有任何**非空/长度检查即写入 `modelOverrides`——改为经 helper 规范化后存储（trim 后落库，不能只判长度存原始空白值）。
- `logModel` 无需改（输入已规范化受界）；A3 遗留项关闭。

## 10. 测试计划（对应 PRD AC1–AC12）

| AC | 用例落点 | 手段 |
|---|---|---|
| AC1 | engine.test.ts：构造 token 已 advance、lease 缺失/旧的 claim → 拒绝且 State 不变、无 Judge spawn、无 CLAIM 日志 | 断言 state.get 版本未变 + subagents.startJudge 未调用 |
| AC2 | dispatch 成功后（makeHarness 真实走 dispatchNow）不传 nodeToken 的精确 executor claim 被接受，JUDGE 流程正常；**Code Mode**：turnUserMessageIds 由 `turnbind` 对含 `tool/code-dispatch-start` 的合成 log 推导，claim 同样被接受（评审阻塞1回归） | 现有 harness；caller 换 `ClaimCaller`；合成 SessionEvent 数组 |
| AC3 | 同 role session 旧 turn：turnUserMessageIds 含**旧** dispatch id、不含新 id → 拒绝 | 直接构造集合差异 |
| AC4 | 同一 lease 第二个 claim 拒绝；claim 后同 turn node_block 拒绝；actor node_block 消费后 claim 拒绝 | 消费位断言 |
| AC5/AC6 | 真值表 completed/failed × ACCEPT | advance 断言沿用现有 ROUTE 断言 |
| AC7/AC8 | REJECT：无 ROUTE/JUDGE-FAIL 行、nodeId/workflowId 不变、token 轮换、CORRECT 行、correction 消息含 [judge rejection]/[previous claim]/[instruction] 三段、boundary 保留（dispatchedAt 不重置）、**重派目标是原 Actor session**（§6.5） | 消息文本断言 + trace 断言 + followup 目标断言 |
| AC9 | NEED_CONTEXT 现状回归（pendingCorrection 保留） | 现有用例改 enum 值 |
| AC10 | 旧 judge id / 旧 token judge_claim 拒绝（含 REJECT 后旧 Judge 再提交） | 现有 stale-judge 用例扩展 |
| AC11 | manager 节点：steer 返回 id → lease 绑定 → manager claim 接受；未含 id 的 manager turn 拒绝 | stub steerManager 返回固定 id |
| AC12 | 全量 unit + e2e | node:test |
| — 评审补充4 | **turnbind.test.ts 纯函数**：native 定位、Code Mode 定位（含 subCallId + **start 事件 rootCallId 双绑定** 校验）、伪造 callId（形如 `x:code:1` 但无对应 start 事件 / start 事件 rootCallId 不匹配）、缺失根 `tool/call`、mid-turn steer、log 截断/异常 → fail-closed | node:test |
| — 评审补充4 | **Manager correction 证据**：manager 节点 REJECT → 重派 → 再 claim → packet 文本含 `[previous rejection]`/`[previous claim]` 段（不依赖 projection） | 断言 renderJudgePrompt 输入 |
| — 评审补充4 | **判定期 model override**：pendingClaim/pendingCorrection 期间对当前 Node role 的 override 被拒——**含 mapping 已缺失/漂移的构造**（守卫按 Node role + boundary 判定，§6.5）；非当前节点 role 仍允许 | handleSetRoleModel 断言 |
| — 评审补充4 | **correction 派发失败→resume**：重派 steer/followup 抛错 → BLOCK 且 pendingCorrection 存续 → resume 后派发消息含完整 [judge rejection]+[previous claim]+[manager resolution]+[instruction] | failNextPuts/fault injection |
| — 评审补充4 | **e2e**：Role 与 Manager 两条 REJECT → 修正 → 再次 ACCEPT 全链路（smoke 扩展或新脚本） | scripts/e2e-smoke.mjs |
| — 评审第二轮 | **builtin-program node_block 回归**：program 节点上 Manager node_block 走控制面被接受（不要求 lease）；program 节点 claim 本就因 kind 被拒 | makeHarness + program 节点 |
| — 评审第二轮 | **acceptance 边界**：claim 的 `state.put` 故障注入 → lease 未消费 → 同一 Actor 重试成功；block 的 put 故障 → book 原样可重试 | failNextPuts |
| — 评审第二轮 | **correction × host restart**：REJECT 后 deferred correction 期间重启 → restart-reconcile BLOCK（pendingCorrection 随行存续）→ resume 重建完整 correction 消息 | 共享 MemState 的 makeHarness 重启模拟 |
| — 评审第二轮 | **persistDeferred book 初始化**：旧 book 缺失时 `executorSessionId` 回退行为显式断言，turn/end 仍能触发延迟 correction 派发 | 构造 book 缺失场景 |
| — 评审第二轮 | **blocked 恢复通道**：correction BLOCK 态 override 被接受且 boundary 重置 → resume 重派为 replacement Actor（新路由）且 correction 证据照常送达；NEED_CONTEXT BLOCK 态 override 走 idle-replacement 语义 | handleSetRoleModel + resume 断言 |

既有 169 用例改造面：`NodeClaim` 去字段、`handleClaim` 签名、judge enum 改名、checker id 改名、SUBMISSION_CONSTRAINT 断言、e2e smoke 的 judge 脚本与断言。

## 11. 实现顺序（映射 PRD §10）

1. `turnbind.ts`（native + Code Mode 双路径）+ `steerManager` messageId（seam 先行，独立测试）；
2. lease（并入 DispatchBook）+ admission gate（handleClaim/node_block）→ AC1–AC4/AC11；
3. `node_claim` schema 去 nodeToken + SUBMISSION_CONSTRAINT 文案；
4. judge v2 enum + 真值表 → AC5/AC6/AC10；
5. `pendingCorrection` + REJECT correction 流 + CORRECT 事件 + `TransientDispatch` 贯穿（含 resume 重建与判定期 override 守卫）→ AC7/AC8 + 评审补充4 用例；
6. v2 原地升级 + checker 更名 + 配置/示例/文档迁移（§8.2 全清单）+ MODEL 上限（D3）；
7. 全量验证（build + unit + e2e），PRD §13 收口，README/CONTEXT/设计文档同步 + A3 文档 revision 收口（§8.4）。

每步一个 commit，沿用 conventional 前缀 + 中文摘要。
