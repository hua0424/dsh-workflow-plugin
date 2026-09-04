# 0903 批次 PRD 修复进度登记

- 登记时间：2026-09-04
- 批次来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 复盘（2026-09-03）
- 用途：本文件是本批次唯一的进度看板；状态变化时更新此文件并在对应 PRD 头部同步状态行，不另开新文档。

## 1. 总览

| PRD | 主题 | 状态 | 关联问题 | 完成时间 | 证据/产物 |
|---|---|---|---|---|---|
| [A2](a2-milestone-delivery-config-hardening.md) | milestone-delivery 配置强化 | ✅ 已完成（v1 兼容版，已部署） | 3、4、5、6、10 | 2026-09-04 | 本目录 `milestone-delivery.yaml`（新配置）、`milestone-delivery.orig.yaml`（旧版备份）、[a2-config-review.md](a2-config-review.md)（语义评审）；线上 catalog definitionHash `7961a32a…` 与评审副本一致 |
| [A4](a4-cold-resume-compaction-investigation.md) | Cold-resume Compaction 调查 | ✅ 方案 A 已实现并合并 main（PRD 已审查）；部署与运行时验证延后统一进行 | 11 | — | 见 §3 与 [a4-code-findings.md](a4-code-findings.md) |
| [A1](a1-claim-admission-and-judge-confirmation.md) | Claim Admission 与 Judge 确认协议 | ⬜ 未开始（语义已确认） | 1、2、7 | — | PRD 已定稿，待实现 |
| [A3](a3-workflow-trace-observability.md) | Workflow Trace 可观测性 | ⬜ 未开始（方案已确认） | 9 | — | PRD 已定稿，待实现 |
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

## 4. 待办清单

- [ ] A4：运行时验证（方案 A 已实现并合并 main；部署与其他 PRD 完成后统一 build+deploy + 隔离 harness 验证 AC1/AC3/AC4/AC6，数据齐备后按 AC9 回写设计文档）
- [ ] A1：dispatch lease + claim 自动绑定 + REJECT correction feedback（含 schema version 决策）
- [ ] A3：Actor claim / Judge 结果 / BLOCK/RESUME / POP trace
- [ ] A5：在 commandcode provider 仓库建 retry 有界化 Issue；验证 workflow 通用 BLOCK/resume 恢复
- [ ] A1 落地后：执行 A2 遗留 L1/L2（配置升版 + 移除 handoff-verdict workaround）
- [ ] Phase 3：隔离 GitHub 测试仓库完整 acceptance run（default branch contains delivery、Issues closed、Milestone closed、END）
- [x] A2：v1 兼容配置强化并部署（2026-09-04）
