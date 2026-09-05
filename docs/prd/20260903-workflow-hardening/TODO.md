# 0903 批次 PRD 修复进度登记

- 登记时间：2026-09-04
- 批次来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 复盘（2026-09-03）
- 用途：本文件是本批次唯一的进度看板；状态变化时更新此文件并在对应 PRD 头部同步状态行，不另开新文档。

## 1. 总览

| PRD | 主题 | 状态 | 关联问题 | 完成时间 | 证据/产物 |
|---|---|---|---|---|---|
| [A2](a2-milestone-delivery-config-hardening.md) | milestone-delivery 配置强化 | ✅ 已完成（v1 兼容版，已部署） | 3、4、5、6、10 | 2026-09-04 | 本目录 `milestone-delivery.yaml`（新配置）、`milestone-delivery.orig.yaml`（旧版备份）、[a2-config-review.md](a2-config-review.md)（语义评审）；线上 catalog definitionHash `7961a32a…` 与评审副本一致 |
| [A4](a4-cold-resume-compaction-investigation.md) | Cold-resume Compaction 调查 | ✅ 方案 A 已实现并合并 main（PRD 已审查）；部署与运行时验证延后统一进行 | 11 | — | 见 §3 与 [a4-code-findings.md](a4-code-findings.md) |
| [A1](a1-claim-admission-and-judge-confirmation.md) | Claim Admission 与 Judge 确认协议 | ✅ 已实现并已合并 main（分支 a1-claim-admission 按 `a1-design.md` §11 七步落地；两轮设计评审 + 三轮实现评审全部修正；209/209 单测 + e2e v2 全链路）；部署与运行时验证延后统一进行 | 1、2、7 | 2026-09-05 | 见 §3.2 与 PRD §13 结项记录 |
| [A3](a3-workflow-trace-observability.md) | Workflow Trace 可观测性 | ✅ 已实现（分支 a3-trace-observability；AC4 revision 经 A1 决议由 token 前缀 + CORRECT 事件等价覆盖；审查 7 项已全部修正）；部署与运行时验证延后统一进行 | 9 | 2026-09-04 | 见 §3.1 与 PRD §13/§14 实现与审查记录 |
| [A5](a5-provider-retry-boundary.md) | Provider Retry 边界 | ⬜ 未开始（跨插件依赖） | 8 + 额度问题 | — | 需在 commandcode provider 侧建立 retry 有界化 Issue，Workflow 侧只保留通用恢复 |

实施顺序依据 README §4：A1（Phase 1）→ A3/A4/A5（Phase 2，可并行）→ A2 定稿 + 隔离验收 run（Phase 3）。
本轮按用户决策提前执行了 A2 的 v1 兼容版；A1 落地后需按 §2 遗留项回补配置文案。

## 2. A2 完成登记（含遗留）

已完成并验证：

1. 新配置通过受限 YAML 解析 + 严格 schema + 静态校验 + 语义责任矩阵评审（a2-config-review.md 六项记录齐全）。
2. 已部署至 `~/.dsh/workflows/milestone-delivery.yaml`，线上 catalog 扫描 `diagnostics: []`，`smoke-test` 不受影响。
3. 插件回归全绿：`pnpm test` 135/135，`pnpm run build` 干净。
4. 交付闭环语义落地：implement publish → 默认分支 ancestry 集成 → close-milestone → END；`final-review`/`close-milestone` FAIL → `plan-remediation`。
5. 设计文档 `docs/design/configurable-agent-workflow-graph.md` §8 示例已同步为新配置。

遗留（登记在案，不阻塞 A2 关闭）：

- **L1（依赖 A1）**：Judge 文案仍为 v1 `PASS|FAIL`，`REJECT`/correction-feedback 语义落地后需升版配置（含 schema version 决策，见 README §5）。
- **L2（依赖 A1）**：v1 引擎丢弃 failed claim 的 handoffContext 且不回传 Judge reason，新配置用「completed claim + handoff 携带 verdict/findings」规避；A1 落地后应移除该 workaround，恢复 failed 语义直传。
- **L3（Phase 3）**：AC13 隔离 GitHub 仓库完整 acceptance run 未执行，建议与 L1 一并处理，避免文案二次返工。
- **L4**：变更未提交 git（用户未要求提交；`AGENTS.md` 为既有未跟踪文件，不属于本批次）。

## 3. A4 调研登记

- 2026-09-04 **代码层调研完成**：结论见 [a4-code-findings.md](a4-code-findings.md)（基于 DSH 源码 `D:\project\github\deepseek-harness` 的静态证据）。
  - 根因（H1 证实）：Actor turn 结算后 `SubagentContinuationManager.watchSettlement` 自动拆除 Activation；下一 Node dispatch 前必然隔着完整 Judge 生命周期，compact 检查点处 Actor 恒为 cold，`cold-resume skip` 是常态路径而非异常。
  - 影响（H2 部分证伪）：coldResume 全量重放持久历史，Actor 携带所有历史 Node transcript 进入新 Node；唯一兜底是默认开启的自动压力压缩（0.8×窗口触发），Node 边界压缩从未发生。A2 新配置多 Issue 循环会放大该成本。
  - 可行修复：**方案 A（cold materialize → compactNow → dispose → followup）可行**，全部用现有公开 API（`ctx.agents.resume` + `ctx.compaction.compactNow` + `AgentHandle.dispose`），仅插件侧改动；方案 B 无公开 API，方案 D 证伪，方案 C 备选。
