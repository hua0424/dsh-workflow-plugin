# PRD：Subagent Node 边界 Compact 阈值

- 日期：2026-09-06
- Milestone：`subagent-compact-threshold`
- 来源需求：Role Actor 每次进入新 Node 前目前都会主动 compact；短上下文没有必要支付额外的冷物化与摘要成本。希望在 Workflow Configuration 中设置阈值，仅当既有上下文长度超过阈值时执行 compact。

## 1. Problem Statement（问题陈述）

现有 Agent Team Workflow 会在复用已有 Role Actor、派发一个新 Node 前执行 Node 边界 compact。cold Actor 路径需要先无 prompt 物化 Session，再调用摘要模型执行 `compactNow`，随后释放 handle 并 followup。即使历史上下文很短，这条路径也会尝试 compact，产生不必要的物化、测量和潜在摘要调用成本。

用户需要按 Workflow Configuration 控制何时值得执行 Node 边界 compact：短上下文直接派发，长上下文仍按现有流程压缩，从而在保留 Role Actor 跨 Node 复用语义的同时减少无收益的 compact。

## 2. Solution（解决方案）

在 `agent-workflow/v2` 顶层增加可选的全工作流配置 `compactThresholdTokens`，表示 Role Actor 当前模型上下文的估算 token 阈值。进入已有 Role Actor 的新 Node 时，Host 在调用 `compactNow` 前通过 DSH `tokenMeter` 测量已物化 Agent Session 的 `totalTokens`：

- `totalTokens > compactThresholdTokens`：沿用现有 Node 边界 compact 流程；
- `totalTokens <= compactThresholdTokens`：跳过 `compactNow`，继续派发新 Node；
- 未配置 `compactThresholdTokens`：保留当前无条件尝试 Node 边界 compact 的行为，确保现有 Workflow Configuration 向后兼容。

该配置位于 Workflow Configuration 顶层，对 Root/Child Workflow 中所有非 Manager Role Actor 一致生效，不增加 per-role 或 per-node 开关。比较语义严格采用“超过阈值”，等于阈值时不 compact。

示例：

```yaml
schemaVersion: agent-workflow/v2
compactThresholdTokens: 32000
roles: {}
judgeRole: {}
workflow: {}
```

示例仅展示字段位置；完整配置仍须满足 Catalog schema 与静态校验。

## 3. User Stories（用户故事）

1. 作为工作流维护者，我希望在 Workflow Configuration 中设置 compact token 阈值，以便不同工作流按自身 Node 数量和上下文规模控制摘要成本。
2. 作为工作流使用者，我希望短上下文的 Role Actor 进入新 Node 时跳过 compact，以便减少无必要的摘要调用和等待。
3. 作为工作流使用者，我希望长上下文超过阈值时仍执行现有 compact，以便避免 Role Actor 历史持续膨胀。
4. 作为现有工作流维护者，我希望省略新字段时行为不变，以便升级插件后无需立即修改全部 Catalog 文件。
5. 作为配置作者，我希望非法阈值在 Catalog 加载阶段得到明确诊断，以便在运行前修正配置。
6. 作为排障人员，我希望 trace log 能区分“低于阈值跳过”和“执行 compact”，并记录测量值与阈值，以便解释某次派发的决策。
7. 作为测试人员，我希望阈值判断可通过隔离 fixture 验证，以便不触碰真实 `~/.dsh`、真实 Workflow Run 或真实摘要模型。
8. 作为运行维护者，我希望 token 测量或必要 Host 能力异常时采用明确且安全的失败语义，以便不会在未知上下文压力下静默绕过既定策略。

## 4. Scope（范围）

