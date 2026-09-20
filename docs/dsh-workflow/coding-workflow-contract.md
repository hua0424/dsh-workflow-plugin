# coding-workflow：多仓 Milestone 交付合同

版本：2026-09-19.2；协议：agent-workflow/v3。配置见 [coding-workflow.yaml](../example/coding-workflow.yaml)。本配置只用于伞仓与子仓组成的多仓工作区；单仓使用已实测的 [coding-workflow-single.yaml](../example/coding-workflow-single.yaml) 及[对应合同](coding-workflow-single-contract.md)。

本合同解释冻结 YAML，不另加节点或门槛。项目文档保留拓扑、构建、质量与权限，工作流定义角色和执行顺序；公共/角色 persona 放稳定准则，节点描述当前动作。actorCommonPersona 不注入 Manager/Judge，提交协议由插件提供。

## 初始化与统一分支

Manager 核对伞仓及所有子仓的工作区、索引和已有主 Issue/子票，保护用户改动。优先复用已有工单；需要拆票时使用实际可用的 to-tickets，或项目等价的 to-issues。不得虚构技能调用，只有缺少不可替代的必需能力才 BLOCK。

向用户一次确认 baseline、Milestone 名、统一 milestone 分支名及每仓起点。以伞仓所选 baseline 的 gitlink 确定子仓参考起点：子仓没有该 baseline 时从对应 gitlink SHA 建立；已经存在但与 gitlink 不一致时，展示差异由用户确认，不擅自移动已有分支。伞仓 baseline 不存在时先明确创建起点。伞仓与全部子仓都建立并推送统一命名的 milestone 分支，包括未改仓；不修改 .gitmodules 的长期跟踪分支，显式切换临时分支。

全部 Issue/Milestone 只在伞仓 trackerRepo，代码 PR 开在相应 targetRepo。跨仓需求拆为关联叶票，每叶票只实施一个代码仓。所有仓采用 `feature → milestone → baseline`；无差异仓不创建空 PR。所有 PR 使用 merge commit 和 `Implements owner/repo#number`，避免提前自动关票。git 显式路径、gh 显式仓库。

## 任务、依赖与信任边界

初始化计划记录实施清单、每票目标仓、验收标准、开发检查和是否需要独立合并前验证。所有实施票合入 milestone 后记 code-integrated，仍保持 open，最终发布与验收全部完成后统一关闭，不再配置 closeGate。

本轮实施依赖以前置票 code-integrated 满足，不等待最终关票。外部依赖、明确要求验收完成的依赖和人工 hold 仍按其真实条件处理。Manager 在初始化解决“后续实现等待最终关票、最终验收又等待后续实现”的闭环；不能用修改标签绕过。

选票节点独占任务穷尽判定，完整核对当前必交集与本轮集成状态，跳过已 code-integrated 票；全部完成才返回 code-complete。prepare-integration 信任该结果，不重复扫 Issue 或检查剩余任务，没有 work-remaining 出口。范围变化交 Manager，不由下游自动重扫和扩展。

下游 Actor/Judge 信任已经验收的上游交接，不重新审上游工作；只核验本节点所操作对象的当前身份、修订及结果。上游成果引用精确链接，实际对象发生漂移仍须按本节点出口处理。

## 路由

| 流程 | 节点 | 结果与后继 |
|---|---|---|
| root | initialize-and-plan（Manager） | ready → run-issue-cycle；cancelled → 返回 cancelled |
| root | run-issue-cycle（Child） | code-complete → prepare-integration |
| root | prepare-integration（coordinator） | integration-ready → final-review |
| root | final-review（code-reviewer） | approved → verify-integration；changes-required → plan-remediation；stale-review → prepare-integration |
| root | verify-integration（tester） | passed → publish-integration；changes-required → plan-remediation；stale-review → prepare-integration |
| root | publish-integration（coordinator） | published → close-milestone；stale-review → prepare-integration |
| root | close-milestone（coordinator） | delivered → 返回 delivered |
| root | plan-remediation（planner） | planned → run-issue-cycle |
| issue-cycle | select-next-issue（coordinator） | selected → deliver-one-issue；code-complete → 返回 code-complete |
| issue-cycle | deliver-one-issue（Child） | code-integrated → select-next-issue |
| issue-delivery | implement（developer） | implemented → review |
| issue-delivery | review（code-reviewer） | approved → complete-issue；verification-required → verify-issue；changes-required → implement |
| issue-delivery | verify-issue（tester） | passed → complete-issue；changes-required → implement；stale-review → review |
| issue-delivery | complete-issue（coordinator） | code-integrated → 返回 code-integrated；stale-review → review |

