# coding-workflow：GitHub Milestone 与 Issue 跟踪合同

版本：2026-09-18.3；协议：agent-workflow/v3。适用于单仓、Milestone 多任务串行交付：实施 PR 合入 milestone 分支，集成 PR 合入目标基线，两级均使用 merge commit。

本合同解释配置；实际节点、结果和验收条件以本 Run 冻结的 YAML 为准。YAML 自足，不要求先读取本合同、运行 setup 或创建本地台账。其他工作流不继承这里的角色和节点约定。项目既有 GitHub issue-tracker、长期规格、CONTEXT/ADR 等约定继续使用。

## 权威与跟踪入口

- 用户授权、主 Issue 规格和明确采纳的澄清决定范围。初始化评论记录本次验收与不做事项；新评论不自动扩大授权。
- GitHub Milestone 表示任务集合与里程碑状态；主 Issue 保存初始化、计划索引、范围变更、集成审查和最终交付。初始化与首次计划可合为一条评论，两个交接入口可指向同一 URL；ready 必须同时满足初始化和规划验收，主票及本轮子票均关联同仓 Milestone。主 Issue 已关闭仍可作为跟踪入口，不因此另建或重开。
- 每张实施/修复 Issue 保存领取与分支身份、实施证据、审查和合并评论；PR 只保留必要摘要及评论链接，保留用户正文和历史。
- Issue 评论提供人工可读证据；插件冻结定义、工作单和 Judge 判定负责推进。评论不能替代 claim，也不能单凭自述证明外部操作成功。
- 无需 run.md、合同副本、delivery.md、每轮 review/decision 文件或 completion.md。本地文件不存在不构成阻塞；长报告按需处理，见下节。
- actorCommonPersona 只注入 Role Actor system；Manager 与 Judge 使用各自规则。合并后的 Manager 节点在 instruction 和 criteria 中自足定义范围、任务分类、依赖、记录与出口条件，不依赖 planner persona 或公共 persona。角色 persona 承载稳定职责，instruction 给出当前动作，共同及结果 criteria 保留实际验收条件。

## 评论与长报告

评论标题标明 workflowId、真实 runId、节点/阶段，审查注明轮次和对象。先按 handoff 的精确链接读初始化、当前计划及对象证据，再定向读取相关新信息；入口不全时按 runId/对象分页检索。少量最近评论不能证明全部历史或任务范围已查全。

| 位置/阶段 | 最少内容 |
|---|---|
| 主 Issue 初始化 | 仓库及 workspace、Milestone/主 Issue URL、授权与规格、验收及不做范围、baseBranch/milestoneBranch、创建时基线 SHA、merge commit 策略、合同版本 |
| 主 Issue 计划索引 | 任务 URL、分类、父子关系、依赖、验收归属、有效授权/hold；新增修复票映射及获准移出/取消依据；关联各票原始分支起点记录 |
| 实施 Issue 领取 | 初始化/计划链接、featureBranch/milestoneBranch、原始 baseCommit、归属与创建/复用依据 |
| 实施 Issue 实现 | PR/base/head/实现 SHA、验收覆盖、自测命令/结果/对象 SHA、未测边界、旧必修项处置 |
| 对应 Issue 审查 | 轮次、PR/base/head/mergeBase、范围及方法、复用证据、发现 ID/依据/处置、必修清单或 approvedBase/approvedHead、验证/延期边界 |
| 主 Issue 集成准备 | 完整任务核对依据、集成 PR/base/head、范围及待集成验收项 |
| 对应 Issue 批准失效 | 原批准链接、修订变化或未覆盖的新失败验证/实质反证、失效原因及远端现状 |
| 对应 Issue 合并前核验 | 批准链接及 approvedBase/approvedHead、检查时间、必要 CI/保护证据或不适用依据、merge commit 策略 |
| 对应 Issue 交付 | 合并前证据、源 head/merge SHA/实际起点及目标包含关系、远端状态、验证与延期边界 |
| 主 Issue 澄清/BLOCK | 问题、事实、决定/授权；Manager 补证的来源、对象/SHA、时间及关键结果 |

计划索引保留范围与依赖事实，不重复维护实时 PR/CI/Issue 状态；副作用前查询远端。原始 baseCommit 不可被当前 tip 覆盖。更新计划保留历史与授权来源，不能静默移除任务。

“必交集”指用户最新有效授权要求本轮交付的任务集合，是选票穷尽与最终全部完成的核验范围。获准移出/取消的票保留历史及依据，不计入必交集；仅改标签或移出 Milestone 不构成授权。集合变更须同步验收归属、依赖和聚合子票范围，不能留下无归属验收或隐性等待。仍须至少有一张 implementation；必交集中没有实施票时 BLOCK，不伪造 delivered。

发布前查询相同节点执行、修订、输入和结论的记录；完全一致的重入可复用。新修订、证据或结论追加评论并链接被替代记录，保留旧批准。写入超时/结果未知先查远端，避免重复资源或评论。多行正文用临时文件和 `--body-file`，明确 owner/repo、采用非交互参数；临时传输文件不充当台账。评论成功取得 URL 后再交接。GitHub 不可用时 BLOCK，发布不了阻塞评论则先保留失败事实，恢复后补记。

