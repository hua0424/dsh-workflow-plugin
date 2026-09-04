# PRD：A3 Workflow Trace 执行结果与中断可观测性

- 日期：2026-09-03
- 来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 复盘
- 状态：已实现（2026-09-04，分支 `a3-trace-observability`；AC4 revision 待 A1 claim 修正协议落地后补，其余 AC 已实现；部署与运行时验证随本批 PRD 统一进行）
- 关联需求：记录每个 Node 的 Actor claim、Judge 输出、BLOCK/RESUME

## 1. 背景

现有 trace log 主要记录：

- Run START；
- Graph PASS/FAIL 路由；
- Child Workflow PUSH；
- Actor compact 结果。

真实 run 的日志仅 20 行。它能说明流程最终如何路由，却无法回答“为什么”：

```text
NODE issue-delivery/implement FAIL -> implement
NODE issue-delivery/implement FAIL -> implement
```

两次 FAIL 的真实原因都是“实现正确但未 commit/push”，该 reason 只存在于 Judge Session，不在 workflow trace。

另外，`test PASS -> complete-issue` 到 `complete-issue PASS -> END` 之间相隔约 52 分钟。期间发生 provider retry、Manager 回合中断、Node BLOCK、人工换模型、`node_resume`，但 trace 完全没有记录。

目标：让单个 workflow trace 文件足以重建 Node 级业务过程，无需翻阅所有 Actor/Judge Session 才能知道 claim、Judge 判断和中断恢复原因。

## 2. 记录边界

本 PRD 中“Actor 执行结果”专指**已被 Engine 接受的 `node_claim` 数据**，不是完整 Assistant 文本、reasoning 或 tool transcript。

“Judge 输出”专指**已被 Engine 接受的 `judge_claim` 数据**。

不记录：

- reasoning；
- 普通 tool call/result；
- Node-local transcript；
- system/persona/skill 内容；
- 未被 Engine 接受的 stale/unauthorized claim 正文（可另记安全摘要，不写完整 payload）。

## 3. 格式决策

保留现有 UTF-8 `.txt` 与 `[YYYY-MM-DD HH:mm:ss]` 前缀。为支持完整但有界的多字段内容，每个事件采用**单行 key=value + JSON-string escaping**：

```text
[ts] CLAIM workflow=<id> node=<id> role=<role> outcome=<completed|failed> summary=<json-string> handoff=<json-string|null>
[ts] JUDGE workflow=<id> node=<id> result=<ACCEPT|REJECT|NEED_CONTEXT> reason=<json-string>
[ts] ROUTE workflow=<id> node=<id> result=<PASS|FAIL> target=<node|END|BLOCK>
[ts] BLOCK workflow=<id> node=<id> source=<actor|judge|program|dispatch|compact|restart|manager> reason=<json-string>
[ts] RESUME workflow=<id> node=<id> oldToken=<prefix> newToken=<prefix> context=<json-string>
```

使用 JSON string escaping 可保证：

- 换行不会破坏“一事件一行”；
- 引号、反斜杠可逆；
- grep 与后续机器解析均稳定。

`ROUTE.result=PASS|FAIL` 表示最终采用的 Graph Edge 方向，而不是 Judge verdict：Actor `completed` + Judge `ACCEPT` 合成为 PASS/onPass；Actor `failed` + Judge `ACCEPT` 合成为 FAIL/onFail。Judge `REJECT` 不产生 ROUTE，只产生 JUDGE(REJECT) 并重派 Actor。

现有 `NODE ... PASS -> ...` 格式可兼容保留，也可迁移为 ROUTE；必须在实现时选定并同步 README/tests，不允许同一事件重复记录两种格式而无版本说明。

## 4. 长度与隐私边界

按现有协议上限记录完整字段：

- Actor summary：最多 4000 字符；
- Actor handoffContext：最多 8000 字符；
- Judge reason：最多 2000 字符；
- BLOCK reason：最多 4000 字符；
- resume resolutionContext：最多 8000 字符。

要求：

- 在协议校验后的规范化文本上写日志；
- 若历史/异常数据超限，按字段上限截断并追加 `…[truncated]`；
- 不额外抓取环境变量、凭据、HTTP header 或原始 provider body；
- AUTH/credential 类型错误继续使用 Host 的安全化文案，不把 provider 可能回显的 key 写入 trace。

## 5. Actor Claim 日志

