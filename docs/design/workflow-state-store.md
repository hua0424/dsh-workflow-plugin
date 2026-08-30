# Workflow State Store 与系统中断恢复

- 状态：已确认（个人、单会话、可重置 MVP 的存储与恢复边界）
- 关联设计：
  - `docs/design/parent-child-workflow-instances.md`
  - `docs/design/trusted-actor-role-binding.md`
  - `docs/design/workflow-policy-dsl-static-validation.md`

## 1. 定位

Workflow State Store 是固定 Workflow Definition 的本地当前状态存储。它只服务于一个人、一个 Manager 会话在一个本地 clone 中串行运行一个 Workflow。

它的目标是：

- 让 Agent 大概率按固定 Parent/Child、Gate 和失败回路推进；
- 在普通进程重启后知道当前步骤、当前 Gate 和可能中断的操作；
- 防止系统中断后盲目重复高风险 Git/GitHub effect；
- 为试运行阶段保留少量近期诊断信息；
- 无法可靠恢复时允许用户丢弃本地状态并从 Git 现场重新开始。

它不是团队级 durable ledger、安全边界、责任审计系统、事件源或高可用任务平台。

## 2. 已确认运行前提

1. 一个工作目录只由一个人、一个 Manager 会话串行使用。
2. 不支持多人、多会话、多 Host 或多进程同时操作同一工作目录。
3. 新 clone/新目录始终创建新的 Workflow 状态；不迁移进行中的 Workflow。
4. 用户遵守一次只运行一个 Workflow 的约定，不设计用户主动并行启动多个流程。
5. 不追求 100% 防绕过、100% crash consistency 或所有异常下无损恢复。
6. Git/GitHub 等外部事实仍是代码、branch、PR、review、check 和 merge 的权威来源。
7. 状态无法恢复时，用户可以显式 reset；需要时由用户自行整理或重置 Git 分支，Host 不自动执行破坏性 Git 操作。

## 3. 明确不做

首期不实现：

- 多用户、多会话或多进程协调；
- Parent revision CAS、`expectedRevision`；
- Command ID、Command Receipt、Command Attempt；
- append-only Workflow Event 或长期审计；
- Durable Lease、Fencing Token、Host Boot Epoch、PID 判活；
- Task/Effect owner takeover、heartbeat、TTL；
- 关系型领域表、EAV、通用 metadata/context/extensions；
- 通用 Outbox、Effect Attempt、自动 retry/backoff；
- immutable Evidence Observation 历史；
- Evidence Artifact Store、artifact backup 或 GC；
- latest/previous backup、Backup Barrier；
- Ledger Generation、Generation/Incident Archive、Restore Audit；
- schema migration、状态修复、Tombstone、定时 retention/purge；
- remote/offsite backup；
- SQLite worker thread、连接池、WAL/SHM 或复杂 PRAGMA 能力矩阵；
- Workflow 状态的 Markdown 镜像。

## 4. 固定存储位置

状态 DB 固定为：

```text
<umbrella-git-dir>/dsh-workflow/state.sqlite3
```

Host 必须通过 Git 解析伞仓真实 git-dir，不能接受 Policy、Agent、环境变量或 tool 参数提供任意 DB 路径。

该位置：

- 不进入 Git 工作树或版本控制；
- 不需要 `.gitignore`；
- 不受 branch 切换和普通 `git reset` 影响；
- 每个 clone 自然拥有独立状态；
- 只允许 Host 内部访问，Manager、Role Actor 和普通文件工具不得直接读写。

首期不考虑同一个 git-dir 被两个活进程同时打开。用户负责遵守单会话约定。

## 5. 极简 SQLite 结构

数据库只包含一个 singleton current-state row。概念结构：

```sql
CREATE TABLE workflow_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  format_version TEXT    NOT NULL,
  state_version  INTEGER NOT NULL,
  snapshot_json  TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;
```

约束：

