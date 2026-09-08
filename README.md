# dsh-workflow-plugin

DSH Agent-Team Workflow plugin — configurable serial Agent/Subagent team
workflows (`agent-workflow/v2`).

**当前 `refact` 是集成中间态，不能部署，也不能宣称全量验收通过。**
T1–T5 已完成；三表闭环已接通同 execution 的 REJECT/NEED_CONTEXT、
Manager 定向 resume/Judge respawn、争议协议和 Manager-only 有界历史。Role Actor 在新 visit
（含自环）前安全收口并 compact 后续接同一 continuable Session；同 execution 返工/resume
不做 Node 边界 compact。`scripts/e2e-smoke.mjs` 已迁移到真实 Runtime/SQLite 的受控闭环；
这仍不是目标宿主真实 Run。T3 基线见 [`T3 报告`](docs/test-reports/issue-10-work-order-loop.md)，
最终全量验收仍由后续票/T9 收口。T5 本地验证已通过 frozen install、build、145 项相关测试、
T3 smoke 与受控 e2e；全量 286 项为 183 PASS / 103 个已知后票 FAIL / 0 skip/cancelled
（旧 `engine` 91、旧 `state` 11、T7 Program 1）。

当前 claim 合同为 `node_claim({outcome, handoff})`：handoff 必填、trim 后
1..8000 字符，completed/failed 对称，END 也交付；明确拒绝旧 summary/handoffContext。
claim 不携带 nodeToken，运行时核对真实派发身份。Judge、Manager、后继与最终结果
共用原文，无独立摘要或 fallback。Catalog v2 保持，v1 Catalog 被拒绝。

State format 为 `agent-workflow-state/v6`：`runs`、`node_executions`、
`node_execution_events` 保存位置、当前工作与关键快照；旧 v3/v4/v5/legacy 有数据时保留并
fail-closed，不静默迁移。REJECT 后当前单保留一代完整 previous claim/Judge 与统一 judgment 关联，
补充/恢复材料只保留当前完整版本，旧值由 events 解释；正常恢复不回放 events。

当前接通 Actor Task 的 ACCEPT/REJECT/NEED_CONTEXT、正常 BLOCK 的 auto/actor/judge
resume、有效 claim 下 Judge respawn，以及 `workflow_status` 的 Manager-only 当前 Run
execution 历史分页（stable after、limit ≤ 50）。标准 Web profile 必须提供正式 `jobs` 与
`compaction` service；缺服务时插件不激活，不维护 optional fallback。完整冷重启/replacement、
Program/Child、授权 Reset/旧格式退出仍按 T6–T8 接通；未支持入口明确拒绝，不退回旧引擎。
真实宿主组合验收留 T9，受控派发 smoke 不代表真实外部模型执行。

## Current documentation

- [`CONTEXT.md`](CONTEXT.md) — 当前领域术语与 T5 实现边界。
- [`docs/design/node-execution-runtime.md`](docs/design/node-execution-runtime.md) / [`spec`](docs/specs/node-execution-runtime.md) — refact 目标设计与验收基线。
- [`docs/work-plans/runtime-refact.md`](docs/work-plans/runtime-refact.md) — 工单依赖、当前进度与分票证据。
- [`docs/design/configurable-agent-workflow-graph.md`](docs/design/configurable-agent-workflow-graph.md) — 旧版设计参考，不覆盖 refact 新规格。
- [`docs/testing/acceptance-test-plan.md`](docs/testing/acceptance-test-plan.md) / [`report`](docs/testing/acceptance-report.md) — 原实现验收资料，不表示当前重构已通过。
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

- Build: `pnpm run build` (tsc → `lib/`). The profile bundle loads `lib/index.js`; Node refuses to strip `.ts` inside node_modules, so the compiled output is the runtime artifact.
- Test: `pnpm test` (node:test, runs the `.ts` sources directly — no build step needed).
- Runtime deps: `yaml`, `zod`. Host API packages (`@deepseek-ai/dsh-*`) are dev-dependencies only — at runtime they resolve from the DSH installation via the profile-module fallback (`~/.dsh/profiles/node_modules`), exactly like the shipped bundles. `jobs`/`compaction` use exact `0.1.2-rc.1` types and are required Host services, not plugin runtime dependencies.

## Installation (development)

下列是完成集成验收后的部署流程；当前 refact 中间态不要执行，本轮没有部署。

