# Issue Tracker

- Tracker：GitHub，仓库 `hua0424/dsh-workflow-plugin`，使用已认证的 `gh`。
- 可实施标签：`ready-for-agent`。拆票直接使用此标签，不再次 triage。
- 当前总规格：#7；实施分支 `refact`。工单及阻塞关系见 `docs/work-plans/runtime-refact.md`。
- 工单使用 GitHub 原生 dependencies/blocked_by 关系，并在正文保留相同 Blocked by 引用；只领取所有阻塞已完成的票。
- 每票记录起始 commit，实施后按该固定点审查本票差异；提交前的审查包含工作区变更，排除用户自有未提交文件。最终提交后复核 diff/commit 范围，发现修复纳入本票。
- Standards 与 Spec 使用独立并行审查；Spec 以当前子票为实施范围，总规格约束不得违背，后续票的未实现项不冒充当前票缺陷。
- 子票在验收、审查、提交均完成后附证据并关闭；拆票/子票完成不自动修改或关闭父规格 #7。
- 本地 commit 不等于 push。用户未授权推送/部署；不把 GitHub Issue 关闭描述为运行版本已经升级。
- 当前用户自有改动：`docs/example/workflow-template.yaml`；不修改、暂存或纳入本轮提交。
