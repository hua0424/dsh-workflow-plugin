# A4 代码层调研结论：Cold-resume Compaction

- 日期：2026-09-04
- 性质：静态代码证据（DSH 源码 `D:\project\github\deepseek-harness` @ master + 本插件源码）；**未运行隔离 harness**，运行时数据（token 曲线、复现次数）仍需 A4 PRD §4 的 feedback loop 补充
- **实现状态：方案 A 已实现（2026-09-04，分支 `a4-cold-compact`，`src/plugin/host.ts` `compactRoleActor` + `test/host-compact.test.ts`）**；部署与运行时验证待做
- 来源：[a4-cold-resume-compaction-investigation.md](a4-cold-resume-compaction-investigation.md)；进度登记见 [TODO.md](TODO.md) §3
- 源码引用格式：`<harness包>/<文件>:行号`（harness 源码）、`src/<文件>:行号`（本插件）

## 1. 根因：为什么新 Node 到达时 Actor 已 cold（H1 证实）

DSH continuable 生命周期由 `SubagentContinuationManager` 独占管理（`subagent/src/continuation.ts`）：

1. **每个 continuable child = 一个持久 Session + 至多一个进程内 Activation**。Activation 不是请求边界，turn 结束不释放；释放由 settlement watcher 决定。
2. **settlement watcher 自动拆 Activation**：`watchSettlement`（continuation.ts:1295-1330）在 `stateOf(activation) === 'settled'` 时立即 `dispose(activation)`。`settled` 判定（continuation.ts:932-936）= Agent 不在 running、无已接受未消费 inbox、无 owned children。dispose 链（continuation.ts:1343+）= `ctx.sessions.flush`（best-effort 落盘）→ `handle.dispose()` → 从 `ctx.agents` 注销。
3. **followup 三态路由**（continuation.ts:476-505）：Activation `running` → 入队；`waiting` → 唤醒同一 Agent；**absent → `coldResume`**（continuation.ts:945-1005）= `persistence.inspect` 全量事件 → 折叠 descriptor → `ctx.agents.resume()` 重建 Agent → 提交新 turn。

插件侧时序（`src/engine/engine.ts:281-351` + `src/plugin/host.ts:310-331`）：

```text
Node N dispatch → actor turn（node_claim 是 turn 内 tool call，SUBMISSION_CONSTRAINT 要求其为最后动作）
  → actor turn 结束 → watcher 判 settled → Activation dispose → actor 从 ctx.agents 消失   ①
  → engine 结算 claim → spawn Judge（独立 continuable child）→ Judge turn → judge_claim
  → advance → Node N+1 dispatchCurrent → compactBeforeDispatch
      → ctx.agents.get(childId) === undefined（① 已发生）→ 'cold-resume skip'
  → sendRoleActor → followup → coldResume → 全量重放持久历史
```

**结论**：Actor turn 结算（①）与下一 Node dispatch 之间**必然隔着整个 Judge 生命周期**，Actor 在 compact 检查点 100% 处于 cold。`cold-resume skip` 不是偶发异常，而是串行引擎协议下的**常态路径**；"只对 resident Agent compact"的 A2 R5 设计前提在真实生命周期下不可达（H1 证实）。

补充：存在一个窄竞态——若 Judge 在 Actor turn 尾部完成判定并触发下一 dispatch，Actor 仍 resident，此时 `compactNow` 会因 `runMaintenance` 要求 idle 而抛 `busy`。本次试跑未出现；方案 A 实现时需处理该分支。

## 2. 实际影响：skip 之后 Actor 带着什么进入新 Node（H2 部分证伪）

- `coldResume` 通过 `ctx.agents.resume()` → `Session.fromRestore` **全量重放持久事件**：Actor 进入新 Node 时携带它服务过的所有历史 Node 的完整 transcript（instruction、tool 调用、claim、handoff）。
- 唯一兜底是 compaction-basic 的**自动压力压缩**：`auto` 默认 `true`（compaction-basic/src/config.ts:95），触发点 `agent/pre-step`（每步前），阈值 `0.8 × contextWindow`（config.ts:20），压缩后保留 `0.16` 比例 verbatim 尾（config.ts:23）；另有 context-overflow 恢复（compaction-basic/src/index.ts:775-828 区域）。
- 因此：上下文**不是无界增长**（方案 D 的前提"skip 但不加载旧历史"不成立——旧历史确实被加载），但**Node 边界压缩从未发生**：Actor 上下文随 Node 数单调增长，直到约 80% 窗口才被与 workflow 无关的兜底压缩触发，摘要时机/粒度不受 Node 边界控制。

本次试跑中 developer 仅连续 3 个 Node、reviewer 2 个 Node，增长尚不致命；A2 新配置下多 Issue 循环（developer/reviewer 跨 Issue 复用）会显著放大该成本——**A4 问题在新配置下比旧配置更常见**。

## 3. 有没有办法压缩：候选方案代码级判定

