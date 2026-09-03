# 可配置 Agent Workflow Graph 首期设计

- 状态：设计已确认并冻结；实现已完成（代码/单测/真实宿主冒烟全部通过），
  剩余唯一验收项为真实模型 Web GUI e2e（详见 `docs/testing/acceptance-report.md`）
- 目标：在 DSH 上提供主 Agent + continuable subagents 的串行团队工作流执行能力
- 替代关系：本文已取代`feature-delivery/v1`业务专用状态机、Effect和Adapter合同；旧文档仅保留在Git历史

## 1. 产品需求

插件只需要解决：

1. 管理员预先配置团队 Role 与不可变 Workflow Graph；
2. 主 Agent与continuable Role Actors按Graph逐Node串行协作；
3. Node使用`actor-task|builtin-program|child-workflow`之一；只有actor-task绑定执行Role和Checker；
4. Worker只能claim completed/failed或报告BLOCK，不能自行判定PASS；
5. 固定程序或独立Judge Actor产生`PASS|FAIL`；
6. Engine只在Checker/Program得到PASS|FAIL后按onPass/onFail进入同Workflow Node ID或`END`；child-workflow Node通过Child END产生PASS；`BLOCK`是current Node运行状态，不是Edge target；
7. 系统/Agent中断后恢复当前Actor对话并继续当前Node；
8. 外部副作用现场由Manager/Worker检查后自行决定继续、重做或重新claim，不做精准Effect恢复。

插件不是GitHub发布系统、测试平台、通用CI、审计系统或分布式状态机。

## 2. 高层领域模型

### 2.1 Role Definition

继续保留现有Role运行定义：

Worker Role最小Schema已确认：

```text
roles.<roleKey> = {
  persona,
  model?: { provider, modelId },
  tools?: { deny: string[] }
}
```

Judge最小Schema：

```text
judgeRole = {
  persona,
  model?: { provider, modelId }
}
```

Role key使用kebab-case；`manager`和`judge`保留，禁止出现在roles。Judge tools不可配置，由Engine固定只读。

已确认`manager`是保留roleKey，可被actor-task Node引用，但禁止出现在`roles`配置中；它始终由当前主会话承担，YAML不伪装修改其persona/model/tools。`roles.*`只定义按需创建并在Run内复用的continuable worker subagents，每次派发新Node前对其执行Node边界compact（`compactNow`）。Judge使用独立`judgeRole`配置。

Preset与Workflow分工已确认：当前Session Preset定义基础persona/tool/Skills/MCP和generic/specialized helper-subagent tools；Workflow YAML定义本Run的worker Role persona/model/toolFilter和Graph。Role Actor先继承Parent Preset composition，再应用Workflow Role覆盖/收窄，因此可以继续使用Preset提供的`qa-expert`、`vue-developer`等helper。首期不为每个Workflow创建独立Preset，也不把Workflow Role仅放在Preset中。

Provider已确认固定：Worker Role Actor使用DSH in-process`spawn` continuable；Judge也使用continuable（每Node fresh、Node内可followup），不再one-shot/fresh。YAML不配置subagentProvider。Model只允许provider+modelId；省略时在Run启动时继承并冻结当前Manager route，不配置maxTokens/temperature/fallback等provider属性。

Role工具限制只支持role-level`tools.deny`，不支持allow-list或per-node override。Role Actor继承Preset tool catalog后一次性收窄；unknown deny name在Run启动时失败，node_claim/node_block等必需工具不能deny。Preset helper未被deny时可供Role在Node内部使用。Codex/Claude/qa-expert/vue-developer等Preset subagent tools只作为Node内部helper，不作为Workflow Role backend。

### 2.2 Judge Role

一个Root Workflow只配置一个Judge Role：

```text
judgeRole
```

Judge不承担普通工作Node，不判断自己完成的工作。它只：

- 对subjective completion claim给出PASS/FAIL；
- 为judge-assisted program check生成固定schema参数；
- 解释失败原因。

Parent/Child Workflow共享同一个Judge Role Definition，但每个Node创建一个全新Judge Session（Node内可因`NEED_CONTEXT`被Manager followup续接）；跨Node不复用Judge session，避免前序判断污染独立性。

Judge提示词已确认使用三层模型：

```text
全Workflow一个Judge Role persona
+ 每个Node创建fresh Judge Session（Node内可followup）
+ 每个checkerId由代码内置prompt template与judge_claim protocol
+ Node只配置该checker schema允许的criteria/context
+ 只注入当前Node的Node-local projection（Node实际dispatch边界起，按事件时间戳合并Manager/User/Actor消息，排除system/tool/notice/旧Node历史）
```

Node不能替换Judge系统职责、checker参数schema或PASS/FAIL协议。Judge-decision可以接收较自由的criteria；judge-assisted checker必须按内置template输出typed参数。

Judge每次创建时使用Engine固定allow-list：`read`、`glob`、`grep`、`read_image`、专用`judge_claim`，以及插件自有`workflow_inspect_git`/`workflow_inspect_github`只读wrapper。Wrapper目标固定current workspace/repository、operation为enum，不接受任意command/URL或mutation。Judge不暴露bash/pwsh/SSH、edit/write、通用GitHub/MCP mutation、Workflow control（`judge_claim`除外）、Skill或subagent tools。缺少所需读取能力时本次判断不产生结果并BLOCK。

