# dsh-agent-team-workflow 使用手册

面向**使用者/运维者**的操作说明。配置编写细节见 `docs/example/README.md`，
术语的精确定义见 `CONTEXT.md`，设计与规格见 `docs/design/`、`docs/specs/`。

## 1. 插件是什么

在 DSH（deepseek harness）中运行可配置的**串行团队工作流**（`agent-workflow/v2`）：
一个 **Manager**（你当前会话）按工作单（work order）逐节点推进，每个节点把任务
派发给一个 **Role Actor**（continuable 子会话，跨节点复用），完成后由独立的
**Judge**（只读）核验 claim（ACCEPT / REJECT / NEED_CONTEXT），通过才进入下一
节点；全部节点完成即 Run 结束。

- 一个 **workspace**（canonical realpath）最多一个活动 Run。
- 状态存于 `${DSH_HOME}/workflows/state.sqlite3`（默认 `~/.dsh/workflows/`）。
- trace log 是 best-effort 派生产物，写在 `~/.dsh/workflows/<workflowId>/`，失败静默。

## 2. 安装 / 部署 / 升级

插件以 dev bundle（`wfdev`）形式部署在 web profile：

```bash
pnpm run build                 # tsc 编译到 lib/（部署前必须）
node scripts/deploy-web.mjs    # 部署到 ~/.dsh/profiles/web/wfdev
# 重启 DSH（dsh web）生效
```

注意：每次 build 后都要重跑 deploy；bundle 成员变更后必须重启 DSH。

**版本兼容提示**：dsh ≥ 0.1.1-rc.7 起 `compaction` 服务不再挂载在宿主平面，
插件已改为运行期按 agent 解析（`host.ts` 的 `compactionFor`），不要在模块级
inject 它，否则 `dsh web` 会永久 pending 卡死
（详见 `docs/pending-discussions/compaction-service-plane-after-presets.md`）。

## 3. 配置一个工作流

1. 复制模板：`docs/example/workflow-template.yaml` → `~/.dsh/workflows/<workflow-id>.yaml`
2. 文件名去掉 `.yaml` 即 workflowId，必须匹配 `[a-z][a-z0-9-]*`（拒绝 `.yml`）。
3. YAML 是受限单文档 1.2：禁止 duplicate key、anchor/alias/merge、custom tag、
   模板插值。invalid 文件**只阻塞自身**，`/dsh-flow list` 会给出诊断。
4. 角色模型路由用可选的 `model: { provider, modelId }` 块；角色可用
   `tools: { deny: [...] }` 收紧工具面。Judge 的工具面 = 全量工具目录减去
   （插件默认 deny 清单 ∪ `judgeRole.tools.deny`）；默认 deny 覆盖 `edit`/`write`
   与 Run 控制工具，`gh`/`git`/`pwsh` 等查询工具默认可用，详见
   `docs/example/README.md`「Judge 工具面」。

## 4. 命令：`/dsh-flow`

```
/dsh-flow list                        列出所有合法 workflow（含 invalid 诊断）
/dsh-flow start <workflow-id> [文本]  启动 workflow（附加文本交给 Manager）
/dsh-flow status                      查看当前 workspace 的 Run 状态
/dsh-flow reset                       终止当前 workspace 的活动 Run（不取消外部动作）
/dsh-flow reset --incompatible-store  备份并退出整个不兼容 State Store
/dsh-flow check <workflow-id>         静态检查该 catalog 各角色的 provider 是否已注册（只报告，不阻断）
```

- `check` 把 catalog 每个角色（含 Judge）的 `model.provider` 与当前
  profile 已注册 provider 清单做纯静态比对（无网络调用），逐角色输出
  OK/不可用 + 原因；不可用只报告，不影响正常加载与运行。未配置 model
  的角色视为运行时继承 Manager route，不报错。

- `start` 的附加文本会作为初始指令的一部分交给 Manager（比如本次目标）。
- `reset` 只是终止插件侧的 Run 状态，**不会**回滚 Actor 已经做过的外部动作
  （提交、PR、issue 等），处理前先人工确认现场。
- `--incompatible-store` 只允许 **root 会话**执行：即用户顶层聊天会话
  （无 parentSession、origin 不是 subagent、delegationDepth 为 0）；
  工作流 Actor / Judge / 子代理内执行会被拒绝。

## 5. 工作流控制工具（对话内使用）

