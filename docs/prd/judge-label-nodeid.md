# PRD：Judge Subagent 显示名携带当前 NodeId

- 日期：2026-09-03
- 来源需求（用户原话）：项目插件在工作流过程中会有 judge 这个 subagent 生成，但是多个 judge subagent 的名称都一样，不像 workflow 的 role 一样有角色名可以区分。调整一下在 spawn workflow-judge 的时候加上当前 nodeid 以便识别。测试的时候不要影响到当前的运行环境。

## 1. 背景与目标（User Goal）

当前 Role Actor 与 Judge 都以 `startContinuable` 生成持久化 subagent：Role Actor 的 `label` 带角色名（`workflow-role:<roleKey>`），能在会话层级区分；而 Judge 的 `label` 是硬编码的 `'workflow-judge'`（`src/plugin/host.ts` `startJudge`），同一 run 内所有 Node 的 Judge 显示名完全相同。用户在 Web GUI 的 subagent 列表里无法分辨某个 Judge 对应哪个 Node。

目标：**每次 spawn Judge 时，`label` 携带当前被判定 Node 的 nodeId**（如 `workflow-judge:implement`），与 Role Actor 的命名风格对齐，让用户一眼识别 Judge 所属节点。

## 2. 功能需求

- **R1 Judge label 携带 nodeId**：spawn Judge 时 `label` 从固定 `'workflow-judge'` 改为 `workflow-judge:<nodeId>`，其中 `<nodeId>` 为**当前被判定 Node 的 id**（即 `topFrame(run).nodeId`，在 spawn 时点的 call stack 顶帧）。
- **R2 纯函数提取（可无宿主测试）**：label 构造逻辑提取为 `src/roles/roles.ts` 中的纯函数 `judgeLabel(nodeId: string): string`，由 `host.ts` 消费。与既有 `judgeSpawnPlan` / `roleDenyList` 的「纯决策逻辑在 roles.ts、适配在 host.ts」模式保持一致。
- **R3 隔离测试**：新增测试只走纯函数/合成 fixture，绝不触碰真实 `~/.dsh` home、真实 state 行或真实 workspace（延续 `docs/pending-discussions/live-e2e-issues.md` B1 约定）。

## 3. 范围（Scope）

- `src/roles/roles.ts`：新增 `judgeLabel` 纯函数。
- `src/plugin/host.ts` `startJudge`：`label` 改由 `judgeLabel(topFrame(run).nodeId)` 生成，移除字面量 `'workflow-judge'`。
- `test/roles.test.ts`：新增 label 构造的单元测试。

## 4. 非目标（Non-Goals）

- 不改 Judge 的 `childId` / `judgeSessionId`（仍为 engine 预留 UUID，唯一性不受影响）。
- 不保证跨 child-workflow 多次调用同一 Node 时 label 全局唯一（同一 Node 重复判定时 label 相同属预期；识别目标是「属于哪个 Node」，不是「第几次 spawn」）。
- 不新增 spawn 序号 / 时间戳等判别式。
- 不改 Role Actor 的 label，不改 engine/state/checker 的既有行为。
- 不做 Web GUI 历史 Judge 条目的清理。

## 5. 验收标准（Acceptance Criteria）

- **AC1**：`judgeLabel('implement')` 返回 `'workflow-judge:implement'`，单测覆盖。
- **AC2**：`src/plugin/host.ts` `startJudge` 不再出现字面量 `'workflow-judge'`，label 由 `judgeLabel` 生成且内含当前 top-frame `nodeId`。
- **AC3**：`pnpm test` 全绿（新增用例 + 既有用例回归）。
- **AC4**：`pnpm run test:e2e` 全绿，且仍走隔离临时 home（真实 `~/.dsh` 与当前 run 状态行不受影响）。

## 6. 技术约束

- `nodeId` 满足 `[a-z][a-z0-9-]*`，拼接产物 `workflow-judge:<nodeId>` 不含空格等非法字符，可直接作为 subagent `label`。
- label 构造为纯函数、无宿主依赖；测试不触 DSH 服务。
- 改动局限于 `roles.ts` + `host.ts` + `roles.test.ts`，不侵入 engine / state / checker / catalog。
