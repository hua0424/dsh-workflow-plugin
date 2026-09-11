# Node Execution Runtime：工作单驱动的串行 Workflow

- 状态：T6–T9 实现与 A01–A30 自动化验收已冻结，待父代理最终 Standards/Spec 审查和 commit；未部署。验收证据见 [`node-execution-runtime-acceptance.md`](../testing/node-execution-runtime-acceptance.md)。
- 运行基线：DSH `0.1.2-rc.1`；源码与索引位置见根目录 `AGENTS.md`。
- 开发规格与实施切片：[node-execution-runtime spec](../specs/node-execution-runtime.md)；开发入口：[Issue #7](https://github.com/hua0424/dsh-workflow-plugin/issues/7)。
- 替代关系：本设计及对应 spec 替代 [旧 PRD](../prd/20260907-node-execution-simplification/requirements.md) / [Issue #6](https://github.com/hua0424/dsh-workflow-plugin/issues/6) 的开发入口。旧 PRD 保留为历史，不再独立派发开发。

## 1. 设计目标与不变规则

插件组织固定职责的人员按不可变 Graph 串行完成任务。SQLite 记录已经确认的流程事实，DSH 承担 Agent 对话和执行；Actor/Manager 用智能检查补足无法低成本确定的业务进度。

1. Run 启动时校验并保存完整 Definition Snapshot；当前 Run 不随 YAML 修改而变化。
2. 一个 canonical workspace 最多一个未结束 Root Run，BLOCK 仍占用此资格。Root/Child 共用该 Run 的 Role mappings；Child 不另占 workspace。
3. 任一时刻只有当前实际工作位置获得推进权。Parent 调用等待 Child 时不能自行推进。
4. Actor Task 的 claim 必须经独立只读 Judge；ACCEPT 才按 `completed → PASS`、`failed → FAIL` 路由。
5. Builtin Program 用其确定性结果确认；Child END 是父调用的 PASS 依据，不额外要求 LLM Judge。
6. BLOCK 是可恢复暂停，不是 Graph FAIL；REJECT 是当前工作返工，不沿 onFail 离开。
7. Role Actor 在整个 Root/Child Run 内复用 continuable Session，承担下一 Node Execution 前执行 Node 边界 compact。工作单独立不等于 Session 独立。
8. 同一工作单内补充、返工、恢复默认续接原 Actor；Session 不可用或显式换人时允许 replacement。
9. 常规按记录继续，长尾交给 Actor/Manager 检查现场；不追求完整复原 Turn、全部消息投递和外部副作用。

## 2. 三个持久对象

### 2.1 `runs`：流程位置与运行控制

一条记录对应一次 Root Workflow 启动；结束后保留，新 Run 不覆盖旧 Run。

保存：Run ID、canonical workspace、Manager、Definition Snapshot、整体状态、当前 execution 指针、必要的 Child 调用信息、Role → Session ID 映射、模型覆盖、并发更新版本与生命周期时间。

整体状态区分 running、blocked、completed、terminated。Reset 撤销当前运行资格，记录 terminated，不伪装成 completed，也不删除材料或自动清理外部资源。

Run 不镜像当前 claim、Judge 意见、handoff、Manager 补充等节点材料。调用栈与当前指针若都存储，必须在同一事务内维护并校验一致，不成为两套独立位置来源。

### 2.2 `node_executions`：一次进入的当前工作单

沿 Graph 每次进入 Node 创建新 execution ID，包括回边、自环及 Child 的再次调用。resume、REJECT 返工和 replacement 更新同一工作单，不新增 visit。

| 字段组 | 责任 |
|---|---|
| 身份与关系 | execution ID、Run/workflow/node、进入顺序、父调用及前驱/后继关联 |
| 输入 | 进入时的 input 快照、冻结 instruction/criteria 的引用 |
| 工作材料 | Manager 补充、最近返工依据、恢复说明；材料有界 |
| 当前阶段 | ready / working / checking / settling / exited |
| 执行授权 | 当前 Actor/Program、派发身份与宿主关联、当前 Judge 安排、提交版本 |
| 当前结果 | 有效 claim、绑定该 claim 的 Judge 结果、Program 参数/已知结果 |
| 暂停与时间 | 最近暂停原因及恢复信息、进入/离开时间、并发更新版本 |

列保存需要校验、关联、查询的控制字段；成组业务材料可用 JSON。无需把每个概念拆为单独表。

input 是进入时快照，不被 Manager 补充或前驱的后续修改覆盖。Actor 的 claim 是候选交付，Judge 接受后才作为后继 input；不维护一个可被任意节点改写的全局任务对象。

当前 claim/judgment 可以被后续版本替代；最近纠正意见保留在当前工作单供直接继续，完整关键历史保存在明细表。旧材料存在不意味着旧提交仍然有效。

各执行类型的交接统一为一份文本，来源明确：Actor 使用已接受的 claim.handoff；Builtin Program 可由其固定实现返回安全、有界的 handoff，没有新交付文本时透传该工作单原 input，不自动 stringify 任意 details 或另造 summary。Program 参数/结果另外保存供核实，新增业务产物标识等需交接的信息由相应 Program 显式写入 handoff。

Child 首节点接收调用工作单的 input；Child 最后节点按自身执行类型形成的最终交接文本，作为父调用工作单的结果传给父后继，嵌套 Child 逐层遵循同一规则。父调用不能用调用前旧 input 覆盖 Child 最终输出，Child 返回不额外安排 Judge。

### 2.3 `node_execution_events`：只追加的关键流转明细

增加第三张表的目的，是用户明确提出的返工追踪、判定争议和过程解释，而不是实现事件回放或精确自动恢复。

每行保存 execution ID、该 execution 内有序事件号、时间、事件类型、操作者/派发/claim 关联以及当时的有界材料快照。

第一版记录以下关键业务事实：

- 进入工作单。
- 安排 Actor/Judge/Program；表述为派发意图，不声称已送达或已执行。
- Actor 提交 claim，保存 outcome 与完整 handoff。
- Judge 提交 ACCEPT / REJECT / NEED_CONTEXT，保存判定依据及所针对的 claim/判定输入关联。
- BLOCK、Manager 补充与 resume。
- Program 确定结果或 Manager 裁决。
- 离开工作单；Reset 的终止记录挂到当前工作单，不冒充正常离开。

当前状态更新与对应关键事件插入放在同一 SQLite 事务中；事件插入失败则该次业务更新也不提交。时间戳只供显示，排序与去重使用稳定事件序号/提交身份。

不记录每次模型 token、工具调用、普通聊天和隐藏推理；不创建独立 attempt、message、outbox、recovery-job 表。没有完整历史回放承诺。

**恢复读当前工作单，解释过程读事件明细。** 明细可以帮助 Manager 查争议，但正常恢复不需要扫描整条事件流重建状态。原有 trace 仍是 best-effort 调试产物，与这张业务明细表不是同一合同。

## 3. Actor 结果合同：只保留 outcome 与 handoff

Actor claim 的业务内容统一为：

- `outcome: completed | failed`。
- `handoff: string`：必填、非空、有界的结果与交接说明；completed/failed 使用同一长度与校验规则。

取消独立 `summary` 字段。Manager、Judge、后继 Actor 和最终用户读取同一份 handoff；状态展示可截取其预览，不新增模型摘要、持久化 summary 或隐式 fallback。

handoff 应说明实际完成/失败的内容、产物位置与核验依据、剩余问题和约束、后续需要的信息。到 END 时仍提交，作为最终结果材料。

插件把 handoff 作为 opaque 文本保存和传递，不引入业务变量、自动对象合并、输出绑定或任务数据流 DSL。内容要求由通用提示与当前 criteria 核验，不强制新增结构化业务字段。

这是对旧工具合同的显式破坏性调整：新提示与 schema 同步移除 summary，不维持运行时双协议。Host 所需的 nodeToken/调用身份是控制合同，不由 outcome/handoff 替代。

`failed` 是业务失败声明；额度不足、缺少条件、临时无法继续或判定争议应使用 BLOCK，不为了退出执行而伪报 failed。

## 4. 阶段与暂停

| 阶段 | 数据库知道的事实 | 下一责任 |
|---|---|---|
| ready | 工作输入已登记，需要安排执行 | Actor / Program / Child 调用 |
| working | 已登记本次执行安排，尚无有效提交 | 等待，或恢复后检查进度 |
| checking | 当前有效 claim 已保存，尚无有效判断 | 等安全收口后安排 Judge |
| settling | 有有效业务结论，尚未完成离开 | 事务交接，或无出口时 BLOCK |
| exited | 已结束该次 Graph 职责 | 不可重新恢复该 visit |

working 不证明现在仍有活跃 Actor，也不证明外部动作已发生；checking 不证明 Judge 已启动。它们是业务阶段，不是宿主精确运行状态。

BLOCK 保留原 phase 与已有材料，增加原因，不新增 quota/network/persistence 等 phase。Run-level 故障可记录 Run 控制原因，节点故障以工作单原因为权威，避免重复镜像。

REJECT 使当前 claim 的判定资格失效，保留历史和最新拒绝依据，同一 execution 回到 ready。FAIL 无 onFail 则保留已确认失败，停在 settling 并 BLOCK；resume 重开本次工作版本，把旧失败转为历史，不能把它误当未判定 claim 再派 Judge。

## 5. 一个推进器，统一正常执行与恢复

start、Actor claim、Judge 提交、有效宿主结算、Manager resume 都进入同一个 Runtime 的状态转换/推进路径，不各建一套派发和恢复逻辑。推进器按触发运行，不引入后台轮询框架。

### 5.1 普通 Actor 路径

1. 一个事务创建 Run 和首个工作单/进入事件。
2. 在外部派发前持久化本次安排、必要身份和工作材料。
3. Host Adapter 取得/续接 Role；新 visit 先按规则 compact，再交付当前输入。
4. Actor claim 入库，并插入 claim 快照事件；失去本次重复提交资格。
5. checking 阶段等待该 Actor 派发安全收口，再让只读 Judge 核验。
6. 校验 Judge 结果的当前身份、claim 及判定输入版本，确定状态转换；有合法出口的 ACCEPT 不先单独提交判定。
7. 若有合法出口，在同一个事务中提交：判定/结果及事件、前驱离开、后继工作单/input/进入事件、Run 指针与 Child 栈更新。ROOT END 同样原子结束。REJECT、NEED_CONTEXT 或 FAIL 无出口时，单独原子提交对应判定/事件与返工或暂停状态，不伪造交接。
8. 事务提交后再安排后继。settling 可以是该事务中的短暂概念，不强制额外一次写入。

REJECT 与 NEED_CONTEXT 进入同一状态转换路径。重复触发必须先看当前阶段与已登记安排，不能重复创建后继或反复发送当前活跃工作。

### 5.2 外部调用不是 SQLite 事务的一部分

短事务和必要的 workspace 串行写入只保护本地事实；spawn/followup、compact、模型、网络、Program 长调用都在事务与状态锁外。返回时重新验证当前 execution、派发和版本，过期结果不得覆盖新状态。

SQLite 提交和宿主投递之间存在窗口，不能通过多记几个字段消除。安排记录不等于投递成功；消息接受也不等于工作完成。窗口内崩溃进入普通恢复策略，不另建可靠消息平台。

## 6. 恢复策略

### 6.1 没有中断记录也必须能恢复

断电、进程退出时可能根本来不及写入 BLOCK。重启后数据库仍可能是 working/checking；恢复以最近记录为起点，不依赖成功执行了异常处理器。

最小默认策略允许启动时把未结束 Run 置为可恢复 BLOCK，保留阶段和材料，Manager 恢复后继续。记录明确且宿主条件满足的路径也可低成本自动继续，不强制所有恢复人工化。

| 已确认事实 | 恢复动作 |
|---|---|
| ready 且材料完整 | 按普通入口派发；投递可能已经发生时附带检查提示 |
| working，没有有效 claim | 默认续接同 Role，先检查现场再继续；不可用时 replacement |
| checking，有有效 claim | 在安全条件满足后继续或重建 Judge，不默认重做 Actor |
| settling，有可交接结论 | 按记录事务交接，不重复业务动作 |
| 前驱 exited、后继已登记 | 只处理后继，不重新推进前驱 |
| 等待补充 | 先保存 Manager 补充与事件，再继续对应处理人 |
| Program 结果未知 | Manager 核实后显式重试或裁决，不盲目重跑 |

### 6.2 统一提示，不穷举异常

Actor 或承担执行职责的 Manager 收到：

> 本任务此前执行中断。请先核对已保存材料与实际完成情况。已完成的部分不要重复产生副作用；未完成的部分继续或补做。完成后重新提交 outcome 和 handoff。无法可靠判断或需要额外权限时，请说明情况并请求 Manager 处理。

Judge 收到只读核验提示：基于当前有效 claim、当前判定材料和只读现场继续/重新检查，不补做被核验工作。信息不足使用 NEED_CONTEXT。

允许重复模型检查和重新提交，不承诺原 Turn 原地恢复或外部效果 exactly-once。数据库损坏、ownership、Definition Snapshot 或 Graph 位置错误必须停止，不能让 Actor 猜测后修库。

## 7. Role、Judge 与宿主职责

### 7.1 Role 上下文延续

Role mappings 归 Root Run。DSH continuable 持久的是 Session 身份，不保证 live Activation 一直存在；冷续接沿用同一 Session，而不是正常新建 Actor。

Actor 再次承担新 Node Execution（包括自环）前执行 Node 边界 compact，随后接收明确的当前 input、instruction（+ correction/resolution/recovery/引擎提交要求）、补充和适用提示，不含 criteria；criteria 仅进 Judge packet 作为判定依据。同工作单返工/resume 不额外触发 Node 边界 compact。

compact 需要合适的 idle live Agent。Host Adapter 封装冷物化/维护/释放等宿主细节，区分成功、有明确语义的无可压缩范围 no-op、busy 和失败。busy 不能伪装为压缩成功；失败保留材料并可恢复 BLOCK，不绕过必要准备直接派发。

Manager 主会话不创建 Role mapping，不执行此 Role compact。模型覆盖仍由 Manager 控制，必要 replacement 更新映射和派发资格，保留工作单材料。

### 7.2 Judge 独立性与版本

Judge 根据冻结 criteria（权威判定依据）、claim.handoff、最近拒绝依据、Manager 补充及只读现场判断；另有边界内 Node-local 投影（executor 首条 dispatch 只保留 `[handoff]`）与可选 previousFeedback / Manager context / 中断恢复段。必要的 Session 投影限定当前 Node-local 材料，排除旧 Node 历史/compact 摘要及完整 Manager 历史。

每轮判断绑定具体 claim 与本轮判定输入；补充改变判定输入、Actor 重新提交或 Manager 退回 Actor 后，旧 Judge 不能提交针对旧输入的有效结论。REJECT 后重新提交创建新的判断安排，不只覆盖一段无关联的 judgment 文本。

使用 DSH 工具限制实际约束只读，不只写一段提示词；Actor/Manager 不能强制把未经独立确认的 claim 改为 ACCEPT。

### 7.3 程序必须保证的安全规则

- execution ID 标识 visit；dispatch 身份标识本次安排及其宿主 Turn；claim 版本标识该次结果。数据库 row revision 仅用于竞争更新校验，不替代这些身份。
- 同一 Session 跨 Node 复用，因此迟到 claim/turn-end 不能仅凭 Session ID 或模型查到的最新 token 取得新工作资格。绑定宿主真实来源，不信任模型自行声明内部关联。
- claim 入库不等于 Actor 已结束。Judge 现场核验、下一 Node compact 与派发都必须满足必要收口条件；已知后台写任务未结束时不能只凭 turn/end 判断安全。
- 宿主 turn/end 是触发核对的事实，不是 PASS，也不一定意味着调用栈已完全退到 idle。退出事件回调后再做状态变更/维护与消息发送；不在 Judge 自己的提交 Turn 内 drain 自己。
- interrupt 返回是取消请求被接受，不是停止完成。replacement/Reset 撤销的是 Workflow 推进资格，不会自动停止旧普通文件或外部操作。
- 已知冲突执行未停止时不启动新工作；无法可靠确认且有冲突风险时保持 BLOCK，由 Manager/用户核查，不建设无限探测系统。

## 8. Judge 争议复用 BLOCK/resume

Actor 收到 REJECT：认可则修正并重新 claim；不认可、超出范围或无法按意见执行，则 node_block，说明有争议的判断、证据、阻碍及希望 Manager 决定的事项。

Manager 查看当前工作单和关键事件，可补充信息、澄清既有要求、安排重新提交，必要时更换执行者/判断安排。恢复仍遵守 Graph 和 Judge 门控；澄清不能静默改写冻结 criteria。

不新增 appeal 工具、争议状态机或自动 Actor/Judge 辩论循环。

协作规则由插件统一注入 Actor/Judge 执行协议：

- Actor：认可拒绝则修正；与可验证事实或当前要求冲突时 BLOCK 并提供依据，不为迎合 Judge 伪造结果。
- Judge：REJECT 指明不符合哪项既有要求、事实依据和需要修正之处；信息不足/要求不明用 NEED_CONTEXT，不把个人偏好当新增 criteria。

Node criteria 只定义该节点的业务验收要求；Role persona 定义专业职责。用户不必在每个 Node 重复编写上述协作协议。

## 9. 三个核心 Module，复用现有入口

- **Workflow Runtime**：拥有工作单状态转换、Graph 路由、授权有效性、统一推进与恢复方向。Graph 是内部简单逻辑，不引入通用状态机框架。
- **SQLite Store**：三张核心业务表、短事务、条件更新、约束、快照/明细查询与兼容性检测。使用已有 node:sqlite，不引入 ORM。
- **DSH Host Adapter**：Role/Judge 生命周期、compact、权限限制、实际 Turn 关联、安全收口与派发。业务 Runtime 不探测宿主各个内部状态。

沿用现有 Catalog 校验、工具/命令授权和内置 Program 入口。Module 是职责分配，不要求新建三层类或转发 Interface。最高层测试 Seam 为实际 Runtime + 临时 SQLite + 受控 Host Adapter，再做隔离 DSH home 冒烟。

## 10. 明确不建设的内容

不建设完整事件溯源、消息恰好一次、外部 Effect 回执/补偿体系、后台恢复调度平台、全量日志存储、通用 Executor/Checker 注册框架、跨 Node 自由通信总线、历史 Web UI、自动清理外部资源。

三张表不是增加三套状态来源：Run 管位置，工作单管当前工作，明细管历史解释。新增字段或恢复分支必须说明它替代了什么推断；只叠加新表、保留全部旧 pending 镜像和恢复分支，不算本次重构完成。