宿主实现已确认：`toolFilter.allow`过滤整个继承工具面（global层+Preset ancestor层），仅Child自身scope注册的delegation machinery豁免，因此固定allow-list对继承Preset的Judge Child成立（历史缺陷已在`tools.view()`修复）。两个wrapper注册在Profile Bundle的host行（global layer）使Judge可见，执行时由`tools.guard()`校验调用者属于当前Judge session。Host在每次Judge spawn后对其final visible schema做fail-closed断言（⊆允许集∪machinery），超出即拒绝spawn并让当前Node BLOCK。

### 2.3 Workflow Catalog、Definition与启动方式

已确认用户级Catalog位于：

```text
${DSH_HOME:-$HOME/.dsh}/workflows/<workflow-id>.yaml
```

目录不属于项目Git。每个Catalog文件是完整自包含配置。文件名stem就是Root Workflow ID；Root Graph只存于顶层`workflow`，可复用子流程存于可选`childWorkflows`：

```text
{
  schemaVersion,
  roles,
  judgeRole,
  workflow: { startNode, nodes },
  childWorkflows?: {
    workflowId: { startNode, nodes }
  }
}
```

删除`rootWorkflow`selector和Root在map中的重复ID。Child Workflow只引用同文件`childWorkflows.<id>`；Root不能被引用。首期无import/include/extends/overlay/跨文件引用/远程Registry/版本范围。

首期启动/查询入口是一个DSH原生Command，grammar已冻结：

```text
/dsh-flow list
/dsh-flow start <workflow-id> [extra text]
/dsh-flow status
/dsh-flow reset
```

无参数直接返回usage error，必须显式使用list/start/status/reset。Start不能覆盖running/blocked Row，completed可覆盖；extra text只进入steer给Manager的消息。Reset只删除current workspace Row，不清外部资源/其他Workspace。不存在pause/stop/jump/skip/force-pass/takeover。

Catalog每次list/start fresh非递归扫描根目录，仅接受lowercase`[a-z][a-z0-9-]*.yaml`普通文件；拒绝symlink/junction和`.yml`，忽略其他扩展/子目录。Invalid文件在list显示diagnostics且只阻塞自身start，不影响其他Workflow。

Schema已确认精确`agent-workflow/v1`，输入使用受限YAML 1.2：单文档，禁止duplicate key、anchor/alias/merge、custom tag、模板/环境插值，未知字段拒绝，不做alias/range/migration。实现用`yaml`库`parseDocument(text,{version:'1.2',uniqueKeys:true,customTags:[]})`并拒绝全部document.errors与warnings，再对AST走查显式拒绝anchor/alias/tag/merge key；库选项不足以保证禁制，必须AST校验加严格schema（未知字段拒绝）双保险。

启动时把完整normalized配置和definitionHash写入Run State。Active Run之后只读取该snapshot并忽略YAML后续修改；新YAML配置只影响下一个Run，不做hot reload/continuity projection。唯一运行中Role replacement来源是Manager显式`workflow_set_role_model`或Actor session不可恢复。

部署形态已确认：插件以DSH Profile Bundle分发——package.json声明`dsh.bundle.patch`指向`cordis.patch.yml`，装入`${DSH_HOME}/profiles/<name>/`的`dsh.profile.bundles`列表，用`dsh plugin --profile <name> add <path|git>`安装；改动bundle成员需重启DSH，home/patch层修改可热载。Engine、`/dsh-flow`命令、八个Workflow control tools、Judge专用`judge_claim`与两个inspection wrapper注册在bundle的host行（global层、所有Agent可见、靠guard授权；共十一个注册工具）；Role/Judge subagent由插件直接调用`ctx.subagents`（continuable/one-shot），不走Preset的subagent delegation工具。

### 2.4 Workflow Definition最小Schema

顶层`workflow`和每个`childWorkflows.<workflowId>`都只保存`startNode`与`nodes`。Static Validator要求Root startNode必须是`actor-task role:manager`，并要求其他start/edge/role/program/checker/child引用存在，所有Node从start可达，每个Workflow至少有一条可达END路径，Child引用图为DAG且Root Workflow不能被Child引用。Graph Node Edge允许显式循环；不配置description/input/output/variables/defaults/timeout/maxIterations/errorHandler。

### 2.5 Parent/Child Workflow

已确认：Parent Workflow Definition可以引用可复用Child Workflow Definition。每次引用在运行时push一个Child Workflow Run frame。Child内部FAIL通过自己的onFail循环/修复；达到END才pop并让Parent调用Node视为PASS。Child BLOCK只暂停并保留frame，不返回FAIL；首期Child是“必须完成的可复用子流程”，不设计RETURN_FAIL终点。

该模型用于复用主流程中多次出现的区域子流程。Parent/Child不再固定解释为Milestone/Issue；Milestone/Issue是某个具体Graph中的业务对象，由Node action/checker处理。Root Parent与所有Child Run共享同一个Judge Role配置，但每次判断使用fresh Judge Agent。

### 2.6 Manager Session Context与消息Handoff

已确认Run State不保存Root inputContext或持久化handoffContext。`/dsh-flow start <id> [extra text]`启动后steer当前Manager；Manager天然使用当前主会话conversation、workspace instructions、Skills和Tools执行Root Node。Command附加文本只进入该steer消息，不复制到SQLite。

不引入Child inputSchema、inputResolver、通用变量或output binding。需要动态选择业务对象时，在Graph中显式增加一个`actor-task`交给Manager/Role Actor判断。