- 扩展 Workflow Configuration 的严格 schema、领域类型、Definition Snapshot 与 definition hash 输入，使 `compactThresholdTokens` 随 Run 启动时的不可变快照冻结。
- 阈值接受安全正整数 token 数；拒绝零、负数、非整数、非数值和超出 JavaScript 安全整数范围的值。
- 在已有 Role Actor 的 fresh Node dispatch 路径中，将冻结的阈值交给 Node 边界 compact 逻辑。
- resident 与 cold materialize 两条 Host 路径均在同一 token-meter 语义下先测量再决策；cold 路径仍须先无 prompt 物化，才能读取准确的 replay-aware Session 测量。
- 保留 Manager、首次创建 Role Actor、同 Node resume 的既有豁免。
- 扩展 best-effort trace detail，至少包含决策（compact/skip）、估算 `totalTokens` 与配置阈值。
- 更新 Workflow Configuration 示例与领域文档，说明字段位置、兼容默认值、单位和严格大于比较规则。
- 增加 schema、engine/host 行为和隔离 e2e smoke 范围内可执行的自动化测试。

## 5. Implementation Decisions（实现决策）

1. **配置层级**：字段名为 `compactThresholdTokens`，位于 Catalog 顶层，与 `roles`、`judgeRole`、`workflow` 同级；Root 与所有 Child Workflow 共用一个策略，延续“不引入 per-role 生命周期开关”的既有决策。
2. **兼容性**：字段可选；缺省时保持当前“fresh Node + 已有 Role Actor mapping 就尝试 compact”的行为。该增加不改变既有字段语义，因此继续使用 `agent-workflow/v2`，不引入双轨 schema。
3. **单位与数据源**：单位为估算 token。决策使用 DSH replay-aware `tokenMeter.measure(agent.session).totalTokens`，与 DSH 自动 pressure compaction 的上下文压力口径保持一致，不以消息数、字符数或上次 compact 返回的 `shadowedTokenCount` 代替。
4. **边界语义**：仅当 `totalTokens > compactThresholdTokens` 时调用 `compactNow`；小于或等于阈值都跳过。
5. **执行时机**：阈值判断只发生在现有 Node 边界 compact seam。首次创建 Role Actor 没有历史，不测量；Manager 不测量；BLOCK/resume 等同 Node 重派不测量也不重复 compact。
6. **cold Actor 生命周期**：cold Actor 仍按“resume 无 prompt → 测量 → 可选 compact → dispose → followup”顺序处理。低于阈值时跳过摘要，但仍必须 dispose 已物化 handle，避免后续 cold followup 与同 Session id 的 resident Agent 冲突。
7. **resident 竞态**：resident Agent 先测量；超过阈值后 `compactNow` 若因窄竞态返回 `busy`，继续沿用现有降级跳过语义。其他 compact 失败仍 fail-closed BLOCK。
8. **能力缺失与测量失败**：配置了阈值但 token-meter 服务缺失、返回非法测量或测量抛错时，不能假定上下文低于阈值；该次 Node 边界处理返回失败并沿用现有 compact failure → BLOCK 与 Manager 通知机制。未配置阈值时不新增 token-meter 依赖。
9. **状态模型**：不新增可变运行时状态。阈值只存在于不可变 Definition Snapshot；每次 fresh Node dispatch 从 Snapshot 读取。测量值与本次决策只写 best-effort trace，不写 Workflow SQLite 状态字段。
10. **配置冻结**：Run 启动后修改 Catalog 文件不影响当前 Run；新阈值与其他 Definition Snapshot 内容一样仅对下一次 Run 生效。

## 6. Testing Decisions（测试决策）

测试优先覆盖最高且稳定的既有 seam，并只断言外部行为，不绑定私有函数结构：

- **Catalog seam**：通过受限 YAML 解析、严格 schema 与 normalize 全链路验证字段接受、缺省兼容及非法值诊断；沿用现有 catalog/schema 测试模式。
- **Engine seam**：使用现有内存 StateHost、假 SubagentHost 验证 fresh Node 才触发阈值感知的 compact 请求，并确保 Manager、首次创建与 same-node resume 行为不变。
- **Host seam**：扩展现有 `host-compact` fixture，注入假的 token meter、resident Agent 或 cold resume handle，验证低于、等于、超过阈值三种分支，以及 cold skip 后必定 dispose、测量异常 fail-closed、缺省配置不测量。
- **Trace seam**：断言可观察 detail/trace 包含测量值、阈值与 skip/compact 决策，不断言内部调用栈。
- **隔离回归**：执行 `pnpm run build`、`pnpm test`；若现有 `pnpm run test:e2e` 能在隔离临时 DSH home 内覆盖该配置加载与派发路径，则执行并要求通过。
- **真实环境边界**：自动测试不得修改真实 `~/.dsh`、当前真实 Workflow Run 或真实 profile。只有“真实模型摘要是否按部署配置路由”等隔离环境无法证明的集成事实可留给用户手工验证，不作为跳过可隔离测试的理由。

