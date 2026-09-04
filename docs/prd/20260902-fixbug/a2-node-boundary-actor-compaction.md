# PRD：A2 Role Actor Node 边界 Compact

- 日期：2026-09-02
- 来源问题：`docs/pending-discussions/live-e2e-issues.md` A2
- 状态：**R5 已被 A4 方案 A 取代（2026-09-04）**——cold Actor 不再跳过，改为 `ctx.agents.resume` 无 prompt 物化 → `compactNow` → `dispose` 后再 followup（见 `docs/pending-discussions/a2-compact-residency-premise.md` 解决记录与 `docs/prd/20260903-workflow-hardening/a4-code-findings.md`）；AC1/AC8 解除挂起，验收移至 A4 隔离 harness

## 1. 背景

Role Actor 是「首次创建、跨 Root/Child Run 复用」的 continuable subagent（CONTEXT.md 既有语义），目的是保留执行者的过程记忆。但长 run 下历史无限累积，后期 actor 频繁 `failed before it finished`。

DSH 自带 auto-compaction（`agent/pre-step` 观测 pressure，`agent/request-error` 做 overflow recovery），对所有 agent 统一生效；但它只按「压力阈值」被动触发，不按 workflow 的 Node 边界主动切分。

本调整在 workflow 的 **Node 边界** 主动 compact：每派发一个新 Node 前，对 idle 的 Role Actor 执行一次显式 `compactNow`，把历史压缩成一个结构化 checkpoint summary。这样 Actor 的上下文被稳定控制在「一个 summary + 当前 Node」的范围，不随 Node 数量线性膨胀。

## 2. 目标

1. 每个 Node 派发前，对已有历史的 Role Actor 主动执行一次 compact。
2. 统一处理所有 Role Actor，不引入 per-role 生命周期开关。
3. Manager（用户主会话）不 compact。
4. compact 无可压内容时正常继续派发；compact 抛异常时 BLOCK（外部故障）。
5. cold-resume 场景跳过 compact，靠 DSH auto-compaction 兜底。

## 3. 术语

- **Node 边界 compact**：在派发新 Node 前、目标 Actor 处于 idle 时，对 Actor Session 执行的显式 `compactNow`。
- **checkpoint summary**：compact 引擎生成的结构化 summary（Primary Request / Files / Errors / Current Work / Next Step / Critical Context 等），以 `<compacted-summary>` 包裹的 user message 替换旧历史范围。
- **resident Agent**：in-process continuable child 当前驻留的 live Agent 对象（可通过 `ctx.agents.get(childId)` 取得）；drained 后不存在。

## 4. 规则

### R1：对象与时机

在 `dispatchCurrent` 中，仅对 **非 manager 的 actor-task** 执行 Node 边界 compact：

- 当前 Node 已 mapping 到已有 Role Actor（`roleActors[roleKey]` 存在）时，在 `followup` 之前对其执行 compact；
- 无 mapping（首次创建该 role）时，Actor 尚无历史，直接 `ensureRoleActor` 创建，不 compact。

### R2：Manager 不 compact

Manager 是用户主会话，承载真实对话，禁止被 compact；Node 边界 compact 只针对 continuable Role Actor。

### R3：统一处理，无 per-role 开关

不对 schema 增加 `lifecycle` 或任何 per-role 配置。所有 Role Actor 一律在 Node 边界 compact，保持最小配置面。

### R4：compact 结果处理

- `compactNow` 返回 `null`（无 compactable range，例如历史尚小）→ 正常继续派发；
- `compactNow` 抛 `ManualCompactionError`（`busy` / `cancelled` / `changed` / `summary` / `commit` / `persistence`）→ 当前 Node 进入 BLOCK，`blockReason` 携带可读 detail，并主动通知 Manager。

`null` 不是失败：它表示「没有可压内容」，Actor 直接以当前历史继续。

### R5：cold-resume 跳过

若目标 Actor 无 resident Agent（已 drain，例如 host 重启后），此刻无法取得 `runMaintenance`/Agent 对象，跳过 compact，`followup` 走 cold-resume，靠 DSH auto-compaction 兜底。

### R6：仅 Node 边界，Node 内不重复

