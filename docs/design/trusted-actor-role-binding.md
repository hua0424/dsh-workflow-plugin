# Trusted Actor 与 Role Actor 设计

- 状态：已确认（首期简化模型）
- 日期：2026-08-18
- 主题：DSH 运行时身份、主会话 Manager、持续 Role Agent、角色映射与门禁授权
- 关联设计：`docs/design/parent-child-workflow-instances.md`、`docs/design/workflow-policy-dsl-static-validation.md`

## 1. 目的

本设计定义工作流首期如何识别调用者、配置团队角色、派发任务和验证权威结果。

它解决以下问题：

1. 如何避免 Agent 通过 prompt、label 或 tool 参数自行声明角色；
2. 如何利用 DSH 提供的可信 `agent.id`；
3. 是否需要独立的 Actor、Role Binding、Assignment 和 Capability 系统；
4. 主会话是否直接担任 Manager；
5. 如何复用 DSH continuable subagent 维持角色上下文；
6. 如何在简化授权模型的同时保留确定性 Gate；
7. 哪些安全和组织隔离能力明确不在首期实现。

本文只冻结首期 trusted actor 与 role actor 语义，不冻结数据库表名、具体 tool 名称、Web UI、GitHub credential 隔离或自动化测试框架。Policy v1 的角色配置边界和静态校验由关联的 Workflow Policy Profile 设计冻结。

## 2. 设计取向

首期目标不是建设一个通用 IAM、RBAC 或多组织审批平台，而是支持以下受控场景：

- 一个主会话；
- 同一时间最多一个 active Parent workflow；
- 一套由配置定义的固定 Agent 团队；
- 一个角色同一时间只有一个 active continuable subagent；
- Manager 根据状态机串行派发写任务；
- Role Agent 直接提交其负责 Gate 的权威结果；
- Host 使用状态、角色映射和 SHA 验证 transition。

因此首期主动采用简单的一对一模型：

```text
一个 roleKey
  → 一个预配置 Role Agent definition
  → 一个运行中的 continuable subagent
  → 一个当前唯一的 agent.id
```

不建设通用 Actor registry、Role Binding、Assignment、lease、Capability、RBAC/ABAC 或跨系统 principal 映射。

## 3. DSH 运行时事实

### 3.1 `agent.id` 是 Session identity

DSH 的 `Agent.id` 与它驱动的 `Session.id` 使用同一个 identity。

因此：

- `agent.id` 是 Host 提供的运行时会话身份；
- 新建 subagent 时生成新的 child session id；
- continuable subagent 后续恢复和接收消息时继续使用这个 durable child id；
- tool implementation 可以从执行上下文取得当前调用 Agent，不能从业务参数取得身份。

`agent.id` 不是预配置角色名称，也不是 persona 名称。

### 3.2 预配置定义与运行时身份不同

Role Agent definition 可以预先声明：

- subagentProvider；
- LLM provider/model/maxTokens；
- persona；
- 可选 tool deny-list。

Continuable mode、直接 child topology、depth 和角色职责不是 definition 字段，而是引擎固定约束。

Manager 根据这个定义创建 continuable subagent 后，DSH 才产生该实例的 `agent.id`。

因此，准确关系是：

```text
Role Agent definition
  → spawn
  → continuable child session
  → durable agent.id
```

### 3.3 Persona、label 与 tool 参数不是身份凭证

以下内容都不能单独授予角色权限：

- subagent description/label；
- prompt 中“你是 Reviewer”等文字；
- persona 文本；
- tool arguments 中的 `actorId` 或 `role`；
- branch 名称；
- Git commit author；
- Agent 自述。

Persona 用于行为引导，tool filter 用于减少可见工具，真正的最小授权依据是 Host 保存的 `roleKey → agent.id` 映射。

### 3.4 Continuable subagent 可以保持上下文

一个 Role Agent 在同一 Parent 生命周期中持续存在并接收后续消息，可以保留：

- 需求背景；
- 设计决策；
- 已完成 Issue；
- Review 历史；
- 测试历史。

