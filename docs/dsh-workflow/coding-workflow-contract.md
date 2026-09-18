# coding-workflow 工作流合同

合同版本：`2026-09-17.1`；配置协议：`agent-workflow/v3`。仅适用于显式引用本合同的 `coding-workflow` 单仓两级 PR 工作流，其他工作流不自动继承角色、节点、目录和报告要求。首次派发读取适用合同；同一会话后续派发可按运行入口读取当前对象材料，不能假定新会话已有合同认知。审查证据格式见 [review-contract.md](review-contract.md)，操作排障按需读 [operations.md](operations.md)。

## 存放与版本管理

- 本文件纳入 Git；运行产物统一放 `docs/dsh-workflow/runs/`，该目录 gitignore，不提交、不强制 add、不用报告提交推进 PR head。
- `runDir = docs/dsh-workflow/runs/<YYYYMMDD-HHmmss>-coding-workflow-<slug>`，Manager 按本地启动时间命名并确认不与已有运行冲突；重入复用 handoff 的路径，不重新命名。
- 只创建实际需要的文件，不预建空目录/空报告。新运行使用独立目录；确需参考旧材料时，在 run.md 记录其原路径与适用范围，保留旧文件。
- ignore 不会让已跟踪文件停止跟踪。发现运行产物已 tracked 时 BLOCK，由 Manager 确认后处理；不擅自 `git rm --cached`、清理文件或覆盖用户改动。
- ignored 材料只存在当前工作区，不随 push、clone 或 worktree 自动共享。关键决策、验收证据摘要和最终结果须同步至关联 Issue/PR，不能只贴本地路径。异机/新工作树执行前由 Manager 提供完整材料；缺失时 BLOCK。
- 不在此存凭据、令牌或未脱敏日志。不要运行会删除 ignored 产物的清理操作。备份/归档由 Manager 明确安排，本目录不是插件 SQLite/trace 的替代品。

## 最小结构

```text
docs/dsh-workflow/
├─ INDEX.md                         # 跨工作流通用入口规则（纳入 Git）
├─ coding-workflow-contract.md   # 本工作流合同（纳入 Git）
├─ review-contract.md               # 可复用审查证据格式（纳入 Git）
└─ runs/                            # 本地运行产物（gitignore）
   └─ <timestamp>-coding-workflow-<slug>/
      ├─ run.md                     # 必建：身份、范围、任务索引和当前进度
      ├─ contracts/                 # 初始化时保存适用合同及引用规范内容副本
      ├─ coordination.md            # 按需：Manager 澄清、授权、BLOCK 处理与核验证据
      ├─ deferred.md                # 按需：经决策延期的问题及后续入口
      ├─ issues/
      │  └─ <issue-number>/
      │     ├─ delivery.md          # 分支起点、实现/自测和合并收尾记录
      │     ├─ r001-review.md       # 该 Issue PR 第一轮审查
      │     ├─ r001-decision.md     # 对同轮报告的逐项决策
      │     ├─ r002-review.md       # 有返工时增加，不覆盖旧轮次
      │     └─ r002-decision.md
      ├─ integration/
      │  ├─ delivery.md             # milestone→基线 PR 身份和最终合并记录
      │  ├─ r001-review.md
      │  └─ r001-decision.md
      └─ completion.md              # 完成/取消时的最终摘要
```

测试角色当前仅预留，没有独立测试节点。现阶段验证来自 developer 自测及仓库已有 CI，不能写成 tester 已验收。未来接入测试节点时再定义测试产物与路由，不预建测试子流程目录。

已有 PRD、ADR、设计和测试文档优先引用原位置。澄清草稿确需长文时按需放 `notes/<slug>.md`；正式需求以 Issue 为准，项目级长期设计决策回归项目原有规范，不在每次运行复制一套文档体系。

## 文件合同与写入责任

多角色共用同一工作区，并发写按以下分区协议执行，避免覆盖他人区块：