Worker完成Node时可在临时claim中提交bounded `handoffContext`文本。Checker PASS后，Engine/Manager把该文本原样放进发给下一Node或Child Workflow Actor的消息；Engine不解析其中的Issue/repository/branch字段，也不持久化。发送窗口中断时重新询问前一Actor或由Manager按真实现场重建。

例如Manager选择下一个Issue后提交：

```text
handoffContext:
  Process GitHub issue https://github.com/acme/server/issues/42.
  Repository: server.
  Reuse the existing issue discussion as requirements context.
```

Child Workflow接收这段上下文并继续。错误、重复或过期选择由后续Agent/Judge/program checker或用户steering发现；这是以Agent动态决策换取配置/数据流模型简化的明确边界。

### 2.7 Node

已确认执行类型是代码内置闭集：

```text
actor-task
builtin-program
child-workflow
```

`nodes`使用map，Node ID由key提供，不在对象内重复。Strict discriminated union已确认：

- `actor-task`：`execution={type,role,instruction}`，必须有`checker={checkerId,config?}`、`onPass`，可选`onFail`；
- `builtin-program`：`execution={type,programId,instruction?,config?}`，禁止role/checker，必须有onPass，可选onFail；instruction只指导Manager临时填写program parameters；
- `child-workflow`：`execution={type,workflowId}`，禁止role/instruction/checker/onFail，只允许onPass。

Actor/program结果固定PASS|FAIL。`onPass` target是同Workflow Node ID或END；`onFail`只能是同Workflow Node ID或省略，不能END。FAIL且onFail缺失时当前Node默认BLOCK。Child Workflow是一个Node，不允许Edge直接引用Workflow ID。运行时不改图，不支持任意表达式、变量脚本、多结果分支或并行Node。

## 3. 内置Checker Catalog

Workflow配置通过固定结构引用内置Checker：

```text
checker: {
  checkerId,
  config
}
```

v1唯一可用Checker是`judge.goal-satisfied`。Catalog只是插件源码内部Map，不提供运行时register API。未来可以在不改变上述YAML结构时由新插件版本增加deterministic或judge-assisted checkerId；这种纯新增ID保持`agent-workflow/v1`，只有配置结构/既有语义不兼容变化才升级v2。

### 3.1 `judge.goal-satisfied`

Config只允许非空`criteria`文本。Engine用内置Judge system template包装：独立检查真实现场、不信任Worker自报、禁止修改、只输出strict PASS/FAIL+reason。Node criteria不能覆盖Judge职责、只读toolFilter或output协议。

Fresh Judge固定接收：global Judge persona、内置template、Node instruction/criteria、Worker transient claim、workspace cwd，以及Host从Manager Session临时投影的USER/MANAGER可见文本conversation。投影是Host内自定义瞬时纯函数：遍历`session.events`选取append-origin的`user/message`（`source.kind==='user'`）与`assistant/message`文本块，排除tool/plugin/替换/hidden事件；不使用`deriveMessages()`（它会混入tool results与插件注入内容）。投影不写State；上次Judge结果只有在Manager明确复述进主会话时才会进入，因而不需要额外Manager注入步骤。

```text
output = {
  result: PASS | FAIL,
  reason
}
```

Judge错误、超时、invalid output、缺少读取能力或现场不可读不产生Graph结果，当前Node进入BLOCK。

### 3.2 Builtin Program与Child Workflow直接返回结果

已确认：每个`actor-task`都必须配置Checker，禁止`none`或Worker claim直接PASS；只有actor-task使用Checker。

`builtin-program`引用代码内置programId。Program Definition固定`configSchema/parameterSchema/resultSchema/run(config,parameters)`；Node config是静态值，Manager每次通过current-node专用`node_run_program({parameters})`提供typed动态参数。Parameters不持久化、不形成变量或handoff，中断后重新提供。Program可执行有副作用action或纯只读check，并直接返回PASS/FAIL，不再额外挂checker。例如`github.initialize-milestone`和`github.all-milestone-issues-complete`。

`child-workflow`push Child Run frame；Child达到END后pop并让调用Node视为PASS。Child内部问题由其Node onFail处理或BLOCK暂停，首期不向Parent返回独立FAIL，也不配置额外Checker。

## 4. 串行执行协议

```text
进入Node
├─ actor-task
│  → 找到/创建Role Actor
│  → Worker工作并node_claim(nodeToken,completed|failed,summary,handoffContext?)
│  → 运行checkerId对应Checker（program/judge-assisted/judge）
│  → PASS时把opaque handoffContext传给下一个Node/Child frame
│  → PASS | FAIL
├─ builtin-program
│  → Engine运行programId
│  → PASS | FAIL
└─ child-workflow
   → push Child Run frame
   → Child END时pop并返回PASS
   → Child BLOCK时保留frame并暂停

PASS: current = onPass
FAIL: current = onFail或BLOCK
Root END: Run completed
Child END: pop frame并让Parent child-workflow Node返回PASS
```

每次Program/Judge调用都捕获current nodeToken。异步结果返回后，Host在应用PASS/FAIL/ERROR前重新核对Row和token；token已变化则丢弃该stale内部结果，不修改State。

Run 到达 Root END（status=completed）时，Engine 向 Manager 主会话 steer 一条完成通知（`workflow "<id>" 已完成（run <runId>）`），让用户在 GUI 里明确看到工作流已结束。该通知是 best-effort：失败不影响已持久化的 completed 状态。