但 Agent 上下文不是工作流事实来源。每次派发仍必须包含当前状态、目标 Child、仓库、分支、Gate 和 SHA，Host ledger 才是权威状态。

## 4. 核心术语

### 4.1 Manager

当前 active Parent 的主控角色。

首期由启动该 Parent 的主会话直接担任，不额外创建 Manager subagent。

### 4.2 Role Agent definition

工作流配置中的角色定义，例如：

- `prd-reviewer`；
- `developer`；
- `code-reviewer`；
- `tester`。

定义包含 persona、模型和工具等运行配置，但本身不是某个运行中的 Agent。

### 4.3 Role Actor

某个 Role Agent definition 在当前 Parent 中产生的 continuable subagent。

首期一个 roleKey 同一时间最多对应一个 active Role Actor。

### 4.4 Role Actor mapping

Host 保存的运行时映射：

```text
(parentId, roleKey) → currentAgentId
```

调用工作流 mutation tool 时，Host 将执行上下文中的 `exec.agent.id` 与该映射比较。

### 4.5 临时只读 Agent

为并发代码阅读、资料整理、调查和分析创建的临时 subagent。

它不是 Role Actor，不进入角色映射，不能提交权威 Gate、修改工作流状态或获得写任务。

## 5. 主会话直接担任 Manager

### 5.1 拓扑

首期团队拓扑为：

```text
主会话 / Manager
├── PRD Reviewer
├── Developer
├── Code Reviewer
├── Tester
└── 临时只读 Agent
```

Role Actors 是主会话的直接 continuable children。

### 5.2 采用该拓扑的原因

1. 用户可以直接与 Manager 沟通需求、反馈、确认和恢复决策；
2. 不需要由主会话向 Manager subagent 额外中转；
3. Role Actors 都是 Manager 的直接 children，适配 DSH continuable subagent 的消息路由；
4. 少一个长期会话、恢复点和状态同步关系；
5. 主会话已经天然承担工作流发起和用户交互职责。

### 5.3 暂不采用专用 Manager subagent

专用 Manager subagent 只有在以后出现以下需求时再考虑：

- 一个主会话同时管理多个 Parent；
- 工作流完全后台运行；
- 普通对话与工作流必须在不同会话并行；
- 多用户共享同一个 Parent；
- Web UI 直接连接独立 Workflow Controller。

## 6. 主会话工作模式

首期定义三个概念模式：

```text
normal
workflow-active
workflow-recovery
```

`abandoned` 是 Parent 的不可恢复终态，不是第四种主会话 mode。Host 持久化终态并向用户送达 abandonment notice 后，主会话解除 active Parent 绑定并转回 `normal`。

### 6.1 `normal`

- 没有绑定 active Parent；
- 允许普通对话、设计讨论和其他任务；
- 可以决定启动新 Workflow。

### 6.2 `workflow-active`

- 主会话已经绑定一个 active Parent；
- 主会话就是该 Parent 的 Manager；
- 用户消息被解释为当前 Workflow 的反馈、确认或调整；
- 不允许创建第二个 active Parent；
- 不执行与当前 Workflow 无关的写任务；
- 持续推进到完成、不可恢复的 abandoned，或明确进入 recovery/blocker。

### 6.3 `workflow-recovery`

用于处理：

- Role Actor 无法恢复；
- GitHub 部分交付；
- 外部服务故障；
- 运行崩溃后的对账；
- 必须等待用户决策的异常。

恢复完成后返回 `workflow-active`。Parent 进入 `completed` 后，或持久化 `abandoned` 并向用户送达 notice 后，主会话解除 active Parent 绑定并返回 `normal`；abandoned 的具体触发和不清理规则见 Workflow Policy Profile 设计。

另有一个不属于 Parent transition 的 Host 级破坏性例外：SQLite schema 不兼容时，直接人类可以执行 Ledger Generation Reset，归档整个旧 generation 并解除当前运行时绑定。旧 Parent 不被伪造为 completed/abandoned，旧 Role Actor mapping/evidence/effect 不进入新 generation，Host 也不清理任何外部产物。该入口及风险见 `docs/design/durable-workflow-ledger.md`。

