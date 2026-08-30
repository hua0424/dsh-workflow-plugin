# Durable Workflow Ledger 与崩溃恢复

- 状态：讨论中（当前决策已落盘；下一轮先做简化调整，暂不进入逐表 schema 或下一专项）
- 关联设计：
  - `docs/design/parent-child-workflow-instances.md`
  - `docs/design/trusted-actor-role-binding.md`
  - `docs/design/workflow-policy-dsl-static-validation.md`

## 1. 设计目标

本专项冻结固定 Workflow Definition 的持久化事实、事务边界、并发控制、幂等、lease、外部 effect、reconciliation 与 Host 重启恢复语义。

Workflow Ledger 是 Parent/Child 工作流状态和审计历史的权威本地记录，但不是 GitHub、Git remote、provider 或测试环境等外部事实的替代品。不可逆外部 effect 仍须在执行前重新验证对应远端事实。

## 2. 已确认：插件拥有独立 SQLite Ledger

首期采用插件自有 SQLite 数据库。插件直接拥有并管理：

- SQL schema；
- 精确 schema version 与不兼容时的 Ledger Generation Reset；
- 数据库连接与事务；
- Workflow Ledger 的完整生命周期。

DSH 负责插件生命周期、服务组合和调用上下文，但 DSH Storage Domain 不作为权威 Workflow Ledger，也不承载必须原子提交的 workflow transition。

### 2.1 原因

一次权威 workflow mutation 至少需要把状态 revision、append-only transition event 和待执行 outbox effect 作为一个不可分割的提交处理。当前考察到的 DSH Storage Domain 公开接口只提供单个 KV record 的 `put`、`delete`、`update` 和串行写队列，没有跨 record/跨 table 事务边界；当前使用的 DSH `0.1.1-rc.2` 安装包也没有把相关 storage packages 作为插件可直接依赖的稳定运行契约。

将整个 Parent 聚合压入单个 KV value 虽能借用单 key 原子更新，但会恶化事件增长、outbox 扫描、局部恢复、schema migration、运维查询和审计读取，因此不作为首期权威存储方案。

插件自有 SQLite 可以用显式数据库事务保证后续要冻结的 ledger 原子性，不要求先扩展 DSH 自身的 storage abstraction。

### 2.2 边界

- SQLite 是本插件的内部持久化实现，不进入 Workflow Policy Profile。
- Agent 和 Workflow tool 不接受数据库路径、SQL、table 名或事务参数。
- 任何数据库写入都必须通过 Host 的固定 application service 和 authorization/transition evaluator，不能向 Role Actor 暴露通用存储接口。
- SQLite 中记录的远端事实是已验证 snapshot、identity 或 evidence reference；需要实时性的关键事实仍由相应 adapter 重新获取和验证。
- 数据库不可打开、schema 不兼容、事务提交失败或 durable 状态不确定时 fail closed，不以进程内状态继续推进。

## 3. 已确认：Parent 是唯一一致性聚合根

首期以 Parent 作为一个工作流实例的唯一一致性聚合根。该 Parent 下任何 Child、Gate、evidence、Role Actor mapping 或 delivery 状态 mutation 都必须：

1. 指定目标 `parentId`；
2. 携带调用方读取到的 `expectedParentRevision`；
3. 在同一数据库事务内验证当前 Parent revision；
4. 仅在全部 mutation 内容成功持久化后把 Parent revision 精确增加 `1`。

若 Parent 不存在、已处于不允许 mutation 的终态，或当前 revision 不等于 `expectedParentRevision`，整个 mutation 以稳定 denial 失败，不写入部分状态、成功事件或待执行 effect。调用方必须重新读取当前 Workflow 状态后再决定下一动作，Host 不把 stale mutation 自动重放到新 revision。

Child 和其他 Parent 内部实体不拥有独立的乐观并发 revision。它们的所有状态变化都排入 Parent 的单一提交序列。这样与首期 Child 严格串行、单一 `nextRunnableChild` 和固定 Gate 顺序保持一致，不引入跨聚合协调。

不同 Parent 之间不共享 revision；是否允许同一 Product Workspace 同时存在多个 active Parent 属于后续运行范围与 lease 设计问题，不由本决策提前开放。

## 4. 已确认：当前状态表权威，事件用于追加审计

首期不采用完整 Event Sourcing。Workflow Ledger 中规范化的 Parent、Child、Gate、evidence reference、Role Actor mapping、delivery 和其他当前状态记录是 Host 做运行时判断的权威本地状态。

每次成功的权威 mutation 必须同时追加不可修改的 Workflow Event。当前状态修改、Parent revision 推进和对应事件写入属于同一个数据库事务，不能出现“状态已变但没有事件”或“事件宣称成功但状态未变”。

Workflow Event 用于：

- 记录谁在什么 Parent revision 上请求并完成了哪项 mutation；
- 关联状态变化、evidence、Role Actor 和外部 effect；
- 提供可解释时间线与事故审计；
- 支持检查当前状态与历史提交序列是否一致。

Workflow Event 不是唯一状态来源。首期不承诺删除当前状态表后可以只靠 event replay 重建全库，也不把 projection rebuild、历史事件 upcaster 或跨版本 replay 作为恢复路径。数据库损坏、schema 不兼容和 migration 失败必须 fail closed，交由后续备份与运维恢复规则处理，不能把不完整事件日志当作自动修复来源。

在 Parent 保留期间，append-only 约束意味着已提交事件不得更新或单独删除；需要纠正时必须通过新的显式 mutation 和新事件表达，不改写历史。第 48 节另确认：Parent 进入终态满 30 天后，整个 Parent 聚合连同全部 Event 一起物理清理且不留 Tombstone；这是唯一 retention 例外。

## 5. 已确认：外部 effect 使用固定两阶段 Outbox

任何会修改 GitHub、Git remote、工作树、Gitlink、分支、PR、Issue、Milestone、label 或其他外部系统的 effect，都不得在 SQLite 数据库事务内部执行，也不得先执行外部操作再尝试补写 Ledger。

带外部 effect 的权威 transition 固定分成两个 Ledger 提交阶段：

### 5.1 Effect Intent 提交

第一事务必须：

1. 校验 Parent 当前状态、`expectedParentRevision`、Actor authorization、Gate/evidence 和执行该 effect 所需的已解析目标；
2. 记录不可变 Effect Intent 与其确定参数/事实 snapshot；
3. 写入统一的 Effect Outbox record；
4. 将触发该操作的内部执行阶段标记为 awaiting/pending effect，不能提前写成业务成功；
5. 追加对应 Workflow Event；
6. 将 Parent revision 增加 `1`。

以上记录必须全部提交或全部回滚。这里的 pending effect 是 Workflow Ledger 的固定内部执行阶段，不是 Policy 可配置状态，也不允许 Policy 新增或改写 effect lifecycle。

### 5.2 Effect 执行与确认提交

第一事务成功并满足 backup barrier 后，Host effect worker 才能领取并执行该 Effect record。执行不可逆 effect 前必须再次从对应 adapter 获取并验证实时关键事实；第一事务中记录的旧 snapshot 不能替代执行时 preflight。

外部调用返回成功不自动等于 Workflow 成功。Host 必须尽可能读取远端/本地权威结果进行确认或 reconciliation。结果明确后，以第二个数据库事务：

- 记录 effect attempt 与已确认 outcome；
- 更新 Effect record 当前状态；
- 进入 Workflow Definition 规定的成功、失败、recovery 或继续对账阶段；
- 追加新的 Workflow Event；
- 再次推进 Parent revision。

如果调用超时、连接中断、响应丢失或进程崩溃导致“effect 可能已发生但结果未知”，不得直接判定失败、成功或盲目重复执行；保持未决状态并先走 reconciliation。

不产生外部 effect 的纯 Ledger mutation 不需要人为拆成两阶段，可以在一个数据库事务内完成当前状态、事件和 Parent revision 的原子提交。

## 6. 已确认：每个 Parent 最多一个未决 Effect Intent

首期每个 Parent 同时最多存在一个尚未得到确定 outcome 的 Effect Intent。未决范围包括 waiting、claimed、executing、outcome-unknown 和 reconciling 等内部阶段；具体状态名将在 Effect Outbox 状态机设计中冻结，但不得通过换名绕过单一未决约束。

存在未决 Effect Intent 时，该 Parent 暂停普通工作流推进：

- 不接受新的普通 transition；
- 不派发新的 Role Actor task/turn；
- 不创建另一个 Effect Intent；
- 不因调用超时就盲目重试可能已经发生的外部操作；
- 不允许 Manager 或 Role Actor用其他工具绕开 effect lifecycle 修改相关资源。

此时只允许：

- 读取 Workflow 状态、历史、阻塞原因和 effect 状态；
- Host effect worker 对当前 intent 执行 claim、受控执行、reconciliation 与安全释放；
- Host 对当前 intent 执行远端 reconciliation；
- Host 将当前 intent 的确定 outcome 作为新的 Parent mutation 提交；
- 固定运维/终止规则明确允许的操作；这些操作的细节必须在后续恢复设计中逐项列出，不能用通用 override 表达。

一个逻辑步骤若需要多个外部 effect，Workflow Definition 必须把它们确定性排序，并在前一个 effect 得到确定 outcome 后再为下一个 effect 创建新 intent。首期不建立 effect dependency graph，也不并发执行同一 Parent 的多个 effect。

单一未决 effect 是 Parent 内部约束；不同 Parent 是否可以并行执行仍受后续 Workspace lease 和资源 lease 规则控制。

## 7. 已确认：Command ID 由可信调用边界派生

每个可能读取或修改 Workflow Ledger 的命令都必须具有 Host 可验证的 Command ID。Command ID 不是身份或授权本身，但它必须绑定可信调用上下文，不能来自 Agent 可自由填写的 tool 参数。

首期来源规则：

- DSH Workflow tool 调用：由 Host 使用 DSH `ToolExecution` 中的真实 agent/session 上下文与 `exec.callId` 派生；
- Host 内部 effect/reconciliation worker：由已持久化 Effect ID、worker operation identity 与固定操作类型派生；
- Host 启动与恢复任务：由对应持久化 recovery work identity 派生；
- 未来 Web/HITL 入口必须由可信 transport/application boundary 分配或验证 request identity，不能直接相信页面提交的任意 Actor/role/idempotency 字段。

Workflow tool schema 不提供 `idempotencyKey`、`commandId` 或等价的可覆盖参数。Agent 重复生成一个内容相同但 `exec.callId` 不同的新工具调用，是一个新的命令，仍须经过当前 revision、状态、Gate、authorization 和重复业务约束校验；它不会被参数 hash 误当成旧命令。

Command ID 不单独授权任何 mutation。Host 仍必须依据 trusted Actor、Parent 状态、`expectedParentRevision`、Workflow Definition 和实时 preflight 独立判断。

## 8. 已确认：成功命令写入严格 Command Receipt

每个成功提交的 Workflow mutation 必须在同一数据库事务中写入不可变 Command Receipt。在所属 Parent 保留期间 Receipt 不得 update/单独 delete；Parent 终态满 30 天后的整聚合 purge 按第 48 节删除全部 Receipt。Receipt 至少绑定：

- Command ID；
- 可信调用边界解析出的 Actor/调用来源引用；
- action 类型；
- `parentId` 与请求的 `expectedParentRevision`；
- Host 对已解析语义参数计算的 canonical request fingerprint；
- 提交产生的新 Parent revision；
- 对应 Workflow Event ID；
- 若有外部 effect，则关联 Effect Intent ID；
- 可稳定重放给调用方的原提交 outcome。

canonical fingerprint 由 Host 对通过 schema 解析后的命令语义计算，不直接 hash 原始 JSON 文本，也不包含 credential、persona 全文、自由日志或其他敏感/非语义内容。具体 canonical encoding 与 hash 算法在数据库字段设计时冻结，但必须确定性且带版本标识。

收到已存在的 Command ID 时：

1. Host 计算本次请求的 canonical fingerprint；
2. 若 fingerprint、目标 Parent 和 action 均与 Receipt 相同，则这是同一已提交命令的重入：直接返回原提交 outcome，不推进 Parent revision、不追加 Workflow Event、不重复写 evidence、不创建新的 Effect Intent；
3. 若任一绑定内容不同，则 fail closed，返回稳定 `command-id-conflict`，不得把旧结果套用到不同请求；
4. 原命令产生的 effect 后来可能已经推进到其他状态；重复命令仍返回原提交身份，并可附带当前 effect/Parent 状态，但不能伪装成新的 transition 结果。

该规则专门覆盖“数据库事务已经提交，但调用方在收到响应前断线/崩溃”的情况。它不把内容相同但 Command ID 不同的新命令自动去重；新命令仍按当前 revision 和 Workflow Definition 正常校验。

## 9. 已确认：Denial 使用独立 Command Attempt Audit

被拒绝的命令不是成功 Workflow mutation，因此：

- 不写 Command Receipt；
- 不追加 Workflow Event；
- 不推进 Parent revision；
- 不更新 Parent/Child/Gate/evidence/Actor/effect 当前状态；
- 不创建 Effect Outbox record 或执行任何外部 effect。

当且仅当 Host 已能从可信执行上下文确定 caller identity，并能安全解析目标 Parent 时，Host 在独立的 append-only Command Attempt Audit 中记录结构化拒绝事实。记录范围限于：

- attempt identity 与接收时间；
- Command ID（若可信调用边界已经形成）；
- caller/Actor reference；
- `parentId`；
- action 类型；
- 调用方声明的 `expectedParentRevision` 与当时观察到的 revision（若可安全读取）；
- 稳定 denial code 与安全的结构化 path/summary；
- 对应的 Host/Workflow Definition version references。

Attempt Audit 不保存原始 tool 参数、credential、persona、完整 prompt、自由文本堆栈或可能包含秘密的 adapter response。message 可以在返回时根据 denial code 和安全字段生成，不要求把原始 message 永久保存。

无法形成可信 caller、无法安全解析 Parent、请求 schema 本身非法或在到达 Workflow application boundary 前失败的调用，只进入受控 Host operational/security log 和计数指标，不写入某个 Parent 的 Attempt Audit，避免让任意垃圾输入污染权威数据库。

Attempt Audit 写入失败不会把被拒命令变成允许；原命令仍 fail closed。具体日志告警、容量限制和 retention 在运维设计中冻结。

外部 effect 已开始后的失败、超时和未知结果不是 Command denial，必须更新同一 Effect record 的最小 execution metadata 并遵循 reconciliation 语义，不能混入本节的拒绝审计；首期不创建独立 Effect Attempt 实体。

## 10. 已确认：Parent Revision、Workflow Event 与 Receipt 一一对应

除 Parent 内部纯运维记录外，每个成功 Parent 领域 mutation 恰好产生：

- 一个新的 Parent revision；
- 一个 Workflow Event；
- 一个 Command Receipt。

