# PRD: Workflow 运行日志跟踪（Run Trace Log）

- 日期：2026-01-03
- 来源需求（用户原话）：为了跟踪进度，workflow 启动时在该 workflow 配置文件同级目录的同名目录下创建一个以时间戳命名的 txt 日志文档；启动时写一条启动日志；每个 node 结束（PASS/FAIL）路由到下一节点时写一条日志跟踪执行过程。

## 1. 背景与目标（User Goal）

当前 workflow 在 GUI 中执行时，用户无法直观跟踪执行进度（哪个节点、判定结果、路由去向），只能在结束后看结果。目标：**每个 workflow run 在文件系统留下一份人可读的、按时间顺序的执行轨迹日志**，无需打开数据库或翻会话记录即可了解 run 的执行过程。

## 2. 功能需求

- **R1 日志文件创建**：workflow run 启动（创建 run）时，在该 workflow 配置文件的同级目录下，创建与该 workflow 同名的目录（如 `~/.dsh/workflows/smoke-test.yaml` → `~/.dsh/workflows/smoke-test/`），并在其中创建一个以时间戳命名的 `.txt` 日志文件。为避免同一秒多次启动冲突，文件名建议携带 runId 短码，例如 `20260103-141522-9e473ab5.txt`。
- **R2 启动日志**：run 启动时写入第一条日志，包含时间戳、workflow id、run id。
- **R3 节点路由日志**：每个 node 的 checker 判定（PASS/FAIL）完成并路由到下一节点时，追加一条日志，包含时间戳、所在 workflow id、node id、判定结果（PASS/FAIL）、路由目标节点（或 END）。
- **R4 失败容忍**：日志写入失败（目录不可写、磁盘错误等）不得中断 workflow 执行——best-effort，仅记录 warning。

## 3. 范围（Scope）

- engine 层增加日志 hook：run 创建处 + PASS/FAIL 路由（advance）处。
- 目录/文件命名规则与单行文本日志格式的实现。
- 单元测试与 e2e 冒烟验证。
- 部署脚本与文档（README / 设计文档）同步更新。

## 4. 非目标（Non-Goals）

- 不做 Web UI 日志展示。
- 不做日志轮转、清理、归档。
- 不记录每 turn 的对话内容或 token 级细节，只记录节点级路由事件。
- 不改变 SQLite 状态模型（日志是派生产物，不进状态库，保持"最小状态"原则）。
- 不支持用户自定义日志格式/路径的配置项（本期格式固定）。

## 5. 验收标准（Acceptance Criteria）

- **AC1**：`/dsh-flow start <workflow>` 启动任意 workflow 后，`<catalogDir>/<workflowId>/` 目录下出现一个新的时间戳命名 `.txt` 文件，首条日志为启动记录，含 workflow id 与 run id。
- **AC2**：每个节点判定路由后追加一行，含 node id、verdict（PASS/FAIL）、目标节点。smoke-test 全流程跑完后，日志至少包含：启动行、`hello` PASS→`worker-echo`、`worker-echo` PASS→`END` 三条。
- **AC3**：FAIL 路由（onFail 回退重试）同样产生日志行，verdict 为 FAIL。
- **AC4**：日志目录不可写时 workflow 照常推进，不因日志失败而中断或报错给用户。
- **AC5**：新增单元测试覆盖文件命名、日志内容、写入失败容忍；`pnpm test`、`pnpm run test:e2e` 全部通过。

## 6. 技术约束

- 日志为追加写入、UTF-8 纯文本。
- 时间戳使用本地时间，ISO 或 `YYYY-MM-DD HH:mm:ss` 可读格式。
- 实现位于插件 engine 层，不侵入 DSH 宿主。
