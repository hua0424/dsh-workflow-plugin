# Workflow Policy 决策落盘追踪复核

## 1. 复核结论

复核基准是本次会话确认的 32 个 Policy 设计决策簇，以及之后确认的受控热重载修订。

最终结果：

```text
完整落盘       32 / 32
热重载修订      完整落盘
缺失            0
部分落盘        0
未解决冲突      0
```

早期“任意 Policy 字节变化都废弃 Parent”的规则已被后续确认的热重载决策正式取代，不属于遗漏。

## 2. 决策追踪矩阵

| # | 已确认决策 | 权威落盘位置 | 结果 |
|---:|---|---|---|
| 1 | Policy 是固定 Workflow Definition 上的受限 Profile，不是状态机 DSL 或 LLM Model selector | Policy §2、§3.1 | 完整 |
| 2 | Policy 不能关闭、跳过、重排或降低强制 Review、测试、SHA、串行和交付保障 | Policy §3.2 | 完整 |
| 3 | v1 不开放 optional Child 或可接受失败终态；未开始 Child 只能经固定取消 transition 处理 | Policy §3.3 | 完整 |
| 4 | 固定路径唯一完整 Policy；无 Registry、选择、继承、overlay、仓库 override 或启动 override | Policy §3.4 | 完整 |
| 5 | Manager Turn 边界检测配置；无完整 snapshot；临时不可读进入 recovery；不兼容变化 abandoned 且不清理产物 | Policy §3.5 | 完整，已按热重载修订 |
| 6 | 不使用 policyId 或人工 revision 作为变化权威 | Policy §3.6、§3.23 | 完整 |
| 7 | 仅受限 YAML 1.2；拒绝 duplicate key、anchor/alias、merge、tag、多文档、YAML 1.1 bool、模板和脚本 | Policy §3.7 | 完整 |
| 8 | Strict Schema、无隐式转换、未知字段失败、引用/集合约束、独立错误汇总、默认值版本稳定 | Policy §3.8 | 完整 |
| 9 | Static Validation 与 Environment Preflight 分离；三个 Workflow 阶段加 reload 定向 preflight | Policy §3.9 | 完整 |
| 10 | 一个 Policy 对应一个 Product Workspace、一个伞仓、固定 Catalog、共享 baseline 和完整交付顺序 | Policy §3.10 | 完整 |
| 11 | Workspace Root 来自 Manager cwd；代码仓来自 `.gitmodules`；路径和 GitHub identity 由环境推导 | Policy §3.11 | 完整 |
| 12 | Catalog 是显式 allowlist；deliveryOrder 是 Catalog keys 的完整无重复排列 | Policy §3.12 | 完整 |
| 13 | repositoryKey 等于 submodule name；workspace 统一 baseline；remote alias 默认 origin，可每仓覆盖 alias | Policy §3.13 | 完整 |
| 14 | 分支只开放五类 prefix；稳定 ID、后缀和类型映射由 Workflow Definition 固定 | Policy §3.14 | 完整 |
| 15 | Manager-owned 只作用于伞仓非代码路径；精确目录和受限最终 segment `*`；固定拒绝目标优先 | Policy §3.15 | 完整 |
| 16 | 固定四个 Role Agent key；Manager 隐式；职责和 action/Gate mapping 不可配置 | Policy §3.16 | 完整 |
| 17 | Role Agent definitions 全部内联；continuable、direct-child topology、depth 和授权由引擎固定 | Policy §3.17 | 完整 |
| 18 | 可选 tools.deny 直接映射 DSH toolFilter；无 allow-list/独立权限层；Host authorization 最终裁决 | Policy §3.18 | 完整 |
| 19 | model 整块可省略后继承 Manager；显式 block 三字段必填；subagentProvider 默认 spawn；persona 必填 | Policy §3.19 | 完整 |
| 20 | 无 Validation Profile Registry；每仓唯一 unit test definition；workspace 唯一 integration definition | Policy §3.20 | 完整 |
| 21 | 结构化、稳定排序、可汇总、无 secret/persona 泄漏且不 auto-fix 的 diagnostics | Policy §3.21 | 完整 |
| 22 | Policy 固定在 `<cwd>/.dsh/workflow-policy.yaml`；不搜索、不接受 path override、Agent 只读 | Policy §3.22 | 完整 |
| 23 | State Store 保存当前 accepted source/semantic hashes、schema/Definition 版本和伞仓 identity；reload 只追加 bounded recentEvents 摘要，不保留 append-only 历史 | Policy §3.23 | 已按个人单会话 State Store 简化修订 |
| 24 | 精确 `schemaVersion: workflow-policy/v1`；不迁移、猜测、降级；Definition compatibility 独立版本化 | Policy §3.24 | 完整 |
| 25 | artifacts.directory 必填且自动 Manager-owned；唯一权威文档是固定 PRD；不镜像 GitHub/Workflow State Store 事实 | Policy §3.25 | 完整 |
| 26 | GitHub credential 属于 Host runtime，不进入 Policy/hash；轮换不废弃 Parent | Policy §3.26 | 完整 |
| 27 | v1 无顶层通用 runtime/retry/timeout；各专项拥有自己的时序语义 | Policy §3.27 | 完整 |
| 28 | origin、spawn、空 deny/ownership 和五类 branch prefix 使用 schema 固定安全默认值 | Policy §3.28 | 完整 |
| 29 | 顶层固定八字段；只有 branches 和 ownership 可整体省略 | Policy §3.29 | 完整 |
| 30 | 每个 Manager Turn 完整加载一次，不跨 turn 缓存；Role Actor turn 不独立加载 | Policy §3.30 | 完整 |
| 31 | v1 不增加自定义 Parser 文件大小、深度、节点或列表资源上限 | Policy §3.31 | 完整 |
| 32 | Parent 创建前 preflight 失败只拒绝启动；创建后可修复环境失败进入 recovery；最终阶段使用领域路由 | Policy §3.32 | 完整 |
| 33 | 热重载白名单、semantic hashes、定向 preflight、atomic accepted-hash 推进、stale Actor replacement、evidence 保留 | Policy §3.5、§3.19、§3.23、§3.30、§5 | 完整 |