三者在同一数据库事务中提交。`WorkflowEvent.aggregateRevision` 和 `CommandReceipt.committedRevision` 必须等于提交后的 Parent revision，数据库必须对 `(parentId, aggregateRevision)` 建立唯一约束。对同一 Parent，成功事件 revision 从创建时确定的首值开始连续单调增加，不允许缺号、重复或在提交后改写。

一个领域 mutation 可以原子修改多个当前状态记录，例如同时更新 Child、Gate、evidence reference 和 Role Actor mapping；这些变化由同一个 Workflow Event 以稳定 event type 和安全结构化摘要表达，不按数据库行拆成多个同 revision 事件。

因此一次成功领域 mutation 的事务不变量是：

1. 校验 Command ID/Receipt 不冲突；
2. 校验 Parent、`expectedParentRevision`、状态、Actor、Gate/evidence 和其他固定前置条件；
3. 计算唯一的新 revision；
4. 写入全部规范化当前状态变化；
5. 若需要外部 effect，则写入唯一统一 Effect Outbox record；
6. 追加一个绑定新 revision 的 Workflow Event；
7. 写入一个绑定同一 revision/event/effect 的 Command Receipt；
8. 更新 Parent 当前 revision；
9. 全部成功后提交，否则整体回滚。

只读命令不产生 revision、Workflow Event 或 Command Receipt。被拒命令遵循 Command Attempt Audit。worker claim、lease acquire/release/orphan/takeover、Effect execution metadata 和其他纯运维记录是否推进 Parent revision，必须在后续逐类明确；它们不能被误称为领域 mutation 来绕过本节的一一对应约束。

## 11. 已确认：一个 Effect ID，不建立逐次 Attempt 实体

首期每个 Effect Intent 由 Host 在创建时分配一个不可变 Effect ID。Effect ID 在该逻辑 effect 的 waiting、claim、execution、超时、reconciliation、retry 和最终 outcome 全生命周期中保持不变。

- Agent、Manager tool 参数和 adapter 输入不得提供或覆盖 Effect ID；
- adapter 支持原生 idempotency key 时，统一使用稳定 Effect ID；
- adapter 不支持原生 idempotency key 时，Effect ID 仍用于本地去重、目标事实绑定和 reconciliation；
- retry 不创建新的 Effect Intent 或 Effect ID；
- 同一 Parent 的新逻辑 effect 必须等前一个得到确定 outcome 后再创建新的 Effect ID。

为保持首期简单，不创建独立 Attempt ID、Effect Attempt table 或逐次 attempt history。Effect 主记录只维护支持安全恢复所需的最小 mutable execution metadata：

- `executionStarted`；
- `attemptCount`；
- `lastAttemptAt`；
- `lastOutcomeClass`；
- `lastErrorCode`；
- 当前 claim/lease 信息（具体字段待 lease 设计冻结）。

这些字段不得保存原始 adapter response、credential、自由文本错误堆栈或敏感请求内容。`attemptCount` 表示 Host 开始过多少次受控执行尝试，不创造新的逻辑 effect 身份。

Host 必须在调用外部 adapter 前先持久化 `executionStarted=true`、增加 `attemptCount` 并记录安全的开始时间。这样 Host 重启后只要发现 effect 曾开始但没有确定 outcome，就先执行 reconciliation，而不是把它当成从未调用并直接重试。该保守规则允许“已记录开始但进程在真正发出请求前崩溃”的假阳性；假阳性只会多一次对账，不会导致重复 effect。

不保存逐次 Attempt history 是明确的 MVP 可观测性取舍。最终经验证的 effect outcome 仍必须通过 Parent 领域 mutation、Workflow Event 和 revision 提交；中间的 claim、开始、最近错误和重试计数属于 effect 运行元数据，不伪装为业务成功事件。

## 12. 已确认：Parent 创建提交 revision 1

Parent 创建本身是成功领域 mutation，必须遵守 revision、Workflow Event 和 Command Receipt 一一对应规则。

创建命令使用专用的“不存在”前置条件，而不是为尚不存在的聚合伪造 `expectedParentRevision=0`。事务必须：

1. 从可信 Manager/Host 调用边界形成 Command ID；
2. 验证 Parent 启动权限、Static Policy Validation、启动前 Environment Preflight 和后续将冻结的 Workspace active-Parent 约束；
3. 由 Host 生成新 `parentId`，Agent 参数不得指定或复用任意 ID；
4. 确认该 `parentId` 不存在；
5. 创建 Parent 当前状态及启动时已解析的固定初始事实；
6. 将 Parent revision 设为 `1`；
7. 追加 `ParentCreated` Workflow Event，`aggregateRevision=1`；
8. 写入对应 Command Receipt，`committedRevision=1`；
9. 全部在一个数据库事务提交。

`ParentCreated` 事件和 Receipt 只保存需要审计的安全结构化引用与 hash，例如 Workflow Definition version、Policy schemaVersion、已接受 Policy hashes、Workspace identity 和创建 Actor reference；不复制完整 Policy source、credential、persona 或外部 live object。

创建事务失败时不得留下 revision 0 Parent、孤立 ParentCreated event、半初始化 Child/Gate 或可被恢复流程误认成 active 的记录。Parent 一经成功创建，后续 mutation 必须从 `expectedParentRevision=1` 开始。

## 13. 已确认：每个 Product Workspace 最多一个活跃 Parent

首期一个 Product Workspace 同时最多存在一个非终态 Parent。以下状态都仍属于 active，占用唯一名额：

- 正常 workflow-active 推进；
- `workflow-recovery`；
- `delivery-partial`；
- 等待 Gate、Actor、用户修复或环境恢复；
- 存在 waiting、executing、outcome-unknown 或 reconciling Effect Intent；
- 任何其他尚可继续、修复或需要明确终止的非终态。

正常 Ledger generation 内，只有 Parent 已提交 `completed` 或 `abandoned` 终态后，该 Product Workspace 才能创建下一个 Parent。不得通过停止 Manager turn、关闭 Web 页面、Host 重启、暂停 Actor、释放 lease 或修改 Policy 文件来释放 active Parent 名额。

唯一已确认例外是 SQLite schema 不兼容时由直接人类执行第 27 节的 destructive Ledger Generation Reset。该操作结束整个旧 Ledger generation 而不伪造 Parent 终态；它不是正常 workflow transition，也不能用于兼容 schema、普通 recovery、Policy 变化或业务失败。

数据库必须使用后续冻结的稳定 Workspace identity 和 active-terminal discriminator 建立真实唯一约束，不能只在应用代码中先查询再插入。两个并发创建命令中最多一个可以成功提交 revision 1；另一个返回稳定 `active-parent-exists` denial，并指向现有 Parent，不产生半初始化记录。

`abandoned` 仍遵循既有边界：Host 只记录终态并停止推进，不因释放 active 名额而自动清理旧 Parent 的本地或远端产物。创建新 Parent 前的 Environment Preflight 必须基于当时真实 workspace/remote 状态重新验证。

多 Parent 排队、同 Workspace 多 Milestone、后台 Manager 和跨 Parent 调度属于未来 Workflow Definition/运行架构扩展，不在首期 Ledger 中预留通用调度模型。

## 14. 已确认：Parent Revision 与 Durable Lease 职责分离

Parent Revision 和 Durable Lease 解决不同问题，首期两者同时存在但不得互相替代。

### 14.1 Parent Revision

`expectedParentRevision` 始终保护短时间的 Parent 领域 mutation：

- 在单个 SQLite 事务内完成 compare-and-swap；
- 防止基于旧状态、旧 Gate、旧 Actor mapping 或旧 evidence 的 mutation 套用到新状态；
- 无论调用方是否持有某个 lease，都不能跳过 revision 校验；
- 普通 Ledger mutation 不需要先持有覆盖整个 Parent 的悲观 lease。

### 14.2 Durable Lease

Durable Lease 只保护跨数据库事务、跨进程并持续一段时间的执行所有权，例如：

- Role Actor 的长时间 task/turn；
- 当前 Effect Intent 的 worker claim 与执行窗口；
- release 等需要跨多个检查或 effect 保持单一 owner 的固定阶段；
- 后续测试执行设计明确需要独占的运行资源。

Lease 不能证明 Workflow transition 仍合法，也不能锁住 GitHub 或阻止插件外操作者。lease owner 在提交 Parent outcome 前仍须使用最新 expected revision，并重新验证相应状态和远端事实。

SQLite 自身的写锁只保护数据库事务，不等于 Durable Lease。进程内 Promise、mutex 或内存中的“正在运行”标志也不能替代持久化 lease，因为 Host 崩溃后它们不可恢复。

具体 lease scope、兼容矩阵、owner identity、Host Boot Epoch、fencing token 和 orphan takeover 规则后续逐项冻结。

## 15. 已确认：Lease Scope 是引擎固定闭集

首期 Durable Lease scope 只能来自固定 Workflow Definition 和 Host 实现声明的闭集。每个 lease key 必须由 Host 根据已持久化 Parent、Task、Effect Intent 或固定资源事实确定性构造。

以下输入均不得声明、拼接或覆盖 lease type、scope、resource key、owner、Host Boot identity 或 fencing token：

- Workflow Policy Profile；
- Agent/Manager tool 参数；
- Role Agent persona；
- adapter 返回值；
- 任意自由文本或环境变量。

Workflow tool 不提供通用 `claim(resource: string)`、`lease(scope: string)` 或同义接口。Actor 只能请求执行当前 Workflow 状态已经创建并授权给它的具体 task/action；Host 在内部解析该 action 所需的固定 lease。

固定 lease catalog 的每一种类型都必须在代码和设计中明确：

- key 的组成；
- 哪类可信 owner 可以持有；
- 与哪些其他 lease/Workflow phase 互斥；
- 何时获取、释放、判定 orphaned 和 takeover；
- fencing token 在哪些 Host guard/effect commit 中验证；
- owner 崩溃后的 takeover 和 recovery 语义。

未来若真实新 Workflow Definition 或测试执行资源需要新 lease type，应通过显式设计和版本升级加入固定 catalog，不通过 Policy 动态扩展。

## 16. 已确认：首期只有 Task 与 Effect 两类 Lease

首期固定 lease catalog 只有以下两类：

### 16.1 `task-execution(parentId, taskId)`

保护一个由固定 Workflow Definition 创建并持久化的 Workflow Task 的长时间执行所有权。适用于：

- Role Actor 的 PRD Review、开发、Code Review、Tester 等权威 task/turn；
- Host 固定 release task；
- 后续自动测试专项在现有 Workflow Task 内定义的执行任务，但不自动授予任意外部设备锁。

每个 Task 同时最多一个有效 execution lease owner。多个只读 Task 是否可以并行由 Parent 当前 phase、Task Facts 和读写屏障决定，不由 lease key 命名决定。写型 Task 与强制 Review/测试 Task 的互斥仍由 Host 在创建、派发和每次受控 mutation 时强制。

### 16.2 `effect-execution(parentId, effectId)`

保护当前 Effect Intent 的 worker claim、外部调用窗口和 reconciliation 所有权。它不创造第二个 Effect ID，也不允许同一 Parent 出现多个未决 effect。

### 16.3 明确不建立的首期 Lease

首期不另设：

- 通用 Parent lease；
- 通用 Workspace writer/resource lease；
- 独立 phase lease；
- 独立 release lease；
- Agent 自定义 lease；
- Policy 声明 lease；
- 尚未由自动测试专项确认的 desktop/device lease。

既有父子工作流设计中的“父实例级 release lease”统一解释并修正为固定 release task 的 `task-execution` lease。release task 仍受 Parent revision、单一未决 Effect Intent、全量 preflight 和串行 effect 约束；不因少一个独立 lease 类型而降低交付保护。

未来新增固定资源 lease 前必须证明 Task/Effect lease 与既有状态机无法表达真实互斥需求，并显式补充 key、owner、兼容矩阵、fencing 与恢复规则。

## 17. 已确认：每个 Lease Key 使用单调 Fencing Token

每个固定 lease key 都维护自己的单调递增 fencing token。首次成功获取以及 orphaned lease 的每次成功 takeover 都必须分配严格大于该 key 历史所有 token 的新值；token 不得回绕、复用或在 lease release 后重置。

lease 当前记录至少绑定：

- 固定 lease type 与确定性 key；
- `parentId` 及 `taskId` 或 `effectId`；
- 当前可信 owner identity；
- fencing token；
- `hostBootId`；
- acquired/released/orphaned 时间；
- 当前 lease 状态。

以下操作必须同时校验当前 owner identity 与 fencing token：

- 主动 release；
- Role Actor/Task owner 发起的受控写工具和权威 task outcome；
- effect worker 更新执行元数据；
- effect worker开始外部 adapter 调用前的最后 Host guard；
- task/effect 最终 outcome 对 Parent 的提交。

旧 token 一旦因 takeover 被更大 token 取代，就永久失效。即使旧进程、旧 Actor turn 或延迟消息后来恢复，也只能读取安全状态，不能 release、修改工作区、调用受控外部 effect 或提交 outcome。

Agent tool 参数不得携带或声称 fencing token。Host 从 trusted Role Actor mapping、Task dispatch/worker execution context 与当前 lease record 解析执行世代，防止 Agent 通过复制新 token 冒充 owner。

Fencing token 只能约束经过本插件 Host guard 和 Ledger 的操作，不能让 GitHub 或文件系统自动理解 token。因此 effect worker 在外部调用前必须最后校验 lease，使用稳定 Effect ID，并在结果未知时走 reconciliation；插件外操作者仍由实时 preflight 和远端保护处理。

fencing token 分配与 lease owner 替换必须在一个 SQLite 事务内 compare-and-swap，两个竞争 takeover 中最多一个成功。

## 18. 已确认：Lease 无 TTL，使用 Host Boot Epoch 判断 Orphan

首期 Durable Lease 不使用墙钟 TTL、heartbeat cadence 或 takeover grace，也不允许 Policy/Agent 配置时间参数。lease 在同一次 Host boot 内持续有效，直到：

- owner 完成并正常 release；或
- Host 通过固定取消/恢复流程确认原执行已停止后 release；或
- 持有 lease 的 Host boot 已终结，新 Host boot 将其判定为 orphaned 并执行受控 takeover。

每次 Host 启动必须创建新的不可复用 `hostBootId`，并在 Ledger 中记录 boot start、当前 instance identity 与后续 clean/unclean end 状态。所有 lease owner 都绑定获得它时的 `hostBootId`。

新 Host 冷启动恢复时：

1. 在数据库事务内识别仍指向其他 `hostBootId` 且未正常 release 的 lease；
2. 将其标记为 orphaned；
3. 不把旧 lease 的 Task/Effect 自动判定成功或失败；
4. 根据 Task 与 Effect 各自的恢复规则决定是否、何时 takeover；
5. takeover 必须分配更大的 fencing token，并留下结构化恢复审计。

