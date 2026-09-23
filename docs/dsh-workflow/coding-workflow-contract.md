# coding-workflow：多仓 Milestone 交付合同

版本：2026-09-23.1；协议：agent-workflow/v3。配置见 [coding-workflow.yaml](../example/coding-workflow.yaml)。本配置只用于伞仓与子仓组成的多仓工作区；单仓使用 [coding-workflow-single.yaml](../example/coding-workflow-single.yaml) 及[对应合同](coding-workflow-single-contract.md)。

本合同解释冻结 YAML，不另加节点或门槛。项目文档保留拓扑、构建、质量与权限，工作流定义角色和执行顺序；公共/角色 persona 放稳定准则，节点描述当前动作。actorCommonPersona 不注入 Manager/Judge，提交协议由插件提供。

## 初始化与统一分支

Manager 核对伞仓及所有子仓的工作区、索引和已有主 Issue/子票，保护用户改动。优先复用已有工单；需要拆票时使用实际可用的 to-tickets，或项目等价的 to-issues。不得虚构技能调用，只有缺少不可替代的必需能力才 BLOCK。

向用户一次确认 baseline、Milestone 名、统一 milestone 分支名及每仓起点。以伞仓所选 baseline 的 gitlink 确定子仓参考起点：子仓没有该 baseline 时从对应 gitlink SHA 建立；已经存在但与 gitlink 不一致时，展示差异由用户确认，不擅自移动已有分支。伞仓 baseline 不存在时先明确创建起点。伞仓与全部子仓都建立并推送统一命名的 milestone 分支，包括未改仓；不修改 .gitmodules 的长期跟踪分支，显式切换临时分支。

全部 Issue/Milestone 只在伞仓 trackerRepo，代码 PR 开在相应 targetRepo。一张实施 Issue 对应可完整验收的功能，可同时涉及多个指定子仓和伞仓，不按仓库强制拆票。所有仓采用 `feature → milestone → baseline`；无差异仓不创建空 PR。所有 PR 使用 merge commit 和 `Implements owner/repo#number`，避免提前自动关票。git 显式路径、gh 显式仓库。

全流程只操作开发测试环境及获准分支，禁止生产部署、生产配置和数据操作。初始化明确环境、精确版本构建/部署方法及 tester 授权；确认 milestone、baseline 的合并及关联自动化不会触发生产操作，否则先 BLOCK 协调。项目开发自检与验收要求仍须满足；与固定顺序冲突的前置要求先协调，不擅自后移或豁免。

## 任务、依赖与信任边界

初始化计划记录功能票集合、每票涉及仓库、验收、开发自检、依赖和测试环境。每票均按完整实现、自测、审查、合入 milestone、独立集成测试顺序执行，通过后立即关闭当前票。仅合并 PR 不算本票完成；手工 close 也不能代替版本、合并记录及验收证据。

本轮实施依赖以前置票验收完成为满足条件；外部依赖、明确的其他验收条件和人工 hold 仍按真实条件处理。不能用更改标签或关闭状态绕过依赖，也不能拆成前后端互等而无法完成本票集成测试的循环。

选票节点独占任务穷尽判定，完整分页核对计划内功能票及新增 Bug 票，排除主/聚合票。仅跳过具有本流程有效验收完成记录且已关闭的票；没有可执行票但仍有未完成工作时 BLOCK，不宣告完成。全部满足才返回 issues-complete，并在主 Issue 保存完成清单。prepare-integration 信任该结果，不重复扫票或重做单票验收。最终发现经 plan-remediation 将 Bug 纳入计划后，循环重新检查新增工作。

下游 Actor/Judge 信任已经验收的上游交接，不重新审上游工作；只核验本节点所操作对象的当前身份、修订及结果。上游成果引用精确链接，实际对象发生漂移仍须按本节点出口处理。

## 路由

| 流程 | 节点 | 结果与后继 |
|---|---|---|
| root | initialize-and-plan（Manager） | ready → run-issue-cycle；cancelled → 返回 cancelled |
| root | run-issue-cycle（Child） | issues-complete → prepare-integration |
| root | prepare-integration（coordinator） | integration-ready → final-review；changes-required → plan-remediation |
| root | final-review（code-reviewer） | approved → verify-integration；changes-required → plan-remediation；stale-review → prepare-integration |
| root | verify-integration（tester） | passed → merge-integration；changes-required → plan-remediation；stale-review → prepare-integration |
| root | merge-integration（coordinator） | merged → close-milestone；stale-review → prepare-integration |
| root | close-milestone（coordinator） | delivered → 返回 delivered |
| root | plan-remediation（planner） | planned → run-issue-cycle |
| issue-cycle | select-next-issue（coordinator） | selected → deliver-one-issue；issues-complete → 返回 issues-complete |
| issue-cycle | deliver-one-issue（Child） | issue-completed → select-next-issue |
| issue-delivery | implement（developer） | implemented → review |
| issue-delivery | review（code-reviewer） | approved → merge-issue；changes-required / stale-review → implement |
| issue-delivery | merge-issue（coordinator） | merged → verify-issue；stale-review → implement |
| issue-delivery | verify-issue（tester） | passed → 返回 issue-completed；changes-required → implement |

