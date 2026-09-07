# dsh-workflow-plugin

DSH Agent-Team Workflow plugin — configurable serial Agent/Subagent team
workflows (`agent-workflow/v2`).

**当前 `refact` 是集成中间态，不能部署，也不能宣称全量验收通过。**
T1/T2 已完成；T3 引入真实 SQLite 的 Actor → Judge ACCEPT → 后继/END 三表闭环。
构建、本票 69 项相关测试和 `scripts/t3-smoke.mjs` 通过，但全量仍有 107 项
旧接口/后续行为测试失败，原 `pnpm run test:e2e` 尚未迁移。证据与未接通范围见
[`T3 报告`](docs/test-reports/issue-10-work-order-loop.md)；最终全量验收由 T9 收口。

当前 claim 合同为 `node_claim({outcome, handoff})`：handoff 必填、trim 后
1..8000 字符，completed/failed 对称，END 也交付；明确拒绝旧 summary/handoffContext。
claim 不携带 nodeToken，运行时核对真实派发身份。Judge、Manager、后继与最终结果
共用原文，无独立摘要或 fallback。Catalog v2 保持，v1 Catalog 被拒绝。

State format 为 `agent-workflow-state/v3`：`runs`、`node_executions`、
`node_execution_events` 保存位置、当前工作与关键快照。最终交付从终局工作单读取，
不再保留 Run pending 材料镜像或 T2 的临时 finalHandoff 字段。

当前只接通 Actor Task 的上述闭环和必要安全门控。REJECT/NEED_CONTEXT、公开历史、
完整恢复/replacement、Program/Child、授权 Reset/旧格式退出按 T4–T8 接通；
未支持入口明确拒绝，不退回旧引擎。旧格式有数据时保留并拒绝启动新存储，
不自动迁移或清库。真实宿主组合验收留 T9，受控派发 smoke 不代表真实外部模型执行。

## Current documentation

- [`CONTEXT.md`](CONTEXT.md) — 当前领域术语与 T3 实现边界。
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
  tools/              7 workflow tools + 2 inspection wrappers
  commands/           /dsh-flow list|start|status|reset
  programs/           git/gh runner + 2 builtin programs
  plugin/host.ts      adapters wiring real DSH services into the engine
cordis.patch.yml      profile-bundle patch (inserts the plugin row)
```

## Development

- Build: `pnpm run build` (tsc → `lib/`). The profile bundle loads `lib/index.js`; Node refuses to strip `.ts` inside node_modules, so the compiled output is the runtime artifact.
- Test: `pnpm test` (node:test, runs the `.ts` sources directly — no build step needed).
- Runtime deps: `yaml`, `zod`. Host API packages (`@deepseek-ai/dsh-*`) are dev-dependencies only — at runtime they resolve from the DSH installation via the profile-module fallback (`~/.dsh/profiles/node_modules`), exactly like the shipped bundles.

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

以下完整字段清单是原 trace 约定。T3 已保留基本 START/CLAIM/JUDGE/ROUTE/BLOCK
与脱敏/转义能力，后票专属日志及旧细字段/时序仍待 T9 同步；关键业务历史以三表为准，
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
  - `[ts] CORRECT workflow=<id> node=<node> token=<8 new> role=<role> judge=<8 old> detail=<json>` — the REJECT re-dispatch boundary (same node, rotated token, retired judge).
  - `[ts] BLOCK workflow=<id> node=<node> token=<8> source=<actor|judge|program|dispatch|compact|restart|manager> reason=<json>` — every BLOCK entrance.
  - `[ts] RESUME workflow=<id> node=<node> oldToken=<8> newToken=<8> target=<judge|actor> context=<json>` / `RESPAWN` / `RESOLVE` / `MODEL` — recovery actions (node_resume, judge_respawn, node_resolve_program, workflow_set_role_model).
  - `[ts] PROGRAM workflow=<id> node=<node> token=<8> program=<id> result=<PASS|FAIL|ERROR> reason=<json|null>` — builtin-program outcomes (parameters are never logged).
  - `[ts] PUSH parent=<wf>/<node> token=<8> child=<childWf>` / `[ts] POP child=<childWf> result=PASS parent=<wf>/<node> token=<8>` — explicit child-workflow entry/return pairing (PUSH/POP share the parent node's token).
  - `[ts] COMPACT workflow=<id> node=<node> token=<8> role=<role> ok=<bool> detail=<json|null>` — node-boundary compaction results.
- **Durable path**: the log file path is persisted on the run's state row
  (`traceLogPath`), so events after a DSH host restart (restart-reconcile
  BLOCK, post-restart resume) still append to the SAME file. The log itself
  remains a derived artifact outside SQLite.
- **Privacy**: only Engine-accepted protocol payloads are logged (handoff /
  judge reason / block reason / resolution context, bounded). No
  reasoning, no tool transcripts, no program parameters. Credential text is
  doubly guarded: auth/credential errors keep the Host's sanitized wording
  (primary), and the trace boundary redacts credential-shaped patterns
  (Bearer/Basic, `sk-…`/`ghp_…`/`github_pat_…`, `api_key=…`-style
  assignments) in all free-text fields plus the untrusted MODEL
  provider/model identifier fields (backstop, best-effort heuristic — not a
  secret scanner). Catalog-validated structural ids (workflow/node/role/
  target) are deliberately NOT redacted so the trace stays correlatable.
- **Consistency**: events are written validate → trace → persist, so the log
  is **at-least-once** — a crash at the seam may leave an orphan line.
  Node-scoped events carry a nodeToken prefix for dedup (looping back to the
  same node AND correction re-dispatches both mint fresh tokens, so legit
  repeats differ from crash dupes); State/Git/GitHub stay authoritative.
- **Best-effort**: log directory/file creation or appends never fail the run.
  The FIRST failure per run surfaces once as a Host logger warning; further
  failures stay silent. State/Git/GitHub remain authoritative when they
  disagree with a trace.

The e2e smoke (`pnpm run test:e2e`) drives the full v2 loop on production code
paths — wrong work → claim → async REJECT → correction re-dispatch → corrected
work → re-claim → ACCEPT → next node — for BOTH a Manager node and a Role node
(embedded v2 catalog, isolated temporary DSH home; the real `~/.dsh` is never
touched).
