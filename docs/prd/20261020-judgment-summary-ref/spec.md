# Spec：节点事件 judgment 摘要 + 引用取全文（结论前置，通知通道可行动化）

> 本 spec 由 issue #214 规格化而来；范围澄清已获作者确认：读取口复用现有 `workflow_status` history 分页，不新增参数/出口；Web GUI 通知卡懒加载全文**排除**，拆后续票。

## Problem Statement

Manager 消费节点事件通知和 `workflow_status` 时，拿不到可行动的判定信息：

1. node-event 通知里 judgment 文本几乎总被截断（reason 硬截 200 字符，且截断点在句子中间），关键结论和下一步动作常被切掉。
2. 判定全文（≤2000 字符）其实已经持久化在引擎事件库中，但通知不携带指向它的引用，Manager 不知道（也无从机械地）按需取全文，只能翻 background Judge subagent 的 closing message——而该通道本身多次空白/截断/乱码。
3. 新 claim 待判期间，`workflow_status` 的 `judgment` 字段仍显示上一轮旧判定（`reasonPreview` 同样截断），与「当前待判定」无法区分，只能靠 `handoffPreview` 变化间接推断。

结果是：Manager 大多数时候只需「判定 + 一句理由」，却被迫在注定截断的通道里猜结论；仅 REJECT/NEED_CONTEXT 需要全文时反而取不到。

## Solution

三层修复，全部落在既有 seam 上，无新模块：

1. **结论前置（零引擎代码）**：Judge persona 强制输出格式——第一行必须是 `判定结果 + 一句话结论 +（REJECT/NEED_CONTEXT 时）下一步动作`，证据细节放后。前 ~150 字符被截断也不损失可行动性。
2. **摘要 + 引用**：node-event 通知的 judgment 字段改为 `verdict + 摘要(≤200字符) + judgmentRef`；judgmentRef 复用现有标识（executionId、visit、事件 sequence——均为事件中已有字段）。全文通过现有 `workflow_status` history 分页按 executionId 读取（事件 snapshot 已含完整 judgment）。background subagent closing message 空白/截断时，通知只给引用不内联长文本，Manager 不再依赖该通道。
3. **消除展示歧义**：`workflow_status` status 输出区分「当前 claim 已判定的 judgment」与「历史/待判定」，沿用既有的判定对齐口径（judgment.claimId + inputVersion 与当前 claim 对齐即为当前判定），并标注 visit 序号。

## User Stories

1. As a Manager，我想在 node-event 通知的前 ~150 字符内看到判定结果和一句话结论，以便截断发生时仍能立即决定下一步。
2. As a Manager，REJECT/NEED_CONTEXT 时我想在通知首行看到下一步动作建议，以便不取全文也能启动恢复流程。
3. As a Manager，我想在通知中获得 judgmentRef（executionId 等稳定标识），以便机械地发起取全文请求而不必猜测对象。
4. As a Manager，我想通过现有 `workflow_status` history 分页取到某次判定的完整 reason（≤2000 字符），以便 REJECT 修正时核对全部证据。
5. As a Manager，我想让通知明确标注判定对应的 visit 序号，以便区分本轮判定与历史判定。
6. As a Manager，当 background Judge subagent 的 closing message 空白或截断时，我想让宿主通知不再成为判定结论的依赖项，以便不为猜测通道付出判读成本。
7. As a Judge，我想被 persona 强制把结论写在 reason 第一行，以便我的输出在任何截断通道下都保持可行动性。
8. As a Judge，REJECT 时我想在 reason 首行写明修法方向，以便 Actor 重提交时直接对齐。
9. As a Judge，NEED_CONTEXT 时我想在 reason 首行写明 Manager 需补充什么，以便恢复动作一步到位。
10. As a workflow 运维者，我想让 `workflow_status` 的 judgment 字段区分「当前已判定 / 历史 REJECT / 待判定」三种状态，以便不需要对照 handoffPreview 变化来推断。
11. As a workflow 运维者，我想让 `workflow_status` 的历史判定同样携带判定所针对的 claim 标识与 visit，以便跨轮追溯。
12. As a plugin 开发者，我想复用既有 history 分页作为全文读取口，以便不新增工具参数、schema 或权限面。
13. As a plugin 开发者，我想让通知格式变更只影响展示层，以便引擎状态机与 invariants 不受影响。
14. As a plugin 开发者，我想让 Judge persona 的格式约束进入 spawn 输入的公共说明，以便所有角色工作流一致生效。
15. As a plugin 开发者，我想让截断发生在语义词边界（而非硬切字节），以便摘要保持可读。
16. As a 测试维护者，我想通过既有 engine 测试 seam 断言通知文本与 status 输出，以便不新增测试基建。
17. As a 后续 Web GUI 开发者，我想依赖稳定的 judgmentRef 契约（本 spec 定义），以便后续懒加载票无需再改引擎。

## Implementation Decisions

- **修改模块**：引擎通知格式化（node-event 文本）、`workflow_status` 的 status 输出、Judge spawn persona 说明（checker 约束文案）。均为既有模块的展示层调整。
- **通知格式**：judgment 字段输出 `结果 + ≤200 字符摘要 + 引用标识`；引用复用事件中已有字段（executionId、visit/sequence），不发明新 ID。
- **全文读取**：不新增 workflow_status 参数、不新增工具。复用现有 Manager-only history 分页；事件 snapshot 本身已含完整 judgment（现状核实：存储层 events 读取返回完整 NodeExecution snapshot）。在文档/通知格式中明示该读取路径即可。
- **判定对齐口径**：复用既有「judgment.claimId 与当前 claim.id 且 inputVersion 对齐 = 当前判定」的定义，status 输出据此区分当前判定 / 历史判定（REJECT/NEED_CONTEXT 反馈）/ 待判定（有 claim 无对齐判定）。
- **Judge persona**：在 checker 公共约束中强制 reason 首行格式：`判定结果 + 一句话结论 +（REJECT/NEED_CONTEXT）下一步动作`；证据细节后置。不改变 Judge 只读 + fail-closed 契约。
- **不动**：EVENT_TYPES、StateStore schema、invariants、authz——本变更不触碰状态机与权限模型。

## Testing Decisions

- 只测外部行为：断言 node-event 文本与 `workflow_status` 输出的形状（含 verdict、摘要长度上限、引用字段、判定状态区分），不断言内部实现。
- 覆盖模块：engine 通知格式化与 status 输出、judge persona 文案约束。测试放在既有 `test/<area>.test.ts` 对应分区，用 node:test 直接跑 `.ts`。
- 先例：现有 engine/status 相关测试（如 coding-workflow 系列对 claim/judgment/通知文本的断言）即为同类样板。
- 验收入口 `pnpm run verify` 口径不变。

## Out of Scope

- Web GUI 通知卡点击懒加载全文（拆后续票，依赖本 spec 定义的 judgmentRef 契约）。
- 新增 workflow_status 参数 / 新只读工具 / schema 变更。
- background subagent closing message 通道本身的宿主侧修复（空白/乱码为宿主缺陷，本 spec 只解除 Manager 对它的依赖）。
- trace log、SQLite schema、EVENT_TYPES 扩充。

## Further Notes

- 实证来源：run 07833774 / Milestone 32 复盘（见 issue #214 正文引用）。
- 相关既有事实：`workflow_status` history 分页已是 Manager-only 且按 executionId 归属当前 Run 校验；判定全文随事件 snapshot 持久化，本 spec 只是打通「通知 → 引用 → 读取」链路。