不新增环境节点或标签节点状态机。环境/权限故障或证据缺口 BLOCK；正常产品缺陷按所在层次返工，不因 PR 已合并就拒绝修复。

## 每票完整多仓实现与验收

每轮 implement 完成当前 Issue 的全部相关仓实现和项目要求的开发自测。各仓 feature 从获准 milestone 基线创建，先推子仓候选，再由 developer 在伞仓 feature 提交相应精确 gitlink；伞仓指针改动也开 feature → milestone PR。manifest 覆盖完整运行组合，记录各 PR 固定 base/head/tree、未改依赖和 no-change，不静默升级依赖到最新 tip。

review 审查全部本票 PR、接口配合和 gitlink。merge-issue 消费批准，以 merge commit 先子仓、后伞仓，逐仓记录候选与实际合并 SHA/tree、包含关系及实际伞仓 milestone 合并提交；合并不改候选 gitlink、不关票。冲突需改代码或候选失效回 implement 重审；部分合并保留成功事实，未合并 PR 可更新，已合并部分需改则新 PR。操作结果未知先查，网络/权限故障重试或 BLOCK，不重复合并或自动回滚。

verify-issue 按实际伞仓 milestone 提交的 gitlink，在获准开发测试环境构建、部署完整版本组合并独立集成测试，不使用子仓最新 tip 或开发自测结论替代。产品缺陷记录在当前仍开放的 Issue，changes-required 回 implement；已合并代码的修复开新分支/PR，重新审查、合并、测试，不为本票未完成验收另造 Bug。全部必需验收通过后记录结果、关闭当前 Issue，再 passed 返回 issue-completed。关票/收尾重试只补遗漏，不重复合并；环境或部署版本不符先恢复正确版本，无法恢复则 BLOCK。

## 整体候选、审查与测试

全部功能票和新增 Bug 票验收完成后，prepare-integration 准备各仓 milestone → baseline PR 及整体 manifest。正常情况下直接使用各票已经组装好的伞仓 milestone gitlink，不重新追逐子仓 tip。版本集合包含固定 baseline/base/head/tree、集成 PR 或 no-change、全部运行依赖和精确伞仓 milestone 提交。

必要时安全同步 baseline 到 milestone。纯版本同步及其必要 gitlink 对齐仍须推送、重组 manifest、重新整体审查与测试，不能沿用旧验收。需要产品代码处理的冲突或集成缺陷由 changes-required 交 plan-remediation 新建 Bug，coordinator 不代写产品实现。无内容差异仓用固定 baseline SHA/tree 记录 no-change，不制造空 PR；受验依赖仍按伞仓固定版本可达性核验。

final-review 复用单票结论，只审本轮整体差异、跨票/跨仓配合、同步引入的变更及主需求覆盖，不逐票重审。verify-integration 对已经合入 milestone 的精确伞仓提交及其 gitlink 组合执行 Milestone 整体验收，包含跨功能场景与必要回归；测试环境只运行这一组版本。记录源码→制品→服务对应证据，纯文档按适用检查验收，不假称 E2E。

整体测试通过后才允许 milestone → baseline 合并，不再设置另一轮合并后验收。候选本身改变导致批准/测试失效时 stale-review 回 prepare-integration；只是环境部署错版本则先恢复或 BLOCK，不把环境漂移当成新产品缺陷。

## 整体缺陷与 Bug 闭环

集成准备中需代码解决的冲突、整体审查必修项、整体测试产品缺陷，统一交 plan-remediation。每个尚未建票的独立发现新建 Bug Issue，归入同一伞仓 Milestone，记录发现来源、失败版本、复现/依据、涉及仓库、完整修复验收和依赖。Bug 按完整功能修复划分，可跨仓，不机械地每仓一票。

已关闭的原功能票或 Bug 不重开、不追加修复任务或最终收尾评论；新 Bug 可以链接它们作为历史依据。同一发现的重试复用已创建的开放 Bug，不重复建票；已关闭 Bug 再次复发则创建新 Bug 并关联历史。主 Issue 保留发现→Bug 映射和更新后的计划；去重核对发现证据与版本，不只比较标题。纯环境故障不创建产品 Bug。