由于首期是单 Host authority，新的 Host boot 是旧 Host 进程已终止的恢复边界。若未来支持多 Host 并发或远程 worker，Boot Epoch 不能再单独证明 owner 已死亡，必须重新设计分布式 liveness/TTL 协议，不能沿用本规则假装安全。

同一 Host boot 内，卡死、取消中或失联的 Role Actor/worker 不会因时间经过自动失去 lease。Host 必须先通过固定执行器控制确认它已经停止，才能 release 或分配新 owner；无法确认时 fail closed 进入 recovery。不存在通用 `forceRelease` 或人工填写新 token 的入口。

无 TTL 是有意的首期确定性取舍：避免系统时钟漂移和长 LLM turn 被误判过期，但代价是同一 boot 内的挂起工作不能仅靠等待自动恢复。

## 19. 已确认：Lease Lifecycle 使用独立运维序列

Lease acquire、正常 release、orphan 标记和 takeover 是执行所有权运维变化，不是 Parent 领域 mutation。它们使用独立 SQLite 事务：

- compare-and-swap 更新 lease current record；
- 追加不可修改的 Lease Audit；
- 不推进 Parent revision；
- 不产生 Workflow Event；
- 不产生 Command Receipt。

Lease Audit 至少记录 lease type/key、`parentId`、`taskId|effectId`、operation、旧/新 owner reference、旧/新 `hostBootId`、旧/新 fencing token、时间和稳定 reason code；不保存 persona、prompt、credential、自由文本错误或 adapter payload。

以下边界仍属于 Parent 领域 mutation并遵循 revision/event/receipt 一一对应：

- 创建并授权一个 Workflow Task；
- Task 的权威 outcome 改变 Child/Gate/evidence/Actor 或 Parent 状态；
- 创建 Effect Intent；
- 经验证的 Effect 最终 outcome 改变 delivery/Parent 状态；
- 进入或离开固定 Workflow Recovery 业务状态。

一个 Task dispatch mutation 可以提交 Task Fact，随后由独立 lease 事务取得 execution owner。lease 获取失败不回滚已经存在的 Task Fact，也不能把 Task 标记完成；Task 保持待执行/阻塞，由状态查询解释当前无 owner 或存在竞争 owner。

Lease Audit 写入必须与 lease current record 变化在同一运维事务中；不能只改 owner/token 而没有审计，也不能只有 Audit 宣称 takeover 而 current record 未更新。

由于 lease 运维事务不推进 Parent revision，任何后续 Task/Effect outcome 提交仍必须单独校验最新 expectedParentRevision、当前 lease owner/token 和 Workflow 状态。拥有新 token 不会使基于旧 revision 的 outcome 自动有效。

## 20. 已确认：Orphaned Task 必须显式恢复后继续同一 Task

新 Host 发现 orphaned `task-execution` lease 时，不得把对应 Workflow Task 自动标记为失败、成功、取消或可立即重跑，也不得直接接受旧 Role Actor 输出。

固定恢复顺序：

1. 冷启动先把旧 boot lease 标记为 orphaned，保留旧 owner 与 fencing token 的 Lease Audit；
2. 通过一个正常 Parent 领域 mutation 使对应 Parent 进入 `workflow-recovery`，记录 `orphaned-task-execution` recovery cause；
3. Host 使用 DSH adapter 确认旧 turn 已不再运行；无法确认时保持 recovery，不能 takeover；
4. 按 Task 类型检查可能已经产生的本地工作树、commit、branch、PR、远端或 evidence candidate，保留现场，不自动 cleanup/rollback；
5. 旧 turn 的文本输出或结构化结果只能作为诊断/candidate，不能绕过当前 revision、SHA、Gate 和 evidence 验证直接成为权威 outcome；
6. 若原 Role Actor durable session 可恢复，则继续使用同一 Actor mapping；若确认不可恢复，则按 Trusted Actor 设计使旧 mapping 失效并创建新的 agent.id，保留旧 session/mapping/evidence 历史；
7. 仅在旧 turn 已停止且恢复方案确定后，对同一个未完成 Task takeover，分配更大的 fencing token；
8. 向恢复或替代 Actor 重新派发完整当前上下文和现场事实，由它继续同一 Task，而不是创建一个内容相同的新 Task；
9. Task 产生的新 outcome 仍以当前 `expectedParentRevision`、当前 Actor mapping、当前 lease owner/token 和实时事实提交。

如果现场变化使原 Task 的候选 SHA、Gate 或前置条件失效，Workflow Definition 重新计算最早未满足 Gate 或进入固定 remediation/conflict-resolution 路由；不能为了复用旧工作而降低验证。

同一 Host boot 内的显式取消也使用相同安全原则：先由执行器确认旧 turn 已停止，再 release/takeover。不存在“等待足够久后视为停止”。

## 21. 已确认：Orphaned Effect 按 `executionStarted` 保守分流

新 Host 发现 orphaned `effect-execution` lease 时，先保留原 Effect ID 和执行元数据，再按以下规则恢复。

### 21.1 `executionStarted=false`

该值表示旧 owner 尚未提交“即将调用外部 adapter”的持久化开始标记。按照固定协议，外部调用不得早于该标记，因此 Host 可以：

1. 标记旧 lease orphaned；
2. 对同一 Effect Intent takeover 并分配更大的 fencing token；
3. 重新执行当前阶段要求的 fresh preflight；
4. 持久化 `executionStarted=true`、增加 `attemptCount` 和安全时间/分类字段；
5. 再次校验当前 owner/token；
6. 使用同一个 Effect ID 调用 adapter。

若 fresh preflight 失败，保持 effect 未决并进入/维持对应 recovery，不得把 effect 标记失败或创建新 Effect ID。

### 21.2 `executionStarted=true` 且没有确定 outcome

必须假设旧调用可能已经到达外部系统。新 Host takeover 后只能先执行 reconciliation，不得直接 retry。reconciliation 结果：

- **confirmed-applied**：验证外部 effect 已按 intent 目标与参数发生，以正常 Parent mutation提交成功 outcome；
- **confirmed-not-applied**：确认外部系统没有发生该 effect 后，才允许在 fresh preflight 后使用同一 Effect ID 受控执行；
- **confirmed-failed**：外部系统提供确定失败事实时，按 Workflow Definition 提交失败/recovery outcome；
- **indeterminate/unavailable**：保持未决 effect 和 `workflow-recovery`，等待后续 reconciliation，不成功、不失败、不盲重试。

adapter 的“not found”只有在该 API 的语义足以证明目标 effect 未发生时才能分类为 confirmed-not-applied；网络错误、权限不足、rate limit、响应不完整或查询范围不确定一律不能作为未发生证明。

reconciliation 本身不创建新 Effect Intent。它使用同一个 Effect ID、当前 `effect-execution` lease owner/token 和已解析目标。最终 outcome 才推进 Parent revision并产生 Workflow Event/Command Receipt；claim、orphan、takeover 和中间 execution metadata 仍属于独立运维序列。

## 22. 已确认：Active Boot Row 加本机进程判活

首期每个 Workflow Ledger 同时只允许一个 Host Boot authority。实现不持有 OS 文件锁，而是在 SQLite 中维护唯一 active-boot row，并结合本机进程存活校验决定是否允许新 Host 接管。

active boot 至少记录：

- `hostBootId` 与不可复用 boot nonce；
- Host instance/build/version reference；
- 本机 PID；
- 可用于防 PID 复用的进程启动标识；
- startedAt；
- clean/unclean end 状态与 endedAt（结束后）；
- 当前 active discriminator。

新 Host 启动规则：

1. 若没有 active boot，使用 SQLite 唯一约束/CAS 创建新 active boot；
2. 若存在 active boot，使用本机 OS 能力校验该 PID 是否存在且进程启动标识是否与记录匹配；
3. 确认旧进程仍存活：新 Host fail closed，不创建 Boot Epoch、不提供 mutation/effect 服务、不把 lease 标记 orphaned；
4. 确认旧进程不存在：在同一 SQLite 事务中把旧 boot 结束为 unclean，并创建新的唯一 active boot；
5. PID 已复用为不同启动标识：旧 boot 对应进程视为不存在，但该判断和证据必须审计；
6. 权限不足、平台不支持、进程身份读取失败或结果矛盾：无法证明旧 Host 已死，fail closed，不 takeover；
7. 两个新 Host 同时争抢一个 crash 残留 boot 时，SQLite CAS/唯一约束最多允许一个创建新 active boot，失败者重新读取后发现活 boot并拒绝启动。

新 Host 不能无条件覆盖 active row，也不使用 elapsed time/TTL 猜测旧 Host 已死。管理员、Agent 和 Policy 不能传入 `oldHostDead=true`、PID、boot nonce 或 force-takeover 参数。

本规则只支持同一台机器上的单 Host authority。远程 Host、容器跨节点共享 Ledger、网络文件系统或无法可靠查询本机进程身份的部署不属于首期支持范围，Environment Preflight 必须拒绝。

Host clean stop 时在停止接受新工作、停止/确认执行器并安全处理 lease 后，将自己的 boot row提交为 clean-ended。若 clean stop 流程无法确认 Task/Effect owner 已停止，对应 lease 保留未释放状态，由下一 Boot 按 orphan 恢复，而不是伪造正常 release。

## 23. 已确认：启动恢复完成前只开放只读状态

Host 冷启动期间使用明确 readiness gate。完成以下步骤前，不得开放任何 Workflow mutation、Task dispatch、lease acquire/takeover、Effect Outbox execution、reconciliation effect 或其他外部 mutation：

1. SQLite 文件与基础连接安全检查；
2. schema version/迁移兼容性检查；
3. active boot 进程判活与当前 Boot Epoch 获取；
4. 旧 boot 未释放 lease 的 orphan 标记与 Lease Audit；
5. Ledger 结构/关系一致性检查；
6. 当前 Active Parent、Task 和 Effect Intent 的恢复分类；
7. 确认不存在需要 fail-closed 的 Host 冲突或未分类不确定状态。

启动阶段只提供最小只读 health/status surface，返回明确 readiness：

- `host-starting`：安全启动检查尚未完成；
- `host-recovery-required`：Host 已取得 authority，但存在必须显式恢复的 Task/Effect/Parent；
- `host-ready`：可以接受当前状态允许的命令；
- `host-blocked`：active Host 冲突、schema/数据库故障或一致性问题使服务不能进入 ready。

只读接口只能读取已经安全打开的状态和结构化 blocker，不触发 lazy migration、lease takeover、Policy reload、adapter 查询或 effect。若数据库尚无法安全读取，只返回 Host 级 blocker，不伪造“没有 active workflow”。

Workflow tool 的 mutation 调用在非 ready 状态必须返回稳定 Host readiness denial，不排队等待后台恢复，也不在恢复完成后自动重放。Role Actor turn 和 effect worker 不能早于 readiness gate 启动。

`host-recovery-required` 不等于所有 mutation 都开放：只允许固定恢复流程明确列出的 Host/Manager recovery command；普通 workflow transition 和新 Parent 创建仍被拒绝。具体恢复 action 名称在 tool/action contract 中冻结。

readiness 是 Host 运行状态，不进入 Workflow Policy，不因页面刷新或 Manager prompt 改变。

## 24. 已确认：Ledger 不一致时 Fail Closed，禁止自动修复

启动一致性检查发现以下任一情况时，Host 进入 `host-blocked`，稳定原因 `ledger-inconsistent`：

- Parent 当前 revision 与最高/连续 Workflow Event revision 不一致；
- 成功领域 mutation 缺少对应 Event 或 Command Receipt；
- Receipt 指向不存在或不匹配的 Parent/Event/Effect；
- 同一 Product Workspace 出现多个 Active Parent；
- 同一 Parent 出现多个未决 Effect Intent；
- lease current record 与 fencing/Lease Audit 基本关系矛盾；
- 外键、唯一约束、枚举、必需 hash/identity 或状态关系被破坏；
- Parent/Child/Gate/evidence/Actor/delivery 当前状态组合不可能由固定 Workflow Definition 产生；
- SQLite integrity check、读取或事务语义不能得到可信结果。

阻塞后：

- 仅开放安全只读 Host 诊断；
- 不运行 Policy reload、Task dispatch、lease takeover、Effect Outbox、reconciliation 或 adapter mutation；
- 不创建新 Parent；
- 不自动 replay Workflow Event；
- 不补行、删行、覆盖 revision、选择“看起来较新”的一侧或重算业务状态；
- 不允许 Agent、Manager tool、Web UI 或 Policy 执行任意 SQL/repair/force-unblock。

这与“当前状态表权威、Workflow Event 只作追加审计而非完整 Event Sourcing”保持一致。现有事件 payload 和历史版本不承诺足以无损重建全部当前状态，因此 replay 不是安全恢复路径。

首期恢复来源只有：

1. 经完整性和版本校验的已验证 SQLite 备份；或
2. 未来单独设计、默认离线、具有明确问题类型与前后校验的专用运维工具。

专用工具不得作为插件正常运行时的通用 override；每种 repair 必须有固定输入、备份前置、dry-run 诊断、审计输出和恢复后全量一致性检查。该工具尚未设计前，`ledger-inconsistent` 只能通过恢复已验证备份或人工保全现场后重建工作环境处理。

`host-blocked` 是 Host readiness，不等于把某个 Parent 自动标记 `abandoned`、`failed` 或 `completed`。数据库不可信时 Host 不写入新的 Parent 终态来假装已处理故障。

## 25. 已确认：DSH Home 下每个 Product Workspace 独立 SQLite

首期每个 Product Workspace 使用一个独立 SQLite Ledger 文件，固定放在共享 DSH Home 的插件私有数据目录：

```text
<DSH_HOME>/workflow-plugin/workspaces/<workspaceStorageKey>/ledger.sqlite3
```

`workspaceStorageKey` 的精确算法下一项冻结。目录名、文件名和路径版本由 Host 固定，不属于 Workflow Policy Profile。

该布局意味着：

- Ledger 不进入 umbrella repo 或任何 Catalog Repository；
- 不写入 workspace 的 `.dsh`、`.git`、artifacts directory 或 Manager-owned path；
- 同一 checkout 从不同 DSH profile 启动时解析到同一 Workspace Ledger；
- 不同 Product Workspace 的 schema、Active Parent、Host Boot、lease、Effect Outbox、损坏和备份相互隔离；
- 一个 Host 进程可以按需管理多个 Workspace Ledger，但每个 Ledger 独立执行 active-boot authority 检查；
- 某一 Workspace Ledger `host-blocked` 不自动阻塞其他 Workspace Ledger。

Policy、Agent、Manager tool、环境中的任意 workspace 配置和 Web UI 均不得提供数据库绝对路径、相对路径、文件名、DSH profile override 或 connection string。Host 只通过受支持的 DSH Home path service/contract 和固定目录结构解析。

