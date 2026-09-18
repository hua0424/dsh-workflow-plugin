# dsh-agent-team-workflow 使用手册

面向**使用者/运维者**的操作说明。配置编写细节见 `docs/example/README.md`，
术语的精确定义见 `CONTEXT.md`，设计与规格见 `docs/design/`、`docs/specs/`。

## 1. 插件是什么

在 DSH（deepseek harness）中运行可配置的**串行团队工作流**（`agent-workflow/v3`）：
一个 **Manager**（你当前会话）按工作单（work order）逐节点推进，每个节点把任务
派发给一个 **Role Actor**（子会话，默认节点级复用，可配置为跨节点复用），完成后由独立的
**Judge**（只读）核验 claim（ACCEPT / REJECT / NEED_CONTEXT），通过才进入下一
节点；全部节点完成即 Run 结束。每个节点声明有限的**命名结果**（各有自己的验收条件
和静态目标），流程声明**返回集合**——结果是业务结论，不是 completed/failed 二分。

- 一个 **workspace**（canonical realpath）最多一个活动 Run。
- 状态存于 `${DSH_HOME}/workflows/state.sqlite3`（默认 `~/.dsh/workflows/`）。
- trace log 是 best-effort 派生产物，写在 `~/.dsh/workflows/<workflowId>/`，失败静默。

## 2. 安装 / 部署 / 升级

插件以 dev bundle（`wfdev`）形式部署在 web profile。**部署是需你显式授权的动作**；只想核对产物时用隔离生成（`--out`，不写 `~/.dsh`）：

```bash
pnpm run build                              # tsc 编译到 lib/（部署前必须）
node scripts/deploy-web.mjs --out /tmp/wfdev-check   # 隔离生成产物并核对版本/依赖（不部署）
node scripts/deploy-web.mjs                 # 部署到 ~/.dsh/profiles/web/wfdev（需授权）
# 重启 DSH（dsh web）生效
```

bundle `package.json` 的必要字段（version / dependencies / dsh / main / type / license）全部取自本仓库
`package.json`，不再手抄一份；`@deepseek-ai/*` 宿主包只留在 devDependencies，出现在 dependencies 会让
生成步骤直接失败。`--out` 必须带目录值：漏写（`--out` 为末位）只打印用法并以 2 退出，**不会**回落到
`~/.dsh` 的真实部署目标。注意：每次 build 后都要重跑 deploy；bundle 成员变更后必须重启 DSH。

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

### 3.1 会话复用粒度 `reuse`（Issue #60 起）

worker Role 可选 `reuse: node | continuable`，决定该 Role 的会话在节点之间是否延续：

- `node`（**缺省**，省略 `reuse` 即此值）：**节点级复用**——同一节点内的重复派发、
  REJECT 修正轮与 BLOCK 恢复复用同一会话；离开节点时先 drain 会话再删除映射（旧
  会话就此失权），再次进入（含结果回边）得到全新会话；跨节点不再做边界
  compact（没有跨节点上下文需要压缩）。drain 失败只降级为“仅撤权”，不阻塞推进。
- `continuable`：**旧行为**——Role 的 continuable 会话在整个 Run 内复用，每次派发
  新节点前先做一次节点边界 compact（cold materialize → compactNow → dispose）再
  派发，保留跨节点历史但要付代价：派发前时延，且 compact 失败是 fail-closed（Run
  进入 BLOCK，等 Manager `node_resume` 重试，风险面见 issue #55）。**选型**：只有
  确实需要 Role 跨节点带着历史继续工作时才选 `continuable`；同一节点内的复用与
  REJECT 返工 `node` 已覆盖，缺省 `node` 即可。
- **`manager` 不适用 `reuse`**：`manager` 是保留 roleKey（禁止出现在 `roles` 中），
  manager 节点始终由当前主会话承担；`judgeRole` 也不接受 `reuse`——Judge 每个节点
  都是全新会话。
- 取值在 Run 启动时随 `definitionSnapshot` 冻结，Run 中途改 YAML 只影响下一个 Run。
  配置细节见 `docs/example/README.md`「会话复用粒度」。

### 3.2 默认模型路由按 Run 冻结（Issue #91 起）

