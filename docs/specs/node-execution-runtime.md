# Spec：工作单驱动的 Workflow Runtime 重构

- 状态：`refact` 实现与 A01–A30 自动化验收已冻结，待父代理最终 Standards/Spec 审查和 commit；未部署。逐项证据见 [`node-execution-runtime-acceptance.md`](../testing/node-execution-runtime-acceptance.md)。
- 跟踪 Issue：[hua0424/dsh-workflow-plugin#7](https://github.com/hua0424/dsh-workflow-plugin/issues/7)，标签 `ready-for-agent`。
- 仓库文档：`docs/specs/node-execution-runtime.md`；架构依据：`docs/design/node-execution-runtime.md`。机制与职责以设计为准，本文补齐工具合同、验收与实施计划；二者如有冲突，应先统一文档而非自行择一。
- 替代：旧 PRD `docs/prd/20260907-node-execution-simplification/requirements.md` / [Issue #6](https://github.com/hua0424/dsh-workflow-plugin/issues/6)。旧 Issue 关闭不代表其方案已实现。
- 本轮授权：创建分支、设计与规格落盘、发布新规格 Issue、关闭旧 Issue。没有操作真实 Run、部署或修改外部业务资源的授权。

## Problem Statement

用户需要固定 Workflow Graph 下的串行团队协作：任务信息逐节点交接，持久 Role Actor 继承自己的历史上下文，每次 Actor 提交由独立 Judge 判断。

当前实现把节点材料、阶段、派发身份与恢复线索分散于 Run pending 字段、内存句柄和 Session 历史中。最小状态未带来最小复杂度，正常派发和恢复路径重复解释不同字段组合。

Actor 有检查现场和自行续作的能力，不需要插件细分全部异常并完美复原宿主执行；但程序仍必须正确保存阶段、控制当前执行资格、拒绝迟到提交并保证交接原子性。

此外，summary 和 handoff 是重复的结果入口；同一节点多次 REJECT/返工缺少统一的关键历史记录；Actor 对 Judge 有异议时应能通过现有 BLOCK/resume 请求 Manager，而不是陷入盲目返工。

## Solution

采用三张核心业务表：Run 跟踪流程位置，Node Execution 保存本次工作的当前事实，Node Execution Events 保存关键流转的只追加快照。

正常执行和恢复进入同一个推进器。记录明确时继续相应阶段；业务进展未知时，在不与旧执行冲突的前提下，提示 Actor 检查现场再继续。恢复不依赖事件回放，也不要求存在最后一条“已中断”记录。

Actor 只提交 outcome 与 handoff；Judge、Manager、后继和最终用户共享 handoff。保留 Role continuable Session 跨 Node 复用与新 visit 前 compact。判定争议复用 BLOCK/resume，并由插件统一注入协作协议。

## User Stories

1. As a 用户, I want 每次启动保存不可变流程快照, so that 修改配置不会改变已经运行的工作。
2. As a 用户, I want 同一 workspace 只有一个未结束 Run, so that 不会有两个流程争夺同一现场。
3. As a 用户, I want 每次进入 Node 都有独立工作单, so that 自环、回边与重复 Child 调用不会覆盖旧工作。
4. As a 用户, I want 中断后保留工作单与输入, so that 外部问题解决后可以从原处继续。
5. As a 用户, I want 崩溃前没有写入 BLOCK 也能恢复, so that 断电不会让恢复依赖异常处理代码是否执行。
6. As a 用户, I want 常规恢复使用已保存事实, so that 不必重新执行已经确认的工作。
7. As a 用户, I want 长尾不确定进度交给 Agent 检查, so that 插件不需要为每类外部动作编写恢复器。
8. As a 用户, I want 已登记的工作和历史在 Reset 后保留, so that 终止运行不会等于丢失材料。
9. As a Manager, I want status 说明当前 execution、阶段、处理人和暂停原因, so that 不必推断内部 pending 字段。
10. As a Manager, I want 补充信息先保存再发送, so that 发送失败不要求重新提供相同材料。
11. As a Manager, I want 查看同一 execution 的 claim/Judge 流转明细, so that 可以理解多轮返工和判定争议。
12. As a Manager, I want 在判定中断后直接继续或重建 Judge, so that 不必默认退回 Actor 重做。
13. As a Manager, I want 对不可靠 claim 明确退回 Actor, so that 重新检查后的新提交不会被旧 Judge 结算。
14. As a Manager, I want Actor 有争议时主动 BLOCK 并给出依据, so that 我能澄清问题而不是看其盲目迎合 Judge。
15. As a Manager, I want Program 结果未知时先核实再重试或裁决, so that 不重复创建外部资源。
16. As a Role Actor, I want 在整个 Root/Child Run 复用 continuable Session, so that 历史工作经验得以延续。
17. As a Role Actor, I want 进入下一 Node 前 compact 后继承上下文, so that 既延续经验又控制上下文规模。
18. As a Role Actor, I want 同一工作单补充和返工继续原 Session, so that 不因普通恢复丢失当前对话。
19. As a Role Actor, I want 每次收到完整当前 input、instruction 和 criteria, so that 历史记忆不是接单前提。
20. As a Role Actor, I want 只提交 outcome 与一份 handoff, so that 不必维护重复或矛盾的 summary。
21. As a Role Actor, I want completed/failed 使用相同交接能力, so that 失败后的处理人也有完整材料。
22. As a Role Actor, I want 接到中断工作时被提醒先检查现场, so that 不机械重跑已经完成的动作。
23. As a Role Actor, I want 不认可 Judge 意见时有统一反馈协议, so that 我可以提交事实和请求协调而不是伪造结果。
24. As a Judge, I want 直接读取当前 claim 的 handoff 和验收依据, so that 判断与后继实际收到的材料一致。
25. As a Judge, I want 每个判断绑定精确 claim 和本轮判定输入, so that 旧判定不能确认新提交。
26. As a Judge, I want 工具面真正只读且材料为 Node-local, so that 无法自行修复对象或继承其他 Node 的完整对话。
27. As a Judge, I want 信息不足时请求补充, so that 不因个人偏好或猜测制造 REJECT。
28. As a 后继执行者, I want 收到前驱已确认的 handoff 快照, so that 输入不随前驱后续历史修改而变化。
29. As a 开发者, I want 状态更新与关键事件原子提交, so that 可见当前状态都有对应业务历史。
30. As a 开发者, I want 一个推进器覆盖正常执行和恢复, so that 不维护两套生命周期。
31. As a 开发者, I want 复用现有 Runtime/SQLite/Host Adapter 测试 Seam, so that 不建设第二套测试框架。
32. As a 开发者, I want 显式删除旧 pending 镜像与重复恢复逻辑, so that 重构不会仅叠加新表。
33. As a 用户, I want 升级时明确拒绝不兼容活动 Run, so that 新版本不会自动覆盖旧材料或静默迁移真实工作。
34. As a 用户, I want 状态摘要和最终输出来自同一 handoff, so that Manager、Judge 和后继不会各看不同版本的结果。

## Implementation Decisions

### I1. 固定模型与最小职责

保留串行 Graph、Root/Child、PASS/FAIL、独立只读 Judge、Manager ownership。三个核心 Module 是 Workflow Runtime、SQLite Store、DSH Host Adapter；Catalog、工具授权与 Program 复用既有职责，不新增通用注册框架或转发层。

### I2. 三表与单一事实来源

Run 管位置及 Role mappings；工作单管当前执行与材料；关键事件表管历史解释。采用已有 SQLite 能力、短事务和必要数据库约束，不引入 ORM/新运行依赖。当前状态与对应业务事件一起提交，事件表不承担恢复重放。

### I3. Visit、派发、提交与竞争版本分离

新 Graph visit 创建新 execution；同 visit 的 resume/REJECT/replacement 更新当前安排。派发绑定宿主真实调用来源，Judge 绑定具体 claim 和判定输入。row revision 只用于条件更新。旧消息不能靠同 Session 或查询最新 token 冒充新派发。

### I4. claim 合同显式切换

新 Actor claim 只含 outcome 与 handoff 业务字段；outcome 为 completed/failed，handoff 必填、非空、有界，两种 outcome 对称。取消 summary 与旧 handoffContext 的公开字段名，不接受双协议或自动 summary fallback。现有宿主绑定和 token 参数仍按控制合同保留。

保持既有 handoff 文本长度上限作为起点；同步更新 schema、提示、Node-local 投影、Judge packet、工具显示、恢复与测试，禁止只改首次 claim 路径。旧格式升级/只读诊断可以识别旧字段，但新运行路径不继续维护它们。

### I5. 工作材料与判定输入

input 进入时固定；Manager 补充单独保存；claim 中 handoff 与本次提交绑定。后继 input 来自已接受的 handoff 快照；不无界累积全部历史。Judge 读相同 handoff、当前 criteria/input、补充与必要 Node-local 证据，排除旧 Node/完整 Manager 历史。

### I6. 五个粗粒度阶段

ready、working、checking、settling、exited；BLOCK 保留原 phase。phase 表示已登记业务进度，不表达每个宿主微状态。REJECT 回同 execution 的 ready；FAIL 无 onFail 在 settling 暂停，恢复时重开工作版本。已离开工作单不可恢复。

### I7. 统一推进与原子交接

命令、工具和有效宿主事件进入同一状态转换/推进路径。派发前先登记安排；claim 先提交 SQLite 才被接受；合法离开时，结果、前驱离开、后继/input、Run 指针和 Child 调用更新原子提交。重复触发不能创建第二个后继。

外部长调用在事务和状态锁外，返回后核对身份/版本。一次驱动只安排当前所需工作，不把 waiting 当无限轮询。触发丢失时显式 resume 可重入，不保证可靠通知自动重放。

### I8. Role 复用与 compact

Role Actor Session 在整个 Root/Child Run 内复用；新 visit 前 compact，同 visit 恢复/返工不额外做 Node 边界 compact。Host Adapter 封装 cold-resume、idle maintenance、合法 no-op、busy/failure 处理。缺少必要 compact 能力或失败时不得默默跳过门槛。Manager 不执行此 Role compact。

### I9. 判断与安全收口

claim 持久化后可以进入 checking，但实际 Judge 核验必须等待该 Actor 派发安全收口。Turn 结束不自动代表全部后台写任务停止，也不代表 Node 通过。宿主事件退出 append 回调后再触发有副作用动作；不在 Judge 自身提交 Turn 内 drain 自己。

已知冲突旧执行未停止时，不 compact/派发后继或 replacement。未知且有冲突风险交 Manager/用户核查，不能把撤权或 interrupt 回执当作停止完成。

### I10. 恢复与恢复目标

默认可以重启后先统一 BLOCK，再按最近阶段继续；也允许记录明确、条件满足时低成本自动继续。无需最后一条 interrupted 事件即可恢复。已保存 claim 走 Judge，已接受结果走交接，未知业务进度走检查现场；不把基础状态损坏交 Agent 猜测。

node_resume 保留 Manager-only/current-BLOCK 限制，可选 auto/actor/judge。auto 按记录；actor 仅用于未离开的 Actor Task 执行/判定返工或 FAIL 无出口重开，撤销旧提交/判定资格但保留材料；judge 仅用于有当前有效 claim 且无有效结论的待判定 Actor Task。已有可交接结论不允许借此重做/改判；Program/Child 不接受 actor/judge 目标。

### I11. 程序、Child 与终止

Program 参数在执行前保存；确定结果直接交接，不确定效果先由 Manager 核实再显式重试/裁决。Program 的固定实现可返回安全有界 handoff，有则作为后继 input，没有新交付文本则透传原 input，不自动序列化任意 details 或合成 summary；有新产物需交接时由该 Program 明确输出。

Child 首节点接收调用工作单 input，最终节点按其执行类型形成的交接文本作为父调用输出传给父后继，嵌套调用同样逐层传递，不能被父调用旧 input 覆盖。Child END、父调用 PASS 与后继登记按相同事务原则；Root/Child 不拥有互相独立的 Actor mappings。

Reset 终止而非成功，保留材料/明细/必要 Run 快照；不能自动清理资源。新 Run 不覆盖旧历史，也不能在已知旧工作仍冲突时立即开始。

### I12. 明细查询与争议

status 默认只展示当前工作单、有效结果、最近判定及 handoff 预览。第一版在既有 workflow_status 入口增加 Manager-only 的显式有界历史查询：给定同一 Run 的 execution ID，按稳定事件序号向后分页，每页最多 50 条，返回后续游标；错误 Run/角色拒绝，不向 Actor/Judge 开放全流程历史。取消单独历史 Web UI 或新工具的需求。

争议走 node_block/resume，无新增 appeal 工具或状态机。统一 Actor 协议要求报告分歧、证据与需要的协调；统一 Judge 协议要求按既有 criteria 给出可核对的拒绝理由，信息不足用 NEED_CONTEXT。普通 Role persona/Node criteria 不重复承担该协议。

### I13. 兼容策略

新 State format 显式升级，不把旧行强转成新工作单。不强制精确迁移旧活动 Run或长期双引擎：新版发现不兼容活动数据应停止、说明、保留原材料，提供授权后的备份/导出与 Reset 退出路径；迁移失败不部分切换，不为恢复失败创建空库掩盖旧库问题。

Graph YAML 语法尽量保持兼容；工具 claim 合同及行为变化必须写升级说明。DSH 类型依赖对齐目标宿主 0.1.2-rc.1 的实际可用包版本，先核实发布/源码类型，不假定每个包版本号必然相同。宿主包保持 devDependencies，运行由安装宿主提供。

### I14. 简化交付门槛

实施报告必须列出删除的 Run pending 材料镜像、内存唯一材料、重复 packet/派发/恢复分支及 summary 路径。保留必要身份校验、Role mappings、Node-local 隔离和 compact；不以取消用户要求的行为充当简化成果。

## Testing Decisions

### T1. 最高层 Seam

沿用前面已确认的实际 Workflow Runtime + 隔离真实 SQLite + 受控 Host Adapter。观察工具返回、派发材料、当前工作单、关键事件与后继关系，不绑定私有 Map 数量、函数拆分和表列布局。

优先扩展现有 Engine/State/Host compact 测试与隔离 smoke，不建立新测试框架。真实 SQLite 关闭重开是恢复验收必需项，不能仅新建 Engine 共享原内存对象。当前 smoke 仅替换模型派发，不冒充完整真实宿主验证；目标 DSH 版本另做隔离 home 冒烟。

### T2. 验收矩阵

| 编号 | 必须观察到的行为 |
|---|---|
| A01 | 启动固定完整 Snapshot；运行中修改配置不影响该 Run；workspace 的第二个未结束 Run 被拒绝，BLOCK 不释放占用 |
| A02 | 回边、自环、重复 Child 调用产生新 execution；resume、REJECT、replacement 保留当前 visit |
| A03 | input、Manager 补充、claim.handoff、Program 参数和关键事件经 SQLite 关闭重开后可读 |
| A04 | state 与对应事件要么一起提交，要么一起回滚；事件写失败后无残留事件、半个被接受的 claim/判定或提前 Judge/后继派发；失败事务不提前消费提交资格，同一真实 dispatch 可原样重试，成功后重复提交被拒绝 |
| A05 | 新 claim 接受 outcome+非空 handoff；缺失/空/超限 handoff 及旧 summary/handoffContext 业务参数被明确拒绝，completed/failed 对称 |
| A06 | 同一 handoff 被 Judge、Manager、后继取得；Root END 最终结果也保留，不存在单独 summary/fallback |
| A07 | Actor → claim → Judge ACCEPT → 后继形成唯一有效推进；后继 input 是已接受 handoff 的固定快照 |
| A08 | claim #1 → REJECT → claim #2 → ACCEPT 在同 execution，按序保留两份 claim/判定快照且关联正确；当前状态只认有效版本 |
| A09 | REJECT 不沿 onFail；新派发收到最近拒绝依据。Actor 提出异议可 BLOCK，Manager 补充/恢复后重新提交，经 Judge 后才推进 |
| A10 | NEED_CONTEXT 保留当前有效 claim；补充先存后送，发送失败不丢；旧判定输入对应的迟到 Judge 结果被拒绝 |
| A11 |  claim 已保存、Judge 未完成时，重开库后可继续/重建 Judge，不默认重做 Actor |
| A12 | 前驱离开与后继创建/input/Run 指针故障注入保持原子；重复回调/恢复不产生第二个后继 |
| A13 | 没有 BLOCK/中断事件、库仍为 working 时也能恢复；提示明确检查现场而不是认定尚未执行 |
| A14 | 外部测试产物已完成但尚未 claim，恢复者可核验后提交，不要求重复副作用；部分完成则只补做剩余工作 |
| A15 | 原 Actor Session 可用时续接同一 Role；不可用/显式更换时 replacement 收到完整当前材料，旧身份失权 |
| A16 | 同 Role 跨 Root/Child Node 和自环复用 Session，新 visit 派发前 compact；同 visit 返工/resume 不额外触发边界 compact |
| A17 | cold Role 仍能按宿主合同准备 compact；成功/合法 no-op/busy/失败区分，失败保留材料并可恢复，不能假成功派发 |
| A18 | claim 后 Actor/已知工具 tail 未收口时 Judge 不开始现场核验，也不 compact/派发后继；interrupt 回执不自动解除等待 |
| A19 | 同 Session 的旧 dispatch/Turn、重复 claim、旧 claim 的 Judge 结果、旧输入的 Judge 结果不能结算当前工作；最新 token 不能覆盖来源校验 |
| A20 | Judge 工具面真正只读、Node-local；恢复提示只要求核验，不要求补做；Actor 无法伪装 Judge/Manager |
| A21 | FAIL 无 onFail 保留失败和历史，settling+BLOCK；resume 重开当前工作，不重判旧 claim；有 onFail 则对称交接 |
| A22 | Program 参数先存再执行；效果不确定不盲目重试，Manager 核实后裁决/显式重跑；确定结果无额外 LLM Judge。显式 Program handoff 传后继，没有新交付文本则透传原 input，任意 details 不被自动注入 |
| A23 | Child 等待期间唯一活跃位置为栈顶；Child END、父 PASS 与后继一致，重复/迟到 Child 结果不二次推进；嵌套 Child 的首节点收到调用 input，最终 handoff 逐层原样到父后继而非被父旧 input 覆盖 |
| A24 | Reset 标记终止而非成功，保留历史并撤销旧权限；新 Run 不覆盖材料，冲突旧工作未停止时不直接派发 |
| A25 | actor/judge 恢复目标拒绝不适用 Node/阶段；不能重开 exited 或覆盖可交接结论；退回 Actor 使旧 claim/Judge 失效 |
| A26 | Manager 可按序分页查看本 Run 指定 execution 的明细，每页最多 50 条；默认 status 不倾倒全部历史，跨 Run/非授权角色拒绝 |
| A27 | 未提交结果且 Turn 已结束形成可见暂停，不静默悬挂；事件回调不重入 append，Judge 不自我 drain |
| A28 | 旧 State format 有明确诊断与授权备份/Reset 路径，不覆盖、不自动迁移活动执行、不部分切换；坏库不被空库伪装为恢复成功 |
| A29 | 实施删除旧 pending 权威来源、summary 双文本和重复恢复分支；保留 Role 复用/compact、身份校验与 Judge 隔离 |
| A30 | 目标 DSH 0.1.2-rc.1 下隔离验证 Role cold continuation、compact、claim/turn 安全收口及一个中断后的继续链路；stub smoke 与真实宿主证据分开报告 |

### T3. 故障注入与完成证据

在现有 Seam 注入：事务失败、事件写失败、发送前失败、消息可能已送达但结果未保存、Judge 不可用、Actor Session 丢失、compact busy/failure、重复/迟到回调和关闭重开数据库。

不按 provider/网络/硬件的每个错误码扩展状态机。测试验证安全拒绝、材料送达与可继续结果，不要求所有微状态恢复。

运行 build/typecheck、unit、隔离 smoke；真实宿主组合单列。未执行、环境不具备和失败都如实记录，不以静态审查或 stub 通过代替真实宿主结果。T9 的最终动态证据与真实 Host 边界记录于 `docs/testing/node-execution-runtime-acceptance.md`。

## Out of Scope

- 完整事件溯源、全量聊天/工具日志入库、重放全部执行、无限保存中间草稿。
- 全派发/外部效果 exactly-once、Outbox/Inbox 框架、Effect 补偿、消息队列、后台恢复平台。
- 动态改图、任意跳转、强制通过、并行工作位置、Child 新增 FAIL 终点。
- 新的申诉/争议工具、Actor/Judge 自动辩论循环、自由团队聊天总线。
- 独立 summary、自动模型摘要、结构化业务 handoff DSL、任意程序注册。
- 每 Node 新建 Role Session、删除 Node 边界 compact、另建 workflow token 阈值策略。
- 完整历史 Web UI、搜索平台、自动归档/清理、精确迁移全部旧活动 Run。
- 自动部署、修改真实 Catalog、注入真实用户 Run 故障、删除外部资源或自动处置其他 Issue。

## Further Notes

### F1. 实施顺序：按可验证纵向切片推进

每个切片单独保留可验证的完成证据；切片中的中间代码不得部署到真实 Run。不是先铺全部新表，再复制旧引擎形成长期双实现。

| 切片 | 工作与完成条件 | 对应验收 |
|---|---|---|
| S0 基线与宿主适配确认 | 核实 DSH 目标版本和包类型，必要时对齐 devDependencies/lock；记录现有测试基线；固定新旧合同切换/备份策略。现有失败先说明，不归因于尚未实现的重构 | A28/A30 的前置 |
| S1 最小真实闭环 | 引入三表与版本，接通 start → Actor 单文本 claim → 独立 Judge ACCEPT → 后继/END；状态+事件+交接事务、必需授权和收口保护同时到位，覆盖一个真实 SQLite 闭环 | A01–A07、A12、A18–A20 基础 |
| S2 返工与争议 | 同 execution 多轮 claim/Judge、拒绝依据、NEED_CONTEXT、统一争议 BLOCK/resume 提示、Manager 有界历史查询；验证当前状态与历史分工 | A08–A10、A25–A27 |
| S3 统一恢复与 Role 生命周期 | 普通 driver 接入 restart/resume/replacement，未知进度检查提示、Session 复用、新 visit compact 与故障处理；真实关闭重开库验证，无第二套恢复引擎 | A11、A13–A17、A19–A20 |
| S4 完整 Graph 与运行控制 | FAIL 无出口、Program 不确定结果、Child 调用返回、Root/Child Role 共享、Reset 与历史、模型更换控制 | A21–A24，复核 A02/A16 |
| S5 收敛与交付 | 删除旧 pending/summary/重复恢复路径，完成兼容退出与文档工具示例同步；全量验收及隔离目标宿主冒烟，列清删除项和残余限制 | A01–A30 |

依赖：S0 → S1 → S2 → S3 → S4 → S5。切片不是新的公开工具或持久化系统，也不要求新增多个薄 Module。

### F2. 已核实的现有落点（实施时重读源码）

- 领域类型与 SQLite：`src/types.ts`、`src/state/store.ts`。
- claim schema/身份与统一提示：`src/tools/tools.ts`、`src/tools/authz.ts`、`src/engine/texts.ts`、`src/plugin/turnbind.ts`。
- Runtime/Graph/恢复与宿主事件：`src/engine/engine.ts`、`src/index.ts`。
- Role/compact/Judge：`src/plugin/host.ts`、`src/roles/roles.ts`、`src/judge/checker.ts`、`src/judge/projection.ts`。
- 测试复用：`test/engine.test.ts`、`test/state.test.ts`、`test/host-compact.test.ts`、`scripts/e2e-smoke.mjs`。按已存在职责补充测试，不假定必须新建同名架构文件。

T9 已将所需 DSH Host 测试包按已发布 exact `0.1.2-rc.1` 固定为 devDependencies，并通过包 exports 组成真实 Host fixture；插件运行依赖仍只有 `yaml` 与 `zod`，没有为类型缺口增加兼容 shim。

### F3. 文档、Issue 与升级说明

完成实施时同步 `CONTEXT.md`、权威 Graph 设计、工具提示/说明和受影响示例，标明 State format 与 claim 工具合同变更；当前文档仍描述未重构运行代码的事实，不在本次规划阶段伪装升级完成。

本 spec 取代旧 Issue #6；关闭原因为 superseded/not planned，不是 completed。新的开发任务引用本 spec 及其验收编号。先前 Issue #5 的 token 阈值方案不属于本 spec，不能默认据此跳过必需的 Node 边界 compact，本次不自动关闭或改写 #5。

开发报告包括：变更摘要、旧复杂度删除清单、各验收证据、升级/授权退出步骤和仍不保证的行为。任何方案若必须新增可靠消息平台、自动补偿、绕过 Judge 或改变固定 Graph，应暂停与用户讨论。
