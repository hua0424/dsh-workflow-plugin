# Agent Guide

<!-- codebase-memory-mcp:start -->
# Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

- Project name (pass as `project` in every call): `D-project-my-dsh-workflow-plugins`
- Index mode: `moderate`（345 nodes / 1003 edges，含 SEMANTICALLY_RELATED 语义边，支持 semantic_query）
- In DSH all tools carry the `mcp__codebase-memory__` prefix.

## Priority Order
1. `mcp__codebase-memory__search_graph` — find functions, classes, routes, variables by pattern / BM25 / semantic query
2. `mcp__codebase-memory__trace_path` — trace who calls a function or what it calls (calls / data_flow / cross_service)
3. `mcp__codebase-memory__get_code_snippet` — read specific function/class source code
4. `mcp__codebase-memory__query_graph` — run Cypher queries for complex patterns
5. `mcp__codebase-memory__get_architecture` — high-level project summary

## When to fall back to grep/glob
- Searching for string literals, error messages, config values
- Searching non-code files (Dockerfiles, shell scripts, configs)
- When MCP tools return insufficient results
- Files reported by `index_status` as `parse_partial`/`skipped`（本项目 test/ 目录未被 moderate 索引）

## Examples
- Find a handler: `search_graph(name_pattern=".*Handler.*")`
- Who calls it: `trace_path(function_name="handleClaim", direction="inbound")`
- Read source: `get_code_snippet(qualified_name="D-project-my-dsh-workflow-plugins.src.engine.engine.WorkflowEngine.handleClaim")`
- Cross-vocabulary: `search_graph(semantic_query=["judge","verdict"])`

## 检索语言注意
- `search_graph` 的 BM25 对中文短词分词差：查代码用英文关键词 / 标识符（如 `judge claim engine`、`validateAndNormalize`），中文只适合语义查询 `semantic_query`。
- 代码改动后如需刷新影响面，先重跑 `mcp__codebase-memory__index_repository`（moderate）再 `detect_changes`。
<!-- codebase-memory-mcp:end -->

## Project

DSH Agent-Team Workflow plugin (`dsh-agent-team-workflow`) — a Cordis plugin for DSH that runs configurable serial Manager / Role-Actor team workflows (`agent-workflow/v1`). TypeScript ESM (`module: nodenext`, strict), Node ≥ 22.19, pnpm, Windows dev environment.

Runtime deps are only `yaml` + `zod`. All `@deepseek-ai/dsh-*` host API packages are devDependencies — at runtime they resolve from the DSH installation via the profile fallback. Do not move them into `dependencies`.

## Commands

- Build / typecheck: `pnpm run build` (tsc → `lib/`；无独立 lint script，tsc 即类型检查).
- Unit tests: `pnpm test` — node:test over `test/*.test.ts`，直接跑 `.ts` 源码，无需先 build.
- E2e smoke: `pnpm run test:e2e` — 真实 engine + SQLite + catalog loader，仅 stub 模型派发；使用隔离的临时 DSH home，绝不触碰真实 `~/.dsh`.
- Dev deploy: `pnpm run build && node scripts/deploy-web.mjs` → 部署到 `~/.dsh/profiles/web/wfdev`；bundle 成员变更后需重启 DSH（`dsh web`）.

## Architecture boundaries

- `src/index.ts` — Cordis `apply()` 入口：注册 /dsh-flow 命令、workflow tools、inspection wrappers，订阅 `session/event` 做 turn 结算.
- `src/types.ts` — 领域类型、limits、错误类.
- `src/catalog/` — 受限 YAML 1.2 解析 + 严格 schema + 静态校验 + 目录扫描.
- `src/state/` — SQLite 状态存储（`node:sqlite` DatabaseSync，WAL，owner-only）+ invariants + nodeToken.
- `src/engine/` — 串行 Node 推进、token 结算、deferred 派发、best-effort trace log（`tracelog.ts`）.
- `src/roles/` — role/judge spawn plans、model routes、deny/allow lists.
- `src/judge/` — Node-local transcript projection + goal-satisfied prompt 与 `judge_claim` 协议.
- `src/tools/` — workflow 控制工具 + inspection wrappers；所有调用经 `authz.ts` 校验调用者身份.
- `src/commands/` — `/dsh-flow list|start|status|reset`.
- `src/programs/` — git/gh runner + builtin programs.
- `src/plugin/host.ts` — 把真实 DSH 服务接入 engine 的适配层（测试 seam）.

Engine invariants（改动 engine/state 前必读，详见 CONTEXT.md）：

- 所有 Node mutation 必须携带 current `nodeToken`（每次 node 进入/resume/replacement 轮换的 UUID）；Actor 一律以 `workflow_status` 返回的最新 token 为准.
- Judge 是只读 + fail-closed：技术故障进入 BLOCK；禁止从 Judge 自己的 judge_claim turn 内 drain 自己.
- 自动 BLOCK 的状态写入必须 defer，不能在 `session/event` 回调内同步 append 同一 Session.
- 一个 workspace（canonical realpath）最多一个 Run；状态存于 `${DSH_HOME}/workflows/state.sqlite3`.

## Docs to read first

- `CONTEXT.md` — 领域术语表（Manager、Role Actor、Judge、Run Frame、nodeToken、BLOCK、pendingClaim、Handoff Context 等含义精确，代码/文档中使用原词）.
- `docs/design/configurable-agent-workflow-graph.md` — v1 权威设计.
- `docs/testing/acceptance-test-plan.md` / `acceptance-report.md` — 冻结的验收标准与现状.
- `docs/prd/<YYYYMMDD-topic>/` — 每轮修复/加固的 PRD；`docs/test-reports/` — 每个_issue 的测试报告；`docs/pending-discussions/` — 已记录的前提结论.

## Conventions

- 注释、文档、commit message 以中文为主；commit 用 conventional 前缀（`feat:` / `fix:` / `docs:` / `test:`）+ 中文摘要.
- 测试放在 `test/<area>.test.ts`，与 src 分区对应，用 node:test.
- src 内 import 带 `.ts` 扩展名（tsconfig 开启 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）.

## Gotchas

- Node 不在 node_modules 内剥 `.ts`，编译产物 `lib/` 才是运行时工件：deploy 前必须 `pnpm run build`，且每次 build 后重跑 `scripts/deploy-web.mjs`.
- Catalog YAML 是受限单文档 YAML 1.2：禁止 duplicate key、anchor/alias/merge、custom tag、模板插值；文件名必须是小写 `[a-z][a-z0-9-]*.yaml`（拒绝 `.yml`）；invalid 文件只阻塞自身.
- Trace log 是 best-effort 派生产物，写在 catalog 配置旁 `<catalogDir>/<workflowId>/`，失败静默、绝不阻断 Run，也不进 SQLite 状态.
- 新增 Checker id 或 builtin program = 修改插件源码 + 测试 + 版本说明；配置不能注册任意程序/脚本/Checker 类型.
