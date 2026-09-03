# 验收标准与测试计划

- 状态：开发启动前冻结；实现过程中如需调整，须经用户确认后修改本文件
- 依据：`docs/design/configurable-agent-workflow-graph.md`（agent-workflow/v1）
- 环境事实（已核查）：宿主 DSH `0.1.1-rc.2`、Node `v24.16.0`（`node:sqlite` 可用）、
  `~/.dsh/profiles/node_modules` 提供 264 个 `@deepseek-ai/*` 包 fallback（外部 bundle
  零依赖 import）；GitHub 访问走 `gh` CLI；插件以 Profile Bundle 装入 `~/.dsh/profiles/web`

## 1. 验收标准

每条标准来自设计文档的对应章节。E2E 验收只能通过**当前 DSH Web GUI
（http://127.0.0.1:3080）真实运行**完成，不引入替代进程。

### A. 命令面（设计 §2.3）

- A1 `/dsh-flow list` 列出 `${DSH_HOME}/workflows/*.yaml` 合法文件；`.yml`、symlink/junction、
  子目录、非 `[a-z][a-z0-9-]*` 文件名一律忽略。
- A2 `/dsh-flow start <id>` 在无 Run 或已有 completed 的 workspace 创建 Run 并自动执行
  Root startNode（role:manager）；在 running/blocked 的 workspace 拒绝并报错。
- A3 无参数、未知子命令输出 usage error；`start` 缺 workflow-id、文件缺失/无效报错且不创建 Run。
- A4 `/dsh-flow status` 只读展示 catalogWorkflowId、status、callStack、current node、
  roleActor 映射、blockReason、model overrides。
- A5 `/dsh-flow reset` 任何 direct-human Session 均可删除本 workspace Row；不影响其他 workspace。

### B. 配置与静态校验（设计 §2.3/§2.4/§7）

- B1 严格受限 YAML：重复 key / anchor / alias / merge / custom tag / 模板插值 / 未知字段 → 拒绝。
- B2 `list` 对 invalid 文件显示 diagnostics 且仅阻塞该文件自身；其他文件正常。
- B3 Root `startNode` 必须是 `actor-task role:manager`；缺失/类型错误 → 拒绝。
- B4 引用完整性：role/childWorkflowId/edge target 存在；Child 引用图 DAG（直接/间接递归拒绝）；
  每个 Workflow 至少一条可达 END；`onFail:END` 拒绝；Root 不被 Child 引用。
- B5 actor-task 必有合法 checkerId；builtin-program 禁 role/checker；child-workflow 只允许 onPass。
- B6 拒绝并行、表达式、脚本 transition、动态改图、运行时注册 Program/Checker。

### C. Runtime State（设计 §5）

- C1 SQLite 位于 `${DSH_HOME}/workflows/state.sqlite3`，单表 `workflow_state` STRICT，
  单连接 + 短 mutation 队列；每 workspace 一行（canonical realpath 键）。
- C2 字段与 invariants：blocked iff blockReason 非空；completed ⇒ callStack=[]；
  每 frame nodeToken 为 UUID；roleActors 键 ⊆ roles；modelOverrides 键 ⊆ roles∪{judge}。
- C3 Snapshot 完整 normalized Definition + definitionHash 写入；Active Run 不重读 YAML。
- C4 State 不保存 claim/handoff/program parameters/Judge 会话/recentEvents/lastError/attempt。

### D. Node 执行与串行协议（设计 §2.7/§4/§4.2）

- D1 actor-task：dispatch 到 Manager（steer）或 continuable Role Actor（followup）。
- D2 builtin-program：Engine 运行 programId；Manager 经 `node_run_program` 提供临时参数。
- D3 child-workflow：push frame；Child END → pop → PASS。
- D4 Worker 只能 claim completed/failed；Checker 独立产生 PASS|FAIL；PASS 走 onPass，
  FAIL 走 onFail，无 onFail → BLOCK。
- D5 每次 Program/Judge 异步结果应用前重验 nodeToken；stale 丢弃。
- D6 派发失败、Turn 结束无结果（`turn/end` + 无 accepted mutation）→ BLOCK（deferred 写入）。
- D7 同一 Role 连续派发：旧 Turn 结算后才派新 Node（dispatchedToken 判据）。

### E. Role Actor / Judge（设计 §2.1/§2.2）

- E1 Worker Role 首次使用创建 continuable spawn Actor，Run 内复用（继承父 Preset +
  persona/toolFilter.deny/agentOptions{provider,model} 覆盖）。
- E2 Judge 每次 fresh non-continuable spawn；toolFilter.allow 后 visible schema
  ⊆ {read,glob,grep,read_image,workflow_inspect_git,workflow_inspect_github} ∪ machinery；
  超出 → fail-closed 拒绝 spawn 并 BLOCK 当前 Node。
- E3 Judge 不调用 Workflow tools（guard 拒绝）；Manager/Worker/Hlper 的调用按角色放行。
- E4 `workflow_set_role_model` 只 Manager；Worker active 时拒绝；override 后旧 mapping
  删除、下次 dispatch 重建；judge override 只影响下一次判断。

### F. Judge 与投影（设计 §2.2/§10.3）

- F1 投影 = append-origin user/message(source.kind==='user') + assistant/message 文本块，
  排除 tool/system/plugin/hidden；不写 State；每次判断临时生成。
- F2 `judge.goal-satisfied` 输出 {result:PASS|FAIL, reason(1..2000)}；异常/超时/invalid
  output/缺读取能力 → 不产生结果 → BLOCK。