DSH Home 本身是 Host 启动环境事实，不进入 Policy hash。若 DSH Home 不可确定、目录权限不安全、路径位于不受支持的远程/网络文件系统，或私有目录无法创建并验证，Environment Preflight/Host startup fail closed。

选择每 Workspace 一库而非全局总库，使单 Host Boot authority 的边界与实际 Workspace effect 范围一致，也避免一个损坏数据库冻结所有产品工作区。跨 Workspace 查询未来由只读聚合服务实现，不把多个 Ledger 合并成一个事务域。

SQLite 文件及 WAL/SHM/备份文件必须处于同一 Host 私有目录边界，并被文件 sandbox、日志与导出功能视为敏感运行数据；Agent 普通文件工具不可读写。

## 26. 已确认：Workspace Storage Identity 使用 Canonical Real Path Hash

首期 Workspace Ledger 目录键固定为：

```text
workspaceStorageKey = lowercaseHex(
  SHA-256(utf8("workflow-workspace/v1\0" + canonicalWorkspaceRoot))
)
```

`canonicalWorkspaceRoot` 由 Host 对 Manager `SessionHeader.cwd` 执行固定路径规范化得到：

- 必须是已存在且可读取的绝对目录；
- 解析 `.`、`..`、symlink 和 junction/reparse point，使用最终 real path；
- 统一平台分隔符与 root 表示；
- 在 Windows 上按 Host 固定规则规范 drive/UNC 与大小写等价形式，确保同一实际目录不会因字符串大小写产生不同 key；
- 不接受 Agent/Policy 提供的“canonical path”；
- 无法可靠解析或路径身份在解析期间发生变化时 fail closed。

目录名只使用 hash，不暴露绝对路径。Ledger 内部 Workspace record 仍保存受控的 canonical root、storage-key algorithm version 和已验证 umbrella repository identity，用于打开时交叉检查。

### 26.1 同一路径被替换

如果同一 canonical path 当前解析出的 umbrella repo、Git metadata 或 Resolved Repository Identity 与 Ledger 已绑定身份不同，Host 进入 `host-blocked(workspace-identity-mismatch)`；不得自动清空旧 Ledger、重绑到新 repo 或把旧 Active Parent 套用到新内容。

普通 remote URL 表示变化只有在既有 Repository identity 规则确认等价时才可继续；不能只比较未经规范化的 URL 文本。

### 26.2 Checkout 移动或改名

checkout 移动、父目录改名或 canonical real path 变化后，首期视为新的 Product Workspace storage scope，并解析到新的 Ledger 目录。Host 不搜索、复制、移动或自动复用旧 Ledger。

若要让旧 Active Parent 在新路径继续，必须将 checkout 恢复到原 canonical path，或等待未来专用离线 Workspace relocation 工具。该工具必须同时验证旧/新路径、repo identity、无活 Host、数据库备份和移动后的完整性；当前未设计前不得手工改 Workspace path 字段冒充迁移。

同一个 remote 的两个不同本地 clone 具有不同 Workspace Storage Identity，因为它们的工作树、分支、未提交现场和 Host authority 不同。远端仍通过 branch protection、SHA preflight 和 baseline drift 检查防止相互静默覆盖；跨 clone/跨机器的全局调度不属于首期 Ledger 保证。

## 27. 已确认修订：不做 DB Migration，允许直接人类重置 Ledger Generation

首期不实现 SQLite schema migration，也不尝试把旧版本记录转换到新 schema。Host 只读写当前精确 Ledger schema version。

打开现有 Workspace Ledger 时若 schema version 与当前 Host 不同：

1. Host 进入 `host-blocked(ledger-schema-incompatible)`；
2. 不自动迁移、导出转换、replay Event、创建空库或继续运行；
3. 只提供安全只读诊断和一个固定的 destructive Ledger Generation Reset 候选；
4. 即使旧库包含 Active Parent，也允许直接人类选择 reset；这是对“只有 completed/abandoned 才释放 Active Parent”的显式、受限例外。

### 27.1 权限与前置条件

Ledger Generation Reset 必须由直接人类显式确认，不能由 Manager LLM、Role Actor、Policy、后台 worker、Web 自动操作或版本升级脚本触发。具体 HITL 认证入口后续在 tool/UI authorization contract 中冻结，至少必须：

- 明确显示这是不可恢复的 Workflow 连续性丢弃，不是 migration；
- 显示 Workspace identity、旧 schema version、旧 Ledger hash 和可读取的 Active Parent/未决 Effect 摘要；
- 要求人类确认旧 Workflow 可能已修改本地/远端资源；
- 确认旧 Host 进程不再存活，且 Agent loop、Role Actor turn 和内部 background work 已停止；
- 不接受 Agent 代填确认、通用 approval 或 Policy flag。

### 27.2 归档与新 Generation

确认后 Host 必须先：

1. 保全旧 `ledger.sqlite3` 及其 WAL/SHM 所需的一致快照；
2. 计算 archive bundle 的 cryptographic hash；
3. 将其移动到同一 Workspace 私有目录中的只读 generation archive，不能删除或覆盖；
4. 创建全新的当前 schema Ledger；
5. 在新 Ledger 的第一个 Host 级记录中写入 `ledger-generation-reset` manifest，包含旧 generation/schema/hash/archive reference、直接人类确认 reference、时间，以及在安全旧版本 reader 能解析时得到的 Active Parent/未决 Effect/Lease/Outbox 结构化摘要。

若旧 schema 无受支持 reader，Host 不猜测旧表内容；manifest 明确记录 `oldContentsSummary=unavailable`，但仍允许直接人类按已确认的破坏性语义 reset。

archive 或 hash 任一步失败时不得创建/启用新 Ledger。新 Ledger 创建后也必须通过当前 schema、integrity 和初始不变量检查，才能成为 active generation。

### 27.3 被丢弃 Parent 的语义

旧 Ledger 中的 Parent 不会被伪造为 `completed`、`failed` 或 `abandoned`，因为当前 Host 没有在旧 schema 中提交可信 Parent transition。它们保留在 archived generation，运行连续性被 Host 级 Ledger Generation Reset 截断。

reset 后：

- 旧 Parent、Child、Gate、evidence、Command Receipt、Role Actor mapping、lease 与 Effect Intent 均不得自动导入或复用；
- Host 不自动清理、回滚、提交、关闭、删除或修复任何旧本地/远端产物；
- 新 Parent 从当前真实 workspace/remote baseline 重新执行完整启动 preflight；
- 旧 effect 是否已经发生只能由人类/未来离线取证处理，新 Ledger 不自动 reconciliation；
- 当前 generation 重新适用“每 Workspace 最多一个 Active Parent”。

这是一个有意接受重复 effect、远端残留、审计跨 generation 不连续和旧 Active Parent 未进入终态风险的破坏性运维能力。它只解决用户明确选择的“版本不符时丢弃旧库并创建空库”，不得扩展为普通 recovery、Policy change、workspace identity mismatch、ledger inconsistency 或业务失败的通用 reset/override。

### 27.4 与先前决策的关系

本节仅修订以下一条：数据库 schema 不兼容时，直接人类可以通过 Ledger Generation Reset 在旧 Parent 未 completed/abandoned 的情况下结束当前 Ledger generation 并创建新 generation。

它不改变正常兼容 schema 下的单一 Active Parent、Parent 状态机、abandoned 原因、no-cleanup、Command/Effect 幂等、fencing 或 fail-closed 规则。`ledger-inconsistent` 也不能使用本 reset，除非未来另行明确修订；schema version 必须可可靠读取并确认“不兼容”才开放该入口。

## 28. 已确认：Generation Archive 由插件永久只读保留

每次 Ledger Generation Reset 产生独立 archive，不得覆盖上一代。archive identity 至少包含 generation ID、旧 schema version、创建时间和 cryptographic content/bundle hash；目录/manifest 使用固定 Host 格式。

首期插件：

- 不自动删除任何 generation archive；
- 不按数量、时间或磁盘水位轮转；
- 不压缩后删原件、不重写旧 archive、不进行 in-place schema upgrade；
- 不把 archive 重新激活为当前 Ledger；
- 不提供 Agent/Manager tool/Web delete、restore、edit、export raw DB 或 arbitrary path download；
- 不把 archive 内容自动导入新 generation；
- 只在只读运维视图显示 generation ID、schema version、hash、大小、时间、reset confirmation reference 和安全摘要。

archive 及其 manifest 位于对应 Workspace 的 DSH Home 私有目录，继承与当前 Ledger 相同的文件权限、sandbox 和敏感数据边界。读取旧业务内容需要与该旧 schema 明确兼容的未来离线工具；当前 Host 不猜测解析。

若管理员因磁盘、法规或安全要求必须删除 archive，只能在相关 Host 完全停止后，于插件外执行离线操作并自行承担取证丢失风险。插件不会把外部删除视为成功 cleanup；下次启动若新 generation reset manifest 引用的 archive 缺失或 hash 不符，应报告结构化 archive integrity warning/blocker，具体严重级别在运维设计中冻结。

“永久保留”是插件行为保证，不声称能阻止拥有操作系统权限的管理员删除文件，也不是远程备份。generation archive 与当前 schema 下的常规可恢复 backup 是两类不同产物：archive 保留被主动丢弃的旧 generation，backup 用于恢复当前 generation 的损坏或误删。

## 29. 已确认：每次 Parent 领域提交后设置 Backup Barrier

当前 Ledger Generation 的每个成功 Parent 领域 mutation 在 SQLite 主事务提交后，必须创建一个一致的 SQLite online backup，并完成备份校验。Host 只有在该 committed revision 的 backup barrier 满足后，才允许该 Parent 的下一次 mutation、Task execution 或 Effect execution 继续。

固定顺序：

1. 提交 Parent mutation，产生新 revision、Workflow Event、Command Receipt 和可选 Effect Intent；
2. 主事务一旦成功，该 mutation 已经是权威事实，不能因后续 backup 失败而回滚、伪装失败或重新执行 command；
3. 使用 SQLite 支持的一致性 online backup/snapshot 机制写入 staging backup，不能直接复制活跃 WAL 数据库的单个主文件；
4. 对 staging backup 校验 SQLite integrity、schema version、Workspace identity、最新 Parent revision 以及 Event/Receipt 基本对应关系；
5. 生成包含 generation ID、schema version、workspaceStorageKey、covered revision、时间、文件 hash 的 backup manifest；
6. 仅在全部校验成功后原子发布为 verified backup，并满足该 revision 的 barrier；
7. staging/校验/发布失败时保留当前主库和上一份 verified backup，Host 进入 `host-recovery-required(backup-barrier-unsatisfied)`，停止后续推进。

backup failure 不能把已提交 command 返回为“未发生”。若原调用方尚未收到响应，重复同一 Command ID 时仍从主库 Receipt 返回原 committed outcome，并同时报告 backup blocker。Host 不创建补偿 Event 或降低 Parent revision。

backup barrier 是 Host durability readiness，不是 Workflow Gate、Policy 参数或 Role Actor evidence。Agent、Policy 和普通工具不能跳过、acknowledge、延迟或选择 backup 路径。

只读查询可以在 backup blocker 期间继续；允许的恢复动作仅包括 Host 重试生成同一当前 revision 的 verified backup，不能先推进新 revision 再补旧 backup。

每个 Workspace 独立执行 backup barrier。一个 Workspace backup 失败不冻结其他 Workspace Ledger。

## 30. 已确认：外部 Effect 调用前必须备份 `executionStarted`

Effect worker 第一次或恢复后准备调用外部 adapter 时，必须按以下顺序：

1. 持有当前 `effect-execution` lease owner/fencing token；
2. 在独立运维事务中将 `executionStarted=true`，增加 `attemptCount`，更新安全的 last-attempt 元数据；
3. 提交后为当前 Ledger 创建并验证新的 backup barrier；
4. backup manifest 除最新 Parent revision 外，还必须覆盖当前 Effect ID、`executionStarted=true`、`attemptCount` 和一个单调的 effect operational sequence/checkpoint；
5. barrier 成功后再次校验 active Host Boot、lease owner/token、Effect ID 和当前 effect 状态；
6. 最后才调用外部 adapter。

若步骤 2 已提交但 backup 失败：

- 不调用外部 adapter；
- 保持 Effect Intent 未决；
- Host 进入 `host-recovery-required(backup-barrier-unsatisfied)`；
- 重试只重新生成覆盖当前状态的 backup，不把 `executionStarted` 改回 false，也不创建新 Effect ID；
- 由于持久状态已进入“可能开始”类别，后续 Host 即使无法证明 adapter 未被调用，也优先采用 reconciliation 安全路径。

此处允许保守假阳性：进程可能在持久化/备份 `executionStarted=true` 后、真正调用 adapter 前崩溃。恢复时多做一次 reconciliation 比把已发生 effect 错当成未发生安全。

调用 adapter 后不要求在返回前先写逐次 Attempt 记录，因为首期已明确不建立 Attempt entity。确定 outcome 通过正常 Parent mutation提交，并触发第 29 节的领域 backup barrier；未知 outcome 更新 effect 运行状态并保持 reconciliation 路径，具体 checkpoint/backup 规则在 Effect Outbox 状态机中继续冻结。

因此 verified backup 可以覆盖同一个 Parent revision 的不同关键运维 checkpoint。backup identity 不能只用 Parent revision，必须另有单调 backup/checkpoint sequence。

## 31. 已确认：当前 Generation 只保留最近两份 Verified Backup

每个当前 Ledger Generation 固定维护：

- `latest`：最新成功发布的 verified backup；
- `previous`：`latest` 发布前的上一份 verified backup；
- `staging`：当前正在生成且尚未取得 verified 身份的临时副本。

每份 backup 由 SQLite snapshot 文件和不可分离的 manifest 构成，manifest 绑定 generation ID、schema version、Workspace Storage Identity、backup/checkpoint sequence、covered Parent revisions、关键未决 Effect checkpoint、创建 Host Boot、时间和 cryptographic hash。

原子轮换规则：

1. 只写新的 staging，不原地修改 `latest` 或 `previous`；
2. staging 完成 SQLite/invariant/hash 校验后才可成为 verified；
3. 发布时先确保原 `latest` 可作为新 `previous` 保留，再把 staging 原子发布为新 `latest`；
4. 文件系统不支持所需同目录原子 rename/replace 语义时，Host startup/preflight fail closed；
5. 轮换任一步失败时保留原 `latest`/`previous` 不变，staging 没有恢复资格；
6. 新 `latest` 成功发布并重新读取验证后，插件可以自动删除比新 `previous` 更老的普通 verified backup；
7. staging 残留在下次启动时只作为临时垃圾诊断/清理候选，绝不能因文件较新就自动恢复。

