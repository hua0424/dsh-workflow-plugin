# coding-workflow-single：单仓完整交付合同

版本：2026-09-20.1；协议：agent-workflow/v3。配置见 [coding-workflow-single.yaml](../example/coding-workflow-single.yaml)。本流程管理单仓 Milestone 多任务串行交付：实施 PR 合入 milestone 分支，集成 PR 合入目标基线，两级都使用 merge commit。

冻结 YAML 定义流程，本合同只解释，不增加验收门槛。项目文档保留编码、质量和授权要求；角色与顺序由当前配置决定。actorCommonPersona 仅覆盖 Role Actor，Manager/Judge 使用各自规则。

## 图与信任边界

| 流程 | 节点 | 结果与后继 |
|---|---|---|
| root | initialize-and-plan（Manager） | ready → run-issue-cycle；cancelled → 返回 cancelled |
| root | run-issue-cycle（Child） | integration-ready → final-review |
| root | final-review（code-reviewer） | approved → close-milestone；changes-required → plan-remediation |
| root | plan-remediation（planner） | planned → run-issue-cycle |
| root | close-milestone（coordinator） | delivered → 返回 delivered |
| issue-cycle | select-next-issue（coordinator） | selected → deliver-one-issue；integration-ready → 返回 integration-ready |
| issue-cycle | deliver-one-issue（Child） | delivered → select-next-issue |
| issue-delivery | implement（developer） | implemented → review |
| issue-delivery | review（code-reviewer） | approved → complete-issue；changes-required → implement |
| issue-delivery | complete-issue（coordinator） | delivered → 返回 delivered |

保持十个节点定义，不增加独立环境或重复裁决节点。Actor/Judge 信任前序已验收结果，只核本节点的职责、当前对象/修订和实际操作结果。complete-issue 与 close-milestone 直接消费 approved handoff，不重读评判审查结论、不自行决定重审，也没有 stale-review 出口；当前操作异常 node_block 交 Manager。

## 初始化、分类与授权

Manager 一次完成范围/验收澄清、授权、主票与必要子票、Milestone、分支身份及计划；初始化要求主 Issue 和 Milestone 开放。本 Run 初始化后，主票因实施或聚合完成而关闭，仍可作为后续集成入口，不另建或重开。计划及主/子票关联同仓 Milestone，记录目标基线、milestone 分支和原始起点；简单任务不制造无意义子票。

任务分为：implementation 实现/修复叶票；aggregate 仅聚合且无独立验收；integration-acceptance 仅主 Issue 的独立集成验收，代码实现仍归叶票。必交集至少一张 implementation。范围移出/取消须有有效授权并保留历史，标签变化或移出 Milestone 不自动改变范围。

父票等待子票和显式依赖一起检查无环；implementation/aggregate 不得等待集成验收主票关闭。依赖含义不清、人工 hold、范围争议交 Manager。planner 只在集成返工时按具体发现创建/复用修复票、更新映射和依赖，不重复规划整项需求。

已有明确授权可沿用；强推、硬重置、绕过保护、部署、扩大范围或子仓交付不因启动本流程自动获准。项目不允许两级 merge commit 时 BLOCK，不擅自切换策略，也不自动删分支。

## 选票独占穷尽判断

select-next-issue 完整分页查询 Milestone（排除 PR）并核对计划，维护有来源的就绪标签和聚合关闭。依赖和子任务满足后自底向上处理 aggregate；人工暂停、撤销授权、needs-info/ready-for-human 等有效限制不得被自动覆盖。

本 Run 已经验收的单票 delivered 证据直接复用，不重新检查历史 PR 代码、测试或审查。外部关闭、来源不明的标签/范围变化不能冒充本 Run 交付，BLOCK 交 Manager。可执行票从当前 milestone 的确切 SHA 建立/复用 feature，领取记录保留原始 baseCommit，不用当前 tip 冒充原始起点。

仅在非空必交集的 implementation 和 aggregate 均已完成、无未解释移出/取消或未分类对象时，才创建/复用 milestone → 基线的集成 PR。剩余待关对象只能为空或已登记的 integration-acceptance 主票；仍有未就绪任务、聚合未完或依赖死锁不能宣称耗尽。

本节点发布并传递 completionSummary（已完成范围、交付证据及穷尽结论）和 pendingClosure（至多一个待集成验收主票），随 integration-ready 交后继。下游不再分页重查必交集、移出历史或各票状态。已知新范围变化交 Manager，不自行扩成另一轮票务巡检。

## 实现、审查与返工