普通报告直接写 Issue。确需长篇复杂报告时，使用当前 workspace 的 ignored `docs/dsh-workflow/runs/<runId>/` 或初始化已指定目录；真正写文件前确认在仓库内、目标已 ignore 且未 tracked，不预建空报告或为尚不存在的报告提交忽略规则。developer 可在任务分支最小补充必要忽略规则并纳入审查；其他角色使用 Issue 分段记录或交 Manager 安排。新增提交改变 head，旧批准随之失效。

Issue 须保留报告用途、关键结论和验证边界，并登记适用修订/轮次、workspace、绝对/仓库相对路径和 SHA256。哈希不能替代内容或证明结论。本地路径不能在异机下载；当前节点确需全文却不可读时请求传递或补证，无需全文则不因路径不可读阻塞。不强制 add、取消跟踪或清理报告，不写凭据和未脱敏敏感日志。

## 图与职责

| 流程 | 节点 | 结果与后继 |
|---|---|---|
| root | initialize-and-plan（Manager） | ready → run-issue-cycle；cancelled → 返回 cancelled |
| root | run-issue-cycle（Child） | integration-ready → final-review |
| root | final-review（code-reviewer） | approved → close-milestone；changes-required → plan-remediation |
| root | plan-remediation（planner） | planned → run-issue-cycle |
| root | close-milestone（coordinator） | stale-review → final-review；delivered → 返回 delivered |
| issue-cycle | select-next-issue（coordinator） | selected → deliver-one-issue；integration-ready → 返回 integration-ready |
| issue-cycle | deliver-one-issue（Child） | delivered → select-next-issue |
| issue-delivery | implement（developer） | implemented → review |
| issue-delivery | review（code-reviewer） | approved → complete-issue；changes-required → implement |
| issue-delivery | complete-issue（coordinator） | stale-review → review；delivered → 返回 delivered |

Manager 在 initialize-and-plan 一次完成澄清、授权、仓库/Milestone/分支身份、主票和子票的创建或复用、分类与依赖规划，并处理 BLOCK；planner 仅负责集成返工的修复规划；developer 实施、自测并维护实施 PR；独立 code-reviewer 发现问题并逐项决定本次修复、延期或不成立；coordinator 负责选票、分支/PR 和合并收尾。专业审查合并原两级 decide-pr，不另设裁决或预留 tester。插件 Judge 仍独立核验出口合同，不等于另一轮专业代码审查。

清晰范围沿用已有授权，不重复确认；缺范围或授权时澄清。授权内可创建/复用相关资源、推送任务分支、满足条件后合并关票。强推、硬重置、绕过保护、部署、擅自扩大范围不属默认授权；本配置仅支持单仓，涉及子仓改动或跨仓交付时 BLOCK，由用户选择适用工作流。两级 merge commit 不被仓库允许时 BLOCK，不自动换合并方式；不自动删分支。

## 计划与任务选择

任务分类：

- implementation：本轮必须完成的实现或修复叶任务；简单任务可直接使用主 Issue，不另建无意义子票。
- aggregate：只有聚合责任、无独立验收的父票；按获准变更后的子票范围核验，全部必交子任务及自身显式依赖满足、无未结事项后可关闭。
- integration-acceptance：仅用于主 Issue，须列明独立集成验收及证据入口。全部实现必须拆入 implementation，不能隐藏待实现代码。

Manager 初始化计划，planner 在集成返工时增补主 Issue 计划索引，检查覆盖、归属、分类和依赖。在同一等待图中检查“聚合父票等待子票”与显式 Blocked by 边无环，分别检查两类关系无环不足以排除交叉死锁。implementation/aggregate 不得依赖集成验收主票的关闭。依赖含义不清、人工暂停或范围争议交 Manager，不按猜测放行。

选票节点集中维护工作流负责的就绪标签和聚合关闭：完整分页查询 Milestone 记录并排除 PR，与计划索引逐项核对；依赖及子任务满足时自底向上关闭 aggregate，再核对已授权 implementation 的就绪状态。只修复有来源的工作流标签；人工 hold、撤销授权、needs-info/ready-for-human 等有效限制优先，不能因依赖关闭就覆盖。普通关票节点不再重复扫描解阻标签。

选取 open、implementation、就绪且依赖满足的叶票；多候选按依赖优先级再按编号升序串行处理。从当前 milestone 的确切 SHA 建立或核验 feature 分支，领取评论保存原始 baseCommit。复用前核对原始记录、归属和祖先关系，缺失时 BLOCK，不把当前 tip 追认为原始起点。

无候选时，只有必交集中至少一个 implementation 且全部关闭、aggregate 全部关闭、无未解释移出/取消或未分类项，才进入集成准备；必交集剩余开放票只能为空或已登记的 integration-acceptance 主 Issue。Milestone 此时仍须 open。查询不完整、仍有未就绪实施票或聚合票未关闭均 BLOCK；记录超过 100 应继续分页，不是失败条件。

