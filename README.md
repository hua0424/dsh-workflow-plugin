# dsh-workflow-plugin

DSH Agent-Team Workflow plugin — configurable serial Agent/Subagent team
workflows (`agent-workflow/v2`).

**当前状态：T1–T9 的 Node Execution Runtime 重构已实现、审查并合入 `main`，A01–A30 自动化验收账本见 [`docs/testing/node-execution-runtime-acceptance.md`](docs/testing/node-execution-runtime-acceptance.md)；本仓库不自动部署——部署是需用户显式授权的独立动作（见「Installation」）。验收基线宿主为 exact DSH `0.1.5-rc.2`（对齐记录见根目录 `AGENTS.md`）。现行验收入口是一条命令 `pnpm run verify`（typecheck + 全量 suite + 两套受控 smoke），逐项口径见 [`docs/testing/runtime-refact-test-migration.md`](docs/testing/runtime-refact-test-migration.md)。**
三表闭环已接通同 execution 的 REJECT/NEED_CONTEXT、Manager 定向 resume/Judge respawn、争议协议、Manager-only 有界历史，以及关闭重开后的统一恢复。Role Actor 在新 visit（含自环）前安全收口并 compact 后续接同一 continuable Session；同 execution 返工/resume 不做 Node 边界 compact，持久 Session 确认不存在时由 fresh replacement 接手完整材料。

受控 Runtime/SQLite smoke 与 exact DSH `0.1.5-rc.2` 真实 Host 组合分开报告：[`A01–A30 验收账本`](docs/testing/node-execution-runtime-acceptance.md)记录 Role Activation cold continuation、真实 Basic compaction、ToolRuntime claim/Judge 与 Host interrupt 后同 execution BLOCK/resume。脚本 LLM 不代表外部模型质量，Activation cold 也不冒充完整进程重启。

T6 重启 reconciliation 不依赖崩溃前存在中断事件：未结束工作单保留 phase/input/claim 并进入可恢复
BLOCK。Manager resume 重新进入普通 driver；working 或未可靠收口的 claim 默认交 Actor 检查现场并重新
claim，settled claim 或显式 judge 决议进入只读 Judge。恢复派发收到“已完成勿重复副作用”的固定提示，
新 dispatch/message 身份拒绝迟到 Turn；不提供外部副作用 exactly-once 保证。

T8 的普通 `/dsh-flow reset` 仅允许当前 Manager，把 active Run 标为 `terminated` 并保留工作单、事件、Snapshot 与 Role mapping；它撤销旧推进资格但不 drain/cancel 外部动作。terminated 后显式 start 会先拒绝已知仍 active/idle 的旧 Role/Judge，Host unknown 风险由用户/Manager 核查。旧 execution/events 仍保留供维护读取，但公开 `workflow_status` 只允许查询当前 Run 的 execution，旧/新 Manager 都不能跨 Run 读取。

当前 claim 合同为 `node_claim({outcome, handoff})`：handoff 必填、trim 后
1..8000 字符，completed/failed 对称，END 也交付；明确拒绝旧 summary/handoffContext。
claim 不携带 nodeToken，运行时核对真实派发身份。Judge、Manager、后继与最终结果
共用原文，无独立摘要或 fallback。Catalog v2 保持，v1 Catalog 被拒绝。

State format 为 `agent-workflow-state/v9`：`runs`、`node_executions`、
`node_execution_events` 保存位置、当前工作与关键快照；旧 v3–v8/legacy 或坏库进入 maintenance 并
fail-closed，不静默迁移。只有 root 人类显式执行 `/dsh-flow reset --incompatible-store` 才会备份整个 SQLite（含 WAL；坏库保留原始 bundle）后切换空 v9，失败不替换源库。REJECT 后当前单保留一代完整 previous claim/Judge 与统一 judgment 关联，
补充/恢复材料只保留当前完整版本，旧值由 events 解释；正常恢复不回放 events。

当前接通 Actor Task 的 ACCEPT/REJECT/NEED_CONTEXT、正常 BLOCK 的 auto/actor/judge resume、有效 claim 下 Judge respawn、Program 直接结算/人工裁决、嵌套 Child 原子返回、FAIL 无出口重开、显式 Role/Judge model override、Reset/terminated（自 #30 起同 workspace 任意顶层会话可执行，工作流内部参与者拒绝），以及 `workflow_status` 的 Manager-only 当前 Run execution 历史分页（stable after、limit ≤ 50，跨 Run 拒绝）。标准 Web profile 必须提供正式 `jobs` 与 `compaction`；Session persistence 缺失/读取异常只记为 availability unknown，不冒充 missing。不兼容 Store 的 status/全库备份退出命令在 maintenance 下保持可用，普通 list/start/tools 明确拒绝，不退回旧引擎。
真实宿主组合命令为 `pnpm run test:real-host`；受控 smoke、真实 Host + 脚本 LLM、外部模型行为三者不得混称。

