# 配置迁移说明：completed / failed 的 Handoff Context 对称传递

配套需求：[requirements.md](./requirements.md)（20260906-claim-handoff-symmetry）

## 1. 引擎侧（已随插件代码交付，无需配置动作）

- `node_claim` 的 `handoffContext` 对 `completed` / `failed` 完全对称：类型（string）、
  trim 后 1..8000、空值拒绝、trim 归一化全部一致；移除了工具层
  “handoffContext 仅 completed 可用”的拒绝分支与描述文本。
- 引擎 `handleClaim` 持久化 `pendingClaim.handoffContext` 时不再区分 outcome；
  Judge ACCEPT 后 completed 沿 onPass、failed 沿 onFail 原样送达后继节点
  （立即派发与 deferred 派发两条路径均已覆盖）。
- 新增 State 字段 `pendingDispatchContext`：deferred 派发窗口的一次性 transient 镜像
  （仅 running 且已 advance 未派发时存在），宿主重启后由 restart-BLOCK → resume
  连同 Manager resolution 一起重投 handoff。无 schema 迁移（run 是整体 JSON snapshot，
  可选字段，`STATE_FORMAT_VERSION` 不变）。
- failed 且无 onFail 时仍 BLOCK 且不伪造派发：claim 被消费（`pendingClaim` 清除），
  恢复信息由 Manager 的 `resolutionContext` 提供，claim 记录以 trace log 为准。

## 2. Catalog 侧（本目录的 [milestone-delivery.yaml](./milestone-delivery.yaml)）

相对部署版的差异只有 `issue-delivery` 子工作流的两个节点文案，图结构未变：

- `decide-pr`：删除“failed 不支持 handoffContext，返工上下文必须写进 summary”的指令；
  改为 failed 时 summary 只概括退回原因，handoffContext 必须携带 Issue、PR、两条分支、
  被退回 head SHA、每条阻断发现与具体修正要求；checker criteria 同步要求可信 failed
  的 handoff 携带可执行修正要求。
- `test`：测试失败声明 failed 时，完整身份/报告路径/复现步骤/返工要求从 summary 移到
  handoffContext，沿 onFail 原样交回 implement；criteria 同步。

其余节点（含所有 onPass/onFail 边、roles、childWorkflows 结构）与部署版逐字一致。

## 3. 部署步骤

1. `pnpm run build && node scripts/deploy-web.mjs`（部署插件本体；bundle 变更需重启 DSH）。
2. 备份现有 catalog（部署时已自动留档为
   `~/.dsh/workflows/milestone-delivery.yaml.<timestamp>.bak`），将本目录的
   `milestone-delivery.yaml` 覆盖到 `~/.dsh/workflows/milestone-delivery.yaml`。
3. `/dsh-flow list` 确认 milestone-delivery 校验通过（无诊断输出）。

## 4. 兼容与旧 Run 边界

- Active Run 使用 immutable Definition Snapshot：覆盖 catalog 文件不影响任何已存在 Run
  （包括事故 Run `968a74c2`）；新指令自下一次 `/dsh-flow start milestone-delivery` 生效。
- 不携带 handoffContext 的旧 claim 形态继续有效；授权、派发 lease、nodeToken、
  Judge 只读与最小状态约束均未改变。
- 旧交付/分支/Issue 的处置与本次迁移无关，仍由用户另行安排。
