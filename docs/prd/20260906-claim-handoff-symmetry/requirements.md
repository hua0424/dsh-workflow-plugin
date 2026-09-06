# 新需求：completed / failed 的 Handoff Context 对称传递

- 状态：待独立开发；本文仅记录需求与背景，不代表已实现。
- 来源：用户在真实 milestone-delivery 工作流返工停滞诊断后明确提出。
- 用户决策：completed 与 failed 应拥有完全一致的信息流能力，两者仅对应不同的节点路由。用户将另行安排开发，完成后重新运行工作流；本次试跑现有交付变更由用户作废重来，不作为该需求的验收成果。
- 操作边界：记录本文不代表授权自动 reset、删除分支、关闭 Issue、改写历史、清理工作区或恢复当前 Run。

## 1. 背景与问题

真实 Run `968a74c2-2f98-47b5-895f-7d61fe87e911` 在 Issue #5 的评审返工中出现重复提交旧实现、最终主动 BLOCK：

1. Reviewer 在 `issue-delivery/review` 找到四项实现/验收阻断，返回 `approved=no`。
2. Manager 在 `decide-pr` 声明 `outcome=failed`。该节点指令要求“failed 不支持 handoffContext，因此返工上下文必须写入 summary”。Manager 按此要求将 Issue、分支、SHA、问题与修正要求全部写入 summary。
3. Judge ACCEPT 该失败声明，引擎正确沿 FAIL 边返回 `implement`。
4. 引擎跨节点派发只提取 `pendingClaim.handoffContext`，未把 failed summary 作为下一节点上下文；failed 又不允许 handoff，导致返工要求未进入新派发消息。
5. Developer 是复用的 Role Actor，只收到固定实现指令，继续依据旧会话中的“无 PR 例外、按既有实现提交 completed”决定重复声明完成，未产生修复提交。
6. 2026-09-06 21:03:41，Developer 主动 BLOCK，错误推断为“Judge 因无 PR 拒绝，形成死锁”。实际 Judge 并未因此 REJECT；流程此前正常走的是 `decide-pr failed → Judge ACCEPT → FAIL → implement`。

### 诊断证据

- 本次运行 trace：`C:\Users\hua\.dsh\workflows\milestone-delivery\20260906-180857-968a74c2.txt`，第 40–55 行记录两次 failed、Judge ACCEPT、FAIL 路由、旧提交重复声明和最终 Actor BLOCK。
- 诊断时的 Engine：`src/engine/engine.ts`，`handleJudgeClaim` 的 ACCEPT 分支仅取 handoffContext 再 advance/dispatch；`dispatchCurrent` 无 transientContext 时只发送固定 instruction 与提交约束。
- 当时的工具/领域约定仅允许 completed 携带 handoffContext。

行号及本地日志路径只用于定位本次事故，不应成为新实现的硬编码依赖。诊断为只读日志与源码核查，尚未新增或执行该缺陷的回归测试。

## 2. 为什么会有此限制

现有协议把 Handoff Context 限定为“成功交付后传给下一节点的信息”，而将失败原因放在 summary 中。这是既有设计限制，不是 FAIL 路由的技术必需条件。

该限制不能满足通用 Workflow Graph：FAIL 同样可以进入一个正常的后继节点，例如返工、补充资料或修复节点，这些节点也需要完整业务上下文。要求失败信息写 summary 却不转发 summary，造成配置约定与引擎行为不匹配。

本文不追认最初设计动机；上述说明描述当前协议的实际限制及其后果。

## 3. 用户目标与核心决定

**completed 与 failed 的信息流能力必须完全对称；outcome 仅决定 Judge ACCEPT 后选择 PASS 或 FAIL 路由。**

- 两种 outcome 均可提供可选 handoffContext。
- 两种 outcome 均有必填 summary，含义与校验一致。
- handoffContext 的类型、长度限制、空值处理、存储、恢复、日志与派发规则不得因 outcome 不同而改变。
- 保留 Judge 确认机制：ACCEPT 才按 claim outcome 路由；REJECT 是同节点纠正，不是 FAIL 路由；NEED_CONTEXT 仍进入 BLOCK。
- 不再要求业务配置把失败上下文塞入 summary 来替代 handoff。

## 4. 功能范围

### R1：Claim 接口对称

node_claim 对 completed 和 failed 接受相同的 summary / handoffContext 字段契约。handoffContext 仍为可选；省略时两种 outcome 均不自动生成业务上下文。

移除所有“仅 completed 可以携带 handoffContext”的限制，包括参数校验、类型分支、工具描述、提示文本与文档。不得仅放宽工具入口却在内部静默丢弃 failed handoff。

### R2：完整保存与恢复

pendingClaim 必须对两种 outcome 一视同仁保存 handoffContext，并在 Judge 重建、NEED_CONTEXT 恢复及宿主重启后的判定恢复中保留其内容。