## Current documentation

- [`CONTEXT.md`](CONTEXT.md) — 当前领域术语与 T6–T9 实现边界。
- [`docs/design/node-execution-runtime.md`](docs/design/node-execution-runtime.md) / [`spec`](docs/specs/node-execution-runtime.md) — refact 权威设计与验收基线。
- [`A01–A30 验收账本`](docs/testing/node-execution-runtime-acceptance.md) / [`旧测试迁移`](docs/testing/runtime-refact-test-migration.md) — 动态证据、真实 Host 边界与删除映射。
- [`长尾讨论`](docs/pending-discussions/runtime-refact-long-tail.md) — 不阻塞本次主要流程的后续边界。
- [`docs/work-plans/runtime-refact.md`](docs/work-plans/runtime-refact.md) — T1–T9 历史工单依赖与分票证据（已完成并合入）。
- [`docs/design/configurable-agent-workflow-graph.md`](docs/design/configurable-agent-workflow-graph.md) — 旧版设计参考，不覆盖 refact 新规格。
- [`docs/testing/acceptance-test-plan.md`](docs/testing/acceptance-test-plan.md) / [`report`](docs/testing/acceptance-report.md) — 原单表实现的历史验收资料（带版本标记，保留适用版本；不代表当前实现），现行入口见 [`旧测试迁移/现行验收入口`](docs/testing/runtime-refact-test-migration.md)。
- [`docs/example/`](docs/example/) — copyable workflow config template (`workflow-template.yaml`) + config/model reference for new workflows.

Superseded `feature-delivery/v1` designs remain available in Git history.

## Repository layout

```
src/
  index.ts            plugin entry (Cordis apply: command+tools+engine wiring)
  types.ts            domain types, limits, error classes
  catalog/            restricted YAML 1.2 parse + strict schema + static validation + scan
  state/              SQLite store (node:sqlite) + invariants + nodeToken
  engine/             serial node advancement, token settlement, deferred dispatch
  roles/              role/judge spawn plans, model routes, deny/allow lists
  judge/              transcript projection + judge.claim-correct Judgment Packet + judge_claim protocol
  tools/              workflow control tools + read-only inspection wrappers
  commands/           /dsh-flow list|start|status|reset
  programs/           git/gh runner + 2 builtin programs
  plugin/host.ts      adapters wiring real DSH services into the engine
cordis.patch.yml      profile-bundle patch (inserts the plugin row)
```

## Development

- Build: `pnpm run build` (tsc → `lib/`). The profile bundle loads `lib/index.js`; Node refuses to strip `.ts` inside node_modules, so the compiled output is the runtime artifact. 脚本用 `node node_modules/typescript/bin/tsc` 显式调用编译器：`.bin` 链接缺失（pnpm install 未物化 bin）时 `tsc` 不在 PATH，文档命令仍必须可直接跑通。
- 验收（现行单入口）：`pnpm run verify` = `typecheck`（`tsc --noEmit`）+ `test:suite`（全量 suite）+ `test:smoke`（两套受控 smoke）。逐项：
  - `pnpm test` — 全量 node:test（标准入口，按文件隔离子进程）。
  - `pnpm run test:suite` — 同样全量、`--test-isolation=none`：受限沙箱禁止派生进程（`spawn EPERM`）时的等价入口；Node 22.x 该 flag 名为 `--experimental-test-isolation=none`。
  - `pnpm run test:smoke` — 统一受控 smoke 入口 = `node scripts/t3-smoke.mjs`（`reuse: continuable`：Role 跨节点复用 + 节点边界 compact + END + 关库重开）&& `node scripts/e2e-smoke.mjs`（缺省 `reuse: node`：REJECT 修正 + failed onFail 自环 + 离开节点 drain + trace）。二者都只用独立临时 home，不读写真实 `~/.dsh`。
  - `pnpm run test:real-host` — 单独运行 exact 0.1.5-rc.2 真实 Host 组合（单文件直跑，不派生 test runner 子进程）；与上面两类 controlled smoke 分开报告，三者不得混称。
  - 计数口径：0 fail；仅允许**环境条件**跳过的用例（`test/programs.test.ts` 两条真实 spawn 用例在禁派生进程的环境按 EPERM 探测跳过，其逻辑由受控适配器用例覆盖）——不靠隐藏失败换取 0 skip，逐项替代见迁移账本。