不新增环境节点或标签节点状态机。需要环境/部署时由 Manager 按有效授权及项目技能准备，恢复对应单票或集成验证节点；缺环境、权限、证据用 BLOCK，产品必修问题走 changes-required。

## 候选、审查与验证

prepare-integration 固定各子仓 milestone head，在伞仓 milestone 提交引用这些 SHA 的 gitlink，准备各仓 milestone → baseline PR。候选提交先于审查和测试。manifest 每仓记录固定 base/head/tree，候选 head 包含固定 base；必要时安全同步基线，冲突交 Manager。无内容差异仓以固定 baseline SHA/tree 作为 no-change 候选，不制造空 PR，也不把尚未被 baseline 包含的 milestone 空提交当作已发布版本。

版本集合覆盖所有参与构建/运行的仓库，包括未改依赖、各仓 PR 或 no-change、伞仓 gitlink、源码与制品/环境映射。整体代码审查通过后独立集成测试，不仅检查伞仓指针 diff。tester 按验收与精确版本独立建立用例矩阵，不以开发自检结论代替独立结果。

保留项目质量要求：需要真实客户端开发自检时，自检通过才开 PR；独立合并前验证按计划执行；集成验证必经。server/plugins 运行时变更若要求部署就绪和独立 E2E，必须以实际版本和真实结果为证。纯文档执行适用检查，不假称运行验证。仅支持跟踪 tip 的部署脚本不能证明 milestone 候选通过，能力不足交 Manager；配置本身不授予部署权限。

## 按受验版本发布与统一收尾

publish-integration 先区分已完成与待发布仓：已合并 PR 按原批准核验本次合并结果、补记遗漏；紧邻每个待发布仓的操作才核对当前 PR base/head，待确认 no-change 仓核对固定 baseline SHA/tree。按依赖发布所有子仓 PR，伞仓最后。每个实际 merge tree 必须等于该仓受验 head tree，目标 baseline 包含受验 head。伞仓 gitlink 始终保持测试过的子仓 SHA，不在发布时改指针追逐 merge commit；baseline 包含受验 SHA 即可，gitlink 不要求等于合并后的 tip。

发布记录为不可覆盖的 publication，逐仓保存源 SHA、实际 mergeSHA/tree 或 no-change、结果与时间。多仓发布非原子：部分成功后重入只补未完成仓，不能回滚或重复已完成发布。只有尚无仓发布时才允许 stale-review 回 prepare；一旦有仓已合并，漂移或实质问题 BLOCK 交 Manager，保留事实，不回到旧候选。

全部发布完成后 close-milestone 使用 publication 统一关闭实施/聚合/主票和 Milestone，完成评论及工作区恢复。它不重新审查上游、不补 Git 发布，也不更新 gitlink；发布后目标正常推进不触发重审或再次合并。缺 publication、范围变化或实质交付问题用 BLOCK。关闭或网络部分失败只补未完成收尾。

## 证据、工作区与适用边界

主 Issue 保存确认、计划、版本集合、整体审查/测试和 publication；实施票保存本票实现、审查、验证、code-integrated。评论绑定 runId、完整仓库身份、修订和前序链接，handoff 传当前阶段必需入口；不全量复制历史。普通报告直接写 Issue，复杂长报告才存 ignored、未跟踪 run 目录并在 Issue 登记摘要、位置与版本，无需 run.md 或合同副本。

逐仓保护用户文件；本轮预期 gitlink 偏移单独登记，按授权路径暂存。hook 后核对实际分支/SHA，不强制同步、重置或隐藏子仓状态；先推子仓再推引用它的伞仓。单例客户端只由一个执行者驱动，确认实例归属。远端操作结果未知先查事实再补做。

root delivered 表示全部交付，completed 本身不是交付证明。新配置只影响新 Run；单仓备份不变。AIChat 旧 AGENTS/persona 尚未按此迁移，既有权限冲突按[解耦提案](aichatoverview-workflow-decoupling-proposal.md)处理。配置与受控验证不等于真实多仓 GitHub 交付、部署或 E2E 已实测。