任何时刻只有一个Active Node和一个权威Workflow Node executor/checker。Manager监督性conversation与Role helper turns可以并存，但不能执行另一Node或提交Node mutation，除非该Agent正是current mapped executor。Role Actor可在当前Turn内调用Preset提供的helper subagents；helper不进入roleActors/call stack，不是Node executor，Host因agentId不匹配而拒绝其node_claim/node_block等Workflow mutation。Helper raw工具行为按Preset/prompt约束，不改变严格串行Node语义。

### 4.1 PASS/FAIL后串行自动派发下一Node

已确认Engine每次只推进一个Node并自动派发下一步，直到BLOCK或Root END。Manager actor-task通过`agent.steer`进入当前主会话下一Turn；subagent role通过current continuable Actor message；builtin-program steer Manager调用`node_run_program`；child-workflow push frame后派发Child startNode。

不需要每Node人工Continue，也不让Manager忽略Graph role手工改派。自动派发不是Host隐藏长循环或并行：任何时刻只有一个Node/Actor/Judge/Program判断在进行，所有Manager输出、tool card和Child Session仍可见并可由用户交互。

### 4.2 无Node结果或派发失败统一BLOCK

每次派发创建一个live settlement observer并捕获`dispatchedToken`。Manager/Role Actor Turn settled时，只有`status=running && dispatchedToken==current top-frame nodeToken`才允许触发无结果BLOCK：

- State仍是该dispatchedToken且未BLOCK：说明没有accepted`node_claim/node_block`，在同一Node写BLOCK，reason=`actor-turn-ended-without-result`；
- State token已因accepted claim/Edge推进而变化：旧Turn正常结束，不BLOCK；Engine此时才派发新current Node，避免同Role下一消息与旧Turn settlement竞态；
- State已blocked/completed：不再处理。

State推进/Resume生成新token后，如果`agent.steer`、Role Actor create/send或Child start派发失败，Engine立即把同一current Node写回BLOCK，reason=`dispatch-failed`，保留该token用于Status；下一次resume再次旋转token并重派。

Host启动时不尝试恢复进程内Turn/队列：所有`status=running` Row都在原Node写BLOCK，reason=`host-restarted-before-node-result`。原本已blocked/completed Row不变。用户恢复对应Manager Session后查看Status并`node_resume`，生成新token后重新派发；不需要查询active/queued turn。

宿主实现确认：Turn结算观察订阅`ctx.on('session/event')`的durable `turn/end`（post-commit、携带reason），对主Session与session-backed Child都成立；`subagent/end`是Activation-epoch级结算而非逐消息/turn事件，不能用于Node结果关联，Worker Node的结果等待以child session自身的`turn/end`为准。`session/event`回调运行于append发布锁内，对同一Session的同步再append会reentrancy报错，因此无结果自动BLOCK的State写入必须defer（microtask/短队列）后执行。`agent.steer`是void/best-effort（idle立即开turn、running在下一步边界消费），无送达回执；Host以`turn/end`或后续`node_claim`为准确认派发已消费，二者皆无则按4.2进入BLOCK。

## 5. 最小Runtime State

已确认使用Home级极简SQLite多行表：`${DSH_HOME}/workflows/state.sqlite3`。每Row以current session cwd解析出的canonical workspace root path为`workspaceKey`，保存一个current Run；不同Workspace可并发，同Workspace最多一个Run并由managerSessionId拒绝其他Session操作。

Host仍只使用一个SQLite connection和一个短mutation queue；不建设Lease/PID/fencing/takeover/connection pool。Run永久绑定启动Manager Session，其他Session不能接管/推进。Workspace移动不自动迁移旧Row。Current workspace任意direct-human Session可通过`/dsh-flow reset`删除该Row，解决owner Session永久不可恢复问题；Reset不停止旧Actors或清外部资源。SQLite只提供原子写和损坏检测，不增加Event/Attempt/History。

```sql
CREATE TABLE workflow_state (
  workspace_key  TEXT PRIMARY KEY,
  format_version TEXT    NOT NULL,
  state_version  INTEGER NOT NULL,
  snapshot_json  TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;
```

Format version固定`agent-workflow-state/v1`。WorkspaceKey直接由current session`cwd`做filesystem native realpath/canonical absolute path得到，不向上搜索Git/package/project root，也不从YAML读取path。Windows统一drive/separator并解析junction/symlink，POSIX使用realpath；用户选择DSH workspace即选择Run作用域。每Row stateVersion独立递增。

宿主实现确认：Home路径用`resolveDshHome()`解析（显式配置>`DSH_HOME`环境变量>`~/.dsh`），不做shell展开。cwd取自`agent.session.header.cwd`（可选字段）；缺失时`/dsh-flow start`直接报错拒绝启动，不做fallback。SQLite用内置`node:sqlite`的`DatabaseSync`（与DSH storage-sqlite同款依赖），owner-only目录/文件、WAL、prepared statements、单连接加短mutation队列。

Definition Snapshot直接保存在该Row的`snapshot_json.definitionSnapshot`；另存文件名stem`catalogWorkflowId`供Status与Root frame identity使用，Root frame.workflowId固定等于该ID。Start时读取Catalog YAML、strict validate/normalize、解析Role/Judge初始model route、计算definitionHash，并在同一初始写入中保存完整normalized纯JSON；后续Run不再读取原YAML。Snapshot不保存原始YAML/comments/path、Manager system prompt、Preset、Skills或MCP schemas。

