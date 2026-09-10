# 待办：扩充 Judge 的受限仓库事实核验能力

GitHub 待办：[#18](https://github.com/hua0424/dsh-workflow-plugin/issues/18)。

状态：**已被 [#25](https://github.com/hua0424/dsh-workflow-plugin/issues/25) 取代（2026-09-10 用户确认），本轮不实施本文件的 typed 扩展**。Judge 工具面改为全量工具默认 + 可配置 deny list 后，`gh`/`git`/`pwsh` 等查询工具对 Judge 直接可见可用，本文件第 18 行的能力缺口随之消失；下面的 typed/enum 扩展、分页完整性验收与固定工具面安全检查不再作为验收项（收到关闭动作时以 #25 的说明为准）。

## 触发事实

milestone-delivery 的实现、决策和合并节点需要查询 PR base/head、合并状态、保护检查及提交祖先关系。

- ~~`src/roles/roles.ts` 的 JUDGE_ALLOW 为固定白名单，没有 shell、任意 HTTP 或 gh 工具。~~ 已由 #25 解除：`JUDGE_ALLOW` 白名单替换为默认 deny 清单（`JUDGE_DEFAULT_DENY`，定义在 `src/roles/roles.ts`），Judge 继承全量工具目录。
- `src/tools/tools.ts` / `src/index.ts` 的 inspection 只有 Git status/branch/remote/top-level 和 GitHub milestones/issues/milestone-issues。
- 当前 GitHub inspection 列表仅取 per_page=100 的一页，不能据此证明大集合完整性。
- ~~`judgeRole` 的严格 schema 不接受 tools 配置；改 YAML/persona 或换模型不能提供这些能力。~~ 已由 #25 解除：`judgeRole.tools.deny` 可配置（只收不能放），默认清单之外的查询工具默认可见。

## 待实施范围

优先扩展已有 inspection wrappers 的 typed/enum 操作，不给 Judge 通用 shell 或任意 URL：

1. PR 详情：仓库限定的 PR 编号、状态、base/head 分支及 SHA、merge commit/merged 状态。
2. 按确切修订查询必要的 CI/保护检查结果；不能把 pending、未知或权限失败当成通过。
3. 受限的提交比较/祖先查询，核对远端目标包含指定实现；限定仓库、合法提交标识与返回大小。
4. GitHub 列表完整性：受限分页，明确截断/错误元数据；达到上限时 NEED_CONTEXT，不声称“全部完成”。
5. 同步工具 schema、适配层、authz、类型和文档；保持 Judge 只读、当前 workspace/repository 约束，不扩大任意执行面。

## 验收

- Judge 可独立核验当前开放/已合并 PR 的确切修订、目标与必要检查，以及指定提交包含关系。
- 跨仓库、非法参数、非 Judge 身份拒绝；网络/权限/分页不完整均可辨识且 fail-closed。
- 所有新增操作有 focused tests；既有固定工具面安全检查和 PR 修订漂移场景回归通过。

## 当前替代流程

Judge 缺能力时 NEED_CONTEXT，列出缺失事实和对应仓库/PR/SHA。Manager 自行执行只读查询，在本次运行 `coordination.md` 追加查询时间、命令/API、原始关键结果、完整性/截断情况及结论；通过 `node_resume` 的 `resolutionContext` 提交必要证据（有有效 claim 时 target=judge）。

补充来源必须明确是 Manager 独立核验，不是 Actor 自述，也不宣称 Judge 亲自查询了远端。Judge 检查证据与当前修订、criteria 一致性；证据不足或修订已漂移则继续 NEED_CONTEXT。若当前 Actor 就是 Manager，不能把同一次 Actor 输出重新命名成独立证据；需要可独立读取的可信来源或用户核验，不足则保持 BLOCK。
