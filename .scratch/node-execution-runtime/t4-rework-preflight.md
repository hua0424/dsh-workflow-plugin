# T4 返工/争议实施预检（非实现）

T3 事件表目前由 `ExecutionChange.events` 传事件类型，Store 把同一最终工作单快照写给该事务内的每种事件。T4 需要确保历史快照能解释 REJECT/NEED_CONTEXT：

- REJECT 后当前有效 claim/Judge 资格失效并回 ready，但同事务的 judgment 事件仍必须保存 Judge reason、被拒 claim 的完整 outcome+handoff、claim/judge dispatch 关联。最小方案可在工作单保留“最近 Judge 反馈/previous claim”当前字段，最终 ready 快照自然成为可解释事件；下一 claim 替换当前资格，旧快照保留在 events。不要为此做两次事务或另建 attempt 表。
- NEED_CONTEXT 不离开，不清 claim；保存判定输入版本、Judge reason 与 BLOCK 原阶段，Manager 补充必须先入库/事件再发送。补充改变 inputVersion，旧 Judge 结果失效。补充不覆盖进入时 input。
- ACCEPT 的业务 judgment 与前驱离开/后继进入仍同事务；不要为历史统一而把 ACCEPT 拆成先判定、后交接两次写。
- Actor 收到 REJECT 后认可就修正；有异议使用现有 node_block，说明分歧/证据/需 Manager 决定事项。插件统一提示，Node criteria/Role persona 不重复协议，Manager 不能强制 ACCEPT 或静默改冻结 criteria。
- events 当前支持按 execution 序号读取，但尚无公开 Manager-only 有界查询。T4在既有 workflow_status 接缝增加明确分页输入/输出，最多50，稳定after游标；Actor/Judge/跨Run拒绝。避免新增第二个history工具或Web UI。
- T3 ready 驱动暂时要求 predecessor Judge settled。Actor REJECT同execution不适用前驱等待；不要触发Node边界compact。Judge retire/重新安排要退出Judge自身提交Turn，不自drain。
- 新/旧 claim ID、judge dispatch ID、inputVersion分别校验；row revision仍只是CAS。历史存在不能让旧提交重新有效。

实施前重读T3完成后的实际类型/Store接口；本预检不解除#10阻塞、不修改Runtime。
