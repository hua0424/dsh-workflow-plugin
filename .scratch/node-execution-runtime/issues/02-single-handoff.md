## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T2：Actor 只提交 outcome(completed|failed) 与一份 handoff；Judge、Manager、后继节点及最终结果展示共用该交接文本。贯通首次派发、返工、恢复与重建 Judge，不保留 summary 双协议。

## Acceptance criteria

- [ ] handoff 必填、非空、有界，completed/failed 对称；公开业务字段只有 outcome 与 handoff，旧 summary/handoffContext 参数明确拒绝，无隐式 fallback。
- [ ] Judge 判断的是本次实际交付 handoff；Manager 状态预览与后继收到相同文本，END 也保留结果。
- [ ] 同步工具 schema、提示与所有首次/返工/恢复/重建调用路径，保留调用授权和提交成功后的安全收口。
- [ ] 在既有 Runtime/Host 测试 Seam 中逐条 red→green，覆盖旧合同拒绝、PASS/FAIL 对称、Judge 与后继材料一致。
- [ ] 本票不引入新存储引擎；以现有隔离状态作为后续三表切换的准备。新增公开合同已完成时同步相关工具说明，历史 PRD 不改写。
- [ ] 类型检查、相关测试及票末全量测试通过，完成双轴审查并提交；对应 #7 A05/A06 及 A07 的交接合同部分。

## Blocked by

#8 — T1：目标宿主兼容基线。
