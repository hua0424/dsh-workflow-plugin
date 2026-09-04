# PRD：A2 milestone-delivery 配置职责与交付闭环强化

- 日期：2026-09-03
- 来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 复盘
- 状态：**v1 兼容版已落地**。`milestone-delivery.yaml` 已按本 PRD 决策重写并部署（评审副本：本目录 `milestone-delivery.yaml`，旧版备份：`milestone-delivery.orig.yaml`，语义评审记录：`a2-config-review.md`）。Judge 文案沿用 v1 `PASS|FAIL|NEED_CONTEXT`、FAIL 走 `onFail` 边；A1 的 `REJECT`/correction-feedback 文案落地后需同步升版配置
- 类型：配置与提示词改造，不新增业务状态机代码（关闭 Milestone 所需 GitHub 操作由 Manager actor 执行）

## 1. 背景

当前配置通过严格 schema/static validation，并与设计文档中的示例完全一致，但真实运行暴露了多处**语义职责矛盾**：

1. `implement` instruction 只要求实现 Issue，checker criteria 却额外要求 implementation 已 `published`。Developer 两次提交正确代码但未 commit/push，Judge 连续两次 REJECT/旧语义 FAIL。
2. `complete-issue` 可在 feature branch 已 push 时关闭 Issue，但没有要求远端默认分支包含实现。最终 workflow completed，而 `origin/main` 不含实现 commit。
3. `github.all-milestone-issues-complete` 只检查 Issue 全部 closed；Milestone #2 最终仍是 open。
4. `draft-prd` 会修改 `docs/prd`，紧接着的 `initialize-milestone` 创建 branch 时却要求 clean tree，迫使 Manager 在 branch 创建前把 PRD commit 到当前分支。本次造成 local main 与 origin/main 分叉。
5. Tester 创建测试报告但未明确谁负责 commit/push；最终由 Manager 临时决定提交。

## 2. 为什么初次配置检查没有发现 instruction/checker 矛盾

初次检查主要覆盖：

- YAML 语法与严格 zod schema；
- role/program/checker id 是否存在；
- node target、reachability、END path、child-workflow DAG；
- 配置是否与权威设计示例一致。

这些检查能证明配置“可加载、可运行”，不能证明每个 instruction 与 checker criteria 在责任上自洽。更关键的是，权威设计示例本身就包含同一矛盾，因此“与示例一致”反而掩盖了语义问题。

这是评审方法缺口：当时结论“配置正确”应限定为“schema/structure 正确”，并单列 semantic review。后续配置评审必须增加以下责任矩阵：

| Node | Actor 被明确要求执行的动作 | Checker 要求验证的事实 | 后续 Node 的责任 | 是否一致 |
|---|---|---|---|---|

任何 checker 要求的可变事实，都必须由当前或先前 instruction 明确分配给某个可执行 Actor；只读 Reviewer/Judge 不得被隐含要求产生副作用。

## 3. 已确认决策

1. **Implement 负责 publish**：Developer 在 claim completed 前必须测试、commit、push 到指定 feature/milestone branch。
2. **默认分支包含交付 commit 才算集成**：Manager 按 repository policy 通过 PR merge 或直接 merge；Judge 只验证远端默认分支已包含交付 commit。
3. **增加 Manager `close-milestone` 节点**：final review 通过后由 Manager 关闭 GitHub Milestone，再由 Judge 验证 state=closed。
4. **先建 branch，再创建 PRD**：通过新增 root start Manager 节点规划 title/branch，满足 root startNode 必须是 Manager actor-task 的现有约束。
5. **Tester 负责发布报告**：Tester 创建、commit、push测试报告后才能 claim completed。
6. 本 PRD 按 A1 新 Judge 确认协议描述；若 A1 采用 v2，配置同步升级。

## 4. 新 Root Workflow

建议根流程：

```text
plan-milestone
  → initialize-milestone
  → draft-prd
  → plan-issues
  → run-issue-cycle
  → final-review
  → close-milestone
  → END

final-review（Reviewer failed + Judge ACCEPT）
  → plan-remediation
  → run-issue-cycle
  → final-review

final-review（Judge REJECT）
  → 返回 Reviewer 修正，不进入 remediation
```

### R1：plan-milestone（新增）

类型：`actor-task`，role `manager`；作为 root `startNode`。

职责：