已确认Runtime State只保存：

```text
{
  runId,
  managerSessionId,
  catalogWorkflowId,
  definitionHash,
  definitionSnapshot,
  status: running | blocked | completed,
  callStack: [
    {
      workflowId,
      nodeId,
      nodeToken
    }
  ],
  roleActors: { [roleKey]: continuableActorId },
  modelOverrides: { [roleKey | judge]: { provider, modelId } },
  blockReason: string | null,
  nodeBoundary: NodeContextBoundary,
  judgeSessionId?: string,
  pendingClaim?: { outcome, summary, handoffContext? }
}
```

Manager不进mapping；Judge只以`judgeSessionId`引用进State（当前active/pending），不保存Judge历史。ModelOverrides只保存current值不保存历史。State不保存lastError或block kind。Strict invariants：running/blocked要求callStack非空，completed要求callStack=[]；blocked iff blockReason非空且对应top frame token，running/completed要求reason=null；每个frame nodeToken是UUID；roleActors keys只能来自Definition roles，modelOverrides keys只能来自roles或judge。SQLite不保存recentEvents；Command/Tool/Manager/Child过程历史完全复用DSH Session log，Status只读current facts。

不再保存：

- feature-delivery Parent/Child state enum；
- candidate manifest/generation；
- delivery-partial；
- GitHub-specific Effect；
-业务专用Checker状态/evidence结构；
-14类Recovery Code；
-精确外部副作用attempt/history。

### 5.1 Builtin Program错误不走Graph Edge

已确认：Builtin Program只有在业务结果明确时返回PASS/FAIL。网络/API/进程错误或副作用结果不确定属于ERROR/INDETERMINATE，不走Edge，current Node保持并把Run置为BLOCK，写短blockReason并在DSH Session log显示详情；Manager检查现场后重试或请求Judge/人工确认。

有副作用Program应尽量inspect-first，例如先查询Milestone是否已存在，再决定创建；但不建设pendingEffect/receipt/attempt状态机。ERROR不是第三条Graph Edge。

Manager手工resolve允许任何处于BLOCK的current builtin-program使用：Host只校验caller、Node类型和nodeToken，Manager检查真实现场后提交PASS/FAIL+reason。Actor-task不能绕过Checker，Child Workflow只有END返回PASS且BLOCK只暂停；但Manager可对任何BLOCK中的current builtin-program在检查现场后手工PASS/FAIL。

### 5.2 一个Human Command与八个Workflow control tools

Direct-human只使用一个`/dsh-flow` Command负责Catalog/list/start/status/reset。Workflow control model-facing闭集为八个；Judge另有专用`judge_claim`与两个固定只读inspection wrappers，不属于Workflow control：

```text
workflow_status()
node_claim({ nodeToken, outcome: completed | failed, summary, handoffContext? })
node_block({ nodeToken, reason })
node_resume({ nodeToken, resolutionContext })
node_run_program({ nodeToken, parameters })
node_resolve_program({ nodeToken, result: PASS | FAIL, reason })
workflow_set_role_model({ roleKey, provider, modelId })
judge_respawn({ nodeToken, reason? })
```

所有Node mutation tool必须回传current frame nodeToken，过期token拒绝。每次进入新Node、BLOCK后resume同一Node或Actor replacement重新派发时生成新UUID并覆盖；不保存旧token/history。Token是尽力而为的stale防护（防凭记忆用旧token，防不住迟到方实时查`workflow_status`拿新token伪装——已知限制），Actor一律以`workflow_status`为准。Tool description固定要求claim/block为当前Turn最后动作，成功后后续输出/tool语义上忽略；首期不调用DSH interrupt。

Tool exact合同已确认：`workflow_status({})`只读且仅current Manager/current Role Actor；`node_claim`要求Run running、token匹配、completed|failed、1..4000 summary和仅completed可用的1..8000 handoff；`node_block`允许current Worker或Manager在Run running且token匹配时调用，写BLOCK但不interrupt当前Turn；BLOCK后迟到claim因status不再running而拒绝。`node_resume`要求Manager、Run blocked、token匹配、current Role Actor无active turn和1..8000 resolutionContext，生成新token且context不持久化；若派发失败再次BLOCK，Manager下次resume必须重新提供resolutionContext；`node_run_program`要求Manager、Run running、token匹配和current Program strict parameters；`node_resolve_program`要求Manager、Run blocked、token匹配、current builtin-program、PASS|FAIL和1..4000 reason；`workflow_set_role_model`要求Manager、roleKey|judge和非空provider/modelId，目标Worker active时拒绝；Worker override写入后删除current roleActors mapping，旧DSH session保留但不再授权，下一次Node dispatch/resume创建replacement；Judge override只影响下一次Judge重建。Unknown字段拒绝。Judge不调用Workflow Tool，使用专用`judge_claim({nodeToken,result,reason})`提交`PASS|FAIL|NEED_CONTEXT`；`judge_respawn({nodeToken,reason?})`为Manager显式重建当前Judge。claim进入判定阶段后其`{outcome,summary,handoffContext?}`作为`pendingClaim`持久化（判定结束清除；`handoffContext`仅completed且非空时写入，20260902-fixbug 评审方案 2），parameters/resolutionContext/result details均不持久化。

### 5.3 BLOCK是当前Node上的可恢复暂停

