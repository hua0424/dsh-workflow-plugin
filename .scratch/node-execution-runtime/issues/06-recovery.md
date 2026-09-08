## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T6：普通执行与重启/resume/replacement 共用推进器。数据库记录明确时续当前阶段，业务进展未知时让 Actor 检查现场后继续，不建立异常分类恢复框架。

## Acceptance criteria

- [ ] SQLite 真实关闭重开后，即使没有 BLOCK/中断事件、phase仍是 working，也能找到原工作单并安全恢复。
- [ ] 有有效 claim 则继续/重建 Judge；有可交接结论则交接；前驱已离开只处理后继。无需回放 events 或恢复内存 DispatchBook。
- [ ] 未知进度恢复包含完整已有材料和“先检查现场再继续”提示；已完成测试产物核验后提交不重复副作用，部分完成只补做剩余工作。
- [ ] 默认续接原 Role Session，不可用/显式更换时 replacement；保存新安排并撤销旧资格，已知冲突执行未停止时不接手，未知高风险交 Manager 核查。
- [ ] Actor 与 Judge 恢复提示分工，Judge 只核验；状态损坏、ownership/Snapshot/位置错误 fail-closed，不允许 Agent 猜测改库。
- [ ] 可先统一 BLOCK 再由 Manager 恢复；允许记录明确且宿主条件满足的低成本继续。丢触发可以显式 resume，不新增轮询或可靠消息平台。
- [ ] 覆盖发送前失败、可能投递后未保存回执、Judge丢失、Actor Session丢失、重复/迟到回调和Manager补充发送失败。
- [ ] 对应 #7 A11、A13–A15、A19–A20及A25；完成 red→green、类型检查、相关/全量测试、双轴审查与提交。

## Blocked by

#13 — T5：Role 生命周期与 compact。
