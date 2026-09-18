# coding-workflow 使用说明

`coding-workflow` 是单仓、两级 PR 的 `agent-workflow/v3` 工作流。配置见 [coding-workflow.yaml](../example/coding-workflow.yaml)，业务合同见 [coding-workflow-contract.md](coding-workflow-contract.md)。保留独立审查与裁决，以及原角色和模型选择；不覆盖原 `milestone-delivery` 配置及合同。

## 启动前

本次迁移时的只读检查（2026-09-17）：仓库主线已支持 v3，但 `C:/Users/hua/.dsh/profiles/web/wfdev/lib/types.js` 仍声明 v2/v9。该记录不是实时状态，启动前须重新确认实际加载的插件；本次只新增配置，不部署插件或切换状态库。

1. 确认实际运行的插件支持 v3；仓库代码更新不代表 DSH 已部署新插件。仍使用旧格式状态库时，先按 [升级手册](../user-guide.md#8-v3-升级与回滚停机切换)结束旧 Run、停止运行环境并显式备份后新建库。配置安装本身不执行部署、切库或恢复旧 Run。
2. 在目标仓库根启动，确认工作区及 GitHub 仓库身份。该配置引用 `docs/dsh-workflow/` 下的 INDEX、本工作流合同及 review-contract；在其他项目使用时先提供这些通用入口与本工作流适用合同，并按项目调整配置。具体角色、节点和两级 PR 规则只由本工作流合同规定。
3. 将配置以 `coding-workflow.yaml` 放入实际 catalog 目录，用 `/dsh-flow list` 确认识别，再用 `/dsh-flow start coding-workflow` 启动。配置文件新增不等于已有 Run 被迁移；同一 workspace 的旧 Run 须先结束。

## 运行材料

Manager 在初始化阶段建立 `docs/dsh-workflow/runs/<YYYYMMDD-HHmmss>-coding-workflow-<slug>/run.md`，保存本合同、INDEX 和 review-contract 内容副本，记录原路径、版本、哈希及副本绝对路径。后续角色从 handoff 找入口并读取冻结副本；这一步由工作流执行，插件不会自动复制外部文档。

运行产物保留在 ignored 目录，重要结论与精确修订摘要同步对应 Issue/PR。仅创建实际使用的材料；初始化前明确取消不要求先建立目录、Milestone 或 Issue。

## 路由与验收

正常路径：初始化 → 规划 → 选票 → 实现 → 审查 → 裁决 → 合并关票 → 再次选票；任务穷尽后进入集成准备 → 集成审查 → 裁决 → 集成交付。

单票裁决需要修改时返回实现；集成裁决需要修改时进入补救规划、开发循环，再回到集成。初始化明确取消则直接返回 cancelled。

Actor 用 `node_claim({ result, handoff })` 提交当前节点合法的命名结果；Judge ACCEPT 后才走相应业务边。REJECT 留在当前节点修正；缺信息时 NEED_CONTEXT/BLOCK 后补证。子流程通过显式返回值映射推进。

选票穷尽以实施任务和聚合任务完成为条件，允许留下已登记的主 Issue 集成验收项供集成阶段完成；不能把未完成实现伪装成集成验收。单个 Issue 也执行当前集成 PR 的审查和裁决，批准必须对应当前 base/head。具体证据、轮次、重入与合并约束以工作流合同为准。

最终业务返回 `delivered` 或 `cancelled`，分别表示交付与取消；completed 运行状态不单独证明交付成功。