- **任务表（run.md）分字段维护**：planner 维护任务范围、父子关系、依赖与 taskKind；coordinator 维护领取、PR、合并及关闭等执行状态。Manager 初始化并处理授权/范围争议。每次先读最新文件，只改自有字段，保留其他字段；其他角色发现过期状态时实查远端并交责任角色修正。
- **当前进度（run.md）为追加时间线**：每个角色只追加带时间与角色前缀的自己的行，不编辑他人行、不改写历史行。
- delivery/review/decision/deferred 按下述归属角色编辑自有区块；发现他人区块有误时记录在 coordination.md 交 Manager 处理，不直接改。

### run.md — 稳定入口

Manager 初始化；planner 维护计划字段，coordinator 更新执行状态；各角色按追加规则记录进度。至少包含：

- 身份：runDir、workflowId、workspace 绝对路径、仓库标识/绝对路径/远端 `owner/repo`、Milestone 编号/URL/标题、主 Issue URL；适用合同原路径、版本、内容哈希及运行内副本绝对路径。初始化保存本合同、通用 INDEX 与引用的 review-contract 副本，后续按该运行副本执行；副本中的其他链接若未一并复制，按记录的原文档位置解析，操作备忘只按需读取。
- 范围：目标、验收入口、明确不做的内容、用户确认记录；取消也记录已产生的外部资源和未清理事项。
- 分支：baseBranch、milestoneBranch、创建时的基线 SHA；分支名不能靠标题推断。
- 任务表：Issue URL、父子关系、依赖、taskKind（implementation / aggregate / integration-acceptance）、验收归属、交付记录路径；记录已批准的移出/取消，不静默删行。
- 当前进度：当前 Issue 或集成 PR、材料路径、最近核验时间、已知阻塞。

此文件是运行身份/范围的入口，不是实时远端状态数据库。分支 tip、Issue 状态和 PR/CI 状态每个有副作用的节点都须重新查询。历史创建基线不可被当前 tip 覆盖。

### delivery.md — 对象级交付

coordinator 建立分支身份与交付入口；developer 创建/复用 Issue PR 并补 PR 身份、实现与自测；coordinator 建立集成 PR 并补各级合并收尾，更新时保留历史。

- Issue 交付：Issue URL、featureBranch、milestoneBranch、原始 baseCommit；PR URL/编号、实现 SHA、当前 base/head SHA。
- 自测：对象 SHA、命令、结果、必要的验收/回归覆盖、未执行项和原因；无适用测试需给出依据，不把未测写成通过。
- 集成交付：集成 PR URL/编号、milestone/base 分支、当前 base/head SHA、必要 CI/回归结果或不适用依据。
- 收尾：对应决策路径和批准 base/head、合并源 head、merge SHA、目标包含关系核验、Issue/Milestone 最终状态和时间。
- 关联 Issue/PR 的交付上下文保留身份和关键证据摘要；编辑自有区块，不替换用户原正文。

### rNNN-review.md / rNNN-decision.md — 不可混轮的证据

code-reviewer 写 review，review-judger 写 decision。即使报告很短，也保留这两个最小文件，使后继与重入有固定入口；handoff 只摘要和引用。

核心规则（详细格式合同见 run.md 指向的 review-contract 内容副本）：轮次按对象从 r001 递增，先读上一轮再固定本轮；相同 PR/base/head 且任务未变的重入复用原轮次，不同修订开新轮次。默认审查固定 base/head 的完整 PR diff，仅满足增量条件时可增量但仍复核旧必修项。通过才记录 approvedBase/approvedHead，返工不保留有效批准；变更实现、head 或批准 base 后原批准失效，漂移时 BLOCK。决策摘要同步至对应 PR（集成同时同步主 Issue）。

### coordination.md / deferred.md / completion.md

- coordination：Manager 按时间追加问题、依据、决定/授权和恢复对象。Judge 缺查询能力时，记录 Manager 独立只读查询的仓库/PR/SHA、时间、命令/API、原始关键输出、分页完整性和结论；通过 `node_resume.resolutionContext` 同时提交关键证据与路径，有有效 claim 时恢复 Judge。不是重复 Actor 自述或直接替 Judge 宣布 ACCEPT。Manager 自己是当前 Actor 时，需要另有可独立读取的可信来源或用户核验；不足则保持 BLOCK。
- deferred：review-judger 登记发现 ID、延期理由、影响、授权依据（需要范围取舍时）、后续 Issue URL或明确待决入口。不把“已登记”当成“已修复”。
- completion：coordinator 完成时写交付范围、集成 PR/merge SHA、实际验证与未测边界、延期事项及远端摘要链接；取消由 Manager 写原因、外部资源现状与清理约束，不能写成交付成功。

