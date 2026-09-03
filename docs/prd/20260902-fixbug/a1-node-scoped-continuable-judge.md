# PRD：A1 Judge 上下文隔离与 Node 内续接

- 日期：2026-09-02
- 来源问题：`docs/pending-discussions/live-e2e-issues.md` A1
- 状态：方案已确认，等待与其他问题统一梳理后开发

## 1. 背景

当前每次 Judge 虽然通过 one-shot `spawn` 创建 fresh Session，但 Host 会把 Manager Session 中最多 120,000 字符的 USER/MANAGER 可见历史重新投影进 Judge prompt。长流程后期，Judge 被与当前 Node 无关的历史污染，频繁无法产生合法 structured result。

真实 e2e 同时表明，完全移除运行历史也不可行：用户、Manager 和 Actor 会在 Node 执行期间产生动态信息，Judge 需要这些信息才能准确理解当前判定。

本调整以“当前 Node”为上下文隔离边界：只投影该 Node 实际派发后的相关消息；正常情况下 Judge 独立判定，只有 Judge 明确表示信息不足时，Manager 才向同一个 Node Judge 追加一次性辅助信息。

## 2. 目标

1. 移除对完整 Manager Session 历史的隐式投影。
2. 为 Judge 构造只包含当前 Node 局部历史的 Judgment Packet。
3. 使用 Session 局部游标准确筛选消息，使用事件时间戳合并 Manager、User、Actor 的跨 Session 顺序。
4. 每个 Node 创建一个全新的 Judge Session；同一 Node 内允许 Judge 因信息不足被 Manager 续接。
5. Node 完成后释放 Judge 的活跃资源；下一 Node 不继承上一 Judge 的上下文。
6. 保持 Graph 只有 PASS/FAIL 路由；信息不足不产生 Graph 结果，而是进入可恢复 BLOCK。

## 3. 术语

- **Node entry**：Graph 进入一个新 Node，并实际将该 Node 消息派发给执行者。
- **Node-local projection**：从当前 Node entry 边界开始，从 Manager 和当前 Actor Session 读取、过滤并合并得到的历史。
- **Judgment Packet**：Judge 首次判断时收到的固定判定输入与 Node-local projection。
- **Pending Judge**：已经收到 Judgment Packet，但以 `NEED_CONTEXT` 暂停、等待 Manager 补充信息的当前 Node Judge。
- **Judge retirement**：Node 判定结束后清除 Workflow 映射、撤销授权并释放活跃 Agent/Activation；不要求物理删除持久化 Session。

## 4. 边界与排序模型

### R1：边界建立时机

边界必须在当前 Node **实际 dispatch** 时建立，不得在新 `nodeToken` 生成时提前建立。

原因：当前 Engine 会先更新 Node/token，再等待旧 Actor turn settlement，最后才派发新 Node。若在 token 生成时建立边界，旧 Node 的尾部事件可能进入新 Node 投影。

### R2：精确局部游标

当前 frame 保存当前 Node 所需的最小边界信息，概念结构如下：

```ts
interface NodeContextBoundary {
  /** Node 实际派发时的 Unix epoch milliseconds。 */
  dispatchedAt: number

  /** Manager Session 在实际派发边界处的 next seq。 */
  managerFromSeq: number

  /** 非 Manager Actor 执行当前 Node 时的 Session。 */
  executorSessionId?: string

  /** startContinuable/followup 接受的本次 Node 派发消息 id。 */
  executorDispatchMessageId?: string
}
```

- Manager Session 使用 `managerFromSeq` 精确筛选。
- Actor Session 根据 `executorDispatchMessageId` 定位本次派发对应的 `user/message`，从其事件 `seq` 开始筛选。
- 当前 Host 不得再丢弃 `startContinuable()` / `followup()` 返回的 dispatch message id。
- 不得仅依赖 `event.time >= dispatchedAt` 判断边界，以避免同一毫秒内边界前后的事件混淆。

### R3：时间戳语义与跨 Session 排序

DSH 的 `SessionEvent.time` 是事件执行 `session.append()` 时生成的 `Date.now()`：

- `user/message`：Agent 从 inbox 取出消息并将其写入当前 step 时；
- `assistant/message`：模型 stream 完成、最终 AssistantMessage 写入 Session 时。

筛选后的 Manager、User、Actor 消息必须合并为统一序列，并按以下顺序排序：

1. `event.time` 升序；
2. 同一 Session 且时间相同时按 `event.seq` 升序；
3. 不同 Session 时间相同时使用稳定的确定性 tie-break，避免测试和重放顺序漂移。

局部游标负责“是否属于当前 Node”，时间戳负责“跨 Session 如何排列”。

### R4：边界生命周期

