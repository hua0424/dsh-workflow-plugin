# #129：coding-workflow 新建配置与合同迁移验收

日期：2026-09-17。用户调整范围：保留原 milestone-delivery，新建 coding-workflow。主线起点 `ec14009`；本轮仅新增配置、专属文档、测试和本报告，未实施插件代码、提交、推送、部署或状态库切换。

## 交付

- 仓库配置：`docs/example/coding-workflow.yaml`。
- 新增 catalog：`C:/Users/hua/.dsh/workflows/coding-workflow.yaml`，以 CreateNew 写入，无覆盖；与仓库配置逐字节一致。
- 专属合同：`docs/dsh-workflow/coding-workflow-contract.md`；说明：`docs/dsh-workflow/coding-workflow.md`。
- 受控回归：`test/coding-workflow.test.ts`。

沿用实施时最新原配置的角色、模型、两级 PR 和独立 reviewer/review-judger。14 个节点迁移为 v3 results/onReturn；Root 返回 delivered/cancelled，开发循环返回 exhausted，单票交付返回 delivered。保留用户已经修复的主票集成验收分类与单票集成必审，不引入额外节点或跳审捷径。

persona 保留 system 层职责、权限和提交收口纪律，不重复硬编码工具参数；结果的强制验收条件由实际 v3 派发。通用 INDEX 无需改变，新流程只引用新专属合同，并保存自己的合同内容副本及独立 runDir。

## 验证结果

- 实际 parseCatalogConfig + validateAndNormalize：通过，0 警告。
- 实际 scanCatalog 只读加载用户 catalog：coding-workflow 为有效 v3 条目，目标诊断为空；没有读取/修改状态库。
- 定向 7/7：真实 WorkflowEngine、临时 SQLite、受控 Host/模型判定。覆盖单票、多票、主票待集成验收的路由、单票返工、集成返工、初始化取消、穷尽后仍进入集成、非法结果与 Judge REJECT 不绕批准，以及旧协议/非法 Child 映射拒绝。
- `pnpm run verify`：typecheck 通过，425/425 tests，0 fail、0 skip；T3 与 E2E 受控 smoke 通过。首轮沙箱内已有 git 派生进程测试遇 EPERM，在允许派生进程环境重跑上述全量后通过，未跳过失败。
- 自然语言合同经审查：两处裁决共同 criteria 补齐逐项处置依据、延期必要授权/后续入口、范围/授权争议边界、当前开放状态和远端摘要；原发现复查已解决。Standards 无必须修项；文档作者复核与独立 YAML/Spec 审查分别记录，不冒称全程独立。
- 原 catalog、INDEX、原 milestone-delivery 专属合同、review-contract、operations 共 5 个文件在本轮前后 SHA-256 相同。

测试中的 Actor/Judge 业务判断为脚本控制，未调用真实模型、GitHub 或真实 DSH Host；不证明自然语言条件会被模型完美执行，也不冒称完成了真实 PR 交付。父 Issue 的远端状态/关闭依据属于合同审查范围，受控测试验证其允许的路由，不伪造远端业务验收。

## 启动前提与操作清单

本次只读核查的 `C:/Users/hua/.dsh/profiles/web/wfdev/lib/types.js` 仍声明 `agent-workflow/v2` / `agent-workflow-state/v9`。仓库已交付 v3 不等于该安装目录已更新；需要在授权维护窗口完成 v3 部署、旧 Run 收尾和适用的状态库备份切换，再检查实际加载版本。

1. 确认目标 workspace 与当前实际插件/状态格式，按 v3 用户手册完成需要的停机切换；不把 reset 当作取消全部外部操作。
2. 原 milestone-delivery 文件保留。v3 catalog 会将旧 v2 文件报告为无效，但按逐文件隔离规则不阻塞有效的新配置；本轮不代用户修改或删除它。
3. 从目标仓库根运行 `/dsh-flow list` 确认识别，再按用户授权启动 `/dsh-flow start coding-workflow`。
4. 新 Run 建立带 coding-workflow 名称的运行目录；不复用旧流程目录或冻结快照。在其他仓库使用前需提供新流程引用的合同与通用材料入口。

未启动真实工作流，未改原配置/合同，未部署 wfdev，未触碰真实 SQLite。本轮验证期间另有来源于其他工作的生产源码/测试改动，未归入本轮交付；全量结果对应验证时工作树。
