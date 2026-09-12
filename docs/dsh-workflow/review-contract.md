# 审查与决策文件合同（rNNN-review / rNNN-decision）

本文件承载 rNNN-review.md / rNNN-decision.md 的详细格式合同，从 INDEX.md 拆出以控制首读成本；code-reviewer、review-judger 首次执行与轮次有疑义时读取。INDEX.md 保留最小规则摘要。

## rNNN-review.md — code-reviewer 写

至少包含：

- PR URL、轮次、observedAt、baseBranch/headBranch、完整 baseSha/headSha、mergeBaseSha（区分 PR base tip 与 diff 起点）。
- 范围与方法：Issue 验收入口、精确 diff、检查过的证据、未核实项。
- 发现列表：稳定编号如 r001-F1、位置/证据、影响、建议；没有发现明确写“无”。
- 建议结论（非正式 GitHub approval）、上轮必修项的复核状态。

默认审查固定 base/head 的完整 PR diff。仅当 base 未变、head 是上轮 head 的后继且旧发现全部可追踪时，允许增量审查；仍须复核旧必修项。分支/base 漂移、范围改变或材料不足时重新确定完整范围，不能继承旧批准。

## rNNN-decision.md — review-judger 写

至少包含：对应 review 路径与同一 PR/base/head；每项发现的核实结论、处置（本次修复/延期/不成立）和理由；剩余必修清单；批准或返工结论。修复复杂不是延期阻断问题的理由；范围外争议交 Manager。通过才记录 approvedBase/approvedHead，返工不保留有效批准。

## 轮次规则

- 轮次按对象分别从 r001 递增。先读取上一轮，再固定本轮，不能把刚写的本轮当作上一轮。
- 相同 PR/base/head 且任务未改变的重入复用原轮次；补充/纠错注明时间和原因，保留旧结论。
- 不同修订（head 或 base 变化）开新轮次。
- 即使报告很短，也保留 review 与 decision 两个最小文件，使后继与重入有固定入口；handoff 只摘要和引用。

## 决策同步与失效

- 决策摘要同步至对应 PR；集成决策同时同步主 Issue。评论包含远端可读的关键结论与修订信息，不只有本地文件路径。
- 变更实现、PR head 或批准 base 后，原批准失效；合并前发现漂移时 BLOCK，由 Manager 安排重新审查和决策，补充证据不能代替新修订的专业评审。
