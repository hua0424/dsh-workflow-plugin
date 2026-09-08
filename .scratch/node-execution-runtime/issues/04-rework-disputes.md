## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T4：同一 Node Execution 内完成多轮 Actor/Judge 返工、补充与争议协调，Manager 可查看有序关键历史。争议复用 BLOCK/resume，不增加申诉工具或辩论状态机。

## Acceptance criteria

- [ ] claim #1→REJECT→claim #2→ACCEPT 保持 execution，事件保存两份提交和两次判断的快照、关联与顺序；当前状态只接受有效版本。
- [ ] REJECT 不走 onFail，同一工作回到 ready 并把最近拒绝理由和原提交送回 Actor；NEED_CONTEXT 保留有效 claim，Manager 补充先保存再发送。
- [ ] 判定绑定精确 claim 和判定输入；补充改变输入、退回 Actor 或重新提交后，旧 Judge 迟到结论无效。
- [ ] 插件统一注入 Actor 争议 BLOCK 协议及 Judge 依据既有 criteria 的判定协议，不要求每个 Node 重复写。Manager 澄清不能静默改图/改 criteria 或强制 ACCEPT。
- [ ] node_resume 的 auto/actor/judge 目标有当前 BLOCK、Node 类型、有效 claim/结论和未离开的限制；退回 Actor 保留材料但撤销旧判断资格。
- [ ] 既有 status 支持 Manager-only 对本 Run execution 的有界事件分页（最多50条、稳定序号游标）；默认仅当前摘要，跨 Run/非授权访问拒绝。
- [ ] Actor 无 claim 正常结束形成可见暂停，不静默卡住。测试覆盖争议→Manager补充→重新提交→独立判断的闭环。
- [ ] 对应 #7 A08–A10、A25–A27；完成 red→green、类型检查、相关/全量测试、双轴审查与提交。

## Blocked by

#10 — T3：三表工作单事务闭环。
