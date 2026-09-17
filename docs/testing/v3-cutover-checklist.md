# v3 停机切换交付/切换检查单

面向开发者与运维者的**操作性检查单**：把 `agent-workflow/v2` 的运行现场切换到
`agent-workflow/v3` 运行时，或在需要时回滚。方案依据 Issue #128 已确认决策 Q6
「方案 A」（结束旧 Run → 显式备份旧状态库 → 初始化新库；旧历史只留在离线备份里）。
使用者视角的说明见 [`docs/user-guide.md` §8](../user-guide.md)。

> **红线（本检查单不授权任何操作）**：本文件只描述步骤，**不授权**在真实 home
> （`~/.dsh`）、真实 Run、真实 catalog 或任何部署上执行切换、备份、归档、重置或
> 回滚。演练一律使用**隔离临时 home**；对真实 home 的任何一次操作都必须另外取得
> 用户明确授权，并逐条记录命令、时间与结果。本检查单也不表示 #133 已部署，或
> 曾经对真实 home 执行过切换。

## 0. 涉及的命令（必须真实存在）

```bash
/dsh-flow list                         # 列出 workflow（维护态下会给出 maintenance 诊断）
/dsh-flow start <workflow-id> [文本]   # 启动 Run
/dsh-flow status                       # 查看当前 workspace 的 Run 状态
/dsh-flow reset                        # 终止当前 workspace 的活动 Run（不取消外部动作）
/dsh-flow reset --incompatible-store   # 备份并退出整个不兼容 State Store（root 限定）
node scripts/check-state-rows.mjs <state.sqlite3 路径>   # 只读诊断（可加 --json）
pnpm run verify                        # 现行验收单入口：typecheck + 全量 suite + 两套受控 smoke
```

## 1. 切换前（旧版本）

- [ ] 确认本次切换的授权范围：临时 home 演练 or 已获明确授权的真实 home（写进记录）。
- [ ] 用**旧版本**插件结束或显式终止活动 Run：`/dsh-flow status` 确认现场，
      `/dsh-flow reset` 终止当前 workspace 的活动 Run（或让它按业务终局走完）。
- [ ] 确认**没有仍在运行的子代理会话**：Actor / Judge / 派发出的 subagent 都不该
      还有未结算的 turn。
- [ ] **人工核查外部操作**（终止 ≠ 取消外部副作用）：已 push 的分支、已开的 PR、
      已建的 issue、已改的文件、已发出的任何外部调用逐项确认——是接管、继续、还是
      明确放弃，都要有结论。
- [ ] 记住运行时固定理由文本：`terminated; external effects not cancelled`，不要把
      `reset` / `terminated` 当成“外部动作已取消”。
- [ ] 记录切换前现场：当前 catalog 文件版本/来源、`${DSH_HOME}/workflows/` 下的状态
      库文件名与大小、备份将要落地的位置。
- [ ] 显式备份旧状态库：用插件提供的显式路径（`/dsh-flow reset --incompatible-store`
      内置的备份；或经授权的复制）备份 `state.sqlite3`，**含 `-wal` / `-shm`**。
- [ ] 验证备份可用：能离线打开（sqlite）并读到预期表/Run，而**不是**一个空文件。
- [ ] 记录备份路径与校验结果；备份不成功就**停在这里**，不要继续。

## 2. 切换中（备份成功才初始化）

- [ ] 备份文件已确认可用后，才进入初始化步骤（顺序不可颠倒）。
- [ ] 初始化/切换由 **root 会话**执行：`/dsh-flow reset --incompatible-store`
      （该命令只接受这一个参数；带其他额外参数是用法错误）。
- [ ] **失败即停**：备份或归档失败时原库保持不动、不初始化新库——此时不要手工删除
      状态库、不要绕过失败信息继续；先读失败原因（原文会写明 `original store unchanged`
      / `original store restored`），再决定下一步。
- [ ] 确认归档目录 `state.sqlite3.archive-<时间戳>-<uuid>/` 与备份文件
      `state.sqlite3.backup-<时间戳>-<uuid>.sqlite3` 都已生成并记录路径。
- [ ] **隔离临时 home 演练**：以上全部步骤先在隔离临时 home 上完整走一遍，确认
      `list` 在切换前给 maintenance 诊断、切换后正常；演练环境不得指向真实 `~/.dsh`。

## 3. 切换后

- [ ] 新库可启动 v3：`/dsh-flow list` 正常列出 workflow，`/dsh-flow start` 能在一个
      最小 v3 catalog 上起 Run，`/dsh-flow status` 正常读状态。
- [ ] 旧历史**只在离线备份/归档里**：新库中查不到旧 Run；不提供旧历史查询入口，
      也没有自动历史合并或双协议混跑。
- [ ] 诊断用只读脚本：`node scripts/check-state-rows.mjs <state.sqlite3 路径>`——
      显式路径、复制成临时快照后只读打开、**不创建/不改写目标库**；对旧库只在
      快照副本上诊断。
- [ ] `pnpm run verify` 口径：按现行验收/环境 skip 规则通过（0 fail；仅允许环境条件
      skip，逐项口径见 [`runtime-refact-test-migration.md`](runtime-refact-test-migration.md)）；
      与真实 Host 检查分开报告，不混称。
- [ ] 记录切换结果：新库路径、运行时间、`verify` 结果、遗留问题归属（哪个后续票）。

## 4. 回滚（停机进行）

- [ ] **停机**：同 §1——先终止/结束 Run（`/dsh-flow reset`），核查子代理会话与外部
      操作已收尾。
- [ ] **保留新库备份**：回滚前先备份新库（含 `-wal` / `-shm`）并记录路径，不要直接
      覆盖；新库上跑过的 Run 只存在于这份备份里。
- [ ] **恢复与旧插件版本匹配的旧库与旧配置**：把旧状态库放回原位，catalog 回到旧
      版本能解析的格式（旧插件不读 v3 配置）。
- [ ] 明确不做的事：**不允许旧插件直接打开新格式库**；**不承诺自动合并**切换后
      两边的历史（回滚不会把新库期间的 Run 合并回来）。
- [ ] 回滚后复验：`/dsh-flow list` / `status` 回到旧版本预期行为，记录结论与遗留问题。

## 5. 不要做的事

- [ ] 不在 v3 运行时上加载 v2 catalog 期望它工作（不接受 v2 配置，也不会把 v2 的
      `failed` 猜测成业务结果）。
- [ ] 不把“维护态”当成自动迁移：旧库正常加载只进维护态并给诊断，不隐式切换、不
      静默改写/转换/清空；切换必须是 root 的显式命令。
- [ ] 不把 `reset` / `terminated` 当作外部副作用已取消。
- [ ] 不在没有授权的情况下触碰真实 home、真实 Run、真实 catalog 或部署；不在生产
      库上做双向（切过去又切回来）试验。
