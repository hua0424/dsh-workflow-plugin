# 工作流跟踪目录

供 `milestone-delivery` 的 Manager、Role Actors 和 Judge 共享运行材料。首次进入节点先读本文件，再读 handoff 指定的 `run.md`；只处理该运行和本节点对象，不依赖角色会话的历史记忆。

## 存放与版本管理

- 本文件纳入 Git；运行产物统一放 `docs/dsh-workflow/runs/`，该目录 gitignore，不提交、不强制 add、不用报告提交推进 PR head。
- `runDir = docs/dsh-workflow/runs/<YYYYMMDD-HHmmss>-milestone-delivery-<slug>`，Manager 按本地启动时间命名并确认不与已有运行冲突；重入复用 handoff 的路径，不重新命名。
- 只创建实际需要的文件，不预建空目录/空报告。已有运行不自动迁移；Manager 先确认实际路径、在 run.md 记录旧路径，再安排迁移。
- ignore 不会让已跟踪文件停止跟踪。发现运行产物已 tracked 时 BLOCK，由 Manager 确认后处理；不擅自 `git rm --cached`、清理文件或覆盖用户改动。
- ignored 材料只存在当前工作区，不随 push、clone 或 worktree 自动共享。关键决策、验收证据摘要和最终结果须同步至关联 Issue/PR，不能只贴本地路径。异机/新工作树执行前由 Manager 提供完整材料；缺失时 BLOCK。
- 不在此存凭据、令牌或未脱敏日志。不要运行会删除 ignored 产物的清理操作。备份/归档由 Manager 明确安排，本目录不是插件 SQLite/trace 的替代品。

## 最小结构