同一个插件实例会同时服务多个 workspace，而**默认模型路由**（既没有
`workflow_set_role_model` 的 override、也没有 catalog 里 `model: { provider, modelId }`
时用的那条）自 #91 起**在 Run 启动时冻结一次、写进该 Run 自己的状态行**，之后不再
跟随外部变化：

- **新 Run**：`/dsh-flow start` 时按 DSH 正式的委派语义取源——Manager 会话最新
  request header 的 provider/model 优先，创建该会话时的 options 兜底——冻结值随
  Run 一起持久化，宿主重启后照旧生效。此后为该 Run 新建的 Role Actor、Judge 会话，
  以及 `reuse: continuable` 的跨节点边界 compact fallback，一律只读这条冻结值。
- **优先级不变**：`workflow_set_role_model` 的 override > catalog 中 Role/Judge 的
  `model:` 块 > 本 Run 的冻结值 > 宿主 spawn 时按 Manager 继承。
- **不追溯已有会话**：冻结只影响之后创建的会话；Run 中途 Manager 会话换了模型，
  不会改写已存在 Role/Judge 会话自己的路由，也不会把它们算到别的 Run 上。
- **旧 Run**（升级前已存在、状态行里没有该字段）：不推测历史值，也**不借用**其他
  workspace/Run 的当前路由——新建会话交回宿主的正式继承语义（仍只从本 Run 自己的
  Manager 解析），边界 compact fallback 保持不注入。因此升级**不需要清空或迁移**
  `${DSH_HOME}/workflows/state.sqlite3`：旧 Run 照旧跑到结束，新 Run 从一开始就
  带着冻结值。

## 4. 提交协议单源化：旧 catalog 迁移指引

提交协议只有引擎一个来源：每次派发末尾的 `[提交要求]` 段（含
`node_claim` 最后动作条款、纯文字不提交→BLOCK、`send_message` 覆盖条款、
REJECT 分歧处理）。**不要**在 `roles.*.persona` 或 `judgeRole.persona` 里
手写提交纪律句——catalog 校验会对关键词 `node_claim` / `judge_claim` /
`send_message` 报**非阻塞警告**（#59）：文件照常进入 catalog、照常可
`/dsh-flow start`，`/dsh-flow list` 中以 `[warn]` 单独一档提示（角色、
关键词、迁移指引），迁移完警告即消失。

**工作流级公共 persona（#140 起）**：顶层可选字段 `actorCommonPersona`
放各 Role Actor 共同遵守的约定——配置后每个 Role Actor 的 system prompt
为「公共 persona 在前 + 空行 + 角色专属 persona 在后」，未配置时行为不变；
该字段同样触发上述提交协议关键词警告。**共同约定放此字段，节点动作仍放
instruction**（结果验收条件进各结果 `criteria`，不依赖 persona 上下文）。
`judgeRole.persona` 与 Manager 派发不受影响。字段细节见
`docs/example/README.md`「工作流级公共 persona（Issue #140）」。

旧 `~/.dsh/workflows/*.yaml` 按三步迁移（插件不代改你的用户文件）：

1. **删 persona 纪律段**：去掉 persona 里"仅通过 node_claim/node_block
   汇报""是本轮最终动作""调用之后输出无效""向父 send_message 汇报"之类
   的句子，只留业务纪律（角色职责、分支/PR 规则、只读约束等）。
2. **instruction 补验收边界**：Actor 派发不再含 `[criteria]`，验收边界归属
   instruction 单源——每个 `actor-task` 节点的 instruction 必须自己写清
   验收标准，不要指望派发里的 criteria。
3. **criteria 写自足**：Judge 只看冻结 criteria 判定——每个 checker 的
   criteria 必须自足、可核验（判据 + 事实依据），不要引用 persona 里删掉
   的纪律句。

改完可用 `node scripts/validate-catalog.mjs <你的yaml> <workflowId>` 本地
校验（OK 即通过；`WARN` 行会指明 persona 关键词位置与迁移指引，不影响
文件可用）。

## 5. 命令：`/dsh-flow`

