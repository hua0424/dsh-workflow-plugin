# coding-workflow-rapid：GitHub Issue 跟踪合同

版本：2026-09-18.4；协议：agent-workflow/v3。仅供显式采用本合同的快速流程参考。单仓、单 Issue、单 PR、四节点；启动前已有规格与验收，不负责拆票或管理 Milestone。

本版遵循 [Matt Pocock GitHub tracker 模板](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md) 的选择：规格和任务放 GitHub Issues，用 gh 管理。项目已有 AGENTS/CLAUDE 中的 issue-tracker 指针继续有效，不重跑 setup、不另建本地工单；项目长期 CONTEXT/ADR/设计文档仍按原约定维护。

## 权威与入口

- Issue 正文和明确授权的澄清定义任务；本 run 初始化评论记录采用的验收/不做范围及授权。新评论不自动扩大范围，冲突交 Manager 处理。
- Issue 评论是人工可读的进度、证据、审查和交付记录；插件冻结配置、工作单与 Judge 判定仍负责流程推进。评论不能替代 claim，也不能证明外部动作已经成功。
- handoff 传 Issue URL、真实 runId、初始化评论 URL、当前证据评论 URL、PR/确切修订、结果与后续约束。长报告按需附路径，不要求本地运行入口。
- 不要求 run.md、合同副本、每轮本地审查文件或 completion.md；没有这些文件不是 BLOCK 理由。YAML 已承载执行所需规则，本合同只解释，不给 Judge 新增门槛。
- actorCommonPersona 只注入 Role Actor system；Manager/Judge 的独立规则保留。初始化评论记录合同版本，若有可重现 Git commit/blob 可附永久链接；版本或哈希不等于内容快照，不再为每次运行复制文档。

## 评论如何组织

每条本流程评论用可见标题标明 workflowId、真实 runId、节点/阶段；能取得 executionId 时可附上，但不新增工具必填参数。Issue 可以有其他讨论或历史 run，不能把最后一条评论直接当作当前结论。

| 阶段 | Issue 评论最少内容 |
|---|---|
| 初始化 | 仓库/workspace、Issue、规格入口、本次验收与不做范围、目标/任务分支、原始 baseCommit、合并方式、授权依据、跟踪约定版本 |
| 实现/返工 | 初始化和上轮审查链接、PR/base/head/实现 SHA、验收覆盖、命令/结果/对象 SHA、未测边界、逐项修复或反证 |
| 审查 rNNN | 实现和上一轮审查链接、PR/base/head/mergeBase、范围/方法、验收与验证覆盖、发现 ID/依据/处置、必修清单或 approvedBase/approvedHead、延期边界 |
| 批准失效 | 原批准评论、新旧 base/head、新失败验证/实质反证链接（如有）、失效原因、未合并/未关票的事实 |
| 合并前核验 | 批准评论、approvedBase/approvedHead、合并方式、核验时间、必要 checks/保护证据或不适用依据 |
| 交付 | 合并前核验链接、mergeCommit/源 head/实际起点及目标包含证据、验证/延期边界、PR 和 Issue 状态 |
| BLOCK/澄清 | 缺口、事实依据、所需决定；Manager 补证含查询来源、对象/SHA、时间与关键结果 |

评论链接串起相关证据，不维护另一份可变本地台账。PR 只放必要交付/审查摘要及对应 Issue 评论链接，保留正文与历史；不要求两个地方复制同一份完整报告。

按 handoff 的精确评论链接先读必要证据，再读与任务有关的新澄清；链接不足时按 runId/节点定向分页检索，工具输出只保留相关内容，不一次倾倒全部历史。最近 3–5 条可用于发现新进展，但不是“完整历史”的证明。

发布前检查同一节点执行、同修订、同输入/结论的记录是否已存在，完全一致的重入才复用；评论写入超时/结果未知时先查询远端，不能盲目重复。新证据、修订或结论追加新评论并引用被替代记录，不覆盖原批准历史。首次审查 r001；修订、反证、验证材料或结论变化开新轮，即使代码 SHA 未变。

多行评论/PR 正文先写临时文件，通过 --body-file 发布；临时传输文件不充当长期跟踪记录。gh 显式指定 owner/repo、采用非交互参数；先确认评论发布成功并取得 URL，再提交节点结果。远端记录不贴凭据或未脱敏敏感日志。GitHub 不可用时 BLOCK，不将本地草稿冒充远端留痕；阻塞评论无法发布时将失败事实放入阻塞原因，恢复后补记。

## 本地长报告：按需创建

短进度、自测摘要、普通审查和批准直接写 Issue。只有确需长篇复杂报告、详细实验/诊断记录等才写本地文件，不预建目录或空报告。

默认目录为当前 workspace 下 docs/dsh-workflow/runs/<runId>/，也可采用初始化评论已明确的项目目录。首次真正落文件前验证路径位于本仓库，git check-ignore 对目标文件生效，git ls-files 确认未跟踪；已跟踪文件不擅自取消跟踪。不为尚不存在的报告创建 .gitignore 提交。

developer 可在任务分支最小补充确有必要的忽略规则，复核后纳入实现；reviewer/coordinator 不为报告修改实现或创建代码提交，未忽略时可用 Issue 分段报告或请 Manager 安排。报告产生的新提交改变 head，旧批准必须失效。