## 3. 热重载最终语义

```text
source-only change
→ 原子推进 accepted policySourceHash
→ 不替换 Actor

reloadable change
→ Static Validation
→ 定向 Environment Preflight
→ 确认受影响 Actor 无运行 turn
→ 原子推进 accepted hashes
→ 标记 stale-policy-reload
→ 下次派发前 replacement

continuity change
→ abandoned(policy-incompatible-change)
→ STOP
```

Reloadable 白名单仅包括：

```text
team.<role>.subagentProvider
team.<role>.model
team.<role>.persona
team.<role>.tools.deny
ownership.managerOwned.files
ownership.managerOwned.directories
```

不新增通用 per-role writable paths。

## 4. 本次复核发现并修正的问题

1. 明确 active Parent 遇到显式不同 schemaVersion 时 abandoned；缺失/类型错误/YAML 失败时 recovery，消除优先级冲突。
2. 将全 Catalog `.gitmodules` 结构检查与 affected repository checkout/remote/baseline 检查分阶段，避免未涉及仓库阻塞。
3. 将 reload 定向 preflight 加入完整 preflight 契约和跨文档不变量。
4. 删除 corrective Child 的 per-child Policy 暗示，明确精简流程来自固定 Workflow Definition。
5. 重新强调 Gitlink 只能由专用 Host effect 更新，不属于普通 Manager-owned 路径。
6. 将最终交付恢复中的验证从“默认完整”修正为 v1 强制整体 Review 和完整集成测试。
7. 修正 Trusted Actor 中 continuable mode、固定角色、Actor 全生命周期复用和未来角色拆分的旧措辞。
8. 将测试复盘和 test-maintenance Child 标为未来提案；首期阻塞测试修改使用现有 remediation 和固定失效规则。
9. 明确接受 reload 不会自动清除已有 recovery cause。
10. 补齐 replacement 失败不回滚新 Policy、不恢复 stale Actor、进入 recovery 的规则。
11. 修正 `repositories.deliveryOrder` 和 Workflow Definition 术语等局部命名。
12. 将 abandoned 分支在加载流程图中明确标为终止，不会继续产生本轮 Validated Policy。
13. 消除 final-delivery conflict recovery 流程中重复执行 Milestone Aggregate Code Review 的步骤。

## 5. 跨文档一致性

以下文档已经同步：

- `docs/design/workflow-policy-dsl-static-validation.md`
- `docs/design/parent-child-workflow-instances.md`
- `docs/design/trusted-actor-role-binding.md`
- `docs/design/workflow-state-store.md`
- `docs/pending-discussions/automated-testing-and-test-learning.md`
- `CONTEXT.md`

实际 `.gitmodules` URL、当前 submodule checkout 和被检查的 DSH 源码路径属于设计依据，不是 Policy schema 字段，因此没有硬编码进 Policy 设计。

## 6. 仍明确延后的专项

以下内容不是漏项：

- Validation Definition 的 runner/command/evidence 内部 schema；
- Static Validator 与 Environment Preflight 完整错误码；
- GitHub/Git/Provider adapter 级检查细节；
- Role Agent 和 Workflow tool/action 最终名称；
- 当时尚未讨论的本地持久化后来已按个人单会话前提简化为极简 SQLite Workflow State Store；具体见 `docs/design/workflow-state-store.md`；
- Web UI workflow-active 交互。

## 7. 版本控制状态

原始 Policy 决策复核时这些文件尚未跟踪；随后已在提交 `97a8b9f` 与 `3786eba` 中建立基线。当前个人单会话 Workflow State Store 精简及关联文档同步仍是未提交工作区改动，提交或 push 需要后续单独执行。
