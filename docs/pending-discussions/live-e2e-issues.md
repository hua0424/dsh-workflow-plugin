# 真实 e2e 运行暴露的问题清单（已决策）

- 日期：2026-09-02
- 来源：真实模型 + 真实 GitHub 跑通 `milestone-delivery`（Milestone #1 `workflow-run-logging`，3 个 Issue）全过程
- 用途：登记问题与候选方案；全部结论已于 2026-09-02 讨论确定，PRD 落在 `docs/prd/20260902-fixbug/`，回写 CONTEXT.md / 设计文档后统一开发

---

## 决策总览

| # | 结论 | 产出 |
|---|---|---|
| A1 | Judge Node 边界隔离 + Node 内 continuable + `PASS\|FAIL\|NEED_CONTEXT` | PRD `a1-node-scoped-continuable-judge.md` |
| A2 | Node 边界对 role actor `compactNow`，失败 BLOCK，cold-resume 跳过 | PRD `a2-node-boundary-actor-compaction.md` |
| A3 | 派发统一注入提交硬约束 + 保留安全暂停 + BLOCK 主动通知 | PRD `a3-actor-turn-without-result.md` |
| A4 | Judge 故障：无 faultKind、`judgeSessionId` 二分恢复、`judge_respawn`、`pendingClaim` | PRD `a4-judge-fault-resilience.md` |
| B1 | 只记文档约定（测试隔离 DSH home），不抽象 fixture 工具 | 文档约定 |
| B2 | 不开发（不为偶然异常保底，手工导出无意义） | 无 |
| C1 | 文档明确 token 以 `workflow_status` 为准；记录已知限制；软约束 prompt | 文档/示例 |
| C2 | 不处理（工作区不干净就该报错） | 无 |
| C3 | 文档/示例明确 gh CLI `--milestone` 用 title、gh api 用 number；建 branch 收敛 builtin program 记为后续 | 文档/示例 |
| C4 | 不处理（人工说明即可） | 无 |

---

## A. 引擎 / 编排设计类

### A1. Judge 结构化输出随会话增长而崩溃（上下文污染）

- **现象**：run 后期 Judge 判定大量返回 `judge evaluation produced no result`；换 pro / flash / k3 三个 provider 复现，成功率约 1/6。Issue #1、#2 全程稳定，Issue #3 开始崩。
- **根因**：Judge 是 `subagents.start('spawn')` 的一次性 fresh 会话（非 fork），但 `projectManagerTranscript` 把**完整 Manager 会话投影**（`PROJECTION_MAX_CHARS = 120_000`）注入 prompt，等价于把持续历史塞回本该纯净的 Judge。随 Manager 会话变长，Judge 的 strict JSON 输出大量失败。
- **影响**：判定无法完成 → 当前节点 BLOCK，需 Manager 反复 resume；后期几乎无法自动推进。
- **候选方案**：
  1. 投影收缩到最近小窗口（如 ~8k 字符），判定标准 + claim 摘要 + 真实工作区事实才是权威输入；
  2. 不注入全量历史，只保留与当前 goal 相关的最近 N 轮；
  3. structured output 失败时降级为文本输出 + `parseJudgeResult` 解析；
  4. 三者组合。
- **已决策**：Node-local projection（Node 实际 dispatch 边界起，按时间戳合并 Manager/User/Actor 消息）+ 每 Node fresh continuable Judge + `PASS|FAIL|NEED_CONTEXT` 协议。详见 PRD `a1-node-scoped-continuable-judge.md`。

### A2. Role Actor 单会话贯穿导致上下文耗尽

- **现象**：developer / reviewer 从 Issue #1 贯穿到 Issue #3，后期连续 3 次 `failed before it finished`（无结束消息）。
- **根因**：role actor 首次创建后在**整个 Root/Child Run 复用**（CONTEXT.md 既有语义），长 run 下上下文膨胀。
- **影响**：后期节点 actor 无法工作，只能靠 `workflow_set_role_model` 换模型触发重建恢复。
- **候选方案**：
  1. 支持"每次节点派发可选新建 actor"（节点级生命周期开关）；
  2. 上下文水位阈值触发重建；
  3. per-role 策略（如 reviewer 每轮重建，developer 跨轮复用）。
- **已决策**：不引入 lifecycle schema；改为 Node 边界对 role actor 执行 `compactNow`，失败 BLOCK，cold-resume 跳过。详见 PRD `a2-node-boundary-actor-compaction.md`。

### A3. Actor 回合结束但未提交结果 → BLOCK，且无自动恢复

- **现象**：reviewer 只输出文字报告、未调 `node_claim` 就结束回合 → BLOCK（`actor-turn-ended-without-result`）。
- **根因**：milestone-delivery.yaml 里 reviewer persona 缺"必须用 node_claim 报告"的硬约束（developer/tester 有，reviewer 没有）；引擎把无结果回合结束视为可恢复暂停（设计如此）。
- **影响**：需 Manager 人工 resume；首次发生时用户困惑"为什么没有任务在跑"。
- **候选方案**：
  1. 所有 role persona 统一加一句硬约束；
  2. 派发 prompt 强调"文字回复不算提交"；
  3. 引擎在 actor 回合结束无结果时自动重派一次并附明确提示。
