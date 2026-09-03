# Domain Glossary

## Agent Team Workflow

在DSH主会话中，由Manager与若干固定Role Actors按预配置Workflow Definition串行协作，直到Root Workflow到达END。它只定义团队编排、Node推进、Checker判断和中断继续，不内置PRD、GitHub、测试或交付等具体业务流程。

## Manager

当前DSH主会话承担的编排者。Manager启动Run、为动态决策Node选择业务对象、把上下文交给后续Node、处理中断/BLOCK、与直接人类沟通，并可执行配置为`manager` Role的Actor Task。Manager执行Actor Task时仍不能自行判定PASS。

## Role Definition

团队中一种工作职责的不可变运行定义，包括`roleKey`、persona、model route和tool restrictions。Role Definition可以由多个Node复用。Session Preset提供基础persona/tools/Skills/MCP和helper subagents；Role Actor继承Preset后再应用Workflow Role覆盖/收窄。Manager是保留roleKey且不在roles配置中。

## Role Actor

某个Workflow Run中Role Definition的当前执行身份。`subagent` Role在首次使用时创建一个continuable Actor，并在整个Root/Child Run中复用（Session级复用：DSH continuable child在quiescent时Activation被自动释放，后续followup自动cold-resume）；每次派发新Node前Engine对其执行Node边界compact（`ctx.compaction.compactNow`，要求resident idle Agent；实践中派发点Actor通常已被DSH自动settle，compact多为跳过，实际上下文控制依赖DSH auto-compaction兜底——见`docs/pending-discussions/`的A2前提记录），compact异常进入BLOCK；不可恢复时用replacement Actor覆盖current mapping。Manager Role由主会话直接承担，不创建Role Actor mapping，也不被compact。

## Judge Role

整个Root Workflow只配置一次的独立判断职责，包括persona、model和Engine固定read-only allow-list：read/glob/grep/read_image及current workspace/repository限定的`workflow_inspect_git`、`workflow_inspect_github` wrappers；不暴露shell/SSH/mutation/MCP/subagent/Workflow control。Judge Role不承担普通工作Node，也不能修改被判断对象。

## Judge Agent

根据Judge Role为一次具体Checker判断创建、按Node隔离的continuable Agent。每个Node创建一个全新Judge Session；同一Node内可因信息不足被Manager followup续接；Node PASS/FAIL后释放活跃资源，下一Node创建新Session，不复用。Parent/Child Workflow共享同一个Judge Role配置，但不复用Judge session。Judge只接收当前Node的Node-local projection（从Node实际dispatch边界起，按事件时间戳合并Manager/User/Actor消息，排除system/tool/notice/旧Node历史）；不再注入完整Manager Session投影。Judge通过专用`judge_claim({nodeToken,result,reason})`协议提交`PASS|FAIL|NEED_CONTEXT`；`PASS|FAIL`是唯一Graph结果，`NEED_CONTEXT`进入可恢复BLOCK等待Manager补充。技术故障fail-closed并BLOCK；判定阶段`pendingClaim`持久化`{outcome,summary}`供spawn重建重投Judgment Packet。

宿主实现已确认：`toolFilter.allow`过滤整个继承工具面（global+Preset ancestor层），固定allow-list对继承Preset的Judge成立，并额外授予`judge_claim`；两个`workflow_inspect_*` wrapper注册在host行，执行时由`tools.guard()`校验调用者属于当前Judge session；每次spawn后Host对Judge final visible schema做fail-closed断言。

## Workflow Configuration

`${DSH_HOME:-$HOME/.dsh}/workflows/<workflow-id>.yaml`中的一个自包含Catalog文件。文件名stem就是Root Workflow ID；顶层`workflow`保存Root Graph，可选`childWorkflows`保存复用子流程。文件还内联全部Role Definitions和一个Judge Role。Schema精确为`agent-workflow/v1`，使用单文档受限YAML 1.2，无duplicate key、anchor/alias/merge、custom tag或模板插值。首期不存在import、include、extends、overlay、跨文件引用或远程Registry。Catalog每次list/start fresh非递归扫描根目录，只接受lowercase`[a-z][a-z0-9-]*.yaml`普通文件，拒绝symlink/junction和`.yml`；invalid文件只阻塞自身。主入口是原生Command：`/dsh-flow list|start <workflow-id> [extra text]|status|reset`；无参数返回usage error，不做隐式status/list。