- 待办：隔离 harness 运行时验证（A4 PRD §4/AC1/AC3/AC4/AC6），数据齐备后按 AC9 回写设计文档。
- 2026-09-04 **方案 A 已实现**（分支 `a4-cold-compact`）：`src/plugin/host.ts` `compactRoleActor` cold 分支改为 resume→compactNow→dispose；resident 窄竞态 `busy` 降级跳过；resume/compact/teardown 失败 fail-closed BLOCK（复用 A2 R4 框架）。新增 `test/host-compact.test.ts`（11 用例），全套 146/146 + build + e2e smoke 通过。同步回写：`CONTEXT.md` Role Actor 词条、0902 A2 PRD 状态行、`docs/pending-discussions/a2-compact-residency-premise.md` 解决记录。PRD 审查意见已采纳：摘要模型与 Actor 模型可以不一致（a4-code-findings.md §3-A.2 已修正）。
- **部署策略（用户决策 2026-09-04）：已合并到 main；build+deploy 与运行时验证（A4 PRD §4/AC1/AC3/AC4/AC6）在其他 PRD 完成后统一进行。**

## 3.1 A3 实现登记

- 2026-09-04 **A3 已实现**（分支 `a3-trace-observability`，自 main 新建）：trace log 迁移到 fmt=2 统一 `key=value` + JSON escaping 事件格式，新增 CLAIM/JUDGE/ROUTE/BLOCK/RESUME/RESPAWN/RESOLVE/PROGRAM/MODEL/PUSH/POP 事件，COMPACT 升级为 fmt=2；R5 全部 BLOCK 入口覆盖（含 restart-reconcile，前提为 `traceLogPath` 可选字段随 RunState 持久化）；每 run 首次日志失败经 `engine.traceWarn` → `ctx.logger.warn` 告警一次。实现决策与覆盖对照见 A3 PRD §13。
- 2026-09-04 **审查修正（首轮 7 项全部接纳，PRD §14）**：Escaped 类型化包装修复 MODEL 多行注入（S1/AC9）、trace 边界 redact 凭据兜底 + fixture（AC10）、CONTEXT.md State 闭集同步（S2）、traceWarnedRuns 清理（S3）、CLAIM 顺序改为 put 前并声明 at-least-once（S4）、AC4 状态措辞（revision 待 A1）。
- 2026-09-04 **复审修正（第二轮 8 项全部接纳，PRD §15）**：START（预检查+trace-before-create）与 RESPAWN（trace-before-put）消除反向 crash gap；ROUTE/PUSH/POP/COMPACT 补 token 短前缀去重；redact 覆盖 raw 标识符与 Basic auth；warn marker 失败启动清理；PRD §13.2 过期表格修正。
- 2026-09-04 **第三轮复审修正（6 项全部接纳，PRD §16）**：rawField 恢复不脱敏（合法 `sk-*` 结构 ID 保留），MODEL provider/model 定点 redact；START create 故障 seam 测试；RESPAWN 表格/事件示例/AGENTS.md 文档收口。
- 验证：`pnpm test` 169/169、`pnpm run build` 干净、`pnpm run test:e2e` fmt=2 断言全过（隔离临时 home）。
- 部署策略与 A4 一致：本批 PRD 完成后统一 build+deploy，运行时验证项（52 分钟空白回放、warning 实际输出、COMPACT 真实文案）见 PRD §13.3。

## 3.2 A1 设计登记

