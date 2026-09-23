# coding-workflow-rapid-multi：多仓单 Issue 快速交付

版本：2026-09-23.1；协议：agent-workflow/v3。配置见 [coding-workflow-rapid-multi.yaml](../example/coding-workflow-rapid-multi.yaml)。适用于伞仓中范围小、验收明确、可由一个 Issue 覆盖的多仓修改；需要分票、分阶段开发或 Milestone 管理时使用 [coding-workflow](coding-workflow.md)。

## 启动与范围

在伞仓根启动，先用 `/dsh-flow list` 校验已安装配置，再 `/dsh-flow start coding-workflow-rapid-multi`。workflowId 由安装文件名决定：当前实际安装的 `coding-workflow-rapid` 是本多仓模板的别名，使用该名称启动时应核对内容与版本；仓库中的 `coding-workflow-rapid.yaml` 仍是独立的单仓模板，不因安装别名而改变。

Manager 初始化确认唯一开放的伞仓 Issue、获准修改仓库、各仓已有基线/起点、开发自检和测试环境集成验收。一个 Issue 可以涉及多个代码仓，不复制工单；范围无法保持简单时交 Manager 选择完整流程，不在本流程临时增加拆票循环。缺基线或分支归属不明先协调，不自行重置已有分支。

每个需修改的代码仓以及需更新指针的伞仓建立任务 feature 分支，PR 直接指向各自基线；仅有 gitlink 更新也属于伞仓变更，必须有伞仓任务分支/PR。未修改依赖只登记固定 SHA，无需新分支或 PR。不创建 Milestone、milestone 分支、子票或选票节点。

本工作流只操作开发测试环境，不得部署生产、修改生产配置或数据。初始化须确认测试环境、部署方法与授权，以及合并目标不会通过 CI 自动触发生产操作；有冲突先协调，不以“仅合并 PR”为由间接操作生产。

## 五个节点

正常路径固定为 initialize → implement → review → merge → verify → 返回 delivered。

| 节点 | 执行者 | 出口 |
|---|---|---|
| initialize | Manager | ready → implement |
| implement | developer | implemented → review |
| review | code-reviewer | approved → merge；changes-required / stale-review → implement |
| merge | coordinator | merged → verify；stale-review → implement |
| verify | tester | passed → 返回 delivered；changes-required → implement |

implement 完成开发自检及项目要求的单元测试、必要回归；review 审查本轮完整候选；merge 合并批准的 PR；verify 在开发测试环境对已合并的完整版本组合进行独立集成测试。不存在免验证捷径，也不再按配置选择两个验证时点。项目既有质量门槛保持不变；与固定顺序冲突的前置要求须由 Manager 先协调，不擅自豁免。

每个 Actor/Judge 信任前序已验收结果，只核验本节点操作的当前对象、修订与结果，不重新跑全流程巡检。公共 persona 保存稳定规则，节点描述当前动作，Manager/Judge 不假定继承 actorCommonPersona。

## 实现时形成完整候选

每轮 implement 面向完整 Issue，一起完成所有相关仓库实现，不是逐仓运行一次节点。developer 按依赖先完成子仓，再在伞仓任务分支提交相应 gitlink，一次交出完整候选和 manifest；本流程没有专用集成准备节点。每个有差异仓的候选 head 包含固定 base，记录 base/head/tree、PR、验收与检查入口；全部实际参与运行的未修改依赖也登记版本。

有修改授权但最终无内容差异的目标仓，用固定 baseline SHA/tree 作为 no-change 候选，不使用未被基线包含的空提交，也不创建空 PR。未改依赖保留原 gitlink SHA，不静默升级到基线 tip；合并时只确认固定依赖提交可获取。伞仓 gitlink 引用确切子仓候选 SHA，提交、审查和后续集成测试对应同一版本组合。

review 审查本次多仓差异及接口配合。集成测试发现产品缺陷后，verify 记录失败版本、复现、实际结果和修复验收，changes-required 返回 implement；Issue 保持开放。返工更新尚未合并的 PR；已合并 PR 不再用作待合并 PR，需要修改时从明确的当前基线创建新的修复分支与 PR。只修改需要修复的仓，但每轮重新形成完整 manifest，经 review → merge → verify，不复用失效的旧批准或测试结论。

## 证据、工具与环境边界