规划后至少有一张依赖可满足的 Bug 可执行，否则 BLOCK 说明阻塞。Bug 进入同一个 issue-cycle，完整实现、审查、合并、单票测试通过后关闭；全部新增 Bug 完成后重新准备整体候选并进行整体审查/测试。不得仅凭 Bug 已关闭跳过整体验收，也不得恢复已经失效的旧 manifest。

## 证据、工具与环境边界

developer 默认完成实现自检，不重复执行完整双轴 code-review；正式独立审查归 review，用户或项目明确要求的额外审查仍须保留。Judge 核验本节点报告的版本、覆盖范围、发现处置与证据是否一致，不默认重做整套代码审查或全量测试，也不因评论存在就认定事实通过；涉及当前操作的 PR/head/checks 等动态事实按需查询当前状态。

Judge 的只读约束针对操作。inspect 能力不足不代表所有工具不足；实际可见 shell 可用于只读 git/gh 查询，不要求调用不存在的工具。确需 NEED_CONTEXT 时一次列清缺口、已尝试的查询及具体错误，区分工具不可见、操作失败和证据缺失，交 Manager 补证。

同一环境故障首次在主 Issue 记录环境、仓库、基线、用例与失败特征、对照结果、影响范围，以及已有补跑结果/明确例外依据；尚未处理则注明待补证或补跑缺口。后续报告和 handoff 引用该记录。多仓证据绑定 repo、manifest 与验证阶段，不跨版本或阶段套用。新环境、相关变更或失败特征变化时重新归因；基线同样失败不自动豁免，冻结 criteria 仍必须满足。tester 可复用环境事实，但不采纳开发自测结论代替独立验证，不因此免除本票或本轮整体必需验收。

## 按受验版本合入 baseline 与收尾

merge-integration 只消费已批准且整体测试通过的 manifest，先区分已完成与待合并仓。紧邻操作核对待合并 PR base/head、保护和生产边界；按依赖先子仓、最后伞仓，以 merge commit 合回 baseline。实际 merge tree 必须等于受验 tree，baseline 包含受验 SHA；伞仓 gitlink 保持受验子仓 SHA，不追逐实际 merge SHA 或最新 tip。

在主 Issue 逐仓保存最终合并记录，包含 manifest、受验 SHA、实际 merge SHA/tree、PR/no-change、伞仓指针及完成清单。未开始任何最终合并时候选失效可 stale-review 回 prepare，重审重测后再合并。已经部分合入 baseline 后遇实质异常，保留事实 BLOCK 交 Manager；不自动回滚、不将整批退回旧候选。结果未知先查询，重试只补未完成操作，不把本次合并造成的 baseline 前进当作漂移。

close-milestone 消费最终合并记录、完成清单和整体通过结果，只关闭尚未关闭的聚合票、主 Issue 和 Milestone，并在主 Issue 保存最终摘要、恢复约定工作状态。不得向已经关闭的功能/Bug 票补评论或重复关票，不重新审查、测试、合并或改 gitlink。关闭/网络部分失败只补遗漏；缺证据、范围变化或实质问题 BLOCK。

## 证据、工作区与适用边界

主 Issue 保存确认、计划、整体 manifest、整体审查/测试、Bug 映射和最终合并记录；功能/Bug 票在关闭前保存本票实现、审查、合并、测试和完成记录。handoff 传 runId、主 Issue/计划、Milestone、仓库分支表、当前票/manifest/结果链接；不全量复制历史。普通报告直接写 Issue，复杂长报告才存 ignored、未跟踪 run 目录并登记摘要、位置与版本，无需 run.md 或合同副本。

逐仓保护用户文件；本轮预期 gitlink 偏移单独登记，按授权路径暂存。hook 后核对实际分支/SHA，不强制同步、重置或隐藏子仓状态；先推子仓再推引用它的伞仓。单例客户端只由一个执行者驱动，确认实例归属。远端操作结果未知先查事实再补做。

root delivered 表示代码已合入获准 baseline 且开发测试验收完成，不表示生产上线；completed 本身不是交付证明。新配置只影响新 Run，旧 Run 的冻结顺序不自动改变；单仓备份不变。AIChat 文档与提示入口的职责划分见[解耦方案](aichatoverview-workflow-decoupling-proposal.md)，运行前以项目实际版本核对冲突。配置与受控验证不等于真实多仓 GitHub 合并、测试环境部署或 E2E 已实测。
