# Domain Glossary

> `refact` 当前为 T5 集成态，未部署。目标架构见 `docs/design/node-execution-runtime.md`，当前工单范围见 `docs/work-plans/runtime-refact.md`。以下区分已接通行为与后续票，不能据此操作真实 Run。

## Agent Team Workflow / Manager

插件按不可变 Graph 串行组织 Manager 与固定 Role Actors。Manager 是启动 Run 的主会话，负责启动、查看状态、处理 BLOCK，也可承担 `role: manager` 的 Actor Task；即使 Manager 执行，也必须经独立 Judge 确认 claim。

一个 canonical workspace 最多一个未结束 Root Run。Manager ownership 固定，其他 Session 不能接管推进。授权使用真实调用 Agent，不信任模型自行声明 Session 身份。

## Workflow Configuration / Definition Snapshot

Catalog 位于 `${DSH_HOME:-$HOME/.dsh}/workflows/<workflow-id>.yaml`。schema 为 `agent-workflow/v2`，受限单文档 YAML 1.2，禁止 duplicate key、anchor/alias/merge、custom tag、模板插值及外部引用。文件名必须是小写 `[a-z][a-z0-9-]*.yaml` 普通文件；每次 list/start fresh 扫描，invalid 文件只阻塞自身。

Run 启动校验、规范化并固定完整 Definition Snapshot 与 hash。运行中不读取新 YAML 改图。Root startNode 必须是 `actor-task role:manager`。Graph 只有 PASS/FAIL 路由，END 是终点而不是结果。

## Run

`runs` 保存 Run identity、workspace、固定 Manager/Snapshot、status、`currentExecutionId`、callStack、Role mappings、modelOverrides、row CAS version 及时间。节点材料不镜像在 Run。

T3 status 为 `running|blocked|completed`。BLOCK 仍占 workspace；新 Run 不覆盖已完成历史。completed 的 `currentExecutionId` 仍指向终局工作单，callStack 为空；最终 handoff 从该工作单读取，无 Run.finalHandoff。

Run.blockReason 仅用于 Run 控制故障；节点暂停原因属于工作单，status 从工作单投影，不重复写两份原因。当前 Runtime 的节点 BLOCK 只写工作单原因。

## Run Frame / 当前位置

callStack 的 workflowId/nodeId/nodeToken 必须与当前工作单一致；Store 在同一事务内校验更新。它不是独立推进入口。新 visit 产生新 execution ID 与 token。

nodeToken 是控制面过期检查，不是授权凭证。**旧 Turn 即使查到最新 token，也不能取得新 dispatch 的 claim/block/Judge 权利。**

## Node Execution（工作单）

`node_executions` 是一次 Graph visit 的当前事实。每次沿 Edge 进入（包括自环、回边）创建独立 execution；REJECT、补充、普通 resume 与 Judge respawn 更新同一单，完整重启/replacement 仍由 T6 收口。

工作单保存 input 快照、phase、Actor 安排与真实 Host message ID、Node-local 投影边界、当前 claim/Judge/判定、版本与暂停原因，以及前驱/后继关联。input 进入时固定，不被前驱修改或后续补充覆盖。

phase 为 `ready|working|checking|settling|exited`：表示已登记业务事实，不表示宿主瞬时状态。working 不证明消息已送达；checking 不证明 Judge 已启动。BLOCK 保留阶段与材料。exited 材料不可变，只允许为待派发后继补记前驱 Judge 安全收口元数据。

## Node Execution Events

`node_execution_events` 只追加关键快照：进入、Actor/Judge安排、claim、judgment、离开、BLOCK。事件在同 execution 内使用稳定递增 sequence；时间仅供显示。

状态与对应事件同事务。ACCEPT 的 judgment、前驱离开、后继 input/进入事件、Run 指针同事务；失败全部回滚，同一真实提交可重试，成功后重复提交不能二次推进。

正常继续读当前工作单，历史解释读事件。不回放事件恢复；不建 attempt、outbox、effect 或 recovery-job 表。`workflow_status({executionId,after?,limit?})` 向当前 Run Manager 提供稳定 sequence 的前向分页（每页最多 50）；Role/Judge 与跨 Run execution 拒绝，默认无参仍只给当前摘要。

## Node Claim / Handoff