首个 verified backup 尚无上一代时，`previous` 可以不存在；在第二份成功发布后必须同时存在 latest/previous。一般流程不伪造 duplicate previous 来满足数量；第 48 节终态 Parent purge 为移除含旧 Parent 的两份副本，允许对同一 post-purge checkpoint 独立生成 latest/previous 作为明确维护例外。

常规 backup 的“两份轮转”只作用于当前 generation。第 28 节永久只读 generation archive 不参与轮换，不能被当作 previous 删除。

Agent、Policy、Workflow tool 和普通 Web 操作不能改变保留数量、选择 backup 路径、把 staging 标记 verified 或阻止安全轮换。磁盘空间不足导致 backup barrier 失败时，Host 停止推进并报告结构化 blocker，不自动删除 generation archive 腾空间。

## 32. 已确认：Backup Restore 必须由直接人类受控执行

当前 Ledger 文件缺失、损坏或无法通过一致性检查时，Host 不自动选择/覆盖 backup。只有直接人类可以在只读 `host-blocked` 运维入口中选择当前 generation 的已验证 `latest` 或 `previous` 执行 restore。

### 32.1 Restore 前置

Host 必须：

- 确认没有其他活 Host；
- 停止并确认当前 Agent loop、Role Actor turn、effect worker 和内部 background work；
- 重新验证所选 backup 文件与 manifest hash、schema version、generation ID、Workspace Storage Identity 和 SQLite/invariant 完整性；
- 展示 backup covered revisions/checkpoint、与故障当前文件可读取状态的差异摘要，以及可能落后于本地/远端事实的风险；
- 获取直接人类对明确 backup identity 的确认，Agent 不能代为确认或改变选择。

### 32.2 保全与切换

执行时先把当前故障 DB、WAL/SHM 和可用诊断信息保全为独立只读 incident archive；当前文件不存在时记录 missing，不伪造 archive。随后：

1. 从所选 verified backup 恢复到新的 staging current DB；
2. 再次完整校验；
3. 使用同目录原子切换发布为 current；
4. 创建新的 Host Boot Epoch；
5. 在恢复后的 Ledger 追加独立 Host restore audit，绑定 incident archive、backup identity/hash、直接人类 confirmation 和 restore time；
6. restore audit 是 Host 运维事实，不推进 Parent revision或伪造 Workflow Event；
7. 为恢复后的 current DB 重新满足 backup barrier，才能进入 recovery service。

任一步失败不得删除 incident archive、原 current 或 verified backups，也不得开放 mutation/effect。

### 32.3 Restore 后强制恢复

Restore 不代表 Workflow 可以从备份状态直接继续。Host 必须：

- 将备份中所有非当前 Boot 的未释放 lease 视为 orphaned，并写 Lease Audit；
- 所有未完成 Workflow Task 进入第 20 节的显式 Task recovery，确认旧 turn 停止并检查工作树/远端现场；
- 所有未决 Effect Intent 无论 backup 中 `executionStarted` 为 true 或 false，均先执行 reconciliation；因为较新但损坏的主库可能已经越过 backup checkpoint；
- 重新加载当前 Policy 并按现有 schemaVersion/continuity/reloadable 规则分类，restore 不回滚 Policy source；
- 重新执行受恢复 checkpoint 影响的 Environment Preflight、Git/GitHub SHA、candidate manifest、Gate/evidence validity 与外部 delivery 状态检查；
- 发现备份状态落后于外部事实时，使用固定 recovery/reconciliation 路由，不改写历史假装一致；
- 在恢复分类完成前保持只读 `host-recovery-required`。

Restore 保持同一 Ledger Generation，不导入其他 generation archive，也不允许跨 Workspace、跨 generation 或跨 schema 选择 backup。它不清理任何外部产物，不能作为撤销 workflow mutation、回滚 GitHub merge 或绕过 Gate 的普通操作。

incident archive 的 retention 与访问按后续敏感运维数据规则冻结；它不参与 latest/previous 普通 backup 轮换。

## 33. 已确认：Ledger 实体使用 Typed Prefix + UUIDv4

Host 创建的独立 Ledger 实体统一使用：

```text
<prefix>_<lowercase canonical UUIDv4>
```

示例：

- Workspace ID：`ws_<uuid>`；
- Parent ID：`par_<uuid>`；
- Child ID：`chd_<uuid>`；
- Workflow Task ID：`tsk_<uuid>`；
- Effect ID：`eff_<uuid>`；
- Workflow Event ID：`evt_<uuid>`；
- Ledger Generation ID：`gen_<uuid>`；
- Host Boot ID：`boot_<uuid>`；
- backup ID：`bkp_<uuid>`；
- 各类独立 audit/attempt ID 使用 schema 固定的不同 prefix。

UUID 使用 Node 运行时的 cryptographically secure UUIDv4 生成能力，采用 RFC canonical `8-4-4-4-12` 小写文本。Host 对输入/读取执行严格格式校验，不接受大写别名、无连字符形式、非 v4 UUID、前后空白或错误实体 prefix。

ID 只表达实体类型和随机身份，不编码：

- 时间或排序；
- milestone/issue/repository/branch；
- role/Actor/provider；
- Parent revision、schema version 或状态；
- Workspace path/hash；
- credential 或用户信息。

排序和因果关系分别使用 Parent revision、固定 sequence、backup/checkpoint sequence、事件时间和显式外键，不依赖 UUID 字典序。

所有 UUID 实体 ID 由 Host 生成。Agent、Policy、adapter 和普通 tool 参数不得指定新实体 ID；查询/后续 action 可以引用 Host 已返回且 Host 授权范围内的现有 ID，但引用 ID 不构成 authority。

以下不是 UUID 实体 ID，保留其已确认来源：

- `workspaceStorageKey`：canonical Workspace Root 的 versioned SHA-256；
- Command ID：可信调用边界派生的幂等身份；
- repositoryKey：Policy Catalog key，首期等于 `.gitmodules` submodule name；
- Parent revision、fencing token、sequence：各自作用域内的单调整数；
- Git/GitHub node/SHA/URL：经 adapter 验证的外部 identity/reference。

prefix 完整注册表在数据库 schema 设计时冻结；同一 prefix 不能跨实体复用，未来更名不静默接受旧/新双格式。

## 34. 已确认：每种 Effect Type 必须有固定幂等与对账契约

首期 Effect Catalog 是固定 Workflow Definition/Host 代码中的闭集，不由 Policy 或 Agent扩展。每种 effect type 在进入 catalog 前必须定义并通过 contract tests 验证：

1. **Intent schema**：允许的确定参数、Resolved Repository Identity、目标资源与 expected remote facts；
2. **authorization**：哪类 Host/Actor 触发路径可以创建该 intent；
3. **fresh preflight**：外部调用前必须重新验证的 branch/SHA/state/permission/ruleset；
4. **provider idempotency**：外部 API 是否支持 idempotency key，支持时 Effect ID 如何传递以及 provider 保留/作用域语义；
5. **reconciliation identity**：不支持 idempotency key 时，使用哪些经验证 remote ID、URL、branch、SHA、marker 或唯一业务关系定位同一个逻辑 effect；
6. **confirmed-applied 判据**：哪些实时外部事实足以证明 intent 已准确发生；
7. **confirmed-not-applied 判据**：哪些事实足以证明尚未发生，可以安全使用同一 Effect ID 执行；
8. **confirmed-failed 判据**：哪些终局失败可确定提交；
9. **indeterminate 处理**：权限、网络、rate limit、模糊匹配或响应缺失时如何保持 recovery；
10. **重复与冲突处理**：发现多个候选 remote object、目标已被其他操作者以不同参数改变、expected SHA 漂移时如何 fail closed；
11. **result verification**：调用返回后如何重新读取权威事实，而不是信任响应文本；
12. **sensitive-data boundary**：哪些请求/响应字段禁止进入 Ledger/log。

Effect ID 始终是本地逻辑身份，不自动成为外部自然键。若 provider 不支持 idempotency key，又无法定义确定性 reconciliation identity 和 applied/not-applied 判据，该 effect type 首期不支持。Host 在 Static catalog validation/启动自检中拒绝注册不完整 contract，在运行时返回稳定 unsupported/unsafe-effect blocker，不能“尽力调用”。

create、update、merge、delete、comment、label、Gitlink 或本地 Git 操作不能只因都属于外部 mutation 就共享一套模糊重试器。每种具体 effect contract 明确哪些错误可 retry、哪些必须 reconcile、哪些进入运维阻塞。

Policy 只能提供已冻结配置槽位中的目标规则；它不能选择 retry strategy、natural key、provider endpoint 或 applied 判据。Agent 也不能通过 effect 参数改变 contract。

具体首期 Effect Catalog 清单与逐项 contract 将在 Git/GitHub adapter/tool-action 专项中冻结；在该清单完成前，本节只确定准入标准，不假设任何高风险 effect 已可执行。

## 35. 已确认：Evidence Observation 不可变，Gate Projection 可变

每次 Host 通过固定 adapter/runner 对证据来源完成验证后，创建一个新的不可变 Evidence Observation，并分配新的 typed UUIDv4 evidence ID。即使验证的是同一个远端 PR、Review、check run 或测试对象，重新验证也创建新 observation，不覆盖旧记录。

Evidence Observation 至少按 evidence type 绑定：

- evidence ID 与固定 evidence type；
- `parentId`、可选 `childId`、目标 Gate/scope；
- Resolved Repository Identity 或 Workspace validation scope；
- remote object/node/URL 等经严格解析的稳定 reference；
- 绑定的 head SHA、base SHA、candidate manifest hash、测试定义 hash或其他固定 subject fingerprint；
- observed verdict/status；
- collector Actor/Host executor reference；
- verifiedAt 与 adapter/runner contract version；
- 安全的结构化 verification facts/summary；
- 创建它的 committed Parent revision/Event reference。

Evidence Observation 不保存 credential、完整 API live object、原始测试日志、persona/prompt 或未经筛选的 provider response。大型/敏感输出使用后续 evidence artifact/reference 规则，不直接塞入 Ledger JSON。

所属 Parent 保留期间，已提交 observation 不得 update/单独 delete，也不把旧 verdict 从 PASS 改为 FAIL。远端对象重新验证、Review 被 dismiss、check 状态变化、测试重跑或 candidate 改变时，创建新的 observation；旧记录保留当时事实。Parent 终态满 30 天后，全部 observations 随整聚合按第 48 节删除且不留 Tombstone。

当前 Gate 是否满足由独立可变 Gate/current satisfaction projection 表达。projection 至少绑定当前 subject fingerprint 和当前被采纳的 evidence ID；只有 evidence type/scope/verdict/fingerprint 与当前 Workflow Definition 要求完全匹配时才能 satisfied。

candidate SHA/manifest、Validation Definition hash、Gate scope 或其他绑定事实变化时，Host 将 Gate projection 变为 unsatisfied/stale，并清除 current accepted evidence reference；不删除或修改旧 observation。新 observation 通过后再使 projection 指向新的 evidence ID。

Gate projection 的变化是 Parent 领域 mutation，必须遵守 expected revision、Workflow Event、Command Receipt 和 backup barrier。纯读取不能静默改写 projection。

一个 Evidence Observation 可以被历史 Workflow Event 引用，但当前 Gate projection 不能同时把互相矛盾或不同 subject fingerprint 的 observations 合并成 PASS。聚合 Gate 的具体 evidence set/manifest 结构后续按固定 Gate 类型冻结。

## 36. 已确认：Evidence 使用原子 Observe-and-Evaluate 命令语义

需要 fresh evidence 的 transition/effect command 在进入 Parent mutation 前，由 Host 通过固定 adapter/runner 执行 revalidation。revalidation 结果分两类。

### 36.1 得到确定 Observation

若 Host 获得 contract 足以分类的确定事实，则在同一个 Parent mutation 事务中：

1. 再次校验原命令 `expectedParentRevision` 与当前状态；
2. 插入新的不可变 Evidence Observation；
3. 更新对应 Gate/current satisfaction projection；
4. 若新 evidence 满足全部前置条件，则可以同时提交原请求 transition 或创建 Effect Intent；
5. 若新 evidence 明确 FAIL/stale/not-satisfied，则不执行业务推进，但提交 Gate 失效/current blocker；
6. 产生一个新 Parent revision、一个 Workflow Event、一个 Command Receipt，并满足 backup barrier。

FAIL/stale 分支是“成功提交了新的权威失效事实”，不是无状态 denial。Command outcome 必须清晰表示：

- `committed=true`；
- 新 Parent revision；
- 新 Evidence ID；
- Gate/current status；
- 原请求 transition/effect 未执行；
- 稳定 blocker code。

调用方后续必须基于新 revision 和恢复后的 Gate 重新行动，不能自动重放原 transition。

### 36.2 无法得到确定 Observation

GitHub/provider/runner 不可达、权限不足、rate limit、响应不完整、对象匹配歧义或 contract 无法分类时：

- 不创建 Evidence Observation；
- 不修改 Gate projection；
- 不推进 Parent revision；
- 不执行 transition/effect；
- 记录独立 Command Attempt denial 与结构化 environment/verification blocker。

“无法验证”不能被写成 FAIL evidence，也不能继续依赖旧 satisfied projection执行关键操作。旧 projection 可以保留其最后一次已提交状态用于历史展示，但调用结果明确 `freshVerification=unavailable`，需要 fresh evidence 的动作 fail closed。

### 36.3 并发与 TOCTOU

adapter revalidation 在 SQLite 事务外执行，期间 Parent 可能变化。因此提交时 expected revision CAS 失败则整个 observation/transition 不写入，返回 stale revision；调用方重新读取后再次验证。Host 不把在旧 revision 上采集的 observation自动套用到新状态。

对不可逆外部 effect，即使 observe-and-evaluate 已在 intent creation 前验证 PASS，effect worker仍须按 Effect Catalog 在实际调用前执行 fresh preflight，防止事务提交后到外部调用前的远端漂移。

## 37. 已确认：Effect Intent 与 Transactional Outbox 合并为一条记录

首期不建立独立通用 `outbox`/message 表。一个 Effect record 同时承担：

- 不可变 Effect Intent；
- transactional outbox 待执行记录；
- 当前 claim/lease 关联；
- 最小 mutable execution metadata；
- reconciliation 当前状态；
- 最终 verified outcome reference。

创建外部 effect 的 Parent mutation 在同一事务插入唯一 Effect record、更新 Parent 内部 pending-effect 阶段、追加 Workflow Event/Command Receipt 并推进 revision。事务提交前 worker 不可见；事务提交和 backup barrier 满足后，effect worker 按固定状态索引扫描/领取，因此仍满足 transactional outbox 的 crash-safe intent-before-effect 原则。

Effect record 的 intent 部分提交后不可修改，包括 effect type、Parent/触发 revision、已解析目标、确定参数、expected remote facts 和 Effect Catalog contract version。执行状态、lease reference、`executionStarted`、`attemptCount`、最近安全错误分类、reconciliation classification 和 outcome reference 是受固定状态机约束的 mutable columns；Host 不提供任意 patch。

