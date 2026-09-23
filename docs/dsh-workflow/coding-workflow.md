# coding-workflow 使用说明

版本：2026-09-23.1。本配置只用于伞仓与子仓组成的多仓 Milestone 交付；单仓使用 [coding-workflow-single.yaml](../example/coding-workflow-single.yaml)。多仓配置见 [coding-workflow.yaml](../example/coding-workflow.yaml)，详细规则见[合同](coding-workflow-contract.md)。

## 启动与确认

在伞仓根核对工作区干净及已有主 Issue/子票，实际插件须支持 v3 命名结果、Child 返回和 actorCommonPersona。将配置放入 catalog，用 `/dsh-flow list` 校验，再 `/dsh-flow start coding-workflow`；不在子仓并行启动另一个 Run，也不用 reset 代替外部收尾。

Manager 优先复用已有票；必要时用实际可用的 to-tickets 或项目等价 to-issues 拆票。每票是可完整验收的功能，可以跨仓；不强制把前后端拆成互相等待的单仓票。用户一次确认 baseline、Milestone 名、统一 milestone 分支名与每仓起点。缺失的子仓 baseline 从伞仓所选 baseline 的 gitlink SHA 建立；已有 baseline 与 gitlink 不同则展示差异确认，不移动已有分支。

伞仓 baseline 缺失时也须明确创建起点。伞仓和全部子仓都创建并推送统一命名的 milestone 分支，包括未改仓；显式切换，不修改 .gitmodules 长期跟踪分支。全部 Issue/Milestone 留在伞仓，PR 按代码仓划分。每仓都是 feature → milestone → baseline；无差异不建空 PR。

全流程只操作开发测试环境，禁止生产部署、生产配置/数据修改，也不能由目标分支 CI 间接触发生产操作。初始化明确测试环境、精确版本构建部署方法和 tester 授权；边界冲突先协调。交付完成不代表生产上线。

## 执行与信任

正常路径：初始化与拆票 → 选票 → 完整跨仓实现/自测 → 审查 → 合入 milestone → 本票独立集成测试并关票 → 再选票 → 准备整体候选 → 整体审查 → milestone 整体测试 → 合入 baseline → 关闭主/聚合票与 Milestone。

每张功能票和 Bug 票通过单票集成验收后立即关闭；依赖以前置票具有有效验收完成记录为准，不能只看 PR 已合并或手工 close。外部依赖和人工 hold 仍需满足。主/聚合票不参与实施票穷尽检查，避免等待最后才关闭的主票形成死锁。

选票独占任务穷尽判定，完整分页核对计划内功能票及后续 Bug；全部验收关闭才返回 issues-complete。prepare 信任这个清单，不反复扫票。各 Actor/Judge 信任已验收上游，只核本节点动作的当前对象、修订和结果。

## 单票实现、合并和测试

每轮 implement 一起完成当前 Issue 的所有相关仓改动，执行项目开发检查。先推子仓 feature，再在伞仓 feature 提交精确候选 gitlink；各变更仓分别开 feature → milestone PR，交完整 manifest。未改依赖保留固定版本，不拉最新 tip；伞仓 gitlink 每票更新，不等整个 Milestone 最后才组装。

review 批准完整候选后，merge-issue 用 merge commit 先子仓后伞仓合并，记录实际伞仓 milestone 提交及各子仓对应关系，不关票。tester 按这个提交的 gitlink 在授权测试环境构建、部署、集成测试；全部通过后关闭当前 Issue，返回 issue-completed。

本票测试发现产品缺陷回 implement，在当前仍开放的票记录和修复；已经合并的代码需要新修复分支/PR，未合并 PR 可更新，不另造 Bug。重新走完整审查、合并、测试链路。需代码解决的合并冲突同样回实现，部分已合并保留事实；网络、权限或环境故障则查询、重试或 BLOCK，不冒充产品缺陷。

## 整体测试与 Bug 循环

全部实施票通过后，prepare-integration 准备 milestone → baseline PR 和整体 manifest，固定已合入 milestone 的伞仓提交及 gitlink。必要 baseline 同步使版本变化时，推送新候选并重新整体审查、测试；需要产品代码处理的冲突交 planner 创建 Bug，coordinator 不代写实现。

整体审查关注跨票、跨仓配合及本轮变化，不逐票重审。整体测试针对固定 milestone 组合验证整个需求，不能用单票报告替代。部署错版本先恢复或 BLOCK；实际候选发生变化才回准备重审重测。

整体审查/测试的产品缺陷必须新建 Bug Issue，归同一 Milestone，记录失败版本、复现、涉及仓库、验收和依赖，回同一实施循环。已关闭功能票或 Bug 不重开、不追加修复工作；新 Bug 引用历史。重试发现同一开放 Bug 时复用，已关闭 Bug 的再次复发另建新票并关联历史。主 Issue 维护发现→Bug 映射，避免重复建票；纯环境问题不建产品 Bug。

Bug 单票验收通过关闭后，再做整体审查和测试。没有可执行 Bug 但仍有未解决问题时 BLOCK，不把阻塞当成 Milestone 完成。

## 合入 baseline 与收尾

milestone 整体测试通过后才合入 baseline。merge-integration 仅合并受验版本，先子仓、后伞仓；实际 merge tree 与受验 tree 相同，baseline 包含受验 SHA。伞仓保持受验 gitlink，不追逐子仓实际 merge SHA 或最新 tip。

主 Issue 逐仓记录最终合并事实。尚未开始任何最终合并时，候选失效可回准备并重审重测；已有部分仓合入 baseline 后出现实质问题则保留事实 BLOCK，不自动回滚或整批重复合并。结果未知先查，重试只补未完成仓。

全部最终合并完成后直接 close-milestone，不再安排 baseline 合并后的第二轮测试。收尾仅关闭主/聚合票和 Milestone、记录最终摘要、恢复约定工作状态；不向已关闭的实施/Bug 票补评论，不重复测试或合并。

## 质量与材料

开发自检、单票集成测试、整体集成测试各有明确责任；项目既有质量要求保留，冲突先协调。tester 在初始化授权内部署测试环境，脚本必须证明实际运行源码/制品/服务对应精确版本，不能用旧服务或最新 tip 替代。纯文档执行适用检查，不假称 E2E。环境失败证据与 Judge 只读边界详见合同。

普通证据写伞仓 Issue，handoff 传精确链接；只把复杂长报告放 ignored、未跟踪 run 目录，Issue 登记摘要、版本与路径。不要求 run.md/合同副本，不重复维护节点标签状态机。保护用户改动、hook 后核版本、先子仓推送后伞仓；单例客户端互斥。

公共 persona 只注入 Role Actor，Manager/Judge 独立配置。冻结 YAML 决定当前流程；root delivered 才表示全部交付。新配置只影响新 Run，旧 Run 不自动切换，single 备份不变。AIChat 文档与提示入口的职责划分见[解耦方案](aichatoverview-workflow-decoupling-proposal.md)。配置与受控验证不代表真实多仓 GitHub 合并、测试环境部署或 E2E 已实测。