developer 默认完成实现自检，不重复执行完整双轴 code-review；正式独立审查归 review，用户或项目明确要求的额外审查仍须保留。Judge 核验本节点报告的版本、覆盖范围、发现处置与证据是否一致，不默认重做整套代码审查或全量测试，也不因评论存在就认定事实通过；涉及当前操作的 PR/head/checks 等动态事实按需查询当前状态。

Judge 的只读约束针对操作。inspect 能力不足不代表所有工具不足；实际可见 shell 可用于只读 git/gh 查询，不要求调用不存在的工具。确需 NEED_CONTEXT 时一次列清缺口、已尝试的查询及具体错误，区分工具不可见、操作失败和证据缺失，交 Manager 补证。

同一环境故障首次在唯一 Issue 记录环境、仓库、基线、用例与失败特征、对照结果、影响范围，以及已有补跑结果/明确例外依据；尚未处理则注明待补证或补跑缺口。后续报告和 handoff 引用该记录。多仓证据绑定 repo、当前 manifest、合并记录与实际源码/制品版本，不跨仓或跨轮套用。新环境、相关变更或失败特征变化时重新归因；基线同样失败不自动豁免，冻结 criteria 仍必须满足。tester 可复用环境事实，但不采纳开发自测结论代替独立验证，不因此免除本轮必需的集成测试。

## 合并与测试版本

采用 **merge commit**，按依赖先子仓、伞仓最后，不沿用单仓 rapid 的 squash 策略。merge 节点消费 review 批准，紧邻操作核对待合并 PR 的当前 base/head、检查与保护；no-change 核对固定基线 SHA/tree。实际 merge tree 必须等于候选 tree，目标基线包含候选 SHA。merge 不重新做功能测试、不关闭 Issue。

合并时不修改伞仓 gitlink 去追逐新 merge commit 或最新 tip；保留候选子仓 SHA，其被目标基线包含即可。每轮在 Issue 创建或复用合并记录，包含各仓 PR、候选→实际 merge SHA/tree、包含关系、no-change/固定依赖和实际伞仓合并提交。不同修复轮保留各自记录，同轮重试复用既有成功结果。

需要代码修改的合并冲突或候选失效以 stale-review 回 implement，记录失效原因；已有部分仓合并也须保留事实，未合并 PR 可更新，已合并部分需改动则开新修复 PR。网络、权限、操作结果未知等故障先查询实际状态，再重试或 BLOCK，不冒充产品缺陷。重入只补未完成操作，不回滚或重复合并已完成 PR。

tester 根据本轮实际伞仓合并提交及其 gitlink，在初始化已授权的开发测试环境构建、部署并集成测试。源码→制品→服务版本须有对应证据；子仓使用 gitlink 指定 SHA，不能拉最新分支 tip 替代。候选 SHA 与 merge SHA 不同按合并记录的 tree/包含关系解释，不把旧服务或另一轮测试当成本轮验收。

环境或实际部署版本不符时，按授权恢复本轮正确环境再测；缺权限、能力或必需证据则 BLOCK 交 Manager。单纯环境漂移不返回 implement。产品缺陷才 changes-required；全部必需集成验收通过后，tester 记录最终摘要、关闭唯一 Issue、安全恢复约定工作状态并保留用户内容，再 passed 返回 delivered。关票或网络故障只补收尾；同版本、同环境有效的测试证据可复用，不重复合并。

## 材料与边界

初始化、实现/manifest、审查、逐仓合并记录和集成测试报告都记录在伞仓同一个 Issue，PR 用 Implements 完整 Issue 引用及证据链接，避免提前自动关票。handoff 传 runId、Issue、仓库分支表、当前候选与结果入口，合并后附合并记录、实际伞仓提交和环境入口，不重复复制历史。

普通报告直接写 Issue；复杂长报告才存 ignored、未跟踪 run 目录，Issue 留摘要、版本和位置。保护用户文件、按路径暂存、显式指定 git/gh 仓库；单例客户端核对归属并独占使用。

冻结 YAML 是执行依据，新配置只影响新 Run，已有 Run 不自动切换顺序。原单仓 rapid、完整多仓及 single 备份不因本模板而改变。本模板的配置校验或受控测试不代表真实多仓 GitHub 合并、测试环境部署或 E2E 已实测。