### 6.4 模式约束的实现边界

Plugin 可以硬性执行：

- 一个主 session 同一时间最多一个 active Parent；
- 错误 Parent、Child、Gate、role 或 SHA 的 mutation 被拒绝；
- active Parent 未结束前不能启动第二个 Parent。

仅靠 workflow tool 不一定能完全阻止模型回答一条普通聊天消息。因此普通对话锁定还需要：

- 动态 system prompt；
- Web UI 的 active workflow 提示；
- Agent 行为约束；
- 对无关副作用的工具层拒绝。

权威状态约束必须由 Host 硬性执行，语言交互限制可以首期采用行为约束。

## 7. 初始角色集合

首期固定且完整的角色集合如下：

| roleKey | 主要职责 |
|---|---|
| `manager` | Parent 编排、状态推进、派发、恢复、交付协调、Manager-owned 非代码 effect |
| `prd-reviewer` | PRD Review PASS/FAIL |
| `developer` | 指定 Child 的业务代码开发、修复和业务代码冲突处理 |
| `code-reviewer` | Child Code Review 和 Milestone Aggregate Code Review |
| `tester` | 需要 Agent 判断的测试准备、执行协调、结果分析和验证活动 |

`manager` 不创建 Role Actor mapping。它由 Parent 保存的主 session identity 隐式确定。

`conflict-resolution` 是 Child 类型，不是角色：

- 业务代码冲突由 `developer` 处理；
- policy 明确允许的伞仓非代码资源冲突由 `manager` 处理。

自动 test runner、GitHub adapter、outbox worker 等是内部执行组件，不伪装成 Role Agent。具体自动化测试证据模型在测试专项设计中确定。

## 8. Role Actor 配置

首期概念配置如下：

```yaml
team:
  prd-reviewer:
    persona: ...
    tools:
      deny: [edit, write]

  developer:
    persona: ...

  code-reviewer:
    model:
      provider: configured-provider
      name: configured-model
      maxTokens: 32000
    persona: ...
    tools:
      deny: [edit, write]

  tester:
    # subagentProvider 省略时默认为 spawn
    # model 省略时在 Role Actor 创建时继承 Manager 当前路由
    persona: ...
```

`mode` 固定为 `continuable`，不作为 Policy 字段。四个固定 Role Agent definition 全部内联在同一个 Policy Source Document，不引用外部 Agent Preset 或独立 Profile Registry。

Static Policy Validation 负责：

- 四个固定 role 是否完整且没有额外 key；
- 同一 roleKey 是否只定义一次；
- Manager 是否被错误配置为普通 child actor；
- persona 是否非空；
- 显式 model block 是否完整；
- tools 是否只使用可选 deny-list，且没有禁止角色固定必需工具。

Environment Preflight 负责：

- subagent provider 是否已注册并支持 continuable；
- 显式或继承得到的 LLM model route 是否可用；
- 非空 deny-list 使用的 provider 是否支持 tool filter。

Role Agent definition 中的可选 per-role `tools.deny` 直接映射到 DSH child `toolFilter.deny`，只收窄对应 Role Actor 继承的工具，不限制 Manager，也不是另一层 Policy 权限系统。无论工具是否可见，Host 的 role/action 校验始终是最终权限边界。

## 9. Role Actor 生命周期

### 9.1 创建范围

每个 Parent 使用自己的一套 Role Actor sessions。

Role Agent definition 可以跨 Parent 复用，但运行中的 Role Actor 不跨 Parent 复用，避免：

- 上一个需求的上下文污染；
- 仓库、分支和 SHA 混淆；
- 旧失败状态影响新 Parent；
- 权威结果归属不清。

### 9.2 按需创建

Role Actor 可以在首次需要时创建：

```text
首次 PRD Review
  → spawn PRD Reviewer

首次开发
  → spawn Developer

首次 Code Review
  → spawn Code Reviewer

首次测试活动
  → spawn Tester
```