数据库必须约束：

- 每个 Effect ID 只有一行；
- 每个 Parent 最多一条未决 Effect record；
- Effect record 必须引用创建它的 Parent revision/Event/Command Receipt；
- final outcome 只能引用后续已提交的 Parent revision/Event；
- intent immutable columns 不可被 update path 修改；
- worker 扫描只使用固定执行状态和 readiness/backup barrier，不执行任意消息类型。

统一记录不意味着 Effect 本身成为 Parent Event Sourcing；Parent 当前状态、Workflow Event、Receipt 和 Effect 各自保留明确职责。Effect record 也不是通用异步消息总线，不能承载邮件、任意 webhook、Agent 自定义 job 或与固定 Effect Catalog 无关的 payload。

未来若出现与 Workflow Effect 不同生命周期的可靠消息需求，再单独证明通用 outbox 的必要性；首期不为假想复用提前分表。

## 38. 已确认：Effect Outbox 使用六状态闭集

Effect record 的 `executionState` 只能是：

```text
pending | executing | reconciling | blocked | applied | failed
```

其中：

- `pending`：intent 已提交且等待 fresh preflight/执行；
- `executing`：已持久化 `executionStarted=true` 并满足调用前 backup barrier，当前调用可能发生；
- `reconciling`：effect 可能已发生但没有确定 outcome，只能先对账；
- `blocked`：存在已知环境/权限/配置 blocker，当前不能安全执行或对账；
- `applied`：已验证 intent 对应 effect 准确发生，终态；
- `failed`：已验证固定 contract 定义的终局失败，终态。

`pending|executing|reconciling|blocked` 都是未决状态，继续占用 Parent 的单一未决 Effect 名额。只有 `applied|failed` 解决该 Effect Intent。

### 38.1 Lease 正交

`claimed`、owner、Host Boot 和 fencing token 不属于 Effect executionState，全部保存在 `effect-execution` lease current/audit。获取或释放 lease 不改变六状态，也不推进 Parent revision。

### 38.2 固定转换

允许的基本转换：

```text
pending      -> executing       # executionStarted + 调用前 backup barrier
pending      -> blocked         # fresh preflight 明确阻塞
blocked      -> pending         # blocker 修复并重新验证
executing    -> applied         # verified outcome，Parent mutation
executing    -> failed          # verified terminal failure，Parent mutation
executing    -> reconciling     # timeout/断线/未知 outcome
reconciling  -> applied         # confirmed-applied，Parent mutation
reconciling  -> failed          # confirmed-failed，Parent mutation
reconciling  -> pending         # confirmed-not-applied，继续同一 Effect ID
reconciling  -> blocked         # 当前无法继续对账/执行的明确 blocker
blocked      -> reconciling     # executionStarted=true 的 blocker 修复后仍须先对账
```

状态机根据 `executionStarted` 限制恢复方向：曾进入执行窗口的 effect 不能仅因 blocker 修复就从 blocked 直接当作从未执行；只有 confirmed-not-applied 才能回 pending。

`applied` 和 `failed` 不允许离开。后续若 Workflow Definition 需要新的 corrective external action，必须在旧 effect 终态且 Parent 路由允许后创建新的 Effect ID；不得重开或改写终态记录。

### 38.3 不支持的状态/动作

首期没有通用：

- `claimed` effect state；
- `retrying` attempt state；
- `cancelled`、`skipped`、`ignored` 或 `force-completed`；
- Agent 自定义状态；
- 自动把长期 blocked/unknown 改成 failed；
- 通过修改 effect type/intent 参数“重用”原 Effect ID。

### 38.4 提交与 Backup

`applied|failed` 必须由 Parent 领域 mutation提交，关联新 Parent revision/Event/Receipt 并满足领域 backup barrier。`pending/executing/reconciling` 的纯执行 checkpoint 可以是独立运维事务；`blocked` 若同时使 Parent 进入/更新 Workflow Recovery，则与该 Parent mutation 原子提交。

进入 `executing` 必须遵守第 30 节调用前 backup barrier。进入 `reconciling` 后也必须在释放当前 effect lease 或开放其他恢复动作前生成覆盖未知 outcome 状态的 verified backup；backup 失败时保留 lease/Host recovery blocker，不把状态降回 executing/pending。

worker 每次扫描和转换都必须使用固定 state transition table、当前 Host readiness、当前 lease owner/token 和 Effect Catalog contract，不能根据错误 message 文本决定下一状态。

## 39. 已确认：每个 Workspace 一个 Ledger Worker Thread 与单 Connection

Host 为每个当前打开的 Workspace Ledger 创建一个专用 Ledger worker thread。该 worker 独占该 Workspace 当前 `ledger.sqlite3` 的一条 read-write SQLite connection，并负责：

- schema/integrity/invariant 检查；
- active Boot/lease 运维事务；
- Parent 领域 mutation；
- 只读状态查询；
- Effect execution metadata checkpoint；
- online backup、manifest 校验与轮换；
- Host audit/Command Attempt/Lease Audit 写入；
- clean close/checkpoint。

Host 主线程与其他插件只能通过固定 typed application commands 调用 worker。worker 内部将命令串行化并显式开启短 SQLite 事务；不接受 SQL 字符串、table/column 名、任意 query predicate、connection option 或 migration script 作为外部输入。

首期不建立 SQLite connection pool，也不为 Web 状态查询创建旁路 read connection。所有读写经同一 worker 保持确定顺序；只读查询返回其执行时的明确 observed revision/checkpoint，Host 不把旧结果当作新的 mutation 前置。

同步 SQLite API、integrity check、backup 和较大审计查询不得在 DSH/Cordis 主事件循环执行。worker response 使用受控 DTO，不传递 SQLite row/proxy、statement、connection 或异常对象。

外部 Git/GitHub/provider/test adapter 调用不得在 Ledger worker thread 或打开的数据库事务中执行。Host 流程固定为：

1. 向 worker 读取/提交必要 Ledger checkpoint；
2. 结束 SQLite transaction并取得 typed result；
3. 在 Host/adapter execution context 执行外部 I/O；
4. 再以新的 typed command 和 expected revision/lease token 提交结果。

一个 Host 进程可以同时拥有多个 Workspace Ledger workers；它们相互隔离。每个 worker仍受对应 Ledger 的 active Boot authority 和 readiness gate 约束。

worker thread 异常退出、消息协议错误、响应反序列化失败或 connection 意外关闭时，该 Workspace 立即停止 mutation/Task/effect，进入 Host recovery/blocker；主线程不能临时打开 SQLite 旁路继续。具体 worker restart 与 Boot Epoch 关系后续实现设计中冻结。

worker protocol 与 schema 同属 Host 版本契约，不进入 Workflow Policy。Agent/Role Actor 无法直接向 worker 发消息。

## 40. 已确认：SQLite 使用不可降级的 WAL + FULL 安全基线

每个 Ledger worker 打开 connection 时必须设置并验证：

- `PRAGMA journal_mode = WAL`；
- `PRAGMA synchronous = FULL`；
- `PRAGMA foreign_keys = ON`；
- `PRAGMA trusted_schema = OFF`；
- Host schema 使用 SQLite `STRICT` tables；
- 固定、版本化的短 `busy_timeout`；具体毫秒值在实现/兼容测试中冻结，不作为运行配置；
- 写事务使用固定 transaction helper 和明确的 `BEGIN IMMEDIATE`/commit/rollback 边界，不依赖隐式多 statement autocommit。

Host 不能只发送 PRAGMA 而假设成功；每次打开必须读取实际值并验证。WAL、FULL、foreign keys、trusted schema 或 STRICT 能力任一不受当前 SQLite/文件系统支持时，该 Workspace `host-blocked(storage-capability-unsupported)`，不能降级到 DELETE journal、NORMAL/OFF、关闭外键或非 STRICT schema。

`busy_timeout` 只吸收短暂文件系统/SQLite 锁竞争，不是通用 retry policy。超时后返回稳定 storage-busy blocker；Host 不无限循环，也不让 Policy/Agent 调整数值。按照单 worker/connection 和 active Boot 设计，持续 busy 通常表示外部进程、备份软件或异常连接干扰，必须 fail closed 调查。

所有外键关系、唯一约束、CHECK 约束、不可变字段 update guard 和状态枚举都必须由数据库约束与 application evaluator 双重保护，不能只依赖 TypeScript 类型。

WAL/SHM 与主 DB 必须位于同一固定私有目录。Environment Preflight/Host startup 必须拒绝无法证明 SQLite WAL/原子 rename/flush 语义的网络共享、远程挂载或不支持文件系统。Host 不允许通过 symlink/junction 把单个 DB/backup 文件重定向到目录边界外。

backup 使用 SQLite 一致性 snapshot/backup API，不把 WAL 文件字节拼接成副本。clean close 时 worker 执行固定 checkpoint/close 流程并验证返回；checkpoint 失败不伪造 clean Host Boot end。

其他安全 PRAGMA（例如 defensive/query-only read path、journal size limit）可以在实现时作为固定加强项加入，但不得削弱以上基线或变成 Policy/runtime 参数。任何会改变 durability/constraint 语义的基线变更必须与 Host/Ledger schema version 明确兼容。

## 41. 已确认：Ledger Worker Crash 只能通过新 Host Boot 恢复

Ledger worker thread 异常退出、未捕获异常、消息协议破坏、connection 非预期关闭或 worker 无法完成固定 shutdown 时：

1. 该 Workspace 立即撤销 `host-ready`；
2. Host 拒绝新的 Workflow mutation、Task dispatch、lease operation、Effect execution/reconciliation 和 backup；
3. 只保留不依赖故障 worker 读取数据库的最小 Host 级 blocker；若无法安全读取 Ledger，不返回缓存状态冒充最新；
4. Host 尝试停止/取消该 Workspace 当前 Role Actor turn、effect adapter I/O 和内部 background work；
5. 无法确认已停止时明确报告，不能在主线程或新 worker 中继续；
6. 同一 `hostBootId` 下禁止自动或人工重启 Ledger worker；
7. 禁止 Host 主线程、Web、其他插件或临时脚本直接打开 SQLite 旁路处理。

恢复要求完整 Host/plugin restart，创建新的 Host Boot Epoch。新 Boot 按既定规则：

- 校验 active boot 进程已终结；
- 将旧 boot lease 标记 orphaned；
- 执行 SQLite integrity/readiness；
- 对 Task 走显式 recovery；
- 对 Effect 按 executionStarted/reconciliation 恢复；
- 在 backup barrier 和一致性检查满足前只读。

即使 worker crash 后当前 Host 主进程仍活着，也不复用该 Boot Epoch，因为旧 Actor/adapter I/O 和 worker 消息是否已经执行可能不确定。通过新 Boot 统一提升 fencing token，比在同一 boot 内引入第二套 worker epoch 更确定。

其他 Workspace 的独立 Ledger worker 可以继续服务；故障是否要求整个 DSH 进程退出取决于插件生命周期能力，但故障 Workspace 的下一次可写服务必须属于新的 Boot Epoch，不能只是 spawn 一个 thread。

worker crash blocker 不是 Parent `failed`/`abandoned`，Host 在数据库不可用时不写伪终态。外部现场保留，由新 Boot recovery 处理。

## 42. 已确认：Evidence Artifact 使用 Workspace 私有 Content-addressed Store

SQLite Workflow Ledger 只保存 Evidence Observation 的结构化 metadata 和 artifact reference，不保存完整测试日志、review payload、诊断包、截图、二进制报告或其他大型 blob。

需要本地持久化的 Evidence Artifact 固定存放在同一 Workspace 的 DSH Home 私有数据边界，例如：

```text
<DSH_HOME>/workflow-plugin/workspaces/<workspaceStorageKey>/evidence/sha256/<prefix>/<digest>
```

精确分片目录由 Host 固定。artifact identity 使用对最终字节计算的 SHA-256；路径只由 Host 从 digest 构造，不接受 Agent/Policy/runner 提供任意文件路径或文件名。

Evidence Observation 对本地 artifact 至少记录：

- SHA-256 digest；
- byte size；
- 固定 media/artifact type；
- sanitizer/producer contract version；
- 创建时间和 producer Task/runner reference；
- artifact store generation/format version；
- 是否属于 Gate 必需证据内容。

artifact 写入后不可原地修改。同 digest 文件已存在时必须验证 size/hash，内容不匹配视为 store corruption，不能覆盖。相同字节可以跨 observations 去重，但引用同一个 blob 不代表 observations 或 Gate scope 相同。

Artifact store：

- 不位于 repository、Policy `artifacts.directory`、`.git` 或 Manager-owned path；
- Agent 普通文件工具、Role Actor 和 Web 客户端不能获取真实本地路径或任意读取；
- 只通过固定 Host evidence API 按授权返回安全 metadata、受控预览或下载；
- 不自动把 artifact 内容复制到 GitHub comment、Markdown、session export 或日志；
- 不保存 credential、环境 secrets、完整 prompt/persona 或未经筛选的 raw provider object；
- 每种 evidence type 的允许 media type、大小上限、结构化格式和 sanitization 在 Validation/GitHub adapter 专项固定，不进入 Policy 通用 runtime 参数。

外部永久证据（例如 GitHub PR/review/check URL）仍可只保存严格验证的 remote reference/hash，不要求下载成 artifact。Host 不把任意 URL 当作本地 artifact，也不代理未经 allowlist 的网络内容。

SQLite database snapshot 本身不内联 artifact bytes；但 latest/previous verified backup bundle 必须另外包含该 checkpoint 所有受保护 artifact 的独立内容副本，并在 manifest 列出 digest/size/type。restore 后重新验证并可从 bundle 恢复 artifact store。Ledger Generation archive 不自动打包全部 artifact；新 generation 不自动复用旧 Evidence Observation，即使相同 digest 文件仍存在。

本地 artifact 的 write-before-reference、缺失/corruption、备份和 retention 规则下一项继续冻结。

## 43. 已确认：Evidence Artifact 必须 Write Before Reference

Evidence producer 先完成 artifact durable publish，随后才能发起引用它的 Parent mutation。

固定顺序：

1. Host/runner 将允许的 sanitized bytes 写入 artifact store 内同文件系统的唯一 staging 文件；
2. 写入期间计算 size 与 SHA-256，完成后重新读取/校验最终 bytes；
3. fsync 文件，并按平台支持的固定流程保证目录元数据 durability；
4. 若目标 digest 已存在，验证现有文件 size/hash 完全相同后复用；不覆盖；
5. 若不存在，使用同目录原子 rename/link 语义发布到 content-addressed final path；
6. 再次验证 final path 没有 symlink/junction 逃逸且 digest/size 匹配；
7. 形成 Host 内部 typed Artifact Descriptor；
8. Parent mutation 提交 Evidence Observation 与 descriptor reference；
9. mutation 成功后按正常规则推进 revision/Event/Receipt 并满足 backup barrier。