Actor 的唯一业务提交是 `node_claim({outcome: completed|failed, handoff})`。handoff opaque、trim 后 1..8000 字符，两种 outcome 完全对称，END 也必填。`normalizeNodeClaim` 同时保护工具与 Runtime；旧 summary/handoffContext 及额外业务字段明确拒绝。

handoff 说明实际结果、产物位置与核验依据、剩余问题和后续约束。Judge、Manager 预览、后继 input 与最终交付共用这一文本，不另造摘要或 fallback。额度不足/缺条件/临时无法继续应 BLOCK，不伪报 failed。

## Dispatch / Claim 身份与 CAS

execution ID 标识 visit；dispatch.id 标识一次安排；真实 Host 返回的 Session/message ID 与 caller 当前 Turn 的 user/message ID 集合共同绑定来源；claim.id 标识一次结果；Judge 安排绑定 claim.id 与 inputVersion。row revision 只仲裁竞争，不能替代任一身份。

安排先持久化，再调用 Host。Host 返回后重新验证当前 execution/dispatch/claim 与 CAS version，才发布实际 message ID。admission→返回窗口内无法证明来源的调用 fail-closed，可重试；不建恰好一次投递平台。

没有内存 DispatchBook 作为独占材料或 lease 权威。Actor claim 的 phase/claim 原子写入就是消费资格；失败事务不消费，重复或旧 dispatch 提交拒绝。Manager 当前是 Actor 时同样必须绑定真实 dispatch；Manager 对 Role 节点的 BLOCK 才是无 lease 的控制面动作。

## Role Definition / Role Actor

Role Definition 定义 persona、model route 与 tool restrictions，Preset 提供基础环境。Role mappings 属于 Root Run，跨 Node 复用 continuable Session；工作单独立不意味着每 Node 创建新 Session。Manager 不建 Role mapping，不 compact。

Role 首次使用创建 Session；再次承担新 visit 前先确认无冲突活动，再执行 Node 边界 compact，之后用 exact Host queue 交付本次 input/instruction/criteria。T1 已对齐 `queueHostSubagentPrompt` 与 `snapshotEvents()`，不用 nearest-step sendMessage 替代独立派发。

T5 已把 `jobs`、`compaction` 设为标准 Web composition 的 required service，并在 Host Adapter 内用正式接口完成 cold resume（无 prompt）、idle maintenance、释放和原 Session Queue 续接。成功与合法 no-range 可继续；busy、压缩/resume/dispose 失败均不伪装成功，工作单保留并 BLOCK。完整中断恢复/replacement 留 T6。

## Judge Role / Judge Agent

Judge 是独立只读检查者，不补做 Actor 工作，不改写 claim outcome。首次判断和 respawn 创建 continuable Judge；NEED_CONTEXT 补充可复用同一 Session，但每次都先登记新的 Judge dispatch，再以 Host queue 开新真实 Turn，并在真实 message ID 返回后才允许该 Turn 提交。

Host 用真实 tool allow-list 限制 read/glob/grep/read_image 和 workspace/repository 限定的 workflow_inspect_git/workflow_inspect_github，并授予专用 judge_claim；spawn 后检查最终工具面，异常 fail-closed。Actor/Manager 不能冒充 Judge。

Judgment Packet 来自本次工作单 input、instruction/criteria、claim.handoff 与本次 dispatch 的 Node-local projection，不从旧 Run.nodeBoundary/pendingClaim 镜像读取。投影排除旧 Node、system/tool/notice 与提交约束，不注入完整 Manager 历史。

`judge_claim({nodeToken,result,reason})` 的真实 caller Turn 绑定当前 Judge dispatch，且必须匹配 claim/input version。ACCEPT 后 completed→PASS、failed→FAIL；有合法出口才原子交接。REJECT 在同 execution 保存完整旧 claim 与 Judge/input 关联、使当前资格失效并重派原 Actor，不走 onFail/新 visit/compact；NEED_CONTEXT 保留当前 claim 并 BLOCK。Manager 的完整当前补充先入库/事件、递增 inputVersion，再开 Judge followup；失败仍保留材料，旧 Turn 无效。

## 安全收口 / Host Adapter

claim 入库之后先等待**对应真实 Actor Turn**安全收口，才启动 Judge。旧 Session 的其他 Turn/end 不能结算当前 visit。interrupt 回执不代表工具/后台任务已经停止。