- Graph edge 进入新 Node：建立新边界。
- 同一 Node 因 Actor BLOCK、Judge `NEED_CONTEXT` 或其他可恢复原因 resume：保留原边界。
- `node_resume` 轮换 `nodeToken` 时不得重置 Node entry 边界。
- Node PASS/FAIL 并离开后：当前边界失效。
- Parent/Child Workflow 的每个 active frame 使用自己的 Node entry 边界；仅 top frame 参与当前投影。

## 5. Node-local projection

### R5：Manager/User 消息

从 Manager Session 的 `managerFromSeq` 开始，只保留：

- append-origin `user/message` 且 `source.kind === 'user'`；
- append-origin `assistant/message` 的可见文本块。

继续排除：

- system prompt；
- reasoning；
- tool call/result；
- Skill/MCP schema；
- plugin/coordinator/subagent notice；
- replacement/hidden/compaction 注入内容；
- 无可见文本的消息。

### R6：当前 Actor 消息

对于非 Manager Actor，只读取其 Session 中从 `executorDispatchMessageId` 对应派发消息开始的当前 Node 内容，保留：

- 本次 Node 的派发/handoff/resolution 文本；
- Actor 的可见 Assistant 文本。

排除：

- 同一 continuable Actor 在以前 Node 中的历史；
- system/persona/skills/reasoning；
- 普通 tool call/result 详情；
- 其他 Node 的消息。

Actor 的 accepted `node_claim` 作为 Judgment Packet 的独立字段传入，不依赖从普通文本投影中解析。

### R7：Judgment Packet

Judge 首次判断固定接收：

```text
Judge persona 与内置只读判定职责
当前 Node instruction
当前 Node criteria（权威验收标准）
Worker claim outcome/summary
workspace cwd
按时间合并的 Node-local projection
Judge 专用判定协议
```

不得再包含边界以前的完整 Manager transcript。

## 6. Judge 生命周期与专用协议

### R8：每 Node fresh、Node 内 continuable

- 当前 Actor claim 后，为当前 Node 创建一个新的 continuable Judge Session。
- 同一个 Judge Session 只允许服务当前 Node。
- 同一 Node `NEED_CONTEXT` 后可以 followup 该 Judge。
- Node PASS/FAIL 后不得把该 Judge 复用于下一 Node。
- 下一 Node 必须创建新的 Judge Session 和新上下文。
- 不支持“清空并复用同一个 Session id”；DSH Session 是 append-only 持久化历史。

### R9：Judge 专用结果协议

Continuable Subagent 不支持 one-shot `outputSchema`，因此 Judge 必须通过专用、受授权控制的工具提交结果。概念协议：

```ts
judge_claim({
  nodeToken: string,
  result: 'PASS' | 'FAIL' | 'NEED_CONTEXT',
  reason: string
})
```

约束：

- 只有映射到当前 Node 的 Judge Session 可以调用。
- `nodeToken` 必须匹配当前 token，防止迟到结果修改已变化的 Node。
- `reason` 必填、非空并有固定长度上限。
- `PASS` 和 `FAIL` 是唯一 Graph 判定结果。
- `NEED_CONTEXT` 不走任何 Graph edge。
- Judge 不得调用通用 Workflow 控制工具。

### R10：`NEED_CONTEXT` 恢复

Judge 只有在凭当前 Judgment Packet 和只读现场仍无法可靠判断时才提交 `NEED_CONTEXT`，reason 必须明确说明：

- 缺少什么信息；
- 该信息为什么影响 PASS/FAIL；
- Manager 应补充什么，而不是只写“无法判断”。

Engine 收到后：

1. 当前 Node 进入 BLOCK；
2. `blockReason` 展示 Judge 的具体原因；
3. 保留当前 `judgeSessionId`、Node entry 边界和当前 Node；
4. 不派发 PASS/FAIL edge。

Manager 使用现有 `node_resume({nodeToken, resolutionContext})` 恢复时：

- 若当前 Node 存在 Pending Judge，则 `resolutionContext` 只作为一次性 followup 发给该 Judge；
- 不重新派发 Actor；
- `nodeToken` 按现有安全语义轮换，新 token 必须告知 Judge；
- Judge 在原短 Session 中结合补充信息再次调用 `judge_claim`。

### R11：Judge 完成与资源释放

Judge 提交 PASS/FAIL 后：

1. Engine 应用对应 Graph edge；
2. 清除当前 Workflow 的 Judge Session 映射；
3. 撤销该 Session 的 Judge 专用授权；
4. 不执行显式 drain：**禁止从 Judge 自己的 `judge_claim` tool call 内 drain 自己**（DSH 的 `dispose` 会 cancel 调用者当前 turn 并等待其 idle，形成 self-cancel 死锁）。continuable child 的 Activation 由 DSH settlement watcher 在 Judge turn 自然结束后自动释放；显式 `drainContinuableChildren` 只允许在**其他 Agent 的 turn** 中调用（`judge_respawn`、spawn 陈旧清理路径）；
5. 保留 DSH 持久化 Session 作为历史记录，但不再 followup。

