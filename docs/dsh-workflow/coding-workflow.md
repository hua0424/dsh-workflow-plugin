# coding-workflow 使用说明

`coding-workflow` 是单仓、GitHub Milestone 多任务、两级 PR 的 `agent-workflow/v3` 工作流。实施 PR 合入 milestone 分支，集成 PR 合入目标基线，两级均采用 merge commit。配置见 [coding-workflow.yaml](../example/coding-workflow.yaml)，证据与重入规则见 [coding-workflow-contract.md](coding-workflow-contract.md)。

## 启动前

1. 确认实际运行的插件支持 v3 命名结果、子流程返回和 actorCommonPersona。仓库代码更新不等于已部署；需要升级旧格式状态库时按[升级手册](../user-guide.md#8-v3-升级与回滚停机切换)操作，配置安装不自动部署或迁移活动 Run。
2. 在目标仓库根启动，确认 GitHub 仓库、目标基线及授权。沿用项目已有 GitHub tracker，无需重新 setup；配置包含执行规则，其他项目无需先复制 INDEX、合同或本地报告目录。
3. 将配置保存到实际 catalog 的 `coding-workflow.yaml`，用 `/dsh-flow list` 校验，再用 `/dsh-flow start coding-workflow` 启动。同一 workspace 已有活动 Run 时先按实际状态处理，不用 reset 代替外部操作收尾。

## 跟踪材料

主 Issue 保存初始化、计划索引、范围变更、集成审查与最终交付；实施/修复 Issue 保存各票的原始分支起点、实施、自测、审查与合并证据。评论标明 workflowId、真实 runId、阶段及修订，handoff 传精确链接。主 Issue 已关闭仍可作为入口。初始化和首次计划可合为一条评论，ready 前两者均须完成。本配置仅支持单仓，不承担子仓改动或跨仓交付。

计划索引记录分类、父子关系、依赖、验收归属及有效授权/hold，不复制实时 CI/PR 状态。最新用户授权的必交集用于穷尽和最终完成核验；获准移出/取消的票保留历史依据，不因单纯改标签或移出 Milestone 就排除。至少一张 implementation 的门槛仍适用。

普通报告直接写 Issue，无需 run.md、合同副本、审查文件或 completion.md。确需长篇复杂报告才写 ignored `docs/dsh-workflow/runs/<runId>/`，并在 Issue 登记关键结论、适用修订、workspace、路径及哈希。远端摘要应独立保留关键证据；本地路径不等于异机可下载链接。

## 路由与验收

正常路径：初始化与规划（Manager 的 initialize-and-plan）→ 选票 → 实现 → 审查 → 合并关票 → 再次选票。选票同时维护依赖解阻标签与聚合关闭；人工 hold、撤销授权和待补信息优先。任务穷尽时选票节点直接准备集成 PR → 集成审查 → 合并关闭 Milestone。

单票审查 `changes-required` 返回实现；集成审查 `changes-required` 进入补救规划、开发循环后再回集成。两级合并的 `stale-review` 都返回本对象审查，包括同 SHA 出现批准未覆盖的新失败验证或实质反证。不再派独立裁决节点或预留 tester，开发与专业审查仍隔离，插件 Judge 核验所选出口合同。

Manager 初始化时完成主票与必要子票的创建/复用，关联同仓 Milestone，并检查聚合等待子票与显式依赖构成的联合等待图；planner 仅处理后续集成修复规划。穷尽要求必交集实施票和聚合票完成，只允许留下明确登记的主 Issue 集成验收项；不能把未完成实现归为集成验收。单票也执行当前集成 PR 审查，可引用旧证据，不能跨 PR 复用批准。

合并前保留确切批准与检查评论，使用 head 条件保护；合并后核验 merge commit 第一父节点等于 approvedBase、源 head 匹配 approvedHead、目标包含相关提交。已合并重入只补收尾，正常目标分支推进不触发重审。

Actor 遵循插件注入的提交协议，Judge ACCEPT 后才沿结果推进；REJECT 留在原节点修正，NEED_CONTEXT/BLOCK 补证后恢复。actorCommonPersona 只覆盖 Role Actor，Manager/Judge 独立配置。最终 `delivered` 表示交付，`cancelled` 表示用户明确取消；运行状态 completed 不单独证明交付成功。新配置只供新 Run，旧定义和历史材料保持原状。