创建后在 definition、继承模型路由和可恢复性未变化时持续复用；Policy 热重载、Manager 继承路由变化或不可恢复故障会按 9.4/9.5 创建 replacement，并保留旧 mapping 历史。

### 9.3 注册映射

Manager 通过 Host 控制的创建路径生成 Role Actor。创建成功后，Host 保存 DSH 返回的 durable child id：

```text
(parentId, roleKey) → childAgentId
```

不能由新 Agent 自己提交一个 `roleKey` 完成注册，也不能根据 description/label 自动授予权限。

### 9.4 恢复

Continuable Role Actor 暂时不在内存时，应优先使用同一个 durable child id 冷恢复并继续对话。

若原 session 确认无法恢复，Parent 进入 `workflow-recovery`。后续可以创建替代 Role Actor，但必须：

- 使旧映射失效；
- 保存旧 evidence；
- 记录替换事实；
- 不把新 Agent 伪装成旧 Agent；
- 重新派发当前尚未完成的任务。

Host Boot 重启后，旧 boot 中未释放的 `task-execution` lease 先标记为 orphaned，Parent 进入 `workflow-recovery`。Host 必须确认旧 turn 不再运行并检查其可能留下的本地/远端事实；旧输出只作为 candidate，不能自动成为权威 outcome。原 durable session 可恢复时继续使用同一 Actor mapping，不可恢复时才按上述规则替换；随后对同一个未完成 Workflow Task 分配更大的 fencing token 并重新派发完整当前上下文。具体 ledger 顺序见 `docs/design/durable-workflow-ledger.md`。

### 9.5 Role Agent 运行定义或继承模型变化时替换

Role Agent 未在 Policy 显式配置 model 时，创建 Role Actor 会继承 Manager 当时的 LLM provider、model 和 maxTokens。由于 continuable child 的实际模型路由在创建时固定，后续 Manager 切换模型不会修改既有 child。

Host 为 mapping 记录解析后的 route、`routeSource=inherited|explicit` 和 `roleDefinitionHash`。下一次派发前，以下任一条件触发替换：

- 继承型 Role Actor 的 route 与 Manager 当前 route 不同；
- Policy 热重载改变该角色的 subagentProvider、model、persona 或 tools.deny，导致 roleDefinitionHash 变化。

Policy 热重载只在旧 Actor 没有运行中的 turn 时接受，并在同一 ledger transition 中把旧 mapping 标记为 `stale-policy-reload`；该 mapping 从此不能再接收任务。下一次派发前，Host 将 stale mapping 转为历史并按当前已接受 definition 创建新 Role Actor。该替换产生新的 agent.id，保留旧 session、mapping 和 evidence，并重新派发完整当前上下文；既有 evidence 不因运行定义变化自动失效。旧 Actor 仍在运行时 fail closed，Manager 必须先停止 Agent loop。Replacement 创建失败时不回滚已经接受的新 Policy，也不重新启用旧 stale Actor；Parent 进入 `workflow-recovery` 后重试创建。

### 9.6 结束

Parent 进入 `completed` 或 `abandoned` 终态后：

- Role Actor mappings 进入历史状态；
- Role Actor 不再接受新工作流任务；
- sessions 可以归档或按 DSH 生命周期清理；
- 后续 Parent 创建新的 Role Actors。

上述历史 mapping/session reference 只在 Parent retention window 内由当前 Ledger 保留。持久化专项确认：Parent completed/abandoned 满 30 天后，该 Parent 的 Actor mappings 与全部其他 Parent-owned Ledger records 一起物理删除且不留 Tombstone；Host 不因此删除 DSH session 或向旧 Actor 执行外部 cleanup。完整规则见 `docs/design/durable-workflow-ledger.md`。

## 10. Manager 派发模型

### 10.1 不建立 Assignment 子系统

