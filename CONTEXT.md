# Domain Glossary

> `refact` 当前为 T6–T9 实现与整体验收冻结、待父代理最终 Standards/Spec 审查和提交的集成态，未部署。目标架构见 `docs/design/node-execution-runtime.md`，A01–A30 证据见 `docs/testing/node-execution-runtime-acceptance.md`；不能据此操作真实 Run。

## Agent Team Workflow / Manager

插件按不可变 Graph 串行组织 Manager 与固定 Role Actors。Manager 是启动 Run 的主会话，负责启动、查看状态、处理 BLOCK，也可承担 `role: manager` 的 Actor Task；即使 Manager 执行，也必须经独立 Judge 确认 claim。

一个 canonical workspace 最多一个未结束 Root Run。Manager ownership 固定，其他 Session 不能接管推进。授权使用真实调用 Agent，不信任模型自行声明 Session 身份。

## Workflow Configuration / Definition Snapshot

Catalog 位于 `${DSH_HOME:-$HOME/.dsh}/workflows/<workflow-id>.yaml`。schema 为 `agent-workflow/v2`，受限单文档 YAML 1.2，禁止 duplicate key、anchor/alias/merge、custom tag、模板插值及外部引用。文件名必须是小写 `[a-z][a-z0-9-]*.yaml` 普通文件；每次 list/start fresh 扫描，invalid 文件只阻塞自身。

Run 启动校验、规范化并固定完整 Definition Snapshot 与 hash。运行中不读取新 YAML 改图。Root startNode 必须是 `actor-task role:manager`。Graph 只有 PASS/FAIL 路由，END 是终点而不是结果。

## Run

`runs` 保存 Run identity、workspace、固定 Manager/Snapshot、status、`currentExecutionId`、callStack、Role mappings、modelOverrides、row CAS version 及时间。节点材料不镜像在 Run。

status 为 `running|blocked|completed|terminated`。BLOCK 仍占 workspace；completed/terminated 释放新 Run 资格但不被覆盖。completed 的 `currentExecutionId` 仍指向终局工作单且 callStack 为空；terminated 保留原 callStack/current execution/phase 与全部材料，只轮换顶层 nodeToken、清 restartPending 并记录“不取消外部动作”的终止原因。最终 handoff 从终局工作单读取，无 Run.finalHandoff。

Run.blockReason 仅用于 Run 控制故障；节点暂停原因属于工作单，status 从工作单投影，不重复写两份原因。当前 Runtime 的节点 BLOCK 只写工作单原因。

## Run Frame / 当前位置

callStack 的 workflowId/nodeId/nodeToken/executionId 必须与各层工作单一致；顶层 executionId 等于 Run.currentExecutionId，较低层 executionId 稳定指向等待中的 Child caller。Store 在同一事务内校验更新。它不是独立推进入口。新 visit 产生新 execution ID 与 token。

nodeToken 是控制面过期检查，不是授权凭证。**旧 Turn 即使查到最新 token，也不能取得新 dispatch 的 claim/block/Judge 权利。**

## Node Execution（工作单）

`node_executions` 是一次 Graph visit 的当前事实。每次沿 Edge 进入（包括自环、回边）创建独立 execution；REJECT、补充、resume、Judge respawn、重启恢复与 Role replacement 都更新同一单，不新增 visit。

工作单保存 input 快照、phase、Actor 安排与真实 Host message ID、Node-local 投影边界、当前 claim/Judge/判定、版本与暂停原因，以及前驱/后继关联。input 进入时固定，不被前驱修改或后续补充覆盖。

phase 为 `ready|working|checking|settling|exited`：表示已登记业务事实，不表示宿主瞬时状态。working 不证明消息已送达；checking 不证明 Judge 已启动。BLOCK 保留阶段与材料。exited 材料不可变，只允许为待派发后继补记前驱 Judge 安全收口元数据。

## Node Execution Events

`node_execution_events` 只追加关键快照：进入、Actor/Judge/Program/Child安排、claim、judgment、Program结果/人工裁决、Child返回、模型变更、离开、BLOCK。事件在同 execution 内使用稳定递增 sequence；时间仅供显示。

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

