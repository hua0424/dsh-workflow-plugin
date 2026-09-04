# dsh-workflow-plugin

DSH Agent-Team Workflow plugin — configurable serial Agent/Subagent team
workflows (`agent-workflow/v1`). Implementation complete; offline-verifiable
acceptance items all pass (103 unit tests + isolated smoke e2e). The one
remaining item is the live-model Web GUI e2e after a DSH restart.

## Current documentation

- [`CONTEXT.md`](CONTEXT.md) — canonical domain glossary.
- [`docs/design/configurable-agent-workflow-graph.md`](docs/design/configurable-agent-workflow-graph.md) — confirmed v1 requirements and design (authoritative).
- [`docs/testing/acceptance-test-plan.md`](docs/testing/acceptance-test-plan.md) — acceptance criteria, test matrix, e2e scenarios (frozen before implementation).
- [`docs/testing/acceptance-report.md`](docs/testing/acceptance-report.md) — current acceptance status and the remaining live-GUI checklist.

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
  judge/              transcript projection + goal-satisfied prompt/output protocol
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

Workflow configs live in `%DSH_HOME%\workflows\*.yaml` (e.g. `milestone-delivery.yaml`, `smoke-test.yaml`).

## Run trace logs

Every workflow run writes a human-readable trace log beside its catalog
config file (`src/engine/tracelog.ts`):

- **Location**: `<catalogDir>/<workflowId>/` — the config path with the
  `.yaml` suffix stripped (e.g. `~/.dsh/workflows/smoke-test.yaml` →
  `~/.dsh/workflows/smoke-test/`).
- **Naming**: `yyyyMMdd-HHmmss-<runId前8位>.txt` (local time; the run-id
  prefix avoids same-second collisions), appended in UTF-8.
- **Format** (`fmt=2`, announced on the START line): one line per event,
  prefixed with `[YYYY-MM-DD HH:mm:ss]` (local time), made of
  space-separated `key=value` tokens. Identifier values are raw; free-text
  values are JSON-string escaped (newlines never break the one-line rule)
  and bounded at their protocol max (over-bound text gets `…[truncated]`):
  - `[ts] START workflow=<id> run=<runId> fmt=2`
  - `[ts] CLAIM workflow=<id> node=<node> token=<8> role=<role> outcome=<completed|failed> summary=<json> handoff=<json|null>` — every accepted Actor claim (after admission, before Judge spawn).
  - `[ts] JUDGE workflow=<id> node=<node> token=<8> result=<PASS|FAIL|NEED_CONTEXT> reason=<json> judge=<8>` — every accepted Judge verdict.
  - `[ts] ROUTE workflow=<id> node=<node> token=<8> result=<PASS|FAIL> target=<node|END|BLOCK>` — the finally-adopted Graph edge direction.
  - `[ts] BLOCK workflow=<id> node=<node> token=<8> source=<actor|judge|program|dispatch|compact|restart|manager> reason=<json>` — every BLOCK entrance.
  - `[ts] RESUME workflow=<id> node=<node> oldToken=<8> newToken=<8> target=<judge|actor> context=<json>` / `RESPAWN` / `RESOLVE` / `MODEL` — recovery actions (node_resume, judge_respawn, node_resolve_program, workflow_set_role_model).
  - `[ts] PROGRAM workflow=<id> node=<node> token=<8> program=<id> result=<PASS|FAIL|ERROR> reason=<json|null>` — builtin-program outcomes (parameters are never logged).
  - `[ts] PUSH parent=<wf>/<node> token=<8> child=<childWf>` / `[ts] POP child=<childWf> result=PASS parent=<wf>/<node> token=<8>` — explicit child-workflow entry/return pairing (PUSH/POP share the parent node's token).
  - `[ts] COMPACT workflow=<id> node=<node> token=<8> role=<role> ok=<bool> detail=<json|null>` — node-boundary compaction results.
- **Durable path**: the log file path is persisted on the run's state row
  (`traceLogPath`), so events after a DSH host restart (restart-reconcile
  BLOCK, post-restart resume) still append to the SAME file. The log itself
  remains a derived artifact outside SQLite.
- **Privacy**: only Engine-accepted protocol payloads are logged (summary /
  handoff / judge reason / block reason / resolution context, bounded). No
  reasoning, no tool transcripts, no program parameters. Credential text is
  doubly guarded: auth/credential errors keep the Host's sanitized wording
  (primary), and the trace boundary redacts credential-shaped patterns
  (Bearer/Basic, `sk-…`/`ghp_…`/`github_pat_…`, `api_key=…`-style
  assignments) in BOTH free-text and identifier fields (backstop,
  best-effort heuristic — not a secret scanner).
- **Consistency**: events are written validate → trace → persist, so the log
  is **at-least-once** — a crash at the seam may leave an orphan line.
  Node-scoped events carry a nodeToken prefix for dedup (looping back to the
  same node mints a fresh token, so legit repeats differ from crash dupes);
  State/Git/GitHub stay authoritative.
- **Best-effort**: log directory/file creation or appends never fail the run.
  The FIRST failure per run surfaces once as a Host logger warning; further
  failures stay silent. State/Git/GitHub remain authoritative when they
  disagree with a trace.

The e2e smoke (`pnpm run test:e2e`) asserts the START line and both PASS
routing lines of the smoke-test workflow in an isolated temporary DSH home
(the real `~/.dsh` is never touched).