### R1：只记录 accepted claim

`handleClaim()` 完成 admission、身份、dispatch lease、长度校验之后，且在 spawn Judge 之前写 CLAIM。

原因：

- claim 一旦 accepted 就进入持久 judgment phase；
- 即使随后 Judge spawn 故障，trace 也能证明 Actor 已提交；
- rejected stale/duplicate claim 不应伪装成 Node 正式结果。

字段：

- workflowId/nodeId；
- executor role（manager 或配置 role）；
- Actor outcome；
- summary；
- handoffContext（缺失为 null）；
- 内部 nodeToken 只记录短前缀，避免日志充斥 UUID；完整 token 不作为业务追踪主键。

### R2：Claim correction revision

A1 新协议下，同一 Node 可经历多次 claim revision。增加 `revision=<n>` 或等价稳定序号：

```text
CLAIM ... revision=1 outcome=completed ...
JUDGE ... revision=1 result=REJECT ...
CLAIM ... revision=2 outcome=completed ...
JUDGE ... revision=2 result=ACCEPT ...
ROUTE ... result=PASS ...
```

revision 是当前 Node 内的派生追踪序号，不要求进入长期业务 State；若为恢复一致性需要持久化，应只保存当前 revision。

## 6. Judge 日志

### R3：记录 accepted Judge confirmation

`handleJudgeClaim()` 完成当前 Judge session、nodeToken、pendingClaim 校验后写 JUDGE。

字段：

- workflowId/nodeId；
- claim revision；
- Judge result（A1：ACCEPT/REJECT/NEED_CONTEXT）；
- reason；
- Judge session id 短前缀（用于关联 Session，非安全凭据）。

### R4：Judge 故障

以下均写 BLOCK 或专用 JUDGE_FAULT：

- Judge spawn/admission 失败；
- Judge turn 无 `judge_claim`；
- Judge tool surface 错误；
- persistence/projection 读取失败；
- followup/respawn 失败。

保留现有 Manager steer，同时写入 trace。

## 7. BLOCK / RESUME 日志

### R5：所有 BLOCK 入口覆盖

至少覆盖：

- Actor `node_block`；
- actor-turn-ended-without-result；
- Judge NEED_CONTEXT；
- Judge technical fault；
- FAIL 无 onFail；
- builtin program ERROR；
- dispatch failure；
- compact failure；
- host restart reconciliation。

每个 BLOCK 必须记录 source 与规范化 reason。

### R6：恢复动作

记录：

- `node_resume`；
- `judge_respawn`；
- `node_resolve_program`；
- model override（只记录 provider/model id，不记录凭据）。

`node_resume` 记录 old/new token 短前缀与 resolutionContext。若处于 pending Judge followup，增加 `target=judge`；否则 `target=actor`。

## 8. Child Workflow 可观测性

保留 PUSH，并增加显式 POP：

```text
[ts] PUSH parent=milestone-delivery/run-issue-cycle child=issue-cycle/select-next-issue
[ts] POP child=issue-delivery result=PASS parent=issue-cycle/deliver-one-issue
```

子流程 END 不能只靠下一条 Parent PASS 间接推断。

## 9. Program 日志

虽然用户本次重点是 Actor/Judge/BLOCK，为保持 Node 事件闭环，builtin program 至少记录：

```text
PROGRAM workflow=<id> node=<id> program=<programId> result=<PASS|FAIL|ERROR> reason=<json-string|null>
```

不得记录敏感 parameters；可记录白名单化身份字段（Milestone number/title、branch name）或 details 摘要。

## 10. Best-effort 与一致性

继续遵循现有原则：日志失败不得改变 workflow 结果。

但 best-effort 不代表无诊断：

- 首次日志创建/追加失败可通过 Host logger warning 一次；
- 不循环刷 warning；
- State 与 trace 冲突时，State/Git/GitHub 是权威，trace 是派生产物。

事件写入顺序：

1. 先通过业务校验；
2. 写 trace（best-effort）；
3. 执行/持久化对应状态转换；
4. 对可能造成重复的 crash seam，测试必须定义允许的日志语义（at-least-once 或 exactly-once）。

推荐为每条 trace 事件增加 Node token/revision 短标识以便去重，而不引入独立日志数据库。

## 11. 非目标

