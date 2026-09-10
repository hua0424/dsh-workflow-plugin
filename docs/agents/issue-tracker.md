# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `hua0424/dsh-workflow-plugin`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## 项目约定

- 可实施标签：`ready-for-agent`。拆票直接使用此标签，不再次 triage。
- 总规格 #7 与 T1–T9 子票均已完成并关闭；实施分支 `refact`。工单、证据和最终提交见 `docs/work-plans/runtime-refact.md`。
- 工单使用 GitHub 原生 dependencies/blocked_by 关系，并在正文保留相同 Blocked by 引用；只领取所有阻塞已完成的票。
- 每票记录起始 commit，实施后按该固定点审查本票差异；提交前的审查包含工作区变更，排除用户自有未提交文件。最终提交后复核 diff/commit 范围，发现修复纳入本票。
- Standards 与 Spec 使用独立并行审查；Spec 以当前子票为实施范围，总规格约束不得违背，后续票的未实现项不冒充当前票缺陷。
- T1–T5逐票验收/审查/提交；用户随后要求T6–T9实现完成后统一测试、双轴审查和最终提交。最终提交`c263e64a7d69d3bacb4936654aaa595951d1d3c5`后按依赖关闭#14/#15/#12/#16，再独立关闭父规格#7。
- 本地 commit 不等于 push。用户未授权推送/部署；不把 GitHub Issue 关闭描述为运行版本已经升级。
- 当前用户自有改动：`docs/example/workflow-template.yaml`；不修改、暂存或纳入本轮提交。