```text
docs/dsh-workflow/
├─ INDEX.md                         # 本规范（纳入 Git）
└─ runs/                            # 本地运行产物（gitignore）
   └─ <timestamp>-milestone-delivery-<slug>/
      ├─ run.md                     # 必建：身份、范围、任务索引和当前进度
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

### run.md — 稳定入口

Manager 初始化；coordinator 更新任务进度；其他角色读取。至少包含：

- 身份：runDir、workflowId、仓库 `owner/repo`、Milestone 编号/URL/标题、主 Issue URL。
- 范围：目标、验收入口、明确不做的内容、用户确认记录；取消也记录已产生的外部资源和未清理事项。
- 分支：baseBranch、milestoneBranch、创建时的基线 SHA；分支名不能靠标题推断。
- 任务表：Issue URL、父子关系、依赖、是否仅为聚合父任务、交付记录路径；记录已批准的移出/取消，不静默删行。
- 当前进度：当前 Issue 或集成 PR、材料路径、最近核验时间、已知阻塞。

此文件是运行身份/范围的入口，不是实时远端状态数据库。分支 tip、Issue 状态和 PR/CI 状态每个有副作用的节点都须重新查询。历史创建基线不可被当前 tip 覆盖。

### delivery.md — 对象级交付

coordinator 建立分支/PR身份；developer 补实现与自测；coordinator 补合并收尾，更新时保留历史。

- Issue 交付：Issue URL、featureBranch、milestoneBranch、原始 baseCommit；PR URL/编号、实现 SHA、当前 base/head SHA。
- 自测：对象 SHA、命令、结果、必要的验收/回归覆盖、未执行项和原因；无适用测试需给出依据，不把未测写成通过。
- 集成交付：集成 PR URL/编号、milestone/base 分支、当前 base/head SHA、必要 CI/回归结果或不适用依据。
- 收尾：对应决策路径和批准 base/head、合并源 head、merge SHA、目标包含关系核验、Issue/Milestone 最终状态和时间。
- 关联 Issue/PR 的交付上下文保留身份和关键证据摘要；编辑自有区块，不替换用户原正文。

### rNNN-review.md / rNNN-decision.md — 不可混轮的证据

code-reviewer 写 review，review-judger 写 decision。即使报告很短，也保留这两个最小文件，使后继与重入有固定入口；handoff 只摘要和引用。

轮次按对象分别从 r001 递增。先读取上一轮，再固定本轮，不能把刚写的本轮当作上一轮。相同 PR/base/head 且任务未改变的重入复用原轮次；补充/纠错注明时间和原因，保留旧结论。不同修订开新轮次。

review 至少包含：

- PR URL、轮次、observedAt、baseBranch/headBranch、完整 baseSha/headSha、mergeBaseSha（区分 PR base tip 与 diff 起点）。
- 范围与方法：Issue 验收入口、精确 diff、检查过的证据、未核实项。
- 发现列表：稳定编号如 r001-F1、位置/证据、影响、建议；没有发现明确写“无”。
- 建议结论（非正式 GitHub approval）、上轮必修项的复核状态。

默认审查固定 base/head 的完整 PR diff。仅当 base 未变、head 是上轮 head 的后继且旧发现全部可追踪时，允许增量审查；仍须复核旧必修项。分支/base 漂移、范围改变或材料不足时重新确定完整范围，不能继承旧批准。

decision 至少包含：对应 review 路径与同一 PR/base/head；每项发现的核实结论、处置（本次修复/延期/不成立）和理由；剩余必修清单；批准或返工结论。修复复杂不是延期阻断问题的理由；范围外争议交 Manager。通过才记录 approvedBase/approvedHead，返工不保留有效批准。

决策摘要同步至对应 PR；集成决策同时同步主 Issue。评论包含远端可读的关键结论与修订信息，不只有本地文件路径。变更实现、PR head 或批准 base 后，原批准失效；合并前发现漂移时 BLOCK，由 Manager 安排重新审查和决策，补充证据不能代替新修订的专业评审。

### coordination.md / deferred.md / completion.md

- coordination：Manager 按时间追加问题、依据、决定/授权和恢复对象。Judge 缺查询能力时，记录 Manager 独立只读查询的仓库/PR/SHA、时间、命令/API、原始关键输出、分页完整性和结论；通过 `node_resume.resolutionContext` 同时提交关键证据与路径，有有效 claim 时恢复 Judge。不是重复 Actor 自述或直接替 Judge 宣布 ACCEPT。Manager 自己是当前 Actor 时，需要另有可独立读取的可信来源或用户核验；不足则保持 BLOCK。
- deferred：review-judger 登记发现 ID、延期理由、影响、授权依据（需要范围取舍时）、后续 Issue URL或明确待决入口。不把“已登记”当成“已修复”。
- completion：coordinator 完成时写交付范围、集成 PR/merge SHA、实际验证与未测边界、延期事项及远端摘要链接；取消由 Manager 写原因、外部资源现状与清理约束，不能写成交付成功。

## Handoff 与结果约定

每次 claim 的 handoff 必须自足且不超工具长度限制；后继只有前驱交接，不自动累计所有历史字段。使用如下短格式，按节点删去不适用字段：

```text
入口：run.md 路径；repo；Milestone 编号；当前 Issue/集成对象。
结果：实际完成内容或明确失败原因。
修订：PR URL；base/head 分支与 SHA；原始 baseCommit/实现 SHA（适用时）。
证据：delivery/review/decision 路径；远端摘要链接；必要检查结果。
后续：必修清单、未核实项、约束；下一角色需要的批准修订等信息。
```

- 调用前核对当前任务身份；claim/block 是本轮最后动作，读取和写入证据须先完成。
- 报告角色完成报告即 completed，不以发现缺陷表达动作失败；决策角色 completed=无本次必修项，failed=需要返工。无法执行/核验或缺权限用 BLOCK。
- `node_block` 使用当前 nodeToken 和 reason（问题、证据、缺失信息、需要 Manager 决定的事项）；该工具没有 handoff 参数，不为传材料再调用 node_claim。
- 外部副作用重入先查现场，匹配则补缺失收尾；不匹配 BLOCK，不强推、不重复创建、不替换原始基线。合并前保护检查/权限不满足时 BLOCK，不绕过保护。
- 技能用实际 catalog 的精确名称。必需技能缺失先由 Manager 决定替代步骤或 BLOCK，不虚构调用成功。

## 当前已知插件限制

- [#17：onFail END](https://github.com/hua0424/dsh-workflow-plugin/issues/17)：已实施并部署。配置直接使用两处 `onFail: END`：根流程 `grilling.failed → END`（用户取消终局，Run 状态沿用 completed，终局结果由终局 claim outcome + handoff 表达）；子流程 `select-next-issue.failed → END`（任务穷尽，pop 后落父节点 onPass 进入集成，父只能经 handoff 感知穷尽事实）。终局语义见 [登记材料](../pending-discussions/onfail-end.md)。
- [#18：Judge inspection](https://github.com/hua0424/dsh-workflow-plugin/issues/18)：当前缺 PR/CI/提交关系查询和列表完整性支持；先由 Manager 按 coordination 合同补证，不通过放宽为 Actor 自报来绕过核验。见 [登记材料](../pending-discussions/judge-repository-inspection.md)。

YAML 修改不更新活动 Run 已冻结的定义快照；配置与规范文本优化只影响之后启动的新 Run。