## Workflow Plugin Bundle

插件以DSH Profile Bundle分发：package.json声明`dsh.bundle.patch`指向`cordis.patch.yml`，装入`${DSH_HOME}/profiles/<name>/`的`dsh.profile.bundles`列表，用`dsh plugin --profile <name> add <path|git>`安装。Engine、`/dsh-flow`命令、七个Workflow tools和两个inspection wrapper注册在bundle的host行（global层、所有Agent可见、靠guard授权）；Role/Judge subagent由插件直接调用`ctx.subagents`（continuable/one-shot），不走Preset的subagent delegation工具。bundle成员变更需重启DSH；home/patch层修改可热载。

## Workflow Definition

一个不可变的有向Node Graph，由`workflowId`、`startNode`和Nodes组成。Graph运行中不能修改；Node业务判断只产生`PASS|FAIL`，不支持任意表达式、脚本transition、多结果分支或并行Node。

## Root Workflow

Catalog文件名对应的入口Workflow Definition。Root startNode必须是`actor-task role:manager`，以直接利用当前主会话conversation并在主聊天开始编排；后续Node不限。Root到达END时整个Run completed。

## Child Workflow

被Parent Workflow中的`child-workflow` Node引用的可复用Workflow Definition。调用时push一个Child Run Frame；Child内部FAIL由自己的onFail循环/修复处理，BLOCK保留Child Frame，只有到达END才pop并让Parent调用Node视为PASS。首期Child不返回独立FAIL终点，Workflow引用图禁止直接或间接递归。

## Parent Workflow

当前调用另一个Child Workflow的Workflow Definition或Run Frame。Parent/Child描述Graph复用与Runtime调用栈，不再固定表示GitHub Milestone/Issue等业务对象。

## Workflow Run

一次Root Workflow执行。Run保存启动时的完整immutable Definition Snapshot、当前call stack、Role Actor mappings和最小诊断状态。Run状态闭集是`running|blocked|completed`。

## Definition Snapshot

Run启动时对完整Workflow Configuration严格校验、规范化后保存的不可变副本。Active Run只使用该Snapshot；外部YAML之后的修改只影响下一个Run，不热重载当前Graph或Role。

## Run Frame

Call Stack中的一个Root或Child执行帧，只包含`workflowId`、`nodeId`和current `nodeToken`。Token是每次Node进入/resume/replacement派发时更新的UUID，用于拒绝旧Turn/旧消息迟到mutation；不保存旧Token历史。Token是尽力而为的stale防护：防「凭记忆用旧token」，防不住「迟到方实时查`workflow_status`拿新token伪装」（已知限制）。Actor一律以`workflow_status`返回的当前nodeToken为准；`resolutionContext`不承载nodeToken。Runtime不保存working/checking/interrupted phase、completion claim、attempt或Node历史。

## Node

Workflow Definition中的最小执行单元。Node包含稳定`nodeId`、一种Execution Type、可选instruction/Checker、必填`onPass`和可选`onFail`。Node运行时不被修改。

## Execution Type

Node如何执行的代码内置闭集：

- `actor-task`：由Manager或一个continuable Role Actor工作；必须配置Checker；
- `builtin-program`：运行代码内置Program，可执行动作或读取现场，并在结果明确时直接返回PASS/FAIL；
- `child-workflow`：调用可复用Child Workflow，Child到END后返回PASS。

## Builtin Program

由代码注册的固定业务程序，具有稳定`programId`、config/parameter/result schema。Node保存静态config，Manager在current Node通过`node_run_program`提供不持久化的typed parameters；Host固定programId。它可以执行业务动作或纯检查。v1仅含固定当前Workspace repository的`github.initialize-milestone(title,branchName)`与`github.all-milestone-issues-complete(milestoneNumber)`；Program parameters/details不持久化。只有结果明确时返回PASS/FAIL；ERROR/INDETERMINATE不走Graph Edge，在当前Node进入BLOCK并交给Manager处理。扩展Program必须修改代码。