- 不做 Web GUI trace viewer。
- 不把完整 Session transcript 复制到日志。
- 不记录模型 reasoning 或普通 tool 输出。
- 不保证日志写入成功；workflow 仍以 State/外部事实为准。
- 不在本 PRD 直接汇总 provider 的每一次 `llm/retry`；额度重试边界见 A5。

## 12. 验收标准

- **AC1 Claim**：每个 accepted Actor claim 有一条 CLAIM，字段完整且 escaped。
- **AC2 Rejected claim**：stale/unauthorized/duplicate claim 不产生正式 CLAIM。
- **AC3 Judge**：每个 accepted Judge result 有一条 JUDGE，包含完整有界 reason。
- **AC4 Correction**：连续 REJECT/修正可按 revision 还原。
- **AC5 BLOCK**：所有列出的 BLOCK 入口都有日志；真实 actor-no-result 不再形成 52 分钟空白。
- **AC6 RESUME**：node_resume/respawn/resolve 均可在 trace 中看到。
- **AC7 PUSH/POP**：嵌套 child workflow 的进入与返回可显式配对。
- **AC8 Program**：builtin program PASS/FAIL/ERROR 均有记录。
- **AC9 上限**：超长 summary/handoff/reason 按字段协议上限安全写入，不产生多行注入。
- **AC10 敏感信息**：fixture 中的 credential-like provider 文案不进入 trace。
- **AC11 故障容忍**：日志目录不可写时 workflow 行为不变。
- **AC12 隔离 e2e**：扩展 `scripts/e2e-smoke.mjs` 或新 harness，只使用临时 DSH home 与合成 workspace；不得触碰真实 `~/.dsh`。
- **AC13 文档**：README 与设计文档更新事件格式、字段、best-effort、隐私边界。

## 13. 实现记录（2026-09-04，分支 a3-trace-observability）

### 13.1 实现时选定的决策

- **§3 格式**：选定**迁移为 ROUTE**（不保留旧 `NODE ... PASS -> ...`），全套事件统一为单行 `key=value` + JSON string escaping，`START` 行声明 `fmt=2` 作版本标记；README/设计文档/单元测试/e2e 断言同步更新，无双格式并存。
- **§3 JUDGE 取值**：`result` 沿用现行 judge_claim 协议的 `PASS|FAIL|NEED_CONTEXT`（本 PRD 草案中的 `ACCEPT|REJECT` 是 A1 新协议术语）；A1 落地时同步改枚举并保留 `revision` 字段（§5 R2 的 revision 是 A1 claim 修正协议的派生序号，当前单 claim 协议下恒为首次，先以 `token` 8 位短前缀满足 §10 去重诉求）。
- **traceLogPath 持久化（R5 restart 覆盖的前提）**：原实现日志路径只存 Engine 内存 map，host 重启即丢，restart-reconcile BLOCK 无法落盘。现将可选字段 `traceLogPath` 随 RunState 行持久化（state store 为宽松 JSON 序列化，向后兼容；pre-A3 旧行无此字段，日志 no-op）。日志本身仍是派生产物，不进 SQLite 之外的任何状态语义。代价：`state.create` 冲突时可能残留一个空孤儿日志文件（best-effort 接受）。
- **§10 告警**：`appendLine` 改为返回布尔；Engine 新增可注入 `traceWarn`（插件接线到 `ctx.logger.warn`），每 run 首次创建/追加失败各告警一次，之后静默。

### 13.2 事件覆盖对照

| 事件 | 写入点（engine.ts） | 验收 |
| --- | --- | --- |
| CLAIM | `handleClaim` admission+lease 校验后、pendingClaim 持久化后、startJudge 前 | AC1/AC2/AC9 |
| JUDGE | `handleJudgeClaim` 校验通过后、任何状态转换前（NEED_CONTEXT/PASS/FAIL 均记） | AC3/AC4 |
| ROUTE | `advance()`（含 child END→pop→parent 递归路由） | §3 |
| BLOCK | `handleBlock`(actor/manager)、NEED_CONTEXT(judge)、`blockOnJudgeFault`(judge)、advance FAIL 无 onFail(judge/program/manager)、program ERROR(program)、`dispatchNow` compact 失败(compact)/dispatch 失败(dispatch)、`handleTurnEnded` 无结果(actor)、`handleRestartReconcile`(restart) | AC5 |
| RESUME | `handleResume` 判定阶段(judge)/普通路径(actor)，token 轮换后、执行前 | AC6 |
| RESPAWN | `handleRespawnJudge` 成功后（reason 缺省记 null） | AC6 |
| RESOLVE | `handleResolveProgram` advance 前 | AC6/AC8 |
| PROGRAM | `handleRunProgram` 结果 revalidation 后（不记 parameters） | AC8 |
| MODEL | `handleSetRoleModel`（只记 provider/model id） | AC6/AC10 |
| PUSH/POP | `dispatchCurrent` child 分支 / `advance` pop 分支（显式配对） | AC7 |
| COMPACT | `compactBeforeDispatch` 成败均记（A2 R7 原有语义升级为 fmt=2） | §9 外延 |