`BLOCK`是current Node/Run状态，不是Node结果或Edge target；它不pop frame、不走其他Edge，也不是终态。Current Actor或Manager可主动报告BLOCK；Role Actor turn因quota/provider/error异常结束时Engine也在当前Node进入BLOCK；Builtin Program ERROR/INDETERMINATE进入BLOCK；Checker/Program FAIL且Node未配置onFail也默认BLOCK。Engine保留current Node/call stack，写`Run.status=blocked`和短reason。Manager/用户处理现场后只能resume同一Node（重新message Actor、运行Program或调用Child），或Reset整个Run；不能从BLOCK任意跳到其他Node。

### 5.4 运行轨迹日志（Run Trace Log）

已确认（PRD `docs/prd/workflow-run-logging.md`，R1-R4）：每个Run在文件系统留一份人可读的、按时间顺序的执行轨迹日志，作为派生产物，**不进SQLite State**（保持最小状态原则）。

- **目录**：catalog entry配置文件同级、与workflow同名目录（config path去掉`.yaml`，如`~/.dsh/workflows/smoke-test.yaml`→`~/.dsh/workflows/smoke-test/`）。
- **文件名**：`yyyyMMdd-HHmmss-<runId前8位>.txt`（本地时间；runId短码避免同秒冲突），追加写入、UTF-8。
- **行格式**：每行前缀`[YYYY-MM-DD HH:mm:ss]`（本地时间）。Run启动写`START workflow=<id> run=<runId>`；checker/program判定路由时写`NODE <workflowId>/<nodeId> PASS -> <nextNodeId|END>`或`FAIL -> <onFailNodeId|BLOCK>`；child-workflow压栈写`PUSH -> <childWorkflowId>`，出栈由child的END行与parent节点的PASS行共同记录；行内始终含所属workflowId。
- **失败容忍（R4）**：tracelog模块所有函数绝不抛错——目录/文件创建失败返回`undefined`、追加失败静默忽略，日志问题永不影响Run推进。Engine以runId为键在内存中保存日志路径，Run completed或reset时清理。
- **不做**日志轮转/清理/归档、Web UI展示、turn级对话内容记录、用户自定义格式/路径（本期格式固定）。

## 6. 中断恢复

已确认不区分working/checking/interrupted/recovery phase。Active Run始终只停在current Node。判定阶段的`pendingClaim`持久化供Judge重建；其余claim/Judge过程存在于当前DSH对话和调用过程，中断窗口丢失就让Worker重新claim。PASS后只把handoffContext发送给下一Actor/Manager，不持久化；发送窗口丢失时重新询问或重建。

中断后Manager统一处理：

```text
读取current frame/node
→ 有Worker continuable session就发消息让其检查现场并继续
→ Worker session不可用就创建replacement并发送current Node/context
→ 判定阶段BLOCK：judgeSessionId存在则followup该Judge，不存在则spawn重建；judge_respawn显式重建。Engine在admission前预留并持久化judgeSessionId；spawn/admission失败必须清除该id，避免followup不存在的Judge
→ builtin-program无Actor时由Manager重新运行program，或创建fresh Judge/由Manager判断现场是否已成功
→ 成功则推进PASS Edge
→ 未成功则重新执行/继续当前Node
```

不建设pendingEffect/inspect handler。Manager/Worker读取Git、GitHub、文件、远端环境等真实现场，自行决定继续、重做、重新claim或保持BLOCK。

插件只保证current Definition/Node/call stack/Actor mappings不丢失；不保证claim/Judge中间结果或Node内部外部动作精准恢复，丢失时重新claim/判断/执行。

## 7. 配置与静态校验边界

必须校验：

- Role/Node/Workflow ID唯一；
- role、child workflow、edge引用存在；Workflow引用图必须是DAG，禁止直接/间接递归；同一Child可被多个Node引用并通过Node Edge循环重复调用；
-每个Workflow一个startNode；Root startNode固定actor-task/manager，Child startNode类型不限；
- onPass target必填且合法，onFail可选但存在时target合法；
- Root/Child的END可达；允许某些FAIL路径无edge并进入BLOCK；
- Node execution type与配置字段匹配，所有actor-task都有合法checkerId；
- Judge Role存在且不作为普通工作Role；
-运行时Definition hash不变；
-禁止并行、任意表达式、脚本transition、动态改图。

Graph本身允许显式循环；循环终止由后续Node PASS/FAIL和Manager steering决定，不预建通用循环变量/计数表达式。

### 7.1 Milestone/Issues循环示例

GitHub业务不再写死成Engine状态机，而由built-in Node action/checker组合：

```text
initialize-milestone
  PASS → develop-next-issue
  FAIL且无onFail → 当前Node BLOCK

develop-next-issue
  PASS → all-issues-complete?
  FAIL → develop-next-issue

all-issues-complete?
  PASS → next-milestone-stage
  FAIL → develop-next-issue
```

`initialize-milestone`是builtin-program；`all-issues-complete?`是builtin-program读取live GitHub Milestone Issues。Engine不复制Issue列表/状态。循环中先经过一个Manager `actor-task`选择下一个未完成Issue，在临时completion claim的opaque handoffContext中写Issue URL/repository，Checker PASS后作为消息发给后续开发Node或Child Workflow；不写State。系统中断后同一Actor检查Milestone/Issue现场再继续，不做精准外部Effect恢复。