## Handoff 与结果约定

每次 claim 的 handoff 必须自足且不超工具长度限制；后继只有前驱交接，不自动累计所有历史字段。使用如下短格式，按节点删去不适用字段：

```text
入口：run.md 的绝对路径 + runDir 绝对路径；workspace / 仓库身份；适用合同副本路径与版本；Milestone 编号；当前 Issue/集成对象。
结果：所选 result 及其成立依据；技术障碍改用 BLOCK，不冒充业务结果。
修订：PR URL；base/head 分支与 SHA；原始 baseCommit/实现 SHA（适用时）。
证据：delivery/review/decision 路径；远端摘要链接；必要检查结果。
后续：必修清单、未核实项、约束；下一角色需要的批准修订等信息。
```

- **运行产物一律写 handoff 给定的 runDir 绝对路径**，不得相对当前 cwd 猜测或写到 `docs/dsh-workflow/` 其它位置。

- 调用前核对当前任务身份；claim/block 是本轮最后动作，读取和写入证据须先完成。
- 使用 `node_claim({ result, handoff })`；result 必须是当前节点声明的名称。报告节点提交 `reviewed` 表示已完成审查报告，无论是否发现缺陷；裁决节点用 `approved` 或 `changes-required` 表达处置结论。无法执行/核验、缺权限或需要授权时用 BLOCK。
- `node_block` 按当前工具参数提供 reason（问题、证据、缺失信息、需要 Manager 决定的事项）；不自行扩展参数，不为传材料再调用 node_claim。
- 外部副作用重入先查现场，匹配则补缺失收尾；不匹配 BLOCK，不强推、不重复创建、不替换原始基线。合并前保护检查/权限不满足时 BLOCK，不绕过保护。
- 技能用实际 catalog 的精确名称。必需技能缺失先由 Manager 决定替代步骤或 BLOCK，不虚构调用成功。

### 节点结果与流程返回

本表解释本工作流的结果；实际合法名称、共同条件、结果条件与目标以本次冻结 YAML 为准。persona 保留 system 层的稳定职责、权限边界和证据纪律；instruction 提供当前动作与材料，强制验收条件同时进入 checker 共同条件或对应 result 的 criteria。

| 所属流程 | 节点 | result 与后继 |
|---|---|---|
| root | grilling | `ready` → need-tickets；`cancelled` → root 返回 cancelled |
| root | need-tickets | `planned` → issue-cycle 调用 |
| root | integrate-milestone | `prepared` → final-review |
| root | final-review | `reviewed` → decide-pr |
| root | decide-pr | `approved` → close-milestone；`changes-required` → plan-remediation |
| root | close-milestone | `delivered` → root 返回 delivered |
| root | plan-remediation | `planned` → issue-cycle 调用 |
| issue-cycle | select-next-issue | `selected` → issue-delivery 调用；`exhausted` → issue-cycle 返回 exhausted |
| issue-delivery | implement | `implemented` → review |
| issue-delivery | review | `reviewed` → decide-pr |
| issue-delivery | decide-pr | `approved` → complete-issue；`changes-required` → implement |
| issue-delivery | complete-issue | `delivered` → issue-delivery 返回 delivered |

issue-delivery 返回 `delivered` 后，issue-cycle 继续选票；issue-cycle 返回 `exhausted` 后，root 进入集成准备。两个 Child 调用通过显式 onReturn 映射推进，没有额外报告节点，也不从 handoff 文本猜测返回值。

