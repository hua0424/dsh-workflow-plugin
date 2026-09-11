# Agent Guide

<!-- codebase-memory-mcp:start -->
# Codebase Knowledge Graph (codebase-memory-mcp)

This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.
ALWAYS prefer MCP graph tools over grep/glob/file-search for code discovery.

- Project name (pass as `project` in every call): `D-project-my-dsh-workflow-plugins`
- Index mode: `moderate`（522 nodes / 1612 edges，含 SEMANTICALLY_RELATED 语义边，支持 semantic_query；T9 审查修复后刷新）
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

DSH Agent-Team Workflow plugin (`dsh-agent-team-workflow`) — a Cordis plugin for DSH that runs configurable serial Manager / Role-Actor team workflows (`agent-workflow/v2`). TypeScript ESM (`module: nodenext`, strict), Node ≥ 22.19, pnpm, Windows dev environment.

Runtime deps are only `yaml` + `zod`. All `@deepseek-ai/dsh-*` host API packages are devDependencies — at runtime they resolve from the DSH installation via the profile fallback. Do not move them into `dependencies`.

## DSH 运行基线（用户确认）

- 当前运行版本：`0.1.5-rc.2`（2026-09-11 自 `0.1.2-rc.1` 升级，见 issue #37 / PR #38）；对应源码：`D:\project\github\deepseek-harness`（master 已含 tag `dsh-v0.1.5-rc.2`）。分析宿主兼容性、continuable Actor、compact 或 Session 行为时，查询此版本源码。
- 0.1.2-rc.1 的宿主缺陷「冷 resume 已完成 turn 的 continuable 子会话永不 settle」（原事故 run 20260911-105817 的 B-001~B-007：复用任一 Role Actor 会话即 60s 超时降级 BLOCK）已在 0.1.5-rc.2 上实测不再复现：4 轮 `cold-resume-test` 的冷复用全部正常 settle，会话内 `compaction/start → compaction/end` 实测 10–16s，零 `coldMaterialize` 超时 BLOCK（详见 issue #37）。
- 该仓库已用 codebase-memory 索引，project：`D-project-github-deepseek-harness`；优先图查询，引用前检查 coverage，必要时读取源文件核实。源码仓库与已安装运行产物是不同路径。
- 本仓库的默认远端是github，相关操作可使用gh命令行工具。

## Commands

- Build / typecheck: `pnpm run build` (tsc → `lib/`；无独立 lint script，tsc 即类型检查).
- Unit tests: `pnpm test` — node:test over `test/*.test.ts`，直接跑 `.ts` 源码，无需先 build.
- E2e smoke: `pnpm run test:e2e` — 真实 engine + SQLite + catalog loader，仅 stub 模型派发；使用隔离的临时 DSH home，绝不触碰真实 `~/.dsh`.
- Dev deploy: `pnpm run build && node scripts/deploy-web.mjs` → 部署到 `~/.dsh/profiles/web/wfdev`；bundle 成员变更后需重启 DSH（`dsh web`）.

## Architecture boundaries

- `src/index.ts` — Cordis `apply()` 入口：注册 /dsh-flow 命令、workflow tools、inspection wrappers，订阅 `session/event` 做 turn 结算.
- `src/types.ts` — 领域类型、limits、错误类.
- `src/catalog/` — 受限 YAML 1.2 解析 + 严格 schema + 静态校验 + 目录扫描.
- `src/state/` — SQLite 三表状态存储（Run / Node Execution / 关键 Events，`node:sqlite` DatabaseSync、WAL）+ invariants + nodeToken。
- `src/engine/` — 工作单驱动的串行 Node 推进、真实派发/Turn 绑定、事务交接与 best-effort trace log（`tracelog.ts`）。
- `src/roles/` — role/judge spawn plans、model routes、deny/allow lists.
- `src/judge/` — Node-local transcript projection + `judge.claim-correct` Judgment Packet 与 `judge_claim` 协议.
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

- 工单实施/审查先读 `docs/agents/issue-tracker.md` 和 `docs/work-plans/runtime-refact.md`，获取实际工单依赖、完成状态与用户改动保护范围。
- `refact` 分支的重构开发/评审先读 `docs/design/node-execution-runtime.md` 与 `docs/specs/node-execution-runtime.md`：三表工作单、outcome+handoff 单文本、Role 复用/compact、BLOCK 争议处理的目标基线；旧 PRD/Issue #6 已被替代。未实现前，以下领域文档仍用于理解当前代码。
- `CONTEXT.md` — 领域术语表（Manager、Role Actor、Judge、Run Frame、nodeToken、BLOCK、pendingClaim、Handoff Context 等含义精确，代码/文档中使用原词）.
- `docs/user-guide.md` — 面向使用者/运维者的操作手册（命令、工具、部署、故障排查）.
- `docs/design/configurable-agent-workflow-graph.md` — v1 权威设计.
- `docs/testing/acceptance-test-plan.md` / `acceptance-report.md` — 冻结的验收标准与现状.
- `docs/prd/<YYYYMMDD-topic>/` — 每轮修复/加固的 PRD；`docs/test-reports/` — 每个_issue 的测试报告；`docs/pending-discussions/` — 已记录的前提结论.

## Conventions

- 注释、文档、commit message 以中文为主；commit 用 conventional 前缀（`feat:` / `fix:` / `docs:` / `test:`）+ 中文摘要.
- 测试放在 `test/<area>.test.ts`，与 src 分区对应，用 node:test.
- src 内 import 带 `.ts` 扩展名（tsconfig 开启 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`）.

## Gotchas

- **`compaction` 不可 inject**（0.1.1-rc.7+ agent presets 起挂在每个会话 preset 的 isolate 域，web-app bundle 禁用了宿主平面副本；宿主行 inject 会永久 pending 卡死 boot）。运行期按 agent 解析：`host.ts` 的 `compactionFor`（`agentPresets.serviceFor` 优先 → 宿主平面回退 → 跳过+告警）；冷物化必须带 preset-join `setup`。详见 `docs/pending-discussions/compaction-service-plane-after-presets.md`。
- Node 不在 node_modules 内剥 `.ts`，编译产物 `lib/` 才是运行时工件：deploy 前必须 `pnpm run build`，且每次 build 后重跑 `scripts/deploy-web.mjs`.
- Catalog YAML 是受限单文档 YAML 1.2：禁止 duplicate key、anchor/alias/merge、custom tag、模板插值；文件名必须是小写 `[a-z][a-z0-9-]*.yaml`（拒绝 `.yml`）；invalid 文件只阻塞自身.
- Trace log 是 best-effort 派生产物，写在 catalog 配置旁 `<catalogDir>/<workflowId>/`，失败静默、绝不阻断 Run；日志**内容**不进 SQLite，仅文件路径以可选 `traceLogPath` 元数据随行持久化（host 重启后事件仍写同一文件）.
- 新增 Checker id 或 builtin program = 修改插件源码 + 测试 + 版本说明；配置不能注册任意程序/脚本/Checker 类型.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `hua0424/dsh-workflow-plugin`; managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, label strings equal to role names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
