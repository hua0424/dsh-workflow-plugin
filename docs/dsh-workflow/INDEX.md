# 工作流跟踪目录

供 `milestone-delivery` 的 Manager、Role Actors 和 Judge 共享运行材料。首次执行读本文件建立合同认知；**重入会话直接读 handoff 的 run.md（任务表 + 当前进度）即可，无需重读全文**。只处理该运行和本节点对象，不依赖角色会话的历史记忆。rNNN-review/decision 的详细格式合同另见 `docs/dsh-workflow/review-contract.md`（code-reviewer / review-judger 首次执行与轮次有疑义时读）。

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
├─ review-contract.md               # rNNN-review/decision 详细格式合同（纳入 Git）
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

多角色共用同一工作区，并发写按以下分区协议执行，避免覆盖他人区块：

- **任务表（run.md）仅 coordinator 维护**；其他角色读到过期任务表时以远端实查为准，不代改。
- **当前进度（run.md）为追加时间线**：每个角色只追加带时间与角色前缀的自己的行，不编辑他人行、不改写历史行。
- delivery/review/decision/deferred 按下述归属角色编辑自有区块；发现他人区块有误时记录在 coordination.md 交 Manager 处理，不直接改。

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

核心规则（详细格式合同见 `docs/dsh-workflow/review-contract.md`）：轮次按对象从 r001 递增，先读上一轮再固定本轮；相同 PR/base/head 且任务未变的重入复用原轮次，不同修订开新轮次。默认审查固定 base/head 的完整 PR diff，仅满足增量条件时可增量但仍复核旧必修项。通过才记录 approvedBase/approvedHead，返工不保留有效批准；变更实现、head 或批准 base 后原批准失效，漂移时 BLOCK。决策摘要同步至对应 PR（集成同时同步主 Issue）。

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

## gh CLI 操作备忘（真实 Run 踩坑沉淀）

- `gh issue edit --milestone` 接受**标题**而非编号（`--milestone 9` 报 not found，须 `--milestone 'prompt-slim-protocol-single-source'`）。
- REST 过滤 `gh api "issues?milestone=<N>&state=all"` 在部分环境返回空数组（工具怪癖，非数据缺失）；用 `gh issue list --milestone <标题>` 或 search API 双路补偿后再下完整性结论。
- sub-issue API（`POST issues/<parent>/sub_issues`、`GET .../sub_issues`）响应体是**数组**；`--jq '.[].number'` 对空数组返回空而非错误，勿据单次输出误判挂载失败，需 GET 复核。
- 无 CI 仓库的合并前检查证据：`gh pr checks <n>` 无 checks + 分支保护 404 + `/rulesets` 空，配合在批准 head 上实跑回归，即构成"无适用检查"的明确依据。

## 当前已知插件限制

- [#54：空回合安全闭合误伤并行子代理等待](https://github.com/hua0424/dsh-workflow-plugin/issues/54)：并行子代理等待期的无工具回合被结算为 `not safely closed` 自动 BLOCK 并解除 claim 绑定；触发后 Actor 无法自恢复，需 Manager `node_resume` 兜底（run 295ad986 先例：coordination.md 2026-09-12 节）。
- [#55：node-boundary compact 失败无降级](https://github.com/hua0424/dsh-workflow-plugin/issues/55)：长会话角色派发时 compact 摘要无法再缩小即 BLOCK；Manager 可 `workflow_set_role_model` 切换更强模型后 `node_resume` 恢复（run 295ad986 先例：coordinator 切 glm-5.3 后一次成功）。
- [#17：onFail END](https://github.com/hua0424/dsh-workflow-plugin/issues/17)：已实施并部署。配置直接使用两处 `onFail: END`：根流程 `grilling.failed → END`（用户取消终局，Run 状态沿用 completed，终局结果由终局 claim outcome + handoff 表达）；子流程 `select-next-issue.failed → END`（任务穷尽，pop 后落父节点 onPass 进入集成，父只能经 handoff 感知穷尽事实）。终局语义见 [登记材料](../pending-discussions/onfail-end.md)。
- [#18：Judge inspection](https://github.com/hua0424/dsh-workflow-plugin/issues/18)：当前缺 PR/CI/提交关系查询和列表完整性支持；先由 Manager 按 coordination 合同补证，不通过放宽为 Actor 自报来绕过核验。见 [登记材料](../pending-discussions/judge-repository-inspection.md)。

YAML 修改不更新活动 Run 已冻结的定义快照；配置与规范文本优化只影响之后启动的新 Run。