| 工具 | 谁用 | 作用 |
| --- | --- | --- |
| `workflow_status` | 参与者 | 查看 Run 摘要；Manager 可分页查看关键历史 |
| `node_claim` | Actor | 提交当前节点的工作结果声明（无需 token，绑定派发 turn；必须是本轮最后动作） |
| `node_block` | Actor | 把当前节点置为 BLOCK 暂停（必须是本轮最后动作） |
| `node_resume` | Manager | 恢复 BLOCK 节点（target=auto/actor/judge，轮换新 nodeToken） |
| `node_run_program` | Manager | 为 builtin-program 节点提交 typed parameters 并运行 |
| `node_resolve_program` | Manager | BLOCK 的 program 节点现场检查后手工提交 PASS/FAIL |
| `workflow_set_role_model` | Manager | 给某 Role / Judge 切换模型（有活动 Actor 时拒绝） |
| `judge_respawn` | Manager | 重建当前节点的 Judge（drain 旧的 + spawn 新的） |
| `judge_claim` | Judge | 提交判定 ACCEPT/REJECT/NEED_CONTEXT（必须是本轮最后动作） |
| `workflow_inspect_git` / `workflow_inspect_github` | Judge | 只读检查 git / GitHub 现场 |

所有工具调用都会校验调用者身份（authz）：以 `workflow_status` 返回的最新
nodeToken 为准，不要缓存旧 token。

## 6. 运行中会发生什么

- 节点推进：Manager 派发 → Actor 工作 → `node_claim` → Judge 核验 →
  通过走 `onPass`，REJECT 以 reason 作为纠正指令重派同节点，NEED_CONTEXT
  由 Manager 补充材料后重判。`onFail` 可指向节点 id 或 `END`（#17 起）：
  FAIL→END 为业务终局——根 Run 状态沿用 `completed` 表示执行结束，终局
  业务结果由终局 claim outcome + handoff 表达（`workflow_status` 的
  `claimOutcome` / `finalHandoffPreview` 可见）；子流程 FAIL→END 返回父
  节点 `onPass`（对父读作 PASS，父只能经 handoff 文本感知失败）。
- Role Actor 是 continuable 子会话，跨节点复用；**节点边界**会对其做一次
  压缩（cold materialize → compactNow → dispose），token 得以受控。
- BLOCK：Actor 主动 `node_block`，或技术故障（Judge fault 等）自动进入；
  Manager 用 `node_resume` 恢复。
- Host 重启后 Run 可冷恢复：状态在 SQLite，会话在持久层，重进即可续跑。

## 7. 故障排查（FAQ）

### 7.1 `dsh web` 启动报 `pending (waiting for service: compaction)`

dsh 0.1.1-rc.7+ 把压缩后端移进每个会话 preset 的 isolate 域，宿主平面没有
这个服务；插件模块级 inject 它会永久 pending 并卡死整个 boot。本插件已修复
（见 §2 版本兼容提示）；若再次出现，检查部署产物是否为最新构建。

### 7.2 `/dsh-flow list` 报 maintenance mode（incompatible state format）

**原因**：`~/.dsh/workflows/state.sqlite3` 里的数据不是当前 v9 三表格式。
典型场景：旧版本插件（重构前单表 `workflow_state`）留下的真实数据——v9
按设计**拒绝迁移或覆盖**旧数据，进入维护模式保护现场（list/start/tools
全部禁用，直到 root 用户裁决）。

诊断特征：`user_version=0` 且表里有 `workflow_state`（旧单表格式）。

**恢复步骤**（确认旧 Run 不需要续跑后）：

1. 在**你自己的顶层会话**（不是工作流 Actor）执行：
   `/dsh-flow reset --incompatible-store`
2. 插件会：把旧库完整备份为
   `state.sqlite3.backup-<时间戳>-<uuid>.sqlite3`（可直接用 sqlite 打开），
   原始文件移入 `state.sqlite3.archive-<时间戳>-<uuid>/`，然后创建全新空
   v9 库。
3. 恢复后 `/dsh-flow list` 应正常列出工作流。
4. 注意：旧 Run 已产生的**外部效果**（PR、issue、分支等）不会被取消，
   需要时先去对应平台确认现场。

什么时候**不要**直接重置：如果旧 Run 的 `snapshot_json` 里有必须续跑的
现场——先用 sqlite 备份文件把 handoff/claim 文本取出来存档，再重置。

### 7.3 其他常见信息

- `resident actor busy`：节点边界压缩时 Actor 恰被外部唤醒，本轮压缩跳过
  （良性，下个边界再试）。
- `node-boundary compact failed: ...`：边界压缩的技术故障，Run 进入故障态，
  Manager 可 `node_resume` 恢复。
- `no compaction backend; boundary compact skipped`：目标会话的 preset 与
  宿主平面都没挂压缩后端，节点边界压缩被跳过（附 host 日志告警）；Run 继续，
  但 Role 会话上下文不再受控压缩。

## 8. 开发者快速参考

```bash
pnpm test            # 单测（node:test，直接跑 .ts 源码）
pnpm run test:e2e    # 隔离 e2e 冒烟（真实 engine + SQLite + stub 模型）
pnpm run build       # tsc 类型检查 + 编译
node scripts/deploy-web.mjs   # 部署（build 之后）
```

- 工单/进度：`docs/agents/issue-tracker.md`、`docs/work-plans/runtime-refact.md`
- 测试报告：`docs/test-reports/`；历史修复背景：`docs/prd/`
