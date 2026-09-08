# Pending Discussion：compaction 服务平面在 agent presets 之后的变化（boot 卡死修复）

- 日期：2026-09-08
- 来源：dsh web 启动失败排查（`dsh: plugin tree failed to load: 1 entry did not activate / dsh-agent-team-workflow: pending (waiting for service: compaction)`），对照 `deepseek-harness` `dsh-v0.1.2-rc.1` 源码核实
- 状态：**已解决**——inject 移除 `compaction`，运行期按 agent 解析（见下）

## 问题

插件模块级 `inject` 含 `compaction`（src/index.ts）。dsh 自 0.1.1-rc.7 引入 agent presets 后，压缩后端不再挂载在宿主平面：

- `packages/bundle/web-app/cordis.patch.yml` 对宿主平面的 `compaction-basic` 显式 `disabled: true`（注释：token METER 留在宿主平面，"only the compaction backend that reads it moves"）；
- standard / cordis / ptc preset 各自在 `isolate: { compaction: true }` 的 group 里挂 `compaction-basic`（`packages/preset/agent-presets/presets/*/agent.cordis.yml`）；
- 宿主平面上 `compaction` 服务因此永不出现 → 宿主行 inject 它的插件永久 pending → `assertEntriesActivated` 失败 → 整个 `dsh web` boot 卡死（社区已知坑，"rc.7" 指的是 0.1.1-rc.7；本机已装 0.1.2-rc.1，行为一致）。

## 已核实证据

- `agentPresets`（`@deepseek-ai/dsh-agent-presets`）是宿主平面服务，仅 web-app bundle 装载（base 不装）；`serviceFor(agent, name)` 是"请求来自会话外部、操作目标是某个会话"的规范读法（`packages/preset/agent-presets/src/mount.ts` `serviceForAgent` 文档），并明确说明宿主行 inject 该服务无法使用；
- 每个普通会话在 create/resume 时经 `composeAgent` 加入 preset（`packages/api/session-controller/src/agent.ts`）；subagent 子会话经 `applyChildComposition` → `composeFrom(childCtx, parent.ctx)` 加入父（Manager）的 preset（`packages/subagent/subagent/src/child-agent.ts`）；
- 裸 `ctx.agents.resume()` 不带 `setup` 时物化出的 Agent 不加入任何 preset mount：`serviceFor` 返回 undefined，且 dsh 会对"未加入 preset 就发布"的 agent 告警。

## 解决（2026-09-08 实施）

1. `src/index.ts`：`inject` 移除 `compaction`（保留 commands/tools/subagents/agents/sessions/jobs）。
2. `src/plugin/host.ts` `compactionFor(ctx, agent)`：先 `ctx.get('agentPresets')?.serviceFor(agent, 'compaction')`，回退 `ctx.get('compaction')`（base-only profile / 旧版 dsh）；两者都无 → 良性跳过（ok:true + detail）并 `ctx.logger.warn`，与 "no actor mapped" 同级——按社区约定"取不到就跳过并告警"，不让 entry 卡 pending、不让 Run BLOCK。
3. 冷物化（A4 方案 A 的 maintenance resume）补 `setup`：Manager 在线时在创建窗口 `composeFrom(agentCtx, manager.ctx)` 加入 Manager 的 preset，否则不携带 setup；join 失败仅告警（回退宿主平面/跳过）。
4. `@deepseek-ai/dsh-agent-presets@0.1.2-rc.1` 作为 devDependency 仅提供类型（`import type {}`，运行期从 DSH 安装解析）。

## 功能影响评估

- dsh web（目标部署面）：resident 子会话本来就加入 Manager 的 preset，`serviceFor` 解析到该会话自己的 isolate 实例——比旧的宿主平面共享实例更准确；冷物化补 join 后同样解析成功，A2/A4 节点边界 compact 行为不变；
- base-only profile / 旧版 dsh：回退宿主平面 `ctx.get('compaction')`，行为与旧 inject 等价；
- 唯一新语义：preset 与宿主平面都没有压缩后端时，从"boot 卡死（不可达运行期）"变为"跳过 + 告警"，Run 不再因此 BLOCK。

## 关联

- `docs/pending-discussions/a2-compact-residency-premise.md`（A2/A4 边界 compact 的冷物化方案）；
- 测试：`test/host-compact.test.ts`（preset 优先 / 无后端跳过 / setup join / 无 setup），`test/host-settlement.test.ts`（inject 断言）。