重复的单Issue开发/Review/Test/Delivery/Close区域可以定义为Child Workflow，由`develop-next-issue`调用；每次调用push Child Run frame，结束后返回Parent检查节点。

### 7.2 首期不开发自定义Workflow Web UI

首期复用DSH主聊天、Command/Tool Cards、Child Session hierarchy和Session log。`/dsh-flow status`展示current workspace的workflow/status/call stack/node/role/blockReason/model override。Manager输出和Tool调用直接显示在主会话，Role工作在可导航Child Session。删除Client Plugin Dashboard、polling、modal、HMR和状态同步；未来可在稳定Engine API上另加可视化。

## 8. Milestone/Issues完整配置示例

文件：`${DSH_HOME}/workflows/milestone-delivery.yaml`

```yaml
schemaVersion: agent-workflow/v1

roles:
  developer:
    persona: |
      Implement the current issue. Use the issue and repository context
      supplied by the Manager. Report only through node_claim/node_block.
      node_claim/node_block is the FINAL action of your turn; call it at most
      once per turn, and never after a successful claim.

  reviewer:
    persona: |
      Review the current issue implementation independently.
      Do not modify implementation files.
      Report only through node_claim/node_block — a text report alone does not
      submit your result. node_claim/node_block is the FINAL action of your
      turn; call it at most once per turn.
    tools:
      deny: [edit, write]

  tester:
    persona: |
      Execute the tests required by the current issue and leave a clear report.
      Report only through node_claim/node_block. node_claim/node_block is the
      FINAL action of your turn; call it at most once per turn.

judgeRole:
  persona: |
    Independently inspect the current claim and real workspace/remote facts.
    Never modify evaluated artifacts. Submit your verdict ONLY through
    judge_claim({nodeToken, result: PASS|FAIL|NEED_CONTEXT, reason}).
    Prefer PASS/FAIL; use NEED_CONTEXT only when information is genuinely missing.

workflow:
  startNode: draft-prd
  nodes:
    draft-prd:
      execution:
        type: actor-task
        role: manager
        instruction: |
          Use the current Manager conversation to create or update the PRD.
      checker:
        checkerId: judge.goal-satisfied
        config:
          criteria: |
            Inspect docs/prd. PASS only when a PRD exists and covers the
            current user goal, scope, non-goals and acceptance criteria.
      onPass: initialize-milestone

    initialize-milestone:
      execution:
        type: builtin-program
        programId: github.initialize-milestone
        instruction: |
          Choose the Milestone title and branch name from the current PRD.
      onPass: plan-issues

    plan-issues:
      execution:
        type: actor-task
        role: manager
        instruction: |
          Create and organize the GitHub Issues required to deliver the PRD.
          When using `gh issue create`, pass the milestone by TITLE
          (--milestone "<title>"), NOT its number — the gh CLI --milestone flag
          expects a title, while `gh api ...?milestone=` expects a number.
      checker:
        checkerId: judge.goal-satisfied
        config:
          criteria: |
            Inspect the PRD, Milestone and Issues. PASS only when required
            Issues cover the PRD and each Issue is actionable.
      onPass: run-issue-cycle

    run-issue-cycle:
      execution:
        type: child-workflow
        workflowId: issue-cycle
      onPass: final-review

    final-review:
      execution:
        type: actor-task
        role: reviewer
        instruction: |
          Review the completed Milestone against the PRD.
      checker:
        checkerId: judge.goal-satisfied
        config:
          criteria: |
            Inspect the PRD, Milestone Issues and delivered code. PASS only
            when the Milestone satisfies the acceptance criteria.
      onPass: END
      onFail: plan-remediation

    plan-remediation:
      execution:
        type: actor-task
        role: manager
        instruction: |
          Turn the final-review findings into one or more unfinished,
          actionable remediation Issues in the current Milestone.
      checker:
        checkerId: judge.goal-satisfied
        config:
          criteria: |
            PASS only when every blocking final-review finding is covered by
            an unfinished actionable Issue in the current Milestone.
      onPass: run-issue-cycle

childWorkflows:
  issue-cycle:
    startNode: select-next-issue
    nodes:
      select-next-issue:
        execution:
          type: actor-task
          role: manager
          instruction: |
            Inspect the current Milestone and select one required unfinished
            Issue. In node_claim handoffContext, state its URL and repository.
        checker:
          checkerId: judge.goal-satisfied
          config:
            criteria: |
              PASS only when the selected Issue exists, is unfinished,
              belongs to the current Milestone and is actionable.
        onPass: deliver-one-issue

      deliver-one-issue:
        execution:
          type: child-workflow
          workflowId: issue-delivery
        onPass: all-issues-complete

      all-issues-complete:
        execution:
          type: builtin-program
          programId: github.all-milestone-issues-complete
          instruction: |
            Use the current Milestone number from the Manager conversation.
        onPass: END
        onFail: select-next-issue

  issue-delivery:
    startNode: implement
    nodes:
      implement:
        execution:
          type: actor-task
          role: developer
          instruction: |
            Implement the Issue identified in the current handoff message.
            On completed claim, carry its URL, repository and branch forward
            in handoffContext for Reviewer.
        checker:
          checkerId: judge.goal-satisfied
          config:
            criteria: |
              Inspect the Issue discussion, repository and commits. PASS only
              when the requested implementation is complete and published,
              and the claim handoff identifies the Issue/repository/branch.
        onPass: review
        onFail: implement

      review:
        execution:
          type: actor-task
          role: reviewer
          instruction: |
            Review the current Issue implementation. On completed claim,
            carry the Issue URL, repository and branch forward for Tester.
        checker:
          checkerId: judge.goal-satisfied
          config:
            criteria: |
              Inspect the Issue, diff and repository. PASS only when the code
              satisfies the Issue, has no blocking quality problem, and the
              claim handoff preserves Issue/repository/branch identity.
        onPass: test
        onFail: implement

      test:
        execution:
          type: actor-task
          role: tester
          instruction: |
            Test the current Issue implementation and publish a clear result.
            On completed claim, carry the Issue URL, repository, branch and
            test report location forward for Manager delivery.
        checker:
          checkerId: judge.goal-satisfied
          config:
            criteria: |
              Inspect the Tester report and relevant repository state. PASS
              only when required tests were executed and passed, and the claim
              handoff preserves Issue/repository/branch/report identity.
        onPass: complete-issue
        onFail: implement

      complete-issue:
        execution:
          type: actor-task
          role: manager
          instruction: |
            Deliver the tested implementation according to repository policy
            and close the current Issue only after delivery is verifiable.
        checker:
          checkerId: judge.goal-satisfied
          config:
            criteria: |
              Inspect the Issue, repository and delivered revision. PASS only
              when the implementation is delivered and the Issue is closed.
        onPass: END
        onFail: implement
```