Agent/runner 不能直接把本地路径、自己声称的 hash 或“上传成功”布尔值作为 Artifact Descriptor。Host 必须读取并验证 bytes。

若 artifact 发布失败，不创建 Evidence Observation，不更新 Gate，不推进 Parent revision；命令返回安全 artifact-storage blocker。若 artifact 已发布但 Parent mutation 因 stale revision、Gate 状态变化、DB 错误或进程崩溃失败，则产生无引用 content-addressed blob。该 blob：

- 不构成 Evidence；
- 不使任何 Gate satisfied；
- 不创建补偿 Workflow Event；
- 可以由后续固定 GC 在证明无引用且无 in-flight writer 后删除。

禁止先写 Evidence Observation/DB reference 再异步补 artifact。SQLite 与文件系统之间不实现通用 two-phase commit；write-before-reference 明确选择“可能有可回收孤儿 blob”，避免“权威 evidence 永久引用缺失文件”。

backup barrier 发布前必须验证该 Parent 当前 Gate/未决 workflow 新增引用的必需 artifact final path 仍存在且 hash 匹配。仅有 staging 文件不满足 barrier。

## 44. 已确认：Artifact 故障按当前引用作用域分级

Host 在 startup、backup barrier、restore recovery 和每次使用 Evidence 前验证所需 artifact 存在、不是 symlink/junction 逃逸、size/hash/type 与 Observation 一致。故障按以下范围处理。

### 44.1 当前必需 Artifact Missing/Unreadable

若当前 Gate satisfaction、未完成 Task、未决 Effect 的验证路径或本轮 Parent completion 条件依赖某 artifact，而该 artifact 缺失、不可读或无法验证：

- 通过 Parent mutation 将相关 Gate/current satisfaction 置为 stale/unsatisfied；
- 清除 current accepted evidence reference，但保留 Evidence Observation；
- Parent 进入/维持 `workflow-recovery(evidence-artifact-unavailable)`；
- 产生新 revision/Event/Receipt 并满足 backup barrier；
- 不把 missing 自动写成原 Evidence 的 FAIL，也不自动重跑测试/Review；
- 后续必须重新取得满足当前 subject fingerprint 的新 Evidence，或按固定 runner/adapter 恢复同一 artifact 内容并验证 hash。

如果数据库当前不可写或 backup barrier 无法满足，则 Host 先只读阻塞，不能在内存中假装 Gate 已失效后继续其他 mutation。

### 44.2 Historical-only Artifact Missing

若 artifact 仅被历史 Evidence Observation/旧 Event引用，且不参与任何当前 Gate、Task、Effect、Active Parent completion 或当前 backup manifest：

- 不改变 Parent revision或当前 Gate；
- 记录结构化 artifact-integrity warning；
- UI 标记历史材料不可用；
- 不静默删除 Observation/reference；
- 不因单个历史缺件冻结无关当前 Workflow。

这不表示删除是允许的；generation archive/取证完整性仍已受损。

### 44.3 Artifact Store Corruption

以下情况破坏 content-addressed store 基本不变量：

- final digest path 的实际 bytes hash/size 与路径或 metadata 不同；
- 同 digest 出现冲突内容；
- final/staging path 通过 symlink、junction、hardlink/reparse 行为逃逸私有目录或出现不支持的链接语义；
- store layout/version 被未知写入者修改；
- Host 无法信任路径包含或原子发布语义。

此时整个 Workspace 进入 `host-blocked(artifact-store-corrupt)`：禁止 Evidence mutation、backup 发布、Task outcome、Effect execution/reconciliation 和新 Parent。只读诊断保留；Host 不覆盖冲突文件、不按文件名猜正确内容、不从旧 Observation 自动重建。

恢复只能使用已验证 artifact 备份/外部永久来源或未来专用离线修复工具，并在恢复后对当前/历史引用执行全量 hash 检查。Agent、Policy 和普通 Web 操作没有 ignore/repair/force-pass。

## 45. 已确认修订：非受保护 Final Artifact 固定保留 30 天

首期 finalized Evidence Artifact 不再永久保留。Host 可以在 artifact `publishedAt` 满 30 × 24 小时后删除，但只有同时满足以下全部条件：

- 不被任何 Active Parent 的任何 Evidence Observation 引用；
- 不被当前 Gate satisfaction/current evidence 引用；
- 不被未完成 Workflow Task、未决 Effect 或当前 recovery scope 引用；
- 不被 current Ledger、latest verified backup 或 previous verified backup manifest 列为必需 artifact；
- 不存在 in-flight artifact writer/staging publish；
- final path、digest 与 store layout 可安全验证；
- Host 已取得该 Workspace authority，Ledger/Artifact store 不处于 blocked/inconsistent 状态。

30 天从 Host 记录的不可变 `publishedAt` 计算，不使用文件 mtime、last access 或 Agent 提供时间。artifact 在满 30 天时仍受保护则继续保留；以后保护解除且年龄已超过 30 天，可在下一次 GC 删除。

### 45.1 GC 执行

GC 使用 Host 固定流程，在阻止新的 artifact reference commit 的短临界区内：

1. 由 Ledger worker 计算当前受保护 digest set；
2. 枚举固定 store layout 中的 final blobs，不跟随链接；
3. 对候选重新验证 digest/path/published metadata；
4. 删除前再次确认未被当前 generation 引用/保护；
5. 删除 final blob；
6. 在独立 Artifact Retention Audit 中记录 digest、size、publishedAt、deletedAt 和固定 `retention-30d` reason；
7. 不删除 Evidence Observation 或改写历史 Event。

GC 不由 Agent/Policy 触发或配置，不接受 arbitrary digest/path。具体运行时机可以是安全 startup maintenance 和成功 backup 后的固定维护点；GC 失败产生运维 warning，不把缺少删除能力误报为 Workflow failure，也不无限 retry 阻塞关键提交。

已确认属于终结 Host Boot 且从未发布的 staging 临时文件可以按单独 startup cleanup 立即处理，不需要等待 30 天；它们从未成为 Evidence Artifact。

### 45.2 与永久 Generation Archive 的关系

第 28 节 Ledger Generation archive 仍由插件永久保留，但其引用的非受保护 artifact bytes 只保证 30 天保留。因此 30 天后旧 generation 的 DB/Event/Evidence metadata/hash 仍在，部分 artifact 内容可能明确显示 `retention-deleted`。

这是对先前“final artifact 永不自动删除”建议的明确否决，也是对 generation archive 完整取证能力的有意降低。Host 不把按规则删除记录成异常 corruption；若缺失 digest 有对应 Artifact Retention Audit，则 UI 显示 expired。没有合法 audit 的缺失仍按第 44 节 historical warning 或 current recovery 处理。

无论年龄多大，Active Parent/current Gate/未决 work 受保护 artifact 不得删除。不存在“30 天到期后即使当前 Gate 依赖也删除”的规则。

管理员在插件外提前删除文件不等于 retention GC，仍按 artifact missing/corruption 处理。

## 46. 已确认：Verified Backup Bundle 包含全部受保护 Artifact

每次生成 latest/previous verified backup 时，Host 先根据该 checkpoint 的 Ledger 状态计算受保护 artifact set，并把每个 artifact 的独立可恢复内容副本纳入同一 staging backup bundle。

bundle 至少包含：

- 一致性 SQLite database snapshot；
- `artifacts/sha256/...` 下的受保护 artifact bytes；
- 统一 manifest，逐项绑定 digest、size、media/artifact type、source store format 和 protection reason；
- DB snapshot hash、artifact set aggregate hash 和完整 bundle hash。

只有以下 artifact 纳入：Active Parent、current Gate、未完成 Task、未决 Effect、当前 recovery 或该 backup checkpoint 明确保护的引用。不复制无保护历史 artifact，也不把全部 content store 装入每次 backup。

backup staging 校验必须重新读取 bundle 中每个 artifact 并计算 hash，不能只相信源 store 文件名。为了使 backup 能抵抗源 artifact path 被误删/替换，bundle 必须拥有独立可恢复 bytes；普通 hardlink 共享同一 inode，不作为唯一备份副本。未来可使用经过能力验证且语义等价的 copy-on-write/reflink，但 restore 验收只看独立可读 bytes/hash，不依赖原 store path。

backup barrier 只有在 DB snapshot 与受保护 artifact set 全部复制、校验、manifest 签定并原子发布后满足。任何 artifact copy/hash 失败等同 backup barrier failure，不发布部分 bundle。

latest/previous 两份 backup 各自是完整可恢复 bundle；轮换删除旧普通 backup 时同时删除该 bundle 内 artifact copy，不影响 current content store 或永久 Ledger Generation archive。

受控 restore 时：

1. 先验证所选 bundle 全部 DB/artifact/hash；
2. 恢复 DB staging；
3. 对 content store 中缺失或不匹配的受保护 digest，从 bundle bytes 走与第 43 节相同的 staging/hash/fsync/atomic publish 流程恢复；
4. 不覆盖 hash 冲突文件，冲突时保持 host-blocked 并保全现场；
5. DB 与所需 artifact 全部验证后才原子启用 restored current；
6. 后续仍执行第 32 节 Task/Effect/Policy/remote recovery。

backup bundle 与 artifact store 位于同一 DSH Home 私有安全边界，继承相同敏感数据访问限制。它提升误删/局部损坏恢复能力，但不等于跨磁盘/跨机器 remote backup。

## 47. 已确认：首期不提供内置 Remote/Offsite Backup

首期插件不提供：

- S3/对象存储 backup；
- 网络共享/远程目录 destination；
- 可配置第二本地磁盘路径；
- backup upload/sync daemon；
- cloud credential、encryption key 或 retention policy；
- Policy/环境变量/Web 中的 arbitrary backup destination；
- 跨机器自动 restore。

latest/previous verified backup 与 generation/incident archives 都位于当前 DSH Home 所在存储边界。它们不能抵御整盘损坏、DSH Home 被整体删除、操作系统账户丢失、勒索软件或机器灾难。Host/UI/文档必须明确显示 `offsiteBackup=false`，不能把“verified”描述成异地灾备。

管理员可以在插件外使用组织既有备份系统保护 DSH Home 私有目录，但受支持的采集边界只有：

1. 完全停止相关 Host，确认 SQLite worker clean close 后复制整个 Workspace 私有目录；或
2. 复制一个已经发布且 manifest/hash 完整的 immutable verified backup bundle/generation archive，不能复制 staging 或单独抓取活跃 `ledger.sqlite3` 主文件。

插件不校验外部备份系统、不持有其 credential，也不因为外部备份失败自动阻塞 Workflow；组织若要求异地备份作为发布前置，必须未来设计成独立 Host 运维能力，不能由 Policy 添加一个布尔 Gate 绕入当前 Workflow Definition。

从外部备份恢复到 DSH Home 仍须走第 32 节直接人类受控 restore、Workspace/generation/schema/hash 校验和 Task/Effect reconciliation，不能简单覆盖当前目录后继续运行。

未来 remote backup 专项必须单独冻结加密、credential ownership、上传幂等、不可变保留、删除、带宽、网络失败和 restore drill；本节不预留通用 destination schema。

## 48. 已确认修订：终态 Parent 满 30 天后全部物理清理，不留 Tombstone

首期每个 Parent 从提交 `completed` 或 `abandoned` 终态的 Host 时间 `terminalCommittedAt` 起计算固定 30 × 24 小时保留期。满期后 Host 自动 purge 该 Parent 聚合。

purge 覆盖该 Parent 在当前 Ledger Generation 的全部记录，包括：

- Parent current row；
- Child、Gate/current projection、Task；
- Workflow Event；
- Command Receipt 与该 Parent 的 Command Attempt Audit；
- Evidence Observation 与 artifact references；
- Role Actor mapping/history；
- Effect record，包括 applied/failed 或 abandoned 时仍未决的 effect；
- Task/Effect lease current 与 Lease Audit；
- 该 Parent 的 recovery/delivery/manifest/branch/repository resolved facts；
- 所有其他以该 Parent 为生命周期所有者的 Ledger rows。

不保留 Parent Tombstone、purge manifest、Parent ID、终态摘要、最后 revision、Effect ID 或远端 outcome 摘要。purge 后按 ID 查询返回 not-found，Host 不区分“从未存在”与“已按 retention 删除”。旧 Command ID/Receipt 不再可重放原 outcome。

这是对以下先前边界的明确修订：Workflow Event、Command Receipt、Evidence Observation、Role Actor mapping 和 Effect history 的 append-only/不可变保证只在所属 Parent 保留期间成立；Parent 终态 30 天后整聚合删除是唯一已确认的自动删除例外。记录在保留期间仍不可 update/单独 delete。

### 48.1 Purge 前置与执行

Host 只能 purge 已终态满 30 天的 Parent；Active Parent 永不按本规则删除。时间使用不可变 `terminalCommittedAt`，不使用最后访问、文件 mtime、Agent 时间或用户可改字段。

执行时：

1. 取得该 Workspace Host authority，确认 Ledger/schema/store 不处于 blocked/inconsistent；
2. 暂停新的 Parent mutation、backup publication 和 artifact reference commit；
3. 在单一 SQLite maintenance transaction 中验证 Parent 仍终态且已满期，并删除全部受外键约束的 Parent-owned rows；
4. 事务失败整体回滚，不留下半个 Parent；
5. 使用固定 SQLite compaction/rebuild 流程回收可回收页面；不声称能对 SSD、文件系统快照或外部备份提供法证级安全擦除；
6. 重新执行全量 Ledger invariants；
7. 重建 current generation 的 verified backup baseline；
8. 满足 post-purge backup barrier 后才恢复其他 mutation。

purge 是 Host maintenance，不是 Parent mutation：不产生该 Parent 的新 revision/Event/Receipt，因为这些记录会被全部删除。也不保留等价 Tombstone/Audit。Host 可以暴露不含 Parent identity 的聚合维护指标，但不能借此保存可重建 tombstone 的字段。

### 48.2 Current Backup 清理

purge 必须从 current DB 以及 current generation 的 latest/previous rotating backups 中移除该 Parent。Host 不能在完成 current DB purge 后继续保留含该 Parent 的普通 backup。

因此 post-purge 需要：

1. 生成并验证不含被 purge Parent 的新 latest bundle；
2. 删除旧 latest/previous 中包含该 Parent 的 bundle；
3. 再独立生成并验证同一 post-purge checkpoint 的 previous bundle，使两份 current backups 都不含该 Parent；
4. 两份 bundle 使用不同 backup ID/hash manifest，允许 covered checkpoint 相同；
5. 任一步失败时 Host 保持 recovery-required，不恢复普通工作，但保留尚未成功替换的旧 bundle直到至少一个新 bundle verified，避免无恢复副本。

