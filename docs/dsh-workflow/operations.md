# 工作流操作与历史排障备忘

本文件按遇到的问题查阅，不是每次派发的必读合同。下列命令行为、沙箱现象、API 形状与插件能力来自历史运行记录，未在本次文档修订中重新验证；先检查当前工具响应、版本、权限及相关 Issue 状态。历史问题不表示当前仍然存在，历史替代步骤不构成新增外部操作授权。

## gh CLI 操作备忘（真实 Run 踩坑沉淀）

- `gh issue edit --milestone` 接受**标题**而非编号（`--milestone 9` 报 not found，须 `--milestone 'prompt-slim-protocol-single-source'`）。
- REST 过滤 `gh api "issues?milestone=<N>&state=all"` 在部分环境返回空数组（工具怪癖，非数据缺失）；用 `gh issue list --milestone <标题>` 或 search API 双路补偿后再下完整性结论。
- sub-issue API（`POST issues/<parent>/sub_issues`、`GET .../sub_issues`）响应体是**数组**；`--jq '.[].number'` 对空数组返回空而非错误，勿据单次输出误判挂载失败，需 GET 复核。
- 无 CI 仓库的合并前曾使用的检查线索：`gh pr checks <n>` 无 checks、分支保护 404、`/rulesets` 空。404 也可能与权限有关；须确认查询权限、适用的仓库/组织规则及分页完整性，再结合批准 head 上的回归结果判断是否无适用检查，不能机械套用。
- DSH 沙箱下曾遇到 `git push` 因 named pipe 限制挂掉 credential helper（`failed to execute prompt script (exit code 66)` / `couldn't create signal pipe, Win32 error 5`）。历史建分支替代通道：`gh api --method POST repos/<owner>/<repo>/git/refs -f ref=refs/heads/<branch> -f sha=<确切SHA>` 创建远端分支，再 `git fetch origin <branch>` + `git branch --set-upstream-to=origin/<branch> <branch>` 绑定；仅在提交对象已存在远端时可创建引用，不等同于上传本地提交，`git ls-remote` 复核 SHA。
- 禁止 `https://x-access-token:<token>@github.com/...` URL 注入式推送：凭据会进入 URL、进程参数或远端 config，有泄露面。使用已授权的正常认证方式或经核验的替代通道，不为省事绕路（反例：run 20260913-114026 的 #54/#55 推送）。
- 沙箱下经 `gh api` Git Data 发布**提交**（上两条只覆盖建分支）的五个坑：①blob 内容必须取 git 对象（`git show <sha>:<path>`），不取工作树字节——行尾规范化会致 SHA 不符；②含子目录的改动须自底向上递归建 tree；③`POST /git/trees` 省略 `base_tree`、提交完整条目表——带 `base_tree` 且 path 含斜杠会生成顶层扁平条目；④commit 的 parents 必须取远端 head，否则 `Update is not a fast forward`；⑤`gh api --input` 传多行 message 用 `` -join "`n" `` 构造。先例：run 20260913-205854 的 issues/24、issues/30 delivery.md。以上发布步骤已固化为 `scripts/push-via-api.mjs`（issue #84，仓库无关单文件，逐 blob SHA 校验 + tree 级等价核验 + dry-run）：能用脚本时直接 `node scripts/push-via-api.mjs <localRef> <remoteRef>`，本条保留为排障文档。
- 历史 gh api 发布曾产出与本地提交**同 tree 不同 SHA** 的孪生 commit；当时本地分支未回齐而显示为"未合并"（幻影分支）。先 fetch 并核对远端对象。`git diff --quiet origin/<branch> HEAD` 仅比较提交内容，不证明工作树或暂存区干净，也不保护本地历史；不得据此直接 `git reset --hard`。确需回齐时先检查工作树/暂存区、识别用户改动、保存本地提交及必要备份，再由 Manager 按授权安排操作。reset --hard 可能丢失未提交内容，并可能删除阻挡写入的未跟踪路径。反例：run 20260913-205854 遗留的本地 54900af/dc2fdce/a40706a。

## 历史事故与能力登记（按需核对）

- [#54：空回合安全闭合误伤并行子代理等待](https://github.com/hua0424/dsh-workflow-plugin/issues/54)：并行子代理等待期的无工具回合被结算为 `not safely closed` 自动 BLOCK 并解除 claim 绑定；触发后 Actor 无法自恢复，需 Manager `node_resume` 兜底（run 295ad986 先例：coordination.md 2026-09-12 节）。
- [#55：node-boundary compact 失败无降级](https://github.com/hua0424/dsh-workflow-plugin/issues/55)：长会话角色派发时 compact 摘要无法再缩小即 BLOCK；Manager 可 `workflow_set_role_model` 切换更强模型后 `node_resume` 恢复（run 295ad986 先例：coordinator 切 glm-5.3 后一次成功）。
- [#17：onFail END](https://github.com/hua0424/dsh-workflow-plugin/issues/17)：历史记录为已实施并部署。原配置使用两处 `onFail: END`：根流程 `grilling.failed → END`（用户取消终局，Run 状态沿用 completed，终局结果由终局 claim outcome + handoff 表达）；子流程 `select-next-issue.failed → END`（任务穷尽，pop 后落父节点 onPass 进入集成，父只能经 handoff 感知穷尽事实）。终局语义见 [登记材料](../pending-discussions/onfail-end.md)。
- [#18：Judge inspection](https://github.com/hua0424/dsh-workflow-plugin/issues/18)：历史登记缺 PR/CI/提交关系查询和列表完整性支持；先由 Manager 按 coordination 合同补证，不通过放宽为 Actor 自报来绕过核验。见 [登记材料](../pending-discussions/judge-repository-inspection.md)。



## 材料路径事故

- issue #24 O5：曾把交付文件写到 runDir 外的 docs/dsh-workflow/issues/17/，由 Manager 迁移。执行时应按当前运行入口给定的绝对路径定位，不能相对 cwd 猜测。