同一次选票执行在任务耗尽时创建/复用 milestone → 基线的开放集成 PR，记录完整范围和待集成验收项，返回 integration-ready，不再派独立 integrate-milestone。集成验收不提前当作任务耗尽的条件。集成发现必修问题时，plan-remediation 按审查轮次/发现 ID 创建或复用同 Milestone 的修复票，更新计划映射并重入选票；不擅自重开已关闭主 Issue或扩大到非阻断优化。

## 审查、返工与批准失效

首次审查完整验收和确切 PR diff；后续可引用可追溯旧证据，但须复核旧必修项、变化与交互影响，无法证明覆盖则完整审查。集成审查无论实施票多少均保留，补查目标基线变化、完整范围、合并差异、主 Issue 独立验收及必要集成回归。旧实施 PR 批准不能跨 PR 复用为集成批准。

审查评论合并发现与处置：逐项记录本次修复、延期或不成立及理由。只有无未解决必修项且必需验证齐全才记录 approvedBase/approvedHead 并返回 approved；明确、可执行的范围内必修清单返回 changes-required。延期需记录影响、必要授权与后续入口，不把登记当修复。技术、权限、证据缺口或范围争议用 BLOCK，不伪装成产品返工。

审查轮次从 r001 递增；修订、反证、验证材料或结论变化开新轮，即使 SHA 未变。提交审查结果前后复核修订，漂移时追加失效事实，不交旧批准。内部 approved 不替代 GitHub 保护要求的人工 approval。

实现返工复用同一开放实施 PR；无须代码变动时可复用 head，不制造空提交。返工必须逐项修复或提供具体反证，reviewer 独立核实。集成返工经修复票交付后重新审查集成 PR。

## 两级合并与重入

coordinator 先区分 PR 现状：

- 开放 PR：base/head 与批准不一致，或出现批准未覆盖且与既定验收相关的新失败验证/实质反证时，登记批准失效并以 stale-review 回本对象的审查，保持未合并、未手动关票；同 SHA 也交接反证链接。普通进度评论不触发重审。缺批准、检查未完成、无可核验原因的技术性检查失败、权限/保护缺口用 BLOCK。
- 已合并 PR：读取当时批准、合并前证据和实际合并事实，只补遗漏收尾。正常合并推动目标 tip 不使已合并 PR 重新审查；事后检查不能冒充合并前证据。

合并前先成功发布核验评论，紧邻操作再次查询 base/head，以工具提供的 head 条件保护执行 merge commit，保留仓库保护。head 条件不原子锁住 base，不能宣称消除并发窗口。操作超时或结果未知先查远端，不盲目重复。

合并后核验 merge SHA 第一父节点等于 approvedBase，合并源 head 等于 approvedHead，远端目标包含批准 head/merge SHA（实施 PR 同时核验实现提交）。不匹配或无法证明则记录事实并 BLOCK，不自动回滚、不手动关票；若 GitHub 已自动关票，记录实际副作用。

核验通过后先发布交付证据，再关闭本 Issue；已关闭则核对本次归属及关闭依据复用。实施交付安全切回并快进 milestone。最终交付还须覆盖集成验收主票的全部验收、必要时关主票、分页确认必交集全部关闭且获准排除项依据完整，再关闭 Milestone 并安全切回基线。任何评论、关票或本地切换失败都保留已发生远端事实，重入只补缺失步骤，不能重复合并。

## Handoff、Judge 与已有运行

handoff 简短但自足：workflowId/runId、仓库/workspace、主 Issue/Milestone、初始化与最新计划链接；当前 Issue/PR、原始分支起点、base/head；精确证据/批准评论链接、所选结果依据及后续约束。子流程只自动传前驱交接，不假定会累计此前字段。普通文件路径不是固定入口。

提交协议使用插件统一注入的工具说明；命名结果必须属于当前冻结节点。Child 的 onReturn 显式映射推进，不从文本猜返回值。REJECT 是原节点内修正，只有 changes-required 被 ACCEPT 才进入业务返工。Judge 按共同与所选结果 criteria 独立核验；评论只是事实入口，不把 Actor 自述当独立证据。

Manager 补证在相关 Issue 记录可追溯的只读查询来源、对象/SHA、时间、关键结果及分页依据，并用 node_resume.resolutionContext 传关键事实和链接。有有效 claim 时补证恢复 Judge；不代替 Judge 宣布通过。Manager 自己是 Actor 时仍需可信的独立来源。

root delivered 表示完整交付，cancelled 要有用户明确取消及资源现状/清理约束。初始化前取消不要求尚未创建的远端资源或本地文件；已有入口则记录取消摘要，不自动删除资源。执行状态 completed 不单独表示已交付。

新版仅供新 Run；不改活动 Run 冻结定义、原合同和历史材料，不迁移或删除旧 run.md。文档版本或哈希不是内容快照，有可重现 Git commit/blob 时可附永久链接；执行门槛已经写入冻结 YAML，不再按运行复制合同。