- `format_version` 首期只接受精确 `workflow-state/v1`；
- `state_version` 从初始值开始，每次成功保存加一，只用于调试和顺序展示；
- `snapshot_json` 必须通过 Host 内置严格 schema；
- 未知字段、未知 enum、缺失关键字段或错误类型拒绝；
- 不做旧格式 migration；不兼容时由用户 reset 后重新开始；
- DB 无状态时可以没有 singleton row。

SQLite 仅提供单事务原子更新和基本文件持久化，不承担关系型领域查询或审计职责。

## 6. Snapshot 最小字段闭集

```text
workflow:
  parentId
  managerSessionId
  state
  milestone
  umbrella
  acceptedPolicy
  affectedRepositories[]
  children[]
  gates{}
  roleActors{}
  runningTask?
  pendingEffect?
  recovery?
recentEvents[0..100]
```

### 6.1 Parent、Manager、Milestone 与 `umbrella`

保存当前 Parent 的稳定 ID、创建它的 Manager session identity、固定 Workflow Definition state 和当前 Milestone reference。Host 重启后仍使用 `managerSessionId` 校验 Manager action；session 无法恢复时停止自动推进或由用户 reset。

`umbrella` 保存完成条件所需的当前伞仓事实：Resolved Repository Identity、Milestone branch/current SHA、最终 PR/Gitlink 状态和 umbrella delivery status。具体 Parent state enum 与 transition table 由 Workflow Definition 专项冻结，不由 Policy 或 snapshot 动态扩展。

### 6.2 `acceptedPolicy`

保存固定 Policy path、Policy schemaVersion、Workflow Definition version、resolved umbrella identity，以及当前 reload/continuity 判断所需的 source、continuity、manager ownership 和固定 role definition hashes。完整 Policy source 不复制到 State Store。

Policy reload、continuity change、abandoned，以及 reload/route 触发的 Role Actor replacement 遵循 `docs/design/workflow-policy-dsl-static-validation.md`；Actor/session 不可恢复时的 replacement 遵循 `docs/design/trusted-actor-role-binding.md`。本设计只简化它们的持久化形态。

### 6.3 `affectedRepositories[]`

每个受影响仓库只保存当前 Workflow 所需事实：

- repositoryKey/Resolved Repository Identity；
- 当前 Milestone/feature/remediation/delivery branch reference；
- 当前 milestone branch/head SHA 与 baseline branch/base SHA；每个受影响仓库都保留自己的 manifest entry，不能只保存一个 aggregate hash；
- 可选 release candidate manifest aggregate hash；
- 当前 delivery status；
- 必要 PR/remote reference。

外部操作前仍须重新读取 Git/GitHub 真实状态；snapshot 不是远端权威。

### 6.4 `children[]`

只保存当前 Parent 的 Child 顺序、固定 Child type、Issue/PR reference、受影响仓库和当前 state。`remediation|conflict-resolution` Child 还保存固定 `cause`；`cancelled` Child 必须保存 `cancellationReason`。运行中不删除仍参与当前 Workflow 的 Child；状态 reset 或新 Workflow 初始化时整体丢弃。

### 6.5 `gates{}`

每个固定 Gate 只保存：

- 当前 `status`；
- 当前 evidence 绑定的 PR head SHA、candidate manifest hash 或测试目标 hash；
- 可选 GitHub URL/remote ID；
- `verifiedAt`；
- 短 summary。

新验证直接覆盖旧 current evidence。candidate/validation target 改变时，相关 Gate 立即变为 unsatisfied 并清空旧 current evidence。

不保存长期 Evidence Observation 或 Artifact 历史。测试/CI 完整日志由对应 runner/CI 自己提供，需要时重新运行或查看原输出。

### 6.6 `roleActors{}`

`roleActors` 只允许四个固定 key；Role Actor 尚未按需创建时对应值可以缺失，创建后保存当前 mapping：

```text
prd-reviewer | developer | code-reviewer | tester
  -> {
       agentId,
       roleDefinitionHash,
       routeSource: inherited | explicit,
       resolvedRoute: { provider, model, maxTokens },
       status
     }
```