compact 只发生在「进入新 Node」的派发点。同一 Node 内的 BLOCK/resume（含 `NEED_CONTEXT`、技术故障恢复）不重复 compact，以保留该 Node 内的执行上下文。

### R7：结果记录

每次 Node 边界 compact 的结果（跳过 / 成功压了多少 / 失败 reason）以 best-effort 写一行到该 run 的 trace log；记录失败不影响派发。

## 5. 与 A1/A4 的关系

- A1 在 Node 实际 dispatch 时建立 `NodeContextBoundary`（供 Judge projection）；A2 的 compact 在同一 dispatch 点之前执行。两者都在 Node 边界操作，但对象不同（Judge 投影 vs Actor 压缩）。
- A4 已定义「技术故障 BLOCK 时主动 steer Manager 固定模板」的通用机制；A2 的 compact 失败 BLOCK 复用该机制，模板中说明「Node 边界 compact 失败」与可选动作（resume 重试、换 summarization 模型等）。

## 6. 状态模型

不新增持久化状态字段。compact 是派发前的即时操作；其历史完全由 DSH Session log（`compaction/*` 事件）保留，Workflow SQLite 不记录。

## 7. 非目标

- 不引入 per-role 生命周期开关或 schema 扩展。
- 不以省 token 成本为目标（成本通过换小窗口 model 等外部手段处理）。
- 不处理 compact 后 summary 丢失前期执行细节的问题（任务成败交给模型能力，失败由 BLOCK + Manager 兜底）。
- 不修改 DSH 的 compaction policy（`thresholdRatio` / `modelPolicies` 等）。
- 不让 Role Actor 自行调用 `/compact` 命令（命令不对 subagent 暴露）。

## 8. 验收标准

- **AC1 边界 compact**：已有历史且仍 resident 的 Role Actor 在派发新 Node 前被执行一次 `compactNow`，compact 成功后再派发。**（评审修正：受 DSH continuable 语义限制降级为条件性 AC——continuable child quiescent 后 Activation 被 settlement watcher 自动释放，派发点通常已无 resident Agent，实际触发 compact 的机会有限；未触发时按 AC6 语义跳过。）**
- **AC2 Manager 豁免**：Manager actor-task 派发前不触发 compact。
- **AC3 首次创建豁免**：Role Actor 首次创建（无历史）不 compact，直接创建并派发。
- **AC4 无内容可压**：`compactNow` 返回 `null` 时正常继续派发，不 BLOCK。
- **AC5 compact 失败 BLOCK**：`compactNow` 抛 `ManualCompactionError` 时 Node BLOCK，`blockReason` 含可读 detail，并通知 Manager。
- **AC6 cold-resume 跳过**：Actor 无 resident Agent 时跳过 compact，`followup` 走 cold-resume 正常派发。
- **AC7 Node 内不重复**：同一 Node 的 BLOCK/resume 不触发第二次 compact；进入下一 Node 才再次 compact。
- **AC8 上下文受控**：**（评审修正：当前 DSH 语义下不可达成，挂起）** 连续执行多个 Node 的 Actor，其模型上下文为「checkpoint summary + 当前 Node 内容」的理想目标；实际由 DSH pressure-based auto-compaction 兜底。待真实 e2e 数据与 DSH maintenance API 支持后再验收（见 `docs/pending-discussions/a2-compact-residency-premise.md`）。
- **AC9 回归门禁**：现有单元 / engine / e2e smoke 全过，并新增 Node 边界 compact、compact 失败 BLOCK、cold-resume 跳过的覆盖。

## 9. 已确认决策

1. 统一对所有 Role Actor 在 Node 边界 compact，不引入 per-role 开关。
2. compact 失败（异常）→ BLOCK；无可压内容（`null`）→ 继续派发。
3. cold-resume 场景跳过 compact，靠 DSH auto-compaction 兜底。
4. Manager 不 compact。
5. **（评审补充）** resident idle Agent 存在时 best-effort compact；resident 不存在时静默跳过（现状），AC1/AC8 的完整达成依赖 DSH 提供 maintenance-resume 类能力，真实 e2e 后再定。
