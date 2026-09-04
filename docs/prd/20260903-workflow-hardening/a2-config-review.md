# A2 配置评审记录：milestone-delivery.yaml（v1 兼容版）

- 日期：2026-09（PRD 20260903-workflow-hardening A2 落地时）
- 评审对象：`${DSH_HOME}/workflows/milestone-delivery.yaml`（= 本目录 `milestone-delivery.yaml`，definitionHash `7961a32a…`）
- 评审方式：按 A2 §11 清单分六项输出；schema/static 由插件自身代码校验，其余为人工语义评审

## 1. Schema / Structure（自动校验）

`node scripts/validate-catalog.mjs <file> milestone-delivery` 通过：

- 受限 YAML 1.2 解析（无 duplicate key / anchor / alias / merge / tag）；
- 严格 zod schema（`agent-workflow/v1`）；
- 静态校验：root startNode `plan-milestone` 为 manager actor-task；所有 node id / role / programId / checkerId 合法；所有 onPass/onFail 目标存在；全部节点可达；每个 workflow 有 END path；child-workflow 引用 DAG 无环。
- 线上 catalog 目录整体扫描 `diagnostics: []`（smoke-test 不受影响）。

结构：root 8 节点（plan-milestone → initialize-milestone → draft-prd → plan-issues → run-issue-cycle → final-review → close-milestone → END；final-review/close-milestone onFail → plan-remediation）；child `issue-cycle` 3 节点；child `issue-delivery` 4 节点。

## 2. Responsibility coherence（责任矩阵）

每个 checker 要求的可变事实都有明确执行者；Reviewer/Judge 只读：

| Node | Actor 被明确要求执行的动作 | Checker 验证的事实 | 一致 |
|---|---|---|---|
| plan-milestone | Manager 只规划 title/branch，不改文件/不建 GitHub 对象；handoff 带 repo/title/branchName/goal | goal 清晰、身份字段非空；不要求 PRD/branch 已存在 | ✅ |
| initialize-milestone | builtin program 建/核实 Milestone + local/remote branch；要求 clean tree | program 自身返回 PASS/FAIL | ✅ |
| draft-prd | Manager 在 milestone branch 上写 PRD 并 commit+push | PRD 存在且完整；PRD commit 在 remote milestone branch；不要求 default branch | ✅ |
| plan-issues | Manager 建 Issues（gh 用 title 语义）；handoff 带 milestoneTitle/Number | Issues 覆盖 PRD 且 actionable；handoff 身份完整 | ✅ |
| final-review | Reviewer 只读 review 远端 **default branch**；claim completed 并在 handoff 记录 satisfied/finding | default branch 满足全部验收标准 + Issues 全 closed 才 PASS，否则 FAIL → remediation | ✅ |
| close-milestone | Manager 用 `gh api PATCH …/milestones/{number} -f state=closed` 关闭 Milestone | Milestone state=closed、open_issues=0、Issues 全 closed | ✅ |
| plan-remediation | Manager 把 handoff 中的 blocking findings 转成 remediation Issues | 每条 finding 被未完成 Issue 覆盖 | ✅ |
| implement | Developer 实现 + 实现级检查 + commit + push milestone branch | 实现 commit 在 remote milestone branch | ✅（修复原 instruction/criteria 矛盾） |
| review | Reviewer 只读 review 指定 commit，handoff 记录 approved/findings | diff 满足 Issue 无 blocking 问题才 PASS | ✅ |
| test | Tester 测试指定 commit + 写报告 + commit + push 报告 | 报告 commit 在 remote milestone branch；untracked ≠ published | ✅（修复原报告发布责任真空） |
| complete-issue | Manager 按 policy merge 到 default branch， ancestry 可达两个 commit 后才关 Issue | default branch ancestry 可达 + PR merged + Issue closed；branch push 不足以 PASS | ✅（修复原“push 即交付”漏洞） |

## 3. Mutation authority

产生副作用的动作全部分配给有权限的 Actor：建 branch/Milestone（builtin program，Manager 触发）、PRD commit/push（Manager）、实现 commit/push（Developer）、报告 commit/push（Tester）、merge/关 Issue/关 Milestone（Manager）。Reviewer `tools.deny: [edit, write]` 且 persona 明确禁止 push/mutate；Judge 只读不变。

## 4. Handoff completeness

- select-next-issue → issue-delivery：Issue URL + repository + milestone branch + milestone number；
- implement → review → test → complete-issue：逐级携带 Issue/repository/branch/commit（+ report path/commit）；
- plan-milestone → initialize-milestone：title + branchName（program typed 参数）；
- final-review FAIL → plan-remediation：**v1 关键设计**——`failed` claim 的 handoffContext 会被引擎丢弃、Judge reason 也不回传（A1 缺口），因此 final-review/review/test 一律以 completed claim 提交评审结果，把 satisfied/approved/findings 写进 handoffContext，使 FAIL 路由后 findings 仍能到达 remediation/implement。

## 5. Delivery semantics 分层

branch push（implement/test）→ default branch 集成（complete-issue，Git ancestry，squash-only 显式排除）→ Issue closed → Milestone closed（close-milestone）→ END。Milestone 未 closed 时 workflow 无法 END（close-milestone 是 END 前唯一必经节点）。

## 6. Failure semantics（v1）

- Judge FAIL → onFail 边：implement/review/test/complete-issue → implement 重试；final-review/close-milestone → plan-remediation；
- 无 onFail 的 FAIL（initialize-milestone、各 checker 未列 onFail 的 program FAIL）→ BLOCK；
- Program ERROR / Judge 技术故障 / NEED_CONTEXT → BLOCK（引擎现有行为）；
- 已知限制（A1 范畴）：Judge FAIL reason 不回传 Actor，重试 Actor 只收到自己上一轮 handoff；本版用“handoff 携带 verdict/findings”缓解，完整 correction feedback 待 A1。

## 7. 遗留与后续

- A1 落地（REJECT 语义 / dispatch lease / failed-handoff 路由）后，本配置需同步升版：final-review/review/test 可改回 `failed` claim 语义，删除 handoff-verdict 规避设计。
- AC13 真实隔离仓库演练待 Phase 3 执行。