```
/dsh-flow list                        列出所有合法 workflow（含 [invalid]/[warn] 诊断）
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
- `reset` / `terminated` 只表示**控制面终止**：它撤销旧推进资格、保留工作单与事件，
  **不等于**外部已经发生的副作用（已提交的 push、PR、issue、文件改动等）被取消——
  处理前先人工确认现场，不要把它读成“已回滚”。工作流的固定理由文本就是
  `terminated; external effects not cancelled`。停机切换与回滚的完整顺序见 §8。
- `reset` 可由**当前 workspace 的任意顶层会话**执行（不要求是当初 `start` 的那个
  对话）——Run 永久绑定启动会话且没有 takeover，原对话被 fork/删除/重启后仍能
  收尾。工作流内部的 Role Actor / Judge / 子代理会话执行会被拒绝；当前
  workspace 没有活动 Run 时返回 `no active run`（幂等成功），已 terminated /
  completed 的 Run 重复 reset 仍被拒绝。
- `--incompatible-store` 只允许 **root 会话**执行：即用户顶层聊天会话
  （无 parentSession、origin 不是 subagent、delegationDepth 为 0）；
  工作流 Actor / Judge / 子代理内执行会被拒绝。它只接受这一个参数形式，
  演示与备份/归档细节见 §8。

## 6. 工作流控制工具（对话内使用）

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

**只读 repository 事实的失败语义（Issue #92 起）**：`workflow_inspect_git` /
`workflow_inspect_github` 与两个 builtin program（`github.initialize-milestone`、
`github.all-milestone-issues-complete`）共用同一套 repository 识别、分页与过滤结果——
GitHub 列表按 `per_page=100` 翻页取全、PR 从 issues 结果中排除；无效 JSON、非数组、缺关键
字段、未知 issue/milestone 状态、后页读取失败、超出分页页数/时间上限都算**读取失败**，返回
失败而不是空集合或截断后的"完整"结果。git 侧同样区分「事实不存在」与「读取失败」：不是仓库、
无 origin、detached HEAD、分支不存在是事实；`git status` 读取失败不当 clean，`ls-remote`
失败不当「远端分支不存在」（因此不会继续 push）。Program 的读取事实不可靠时一律 ERROR
（Runtime 转 BLOCK），且写动作（创建 milestone / 建本地分支 / push）只在依赖的读取事实全部
可靠后才执行。

## 7. 运行中会发生什么

- 节点推进：Manager 派发 → Actor 工作 → `node_claim` → Judge 核验 →
  通过后沿**该结果声明的静态 Target** 走唯一后继，REJECT 以 reason 作为纠正指令
  重派同节点（可改选另一个合法结果，但必须重新核验），NEED_CONTEXT 由 Manager
  补充材料后重判。v3 的 Target 是严格互斥的 `{ node: <本流程节点> }` 或
  `{ return: <本流程返回名> }`：**没有**裸 `END`、`onPass`/`onFail` 或默认路由。
  走到 `{ return }` 即流程返回——Root 的返回就是 Run 的**业务终局**，`workflow_status`
  的 `businessReturn`（返回名 + 终局来源 executionId）与 `claimResult` /
  `finalHandoffPreview` 可见；Run 状态 `completed` 只表示执行已结束，`reset` 的
  `terminated` 不制造业务返回。节点结果名由该节点声明，与流程返回名不必同名。
- 各节点的结果集合与验收条件随 Run **冻结**（`checker.config.criteria` 是共同条件，
  每个结果另有自己的 criteria）：Actor 初次派发、REJECT 修正与恢复都收到同一份共同
  条件 + 全部合法结果条件；Judge 只收到共同条件与本次所选结果的条件，不改选结果、
  不遍历其他出口。
- Role Actor 的会话按 `roles.<role>.reuse` 复用（缺省 `node`，见 §3.1）：
  `node` 为节点级复用、离开节点即 drain + 撤权、无边界 compact；`continuable`
  保留整 Run 复用，并在**节点边界**对其做一次压缩（cold materialize →
  compactNow → dispose），token 得以受控但派发前有额外时延。
- BLOCK：Actor 主动 `node_block`，或技术故障（Judge fault 等）自动进入；
  Manager 用 `node_resume` 恢复。
- Host 重启后 Run 可冷恢复：状态在 SQLite，会话在持久层，重进即可续跑。

## 8. v3 升级与回滚（停机切换）

> **依据与适用边界**：本节的停机切换方案来自 Issue #128 已确认决策 Q6「方案 A」，
> 切换检查单见 [`docs/testing/v3-cutover-checklist.md`](testing/v3-cutover-checklist.md)。
> 本节只说明操作步骤与运行时事实，**不代表切换已经部署过，也不表示任何真实 home
> 已被执行过切换**；所有涉及状态库的操作都必须使用隔离的临时 home，或在获得明确
> 授权后对真实 home 执行。

v3 运行时**不接受 v2 配置**，也不把 v2 的 `failed` 猜测成任何业务结果；不提供
双协议工具、不做自动历史合并。因此从 v2 升到 v3 是一次**停机切换**：先把旧现场
收干净，再显式备份旧状态库，最后初始化新库——新库一旦初始化，旧历史只保留在
离线备份里，新运行时不提供旧历史查询。

### 8.1 顺序：先停机，再核查，再备份，最后初始化

1. **用旧版本结束或显式终止活动 Run**：在切到 v3 之前，先在旧插件版本上用
   `/dsh-flow` 的终止路径把当前 workspace 的活动 Run 收尾（`reset` 把活动 Run 标为
   `terminated`；节点走完则按业务终局结束）。不要在新版本上运行旧 Run，
   也不要用新版本去“接管”旧 Run——v3 不会打开旧 Run，也不做 v2→v3 的失败猜测。
2. **人工核查参与者与外部操作已安全收尾**：终止只是控制面动作，不会取消已经发出
   的外部副作用。逐项确认子代理会话（Actor / Judge / 派发出的 subagent）没有仍在
   运行的 turn，以及外部副作用（已 push 的分支、已开的 PR、已建的 issue、已改的文件
   等）都已经人工确认、接管或明确放弃——运行时的固定理由文本
   `terminated; external effects not cancelled` 就是这个意思。
3. **显式备份旧状态库，备份必须成功**：对旧库（`${DSH_HOME}/workflows/state.sqlite3`，
   含 `-wal` / `-shm`）做完整备份，并确认备份文件可用（备份是可离线打开的 SQLite
   文件）。走 `reset --incompatible-store` 时这就是它执行的第一步；备份失败即停，
   原库不动、不进入下一步。
4. **再初始化新库**：备份成功后由新版本建立全新**空**状态库。新库一旦初始化，旧历史
   只存在于上一步（以及同一次切换的归档目录）的离线备份中，新运行时不提供旧历史
   查询，也不自动合并。

### 8.2 旧格式状态库的正常加载行为：维护态，不隐式切换

用新版本打开**旧格式**或**坏**的状态库时，插件进入**维护态（maintenance）**：普通
命令一律回复**完整维护诊断**——状态库路径、`user_version`、原因，以及“未迁移或替换
任何数据”的说明（`/dsh-flow list` 给出 `list 失败：Workflow State Store is in
maintenance mode; ordinary list/start/tools are disabled.` 后接 `path:` /
`user_version:` / `reason:` 各行；`start` / `check` 与普通 `reset` 同样以该诊断作为
失败原因，`status` 把它作为状态正文输出）。`/dsh-flow reset --incompatible-store`
**不打印这段诊断**：它是 root 会话的显式**整库切换**命令，直接执行备份 → 归档 →
初始化新空库（见 §8.3），返回的是切换本身的消息。维护态下的行为：

- 普通 `list` / `start` / 工作流控制工具在维护态下**全部被拒绝**，不退回旧引擎；
  连普通 `reset` 也不会在维护态下执行——它只会回复维护诊断，并提示必须用
  `--incompatible-store`（即普通 `reset` 不能切换不兼容库）。
- **不会隐式触发切换**：没有“首次加载自动迁移”的路径，也不会静默改写、转换或清空
  旧库（拒绝时的措辞就是「原始数据保留、需要授权的备份/切换」）；
- 只有 root 权限的显式命令才会执行整库切换：`/dsh-flow reset --incompatible-store`
  ——命令只接受这一个参数形式，带**其他任何额外参数都会被拒绝**（用法错误）。
  探测结果为坏库（corrupt）时走的也是这条显式路径，只是它保留的是原始文件
  bundle（见 §8.3）。
- `--incompatible-store` 只允许 **root 会话**执行（用户顶层聊天会话：无
  parentSession、origin 不是 subagent、delegationDepth 为 0）；工作流 Actor / Judge /
  子代理内执行会被拒绝。
- 状态库本来就兼容时执行该命令会被拒绝（提示改用普通 `reset` 收尾当前 Run）。

### 8.3 显式切换做了什么（备份成功才初始化）

对旧格式库执行 `/dsh-flow reset --incompatible-store` 时，运行时的动作顺序是：

1. 先**备份**：以只读方式打开旧库，把整库备份到
   `state.sqlite3.backup-<时间戳>-<uuid>.sqlite3`（可直接用 sqlite 打开）。备份失败
   就到此为止：删除半成品备份文件，**原库不动，不初始化新库**（失败消息明确写
   “backup failed; original store unchanged”）。
2. 再**归档**：把 `state.sqlite3`、`state.sqlite3-wal`、`state.sqlite3-shm` 移入
   `state.sqlite3.archive-<时间戳>-<uuid>/` 目录；归档中途失败会把已移动的文件移回
   原处并报 “archive failed; original store restored”。
3. 最后**初始化新库**：创建全新空库。新库初始化失败时会去掉新建的文件、把归档文件
   还原回原位，并报 “new state initialization failed; original store restored”。

坏库（corrupt）不带可备份的旧格式数据：切换保留的是原始文件 bundle（归档目录），
`backupPath` 返回的是归档目录本身。

**界线**：不提供旧历史查询，不做旧历史自动合并或双协议混跑；备份里的旧 Run 只能
离线查看（例如用 sqlite 打开备份文件取出 handoff/claim 文本），新库里没有它们。

### 8.4 诊断入口

```bash
node scripts/check-state-rows.mjs <state.sqlite3 的路径>   # 只读诊断，可加 --json
```

该脚本是**只读**的：必须显式给路径（缺参数只打印用法并以 2 退出），先复制成临时
快照再以只读方式打开副本，**不创建、不改写目标库**，也不默认真实 home。对有疑问的
旧库，请把这个脚本跑在它的**快照副本**上，而不是边跑边切。

### 8.5 回滚

回滚同样是一次停机操作，不要在生产库上做双向试验：

1. 停机（结束或终止当前 Run，核查外部操作，见 §8.1）；
2. **保留新库的备份与归档记录**（新库也要先备份，别直接覆盖）；
3. 恢复**与旧插件版本匹配**的旧库与**旧配置**：把旧状态库文件放回原位，并让 catalog
   回到旧版本能解析的格式。
4. 不允许旧插件直接打开新格式库——旧版本会把它当作不兼容格式并进入维护态；
   切换后两边的历史**不会自动合并**，回滚也不会把期间在新库上跑过的 Run 合并回来
   （它们只存在于新库的备份里）。

### 8.6 常见误区

- “reset 了就等于外部副作用已经取消”——不是：`reset` / `terminated` 只是控制面
  终止，外部动作要人工核对，固定理由文本 `terminated; external effects not cancelled`
  是运行时的原文。
- “新版本能继续跑旧 Run / 能查旧历史”——不能：v3 不接受 v2 配置，旧历史只在离线
  备份里。
- “加载旧库会自动迁移”——不会：只进维护态并给诊断，切换必须是 root 的显式命令。
- “两次都能随时切回去”——回滚要停机、要保留新库备份、要恢复匹配旧版的旧库与旧配置，
  且不承诺自动合并历史。

## 9. 故障排查（FAQ）

### 9.1 `dsh web` 启动报 `pending (waiting for service: compaction)`

dsh 0.1.1-rc.7+ 把压缩后端移进每个会话 preset 的 isolate 域，宿主平面没有
这个服务；插件模块级 inject 它会永久 pending 并卡死整个 boot。本插件已修复
（见 §2 版本兼容提示）；若再次出现，检查部署产物是否为最新构建。

### 9.2 `/dsh-flow list` 报 maintenance mode（incompatible state format）

**原因**：`~/.dsh/workflows/state.sqlite3` 里的数据不是当前格式（`agent-workflow-state/v10`，
`user_version=10` 的三表布局）。典型场景：旧版本插件留下的真实数据（重构前的单表
`workflow_state`，或 v3 协议之前的 v9 库）——当前版本按设计**拒绝迁移或覆盖**旧数据，
进入维护模式保护现场（list/start/tools 全部禁用，直到 root 用户裁决）。

诊断特征：`user_version` 不是 10，或表里出现 `workflow_state`（旧单表格式）。

**恢复步骤**（确认旧 Run 不需要续跑后）：

1. 在**你自己的顶层会话**（不是工作流 Actor）执行：
   `/dsh-flow reset --incompatible-store`
2. 插件会：把旧库完整备份为
   `state.sqlite3.backup-<时间戳>-<uuid>.sqlite3`（可直接用 sqlite 打开），
   原始文件移入 `state.sqlite3.archive-<时间戳>-<uuid>/`，然后创建全新空
   v10 库。
3. 恢复后 `/dsh-flow list` 应正常列出工作流。
4. 注意：旧 Run 已产生的**外部效果**（PR、issue、分支等）不会被取消，
   需要时先去对应平台确认现场。

什么时候**不要**直接重置：如果旧 Run 的 `snapshot_json` 里有必须续跑的
现场——先用 sqlite 备份文件把 handoff/claim 文本取出来存档，再重置。

### 9.3 想看某个状态库到底装了什么（只读诊断）

```bash
node scripts/check-state-rows.mjs <state.sqlite3 的路径>      # 例：只查一个临时 fixture
node scripts/check-state-rows.mjs <path> --json              # 机器可读
```

- **必须显式给路径**：脚本没有默认目标，不会去读你的真实 `~/.dsh`；缺参数只打印用法并以 2 退出。
- **零副作用**：先复制成临时快照再以只读方式打开副本，被诊断的库与所在目录（含 WAL/shm 索引）都不被创建或改写；路径不存在按 `missing` 报告，不是"空库"。
- **格式识别**：`user_version=10` 且恰好 `runs` / `node_executions` / `node_execution_events` 三表 → 列出每个 Run 的 status/workflow/stateVersion/currentExecution；旧三表（`user_version=9` 及更早）/ 旧单表 `workflow_state` → 提示它是被 fail-closed 拒绝的旧格式与 `reset --incompatible-store` 退出路径；其它未知布局 / 坏库 → 明确诊断，不猜成空结果。
- 退出码：`0` 当前 v10 格式；`1` 有诊断（missing/legacy/unknown/corrupt）；`2` 用法错误。

### 9.4 其他常见信息

以下三条只与 `reuse: continuable` 的 Role 有关——缺省 `node` 的 Role 不做节点边界
压缩（见 §3.1）。

- `resident actor busy`：节点边界压缩时 Actor 恰被外部唤醒，本轮压缩跳过
  （良性，下个边界再试）。
- `node-boundary compact failed: ...`：边界压缩的技术故障，Run 进入故障态，
  Manager 可 `node_resume` 恢复。
- `no compaction backend; boundary compact skipped`：目标会话的 preset 与
  宿主平面都没挂压缩后端，节点边界压缩被跳过（附 host 日志告警）；Run 继续，
  但 Role 会话上下文不再受控压缩。

## 10. 开发者快速参考

```bash
pnpm run verify       # 现行验收单入口：typecheck + 全量 suite + 两套受控 smoke
pnpm run typecheck    # tsc --noEmit（脚本显式调用 node_modules/typescript/bin/tsc）
pnpm test             # 全量 node:test（标准入口，按文件隔离子进程）
pnpm run test:suite   # 同一全量套件，--test-isolation=none（禁派生进程的受限环境用）
pnpm run test:smoke   # 统一受控 smoke：t3（reuse: continuable）+ e2e（缺省 reuse: node）
pnpm run test:real-host  # exact 0.1.5-rc.2 真实 Host 组合（单文件直跑；与受控 smoke 分开报告）
pnpm run build        # tsc 编译到 lib/
node scripts/deploy-web.mjs --out <目录>   # 隔离生成部署产物（不部署）
node scripts/deploy-web.mjs                # 部署（build 之后，需授权）
node scripts/check-state-rows.mjs <path>   # 只读诊断指定状态库
```

- 计数口径：0 fail；skip 只允许环境条件（`test/programs.test.ts` 两条真实 spawn 用例在禁派生进程的环境按 EPERM 探测跳过，逻辑由受控适配器用例覆盖）。逐项替代映射见 `docs/testing/runtime-refact-test-migration.md`。
- 工单/进度：`docs/agents/issue-tracker.md`、`docs/work-plans/runtime-refact.md`
- 测试报告：`docs/test-reports/`；历史修复背景：`docs/prd/`