不保存旧 mapping、replacement history 或旧 session reference。replacement 成功后直接覆盖当前值；失败时当前 mapping 标为 stale，Workflow 进入简单 recovery。DSH 可独立保留旧 session，插件不追踪或清理。

当前 Gate evidence 不因 Actor replacement 自动失效，仍只按当前 candidate/manifest 判断。

### 6.7 `runningTask?`

同时最多一个：

```text
{
  id,
  type,
  roleOrExecutor,
  roleDefinitionHash?,
  childId?,
  gateKey?,
  repositories?: [{ repositoryKey, branch, sha }],
  candidateManifestHash?,
  status: running | interrupted,
  startedAt
}
```

Host 在任务结束、失败或进入 interrupted recovery 前不派发另一个权威 Task。临时只读辅助 subagent 不属于权威 Workflow Task，不写入 `runningTask`，也不能提交 Gate 或修改 Workflow 状态。

### 6.8 `pendingEffect?`

同时最多一个：

```text
{
  id,
  type,
  target,
  expectedFacts,
  status: prepared | started | unknown,
  lastError?
}
```

它只处理外部 effect 的系统中断风险，见第 9 节。

### 6.9 `recovery?`

只保存当前稳定 error/recovery code 和短提示。不保存通用 cause graph、attempt history 或 stack trace。

### 6.10 `recentEvents[]`

最多 100 条近期诊断摘要：

- Host 时间；
- action/type；
- 前后状态；
- Task/Effect ID；
- 稳定 error code 与短 summary。

第 101 条写入时删除最旧项。它只用于 Agent 排查近期故障，不用于责任审计、权限判断或完整重放。禁止保存 credential、prompt、persona、完整工具输出或 provider response。

## 7. Mutation 模型

所有 State Store mutation 使用一个 Host 进程内串行队列：

1. 读取并严格校验当前 singleton row；
2. 按固定 Workflow Definition 校验 requested action；
3. 计算完整新 snapshot；
4. `state_version + 1`；
5. 在一个短 SQLite 事务中整体替换 singleton row；
6. commit 后返回当前 state/version。

不使用调用方提供的 expected revision，不做跨会话 CAS，不保存 Command Receipt。重复命令由当前 state/Gate 规则拒绝或成为明确无操作。

Host 主线程持有一条 SQLite connection。snapshot 很小，因此不使用专用 worker thread、连接池或 WAL。DB busy/I/O error 时停止当前推进并允许用户重试或 reset，不建设自动 storage recovery。

## 8. Task 派发与中断恢复

### 8.1 正常派发

派发权威 Task 前先把它写入 `runningTask(status=running)`。Role Actor/runner 完成后，Host 校验当前 Gate、candidate 和结果，更新 Workflow state 并清空 `runningTask`。

Child 严格串行、读写阶段和职责边界仍由固定 Workflow Definition/Host action evaluator 执行；不依赖 lease。

### 8.2 系统中断

Host 启动时发现非空 `runningTask`：

1. 将其标记为 `interrupted`；
2. Workflow 进入 `recovery(interrupted-task)`；
3. 停止自动派发；
4. Manager 检查对应 DSH Actor、工作树、branch、commit/PR 和远端事实；
5. 可恢复时向同一 Actor 重新发送当前 step 完整上下文；
6. 原 Actor 不可用时创建 replacement，或让对应角色从现有文件继续同一步；
7. 无法判断或不值得继续时，由直接人类 reset。

不恢复精确消息中断点，不自动接受旧输出，不记录 attempt/checkpoint，也不自动重跑整个 Task。

## 9. 外部 Effect 与中断恢复

### 9.1 固定 Handler

每种 Host 固定 effect type 只实现：

```text
preflight(snapshot, liveFacts)
execute(target, expectedFacts)
inspect(target, expectedFacts) -> applied | not-applied | unknown
```

Effect type 是 Host 固定闭集，Policy/Agent 不能新增。

### 9.2 执行协议