The plugin is a DSH Profile Bundle, deployed wfgate-style into a local bundle
directory under the web profile (the same layout the shipped bundles use, so
`@deepseek-ai/*` resolves to the HOST's instances via the profiles fallback).

1. `pnpm run build` — compile `lib/`.
2. `node scripts/deploy-web.mjs` — copies `lib/`, `cordis.patch.yml`, and a
   bundle `package.json` into `~/.dsh/profiles/web/wfdev`.
3. Ensure `"dsh-agent-team-workflow": "file:wfdev"` is in
   `~/.dsh/profiles/web/package.json` dependencies and the name is listed in
   `dsh.profile.bundles` (both set up once; `pnpm install` reconciles).
4. Restart DSH (`dsh web`).

Re-deploy after every `pnpm run build` (step 2). The profile's `pnpm install`
owns runtime deps (`yaml`, `zod`).

Workflow configs live in `%DSH_HOME%\workflows\*.yaml` (e.g. `milestone-delivery.yaml`, `smoke-test.yaml`). New workflows: copy [`docs/example/workflow-template.yaml`](docs/example/workflow-template.yaml) and adapt it (see [`docs/example/README.md`](docs/example/README.md) for the model-route and config-surface reference).

## Run trace logs

以下完整字段清单是原 trace 约定。T4 保留基本 START/CLAIM/JUDGE/ROUTE/BLOCK
与脱敏/转义能力，返工/补充/respawn 的专属细日志仍待 T9 同步；关键业务历史以三表为准，
不要用旧 trace 格式或先写日志的时序替代当前事务事实。

Every workflow run writes a human-readable trace log beside its catalog
config file (`src/engine/tracelog.ts`):

- **Location**: `<catalogDir>/<workflowId>/` — the config path with the
  `.yaml` suffix stripped (e.g. `~/.dsh/workflows/smoke-test.yaml` →
  `~/.dsh/workflows/smoke-test/`).
- **Naming**: `yyyyMMdd-HHmmss-<runId前8位>.txt` (local time; the run-id
  prefix avoids same-second collisions), appended in UTF-8.
- **Format** (`fmt=3`, announced on the START line): one line per event,
  prefixed with `[YYYY-MM-DD HH:mm:ss]` (local time), made of
  space-separated `key=value` tokens. Identifier values are raw; free-text
  values are JSON-string escaped (newlines never break the one-line rule)
  and bounded at their protocol max (over-bound text gets `…[truncated]`):
  - `[ts] START workflow=<id> run=<runId> fmt=3`
  - `[ts] CLAIM workflow=<id> node=<node> token=<8> role=<role> outcome=<completed|failed> handoff=<json>` — every accepted Actor claim (after lease admission, before Judge spawn).
  - `[ts] JUDGE workflow=<id> node=<node> token=<8> result=<ACCEPT|REJECT|NEED_CONTEXT> reason=<json> judge=<8>` — every accepted Judge confirmation (v2).
  - `[ts] ROUTE workflow=<id> node=<node> token=<8> result=<PASS|FAIL> target=<node|END|BLOCK>` — the finally-adopted Graph edge direction (ACCEPT maps the claimed outcome; REJECT routes nothing).
  - `CORRECT` 专属细行当前未恢复；REJECT 的同 execution 关联与顺序以 `node_execution_events` 为准，nodeToken 不因普通返工轮换。
  - `[ts] BLOCK workflow=<id> node=<node> token=<8> source=<actor|judge|program|dispatch|compact|restart|manager> reason=<json>` — every BLOCK entrance.
  - `RESUME` / `RESPAWN` 专属细行当前未恢复；Manager context/resume/respawn decision 已与当前状态同事务写入关键 events。
  - `[ts] PROGRAM workflow=<id> node=<node> token=<8> program=<id> result=<PASS|FAIL|ERROR> reason=<json|null>` — builtin-program outcomes (parameters are never logged).
  - `[ts] PUSH parent=<wf>/<node> token=<8> child=<childWf>` / `[ts] POP child=<childWf> result=PASS parent=<wf>/<node> token=<8>` — explicit child-workflow entry/return pairing (PUSH/POP share the parent node's token).
  - `[ts] COMPACT workflow=<id> node=<node> token=<8> role=<role> ok=<bool> detail=<json|null>` — node-boundary compaction results.
- **Durable path**: the log file path is persisted on the run's state row
  (`traceLogPath`), so events after a DSH host restart (restart-reconcile
  BLOCK, post-restart resume) still append to the SAME file. The log itself
  remains a derived artifact outside SQLite.
- **Privacy**: current trace logs only Engine-accepted handoff / Judge reason /
  block reason (bounded). Manager resolution context/respawn decisions are currently
  persisted in SQLite events, not trace; their dedicated trace lines remain T9 work. No
  reasoning, no tool transcripts, no program parameters. Credential text is
  doubly guarded: auth/credential errors keep the Host's sanitized wording
  (primary), and the trace boundary redacts credential-shaped patterns
  (Bearer/Basic, `sk-…`/`ghp_…`/`github_pat_…`, `api_key=…`-style
  assignments) in all free-text fields plus the untrusted MODEL
  provider/model identifier fields (backstop, best-effort heuristic — not a
  secret scanner). Catalog-validated structural ids (workflow/node/role/
  target) are deliberately NOT redacted so the trace stays correlatable.
- **Consistency**: SQLite current state + `node_execution_events` are authoritative
  and commit together; trace is post-commit best-effort and is never replayed for recovery.
  New Graph visits mint new nodeToken/execution IDs; ordinary same-execution correction
  keeps the visit/token and uses dispatch/claim/Judge/input identities to reject stale work.
- **Best-effort**: log directory/file creation or appends never fail the run.
  The FIRST failure per run surfaces once as a Host logger warning; further
  failures stay silent. State/Git/GitHub remain authoritative when they
  disagree with a trace.

The e2e smoke (`pnpm run test:e2e`) drives the full v2 loop on production code
paths — wrong work → claim → async REJECT → correction re-dispatch → corrected
work → re-claim → ACCEPT → next node — for BOTH a Manager node and a Role node
(embedded v2 catalog, isolated temporary DSH home; the real `~/.dsh` is never
touched).