- **已决策**：保留安全暂停（不自动重派）；派发统一注入提交硬约束；BLOCK 主动通知 Manager。详见 PRD `a3-actor-turn-without-result.md`。

### A4. Judge 失败后的韧性不足

- **现象**：`runJudge` 返回 `undefined` → BLOCK，无自动重试、无降级、无诊断日志（`catch` 全吞）。
- **根因**：fail-closed 设计，异常一律 `undefined`。
- **影响**：与 A1 叠加导致后期严重卡顿，且难以定位失败原因。
- **候选方案**：
  1. Judge 一次失败自动重试 1–2 次；
  2. BLOCK reason 携带更细诊断（stopReason / structured 缺失 / 异常信息）；
  3. 至少补日志（当前吞掉一切）。
- **已决策**：保持 fail-closed；无 faultKind 只留 detail；`judgeSessionId` 二分恢复 + `judge_respawn` + `pendingClaim`。详见 PRD `a4-judge-fault-resilience.md`。

---

## B. 测试 / 状态安全类

### B1. e2e 测试脚本误删活动 run 状态行

- **现象**：`scripts/e2e-smoke.mjs` 用真实 `~/.dsh` + 本 workspace key 做清理，摧毁了正在跑的 milestone-delivery 状态行（`workflow_state` 表 0 行）。
- **根因**：测试 harness 无隔离。
- **影响**：run 工具调用全部失效，需手工手术恢复。
- **已修**：Issue #3 改为隔离 DSH home + 合成 workspace key。
- **已决策**：不抽象 fixture 工具；仅记文档约定（任何触碰 DSH home / state / workspace 的测试必须用临时 home + 合成 workspace，禁止碰真实 home）。

### B2. 状态行脆弱，无备份 / 导出

- **现象**：状态行被误删后，恢复完全依赖"恰好有事故前转储"。
- **根因**：最小状态设计，无 export / backup。
- **影响**：数据丢失恢复困难（本次靠事故前一次偶然 dump 才恢复）。
- **候选方案**：
  1. 提供状态导出 / 快照；
  2. WAL 备份；
  3. 接受"最小状态 + 靠 Git/Session log 重建"。
- **已决策**：不开发（不为偶然异常保底，手工导出依赖人执行无意义）。

---

## C. 运维 / 工具摩擦类

### C1. `node_resume` 会轮换 nodeToken

- **现象**：每次 resume 生成新 token，resolutionContext 里写的旧 token 变 stale，actor 需自己重读 `workflow_status` 取新 token。
- **影响**：恢复上下文里的 token 信息有误导性。
- **候选方案**：resume 后自动附最新 token；或文档明确"actor 一律以 workflow_status 为准"。
- **已决策**：文档明确 token 以 `workflow_status` 为准、`resolutionContext` 不承载 token；记录 token 防护「尽力而为」的已知限制；示例 prompt 软约束（claim 是最终调用、每轮一次）。

### C2. `initialize-milestone` 要求工作区干净

- **现象**：dirty tree 时程序 ERROR，首次跑真实 workflow 前必须先提交/清理。
- **影响**：产生一个需要用户介入的决策点。
- **候选方案**：支持 stash；分支基于当前 HEAD 而非工作区；更明确的报错提示。
- **已决策**：不处理（工作区不干净就该报错，语义正确）。

### C3. gh CLI `--milestone` 用编号失败

- **现象**：`gh issue create --milestone 1` → `could not add to milestone '1': '1' not found`，需用 milestone 标题。
- **影响**：小摩擦。
- **候选方案**：builtin program 统一用 milestone number / title 语义；或适配 gh CLI 参数。
- **已决策**：文档/示例明确 `gh issue create --milestone` 用 title、`gh api ?milestone=` 用 number；「建 branch 收敛为 builtin program」记为后续方向。

### C4. 模型路由发现无 in-band 手段

- **现象**：换模型时需人工从 `settings.yaml` 找 provider/model id。
- **影响**：Manager 决策慢。
- **候选方案**：`workflow_status` 暴露可用 provider/model；或文档约定。
- **已决策**：不处理（人工说明即可）。

---

## 附：本次手工恢复技术（供复盘）

- 状态行丢失后，用**事故前转储的完整 snapshot**（含 `managerSessionId`、`definitionHash`、完整 `definitionSnapshot`、callStack token）通过 `StateStore.createRow` 重建，置为 BLOCK 后 `node_resume` 继续。关键前提：`definitionHash` 必须与当前 catalog 一致（本次校验通过）。
- 启示：恢复依赖"恰好有转储"，脆弱；与 B2 相关。