运行时，`initialize-milestone`与`all-issues-complete`由Manager调用`node_run_program`提供临时typed参数。Manager选择Issue时的handoff只作为下一Child Actor消息，不写State。任何无onFail的FAIL、Actor block、Program ERROR或Judge异常都会在current Node进入BLOCK。

## 9. 预计保留与删除

### 保留并简化

- Role Definition/model/persona/tools.deny；
- current Role Actor mapping；
- continuable subagent与steering；
-每Workspace一个current Run的Home级SQLite State Store；
-严格串行；
-transient current Node claim与消息handoff（不写State）；
-固定Node execution/program/checker catalog；
-一个Judge Role配置；每次判断使用fresh non-continuable Judge Agent；
-`/dsh-flow` list/start/status/reset与最小Node Tools；
-DSH Session log可见性（SQLite不重复保存事件）。

### 删除或整体替换

- `feature-delivery/v1`业务专用Parent/Child状态机；
-固定PRD/Review/Test/Delivery阶段；
-candidate/delivery schema；
-GitHub Adapter/14 Effect合同；
-Tester专用执行协议；
-七阶段Dashboard；
-业务专用Recovery Codes与Tool集合。

## 10. Builtin Program与Checker合同

### 10.1 v1 Builtin Program合同

首期仅两个Program：

- `github.initialize-milestone`：固定当前Workspace GitHub repository/remote/current HEAD，Manager临时提供`{title,branchName}`；clean前提下inspect-first创建/核实Milestone和local+remote exact branch，返回PASS/FAIL/ERROR及transient milestone/branch details；
- `github.all-milestone-issues-complete`：固定当前Workspace repository，Manager提供`{milestoneNumber}`；无Issue或存在open Issue返回FAIL，全部closed返回PASS，无法读取返回ERROR，并返回transient counts。

实现决策已确认：GitHub访问统一走`gh`CLI（`gh api`，与wfgate原型同款方式），认证复用`gh auth`、不引入插件自有token配置；插件另持一个极小的git subprocess adapter（`git rev-parse --show-toplevel`、`symbolic-ref`+detached HEAD回退、`remote get-url`、`status --porcelain=v1`，参数数组、无shell）。DSH宿主不提供Git/GitHub工具包；`gh`缺失或非git workspace时Program返回ERROR并BLOCK。Repository/path/remote不能由Manager提供。

Program parameters/details不持久化；ERROR当前Node BLOCK，重跑时先inspect真实现场。

### 10.2 Builtin Catalog不可运行时扩展

Program/Checker Catalog只是插件源码内部固定ID→implementation/schema Map，不向Cordis或其他插件提供register API。新增ID但保持现有YAML结构/语义时可留在`agent-workflow/v1`，只需修改插件、测试并发布新版本；只有结构或既有语义不兼容变化才升级v2。恢复时Host不支持Definition Snapshot中的ID则停止Run，用户恢复兼容插件版本或Reset，不做动态fallback。

### 10.3 `judge.goal-satisfied`合同

Node config只允许`{criteria}`文本，trim后1..8000字符。每次fresh Judge收到global persona、内置独立只读判断template、Node instruction/criteria、Worker transient claim、workspace cwd，以及Host临时生成的Manager Session USER/MANAGER可见文本projection；projection排除system/tool/subagent/hidden内容且不写State。上次Judge只有被Manager明确复述到主会话时才会进入。

Structured output固定`{result:PASS|FAIL,reason}`，reason必填，trim后1..2000字符，不能返回nextNode/tool/handoff。Judge provider/timeout/invalid output/缺read能力/现场不可读不产生Graph结果，当前Node BLOCK并可由Manager创建fresh Judge重试。Worker即使claim failed，Judge仍按真实criteria独立判断。

## 11. 后续工作

旧`feature-delivery/v1`系列文档已删除，Git历史保留原设计。当前只有本文与`CONTEXT.md`作为权威需求/设计。

后续如继续设计，只讨论实现模块边界、测试拆分和DSH插件接入；在用户明确要求前不开始代码实现。
