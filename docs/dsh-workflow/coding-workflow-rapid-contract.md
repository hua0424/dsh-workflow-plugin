# coding-workflow-rapid 轻量单任务合同

版本：2026-09-18.2；协议：agent-workflow/v3。仅适用于显式采用本合同的工作流。启动前已完成 grill/to-spec，唯一 GitHub Issue 是规格与验收入口。

## 共同行为与交接

- **入口**：每次派发读 handoff 指定的 run.md，核对仓库/Issue/当前 PR；首次读通用 INDEX 与本节，当前角色的细节按下文标题读取，已有运行以合同副本为准。文档缺失且影响当前工作时 BLOCK。
- **范围**：单仓、单 Issue、无子票、单 PR，不管理 Milestone。保留用户改动、正文及历史；只写当前授权对象和自有记录。范围扩大、需拆票/改子仓、技术/权限或证据缺口均 BLOCK。范围内必修项走返工。
- **材料**：运行产物只写既定 ignored runDir。先保存证据、更新 run.md，再交付；关键摘要同步 Issue/PR，其他环境不能只凭本地路径读取证据。
- **公共交接字段**：run.md/runDir 绝对路径、仓库/Issue、合同副本入口、所选 result 与成立依据。节点 instruction 列出该 result 要追加的产物、修订、证据和后续事项；只传摘要与入口，不复制整份报告。
- **提交**：工具参数、长度、claim 必须最后调用及 REJECT 处理以插件每次派发的提交协议为准。persona 只保留一句终止纪律，不在配置复制完整协议。

这是工作流专属规则，不向通用 INDEX 添加节点或角色要求。当前插件没有共用 persona 配置，Role 的入口提示和终止纪律须在各 persona 保留短句；引用本文件不会将正文自动提升为 system prompt。

## 启动与授权

启动提供 Issue、仓库、目标分支；已有明确项目默认值可采用并记录，缺失或冲突交 Manager 澄清。启动即授权范围内实现、推送、创建/更新 PR、满足条件后合并及关闭此 Issue，不授权强推、破坏用户改动、绕过保护或部署。项目合并规定优先，无规定采用 squash；仓库不允许选定方式时 BLOCK。

Manager 初始化（插件强制根首节点使用 manager），coordinator 合并，developer 实现，独立 code-reviewer 同时审查与裁决；插件 Judge 核验 claim，不承担业务裁决。可配置 Role Actor 的稳定职责与权限约束进入 persona（system），具体动作放 instruction；验收条件同时列入节点共同/结果 criteria，不能仅依赖长上下文 instruction。Manager 是既有主会话，配置不能用 Role persona 替换其 system；初始化约束通过当前派发 instruction 和 Judge criteria 双重承载。通用 INDEX 不增加角色或节点约定，本流程不继承 coding-workflow 的两级 PR、独立 decision 或 review-contract 文件义务。

## 初始化与材料

每次运行使用 `docs/dsh-workflow/runs/<YYYYMMDD-HHmmss>-coding-workflow-rapid-<slug>/`，初始化确定唯一绝对路径，重入复用，不碰其他运行。

Manager 核对仓库、目标分支与干净工作树，从 fetch 后的确切目标 SHA 建立任务分支；已有分支/PR 仅在归属和原始起点可核验时复用。非本次可追溯的改动或身份不明时 BLOCK，保留现场。只在任务分支处理必要 .gitignore；部署、强推和硬重置不在初始化授权内。

- `run.md`：身份、规格入口、验收与不做范围、workspace/仓库/远端、Issue、原始 baseCommit、任务/目标分支、PR、合并方式与授权；合同原路径/版本/哈希/副本绝对路径；初始化、实现自测、当前报告索引及最终收尾。只维护实际需要内容。
- `contracts/`：初始化保存通用 INDEX 和本合同完整内容副本，核对哈希；不假称插件自动冻结外部文件。不复制无关合同，副本中的相对引用按所记录原位置解析。
- `rNNN-review.md`：每轮一份审查与裁决合并报告。首次 r001；对象修订或审查输入改变则新轮次，不覆盖旧结论。完全相同输入的重入可补齐原轮次的遗漏动作，保留修改轨迹。

**任何运行材料写入之前**，先核验 `git check-ignore` 对目录和计划文件路径生效，并用 `git ls-files` 检查其中无已跟踪文件。未忽略时在已核验的任务分支最小追加仓库 `.gitignore` 规则 `/docs/dsh-workflow/runs/`，再次检查（包括既有反向规则）。规则不足时只作必要修正，不覆盖其他内容。忽略规则不取消跟踪；发现已跟踪材料 BLOCK，由用户决定，不能擅自 `git rm --cached`。

