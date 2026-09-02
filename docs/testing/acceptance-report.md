# 验收报告（阶段性）

- 生成时间：实现完成、经过两轮对抗性审查修复、等待真实 GUI e2e 重启期间
- 验收依据：`docs/testing/acceptance-test-plan.md`（A-J 九组标准）
- 当前结论：**离线可验证项全部通过；唯一剩余项 = 真实模型 Web GUI e2e（需用户重启 DSH）**

## 1. 已通过验收（离线证据）

### 自动化测试：92/92 通过

```
node --test "test/*.test.ts" → 92 pass / 0 fail
pnpm run test:e2e          → E2E SMOKE PASS
```

测试覆盖分布：

| 文件 | 覆盖验收项 |
|---|---|
| `test/catalog.test.ts`（19） | A1/A2 文件名规则、B1（duplicate/anchor/alias/merge/tag/多文档/未知字段）、B3/B4/B5（startNode/onFail:END/未知 role/unreachable/child 环/hash/criteria 边界/prototype-pollution）、B6 |
| `test/state.test.ts`（12） | C1（路径/STRICT/roundtrip/并发冲突）、C2（invariants 全覆盖）、C3（snapshot）、版本冲突 |
| `test/engine.test.ts`（16） | D1/D3/D4/D5/D6/D7、E4、H1/H2、精确 executor 绑定（非执行者 claim/turn 被拒、非 Manager resume 被拒）、模型切换 active/idle 语义 |
| `test/authz.test.ts`（6） | G8（manager 全权/role 三工具/judge 两 wrapper/cold-resume/unknown/stale） |
| `test/tools.test.ts`（17） | G1-G9（工具集恰好九个、路由、concludeTurn、长度校验、授权拒绝路径）、A3/A5 命令语法 |
| `test/roles.test.ts`（6） | E1/E2/E4（路由解析/deny/allow-list/override 拒绝/frozen route） |
| `test/programs.test.ts`（5） | I1/I2/I3 基础（origin 解析/gh 运行/ENOENT） |
| `test/judge.test.ts`（11） | F1（投影过滤）、F2/F3（输出协议/边界） |
| `test/review-fixes.test.ts`（4） | F4（gh argv 无 jq）、F6（resolve 清 BLOCK）、F15（state=all/排除 PR）、program 目录 |

### 真实宿主验证（无模型部分）

- **插件装载**：headless profile boot 成功 import + apply，`state.sqlite3` 由插件创建
  （STRICT 表 schema 正确）；`--dump-config` 组合树包含插件行。
- **真实存储 + 真实 catalog + 真实 engine 全链路**（`pnpm run test:e2e`）：
  start → manager claim → judge（脚本化读真实文件）→ PASS 推进 → deferred dispatch
  → worker claim → END 完成。
- **部署布局**：wfdev 本地 bundle 目录（wfgate 同款），`@deepseek-ai/*` 解析到宿主安装
  实例（`import.meta.resolve` 实证），yaml/zod 由 profile pnpm 管理。

## 2. 两轮对抗性审查的修复记录

第一轮审查（23 项发现）+ 第二轮重点复核，全部 P0/P1 项已修复：

| 编号 | 问题 | 修复 |
|---|---|---|
| F1 | 未处理 rejection 触发 fail-loud | catch + per-workspace mutation 队列 |
| F2 | settlement 未绑定 executor | DispatchBook.executorSessionId；handleTurnEnded(ws, sessionId) |
| F3 | Judge structured_output 被 fail-closed 误拒 | machinery 豁免集 |
| F4 | gh --jq -q 非法管道 | buildGhArgs 纯 argv（无 jq）+ query 参数 |
| F5 | 无精确 executor 校验 | claim/block/resume/run/resolve 全部带 callerSessionId 校验 |
| F6 | 手工 resolve 后仍 blocked | 先清 BLOCK 再 advance |
| F7 | handoff/resolution 从未交付 | DispatchBook.transientContext + 派发时拼入 |
| F8 | dispatchNow 绕过 CAS | 全程沿用操作开始时的 expectedVersion |
| F10 | inspection 结果丢 value | fmtResult 序列化 value |
| F12 | 模型切换合同错误 | active 拒绝 / idle 替换（删 mapping + 下次重建） |
| F13 | resume 未检查 active actor | actorActivity oracle 检查 |
| F14 | Judge/Program 无 single-flight | inFlight map 按 workspace+token 占用 |
| F15 | Issues API state=open 导致 PASS 不可达 | state=all&milestone=N + 排除 PR |
| F17 | restart reconcile 入口竞态 | 命令/工具先注册，mutation 走队列 |
| F18 | `in` 原型链污染 | 全部 hasOwn |
| F22 | 模型路由未冻结 | frozenRoute + managerRoute oracle |
| F21 | State invariants 只测不执行 | StateStore 读路径校验 + restart reconcile 隔离 |