- 根据当前用户目标选择 Milestone title 与 branch name；
- 只规划，不修改工作区文件；
- completed claim 的 handoffContext 必须包含 repository、title、branchName。

Checker criteria：

- 用户目标足够明确；
- title/branchName 非空、可执行、与目标一致；
- repository 身份明确；
- 不要求 PRD 文件已经存在。

### R2：initialize-milestone

保持 builtin program `github.initialize-milestone`，接收前一 Node handoff 中的 title/branchName。

预期现场：

- 工作区仍 clean；
- program 创建/核实 Milestone 与 exact local+remote branch；
- PASS 后当前分支已是 milestone branch。

### R3：draft-prd（后移）

职责明确为：

- 在 milestone branch 上创建/更新 `docs/prd`；
- PRD 必须覆盖 user goal、scope、non-goals、acceptance criteria；
- commit 并 push PRD 到 milestone branch；
- completed claim handoff 携带 PRD path、commit、repository、branch、Milestone title/number。

Checker criteria 增加：

- PRD 文件存在且内容完整；
- PRD commit 属于当前 milestone branch；
- remote branch 包含该 commit；
- 不要求 default branch 此时已包含 PRD。

这样不会再通过修改 local main 来满足下一节点 clean-tree 前提。

## 5. Issue Delivery 职责

### R4：implement 负责 commit/push

Instruction 必须明确：

```text
Implement the Issue, run the required implementation-level checks, commit the
Issue changes, and push the commit to the identified milestone branch before
claiming completed. Carry Issue URL, repository, branch and implementation
commit in handoffContext.
```

Checker criteria 与 instruction 对齐：

- Issue 要求实现完整；
- 必要实现级测试通过；
- implementation commit 存在；
- remote milestone branch 包含该 commit；
- handoff 身份完整。

在 A1 新语义下，未 publish 时 Judge `REJECT`，反馈返回当前 Actor 修正，不走 Graph `onFail`。

### R5：review

Reviewer 保持只读，不修改实现文件。

Instruction 增加：

- review 远端 milestone branch 上的明确 implementation commit；
- completed claim handoff 必须包含 Issue/repository/branch/commit；
- 若认为实现不正确，提交 `outcome: failed`，summary 写清 blocking findings。

Checker 确认 Reviewer claim 是否与 diff/Issue 一致。

### R6：test 负责测试报告发布

Tester instruction 明确：

1. 测试指定 implementation commit；
2. 创建 `docs/test-reports/<issue>-<slug>-test-report.md`；
3. 报告至少记录 Issue URL、repo、branch、commit、环境、命令、结果、隔离说明；
4. 将报告 commit 并 push 到 milestone branch；
5. completed claim handoff 携带 implementation commit、report path、report commit。

Checker criteria：

- 要求的测试已执行并通过；
- report 文件存在且内容完整；
- report commit 已在 remote milestone branch；
- 不允许把“tracked tree clean，但 report untracked”描述为已发布。

## 6. 默认分支集成与 Issue 关闭

### R7：complete-issue

Manager instruction 改为：

1. 读取 implementation/review/test handoff；
2. 按 repository policy 选择 PR merge 或直接 merge；
3. 确保远端默认分支通过 Git ancestry 可达 implementation commit 与 test-report commit；本版不以无法稳定判定的“内容等价”或未合并 PR 代替 commit 可达性；若仓库只允许 squash merge，必须先在 repository policy 中定义可机器验证的替代合同并另行更新本配置；
4. 必要 CI/branch protection 全部满足；
5. 只有在默认分支集成可验证后关闭 Issue；
6. claim handoff 携带 Issue URL、default branch、integrated revision/PR URL、closure state。

Checker criteria 必须验证：

- 远端默认分支包含交付内容；
- PR（若使用）已 merged，而非仅 open；
- Issue 已 closed/completed；
- milestone branch 仅 push 不能独立满足交付标准。

该设计允许仓库自行选择 PR 或 direct merge，但固定最终事实：“default branch contains delivery”。

## 7. Milestone 关闭

### R8：final-review

Reviewer review 的权威基线改为远端默认分支，而不是 feature branch：

- PRD acceptance criteria；
- Milestone Issues；
- 每个 Issue 的 integrated revision；
- default branch 的最终代码与测试报告。

Reviewer 无权关闭 Milestone，只提交 final-review claim。

### R9：close-milestone（新增）