Parent 状态机已经唯一确定 required work，Issue 又严格串行，因此首期不建立通用 Assignment、任意资源 claim 或任务池。引擎只为固定 Workflow Definition 产生持久化 Workflow Task，并以固定 `task-execution(parentId, taskId)` lease 保护其长时间执行；这不是 Agent 可自行领取或 Policy 可扩展的通用 lease 子系统。

Child 只需要知道负责它的 roleKey。Manager 根据 `nextRequiredGate` 和 `nextRunnableChild` 决定向哪个 Role Actor 发送消息。

### 10.2 最小任务消息

每次派发至少包含：

- `parentInstanceId`；
- `childInstanceId`，如适用；
- 当前任务类型；
- repository/worktree；
- branch；
- candidate SHA 或测试基线；
- 当前 expected Gate；
- 允许提交的结果；
- 应使用的 workflow tool。

示例：

```text
执行 Child C-03 的 Code Review。

Repository: repo-a
Branch: feature/C-03
Candidate SHA: abc123
Expected Gate: child-code-review

审查结束后，必须通过权威 Review 提交工具提交 PASS 或 FAIL；
不要仅在普通文本中声称完成。
```

### 10.3 持续上下文不是权威输入

即使 Role Actor 记得之前任务，Manager 也必须为每次新任务发送最新状态和 SHA。

发生以下变化时必须重新派发更新后的任务：

- Child 代码变化；
- Milestone candidate SHA 变化；
- Policy baseline branch base SHA 变化；
- remediation/conflict-resolution 合入；
- 旧 Gate evidence 失效。

## 11. 权威 mutation 授权

### 11.1 固定 action-to-role 规则

首期使用固定规则，不引入 Capability 引擎。

概念映射如下：

| Action | Required actor |
|---|---|
| 创建和管理 Parent | 当前主会话 Manager |
| 创建、排序和派发 Child | Manager |
| 提交 PRD Review | `prd-reviewer` Role Actor |
| 执行业务代码开发并提交开发完成 | `developer` Role Actor |
| 提交 Child Code Review | `code-reviewer` Role Actor |
| 提交 Milestone Aggregate Code Review | `code-reviewer` Role Actor |
| 提交需要 Agent 判断的测试/验证结果 | `tester` Role Actor |
| 执行 Manager-owned 伞仓非代码 effect | Manager |
| 执行最终交付编排 | Manager |

同一个 `code-reviewer` Role Actor 可以执行 Child 和 Milestone 两级 Review，但它们仍是两个独立 Gate、两个独立 attempt 和两个独立 SHA-bound evidence。

首期接受二者不是组织上独立 Reviewer 的妥协。

### 11.2 Host 校验步骤

每个状态修改调用至少按 action 类型校验以下适用项：

1. 当前 `exec.agent.id` 来自 DSH execution context；
2. 当前 Parent 是否存在且未完成；
3. Parent 保存的 Manager session identity 是否仍有效；
4. action 所需 roleKey；
5. Manager action 的调用者是否等于 Parent 的 Manager session；
6. Role Agent action 的 `roleKey → currentAgentId` 是否存在，且该 Agent 是否为 Manager 的直接 child；
7. Role Agent action 的调用者 ID 是否等于该 currentAgentId；
8. Parent/Child 当前状态是否等待这个 action；
9. repository、branch、candidate SHA 是否匹配；
10. 旧 evidence 是否已经失效；
11. transition 是否满足父子实例不变量。

任一项无法确认时 fail closed。

### 11.3 不接受调用者声明身份

Mutation tool 不接受具有授权意义的：

```text
actorId
role
isManager
reviewerName
```

如果为了显示或诊断保留类似字段，它们也不能参与授权判断。

## 12. Gate evidence

Role Agent 必须直接提交自己负责的权威 Gate 结果。

例如 Code Reviewer 应自己调用 Review 提交工具，而不是只把“PASS”发给 Manager，再由 Manager 代为提交。

每条权威 evidence 至少关联：

- Parent；
- Child 或 Gate scope；
- roleKey；
- Host 观测到的 `agent.id`；
- attempt；
- repository/branch；
- candidate SHA；
- PASS/FAIL；
- 时间；
- 结构化结果或报告引用。