每个本地报告在对应 Issue 评论登记：

- 报告用途、关键结论、适用 PR/base/head 和审查轮次（如有）。
- 所在 workspace、绝对路径和仓库相对路径、内容 SHA256。
- 说明文件仅在该工作区可用；哈希用于识别内容，不能替代内容或证明结论。

远端评论须独立保留关键发现、处置、批准修订和验证边界，不能只写“详见本地文件”。换机器后，本地路径不是可下载链接；当前节点无需全文时不为此阻塞，确需原始全文却不可读时请求传递材料或补证。文件不进 PR、不强制 add、不擅自清理，不记录凭据。正式规格和长期设计仍放项目规定位置，不当运行附件处理。

## 四节点与职责

| 节点 | 结果 | 后继 |
|---|---|---|
| initialize（Manager） | ready | implement |
| implement（developer） | implemented | review |
| review（独立 reviewer） | approved | merge |
| review | changes-required | implement |
| merge（coordinator） | stale-review | review |
| merge | delivered | 返回 delivered |

启动授权范围内实现、推送、创建/更新指定 PR、满足条件后合并和关闭此 Issue；已有明确授权/项目默认目标可沿用，缺失或冲突澄清。强推、硬重置、绕过保护、部署、扩大范围/拆票/子仓改动不在授权内。项目合并规定优先，无规定用 squash；不自动删分支。

初始化先核对 GitHub 仓库、Issue、子票/未解决依赖、验收和授权，再检查干净工作树、fetch 目标 SHA，建立/核验复用任务分支与原始起点，最后发布初始化评论。其他 run 的同名分支/PR 不自动认领，身份不明 BLOCK。初始化不为跟踪创建本地文件或忽略提交。

developer 使用 implement，按需 tdd/diagnosing-bugs；reviewer 使用 code-review，纯文档/注释小改可直接执行。技能产物遵循本流程的 Issue 跟踪方式，不额外要求本地票据；技能不能扩大授权或替代独立审查。必需技能/验证能力缺失须说明并处理，不虚构执行成功。

implemented 表示实现交付与证据可供核验，不等于审查批准。旧必修项逐项修复或给具体反证，reviewer 必须核实；无代码变更可复用 head，不制造空提交。必需验证无法执行/证据无法取得用 BLOCK，不伪装成产品返工。

## 审查与合并

首次审查完整验收和 PR diff；后续可复用可追溯证据，但须补查所有变化与交互影响，无法确认覆盖则完整审查。范围内明确缺陷进入 changes-required；技术/权限/证据缺口或范围争议 BLOCK。延期记录影响、必要授权和后续入口，不把登记当修复。

Issue 审查评论中只有无未解决必修项且必需验证齐全才记录 approvedBase/approvedHead；返工、后续推翻结论，或出现与既定验收相关且批准未覆盖的新失败验证/实质反证，使旧批准失效，即使 SHA 不变。普通进度评论不触发重审。内部 approved 不代替仓库要求的 GitHub 人工 approval。发布前后复核修订，变化则追加失效说明，不提交旧批准。

coordinator 先区分 PR 是否已合并：
- 开放 PR：当前 base/head 偏离原批准，或有既定验收内的新失败验证/实质反证未被有效批准覆盖时，发布失效评论并以 stale-review 回审查，不合并关票；同 SHA 也须交接新证据链接。缺报告/冲突/检查待完成、无可核验原因的技术性检查失败/保护不满足则 BLOCK；有明确新失败验证需重新判断既定验收时走重审。范围变更仍由 Manager 澄清，不借重审扩大授权。
- 已合并 PR：读取当时批准、合并前核验和实际合并记录，只补未完成收尾；不能因正常合并推进了目标 tip 而重审已合并 PR，也不能用事后检查冒充合并前证据。

合并前核验评论必须先成功发布，再紧邻合并重新读取 base/head，使用工具提供的 head 条件保护。head 条件不原子锁住 base；保留仓库保护，不声称消除并发窗口。发现变化则追加失效事实；实际操作结果不明先查远端，不重复执行。

合并后主动核验实际合并起点等于 approvedBase：squash/merge 查 mergeCommit 第一父节点，rebase 用可追溯提交链或可靠远端证据；再核验目标包含 mergeCommit，merge 方式额外要求包含批准 head。不能证明或不匹配则记录事实并 BLOCK，不自动回滚或手动关票；GitHub 自动关票如实记载，不伪称无副作用。

核验成功后先发布交付评论，再关闭 Issue；已自动关闭则核验复用。安全切回并快进目标分支，工作树干净后 delivered。评论/关票/本地切换失败保留远端事实，恢复只补遗漏动作。

## Judge 与已有运行

Judge 按冻结共同/所选结果 criteria 独立查询核验，Issue 评论只是证据入口。Manager 补证在 Issue 追加可追溯只读查询记录，并将关键事实及评论 URL 传 node_resume.resolutionContext；单纯重复 Actor 自述或宣布通过不是独立证据。

新 YAML/本合同只供新 Run 采用；不自动改写已有 Run 的冻结定义、合同或历史材料，也不迁移/删除旧 run.md。其他项目可直接复制配置并使用自身 GitHub tracker 设置；静态合同可按需参考，缺少本地文档或尚未创建报告目录本身不构成阻塞。
