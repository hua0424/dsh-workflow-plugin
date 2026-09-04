# PRD：A4 Cold-resume Compaction 原因调查与方案验证

- 日期：2026-09-03
- 来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 复盘
- 状态：调查进行中——代码层调研已完成（结论：H1 证实、H2 部分证伪、方案 A 可行，见 [a4-code-findings.md](a4-code-findings.md)）；隔离 harness 运行时验证未开始
- 类型：诊断/原型/决策 PRD

## 1. 背景

既有设计要求：同一 Role Actor 跨 Node 复用时，在每个新 Node dispatch 前执行 `compactNow`，避免长 milestone 中 Actor context 持续膨胀。

真实 run 出现：

```text
COMPACT issue-delivery/implement role=developer cold-resume skip
COMPACT issue-delivery/implement role=developer cold-resume skip
COMPACT milestone-delivery/final-review role=reviewer cold-resume skip
```

对应实现位于 `src/plugin/host.ts`：

```ts
const agent = adapters.ctx.agents.get(childId)
if (agent === undefined) return { ok: true, detail: 'cold-resume skip' }
```

这说明进入新 Node 时，持久化 role session id 仍存在，但 resident Agent/Activation 已不存在，因此 `compactNow` 根本没有执行。

需要回答的核心问题不是“日志为什么写 skip”，而是：**为什么设计要求每个新 Node 压缩，但实际常态生命周期使新 Node 到达时 Actor 已 cold，导致压缩路径不可达？**

## 2. 调查目标

1. 构建可重复、隔离的 feedback loop，稳定复现 `cold-resume skip`。
2. 还原 Role Actor 从首次 `startContinuable`、turn settlement、Activation release、下一 Node `followup` cold-resume 的精确时序。
3. 测量 cold-resume 后实际加载的历史范围与估算 token 数，确认 skip 是否真的导致完整旧上下文进入下一 Node；优先使用 Agent request 构造 seam、本地 tokenizer或确定性字符/事件计数，不依赖真实 provider 计费请求。
4. 判断当前 A2 设计前提是否错误，还是 Host dispatch 时机/接口使用错误。
5. 对候选修复做最小原型与对比测试，输出明确架构决策。

## 3. 当前假设（需证伪/确认）

### H1：continuable Activation 在 turn idle 后自动释放

预测：Role Actor turn 结束后、下一 Node 到达前，`ctx.agents.get(childId)` 稳定返回 undefined；`ctx.subagents.followup()` 随后从持久 Session cold-resume。

若成立，当前“只对 resident Agent compact”无法满足跨 Node 常态路径。

### H2：cold-resume 加载完整未 compact 的持久历史

预测：第二个 Node followup 后，模型请求上下文包含第一个 Node 的历史（除普通全局 compaction 已处理部分外）；Node 数增加时 input token 单调增长。

若不成立，可能 persistence/agent loop 已在 cold-resume 内隐式 compact，现有 skip 只是可观测性误导。

### H3：可以先 cold-resume、compact，再投递新 Node prompt

预测：若 continuation API 支持“materialize without dispatch”或可在 followup 前取得 resident Agent，则能在新 prompt 进入前执行 `compactNow`，保持明确 Node 边界。

风险：现有 `followup()` 可能把 prompt 入队并立刻启动 turn，导致 compact 与新 Node 并发，违反串行边界。

### H4：需要改为 summary/fresh Actor，而非原地 compact

预测：若 Host API 没有安全的 cold materialize seam，最可靠方案可能是：读取旧 Session → 生成受控 summary → 创建新 Actor session → 更新 role mapping。

代价：改变“同一 Role Actor Session 跨 Run 复用”的既有语义，需要独立设计。

## 4. Feedback Loop 要求

必须新增隔离 harness，禁止用真实 `~/.dsh` 或当前 workspace state。

最小场景：

```text
Node A (role=developer)
  claim accepted → Judge ACCEPT → Node B
Node B (same role=developer)
```

测试控制：

1. Node A 首次创建 continuable Actor；
2. Actor turn 完全 settle，确认 resident Activation 是否释放；
3. Node B fresh entry；
4. 记录 compactRoleActor 返回值；
5. 记录 cold-resume 前后 Session event/token/context facts；
6. 断言 Node B 的模型输入是否包含 Node A 未压缩历史。