- **§10 一致性语义（审查后修正为 at-least-once）**：初版 CLAIM 写在 acceptance 持久化之后（at-most-once，崩溃即缺行）；按 §10 规定的「校验→trace→持久化」顺序修正为 put 之前写 CLAIM。语义声明：**at-least-once**——崩溃缝隙可产生孤立事件行（如 CLAIM 已写但 acceptance 未落盘），以 token 短前缀去重，State/Git/GitHub 权威；正常路径不存在反向缺口（State 已接受而 trace 缺失）。其余事件（JUDGE/ROUTE/BLOCK/RESUME/PROGRAM 等）初版即遵循该顺序，crash-seam 语义由 put 故障注入测试固化。

### 13.3 验证情况

- 单元测试：`test/tracelog.test.ts`（fmt=2 助手：转义/截断/null/Escaped 包装防注入/redact 凭据模式）+ `test/engine.test.ts` trace 段（START fmt=2、CLAIM/JUDGE/ROUTE、stale/duplicate claim 不产生 CLAIM（AC2）、FAIL→BLOCK source、NEED_CONTEXT→RESUME(judge)、node_block→RESUME(actor)、actor 无结果 BLOCK、RESPAWN、PUSH/POP 配对、PROGRAM ERROR→RESOLVE、MODEL、restart-reconcile 跨 engine 实例写入同一日志、日志目录不可写时 warn 一次且 Run 行为不变、超限截断单行；审查回归：raw 标识符注入、credential fixture、put 故障 at-least-once crash seam）。164/164 通过。
- e2e：`scripts/e2e-smoke.mjs` 断言升级为 fmt=2 六行（START/CLAIM/JUDGE/ROUTE×2/CLAIM），隔离临时 home，`E2E SMOKE PASS`。
- 文档：README "Run trace logs"、设计文档 §5.4（含 at-least-once 一致性语义与 redact 兜底）、CONTEXT.md State 闭集已同步（AC13）。
- 待运行时验证（随本批统一部署）：真实 milestone-delivery run 的 52 分钟空白场景回放、Host logger warning 实际输出、COMPACT detail 真实文案。

## 14. 审查修正记录（2026-09-04 同批 review，7 项全部接纳）

| 审查项 | 结论与修复 |
| --- | --- |
| S1/AC9 高：MODEL 多行日志注入 | 属实（已复现）。`jsonField` 改为返回 `Escaped` 包装类型，`traceEvent` 仅对 `instanceof Escaped` 透传；raw 字符串统一重新过 `[\s"\\]` 检查并 JSON quoting，「以引号开头即已转义」启发式删除。补注入回归测试。 |
| S2 中：CONTEXT.md State 闭集未列 `traceLogPath` | 属实。已补列为「可选派生元数据」。 |
| S3 低：`traceWarnedRuns` 只增不减 | 属实。completed/reset 时删除。 |
| AC9 Spec：单行保证测试缺口 | 属实。补 raw 标识符含引号/换行的注入测试（engine 级 + 助手级）。 |
| AC10 中高：凭据净化无实现保证与 fixture | 属实。trace 边界 `redact()` 兜底 + credential-like fixture（claim summary、dispatch BLOCK reason 两条路径）；主防线仍为 Host 安全化文案。 |
| AC4 中：revision 未实现但状态写「已实现」 | 属实。状态改为「AC4 revision 待 A1 claim 修正协议落地，其余 AC 已实现」。 |
| S4 中：crash seam 语义未定义 | 属实。CLAIM 移到 acceptance put 之前（§10 规定顺序），语义显式声明 at-least-once；put 故障注入测试固化该语义。 |

修正后验证：`pnpm test` 164/164、`pnpm run build` 干净、`pnpm run test:e2e` PASS。