## Checker

`actor-task`的实际推进门控。Node配置`checkerId`和该Checker schema允许的config；Worker只能claim completed/failed，Checker才产生PASS/FAIL。Runtime不保存Checker状态、evidence或attempt history。

## Checker Definition

插件源码内部固定Catalog中的Checker实现，包括`checkerId`、evaluation mode、config/claim/parameter schema、可选Judge prompt template和evaluate逻辑。不提供运行时register API；新增ID但不改变配置结构/既有语义时仍可属于v1，结构或既有语义不兼容才升级v2；扩展Checker必须修改插件源码、测试和版本；配置不能提供任意程序、脚本或Checker类型。

## Deterministic Program Checker（未来扩展）

直接根据Worker claim、Node config和live workspace/remote facts计算PASS/FAIL的Checker；v1尚无该类checkerId。

## Judge-assisted Program Checker（未来扩展）

使用fresh Judge从claim/现场提取固定parameter schema，再由内置程序计算最终PASS/FAIL的Checker；v1尚无该类checkerId。Judge不能选择任意command或checkerId。

## Judge Decision Checker

由Judge根据Global Judge persona、内置Checker template、Node criteria、Worker claim、只读现场，以及当前Node的Node-local projection直接给出PASS/FAIL与reason的Checker。Projection从Node实际dispatch边界起按时间戳合并Manager/User/Actor消息，排除system/tool/subagent/hidden/旧Node内容且不写State。v1唯一Checker `judge.goal-satisfied`只允许Node配置criteria文本；Judge通过`judge_claim`协议提交`PASS|FAIL|NEED_CONTEXT`，`PASS|FAIL`走Graph edge，`NEED_CONTEXT`进入可恢复BLOCK，技术故障fail-closed并BLOCK。它不能替换Judge只读职责和专用协议。

## PASS / FAIL

Checker或Builtin Program在业务结果明确时产生的唯一Graph结果。PASS走`onPass`；FAIL在配置`onFail`时走该Edge，未配置onFail时当前Node进入BLOCK。

## END

成功终点，不是Node结果。Root到END表示Run completed；Child到END表示Child成功并返回Parent PASS。

Root END 时 Engine 向 Manager 主会话 steer 一条完成通知（`workflow "<id>" 已完成（run <runId>）`），用户因此在主聊天里能明确看到工作流结束；通知是 best-effort，失败不影响已持久化的 completed 状态。

## BLOCK

当前Node/Run的可恢复暂停状态，不是Graph Edge或业务结果。Actor可以主动报告BLOCK；Actor/Manager Turn结束但未提交Node结果、派发失败、Host重启后缺少匹配Turn、Judge技术故障、Node边界compact失败、Builtin Program ERROR/INDETERMINATE或FAIL且无onFail也进入BLOCK。BLOCK保留current Node和call stack；Manager处理后只能resume同一Node或Reset，不能跳到任意Node。技术性BLOCK（Judge故障、actor未提交结果、compact失败）主动steer Manager固定模板通知，说明原因与可选动作；actor-task派发统一注入「必须调用`node_claim`提交」硬约束。

## Manager Session Context

当前主会话中已有的USER/MANAGER conversation、workspace instructions、Skills和Tools。`/dsh-flow`启动后steer同一个Manager，因此Run State不复制conversation/system/Skill/MCP上下文。Role/Judge Agent由DSH按各自cwd/preset重新装配环境。

## Handoff Context

Actor Task在临时completion claim中可提供的opaque文本。Checker PASS后，Engine/Manager把它原样放进发给下一Node或Child Actor的消息，但不持久化。它用于Agent动态选择Issue/仓库等对象，替代typed resolver、变量、output binding和data-flow DSL；发送窗口丢失时重新询问或按真实现场重建。