### 方案 A：cold materialize → compact → dispose → followup —— ✅ 可行（推荐，仅插件侧改动）

所需 API 全部是现有公开接口，无需 harness 变更：

| 步骤 | API | 证据 |
|---|---|---|
| 冷物化（无 prompt、不开 turn） | `ctx.agents.resume({ resumeSessionId, agentOptions })` → `AgentHandle` | agent/src/index.ts:424-430；agent-loop/src/index.ts:653-659（要求 `sessionPersistence`，cold resume 可用即证明其存在）。resume 完成即返回 handle，不提交任何消息 |
| 压缩 | `ctx.compaction.compactNow(agent, signal)` | compaction-basic/src/index.ts:368-419：走 `agent.runMaintenance`（要求 idle——刚 resume 未驱动的 Agent 正是 idle）；`selectCompactableRange(session, measure, 0)`（region.ts:98-134）保留最后一个平衡尾、**其余全部有用历史压成一条 summary**；内部自带 `flush: () => ctx.sessions.flush(...)`（index.ts:395-397），**resolve 即 marker pair 已落盘** |
| 拆除 residency | `handle.dispose()` | agent-loop/src/index.ts:497-520：cancel → whenIdle → scope.dispose → 摘除 agents/sessions 内存注册表；**不触碰持久数据** |
| 正常派发 | `ctx.subagents.followup(...)` | 走 `coldResume`，重放的已是压缩后的 surface |

约束与注意：

1. **必须先 dispose 再 followup**：同 id 的 Agent 已在注册表时 `AgentRegistry.enter` 拒绝，续管 manager 的 coldResume 会失败。顺序 await 即无并发（H3 的并发担忧只在乱序时成立）。
2. 成本：每个 Node 边界一次额外物化 + 一次摘要 LLM 调用（followup 的 coldResume 本来也要物化，故为"双重物化"）。摘要路由建议传角色 route（`resolveRoleModel`）保持与 Actor 模型一致。
3. 失败语义：`resume` 失败（persistence 故障）或 `compactNow` 抛 `ManualCompactionError`（busy/cancelled/changed/summary/commit/persistence）应 fail-closed BLOCK，复用 A2 R4 既有的 `COMPACT_FAIL_PREFIX` 通知与 resume 框架；窄竞态下的 `busy`（Actor 仍 resident）可降级为跳过。
4. 对插件其他机制无副作用：`src/index.ts:364-365` 的 turn 结算订阅只认 `turn/end`，compaction 事件不会误触发；摘要走 `ctx.llm` 直调，不产生 Agent turn，不需要 role-actor 授权。

### 方案 B：followup 前 persistence-level compact —— ❌ 无公开 API

`CompactionEngine` 三个入口（`compactIfNeeded`/`compactNow`/`compactRegion`）全部要求 resident `CompactionAgentContext`；surface/`replaceGeneration` 事务、tool-pairing 平衡、durable `compaction/start|end` marker 都是引擎内部不变量。裸改持久事件日志会破坏 append-only 与重放语义。除非 harness 新增 API，不建议。

### 方案 C：新 Node 创建 fresh Actor + 受控 handoff —— 可行但语义变更，备选

A2 新配置的 handoff 已结构化承载跨 Node 上下文，信息损失可控；但改变设计文档"同一 Role Actor Session 跨 Node 复用"的既有承诺，且 Judge 投影、授权映射、trace 语义都要跟着改。仅当方案 A 的双重物化/摘要成本被证明不可接受时再立项（独立 PRD）。

### 方案 D：接受 skip、证明不加载旧历史 —— ❌ 证伪

`coldResume` 全量重放（§2），前提不成立。

## 4. 与 A4 PRD 假设对照

| 假设 | 结论 |
|---|---|
| H1 Activation 在 turn idle 后自动释放 | ✅ 证实（`watchSettlement`/`stateOf`，continuation.ts:932/1295） |
| H2 cold-resume 加载完整未 compact 历史 | ✅ 方向证实（全量重放），但补正：默认开启的自动压力压缩在 0.8×窗口兜底，非无界 |
| H3 可以先 cold-resume、compact、再投递 | ✅ 证实且顺序化后无并发风险；额外发现必须 dispose 再 followup |
| H4 需要改为 summary/fresh Actor | 保留为备选（方案 C），非必需 |

## 5. 建议下一步

1. 按方案 A 实现插件侧修复（`compactRoleActor` 的 cold 分支改为 resume→compactNow→dispose），失败语义按 §3-A.3。
2. 实现 A4 PRD §4 隔离 harness 补运行时证据：AC1（复现）、AC3（Node B 输入量化）、AC4（resident 对照）、AC6（方案原型对比 token 曲线）。
3. 数据齐备后按 AC9 正式回写 `CONTEXT.md`/设计文档（修订 A2 R5 的 resident 前提与 §8 描述），并更新 A4 PRD 状态。
