## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T8：用户可以安全识别旧 State format、备份并授权退出旧活动Run，或终止新Run后保留历史再开始。Reset是终止而非完成，不清理外部资源，不需要手工改SQLite。

## Acceptance criteria

- [ ] 旧格式/不兼容活动数据被明确识别并拒绝继续；只读诊断及授权备份/导出与Reset路径可用，不自动Reset、不静默丢弃材料。
- [ ] 受控存储升级失败时不部分切换；损坏数据库不被新建空库伪装为恢复成功；不建设精确旧Run迁移或双引擎。
- [ ] Reset把Run标为terminated而非completed，释放当前资格但保留工作单、关键事件和必要Snapshot；撤销旧Actor/Judge推进权限。
- [ ] 新Run不覆盖旧历史；已知冲突旧工作未停止时不得派发，未知有风险需Manager/用户核查。Reset不自动取消所有外部动作或删除资源。
- [ ] 在临时旧库/新库和受控Host下red→green验证升级失败、授权退出、终止后新建和迟到消息拒绝；不操作真实用户库。
- [ ] 对应 #7 A24/A28及A01的资格释放；类型检查、相关/全量测试、双轴审查与提交完成。

## Blocked by

#10 — T3：三表工作单事务闭环。