## Node Claim

Current Actor Task Worker通过携带current nodeToken的`node_claim`提交的`completed|failed`声明、summary和可选handoffContext。Claim和handoff都必须经过Checker；claim进入判定阶段后其`{outcome,summary}`作为`pendingClaim`持久化（供Judge spawn重建重投Judgment Packet），判定结束清除；handoffContext不持久化，系统中断后让Worker重新claim。

## Node Block

Current Actor或Manager可在Run running且token匹配时通过`node_block(nodeToken,reason)`把current Node置为BLOCK。它不运行Checker/Edge，也不自动interrupt Actor；BLOCK后迟到mutation因status不再running而拒绝。

## Node Program Run

Manager在current `builtin-program` Node调用`node_run_program(nodeToken,parameters)`的动作。Engine从current Node固定programId/config，只接收其parameterSchema允许的临时参数；参数不持久化、不形成变量或handoff，中断后重新提供。

## Node Resume

Manager在current Role Actor无active turn时通过`node_resume(nodeToken,resolutionContext)`恢复BLOCK Node。它清除BLOCK状态，把处理结果发给当前Worker，或用于重新运行Builtin Program/Child调用；不能修改current Node。判定阶段的BLOCK：`judgeSessionId`存在时followup该Judge，不存在时spawn重建Judge；`judge_respawn(nodeToken,reason?)`显式重建。resume成功后nodeToken必然轮换，Actor一律以`workflow_status`为准。ResolutionContext不承载nodeToken、不持久化，派发失败后再次resume必须重新提供。

## Manual Program Resolution

只要current Node是builtin-program、Run处于BLOCK且nodeToken匹配，Manager检查真实现场后可调用`node_resolve_program(nodeToken,result,reason)`确认PASS/FAIL。Host不分类BLOCK原因；Manager因此可以覆盖builtin-program的明确FAIL，但Actor Checker和Child结果仍不能override。

## Workflow Visibility

首期不开发自定义Workflow Web UI。Manager输出和Tool/Command Cards显示在主聊天，Role Actors显示在Child Session hierarchy，`/dsh-flow status`展示current workspace的Run status/call stack/current Node/Role/blockReason/model override；历史查看复用DSH Session log。

## Workflow State Store

`${DSH_HOME}/workflows/state.sqlite3`中按current Manager Session cwd的filesystem canonical realpath分Row保存current Run的最小持久化边界。一个Workspace最多一个Run并永久绑定启动managerSessionId，不同Workspace可并发；其他Session不能接管/推进，但同Workspace任意direct-human Session可用`/dsh-flow reset`只删除本地Row；一个connection/queue串行短写。State只包含catalogWorkflowId、immutable Definition Snapshot、Run identity/status、call stack、当前active Node的`NodeContextBoundary`（串行执行下top frame唯一活跃，实现为Run级单字段，离开Node即重置）、Role Actor mappings、current model overrides、blockReason、当前`judgeSessionId`映射和判定阶段`pendingClaim{outcome,summary}`；Root frame.workflowId等于catalogWorkflowId；不保存recentEvents、业务对象状态、Judge历史、Checker evidence、Task/Effect、Recovery状态或精确外部副作用历史。历史完全复用DSH Session log。

宿主实现确认：Home路径用`resolveDshHome()`（显式配置>`DSH_HOME`环境变量>`~/.dsh`）；cwd取自`agent.session.header.cwd`，缺失时拒绝start；SQLite用内置`node:sqlite`的`DatabaseSync`（与DSH storage-sqlite同款），owner-only目录/文件、WAL、单连接加短mutation队列。Turn结算订阅`session/event`的durable `turn/end`；`subagent/end`是Activation-epoch级、不能用于Node结果关联。自动BLOCK写入必须defer，不能在`session/event`回调内同步append同一Session。

## External Fact

Git、GitHub、文件系统、SSH环境等Node工作涉及的真实现场。插件不为外部副作用建设精准Effect recovery；系统中断后Manager/Worker重新读取External Facts，自行决定继续、重做、重新claim或BLOCK。