这构成第 31 节“一般不伪造 duplicate previous”的明确维护例外：purge rebaseline 可以为同一 checkpoint生成两份独立 verified bundles，以同时满足两份备份和删除旧 Parent 副本。

### 48.3 永久 Archive 例外

已经存在的永久 Ledger Generation archive 或 incident archive 不因当前 generation Parent retention 而重写、删除或重新 hash。它们可能继续包含该 Parent；本规则只清理 current DB 和 current rotating backups。

因此“全部物理清理”准确指活跃 generation 与其普通恢复副本，不是跨所有历史 archive 的法证删除。管理员若要求 archive 中也删除，当前插件不支持，不能修改 archive 冒充原 hash。

### 48.4 外部资源与 Artifact

purge 不清理或修改 DSH session、Git workspace、branch、commit、PR、Issue、Milestone、GitHub review/check、测试系统或任何远端 effect。它也不通知旧 Role Actor、关闭外部资源或回滚 merge。

Parent purge 后，其 artifact 不再因该 Parent 受保护；若 artifact 也已满足第 45 节 30 天保留且没有其他保护引用，可由 Artifact GC 删除。artifact deletion 仍写 Artifact Retention Audit；由于 Parent 已删除，该 Audit 不保留可恢复 Parent tombstone 关系。

Generation Reset archive 中的旧 Active Parent 不属于当前 Ledger current rows，不由本规则打开 archive 并 purge。

这是用户明确选择的审计/幂等取舍：终态超过 30 天后，插件不再提供该 Parent 的本地历史、Receipt 或 effect 取证。

## 49. 已确认：Incident Archive 由插件永久只读保留

每次受控 Backup Restore、主 DB 损坏保全或未来明确要求保全故障现场的操作，创建独立 typed incident ID 与 immutable incident archive bundle。bundle 可以包含：

- 故障 current DB、WAL/SHM 的一致可保全部分；
- 当时 latest/previous/staging manifests 的安全副本；
- SQLite/invariant error codes 与版本信息；
- Artifact store integrity manifest/冲突文件的受控副本或 hash；
- Host Boot/worker crash 的结构化诊断；
- 直接人类 restore confirmation reference；
- bundle content hash 与创建时间。

不得无差别抓取进程内存、环境变量、credential、完整 prompt/persona、原始 provider response 或整个 workspace。只有恢复/取证所需且经过固定 sanitizer 的数据可以进入 bundle。

插件对 incident archive：

- 永不自动删除、覆盖、压缩改写、迁移或合并；
- 不受 Parent 30 天 purge、artifact 30 天 GC 或 latest/previous 轮换影响；
- 不因 restore 成功而删除；
- 不重新激活为 current Ledger；
- 只在运维 UI 显示 incident ID、时间、类型、schema/generation、hash、大小和安全摘要；
- 不向 Agent/Role Actor/普通 Workflow tool 暴露本地路径、raw DB 或任意下载；
- 与 generation archive 一样位于 Workspace DSH Home 私有目录并继承严格文件权限。

因此 incident archive 可能永久包含 current Ledger 后来已按 Parent retention purge 的记录。这是第 48 节明确保留的 archive 例外，不创建 current Ledger Tombstone，也不让普通查询恢复旧 Parent。

拥有操作系统权限的管理员可以在相关 Host 完全停止后离线删除，插件不保证阻止。删除会永久损失取证能力；下次启动若 current restore audit 引用的 incident archive 缺失/hash 不符，Host 报告结构化 archive integrity warning/blocker，不重建或静默移除引用。

首期没有 archive encryption key management 或 remote vault；机密性依赖 DSH Home/OS 权限。若组织要求加密、legal hold 或受控删除，需未来独立安全运维专项，不能把 raw archive export 暴露给 Agent。

## 50. 已确认：非 Parent 结构化 Audit 永久保留

以下 Host 级或跨 Parent 的结构化 audit 在所属 current Ledger Generation 中永久保留，generation reset 后随整个旧 DB 进入永久 archive：

- Host Boot start/clean-end/unclean takeover；
- Lease orphan/takeover 中不随 Parent purge 删除的 Host-level部分；
- Ledger Generation Reset；
- Backup publication/rotation/barrier failure/restore；
- incident/generation archive integrity；
- Artifact Retention/Delete；
- artifact store corruption/repair（未来若有）；
- schema/storage capability/readiness 变化；
- 其他明确不属于单个 Parent 生命周期的破坏性运维事实。

Parent-owned Lease Audit、Effect、Task 等仍随 Parent 30 天 purge 删除；若一次 Host audit 同时涉及 Parent，结构必须区分 Host-level operation 与可选 Parent reference，Parent purge 后不得保留足以构成 Parent Tombstone 的完整业务摘要。Generation Reset/Restore 依据既有决策可以在 permanent archive/Host audit 中保留其必要的旧 generation 摘要，这是明确 archive 例外。

结构化 audit 只保存：固定 event/audit type、稳定 code、typed entity/reference、version/hash、时间、直接人类 confirmation reference 和经过 allowlist 的安全字段。不得保存：

- 自由文本 operational log；
- raw stack trace；
- 任意 exception object serialization；
- environment dump；
- credential/token/header；
- 完整 API/runner response；
- prompt/persona/session transcript；
- 任意 workspace 文件内容。

普通调试/operational log 由 DSH/OS 现有日志设施管理，不进入 Workflow Ledger、backup manifest 或 archive bundle（除非 incident archive contract 明确选择并 sanitize 某段结构化诊断）。插件不建立第二套可配置文本日志 retention 系统。

Web/UI 根据 audit code 和安全字段本地化生成说明，不要求永久保存原始 message。未知异常只记录稳定 internal-error correlation ID，详细 stack 留在受控临时 Host log。

永久保留是插件行为；操作系统管理员仍可删除 DSH Home。首期无 legal hold、WORM 或远程审计服务保证。

## 51. 已确认：使用规范化关系表，拒绝 EAV/整聚合 JSON

SQLite schema 使用固定、领域专属的 `STRICT` tables。关键字段必须是显式 typed columns，并由 database/application 双重约束：

- typed entity ID 与外键；
- Parent revision/sequence；
- state/type/verdict 枚举 CHECK；
- schema/Workflow/Policy/hash version；
- Workspace/Repository/Gate/Effect identity；
- timestamps；
- unique Active Parent、single unresolved Effect、Event revision、Command ID 等唯一约束；
- nullable 关系的精确条件 CHECK。

首期禁止：

- `entities(type, id, json)` 通用实体表；
- EAV/property-bag schema；
- 把整个 Parent aggregate 序列化为单一 JSON/BLOB；
- 任意 key/value custom fields；
- Agent/Policy 定义 table/column/index；
- 以 JSON path query 代替关键外键、状态和唯一约束；
- JavaScript object serialization/反序列化直接成为权威 schema。

JSON 只允许用于固定 type 的不可变、安全、版本化 detail payload，例如某个 Effect Catalog type 的确定参数摘要或 Evidence contract 的有限结构化 facts。每个 JSON payload 必须：

- 有显式 `payloadType`/`payloadVersion` typed columns；
- 对应 Host 内置严格 schema，未知字段拒绝；
- 使用确定 canonical JSON 编码并记录 hash；
- 写入前校验，读取后再次校验；
- 不含 credential、raw response、任意路径、自由对象或可执行内容；
- 不作为 SQL authorization/state transition 的唯一依据；关键查询字段同时正规化成 columns/FK；
- 版本不支持时 fail closed，不兼容猜测。

mutable current state 与 immutable history/audit 分表。不可变 table 不提供通用 update path；Parent retention purge 是整聚合受控删除，不借此开放任意 row delete。

schema 使用明确 migration-free exact version（按第 27 节），table/column/index/constraint 变化发布新的 Ledger schema version；旧库按 Ledger Generation Reset 处理，不静默修改。

数据库 schema 文件与 typed DTO/domain evaluator 必须生成/测试一致，但数据库约束是独立防线；TypeScript compile success 不能替代 runtime constraint tests。

## 52. 已确认：首期使用固定领域 Table Inventory

首期 schema table inventory：

### 52.1 Ledger/Host

- `ledger_meta`：单例 current generation/schema/Workspace identity 与 storage format；
- `host_boots`：Host Boot Epoch/current active boot；
- `host_audits`：非 Parent 结构化 Host audit；
- `backup_publications`：latest/previous/staging publication/checkpoint metadata。

### 52.2 Parent 当前状态与工作范围

- `parents`：Parent aggregate root、state、revision、Workflow/Policy hashes、终态 retention 时间；
- `parent_repositories`：Parent 选择的 affected Catalog subset、resolved identity、delivery sequence 与 baseline facts；
- `children`：固定 Child 类型、顺序、状态与 Parent ownership；
- `child_repositories`：Child 对 repository 的工作范围、branch/candidate/PR facts；
- `tasks`：固定 Workflow Task facts、授权 role/executor、状态与 subject scope；
- `gates`：Gate current satisfaction projection、subject fingerprint 与 accepted evidence relation；
- `recovery_causes`：当前/历史 recovery blocker type、scope 和 resolved 状态。

### 52.3 Candidate 与交付

- `release_candidate_entries`：冻结 candidate manifest 中每个 affected repo 的 baseline/candidate SHA 和 manifest sequence；
- `delivery_repository_states`：最终串行交付中每仓 pending/merged/failed/current remote facts。

### 52.4 Evidence、Artifact 与 Actor

- `evidence_observations`：不可变 verified evidence metadata；
- `evidence_artifact_refs`：Observation 与 content-addressed artifact 的多值引用；
- `artifact_objects`：final artifact digest/size/type/publishedAt/store format 与当前存在状态；
- `artifact_retention_audits`：30 天 GC 删除审计；
- `role_actor_mappings`：Parent 固定 role 到 DSH durable Actor 的 current/history mapping、definition/route hash 与 stale reason。

### 52.5 Effect、Command 与领域审计

- `effects`：统一 Effect Intent/transactional outbox/current execution/reconciliation/outcome；
- `workflow_events`：每 Parent revision 一条的领域事件；
- `command_receipts`：成功 mutation 的不可变幂等回执；
- `command_attempts`：被拒命令的独立安全审计。

### 52.6 Lease

- `leases`：`task-execution|effect-execution` current owner/Boot/fencing；
- `lease_audits`：acquire/release/orphan/takeover 审计。

具体设计中可以证明必要后把一个领域表拆成更专属的子表，或增加固定 Workflow Definition 确实需要的关系表；新增必须说明无法由现有正规化关系表达的 invariant/query/retention 需求。不能用“未来灵活性”增加通用表。

明确不建立：

- Policy registry/snapshot/version activation table；
- 通用 `instances`/state-machine definitions/transitions table；
- 通用 assignment/task pool/claim table；
- 独立 generic outbox/message table；
- Effect Attempt table；
- Parent Tombstone/purge manifest table；
- generic entities/EAV/property bag；
- arbitrary key/value runtime settings；
- Markdown/state mirror table。

Policy source仍是固定 workspace 文件；Parent 只保存运行连续性与审计所需的 schema/accepted hashes/固定解析事实，不复制完整 Policy source。Parent purge 后上述 Parent-owned tables 按第 48 节级联清理；Host/artifact audits 与永久 archives 遵循各自 retention。

## 53. 已确认：Parent 使用单一 Canonical State

`parents` current row 使用一个 `state` typed column表示固定 Workflow Definition 当前状态，并使用一个 `revision` 整数表示 Parent 领域提交序列。不得保存以下可互相矛盾的冗余布尔状态：

- `isActive`；
- `isBlocked`；
- `isRecovery`；
- `isDeliveryPartial`；
- `isCompleted`；
- `isAbandoned`；
- `isTerminal`。

active、terminal、recovery、delivery-partial 等分类由固定 state enum/transition metadata 和关系表确定性推导。具体 Parent state enum 及每个状态的 allowed transitions 属于固定 Workflow Definition 常量专项；schema 生成明确 CHECK/lookup constraint，只接受该精确闭集，不使用任意字符串或 Policy 扩展。

`recovery_causes` 保存 recovery/blocker 的 type、scope、opened/resolved relation，不代替 `parents.state`。同一个 Parent 可以保留多个历史 cause，但当前 state 与未解决 causes 的允许组合由 Workflow Definition/database constraints 校验。error message 文本不作为 state/cause。

main session 的 `normal|workflow-active|workflow-recovery` 交互 mode、Host readiness、Effect executionState、Task state 和 Child state 都是不同状态域，不能写入 `parents.state` 冒充同一 enum。

`parents` 核心列至少包含：

- typed `parent_id` primary key；
- current `generation_id`/Workspace relation；
- canonical `state`；
- nonnegative monotonic `revision`；
- fixed Workflow Definition version；
- Policy schemaVersion 与 accepted source/continuity/ownership/role hashes所需显式字段或固定子关系；
- created actor/time；
- latest committed Event/Command linkage；
- terminal state 的 `terminal_committed_at`，非终态必须 null；
- milestone/umbrella identity 等 Parent 固定业务引用的正规化字段/关系。

所有 Parent 领域 mutation 使用 `WHERE parent_id=? AND revision=? AND state IN (...)` 的 compare-and-swap 语义，并在同事务将 revision +1；更新行数不是 1 则 whole mutation fail closed。

每 Workspace 单一 Active Parent 使用数据库 partial unique index/等价真实约束，根据固定 terminal state set 判断；不通过可漂移 `isActive` 列维护。Ledger Generation Reset 和 30 天 purge 继续遵循已确认例外。

只读查询可以返回派生 `active/terminal/recovery` flags 作为 DTO 展示，但这些不是持久化 authority，也不能由调用方回写。

## 54. 下一轮优先事项：先简化，再继续冻结

用户已明确要求暂不进入 Workflow Definition 常量、逐表物理 schema 或下一专项。下一轮先对本文件当前设计进行简化调整，重点识别并删除：

- 超出首期真实需求的恢复/备份层级；
- 重复表达同一不变量的状态、audit 或 checkpoint；
- 为低概率运维场景引入的过度机制；
- 可以由更少固定规则覆盖的表、流程和术语；
- 与用户偏好的确定性 MVP 不匹配的通用化设计。

简化时不能静默改变已确认决策；每项删除、合并或替代仍按一次一个问题确认并立即同步关联文档。简化完成前，本文件保持“讨论中”，不作为可直接实施的冻结 schema。

简化后仍待讨论：

1. 精确 Parent state enum 与 Workflow Definition transition table；
2. `ledger_meta`/`parents` 完整 columns/index/constraints；
3. repository/child/task/gate/recovery tables；
4. candidate/delivery tables；
5. evidence/artifact/actor tables；
6. effect/command/event/lease tables；
7. stable error/denial/recovery code catalog；
8. Git/GitHub 专项中的具体 Effect Catalog。