本 PRD 不要求清理 Web GUI 任务管理区中的历史 Judge 条目。

### R12：技术故障边界

以下属于 Judge 技术故障，而不是语义性 `NEED_CONTEXT`：

- provider/model 异常；
- token ceiling；
- Judge turn 结束但未调用 `judge_claim`；
- Judge tool surface 不正确；
- Session/持久化/读取异常。

技术故障仍应 fail-closed 并 BLOCK，且必须暴露可诊断原因。自动重试、替换 Judge、降级解析等韧性策略归入 A4，后续单独确定。

## 7. 状态模型

允许在 current frame/run current facts 中增加：

- 当前 Node 的 `NodeContextBoundary`；
- 当前 Pending/active Judge 的 `judgeSessionId`。

不新增：

- 跨 Node Decision Context；
- 完整 Manager/Actor transcript 副本；
- 每次 Judge 的 Manager 摘要；
- 可配置的复杂 phase 状态机；
- 已完成 Judge 的历史映射。

DSH Session log 继续作为消息历史的唯一持久化来源，Workflow SQLite 只保存重建当前执行现场所需的引用。

## 8. 非目标

- 不跨 Node 复用 Judge Session。
- 不清空或物理删除 DSH Session 历史。
- 不处理 Web GUI 历史 Judge 条目过多的问题。
- 不设计跨 Node Decision Context 或长期决策账本。
- 不让 Manager 在每次正常判定前强制生成摘要。
- 不把 Actor tool 执行日志整体暴露给 Judge。
- 不在本调整中决定 A4 的自动重试/降级策略。
- 不改变 Graph 的 PASS/FAIL edge schema。

## 9. 验收标准

- **AC1 历史隔离**：Manager Session 在当前 Node 边界前存在超长历史时，Judge prompt 不包含该历史，只包含当前 Node entry 后筛选出的消息。
- **AC2 精确边界**：边界前后事件即使具有相同毫秒时间戳，局部游标也能排除边界前事件并保留边界后事件。
- **AC3 Actor 隔离**：同一 continuable Role Actor 连续执行多个 Node 时，第二个 Node Judge 不接收该 Actor 在第一个 Node 中的普通历史。
- **AC4 跨 Session 顺序**：边界后的 User、Manager、Actor 消息按 `SessionEvent.time` 合并，测试覆盖交错事件及相同时间戳的确定性 tie-break。
- **AC5 Resume 保留边界**：同一 Node BLOCK/resume 和 token 轮换不会丢失该 Node 已有局部历史；进入下一 Node 后旧边界不再生效。
- **AC6 正常判定**：Judge 调用 `judge_claim(PASS|FAIL)` 后按对应 edge 推进，映射和授权被清除，活跃 Judge 资源被释放。
- **AC7 缺信息恢复**：Judge 调用 `NEED_CONTEXT` 后 Node BLOCK，Manager 的 `resolutionContext` followup 到同一 Judge Session，Actor 不被重复派发，Judge 可随后 PASS/FAIL。
- **AC8 跨 Node fresh**：相邻两个需 Judge 的 Node 使用不同 Judge Session id；第二个 Judge 的模型上下文不包含第一个 Judge 的历史。
- **AC9 Stale safety**：旧 token、旧 Judge 或已退役 Judge 的迟到 `judge_claim` 被拒绝，不修改 State。
- **AC10 技术失败可诊断**：Judge 无结果、回合异常或协议缺失时保持 fail-closed，并在 BLOCK reason 中显示可区分的具体原因。
- **AC11 回归门禁**：现有单元测试、engine 测试和 e2e smoke 全部通过，并增加真实长 Manager 历史、同 Actor 多 Node、`NEED_CONTEXT` followup 的覆盖。

## 10. 已确认决策

1. 使用精确版边界：局部游标负责筛选，时间戳负责跨 Session 排序。
2. 边界建立在 Node 实际 dispatch，而不是 `nodeToken` 生成时。
3. Judge 每 Node fresh；同一 Node 内 continuable。
4. Judge 使用专用 `PASS | FAIL | NEED_CONTEXT` 协议。
5. 正常路径不要求 Manager 生成摘要；只在 `NEED_CONTEXT` 时补充。
6. Node 完成后只要求释放 Judge 活跃资源；GUI 历史条目清理不在本次范围内。
7. 暂不引入跨 Node Decision Context。