## 7. Out of Scope（非目标）

- 不修改 DSH 全局 compaction-basic 的 `thresholdRatio`、`retainRatio`、自动 pressure compaction 或 overflow recovery 策略。
- 不提供 per-role、per-node、provider/model 专属阈值，也不提供运行中动态修改阈值的工具。
- 不改变 Role Actor Session 跨 Root/Child Run Frame 复用、cold resume、Judge 或 NodeContextBoundary 语义。
- 不对 Manager 主会话或 Judge Agent 执行该阈值 compact。
- 不根据字符数、消息数、Node 数或 wall-clock 时间触发 compact。
- 不新增 Web GUI 配置界面或 compact 指标面板。
- 不承诺通过该阈值精确控制模型计费 token；`totalTokens` 是 DSH token meter 的 replay-aware 估算/锚定结果。
- 不在本交付中改变 summary 模型、摘要模板或 compact 后保留范围。

## 8. Acceptance Criteria（验收标准）

- **AC1 配置解析**：合法的顶层 `compactThresholdTokens` 安全正整数可通过受限 YAML、严格 schema 与静态校验并进入 Definition Snapshot；非法值在 Catalog 加载时给出字段级诊断。
- **AC2 缺省兼容**：未配置阈值的既有 `agent-workflow/v2` Catalog 行为不变；已有 Role Actor 在 fresh Node 边界仍按原设计尝试 compact，且不要求 token-meter 预检查。
- **AC3 低于阈值跳过**：已配置阈值且 `totalTokens < compactThresholdTokens` 时不调用 `compactNow`，随后正常派发 Node。
- **AC4 等于阈值跳过**：`totalTokens === compactThresholdTokens` 时不调用 `compactNow`，证明比较符为严格大于。
- **AC5 超过阈值 compact**：`totalTokens > compactThresholdTokens` 时调用一次 `compactNow`，成功或 `null` 后再正常派发，并保持现有错误分类。
- **AC6 cold 清理**：cold Actor 在低于/等于阈值而跳过 compact 时，调用顺序为 resume 无 prompt → measure → dispose → followup；已物化 handle 不泄漏。
- **AC7 既有豁免**：Manager、首次创建 Role Actor、同 Node resume 均不执行阈值测量或 Node 边界 compact。
- **AC8 失败安全**：配置阈值时，token-meter 缺失、测量抛错或返回非法 token 值会使当前 Node 进入 BLOCK，原因可读并通知 Manager；不得静默当作低于阈值。
- **AC9 可观测性**：trace log 可区分低于阈值跳过与超过阈值执行，且记录 `totalTokens` 和 `compactThresholdTokens`；trace 写入失败仍不阻断 Run。
- **AC10 快照语义**：Run 启动后修改磁盘 Catalog 的阈值不影响当前 Run；下一次 Run 使用新值。
- **AC11 文档**：Workflow Configuration 示例与领域说明包含字段位置、token 单位、缺省兼容行为及“严格超过”规则。
- **AC12 自动化门禁**：`pnpm run build` 与 `pnpm test` 全绿；`pnpm run test:e2e` 若可在既有隔离临时 home 内执行则必须全绿，且不得触碰真实运行环境。

## 9. Further Notes（补充说明）

- `compactNow` 的 `null` 表示没有安全且有用的可压范围；它与“阈值未超过而未调用 compact”是两个不同的正常分支，trace 应能区分。
- 阈值判断减少的是不必要的摘要尝试；cold Actor 为获得 replay-aware Session 测量仍需一次无 prompt 物化。若后续需要避免这次物化，应另行设计 persistence-level measurement API，不在本 PRD 范围内。
- 实现应继续保持插件运行时依赖边界：DSH Host API 包维持 devDependency/宿主解析模式，不因 token-meter 能力而加入普通 runtime dependencies。