本次必要 `.gitignore` 修改由 Manager 在任务分支单独提交、记录，随后与实现一并进入 PR；初始化重入允许这类已记录的自身改动，但不可借此接管身份不明的脏工作树。developer 和 reviewer 再核对暂存/PR diff 不包含运行材料。没有必要改动则不制造提交。

运行文件不提交、不强制 add、不清理、不记录密钥。ignored 文件不随 push/clone/worktree 传递；换环境前确认材料可读，否则 BLOCK。正式规格和长期设计保留项目原位置。只补充 Issue/PR 的自有区块或评论，保留用户正文及历史；远端必须有关键证据摘要，不能只发本地路径。

各角色追加带时间的进度；只维护自己的记录，保留他人内容。Manager 管初始化，coordinator 管收尾，developer 管实现/自测，reviewer 管审查报告与索引。Manager 的澄清/授权按需追加到 run.md，不另建空报告。

## 四节点与路由

| 节点 | 结果 | 后继 |
|---|---|---|
| initialize | ready | implement |
| implement | implemented | review |
| review | approved | merge |
| review | changes-required | implement |
| merge | stale-review | review |
| merge | delivered | 返回 delivered |

无子流程，无选票循环，无集成 PR，无独立裁决节点。结果条件互斥；技术故障、缺权限/证据、范围争议或需要拆票用 BLOCK，不增加伪业务出口。原 Issue 范围内的缺陷直接返工；扩大范围或子仓改动由用户另行决定是否换流程。本流程不自动创建后续票或迁移活动 Run。

## 审查与裁决

审查报告包含仓库/Issue/PR/base/head/mergeBase、范围、验收覆盖、自测与 CI 证据、未测边界、旧必修项复核、每条发现及稳定编号、证据和处置、本轮结论；批准时写 approvedBase/approvedHead。延期项就在报告内注明影响、必要授权及后续入口，不因登记而视为修复。返工报告无有效批准。

首轮完整审查；返工与基线/head 漂移可复用可追溯证据，须补查所有变化及交互影响，无法确认覆盖则完整审查。无必修项且必需验证齐全才批准；缺运行环境或无法核验用 BLOCK。审查摘要与确切修订同步 PR。发现与裁决写同一报告，不要求另一角色签字；仓库要求的 GitHub 人工 approval 仍须满足，工作流内部 approved 不能替代保护规则。

## 合并与重入

开放 PR 的当前 base/head 与批准任一不同时，旧批准失效：在 run.md 记录新旧值，交 stale-review 返回审查，不修改旧报告。对象归属不明、缺报告、检查待完成/失败、冲突、权限或保护不满足时 BLOCK。允许的重新审查不是绕过必要测试；reviewer 应要求实现阶段补足范围内验证/修复。

合并前重新查询实际状态，记录方法、批准 base/head、核验时间和检查证据；使用可用工具的 head 条件保护，紧邻合并重查 base。GitHub 工具的 head 条件不保证原子锁住目标 base，保留仓库已有保护/更新要求，不宣称本配置消除了并发窗口；发现检查后发生并发变化则如实 BLOCK 并交用户处理，不伪造批准或自动回滚。

合并后必须主动核验实际合并起点等于 approvedBase：squash/merge 读取 mergeCommit 第一父节点，rebase 依可追溯提交链起点或可靠远端证据。不能证明或不相等时 BLOCK 交用户，不提交 delivered、不手动关票、不自动回滚；GitHub 已自动关票须如实记录，不能伪称尚未产生副作用。

合并后的收尾重入以 PR 的 merged 状态和合并时记录为准，不能因为正常合并使目标 tip 前进而重新审查已经合并的 PR。核验指定 PR、目标、合并源 head、当时批准与检查证据、PR mergeCommit，以及远端目标包含关系。squash/rebase 不要求原 head 是目标祖先；merge commit 额外检查该关系。证据缺失先 BLOCK 补证，不重复合并，不用事后检查替代合并前检查。

核验成功后同步 Issue 摘要并关票；GitHub 已自动关票则核验归属后复用。更新 run.md 收尾，记录 mergeCommit、批准修订、合并方法、验证/延期边界、远端摘要，安全回到并快进目标分支，保持工作树干净。不自动删分支。关票/同步失败时下次只补未完成动作。

## Judge 补证

Judge 只核共同与所选 result criteria；ACCEPT 才走业务边，REJECT 是当前节点修正，NEED_CONTEXT 保留 claim 并 BLOCK 等补证。Manager 缺证据时独立只读查询，向 run.md 追加对象/SHA/时间/命令或 API/关键输出/分页完整性，使用 node_resume.resolutionContext 提交关键证据及路径；Actor 自述或 Manager 的通过宣告不构成独立证据。

本配置需已部署 v3 插件。新增 catalog 文件不自动启动 Run，也不升级插件/状态库；旧 Run 和原配置保持不变。其他项目采用前需在该仓库提供本合同与通用 INDEX，不能假定用户 catalog 会分发仓库文档。
