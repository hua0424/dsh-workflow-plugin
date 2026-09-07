# PRD：以 Node 执行工作单简化 Workflow Engine 与中断恢复

- 日期：2026-09-07。
- 状态：已被新设计与 spec 替代，仅保留历史；不再作为独立开发/验收基线，未表示已实现。
- 原跟踪 Issue：[hua0424/dsh-workflow-plugin#6](https://github.com/hua0424/dsh-workflow-plugin/issues/6)；按用户要求由 [新 Spec Issue #7](https://github.com/hua0424/dsh-workflow-plugin/issues/7) 接替。
- 新入口：`refact` 分支的 `docs/design/node-execution-runtime.md` 与 `docs/specs/node-execution-runtime.md`。新版本采用 Run/工作单/关键事件三表，claim 合并为 outcome+handoff，争议复用 BLOCK/resume；下文 summary 等旧合同只反映当时决定。
- 仓库文档：`docs/prd/20260907-node-execution-simplification/requirements.md`。
- 来源：用户要求分析并简化 Workflow 插件，随后要求形成指导后续开发的 PRD。
- 核心决策：允许增加 SQLite 执行记录和显式阶段；以减少整体代码复杂度、提升 Node 独立性为目标。常规情况根据记录恢复；少见、难以精确还原的中断情况，交给 Role Actor 或 Manager 检查 External Facts 后继续或重做。
- 操作范围：本 PRD 的编写和发布不授权修改真实 Run、部署插件、清理工作区、删除外部资源或处置已有 GitHub 交付。

## Problem Statement

### P1：节点已登记，但工作过程并没有成为独立、完整的执行对象

用户希望 Workflow 是一个由固定职责人员协作完成工作的串行有向图。每个 Node 的执行者只需要理解当前输入、工作指令和完成要求，不必掌握整个 Graph，也不必理解宿主的 Session、派发队列和故障恢复细节。

当前插件保存 current Run、call stack、nodeToken 等信息，但 Node 的阶段与材料分散在 Run 的 pendingClaim、pendingCorrection、pendingDispatchContext、内存 DispatchBook 和 DSH Session 中。一个业务概念需要同时理解多个字段及其存在/缺失组合。

### P2：“最小状态”把复杂度转移到了派发和恢复代码中

为补足上下文丢失、Judge 重建、返工重派等问题，当前实现已经增加多种临时状态镜像。恢复入口必须分别处理 claim、correction、deferred handoff、Actor mapping 和 Judge Session 的组合。

用户不反对持久化状态。用户反对为了少存字段而产生大量推断，也反对为了覆盖所有罕见故障而建设过度复杂的自动恢复协议。

### P3：工作单独立性与 Role 上下文延续需要分清边界

Role Actor 是整个 Root/Child Run 内复用的 continuable subagent，不同 Node 继承此前上下文，并在进入下一 Node 时 compact。需要简化的是散落的工作材料和恢复推断，而不是取消 Role 复用。当前 Node 的输入、提交和判定必须有独立边界，不能只依赖 Role 的历史记忆；compact 后的历史经验可以保留，但不能代替当前工作单或成为当前 claim 的判定证据。

### P4：中断恢复的目标被错误理解为完美恢复机器现场

用户真正需要的是工作流能够可靠继续完成工作，不一定要原样恢复每个 Turn、每次消息发送和每个外部动作。

如果进度无法低成本确定，向执行者提供已有材料并说明“之前任务执行中断，请先检查完成情况再继续”，通常比实现大量恢复状态和精确回执协议更合适。

## Solution

### S1：从“最小字段”改为“最少隐式状态与恢复猜测”

建立持久化的 **Node Execution（Node 执行工作单）**：每次沿 Graph 进入 Node 都有独立身份，保存输入、执行阶段、提交结果、Judge 意见和交接材料。工作单既支持正常执行，也支持恢复和换人接手，不是只追加一份审计日志。

### S2：常规恢复依靠记录，长尾恢复依靠 Agent

- 已知事实足够：按工作单继续相应阶段，例如已有 claim 就继续 Judge，已有接受结论就交接后继。
- 阶段或派发结果不确定：不扩建精确恢复协议，向当前处理人注入中断检查提示，允许其检查 External Facts 后继续、补做、重新提交或请求 Manager。
- 已经完成的外部工作可以直接形成新的可信 claim，不要求为了“重做”而再次制造相同外部效果。
- Agent 的判断可以替代业务进度推断，不能替代身份授权、Judge 门控或 Graph 路由校验。

**既不禁止基于 SQLite 的恢复，也不要求无人值守自动恢复。是否增加一项恢复机制，以其是否减少整体复杂度为判断标准。**

### S3：Role Actor 跨 Node 延续，Node Execution 独立保存本次工作

同一 Role 在整个 Root/Child Run 中复用同一个 continuable Actor Session，不同 Node 继承此前上下文；进入下一 Node、派发新工作前执行 Node 边界 compact，压缩而非清空历史。同一次 Node Execution 内继续、补充和返工不视为新 Node 进入。工作单独立指本次输入、阶段、提交、判定和授权独立，不意味着每个 Node 新建 Actor Session。旧 Session 不可用时，replacement 读取工作单接手，不要求完美重建全部 Role 历史。

### S4：保持串行 Graph 与独立确认，扩大局部处理自由度

Graph 仍不可变，任一时刻只允许一个 Node 执行位置推进。Actor 可检查现场、使用获准的 helper、提问、暂停、继续或提交结果；Manager 负责协调；Judge 独立核验。业务问题尽量在工作单内解决，不转化为 Engine 的专用恢复分支。

## User Stories

1. As a 用户, I want 工作流在中断后能够继续完成目标, so that 我不必理解或修复内部派发状态。
2. As a 用户, I want 开发者可以增加有价值的 SQLite 状态, so that 最小状态原则不再阻碍代码简化。
3. As a 用户, I want 长尾故障能够交给 Agent 检查现场, so that 插件无需为了完美恢复无限增加复杂度。
4. As a 用户, I want SQLite 能保存每次 Node 的进入、工作材料和离开结果, so that 我能定位执行进度并安排接手。
5. As a 用户, I want 工作流继续保持串行, so that 多个 Node 不会同时修改现场或争夺推进权。
6. As a Manager, I want 查看当前工作单的阶段、材料、执行者和暂停原因, so that 我能决定继续哪个工作环节。
7. As a Manager, I want 常规恢复直接使用已有输入和提交, so that 我不必从聊天记录手工拼装上下文。
8. As a Manager, I want 在进展不确定时把工作交回 Actor 检查, so that 我不必要求 Engine 判断每个外部动作是否发生。
9. As a Manager, I want 补充信息被保存在当前工作单中, so that 发送失败或再次中断后不用重复输入。
10. As a Manager, I want 更换模型或不可用 Actor 后新执行者仍能接手, so that 人员变化不会导致任务材料丢失。
11. As a Manager, I want 对已经保存的 claim 继续或重建 Judge, so that 不必无故重做已经提交的工作。
12. As a Manager, I want 必要时明确退回 Actor 检查并重新提交, so that 不可靠的旧 claim 不会被强行继续判定。
13. As a Manager, I want FAIL 且没有 onFail 时仍保留失败材料, so that 再次安排当前工作时有依据。
14. As a Manager, I want 程序执行效果不确定时先核实现场再重试或裁决, so that 不会盲目重复创建外部资源。
15. As a Manager, I want 重启后的待处理 Run 可以安全暂停等待协调, so that 插件不必自动恢复所有宿主活动。
16. As a Role Actor, I want 收到完整的当前输入、instruction 和完成要求, so that 我不用了解整个 Workflow Graph。
17. As a Role Actor, I want 在整个流程中复用 continuable Session，进入下一 Node 时 compact 并继承压缩后的上下文, so that 历史经验得以延续，同时当前工作仍以独立工作单为准。
18. As a Role Actor, I want 同一次工作内保留补充和纠正意见, so that 我可以连续修正而不必从头了解问题。
19. As a Role Actor, I want 接到中断任务时被明确提醒先检查完成情况, so that 我能自适应地继续、补做或重新提交。
20. As a Role Actor, I want 已经完成的现场工作无需重复执行, so that 接手任务不会造成重复副作用。
21. As a Role Actor, I want 缺少材料时能够向 Manager 报告需要什么, so that 业务提问不被误判为 Graph FAIL。
22. As a Role Actor, I want completed 和 failed 拥有对称的 Handoff Context, so that 后继和返工节点都能收到可执行材料。
23. As a Role Actor, I want 自己的迟到提交明确被拒绝, so that 不会误结算新的工作或新的派发轮次。
24. As a Judge, I want 从工作单取得当前输入、claim、交付材料和纠正意见, so that 不必依赖拼接其他 Node 的聊天历史。
25. As a Judge, I want 缺少信息时请求补充而不是猜测, so that 判定仍然可信。
26. As a Judge, I want 技术故障后能从已有材料重新判定, so that 不需要恢复原先的模型推理过程。
27. As a Judge, I want 我的结论严格关联当前提交版本, so that 旧判断不会确认新的工作结果。
28. As a 后继 Node 的执行者, I want 直接收到前序已确认的 Handoff Context, so that 不依赖同一 Role 的旧 Session 记忆。
29. As a Child Workflow 的执行者, I want 调用材料和执行身份彼此独立, so that 同一 Child 的多次调用不会串线。
30. As a 开发者, I want 正常推进和恢复使用同一组状态转换, so that 不维护两套生命周期实现。
31. As a 开发者, I want 内存只保留必要的活动句柄和可丢弃缓存, so that 重启后不必恢复所有进程内对象。
32. As a 开发者, I want 测试面主要是现有 Engine/Host Adapter 和隔离 SQLite, so that 可以验证用户可见行为而不绑定私有布尔字段。
33. As a 开发者, I want 明确哪些旧分支必须删除, so that 本次重构不是叠加一套新旧并存的状态系统。
34. As a 用户, I want 升级时明确处理不兼容的旧活动 Run, so that 新版不会静默损坏现有工作。

## Implementation Decisions

### D1：设计优先级与简化判据

按以下顺序决策：

1. 保留必要的安全和正确推进约束。
2. 保留足够的工作材料，使 Role Actor / Manager 能独立接手。
3. 对常规路径采用明确、统一、低成本的记录和恢复。
4. 对长尾不确定情况优先使用同一种“检查现场后继续”降级方式。
5. 再考虑更细的自动恢复；不能以“理论上能自动恢复”为由增加新的协议体系。

新增恢复分支时，开发说明必须回答：相比直接交由处理人检查现场，这项机制是否更简单或能明显减少重复工作；新增分支是否能替代其他分支；是否只在复原宿主内部细节。不是“只要 Agent 能处理就禁止自动恢复”，而是优先选择整体成本更低的做法；收益不足的长尾分支不实现。

不把代码行数下降百分比作为唯一验收指标；但必须交付旧状态、旧分支和重复路径的删除清单。仅添加工作单表而保留全部旧推断，不算完成本 PRD。

### D2：保留的领域语义

- 一个 canonical workspace 最多一个 active Run；Run 仍绑定 Manager。
- Workflow Definition Snapshot 不可变；本期不支持运行中改图或任意跳转。
- Graph 业务结果仍只有 PASS / FAIL；BLOCK 不是 Edge。
- Actor Task 的 completed / failed 只是 claim，不能直接推进。
- Judge ACCEPT 按 claim outcome 路由；REJECT 回到当前工作修正；NEED_CONTEXT 等待补充。
- completed / failed 的 summary 与 Handoff Context 容量、保存、派发能力保持对称。
- Child Workflow 仍在到达 END 时返回 Parent PASS，不新增 Child FAIL 终点。
- Manager 执行 Actor Task 时不能自己确认 PASS；程序现有的 Manual Program Resolution 保留。

### D3：新增 Node Execution，区分“节点定义”“本次进入”“派发轮次”

Node Execution 是一次沿 Graph 进入 Node 后形成的工作单，拥有稳定 execution ID。

- 沿 Graph 再次进入同一 nodeId，包括自环，创建新的 Node Execution。
- 同一 Node 内 resume、Judge REJECT 返工、Actor replacement 不创建新的 Graph visit；更新该工作单的派发或提交版本。
- 本次执行的身份不能由 nodeId 或会轮换的 nodeToken 单独承担。
- 保留 run、workflow、node 关联和父 Child 调用的 execution 关联，能区分同一 Child 的多次调用。
- Child 调用工作单可以保持未离开，但不与栈顶工作单同时获得推进权；仍只有 top frame 对应的实际执行位置活跃。
- 已保存的旧提交或旧判定即使保留为历史材料，也不自动成为当前有效结果。

### D4：SQLite 记录的职责与最小实现范围

至少新增一张 Node Execution 表。Run 保存运行身份、Definition Snapshot、call stack、当前工作单指针、Manager、Run 级 Role Actor mappings 和当前控制状态。Role Actor mappings 支持同一 Role 跨 Node 复用，工作单中的执行者关联记录本次实际派发身份，两者职责不同。工作单承载 Node 运行事实，不再把相同事实镜像回多个 Run pending 字段。

工作单至少覆盖：

| 类别 | 必需事实 |
|---|---|
| 身份与位置 | execution ID、Run/workflow/node、进入顺序、父调用关联、进入与离开时间 |
| 执行材料 | 原始 Handoff Context、instruction/criteria 的不可变引用、Manager 补充、当前恢复说明 |
| 当前进度 | 最近已确认的粗粒度阶段、暂停原因、暂停时的阶段 |
| 当前处理人 | Role/Program、当前 Actor/Judge Session 关联、必要的当前派发与提交版本 |
| 执行提交 | 当前或最近 claim、summary、Handoff Context、Program 参数和已知结果 |
| 判断与交接 | 当前有效判定、对应提交版本、最近纠正意见、已经选择的 Graph 结果、后继关联 |
| 接手材料 | 换人或重新提交前保留下来的重要结果、纠正意见和 Manager 决定 |

Implementation 可以使用少量关系字段加 JSON 保存有界材料，不强制完全关系化，也不强制为每个概念建立单独表。

重要区别：

- 保存业务输入、已接受提交、判定和恢复所需材料是必需的。
- 保存所有 token 历史、所有 tool 事件、全部 Turn、完整聊天和详细外部 Effect 历史不是必需的。
- 最近已确认阶段表示“数据库知道的进度”，不声称它与宿主每个微小执行瞬间完全同步。
- 内存可保留活动句柄、短期互斥和本进程派发 lease；不要求重启后让旧 lease 继续有效。重启恢复可以建立新派发轮次和新授权。
- 不允许只有内存保存后继所需 Handoff Context 或 Manager 补充。

已离开的工作单保留输入和结果摘要。启动新 Run 不覆盖前一 Run 的工作单历史。为了避免保留失去定义背景的孤立记录，保留必要 Run 身份与对应 Definition Snapshot；可在当前存储中扩展 Run 归档，不要求建设通用历史查询平台。

Reset 的含义改为撤销当前运行资格并释放 workspace 的 Run 占用，不默认删除已记录的工作材料或操作外部资源；历史标明因 Reset 终止，不伪装成工作已完成。后续显式历史清理不属于本期。

Reset 不等于旧宿主任务已经停止。已知旧 Actor/Program 仍可能修改现场时，新 Run 的派发同样适用 D14 的停止或 Manager/用户核查门槛；活动情况未知时明确提示先确认，不新增后台探测或自动清理协议。

### D5：粗粒度阶段，而不是精确恢复状态机

工作单需要表达以下五种业务进度；实现可统一命名，但不能重新用 optional 字段组合隐式代替：

1. **待执行**：输入已登记，还没有已确认的有效提交；可以准备派发。
2. **处理中**：Actor/Program 已被安排处理，但尚无已保存的有效结果；不区分模型推理、tool 执行、等待 provider 等细节。
3. **待判定**：已有当前有效 claim，等待 Judge 确认。
4. **待交接**：已有有效业务结论，尚未完成 Graph 离开与后继登记。
5. **已离开**：该次 Node 已结束其 Graph 职责；结果和后继关系保留。

暂停保留原阶段和原因。可以继续使用 Run 的 BLOCK 作为对外暂停状态，不为“缺少参数”“provider 超时”“消息回执丢失”等原因增加大量 phase。

“待交接”可以是正常事务中的短暂概念，若判定和离开能够在一个事务里直接完成，不要求为了保存该阶段单独增加一次写入。

Program 和 Child 使用相同工作单概念，但不强制经历不存在的 LLM 判定阶段。父 Child 工作单的处理中表示等待其栈顶 Child 完成。

两个特殊业务转换直接明确，不增加 phase：

- Judge REJECT：原 claim 转为历史材料，当前判定资格失效；同一工作单回到待执行，携带纠正意见重新安排 Actor。
- FAIL 无 onFail：保留已确认失败，处于待交接但 BLOCK，原因是没有可用出口；不得尝试不存在的交接。按 D12 恢复时，将该次失败转为历史材料、增加工作版本并回到待执行，而不是重新判定旧 claim。

### D6：登记顺序、事务和正常推进

- 在向 Actor/Program 派发工作前，先登记该次工作单的输入及本次安排；不要先启动后继，再保存前驱离开。
- Actor claim 持久化成功后，才作为已接受提交安排 Judge。技术故障不能把未入库提交当成已确认。
- Judge/Program 产生有效结论后，在同一 SQLite 事务中保存结果、前驱离开、后继工作单及输入，并更新 Run 指针；Root END 和 Child 返回适用同一原子原则。
- 无后继时不能伪造后继记录。FAIL 无 onFail 的处理见 D12。
- 若必须等待旧执行者结束才可派发后继，后继工作单可以先处于待执行，不把等待所需上下文只放在内存。等待条件集中在一个派发路径，不在 claim、Judge、resume 各自复制。
- SQLite 短事务和必要的队列只保护状态转换。宿主 spawn/followup、LLM、网络和 Program 长调用在事务之外执行，回来后校验当前执行身份与版本。
- 不强制完整 Outbox、Inbox、事件回放或分布式提交协议。待执行工作单加当前安排信息可以充当最小派发意图。
- 输入登记失败时不启动新外部工作；外部调用已发生但本地结果未登记时，进入 D7 的不确定情况处理。

### D7：恢复策略——明确的按记录继续，不明确的交给处理人

#### D7.1 常规恢复

| 数据库中可直接确定的情况 | 默认处理 |
|---|---|
| 待执行，输入完整 | 从工作单派发；若无法确定之前是否已投递，附带中断检查提示，而非建设额外投递还原协议 |
| 处理中，没有已保存的有效 claim | 默认续接该 Role 的原 Session，安排 Actor 检查现场后继续；Session 不可用或显式更换时按 D8 创建 replacement |
| 待判定，claim 与必要材料完整 | 继续当前 Judge 或从工作单创建新 Judge，不先重做 Actor 工作 |
| 已有有效判定或 Program 结果，尚未交接 | 使用已记录结论完成交接，不重新猜测原业务结果 |
| 前驱已离开、后继已登记 | 只处理当前后继，不重新推进前驱，不创建第二个后继 |
| 等待 Manager 补充 | 先保存补充，再安排对应处理人继续 |

本期不要求宿主启动后无人值守自动跑任务。最简单的默认实现可以在重启时把未结束 Run 统一置为可恢复 BLOCK，同时保留最近阶段和材料，Manager 恢复主会话后继续。无需为了这个选择恢复进程内 dispatch book 或逐个探测旧 Session。

对记录明确且宿主条件满足的常规路径，可以复用普通驱动器继续；本 PRD 不禁止低成本自动推进。不能把“统一 BLOCK 是允许的实现”解释为“执行记录只用于查看、不能用于恢复”。

#### D7.2 通用长尾降级

当无法低成本确定派发是否送达、Actor 是否做完、Judge Session 是否还可用或某个外部效果是否已发生时，使用统一恢复入口，按当前处理人的职责生成提示。交给 Actor 或承担执行职责的 Manager 时，提示语义必须包含：

> 之前任务执行中断，请先检查完成情况再继续。以下是已保存的任务材料和进度记录，可能不完整。若工作已经完成，请核验后提交结果，不要重复产生外部副作用；若尚未完成，请继续或补做。无法可靠判断或需要额外权限时，请说明情况并交由 Manager 处理。

交给 Judge 时不得发送要求补做工作的指令，应明确：之前判定中断，请基于当前有效 claim、已保存材料及只读现场重新核验；无法判断则请求补充或交由 Manager，不能修改对象。Judge Session 丢失而 claim 完整时优先重建 Judge，只有 Manager 明确退回 Actor 才走工作检查/补做路径。

要求：

- 提示和已有输入、最近 claim/纠正意见、Manager 补充一起交付，不只发送一句空泛“继续”。
- “检查后重做”表示完成同一工作目标，不意味着强制重跑全部命令或撤销既有成果。
- Actor 可以基于真实现场重新 claim completed/failed；新 claim 仍经 Judge。
- Program 的不确定结果交给 Manager 检查，再明确决定重新运行或 Manual Program Resolution；不得因为参数已存储而直接盲目重跑有副作用 Program。
- 不自动解析业务仓库、Issue 或外部对象以建设每类 Effect 的专用恢复器。
- 原 Session 不可用不应变成必须修复原 Session 才能继续的阻断条件。
- 阶段记录不完整可以降级；Run ownership、Definition Snapshot、当前 Graph 位置或 SQLite 结构损坏不能让 Agent 猜测后自动覆盖。此类基础完整性问题应停止并交给 Manager/用户。

#### D7.3 明确的恢复取舍

允许为简化代码重新生成 prompt、重建 Judge、重新检查现场、重新提交工作结果。允许有限的重复模型工作。

不承诺原 Turn 原地恢复、不承诺每条派发 exactly-once、不承诺外部副作用 exactly-once。

不能为了追求恢复命中率增加多级 Session 探测、跨存储事务、外部 Effect 回执历史或自动补偿系统。若一个长尾场景最终仍需要人工确认，应优先直接走统一接手提示。

### D8：Role Actor 在 Run 内复用，进入下一 Node 时 compact

- Role Definition 继续定义 persona、模型和工具限制；非 Manager Role 首次使用时创建 continuable Actor，在整个 Root/Child Run 内按 Role 复用其 Session，不因新的 Node Execution 默认创建新 Session。
- Role 再次承担新的 Node Execution 时，在派发该 Node 工作前执行 Node 边界 compact，随后续接同一 Actor。不同 Node 继承 compact 后的上下文，而非清空历史或只传工作单。自环再次进入同一 nodeId 也是新 Node Execution，适用相同边界规则。
- 同一工作单内 resume、补充和 REJECT 修正默认继续当前 Actor，不因这些操作额外触发 Node 边界 compact；同 Node 内长对话仍可使用 DSH 原有上下文管理能力。
- 保留必要的 Run 级 Role mapping、cold-resume 和 Node 边界 compact 能力，集中封装于 Host Adapter；不把现有 cold materialize→compact→dispose 路径列为必须删除项。可替换其内部实现，但不能取消跨 Node 复用和 compact 的行为。
- compact 失败时保留工作单输入和待派发进度，进入可恢复 BLOCK，不把失败当作已完成 compact 后直接派发新 Node。恢复复用普通准备/派发入口，不为精确还原 compact 内部过程增加复杂协议。
- Actor 跨 Node 保留上下文，不代表旧 Node 的提交资格、派发身份或判定证据可以沿用。每次工作仍显式交付完整输入并绑定当前 execution/派发版本；Judge 只取得当前工作单材料及 Node-local 可见证据。
- 旧 Session 不可用或明确更换模型/人员时允许 replacement，更新 Run 级 Role mapping；新 Actor 必须得到当前工作单完整材料。replacement 是异常接手或显式更换，不是正常 Node 切换策略，也不要求完美重建全部历史上下文。
- Manager 仍是主会话，不创建 Role Actor mapping，也不执行上述 Role 边界 compact；Manager 执行时仍取得明确工作单输入。Judge 不接收完整 Manager 历史。
- Role 模型覆盖保持现有 Manager 控制语义，需要更换 Actor 时使用新的派发版本并保留材料；不能借模型更换绕过旧活动执行的安全门槛。
- 本期不另建 Workflow 级 token 阈值或复杂 compaction 调度；这不排除上述必需的 Node 边界 compact。

### D9：工作单输入、Handoff Context 与沟通

每次派发应从同一份工作单材料构造以下内容：当前 instruction、相关 criteria、Handoff Context、当前纠正意见、Manager 补充，以及适用时的恢复提示。

- instruction/criteria 可以引用已冻结的 Definition Snapshot，不要求逐行复制整个配置。
- Root 启动附加文本同样成为持久输入，不能只存在于一次 steer。
- Program 已通过 schema 校验的动态参数在执行前保存；参数保存是接手材料，不代表可以自动重跑。
- Manager 的 resolutionContext 在发送前保存；发送失败后再次恢复不要求手工重贴已保存内容。
- 原输入保持可追溯，补充不应静默覆盖任务原意；保存最近重要补充及其来源/顺序即可，不要求复制普通对话。
- completed / failed 的 Handoff Context 一致保存和发送。summary 仍是声明摘要，不新增 outcome 特有的隐式 summary fallback。
- 交接保留 opaque 文本，不引入变量、output binding、表达式或业务对象数据流 DSL。
- 后继 Actor 不需要知道来源 Node、onPass/onFail 或全图。审计所需 execution 关联留在存储中，不因此强制塞进任务提示。
- 外部材料、Actor 声明和 Handoff Context 是工作数据，不具有改变系统权限或替代 instruction/criteria 的授权效力。

### D10：Judge 以工作单为主要 Judgment Packet 来源

Judge 的主要材料是当前 Node instruction/criteria、明确输入、当前 claim、待交付的 Handoff Context、已有纠正意见和 Manager 已保存补充。

这是对旧“直接 packet 只含 outcome/summary、handoff 依赖局部投影”的有意调整：Judge 应能看见本次实际交付材料，并按当前 criteria 判断其是否支持 claim；不为所有 handoff 新增通用业务 schema 或强制独立审计流程。

- 必要时读取复用 Actor Session 中属于当前 Node Execution 的有界可见材料或 External Facts；必须保留 Node-local 边界，排除旧 Node 历史及其 compact 摘要，不把共享 Session 当作整段判定输入，也不依赖跨完整 Manager Session 的聊天拼接。
- 不复制完整 DSH 日志到 SQLite；恢复也不要求重建原来的 transcript projection。
- Judge 必须保持独立只读，不允许在恢复时转为执行者或直接修复对象。
- 判定必须绑定当前 claim 版本；Actor 重新提交或 Manager 明确退回 Actor 后，旧 Judge 的迟到结果失效。
- Judge 技术故障可由同一创建路径重建；NEED_CONTEXT 可继续现有 Judge，续接不可用时直接用已保存材料创建新 Judge。
- 无法判定仍是 NEED_CONTEXT/BLOCK，不视为 ACCEPT。
- REJECT 仍是当前工作单返工，不走 Graph FAIL，最近拒绝依据保留供后续工作和判定使用。

### D11：工具与协作入口尽量复用

保留现有 start/list/status/reset、node_claim、node_block、node_resume、node_run_program、node_resolve_program、judge_claim、judge_respawn、workflow_set_role_model 的职责，不新增聊天总线或大量工作单专用操作工具。

本期合同调整：

- **status**：增加当前 execution 身份、粗粒度阶段、暂停时阶段、当前处理人、输入/结果摘要、是否有有效 claim/判定和可行的恢复方向；不默认输出全部历史和大文本。
- **node_claim**：继续由 Host 绑定当前派发，不要求模型填写内部 execution ID；原子保存提交并消费该派发的提交资格。
- **node_block**：除原有 reason 外不强制新增复杂问题 schema；缺少材料时 reason 应说明缺什么、需要谁提供。当前任务材料与最近结果不因 BLOCK 删除。
- **node_resume**：仍仅由 Manager 对当前 BLOCK 工作单调用，保存补充后复用普通推进路径。增加可选恢复目标 auto / actor / judge，默认 auto。auto 按已记录进度选择处理人或交接；actor 仅适用于尚未离开的 Actor Task、未形成有效交接结论的执行/判定返工，或 D12 的 FAIL 无 onFail 重开工作；它使旧派发、旧 claim 及其判定资格失效，材料保留为历史。judge 仅适用于待判定且存在有效 claim、尚无有效业务结论的 Actor Task。已有可交接结论时只完成交接，不允许借目标选择改判或重做；已离开工作单不能恢复。Program/Child 不接受 actor/judge 选择，沿其既有执行/调用规则处理。
- **judge_respawn**：复用同一 Judge 创建路径，不维护独立的完整恢复实现。
- **workflow_set_role_model**：保持 Manager 控制，当前人员更换不能改变 Node 指令或绕过 Judge。
- **node_run_program / node_resolve_program**：保存参数、已知结果和 Manager 裁决理由；保持现有授权与适用节点限制。

业务沟通第一版使用现有 BLOCK/resume 闭环：Actor 说明缺失信息，Manager 保存答复并恢复。普通进度说明不必自动转成完成 claim，但 Actor Turn 结束且没有 claim 或显式等待仍应形成可见暂停，不能静默卡住。

Role 可以在当前 Node 内使用获准的 helper；helper 没有 Workflow 推进权。沟通或 helper 不自动激活另一个 Workflow Node。

### D12：已确认失败、无后继与重新执行

FAIL 无 onFail 时继续停在当前 Node，不允许 Manager 任意跳转，也不创建虚构后继。

与旧实现不同：失败 claim、handoff 和已确认结果保留在工作单中，不因“消费了提交”而删掉接手材料。

默认 resume 在此场景回到 Actor/Program 的当前工作检查，而不是因为历史中有 claim 就重新启动 Judge。重新安排 Actor 时增加工作版本，前一次失败结论保留为历史材料，不作为新提交的判定。

有 onFail 时已接受的 failed 沿 onFail 正常离开，后继收到同等完整的 handoff。REJECT 不适用本条，不离开当前 Node。

### D13：Program 与 Child 的确认范围

“每个 Node 都有结果确认”统一理解为每种执行都有可信的离开依据，不强制每个 Node 都额外调用 LLM Judge：

- Actor Task：独立 Judge 确认 claim。
- Builtin Program：固定程序提供确定性结果；ERROR/效果不确定交给 Manager 检查，保留 Manual Program Resolution。
- Child Workflow：Child 到达 END 的已登记事实是 Parent 调用 Node 的 PASS 依据。

程序业务动作与确认可以仍由同一内置实现承担，本期不要求拆成通用 Executor/Checker 插件注册体系。只有 Actor Task 保持不可绕过的独立 Judge 门控。

### D14：必要安全保留，宿主细节集中封装

不能以“让 Agent 判断”为由删掉以下规则：

1. Manager、Actor、Judge、helper 的权限区分。
2. 当前 Run/execution/派发轮次和当前提交版本校验。
3. 一次派发的重复 claim、迟到 claim 和旧 Judge 结果不能二次推进。
4. 模型读取 status 里的最新 token，不能把旧 Turn 伪装成本次获派发工作。
5. 同一 workspace 的状态写入串行、短事务原子性与必要版本校验。
6. 已知旧 Actor 仍 active 时，不向其启动相冲突的新工作；replacement 前撤销旧推进资格。
7. session/event 的处理退出宿主 append 回调后再做状态变更/消息发送；禁止 Judge 在自己的 judge_claim 调用内 drain 自己。
8. Root END、Reset、replacement 后，旧身份不再拥有当前工作单的推进资格。

派发 lease、nodeToken 等现有保护可以由更简单、同等安全的执行身份绑定实现替代；不要求逐字段保留旧结构，也不要求跨重启恢复旧 lease。

不确定的宿主活动无需多级探测和无限轮询。若无法确认旧执行已停止且可能继续修改现场，应交给 Manager 检查或停止旧执行后再接手；不能把撤销 Workflow 推进权描述为撤销了旧 Actor 的普通文件/外部操作能力。

已判定无效的宿主迟到事件不能结算新的派发。事件身份关联的防护集中在 Host Adapter，不能因增加 phase 就直接重放旧 turn/end。

### D15：Module 与 Seam 的收敛目标

优先加深现有 Module，不为拆文件新增仅转发的 Interface：

- **Node Execution Module**：拥有工作单事实、状态转换、提交与判定有效性、恢复目标选择及统一降级策略。
- **Graph 推进 Module**：只决定 onPass/onFail、Child push/pop、END，不处理 Actor compact、Session 探测或外部业务恢复。
- **Host Adapter**：负责 DSH 派发、当前调用身份、Session 生命周期、只读 Judge 工具面和安全结算事件。
- **State Store Module**：负责工作单与 Run 的事务提交、必要版本约束、读取和兼容性检测。

这些是职责分配，不强制新增四个类或四层调用。测试与业务入口应穿过同一个高层 Seam；具体私有函数与表的拆法由实施者选择。

必须删除或被替代的旧复杂度：

- Run 上承担隐式阶段推断的 pending 字段体系及重复材料镜像。
- 内存中唯一保存的后继输入、Manager 补充和恢复目标。
- claim/resume/respawn 中复制的 Judge packet 准备、创建和失败恢复逻辑。
- 散落在多个业务路径中的 Role mapping 修复与 compact 调度重复逻辑；保留跨 Node Session 复用、Node 边界 compact 和必要映射维护，收敛到同一 Host Adapter 路径。
- 必须拼接多个 Session 的历史才能生成恢复材料的依赖。
- 专门为了还原罕见宿主状态而增加的多重存在性检查。

允许保留少量必要的活动互斥、调度句柄和事件关联；不以“删除所有 Map/所有 guard”作为简化目标。

### D16：材料大小、日志和历史

- 当前 summary、handoff、reason、resolution 的已有长度限制可继续复用；completed/failed 不分叉。
- 当前有效输入、最近有效 claim、当前判断依据和未送达补充不能因截断历史而丢失。
- 较早沟通和重复提交可以保留有界摘要及 Session/产物引用；不要求无限保存完整版本文本，也不新增专门的模型摘要调度。
- Program 参数和错误只保存允许的业务数据；不把凭据、reasoning、完整工具结果写入工作单。需要凭据时保存引用或要求恢复时重新提供。
- Trace log 仍是 best-effort 派生产物。记录与 trace 冲突时工作单及 External Facts 优先；不把日志成功作为业务提交的前置条件。
- 不要求 trace 和 SQLite exactly-once，不要求为每条日志增加可靠投递协议。
- 基础 status 和工作单摘要足以支持本期排障；完整历史 UI、搜索和自动清理另行设计。

### D17：兼容、迁移和旧设计替代关系

本次属于运行时模型重构，必须升级 State format 并识别不兼容数据。不能用强制类型转换把旧 Run 当作新工作单运行。

本期不强制实现旧活动 Run 的精确迁移或新旧双引擎。默认交付策略：

1. 升级前说明旧活动 Run 需要在旧版本完成，或由用户明确选择 Reset 后启动新 Run。
2. 新版识别旧活动数据时给出明确提示，不继续旧执行、不覆盖材料、不自动 Reset。
3. 保留只读诊断及经授权的 Reset/导出或备份路径，避免用户被迫手工改 SQLite。
4. 数据格式升级和 Run/Node 历史保留采用备份后的受控迁移；失败时不部分切换。
5. 既有 YAML Graph、Role 与 Checker 配置语法尽量保持兼容；运行语义变化明确列在升级说明中，不静默迁移真实 Catalog。

下列旧约束由本 PRD 明确替代，开发完成时同步更新领域术语、权威设计、工具说明、测试和示例；历史 PRD 标明替代关系，不改写当时事实：

| 旧约束 | 新决定 |
|---|---|
| 不持久化 phase、Node history | 保存粗粒度工作阶段和逐次 Node Execution |
| resolutionContext / Program 参数临时存在 | 执行前保存可安全持久化的工作材料 |
| claim/handoff 随阶段消费后删除 | 提交资格消费与材料保留分离 |
| FAIL 无 onFail 时清掉失败接手材料 | 保留失败材料，但显式回到检查执行，不误走旧 claim 判定 |
| Judge 直接 packet 不含 handoff | 工作单输入和待交付 handoff 成为明确判定材料 |
| Reset 只删当前行且材料随之丢失 | 撤销当前运行资格，已登记历史默认保留 |

### D18：实施顺序与停下来讨论的条件

建议按纵向切片开发，不先铺完整数据库/消息框架：

1. 定义工作单身份、粗粒度阶段和事务保存；完成一个 Manager/Actor → Judge → 后继的真实存储闭环。
2. 将明确恢复与统一中断检查提示接入同一推进路径，验证重启和换人。
3. 在保留 Role continuable Session 跨 Node 复用与边界 compact 的前提下，统一 Role mapping、compact 和派发准备路径；以工作单区分各次执行材料、授权与 Judge 证据。
4. 接入 Program、Child、FAIL 无 onFail、BLOCK/resume 和模型更换。
5. 删除旧状态来源、完成兼容提示与文档同步，再做隔离宿主冒烟。

若开发中发现必须改变 Graph 结果、允许跳节点、绕过 Actor Judge、增加任意代码执行、要求可靠消息基础设施、自动清理外部资源，或必须保留新旧双引擎才能完成，应暂停与用户讨论。

普通字段命名、内部函数拆分、JSON 与列的分配不需要逐项提问；以本 PRD 的行为和简化目标为准。

## Testing Decisions

### T1：测试 Seam 与原则

优先使用既有 **Engine + Host Adapter + 隔离真实 SQLite** 的高层集成 Seam，观察派发到 Actor/Judge 的材料、工具返回、Run/工作单的可读状态和后继是否被创建。

- 不把 DispatchBook 的字段、私有 Map 数量、具体 helper 调用顺序写成新的验收合同。
- State Store 使用临时数据库验证事务与关闭重开，不只用新 Engine 共享同一内存对象代替持久化恢复。
- Host Adapter 用受控假实现注入发送前失败、发送后结果丢失、Session 不可用、重复/迟到结算；不要求在单测里重建全部 DSH 内部实现。
- 对已知阶段，验证按记录继续；对不确定情况，验证材料和提示送达、允许处理人重新检查并完成。不能把未完美重建旧状态判为失败。
- 对安全保护，测试实际拒绝行为：旧提交无权推进、当前 Judge 只读、未经确认不沿 Graph 离开。
- 最后用隔离 DSH home 做真实宿主冒烟，验证一个中断任务由 Role/Manager 检查现场后继续的流程；不使用真实用户 Run 注入故障。

既有测试中的 PASS/FAIL、REJECT、NEED_CONTEXT、deferred handoff、claim lease、Program/Child、Role Session 复用、Node 边界 compact 和状态 round-trip 是回归素材。保留跨 Node compact 与上下文延续的行为验证，具体内部调用链可随封装调整；与已被替代的“材料必须删除”等旧设计绑定的断言应更新，而非机械保留。

### T2：验收标准

| 编号 | 必须观察到的外部行为 |
|---|---|
| AC01 工作单独立身份 | 两次进入同一 Node 和两次调用同一 Child 均产生不同 execution，记录不覆盖；同 Node resume/返工保持该 visit 身份 |
| AC02 材料持久化 | Handoff Context、Root 附加文本、Manager 补充和允许保存的 Program 参数在 SQLite 关闭重开后仍可用于接手 |
| AC03 常规 Actor 链路 | 输入登记 → Actor claim → Judge ACCEPT → 后继收到完整材料，整个路径只有一个有效 Graph 推进 |
| AC04 PASS/FAIL 对称 | completed/failed 对相同材料具有一致存储与派发能力，仅按 onPass/onFail 选择目标 |
| AC05 判定前中断 | claim 已保存但 Judge 未完成时，可直接从工作单继续/重建 Judge，无须默认重做 Actor |
| AC06 交接原子性 | 保存前驱离开和后继登记时故障，不出现半个 Graph 交接；数据库没有后继工作单时，不先启动后继 |
| AC07 派发长尾降级 | prompt 可能已送达但回执未保存时，不要求判明精确投递状态；恢复者收到已有材料与中断检查提示，并能通过检查现场完成任务 |
| AC08 外部工作已完成 | Actor 中断前已产生测试产物但未 claim，接手后识别已有成果并重新提交，经 Judge 后推进，不要求再制造同一成果 |
| AC09 外部工作未完成 | 接手者发现部分完成，补做剩余工作后提交，经 Judge 完成当前 Node |
| AC10 不可判明现场 | Actor/Manager 无法可靠确认外部效果时保持 BLOCK 或请求用户，不由 Engine 猜测成功或盲目执行高影响动作 |
| AC11 Session 不可用 | 旧 Actor/Judge Session 无法恢复时，replacement/fresh Judge 使用工作单继续，不要求修复旧 Activation |
| AC12 Role 复用与边界 compact | 非 Manager 的同一 Role 跨 Root/Child Node Execution（含自环再次进入）复用同一 continuable Session，派发新 Node 前 compact，并继承压缩后的上下文及收到完整当前输入；同一次工作中的补充/返工继续当前 Session，不额外触发 Node 边界 compact。compact 失败时 BLOCK 且保留待派发材料，恢复后可继续。Session 不可用或显式更换时才按 replacement 规则接手；Manager 保留主会话且不执行 Role 边界 compact；Judge 不接收旧 Node 历史/compact 摘要或完整 Manager 历史 |
| AC13 REJECT 修正 | 不走 onFail；同一工作单收到拒绝理由与最近提交；新 claim 替代旧有效提交后再次判定 |
| AC14 NEED_CONTEXT | Manager 补充先保存再发送，发送失败后材料仍在；继续或重建 Judge 都能读到补充 |
| AC15 显式退回 Actor | 待判定时 Manager 选择 actor 恢复，旧 claim/Judge 不再具有当前判定资格，材料仍在，新提交需要新的有效判断 |
| AC16 FAIL 无 onFail | 保持当前 Node 并保留失败材料；默认恢复走检查执行，不因为历史 claim 存在而误发 Judge |
| AC17 Program 不确定 | 程序结果未知时 Manager 取得参数及已知材料，先核实再显式重跑或裁决；记录本身不触发盲目重复副作用 |
| AC18 Child 返回 | Child END 与 Parent 推进关联一致，暂停不丢当前栈顶；旧 Child 迟到结果不能再次推动 Parent |
| AC19 迟到与重复 | 旧 Actor、旧 dispatch/Turn、旧 claim 的 Judge 结果、重复结算均不能推进新轮次；保存提交失败后不伪装已接受 |
| AC20 串行与宿主安全 | 已知活跃旧执行不与后继冲突；退出 event 回调后再做有副作用动作；Judge 提交不自我 drain；只读限制保持 |
| AC21 简单重启策略 | 新 Engine 从真实 SQLite 找到工作单；允许先统一 BLOCK，再按记录恢复或按统一提示检查；不依赖重建全部旧内存状态 |
| AC22 Reset 与历史 | Reset 释放当前运行资格并拒绝旧身份推进，历史标明 Reset 而非完成；新 Run 不覆盖已保留材料。已知旧任务仍活跃时不直接派发冲突的新工作，未知时提示 Manager/用户先核查；不自动清理外部资源 |
| AC23 旧格式保护 | 使用隔离旧库验证：识别不兼容活动 Run 并给出说明，不覆盖、不自动 Reset、不启动第二套引擎；仍有经授权的 Reset/备份退出路径，受控迁移失败时原数据保持可用、不部分切换 |
| AC24 可见状态 | status 能说明当前是谁处理、最近阶段、为何暂停、有哪些有效提交及可选恢复方向；无结果结束不会静默悬挂 |
| AC25 简化交付 | 开发报告列出已删除的隐式状态、重复恢复路径及已收敛的 Role mapping/compact 调度逻辑；不以删除 Role 复用或 Node 边界 compact 充当简化成果；工作单不是旧 pending 系统之外的第二套权威来源 |
| AC26 恢复目标与提示职责 | judge 目标拒绝已经确认的 FAIL 或其他终局结论，actor 目标不能重开已离开节点或覆盖可交接结论；不适用的节点类型被拒绝。Judge 恢复提示只要求核验，不要求补做；Actor 接手提示明确先检查再继续 |

### T3：验证结果的记录规则

- 运行构建/类型检查、单测和隔离 e2e；真实宿主冒烟单独记录。
- 故障注入测试证明的是明确的外部行为，不宣称覆盖所有宿主崩溃组合。
- 未运行或被环境阻断的验证明确标记，不记为通过。
- 本 PRD 编写阶段不执行上述开发验收，不以现有测试通过代替本次重构验收。

## Out of Scope

1. 完整 event sourcing、全量 Session 日志复制与精确事件回放。
2. 对全部派发、Turn 或外部 Effect 的 exactly-once 保证。
3. 为每种 Git/GitHub/SSH 动作建立专用恢复状态机、回执仓库或自动补偿。
4. 无限重试、跨宿主分布式调度、PID takeover、租约服务、消息中间件。
5. 无人值守恢复所有故障的强制承诺；但不禁止记录明确时的低成本继续。
6. 动态改 Graph、任意 jump/skip/force-pass、新增多结果 Edge 或并行 Workflow Node。
7. 让 Manager 或 Actor 绕过 Actor Task 的独立 Judge。
8. 为所有 Program 和 Child 强制增加 LLM Judge。
9. 独立团队聊天系统、自由角色互相启动其他 Node、完整消息路由平台。
10. 通用业务变量、typed data-flow DSL、任意脚本 Program 注册。
11. 新增 Workflow token 阈值策略或复杂 compaction 调度系统；保留并收敛 Role 的 Node 边界 compact 不在此排除项中。
12. 完整历史 Web UI、复杂报表、后台归档搬迁和清理策略；正常保存已结束 Run/工作单不在此排除项中。
13. 旧活动 Run 的完美迁移、长期新旧双状态引擎。
14. 自动部署本插件、改写真实 Catalog、恢复真实 Run 或处置现有分支/Issue/外部资源。

## Further Notes

### F1：用户最新澄清优先于前一轮分析中的收窄表述

用户并未规定“执行记录只用于保留材料、不用于自动恢复”。本 PRD 不采纳这一错误收窄。

用户明确允许在 SQLite 登记执行过程以恢复流程；只是在完整恢复需要过高复杂度时，允许牺牲精确还原，让 Actor/Manager 判断现场，或在重派时注入中断检查提示。

因此，本 PRD 的目标是 **常规路径有据可恢复，长尾情况能低成本接手**，不是“全部人工恢复”，也不是“全部自动恢复”。

用户进一步明确：**Role subagent 在整个流程中复用、是 continuable 的，不同 Node 继承之前的上下文，只是在进入下一 Node 时 compact。** 本 PRD 据此撤回前一版“非 Manager Actor 每个 Node Execution 新建 Session、删除跨 Node compact”的决定。Node Execution 独立的是工作记录和执行资格，不是 Role Session 的生命周期。

### F2：与现有文档和待办的关系

- 当前领域术语和既有 Graph 设计仍描述现网实现；本 PRD 中列出的替代项是后续开发目标，不在文档编写阶段把旧实现描述为已经升级。
- 既有 [Handoff Context 对称传递需求](https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/prd/20260906-claim-handoff-symmetry/requirements.md) 的 completed/failed 对称和 opaque 交接原则保留；其 FAIL 无 onFail 删除材料、Judge packet 不含 handoff、保持最小状态的局部决定由本 PRD 指定的新行为替代。
- 既有 [Workflow hardening 总览](https://github.com/hua0424/dsh-workflow-plugin/blob/main/docs/prd/20260903-workflow-hardening/README.md) 中的 Judge 确认、迟到提交防护、只读原则、Role Session 在同一 Run 内跨 Node 复用与 Node 边界 compact 继续保留；本 PRD 只要求相关宿主细节集中封装，不取消这些行为。
- 既有 [Issue #5：按 workflow token 阈值执行 Role Actor Node 边界 compact](https://github.com/hua0424/dsh-workflow-plugin/issues/5) 同样基于 Role 复用与 Node 边界 compact，不再因“每 Node 新 Session”与本 PRD 对立。本 PRD 按用户本次澄清要求进入下一 Node 时 compact；是否另行采用阈值、在哪些边界允许跳过，由该 Issue 后续明确，不能在本 PRD 实施时默认为已批准。本次不自动关闭或修改该 Issue。

### F3：交付物与开发对齐

后续开发交付至少包括：新的运行实现、存储升级/旧活动 Run 处理说明、测试证据、旧复杂度删除清单，以及领域术语/权威设计/工具提示/示例的同步更新。

评审首先询问：工作单是否能被独立接手；普通推进和恢复是否共用路径；长尾是否统一降级；旧状态体系是否真正删除。不能仅以新增表、增加状态枚举或补齐更多精确恢复用例宣布完成。

本文中的行为与 AC 编号是后续开发和评审对齐依据。若 implementation 为覆盖少数罕见情况重新引入大量恢复机制，应回到 D1/D7 重新评估，而不是把复杂度增长视为理所当然。