REJECT 的 previousClaim / pendingCorrection 同样不得丢弃 failed claim 的 handoff。仍沿用现有“REJECT 纠正同节点、ACCEPT 后才向后继传递”的边界。

### R3：FAIL 后继节点收到 Handoff

Judge ACCEPT failed claim 且存在 onFail 后继节点时，原样传递该 claim 的 handoffContext，与 completed 沿 onPass 的行为一致。

必须覆盖立即派发与 deferred 派发两条路径，并适用于 Manager / Role Actor 后继及现有 Child Workflow 上下文传递边界。

无 onFail 时继续按原定义 BLOCK，不创造后继节点、不自动推进。对此分支的上下文保留与恢复边界必须明确记录并测试，不能把本次提交描述为已成功交付给不存在的后继。

### R4：Summary 与 Handoff 职责明确

- summary：当前 Node 的结果声明摘要，供 Checker/Judge 与日志核对。
- handoffContext：向后续节点传递的业务上下文。
- 不通过“failed 时把 summary 隐式转为 handoff”解决问题；该做法会继续维持两种 outcome 的不对称语义。
- 若未来需要统一的 summary fallback，另行定义，不能仅为 failed 添加隐藏规则。

### R5：同步工作流配置与权威文档

更新 milestone-delivery 的 decide-pr 等失败分支指令：声明 failed 时直接通过 handoffContext 携带 Issue、PR、分支、SHA、阻断发现和具体修正要求；summary 只需概括退回原因。

检查仓库示例、配置模板、领域术语、权威设计、工具说明及测试 fixture，移除旧的 completed-only 限制。需要同步实际部署的 Catalog，但不得在本需求记录阶段改写真实运行配置。

Active Run 使用 immutable Definition Snapshot。配置修改不应宣称自动修复旧 Run；用户计划在开发完成后启动新 Run 验证。

## 5. 非目标

- 不绕过 Judge、不允许 Manager 直接裁决 Actor Node PASS。
- 不改变 PASS/FAIL 路由图、REJECT 纠正流、NEED_CONTEXT/BLOCK 含义。
- 不新增任意跳节点、自动重试或新业务输出 DSL。
- 不通过清空 Actor 历史、改模型或恢复旧 Run 来替代信息流修复。
- 不在本需求中修复 Issue #5 的 compact 实现阻断项。
- 不自动作废现有 Git/GitHub 对象或交付记录；相关操作由用户另行安排。

## 6. 验收标准

- **AC1 接口对称**：completed 与 failed 都能提交合法 handoffContext；非法类型、超长、空值等边界按同一既有规则处理。
- **AC2 FAIL 实际派发**：failed + handoff → Judge ACCEPT → onFail 后继，后继派发消息包含完整 handoff，Issue/分支/SHA/纠正要求无丢失。
- **AC3 PASS 回归**：completed 的 handoff 行为保持不变；针对相同输入上下文，两条分支仅目标/路由结果不同。
- **AC4 立即/延迟派发**：worker 已结算和仍 active 两种时序下，FAIL handoff 均送达且不串入其他 Node。
- **AC5 恢复**：failed handoff 经 pendingClaim 保存、宿主重启、Judge 重建与 NEED_CONTEXT 恢复后保持完整。
- **AC6 REJECT 边界**：failed claim 被 REJECT 时不走 onFail，previousClaim 保留 handoff 供纠正；随后 ACCEPT 才按最终 claim 路由。
- **AC7 无后继边界**：failed 且无 onFail 仍 BLOCK，不伪造派发；上下文保存/恢复行为有明确文档与测试。
- **AC8 实际事故回归**：隔离运行包含 implement → review → decide-pr → implement 的返工循环，Reviewer 给出唯一标记的修正要求，Manager 以 failed handoff 传递；断言新 implement 派发实际收到该要求，而非仅在日志或 Manager Session 中可见。
- **AC9 文档一致**：工具 schema/描述、类型、引擎、领域文档与示例均不再存在生效的 completed-only handoff 限制；历史记录应标明已被本需求取代，不歪改事故事实。
- **AC10 安全与兼容**：不携带 handoff 的旧 claim 仍有效；既有授权、派发 lease、nodeToken、Judge 只读和最小状态约束保持不变。

## 7. 验证与交付建议

优先使用真实 Engine + 隔离 StateStore + 假 Host 的集成 seam：记录实际 sendRoleActor / steerManager 的消息来验证内容送达，不能只断言类型接受字段或日志存在。

补充工具校验、状态 round-trip、Judge 恢复及 deferred dispatch 回归测试；执行构建、单测和隔离 e2e。不得修改当前真实 Run 来做测试，也不得将沙箱导致的未执行测试记为通过。

独立开发完成后向用户交付代码、配置迁移说明及测试证据。用户再以新 Run 重跑 milestone-delivery；旧 Run 和旧交付的处置由用户另行决定。