session/event 同步回调只捕获该 turn/end 对应的精确消息集合和 Agent 生命周期引用，退出 append publication lock 后由 setImmediate 触发 Runtime。Host 使用正式 jobs、whenIdle、inbox、durable descendant 与 live registry 检查当代/observed exact Agent：durable inactive descendant 无 Activation 可通过；running 却不可观察、live 非 idle、pending inbox、非 terminal job、diagnostic 或 orphan 证据均 fail-closed。orphan 不因 job 行消失洗白，插件 effect 清理观察引用。这里只保证可观察 Host 活动，不证明未登记外部副作用停止。

Judge ACCEPT 工具内只提交事务和撤权，**不 await 自己 whenIdle/drain**。后继派发由该 Judge 工具返回后的精确收口事件驱动。Root END 已完成时，Actor 已在判断前安全收口，撤权后的只读 Judge 不因缺失最终 turn/end 另占 workspace 或形成新的业务锁。未结束 Run 的 cold/无可靠证据活动仍保守 BLOCK；恢复/授权退出由 T6/T8 接通。

SQLite 事务与状态队列不包 spawn/compact/网络/Program 长调用。index 不再把完整 Engine Promise 放进 workspace enqueue；每个外部返回后重新验证身份版本。

## BLOCK / 暂未接通范围

T4 支持显式 node_block、Actor 未提交结果、Judge 未提交结论、NEED_CONTEXT、派发/compact/安全收口故障的可见 BLOCK；材料保留。`node_resume` 仍是 Manager-only/current BLOCK，可选 auto/actor/judge 并拒绝已 exited、不适用阶段或可交接结论；`judge_respawn` 仅在有效 claim 下重建并撤销/收口旧 Judge。Actor/Judge 争议协议由插件统一注入，Manager 补充不改冻结 Snapshot/criteria。重启默认 BLOCK 未结束 Run，不猜测外部效果。

以下入口在 refact 集成期明确拒绝，无旧引擎 fallback：

- T6：完整 Role replacement、冷重启与未知外部进度恢复；T5 只完成正常运行内的 Role Session 复用、Node 边界 compact 与可观察 Host 安全收口。
- T7：Builtin Program、Child Workflow、FAIL 无出口重开与 model replacement 控制。含 Program/Child 的 Root 图在启动前拒绝；已有 onFail 的 Actor FAIL 对称交接已支持。
- T8：授权 Reset/terminated 与旧格式备份退出；当前 Reset 不删除材料。

Program 的目标合同为参数先存再执行、确定结果交接、不确定效果先核查；Child 的目标合同为输入/最终 handoff 逐层传递及共享 Role mappings。它们当前不是已实现能力。

## Workflow State Store / 可观察性

使用内置 node:sqlite、WAL、单连接短事务；SQL active-workspace unique/FK 与 Run/Execution CAS 共同保护位置。旧 workflow_state 有行、未知格式/坏快照必须明确拒绝，保留原数据，不静默迁移或创建空库遮盖。T5 为新 visit 的 Role 边界准备事实将 State format 升为 `agent-workflow-state/v6`；旧 v3/v4/v5 同样 fail-closed，不静默迁移。

命令仍是 `/dsh-flow list|start <id> [extra text]|status|reset`，Root extraText 在首次派发前作为 input 保存。默认 status 只展示当前 execution/phase/角色/原因、input/handoff 有界预览与恢复方向，不暴露完整 claim、previousClaim、Manager context 或内部 dispatch；最终通知 best-effort，失败不撤销终局事务。

trace 是派生产物，不是业务 events。T4 沿用 trace helper 的转义/脱敏/失败容忍，记录已提交的 START/CLAIM/JUDGE/ROUTE/BLOCK；不通过 trace 恢复。旧先trace后State的 orphan 时序与后续票专属细日志需 T9 收敛验证。

## 测试与交付

最高测试 seam 是真实 Workflow Runtime + 临时 SQLite + 受控 Host Adapter；关键来源测试使用精确派发 ID 集合。`scripts/t3-smoke.mjs` 保留 ACCEPT 基线，`scripts/e2e-smoke.mjs` 已迁移为 T4 的 REJECT/failed-onFail/修正闭环；二者都使用独立临时 home，不操作真实 Run，也不冒充 A30 真实宿主验证。

旧全量 engine/state 测试仍待按 T5–T9 迁移，失败必须列明，不通过删除/skip 有效测试伪装全绿。真实宿主 A30、完整恢复/Graph/授权退出及整体验收仍由对应后票完成。