至少运行：

- resident case：人为保持 Actor resident，预期 compact 执行；
- cold case：Actor自然 settle，预期复现 skip；
- host restart case：只有持久 session id；
- 多 Node case：重复 5～10 次，观察 token 增长曲线。

所有 state/session/catalog 使用临时 DSH home，结束只删除自有 temp root。

## 5. 必须采集的观测点

以唯一 `[DEBUG-COLD-COMPACT]` 临时前缀记录，完成后清理：

- roleKey、childId；
- `ctx.agents.get(childId)` 是否 resident；
- Actor status/activation 状态；
- turn/end 与 Activation release 时间；
- compact 调用开始/结束/失败；
- followup 接受时间与新 turn 开始时间；
- cold persistence inspect 的 event count；
- Node A/Node B 模型请求 input token 或可比较的上下文字符数；
- compaction shadowed seq/token count。

禁止记录普通消息全文或凭据。

## 6. 候选方案及判定标准

### 方案 A：Cold materialize → compact → followup

前提：Host 提供无 prompt、无 turn 启动的 continuable materialize/resume API。

通过条件：

- 新 Node prompt 入队前 compact 完成；
- 无 active turn 并发；
- cold/restart 均工作；
- role session identity 可保留。

### 方案 B：Followup 前 persistence-level compact

前提：Session persistence/compaction 支持对非 resident session 安全压缩。

通过条件：

- 产生与 `compactNow` 一致的 shadow/history 语义；
- 不破坏 append-only/invariant；
- restart 与并发安全可证明。

### 方案 C：新 Node 创建 fresh Actor + 受控 handoff summary

前提：无法安全 cold compact。

通过条件：

- 每 Node context 有界；
- 只携带明确 summary/handoff，不丢业务必要信息；
- role mapping/lifecycle、模型 override、工具授权可迁移；
- 文档明确不再承诺同一 Session identity。

### 方案 D：接受 cold skip，但证明不加载旧历史

只有 H2 被证伪时可选。必须有模型请求上下文证据，不能仅凭 `agent === undefined` 推断。

## 7. 调查边界

- 调查阶段不直接修改生产 compaction 语义。
- 不在真实 active run 上加 instrumentation。
- 不把“cold-resume skip”直接改成错误/BLOCK；在原因明确前，BLOCK 只会降低可用性。
- 不同时修改 A1 claim 协议，避免变量过多；可使用固定 mock Judge。
- 不以单元 mock 的 `ctx.agents.get()` 结果替代真实 continuable lifecycle 集成测试。

## 8. 交付物

1. `docs/diagnostics/cold-resume-compaction-report.md`：复现步骤、时间线、数据、根因。
2. 隔离 regression/integration harness。
3. 候选方案对比表：正确性、侵入性、状态兼容、测试难度、运行成本。
4. 一份明确决策：选择 A/B/C/D，或列出阻塞该决策的 Host API 缺口。
5. 若选择需要架构变化的方案，另建实现 PRD，不把调查代码直接当生产修复。

## 9. 验收标准

- **AC1 稳定复现**：隔离测试至少连续 10 次复现 cold-resume skip，或以证据证明它不是稳定常态。
- **AC2 时序明确**：报告能指出 Activation 在哪个事件后释放、下一 Node 何时尝试 compact/followup。
- **AC3 上下文证据**：通过本地 request 构造 seam/tokenizer量化 Node B 是否加载 Node A 历史；若没有 tokenizer，使用确定性的事件范围与字符数作为近似并明确标注，不能只看 resident 状态，也不得为此调用真实付费 provider。
- **AC4 resident 对照**：resident case 中 compact 确实执行且有 shadowed token/seq 证据。
- **AC5 restart 对照**：Host restart 后路径有明确结果。
- **AC6 方案原型**：至少一个可行候选在隔离 harness 中证明 Node B context 有界。
- **AC7 不影响真实环境**：所有测试使用 temp DSH home/synthetic workspace，真实 `~/.dsh` 零写入。
- **AC8 清理**：所有 `[DEBUG-COLD-COMPACT]` instrumentation 从生产代码移除。
- **AC9 决策文档**：结论回写 `CONTEXT.md`、设计文档或 ADR；若既有 A2 前提错误，明确修订而不是保留矛盾描述。