Manager 可以读取、展示和根据 evidence 推进状态，但不能冒充其他 Role Agent 产生 evidence。

测试自动化后，原始 runner 结果与 Tester 的分析结论可能是不同记录；该细节留给自动化测试设计。

## 13. 临时只读并发

父子实例设计只允许读任务并发。首期 trusted actor 模型按以下方式处理：

- Manager 或 Role Actor 可以创建临时只读 subagent；
- 临时 Agent 不加入 Role Actor mapping；
- 不赋予权威 mutation tool；
- 不能提交 Review/Test PASS；
- 不能改变 Parent 或 Child 状态；
- 结果只作为调用它的 Manager 或 Role Actor 的辅助输入。

临时只读 Agent 不需要 Actor registry、Role Binding 或 Assignment。

## 14. 明确接受的安全妥协

### 14.1 Session identity 不等于人类身份

`agent.id` 能证明不同 DSH sessions，不能证明不同人、组织、模型提供商或 GitHub 账号。

首期只提供运行时身份和审计归属，不提供企业 IAM。

### 14.2 Manager 控制团队成员

Manager 创建和指挥所有 Role Actors，因此 Reviewer 不是组织意义上完全独立的审批者。

首期仍保留不同 sessions、独立 evidence 和 Host 校验，但不声称解决人为串通或共同控制问题。

### 14.3 同一 Code Reviewer 执行两级 Review

Child Review 与 Milestone Aggregate Review 保持不同 Gate，但允许由同一个持续 Code Reviewer Role Actor 执行。

`workflow-policy/v1` 不允许拆分或新增 Reviewer role。未来若确有需求，必须通过新的 Workflow Definition/schemaVersion 重新冻结角色集合与授权映射，不能仅靠当前配置增加 roleKey。

### 14.4 不阻止所有 Git/GitHub 旁路

Role mapping 控制 workflow mutation，不单独阻止 Agent 使用 shell、Git 或 GitHub API。

完整约束仍依赖：

- GitHub branch protection/ruleset；
- 受控 GitHub adapter；
- worktree/path policy；
- candidate SHA 检查；
- 最终 preflight 和远端验证。

### 14.5 普通聊天锁定包含行为约束

Host 可以硬性锁定 active Parent 和 transition，但普通自然语言消息是否被回答仍部分依赖 system prompt 和 UI。首期接受这一边界。

## 15. 首期明确不实现

以下能力推迟：

- 通用 Actor registry；
- 一个 actor 同时绑定多个 roles；
- 一个 role 同时绑定多个 active actors；
- 通用 Role Binding 表和 scope 继承；
- Assignment、claim、lease 和任务池；
- Capability engine；
- RBAC/ABAC policy DSL；
- actor independence domain；
- 人类账号和企业 IAM；
- GitHub principal 与 DSH session 映射；
- 复杂 lineage 职责分离；
- reviewer pool；
- 多 Parent 并行主控；
- 独立后台 Manager service。

如果未来需求出现，再以兼容方式扩展，而不是在首期预建抽象层。

## 16. 与父子实例设计的关系

本设计不改变已经确认的父子实例语义：

- Parent 仍负责整体编排和 Gate；
- Child 仍负责具体开发任务；
- Issue 仍严格串行；
- 只有读任务可以并行；
- PRD Review、Child Code Review 和 Milestone Aggregate Code Review 仍是三个不同 Gate；
- Manager 不修改业务代码；
- Manager 可以处理 policy 明确允许的伞仓非代码资源；
- Gate evidence 仍绑定 candidate SHA；
- `nextRequiredGate` 仍从最早失效或未满足 Gate 重新计算。

本设计只规定谁可以提交这些动作，以及 Host 如何用最小映射验证调用者。

## 17. 已确认不变量

