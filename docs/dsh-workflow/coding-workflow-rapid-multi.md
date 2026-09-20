# coding-workflow-rapid-multi：多仓单 Issue 快速交付

版本：2026-09-19.1；协议：agent-workflow/v3。配置见 [coding-workflow-rapid-multi.yaml](../example/coding-workflow-rapid-multi.yaml)。适用于伞仓中范围小、验收明确、可由一个 Issue 覆盖的多仓修改；需要分票、分阶段交付或 Milestone 管理时使用 [coding-workflow](coding-workflow.md)。单仓任务继续使用 coding-workflow-rapid。

## 启动与范围

在伞仓根启动，先用 `/dsh-flow list` 校验已安装配置，再 `/dsh-flow start coding-workflow-rapid-multi`。Manager 初始化确认唯一开放的伞仓 Issue、获准修改仓库、各仓已有基线/起点及验收。一个 Issue 可以涉及多个代码仓，不复制工单；范围无法保持简单时交 Manager 选择完整流程，不在本流程临时增加拆票循环。缺基线或分支归属不明先协调，不自行重置已有分支。

每个需修改的代码仓以及需更新指针的伞仓建立一个任务 feature 分支，PR 直接指向各自基线；仅有 gitlink 更新也属于伞仓变更，必须有伞仓任务分支/PR。未修改依赖只登记固定 SHA，无需新分支或 PR。不创建 Milestone、milestone 分支、子票或选票节点。

## 五个节点

| 节点 | 执行者 | 出口 |
|---|---|---|
| initialize | Manager | ready → implement |
| implement | developer | implemented → review |
| review | code-reviewer | approved → merge；verification-required → verify；changes-required / stale-review → implement |
| verify | tester | passed → merge；changes-required / stale-review → implement |
| merge | coordinator | delivered → 返回 delivered；verification-required → verify；stale-review → implement |

初始化登记 premergeRequired、postmergeRequired 及各自检查范围。verify 通过 handoff 的 verificationStage=premerge/postmerge 复用：需要合并前独立验证时，review → verify → merge；全部仓发布后还需验证时，merge → verify → merge，最后一次仅补关票。无返工正常路径中 verify 执行零次、一次或两次，不增加节点。

premergeRequired=false 时 review 可 approved 进入代码发布，即使 postmergeRequired=true 也不提前关 Issue。项目客户端、全栈、部署就绪等质量门槛保持不变，环境由 Manager 按授权协调。若开 PR 前自检必须依赖同 Issue 尚未合并的后端且不支持候选环境，初始化须协调环境、拆阶段或改用完整流程；合并后验证回边不能解决这个前置阻塞。

每个 Actor/Judge 信任前序已验收结果，只核验本节点操作的当前对象、修订与结果，不重新跑全流程巡检。公共 persona 保存稳定规则，节点描述当前动作，Manager/Judge 不假定继承 actorCommonPersona。

## 实现时形成完整候选

developer 按依赖先完成子仓，再在伞仓任务分支提交相应 gitlink，一次交出完整候选和 manifest；本流程没有专用集成准备节点。每个有差异仓的候选 head 包含固定 base，记录 base/head/tree、PR、验收与检查入口；全部实际参与运行的未修改依赖也登记版本。

有修改授权但最终无内容差异的目标仓，用固定 baseline SHA/tree 作为 no-change 候选，不使用未被基线包含的空提交，也不创建空 PR。未改依赖则保留原 gitlink SHA，不静默升级到基线 tip；发布只确认固定依赖提交可获取。伞仓 gitlink 引用确切子仓候选 SHA，提交、审查和相应阶段测试对应同一版本组合。

review 审查本次多仓差异及接口配合；独立验证从验收标准和对应阶段实际版本设计用例，不用开发自测结论代替结果。缺环境、权限或必需证据时 BLOCK。premerge 阶段且所有仓尚未发布时，产品修复/候选漂移可返回 implement；postmerge 验证失败或版本漂移只能 BLOCK 保留发布事实，不回旧 PR 返工。

## 发布与关闭

采用 **merge commit**，按依赖先子仓、伞仓最后，不沿用单仓 rapid 的 squash 策略。merge 节点紧邻操作核对待发布 PR 的当前 base/head 与批准的 manifest，所需 premerge 验证须已通过；no-change 核对其固定基线 SHA/tree。实际 merge tree 必须等于候选 tree，基线包含候选 SHA；postmerge 测试结果只能在实际执行后记录。

发布时不修改伞仓 gitlink 去追逐新 merge commit 或最新 tip；保留候选子仓 SHA，其被目标基线包含即可。逐仓记录发布结果，同一 manifest 的实际发布映射复用原 publication URL。所有仓完成后，如 postmergeRequired 尚未完成，交 verify 对实际已发布版本验证，Issue 保持 open。通过后回 merge，直接使用原 publication 与对应阶段通过报告关票、恢复工作区，不重发 publication 触发重复验收，也不重复发布代码。

只有所有仓尚未执行最终合并时，候选漂移才能 stale-review 返回 implement。部分仓已合并后遇问题则 BLOCK，保留实际结果；在 merge 重入只补未完成仓、记录或验证后的关票，不回滚、不重复合并、不把整批退回实现。postmerge 失败后的新修复或范围改变由 Manager 安排。

## 材料与边界

初始化、实现/manifest、审查、独立验证和逐仓交付都记录在伞仓同一个 Issue，PR 用 Implements 完整 Issue 引用及证据链接，避免提前自动关票。handoff 传 runId、Issue、仓库分支表、当前候选与结果入口，不重复复制历史。

普通报告直接写 Issue；复杂长报告才存 ignored、未跟踪 run 目录，Issue 留摘要、版本和位置。保护用户文件、按路径暂存、显式指定 git/gh 仓库；单例客户端核对归属并独占使用。

冻结 YAML 是执行依据，新配置只影响新 Run。原 rapid、完整多仓及 single 备份不因本模板而改变。本模板的配置校验或受控测试不代表真实多仓 GitHub 交付、部署或 E2E 已实测。