- 本流程保留独立 code-reviewer 与 review-judger；reviewer 负责发现，review-judger 完成逐项核实与处置。存在未解决的范围或授权争议时 BLOCK，请 Manager 提供决定；技术信息不足时补证，不新增猜测出口。
- 裁决出口互斥：所有发现已处置、无本次必修项且批准修订明确时 `approved`；有明确且可执行的本次必修清单时 `changes-required`。延期必须具备必要授权与后续入口。
- Judge 核验共同 criteria 与 Actor 所选 result 的 criteria；满足则 ACCEPT，不满足则 REJECT，需要补充信息才 NEED_CONTEXT。不另加遍历所有出口或证明唯一性的任务。
- REJECT 是同一节点内修正 claim，不能当作 `changes-required` 业务返工边；只有 `changes-required` 被 ACCEPT 后才沿静态目标返工。NEED_CONTEXT 保留 claim 并 BLOCK，经补证恢复 Judge。
- root 返回 `delivered` 表示完成交付；`cancelled` 表示已确认取消，并保留资源现状和清理约束。运行状态 completed 仅表示执行结束；控制面终止不等于已交付或已处理全部外部副作用。

## 任务分类与阶段退出

- `implementation`：本轮必须完成的实现或修复叶任务。简单任务的主 Issue 直接归此类，不另建无意义子票。
- `aggregate`：仅聚合子任务、没有独立验收的父 Issue。子任务完成且无未结事项后由 coordinator 自底向上关闭，直到无可关闭的聚合票；每次关闭后分页核对同 Milestone 依赖该票的 open implementation，全部依赖已关闭的补齐 ready-for-agent，仍阻塞的不动。不得留下开放聚合票再退出开发循环。
- `integration-acceptance`：仅允许主 Issue 使用，须明确列出集成阶段验收项及其证据入口。实现工作必须拆入 implementation，不得借此分类把未完成代码、修复或子任务留到集成阶段。
- planner 在初始化/拆票及补救规划时维护分类、依赖与验收归属。依赖及父子关系不得成环，integration-acceptance 主票不能成为 implementation/aggregate 等待关闭的依赖。无法分类或范围有争议时交 Manager，不靠默认猜测排除任务。
- 退出开发循环前完整分页核对 Milestone 成员及 run.md 登记：至少有一个 implementation 且其全部关闭、aggregate 已完成并关闭；剩余开放 Issue 可为空，否则只允许是已显式登记的 integration-acceptance 主 Issue。handoff 列出待验收项，没有则写“无”。缺页、未登记、子任务未完成、状态冲突时不得声明穷尽。记录超过 100 不是失败条件，应继续分页或报告确切查询障碍。
- 集成准备接受上述状态，不提前要求主 Issue 已被未来的集成审查/裁决批准。若主 Issue 是 integration-acceptance，须在当前集成审查/裁决覆盖全部独立验收项、集成合并成功并验证目标包含关系后，由 coordinator 关闭主 Issue，再核验所有任务与 Milestone 的最终状态。
- 集成审查发现需要实现/修复时，补救规划登记 implementation 任务并重新进入开发循环，不能仅改分类绕过返工。

## 集成批准不可按 Issue 数量跳过

不论实施 Issue 数量，当前集成 PR 都须有本对象、本轮的 review 和 decision，decision 明确记录当前 approvedBase / approvedHead 后才可进入合并收尾。

可引用旧审查证据以减少重复工作，但当前报告必须说明证据对应的仓库、PR、修订及覆盖范围，并补充核验基线变化、新增内容、集成差异、主 Issue 独立验收和必要回归。Issue 数量相同、提交 tree 相同或旧 feature PR 已批准，都不单独构成集成批准。不能证明完整覆盖时执行完整审查。复用证据不等于复用旧批准。

## 合同变更与已有运行

YAML 定义快照与文档是两回事：YAML 修改不更新活动 Run 已冻结定义，但插件不会自动冻结或注入这些外部文档。上述合同副本由初始化步骤保存，不能宣称插件已提供此功能。

本配置新建 `coding-workflow` 运行，不迁移活动旧 Run、不复用旧工作流的 runDir。切换前用匹配旧格式的插件结束或显式终止旧 Run，核对外部操作收尾；如状态库仍为旧格式，按升级手册显式备份后新建，新版不恢复或查询旧格式历史。保留原工作流文件与历史材料，不能因改用本合同而覆盖。仅保存版本字符串不足以防止外部文档后来被覆盖。

初始化前明确取消时，仅需可读取的取消依据、已产生资源现状及清理约束；不要求尚未创建的 run.md、合同副本或远端资源。已有 runDir 时取消摘要写 completion.md。