T5 已把 `jobs`、`compaction` 设为标准 Web composition 的 required service，并在 Host Adapter 内用正式接口完成 cold resume（无 prompt）、idle maintenance、释放和原 Session Queue 续接。成功与合法 no-range 可继续；busy、压缩/resume/dispose 失败均不伪装成功，工作单保留并 BLOCK。T6 的 Session availability 为 `available|missing|unknown`：live 或持久读取成功为 available，只有正式 `SessionPersistenceNotFoundError` 是 missing，服务缺失/损坏/读取异常保持 unknown；仅 missing 自动 fresh replacement，unknown 保留原身份并在 Manager 明确确认后尝试 cold 续接，失败继续 BLOCK。

## Judge Role / Judge Agent

Judge 是独立只读检查者，不补做 Actor 工作，不改写 claim outcome。首次判断和 respawn 创建 continuable Judge；NEED_CONTEXT 补充可复用同一 Session，但每次都先登记新的 Judge dispatch，再以 Host queue 开新真实 Turn，并在真实 message ID 返回后才允许该 Turn 提交。T6 将恢复决定持久化为 `followup|fresh`：historical NEED_CONTEXT 或重启后未判定且 available/unknown 的当前 Judge 可在同 Session 预安排新 dispatch 并 followup；只有 missing 或明确 respawn 才 fresh，旧 Turn/inputVersion 均失权。

Host 用真实 tool allow-list 限制 read/glob/grep/read_image 和 workspace/repository 限定的 workflow_inspect_git/workflow_inspect_github，并授予专用 judge_claim；spawn 后检查最终工具面，异常 fail-closed。Actor/Manager 不能冒充 Judge。

Judgment Packet 来自本次工作单 input、instruction/criteria、claim.handoff 与本次 dispatch 的 Node-local projection，不从旧 Run.nodeBoundary/pendingClaim 镜像读取。投影排除旧 Node、system/tool/notice 与提交约束，不注入完整 Manager 历史。

`judge_claim({nodeToken,result,reason})` 的真实 caller Turn 绑定当前 Judge dispatch，且必须匹配 claim/input version。ACCEPT 后 completed→PASS、failed→FAIL；有合法出口才原子交接。REJECT 在同 execution 保存完整旧 claim 与 Judge/input 关联、使当前资格失效并重派原 Actor，不走 onFail/新 visit/compact；NEED_CONTEXT 保留当前 claim 并 BLOCK。Manager 的完整当前补充先入库/事件、递增 inputVersion，再开 Judge followup；失败仍保留材料，旧 Turn 无效。

## 安全收口 / Host Adapter

claim 入库之后先等待**对应真实 Actor Turn**安全收口，才启动 Judge。旧 Session 的其他 Turn/end 不能结算当前 visit。interrupt 回执不代表工具/后台任务已经停止。

session/event 同步回调只捕获该 turn/end 对应的精确消息集合和 Agent 生命周期引用，退出 append publication lock 后由 setImmediate 触发 Runtime。Host 使用正式 jobs、whenIdle、inbox、durable descendant 与 live registry 检查当代/observed exact Agent：durable inactive descendant 无 Activation 可通过；running 却不可观察、live 非 idle、pending inbox、非 terminal job、diagnostic 或 orphan 证据均 fail-closed。orphan 不因 job 行消失洗白，插件 effect 清理观察引用。这里只保证可观察 Host 活动，不证明未登记外部副作用停止。

Judge ACCEPT 工具内只提交事务和撤权，**不 await 自己 whenIdle/drain**。后继派发由该 Judge 工具返回后的精确收口事件驱动。Root END 已完成时，Actor 已在判断前安全收口，撤权后的只读 Judge 不因缺失最终 turn/end 另占 workspace 或形成新的业务锁。T6 中 live active/idle 但 `safeToInspect=false` 的旧执行仍保守拒绝；重启后无 current/observed Agent 的 unknown 只有在 Manager 提供明确 resume context 后才可 cold 接手。已 ACCEPT/exited 且后继登记的前驱只读 Judge 漏 end，可由重启恢复事务技术收口而不重判前驱。T8 Reset 仅撤销 Workflow 资格和 best-effort Judge 授权，不 drain/cancel 外部资源。

SQLite 事务与状态队列不包 spawn/compact/网络/Program 长调用。index 不再把完整 Engine Promise 放进 workspace enqueue；每个外部返回后重新验证身份版本。

## BLOCK / 恢复与暂未接通范围