1. 保存 `pendingEffect(status=prepared)` 以及确定 target/expected branch/SHA；
2. 执行 fresh `preflight`；
3. 外部调用前保存 `status=started`；
4. 调用 `execute`；
5. 调用 `inspect` 重新读取真实外部状态；
6. `applied|not-applied` 得到确定处理结果后，更新 Workflow 当前 state 并清空 `pendingEffect`；
7. 调用超时、响应丢失或无法判断时保存 `status=unknown` 并停止自动推进。

一个 effect 解决前不创建第二个 `pendingEffect`。

### 9.3 重启恢复

根据持久化的 `pendingEffect.status`：

- `prepared`：重新执行 fresh preflight 后可以继续；
- `started|unknown`：必须先调用 `inspect`。

`inspect` 的结果不是新的持久化 status，按以下方式处理：

- `applied`：更新当前 Workflow 并清空 `pendingEffect`；
- `not-applied`：可在用户/Manager 继续当前 step 时重新 preflight/execute；
- `unknown`：保持持久化 `status=unknown` 并停止，由用户稍后重查、人工处理或 reset。

不做自动 retry/backoff、attempt 计数、通用 reconciliation 状态机或 completed effect 历史。

## 10. 启动流程

完整启动恢复只有五步：

1. 解析伞仓 git-dir 并打开 SQLite；
2. 没有 snapshot：进入正常空闲状态；
3. snapshot 非法或 singleton column `format_version` 不兼容：停止并提示直接人类 reset；
4. 存在 `runningTask`：按第 8.2 节进入 interrupted recovery；
5. 存在 `pendingEffect`：按第 9.3 节处理；否则按 snapshot 当前 state 继续。

不增加自动 repair、archive restore、Task replay、后台 reconciliation、Host readiness 状态机或启动一致性图扫描。

## 11. Workflow 生命周期

### 11.1 新建

无 snapshot 时可创建新 Parent。snapshot 中存在 Active Parent 时拒绝另建；该限制是简单状态检查，不是多会话锁。

### 11.2 终态

Parent 进入 `completed|abandoned` 后，当前 snapshot 保留供用户查看最近一次结果。Host 不启动 retention timer。

用户显式启动下一个 Workflow 时，用新的初始 snapshot 整体覆盖旧终态状态；不创建 Archive/Tombstone，也不自动处理旧 Git/GitHub/DSH 资源。

### 11.3 Workflow Reset

概念动作 **Workflow Reset** 只接受当前主会话的直接人类明确请求。其具体 tool/action 名称留给后续专项冻结；Manager LLM、Role Actor、Policy reload、background work 和错误处理不能自动触发。

Reset：

- 清空 singleton row；
- 不伪造 Parent completed/abandoned；
- 不执行 Git reset/clean/checkout；
- 不删除 branch/commit；
- 不关闭 PR/Issue/Milestone；
- 不回滚或重复外部 effect；
- 不删除 DSH session。

DB 无法读取时，直接人类仍可请求删除固定 `state.sqlite3` 并重新初始化。

## 12. 格式升级与损坏

首期只接受精确 `workflow-state/v1`，不提供 migration。

遇到以下情况时停止自动推进：

- SQLite 无法打开；
- singleton row 无法读取；
- JSON 解析失败；
- snapshot strict schema 失败；
- singleton column `format_version` 不支持；
- SQLite transaction/I/O error。

用户可以重试；不值得修复时执行 Workflow Reset。Host 不自动猜测、修复、备份恢复或改写 Git/远端现场。

## 13. 仍待后续专项冻结

本设计只冻结 State Store 边界。以下内容仍分别讨论：

- 固定 Workflow Definition 的精确 Parent/Child/Task/Gate state 与 transition 常量；
- snapshot 各嵌套对象的完整字段/enum schema；
- Git/GitHub adapter 的具体 effect type 与三函数 handler；
- Validation Definition、test runner 与 current Gate evidence 字段；
- Workflow tool/action 名称、状态查询和 reset UI；
- bounded error/recovery code catalog。