类型：`actor-task`，role `manager`，位于 final-review onPass 之后。

Instruction：

- 确认当前 Milestone 0 open Issues；
- 确认 final-review accepted；
- 使用 Milestone number 调用 `gh api --method PATCH repos/{owner}/{repo}/milestones/{number} -f state=closed`（API 用 number；不得误用 `gh issue create --milestone` 的 title 语义）将 Milestone state 更新为 `closed`；
- claim handoff 携带 Milestone URL/number/title/state 与 default branch integrated revision。

Checker criteria：

- GitHub Milestone `state === closed`；
- `open_issues === 0`；
- 所有 required Issues closed/completed；
- 只有全部满足才 ACCEPT，随后 Graph onPass → END。

“default branch 满足 PRD”只由前一 `final-review` 负责，`close-milestone` 不重复做第二套可能漂移的产品验收。

只加强 criteria 而不增加执行节点不可行，因为 Judge/Reviewer 都是只读者，必须有 Manager 执行关闭动作。

## 8. Remediation 循环

`final-review` 的负面结果在 A1 语义下分两类：

- Reviewer claim failed + Judge ACCEPT：沿 `onFail: plan-remediation`。
- Judge REJECT Reviewer claim：返回 Reviewer 修改 review，不进入 remediation。

`plan-remediation` 必须通过显式 handoffContext 收到（Judge reason 沿协议上限最多 2000 字符）：

- Reviewer failed claim summary；
- Judge ACCEPT reason；
- blocking findings；
- PRD/Milestone/default branch identity。

该 handoff 由 A1 的 accepted-failed 路由组装，不依赖 Manager 从旧 Session 猜测 final-review findings。

Manager 创建 remediation Issues 后回到 issue-cycle。Milestone 在 remediation 完成和 final-review ACCEPT 前保持 open。

## 9. 非目标

- 不强制所有仓库只能使用 PR；允许 repository policy 决定 PR merge/direct merge。
- 不让 Reviewer/Judge执行 GitHub mutation。
- 不在配置中实现通用变量系统；身份继续通过 handoff 与现场检查获得。
- 不在本 PRD 修改 builtin program 的 git subprocess 行为。
- 不处理插件自举运行时验证；专用测试环境另行建设。

## 10. 验收标准

- **AC1 顺序**：root start 为 Manager `plan-milestone`，branch 初始化成功后才执行 `draft-prd`。
- **AC2 clean-tree**：新流程不要求 Manager 在 local main 上预提交 PRD 来满足 branch 创建。
- **AC3 PRD发布**：PRD commit 在 remote milestone branch。
- **AC4 instruction/criteria 一致**：责任矩阵中每个 checker 要求都有明确执行者。
- **AC5 implement发布**：未 commit/push 的 Developer claim 被 REJECT，并在同一 Node correction 中收到明确、可执行的 Judge 反馈。
- **AC6 Tester报告**：Tester 在 claim 前 commit/push报告，handoff 含 report commit。
- **AC7 默认分支集成**：feature branch 已 push但 default branch 不含实现时，complete-issue 不能通过且 Issue 不得关闭。
- **AC8 Issue关闭**：default branch 包含交付后 Issue 才 closed。
- **AC9 final-review基线**：Reviewer/Judge 检查远端默认分支。
- **AC10 Milestone关闭**：Milestone state 未 closed 时 workflow 不得 END。
- **AC11 remediation**：final-review accepted failed 时 blocking findings 能到达 plan-remediation。
- **AC12 配置验证**：更新后的 YAML 通过 strict schema/static validation，所有 Node reachable 且有 END path，child-workflow DAG 无环。
- **AC13 实际演练**：隔离仓库执行至少一个单 Issue milestone，最终默认分支包含实现、Issue closed、Milestone closed。

## 11. 建议配置评审清单

后续每次检查 `milestone-delivery.yaml` 时必须分别输出：

1. **Schema/Structure**：字段、ID、Edge、reachability、DAG。
2. **Responsibility coherence**：instruction 与 criteria 是否一致。
3. **Mutation authority**：产生副作用的要求是否分给有权限 Actor。
4. **Handoff completeness**：后续节点所需信息是否明确传递。
5. **Delivery semantics**：branch push、default integration、Issue close、Milestone close 是否分层清楚。
6. **Failure semantics**：Actor failed、Judge REJECT、NEED_CONTEXT、Program ERROR 分别如何处理。