- 诊断工具：`node scripts/check-state-rows.mjs <state.sqlite3 路径>` 只读诊断指定库（显式路径、不默认真实 home、复制成临时快照后只读打开，不改写目标库）；当前 v9 / 旧单表 / 未知布局 / 坏库分别给诊断，退出码 0/1/2。
- Runtime deps: `yaml`, `zod`. Host API packages (`@deepseek-ai/dsh-*`) are dev-dependencies only — at runtime they resolve from the DSH installation via the profile-module fallback (`~/.dsh/profiles/node_modules`), exactly like the shipped bundles. `jobs`/`compaction` use exact `0.1.5-rc.2` types and are required Host services, not plugin runtime dependencies.

## Installation (development)

下列流程需要**用户显式授权**：本轮验收只生成隔离产物（`--out`），不写 `~/.dsh`、不影响任何真实 Run。

The plugin is a DSH Profile Bundle, deployed wfgate-style into a local bundle
directory under the web profile (the same layout the shipped bundles use, so
`@deepseek-ai/*` resolves to the HOST's instances via the profiles fallback).

1. `pnpm run build` — compile `lib/`.
2. `node scripts/deploy-web.mjs` — copies `lib/`, `cordis.patch.yml`, and a
   bundle `package.json` (version/dependencies 取自本仓库 `package.json`，宿主包
   `@deepseek-ai/*` 只留在 devDependencies，出现在 dependencies 即 fail-closed)
   into `~/.dsh/profiles/web/wfdev`。隔离产物验证用
   `node scripts/deploy-web.mjs --out <临时目录>`：只生成、不触碰 profile。
3. Ensure `"dsh-agent-team-workflow": "file:wfdev"` is in
   `~/.dsh/profiles/web/package.json` dependencies and the name is listed in
   `dsh.profile.bundles` (both set up once; `pnpm install` reconciles).
4. Restart DSH (`dsh web`).

Re-deploy after every `pnpm run build` (step 2). The profile's `pnpm install`
owns runtime deps (`yaml`, `zod`).

Workflow configs live in `%DSH_HOME%\workflows\*.yaml` (e.g. `milestone-delivery.yaml`, `smoke-test.yaml`). New workflows: copy [`docs/example/workflow-template.yaml`](docs/example/workflow-template.yaml) and adapt it (see [`docs/example/README.md`](docs/example/README.md) for the model-route and config-surface reference).

## Run trace logs

Trace 是便于人工排障的派生产物，关键业务历史以 SQLite `node_execution_events` 为准；不要用 trace 恢复或替代事务事实。

- **Location / naming**：`<catalogDir>/<workflowId>/yyyyMMdd-HHmmss-<runId前8位>.txt`，路径随 Run 持久化，重启后仍追加同一文件。
- **当前格式**：`fmt=3` 的单行 `key=value`；Runtime best-effort 记录 `START`、`CLAIM`、`JUDGE`、`ROUTE`、`BLOCK`、`MODEL`。free text 有界、JSON 转义并对 credential-like 文本做兜底脱敏。
- **不维护双路径**：Program/Child/resume/respawn/compact 的权威材料和顺序写入对应工作单事件；旧 `PROGRAM/PUSH/POP/RESUME/RESPAWN/COMPACT` 专属 trace 合同已删除，不再承诺。
- **一致性**：业务状态与事件同事务提交；trace 只在提交后追加，失败不阻断 Run，首次失败每 Run 最多告警一次。
- **限制**：trace 不保存 reasoning、完整工具 transcript 或 Program 参数，也不是 secret scanner。长期细粒度可观测性取舍见 `docs/pending-discussions/runtime-refact-long-tail.md`。

The controlled smokes (`pnpm run test:smoke` = `t3-smoke.mjs` && `e2e-smoke.mjs`) drive the full
v2 loop on production code paths. `e2e-smoke.mjs`（`pnpm run test:e2e`）覆盖缺省 `reuse: node`：
wrong work → claim → async REJECT → correction re-dispatch → corrected
work → re-claim → ACCEPT → next node — for BOTH a Manager node and a Role node，
外加 failed onFail 自环、离开节点 drain + 新 visit 新会话、迟到旧 Judge 失权与 `fmt=3` trace；
`t3-smoke.mjs`（`pnpm run test:t3`）覆盖 `reuse: continuable` 的另一半：Role 跨节点复用 +
节点边界 compact + END + SQLite 关库重开。两者都用 embedded v2 catalog 与隔离临时 DSH home，
真实 `~/.dsh` 绝不被触碰，且都不冒充真实宿主 E2E。