## 3. 尚未完成的验收项

| 项 | 原因 | 完成条件 |
|---|---|---|
| **真实模型 Web GUI e2e（§3 场景 J1）**：`/dsh-flow list` / `start smoke-test`，Manager 会话 steer、Role Actor 真实子会话、fresh Judge 真实判断、`/dsh-flow status`、BLOCK/resume 展示、reset | 需要用户重启 DSH Web 进程（插件在 profile bundle 中，bundle 成员变更需重启；Web profile 的 hmr 被禁用，无热载路径） | 用户重启后按 `acceptance-test-plan.md` §3 场景 1-9 操作并确认 |
| milestone-delivery（真实 GitHub + gh CLI） | 依赖上述重启 + 真实仓库 | 在 smoke-test 通过后执行 |

## 4. 重启后的操作清单（给用户）

1. 重启 DSH（关掉再开）
2. `/dsh-flow list` → 期望列出 `milestone-delivery`、`smoke-test`
3. `/dsh-flow start smoke-test` → 主会话出现 Manager steer（写 smoke/result.txt 的指令）
4. Manager 完成后会自动 claim → Judge 子会话出现 → PASS 后 worker 子会话出现
5. `/dsh-flow status` 随时查看进度
6. 结束后 `/dsh-flow reset` 清理

如任何一步报错，把错误贴回来（不必手动修复，我根据错误修代码 + 重新部署，重启 DSH 生效）。

## 5. 真实模型 live e2e 结论（2026-09-02）

### 已跑通的验收

- **smoke-test**：完整跑通两次。start → Manager 执行 → Judge PASS → worker 节点 → END → Manager 收到完成通知（`workflow "<id>" 已完成`）。`/dsh-flow list/start/status/reset` 全部实际使用通过。
- **milestone-delivery（真实 GitHub + gh CLI）**：从 `draft-prd` 起步，跑完 3 个 Issue 的完整交付循环，真实创建并关闭 Milestone #1 `workflow-run-logging`、3 个 Issue，真实分支 `feat/workflow-run-logging` 发布到 origin（最终 `b080155`）。子工作流（child-workflow）压栈/出栈、BLOCK/resume、Judge 门控、FAIL 循环（`all-issues-complete` FAIL → 回 `select-next-issue`）均实测通过。

### 事故与处理

1. **reviewer 忘记调用 node_claim**（只发文字报告就结束回合）→ 引擎正确 BLOCK（`actor-turn-ended-without-result`），`node_resume` 恢复后正常。根因：milestone-delivery.yaml 里 reviewer persona 缺少"必须用 node_claim 报告"的硬约束。
2. **e2e-smoke.mjs 误删活动 run 状态行** → 脚本用真实 `~/.dsh` + 本 workspace key 做清理，摧毁了正在跑的 run。已用事故前转储的 snapshot 手术恢复（definitionHash 校验一致）。已在 Issue #3 修复：e2e 改用隔离 DSH home + 合成 workspace key。
3. **长寿 continuable Role Actor 上下文耗尽** → developer/reviewer 从 Issue #1 贯穿到 #3，后期 `failed before it finished`（无结束消息）。`workflow_set_role_model` 换模型（重建 actor）后恢复。

### 后续优化（待办）

- **【P1】Judge 上下文污染**：Judge 本是一次性 fresh 会话（`subagents.start('spawn')`，非 fork），但 `projectManagerTranscript` 把**完整 Manager 会话投影**（上限 `PROJECTION_MAX_CHARS=120_000`）注入 Judge prompt，等价于把持续历史塞回"纯净" Judge。随 Manager 会话变长，Judge 的 structured output 大量失败（pro/flash/k3 三 provider 复现，成功率约 1/6），`runJudge` 返回 `undefined` → 引擎 BLOCK（`judge evaluation produced no result`）。**方向**：投影应收缩到最近小窗口（如 ~8k）或干脆不注入全量历史（判定标准 + claim 摘要 + 真实工作区事实才是权威输入），保持 Judge 真正 fresh。
- **【P2】Role Actor 生命周期**：role actor 应支持在节点间按需重建，而非一个会话硬扛到底，避免上下文耗尽可能性。
- **【P2】catalog persona 硬约束**：所有 role persona 统一加一句"必须用 node_claim/node_block 工具报告，文字回复不算提交"。