- 2026-09-05 **机制设计定稿**（`a1-design.md`，分支 `a1-claim-admission`，commit 01c8d0a）：R3 Host seam 验证通过（`exec.callId` + `tool/call` 先于工具体落 log + `session.events` 同步读；`steerManager` 经 `createUserMessage` 捕获 messageId）；版本决策 D1 = v2 原地升级（用户确认）；D2 不加 revision 字段（A3 遗留 AC4 关闭）；D3 MODEL 上限 64/128。
- 2026-09-05 **设计评审修正（3 阻塞 + 4 中等 + 4 补充全部接纳）**：① turnbind 覆盖 Code Mode 嵌套调用（`tool/code-dispatch-start` 无 turn，按 `rootCallId` 定位根 `tool/call` + subCallId 校验）；② Manager 路径 correction 证据改经持久化 `pendingCorrection` 进入下一 Judgment Packet `[previous rejection]` 段（不放宽 projection source 过滤）；③ 判定期/修正期禁止对 boundary executor role 的 model override + correction 重派以 `nodeBoundary.executorSessionId` 解析原 Actor；④ `TransientDispatch` 联合类型贯穿 DispatchBook/persistDeferred/dispatchNow/dispatchCurrent；⑤ lease 并入 DispatchBook（`dispatchCurrent` 返回派发身份，发布收敛于 dispatchNow 单点，零新增清理点）；⑥ MODEL 上限字段名纠正为 `roles[*].model`/`judgeRole.model` 并统一 trim-规范化 helper；⑦ A3/主设计文档 revision 表述收口、v2 迁移清单扩充、快照先于清除、测试计划补 5 组用例。
- 2026-09-05 **第二轮设计评审修正（1 阻塞 + 3 中等 + 5 补充全部接纳）**：① `node_block` lease 绑定限定 actor-task——builtin-program/child-workflow 节点 Manager block 保持控制面（二者不发 lease，按 executor 归类会永久拒绝）；无 lease 节点 book 显式初始化 `dispatchMessageId: undefined, leaseConsumed: true`；② `leaseConsumed` 移到 `state.put` 成功之后（put 失败 lease 未消费、可重试），node_block 同理不留 consumed 残留；③ model override 守卫改按 Node role + boundary 判定（不依赖 roleActors 映射），并新增 blocked 恢复通道（correction BLOCK 态 override + boundary 重置 → resume 用新路由建 replacement 且证据照常送达）；④ Code Mode start 事件补 `rootCallId` 双绑定校验；⑤ 测试补 5 组（program block 回归、acceptance 边界、correction×restart、persistDeferred 初始化、blocked 恢复通道），设计状态行定稿，TODO/README 文件名与措辞同步。
- 2026-09-05 **实现完成（按 §11 七个提交）**：① `turnbind.ts` 双路径 + `steerManager` 返回 messageId；② DispatchBook lease + claim/block 准入门（acceptance 边界在 put 之后；program/child block 控制面分类）；③ `node_claim` 去 nodeToken + SUBMISSION_CONSTRAINT 更新；④⑤ judge v2 真值表 + REJECT correction 流（`pendingCorrection`/CORRECT 事件/TransientDispatch/resume 重建/override 守卫与 blocked 逃生通道）；⑥ v2 原地升级 + `judge.claim-correct` 更名 + MODEL 64/128 上限（`normalizeModelRoute`）+ milestone 配置/测试夹具/CONTEXT/README/设计文档/AGENTS/A3 文档收口；⑦ e2e 重写为内嵌 v2 catalog 的 Manager+Role 双 REJECT→correction→再 ACCEPT 全链路。验证：build 干净、unit 202/202、`E2E SMOKE PASS`。遗留到批末：统一 build+deploy + 真实 catalog 重新生成。
- 2026-09-05 **实现评审修正（3 项全部接纳 + 2 低风险缺口补齐，commit 1e2ec08）**：① `handleBlock` 改按 Node role 分类——`executorSessionOf` 读 `roleActors` 映射，当前 role 映射缺失时 `''` 使 executor 检查与 lease 门槛双双短路（fail-open，兄弟 role actor 可绕过 lease block 当前 Node）；② `handleSetRoleModel` 对 completed Run（callStack=[]）不再读 top frame（空栈抛错回归）；③ LIMITS 为 trim 语义，tool 层一律传 trim 结果 + engine 对 summary/handoff/reason/resolutionContext 防御性 trim——首尾海量空白不再把近 MB 级文本写进 State/correction prompt。低风险缺口：`executorSessionOf` 断言级冗余改为并入 lease 判据（设计 §5.1 修订注）、persistDeferred 无 book 兜底派发专项用例。验证：unit 209/209、build、E2E SMOKE PASS。

## 4. 待办清单

- [ ] A4：运行时验证（方案 A 已实现并合并 main；部署与其他 PRD 完成后统一 build+deploy + 隔离 harness 验证 AC1/AC3/AC4/AC6，数据齐备后按 AC9 回写设计文档）
- [ ] A1：批末统一部署（build+deploy + 真实 `~/.dsh/workflows/milestone-delivery.yaml` 重新生成；旧 v1 运行行 fail-closed，退出 `/dsh-flow reset`）与运行时验证（实现已完成，见 §3.2）
- [ ] A3：运行时验证（方案已实现；统一部署后回放 52 分钟空白场景、确认 warning 输出与 COMPACT 文案）
- [ ] A5：在 commandcode provider 仓库建 retry 有界化 Issue；验证 workflow 通用 BLOCK/resume 恢复
- [ ] A2 遗留 L1/L2（配置已在 A1 实现中随 v2 迁移升版；L2 handoff-verdict workaround 待在真实 run 中确认 failed-claim 语义直传后移除）；MODEL 上限（provider/modelId 64/128）已随 A1 实现落地
- [ ] Phase 3：隔离 GitHub 测试仓库完整 acceptance run（default branch contains delivery、Issues closed、Milestone closed、END）
- [x] A2：v1 兼容配置强化并部署（2026-09-04）
- [x] A3：fmt=2 trace 事件全覆盖实现 + 单测/e2e/文档（2026-09-04，分支 a3-trace-observability）
- [x] A1：dispatch lease + claim 自动绑定 + REJECT correction + v2 原地升级（2026-09-05，分支 a1-claim-admission；见 §3.2 与 PRD §13）