T4 支持显式 node_block、Actor 未提交结果、Judge 未提交结论、NEED_CONTEXT、派发/compact/安全收口故障的可见 BLOCK；材料保留。`node_resume` 是 Manager-only/current BLOCK，可选 auto/actor/judge 并拒绝已 exited、不适用阶段或可交接结论；`judge_respawn` 仅在有效 claim 下重建并撤销/收口旧 Judge。T6 的重启 reconciliation 为所有未结束 Run 记录 `restartPending`/`interrupted`，running 转可恢复 BLOCK、原 blocked 保留原因；resume 消费该标记并重入同一 driver。working/无可靠收口的 checking-auto 让 Actor 带完整材料检查现场后重新 claim；settled claim 或 Manager 显式 judge 决议走只读 Judge。派发无回执时新建 dispatch 身份，不承诺 exactly-once。Actor/Judge 争议协议仍统一注入，Manager 补充不改冻结 Snapshot/criteria。

T7 已接通 Builtin Program、嵌套 Child、FAIL 无出口重开与 model replacement。Program 参数/安排先存再执行，PASS/FAIL 无 Judge 原子路由；显式 handoff 或原 input 是唯一交接，ERROR/抛错先 BLOCK，由 Manager 显式重试或裁决。Child caller 与 frame.executionId 稳定关联，首节点继承调用 input，最终 handoff 原子逐层 pop 到父后继，Root/Child 共用 Role mappings。Actor accepted FAIL 无 onFail 保留 claim/judgment 于 settling BLOCK，Manager actor resume 在同 execution 重开新工作版本。

T8 已接通 Manager-only `/dsh-flow reset`：一个短 CAS 事务把当前 active Run 标为 terminated，保留 execution/事件/Snapshot/Role mapping 并写 terminated event；重复 Reset 与非 Manager 拒绝。新 Run 前检查 terminated 当前 Role/Judge 及 ready 前驱未收口 Judge，known active/idle 拒绝，Host unknown 仅因新的显式 start 才允许，旧 Actor/Judge/Program 回调不能推进新 Run。

## Workflow State Store / 可观察性

使用内置 node:sqlite、WAL、单连接短事务；SQL active-workspace unique/FK 与 Run/Execution CAS 共同保护位置。T8 为 terminated 状态/事件将 State format 升为 `agent-workflow-state/v9`；旧 workflow_state、v3–v8、未知格式或坏库进入只读 maintenance 诊断，普通 start/list/tools fail-closed，插件命令仍激活。不会自动迁移或创建空库遮盖；只有 root 人类命令 `/dsh-flow reset --incompatible-store` 才对整个 Store 做唯一一致性备份（有效 SQLite 使用原生 backup，坏库保留原始 main/WAL/SHM bundle）后切换空 v9，失败保持源文件与 maintenance 状态。

命令仍是 `/dsh-flow list|start <id> [extra text]|status|reset`，另有仅供不兼容全库维护退出的显式 `/dsh-flow reset --incompatible-store`；Root extraText 在首次派发前作为 input 保存。默认 status 只展示当前 execution/phase/角色/原因、input/handoff 有界预览与恢复方向，不暴露完整 claim、previousClaim、Manager context 或内部 dispatch；最终通知 best-effort，失败不撤销终局事务。

trace 是派生产物，不是业务 events。Runtime 保留 trace helper 的转义/脱敏/失败容忍，并在事实提交后 best-effort 记录 START/CLAIM/JUDGE/ROUTE/BLOCK/MODEL；不通过 trace 恢复。Program/Child/resume/respawn 等权威过程只写同事务 `node_execution_events`，不继续维护旧专属 trace 双路径。

## 测试与交付

最高 controlled seam 是真实 Workflow Runtime + 临时 SQLite（恢复、Program、嵌套 Child 与 Reset/升级测试真实关闭重开）+ 受控 Host Adapter；关键来源测试使用精确派发 ID 集合。`scripts/t3-smoke.mjs` 保留 ACCEPT 基线，`scripts/e2e-smoke.mjs` 覆盖 REJECT/failed-onFail/修正闭环；二者都使用独立临时 home，不操作真实 Run。

T9 已按 `docs/testing/runtime-refact-test-migration.md` 删除旧 MemState/单表结构测试并以新 seam 动态证据替代，full suite 必须 0 fail/0 skip。`test/runtime-real-host.test.ts` 另以 exact DSH 0.1.2-rc.1 真实 Host 组合覆盖 A30 的 Role Activation cold continuation、真实 Basic compact、ToolRuntime claim/Judge 与 Host interrupt 后同 execution BLOCK/resume；它使用脚本 LLM，不冒充外部模型质量或完整进程重启。
