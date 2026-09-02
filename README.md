# dsh-workflow-plugin

DSH Agent-Team Workflow plugin — configurable serial Agent/Subagent team
workflows (`agent-workflow/v1`). Implementation complete; offline-verifiable
acceptance items all pass (84 unit tests + real-host smoke e2e). The one
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
- **Format**: one line per event, each prefixed with
  `[YYYY-MM-DD HH:mm:ss]` (local time):
  - `[ts] START workflow=<workflowId> run=<runId>` — written at run start.
  - `[ts] NODE <workflowId>/<nodeId> PASS -> <nextNodeId|END>` / `FAIL ->
    <onFailNodeId|BLOCK>` — written when a checker/program verdict routes to
    the next node. Child-workflow push/pop routing is logged too
    (`PUSH -> <childWorkflowId>` on entry; the child's END line plus the
    parent node's PASS line on return).
- **Best-effort**: log directory/file creation or appends never fail the run
  — failures are silently ignored and the workflow keeps advancing. Logs are
  derived artifacts; they are not part of the SQLite state.

The e2e smoke (`pnpm run test:e2e`) asserts the START line and both PASS
routing lines of the smoke-test workflow in an isolated temporary DSH home
(the real `~/.dsh` is never touched).
