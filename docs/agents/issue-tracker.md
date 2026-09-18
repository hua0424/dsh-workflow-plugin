# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `hua0424/dsh-workflow-plugin`. Use the `gh` CLI for GitHub operations. Check the current clone's remote identity before acting; pass `--repo hua0424/dsh-workflow-plugin` explicitly rather than relying on the working directory.

## Conventions

Use non-interactive flags. For multi-line issue bodies, comments or PR descriptions, write the exact text to a temporary file and pass `--body-file`; preserve newlines and avoid shell interpolation. Do not print credentials or include sensitive logs in remote records.

```text
gh issue create --repo hua0424/dsh-workflow-plugin --title "..." --body-file <file>
gh issue view <number> --repo hua0424/dsh-workflow-plugin --json number,title,body,labels,state,url,comments
gh issue list --repo hua0424/dsh-workflow-plugin --state open --json number,title,labels,url
gh issue comment <number> --repo hua0424/dsh-workflow-plugin --body-file <file>
gh issue edit <number> --repo hua0424/dsh-workflow-plugin --add-label "..."
gh issue edit <number> --repo hua0424/dsh-workflow-plugin --remove-label "..."
gh issue close <number> --repo hua0424/dsh-workflow-plugin
```

Read precise issue/comment links and relevant fields first. Use appropriate filters; default list limits do not prove completeness. When claiming all matching issues or comments were checked, paginate through the whole relevant result set. Before retrying a write whose outcome is unknown, query GitHub to avoid duplicate resources or comments.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

## 项目约定

- 五类标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`；定义见 [triage-labels.md](triage-labels.md)。标签变更须符合当前授权与就绪事实；拆票本身不自动授予实施权限或覆盖人工暂停。
- 依赖使用 GitHub 原生 dependencies/blocked_by，并在正文保留一致的 Blocked by 引用；两处不一致先核实并修正，不把正文引用缺失当作没有依赖。
- Issue 规格及明确采纳的澄清提供范围依据。节点、角色、拆票顺序、审查方式、报告位置、PR/关票/合并时机按当前工作流冻结配置执行；无工作流时按用户任务及所选 skill，项目质量规范仍适用。
- 查询仓库现状并保护用户已有改动，不擅自覆盖、暂存或纳入提交。推送、关闭对象、合并和部署按当前有效授权执行，已有明确授权不反复请求确认；本地 commit、远端交付和运行环境部署是不同事实，汇报须分别准确。
- 需要追溯 #7 / T1–T9 重构的工单、实施顺序、证据与提交时，按需查 [runtime-refact.md](../work-plans/runtime-refact.md)。其中历史授权、分支和用户文件记录不构成当前任务的持续约束。