developer 实施当前票、运行适用验证、提交推送 feature → milestone PR，记录实现修订和结果。review 独立审当前实现及本票验收，具体必修项返回 changes-required；无法执行必需验证、缺权限或范围争议 BLOCK，不伪装产品返工。已批准结论绑定 approvedBase/approvedHead，不替代 GitHub 保护要求的人工 approval。

final-review 消费 completionSummary/pendingClosure 和集成 PR，只审集成差异、交互影响、目标基线变化及主票整体验收，复用单票已验收结果，不逐票重审或做票务巡检。通过后将批准修订和原完成/待关清单交 close-milestone；具体集成必修问题交 planner，再进入修复票循环。必需集成验证仍须完成，信任上游不降低本阶段质量要求。

实现返工复用原开放 PR，无代码变化不制造空提交。已经合并的代码需要修复时使用新修复票/PR，保留原交付事实。评论保存发现、处置、范围与验证边界，不把延期登记当修复。

## 证据、工具与环境边界

developer 默认完成实现自检，不重复执行完整双轴 code-review；正式独立审查归 review，用户或项目明确要求的额外审查仍须保留。Judge 核验本节点报告的版本、覆盖范围、发现处置与证据是否一致，不默认重做整套代码审查或全量测试，也不因评论存在就认定事实通过；涉及当前操作的 PR/head/checks 等动态事实按需查询当前状态。

Judge 的只读约束针对操作。inspect 能力不足不代表所有工具不足；实际可见 shell 可用于只读 git/gh 查询，不要求调用不存在的工具。确需 NEED_CONTEXT 时一次列清缺口、已尝试的查询及具体错误，区分工具不可见、操作失败和证据缺失，交 Manager 补证。

同一环境故障首次在主 Issue 记录环境、仓库、基线、用例与失败特征、对照结果、影响范围，以及已有补跑结果/明确例外依据；尚未处理则注明待补证或补跑缺口。后续报告和 handoff 引用该记录，不重复铺陈。新环境、相关变更或失败特征变化时重新归因；基线同样失败不自动豁免，冻结 criteria 仍必须满足。

## 两级合并只管当前操作

complete-issue 和 close-milestone 直接使用 approved handoff 中的对象、修订及操作入口，不重新读取裁决 review 或主动搜索新反证。开放 PR 紧邻合并核对当前身份、base/head、checks/保护和合并条件；修订变化、冲突、权限/检查异常或已知输入问题以 node_block 携当前事实和 handoff 交 Manager，不自行返回审查。

合并前成功发布核验记录，使用工具 head 条件保护执行 merge commit；该条件不原子锁定 base。合并后核验源 head=approvedHead、merge 第一父=approvedBase，目标包含批准 head/merge SHA，实施级还包含实现提交。不匹配或不能证明则如实 BLOCK，不自动回滚或关票。

已合并 PR 重入时按本次合并记录核验并补遗漏收尾，不因目标正常推进重复合并或重审。操作结果未知先查当前 PR；事后记录不能冒充合并前检查，已发生的自动关票须如实记载。

complete-issue 合并到 milestone 后发布本票交付证据、关本票、安全切回 milestone，返回 delivered；不扫描其他票解阻。

close-milestone 合并集成 PR 后只按 approved handoff 的 completionSummary/pendingClosure 收尾：完成指定主票的交付记录与关闭、关闭 Milestone、安全恢复基线。它不再次分页验证全部实施票、不追查移出历史、不重读各票审查；这些属于选票阶段。评论、关票或切换失败保留已成功事实，重入只补未完成操作。

## Issue 记录与生效范围

主 Issue 保存初始化/计划、completionSummary/pendingClosure、集成审查与最终交付；每张实施/修复票保存领取、实现、审查及本票交付。评论标明 runId、阶段、对象/修订和相关链接，PR 留摘要。handoff 保留运行与仓库身份、当前对象/批准入口；进入集成后继续传递完成摘要与待关清单，不假定 Child 自动累计所有历史字段。

普通报告直接写 Issue，无需 run.md、合同副本或本地普通审查文件。复杂长报告才放 ignored、未跟踪 run 目录，Issue 留用途、关键结论、版本与位置；不为不存在的报告预建文件或提交忽略规则。项目长期规格仍按既有文档约定维护。

多行正文使用 --body-file，gh 明确仓库；远端写入结果未知先查询，成功复用、遗漏补齐，不泄露凭据。GitHub 不可用或必要证据缺失 BLOCK。Manager 按有效授权处理阻塞和补证，不代 Judge 宣布通过。

root delivered 表示完成整次交付，cancelled 须有用户明确取消，completed 本身不是业务成功证明。新版只用于新 Run，不改已有冻结定义或历史材料；配置校验不等于真实 GitHub 交付已执行。