- F3 criteria trim 后 1..8000 校验。

### G. 八个 Workflow control tools + 一个 Judge 专用 `judge_claim` + 两个 inspection wrappers（设计 §5.2）

- G1 工具集合恰好十一个；所有 Node mutation 必须携带 current frame nodeToken；过期拒绝。
- G2 `node_claim`：仅 running + token 匹配；completed|failed；summary 1..4000；
  handoffContext 仅 completed 时 1..8000。
- G3 `node_block`：running + token 匹配；写 BLOCK；BLOCK 后迟到 claim 因非 running 拒绝。
- G4 `node_resume`：仅 Manager、blocked、token 匹配、目标 Actor 无 active turn；
  resolutionContext 1..8000；生成新 token；派发失败再次 BLOCK。
- G5 `node_run_program`：仅 Manager、running、token、current builtin-program strict parameters。
- G6 `node_resolve_program`：仅 Manager、blocked、token、current builtin-program、
  PASS|FAIL + 1..4000 reason（可覆盖任何 BLOCKed Program 的明确 FAIL）。
- G7 `workflow_status({})`：Manager + current Role Actor 可读。
- G8 未知字段拒绝；Judge 不调用 Workflow tools；helper subagent 的 mutation 被 guard 拒绝。
- G9 `workflow_inspect_git`/`workflow_inspect_github` 只读、enum 参数、无任意 command/URL。

### H. 中断恢复（设计 §4.2/§6）

- H1 重启后所有 running Row → BLOCK（host-restarted-before-node-result）；blocked/completed 不变。
- H2 Manager `node_resume` 同一 Node 重派；Actor 不可用 → replacement。
- H3 resolutionContext/parameters 均不持久化（重启后由 Manager 重建）；`handoffContext` 例外——随 `pendingClaim` 持久化（20260902-fixbug 评审方案 2）。

### I. Builtin Programs（设计 §10.1）

- I1 `github.initialize-milestone`：走 gh CLI + 固定 workspace repo；clean 前提
  inspect-first；返回 PASS/FAIL/ERROR（网络/gh 缺失/非 git repo → ERROR → BLOCK）。
- I2 `github.all-milestone-issues-complete`：milestoneNumber 参数；open → FAIL；
  全 closed → PASS；读取失败 → ERROR。
- I3 参数不持久化；ERROR 不走 Edge。

### J. 示例 Workflow E2E（设计 §8）

- J1 milestone-delivery.yaml 全流程跑通（见 §3 场景）。

## 2. 自动化测试方法

测试框架：`node:test` + `node:assert`（零第三方测试依赖）。代码分层保证纯逻辑可脱离
宿主测试；宿主行为通过 mock 类型桩（手写 interfaces，不依赖真实 DSH）验证。

### 测试矩阵

| 模块 | 被测对象 | 测试方式 | 关键用例 |
|---|---|---|---|
| catalog | YAML 解析/静态校验/normalize | 纯函数 + fixture 文件 | B1-B6、snapshot 幂等 |
| state | SQLite schema/invariants/事务 | 临时目录真实 sqlite | C1-C4、并发 mutation 队列 |
| engine | 转移/推进/nodeToken/结算 | 手写 AgentRuntime 桩 | D4-D7、stale token、deferred BLOCK |
| roles | spawn 参数组装/allow 断言/模型覆盖 | 手写 ctx 桩 | E1/E2/E4 |
| tools | 7+2 工具参数校验/授权矩阵 | 手写 exec/guard 桩 | G1-G9（每工具每个错误分支） |
| judge | 投影函数/模板/输出 schema | 纯函数 + 会话事件桩 | F1-F3 |
| programs | git 解析/gh 参数组装 | 手写 spawnSync 桩（捕获 argv） | I1-I3、ERROR 分类 |
| e2e | 全链路 | 真实 DSH Web GUI + 真实 GitHub 示例仓 | J1 |

桩策略：所有宿主 API 通过窄接口注入（`AgentRuntime`、`SubagentRuntime`、
`GitRunner`、`GhRunner`、`CommandRuntime`、`ToolRuntime`），插件 `apply(ctx)` 只做
装配。因此 80% 代码可在无宿主环境跑单测；装配层由 E2E 覆盖。

## 3. E2E 场景（真实 DSH）

准备：临时 GitHub 仓库 + milestone-delivery.yaml（设计 §8）装入 Catalog。

1. `/dsh-flow list` → 显示 milestone-delivery。
2. `/dsh-flow start milestone-delivery` → 主会话出现 Manager steer（draft-prd）；
   `/dsh-flow status` 显示 running。
3. Manager 产出 PRD → claim → Judge 独立判断（观察 fresh Judge 子会话）→ PASS 推进
   initialize-milestone。
4. Manager `node_run_program` 提供 title/branch → Program PASS（验证真实 Milestone/branch）。
5. plan-issues（Manager）→ run-issue-cycle（Child push）→ select-next-issue → 三角色串行
   递手（implement→review→test 各自 claim + handoff 传递，可观察 4 个 Child Session）
   → complete-issue 关闭 Issue → all-issues-complete 循环直至无 open → END。
6. 制造中断：在 test Node 运行中重启 DSH → 重启后 status 显示 BLOCK
   （host-restarted-before-node-result）→ Manager `node_resume` → 继续直至 Root END。
7. 制造 FAIL：final-review FAIL → plan-remediation → 新 Issue → 再次 cycle。
8. `/dsh-flow reset` → status 显示无 Run；再次 start 成功。
9. 全程无自定义 Web UI：主聊天卡片 + Child Session 层级可见。