1. `agent.id` 是 DSH Host 提供的 Session identity。
2. `agent.id` 不是预配置角色名称。
3. 一个 roleKey 同一时刻最多有一个 current continuable Role Actor；definition/route/recovery 变化可依次产生 replacement，旧 mapping 保留为 stale/history。
4. Host 保存 `(parentId, roleKey) → currentAgentId`。
5. 一个 roleKey 同一时间最多有一个 active Role Actor。
6. 一个 Role Actor 首期只代表一个 roleKey。
7. 主会话直接担任 Manager，不创建 Manager subagent。
8. 一个主 session 同一时间最多绑定一个 active Parent。
9. Parent active 时，主会话进入 workflow 模式并持续到完成、abandoned 或 recovery/blocker；completed/abandoned 后解除绑定并返回 normal。SQLite schema 不兼容时经直接人类确认的 Ledger Generation Reset 是 Host 级破坏性例外：它解除旧 generation 的运行时绑定，但不伪造 Parent 终态。
10. Role Actors 是 Manager 的直接 continuable children。
11. Role Actor 在 definition、继承 route 和可恢复性不变时于同一 Parent 中持续复用；替换后旧 mapping 留史，任何 Role Actor 都不跨 Parent 复用。
12. Role Actor 可以按需创建，创建后登记 DSH 返回的 durable child id。
13. Persona、label、prompt 和 tool 参数不构成角色授权。
14. 不建立通用 Actor、Role Binding、Assignment 或 Capability 子系统。
15. Manager 根据 Parent 当前状态向对应 Role Actor 派发任务。
16. 每次派发都携带最新 Parent/Child、Gate、仓库、分支和 SHA。
17. Role Agent 直接提交其负责 Gate 的权威 evidence。
18. Manager 不能代替其他 Role Agent 制造 PASS/FAIL evidence。
19. Host 使用 `exec.agent.id`、role mapping、当前状态和 SHA 共同校验 mutation。
20. 任一身份、映射、状态或 SHA 无法确认时 fail closed。
21. 同一个 Code Reviewer Role Actor 可以执行 Child 与 Milestone 两级 Review，但 evidence 独立。
22. 临时只读 Agent 不进入 role mapping，不能提交权威 Gate 或状态 mutation。
23. 原 Role Actor 可恢复时继续使用同一 durable id；不可恢复时进入显式 recovery，不静默冒充或替换。
24. Parent 进入 completed 或 abandoned 终态后，该 Parent 的 Role Actor mappings 进入历史状态。
25. 首期接受 session identity 不等于真实人类身份的边界。
26. Role Actor mapping 不替代 GitHub ruleset、路径策略、SHA preflight 和远端验证。
27. 首期 Policy 必须且只能配置 `prd-reviewer`、`developer`、`code-reviewer`、`tester` 四个固定 Role Agent key，不能增删角色或改变职责映射。
28. 四个 Role Agent definition 全部内联在同一个 Policy 中；continuable mode、拓扑、depth 和授权映射由引擎固定，不引用外部 Agent Preset。
29. 每个 Role Agent 可以配置可选的 per-role DSH tool deny-list；它只收窄该 Role Actor 继承的工具，不限制 Manager，Host role/action 校验仍是最终权限边界。
30. Role Agent 未显式配置 model 时继承创建时的 Manager 路由；Manager 路由变化或 reloadable Role Agent definition 变化后，下一次派发前以新的 agent.id 替换受影响 Role Actor，既有 evidence 不因此失效。Policy reload replacement 失败时保留已接受的新 Policy，旧 stale Actor 仍不可用，Parent 进入 workflow-recovery。

## 18. 后续专项设计

Workflow Policy Profile 与 Role Agent definition 的首期边界已在关联设计中冻结。以下内容仍需分别讨论：

- SQLite ledger、revision、幂等、恢复、outbox；
- Workflow tool/action 的具体名称和 authorization matrix；
- DSH continuable child 创建、恢复与替换适配器；
- GitHub adapter、credential 和 ruleset；
- 自动测试、test runner 与 Tester evidence；
- Web UI 的 workflow-active 交互与状态展示；
- 多 Parent、后台 Manager 和真实 IAM 的未来扩展。
