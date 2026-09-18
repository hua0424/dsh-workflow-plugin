# 命名结果、出口验收合同与子流程返回值

状态：设计访谈结论已确认（2026-09-17），待实施；跟踪 Issue：[#128](https://github.com/hua0424/dsh-workflow-plugin/issues/128)。本文件同时作为插件改造 Issue 的完整规格。语法为待实现的 v3 合同，不代表当前 v2 已支持。

## 问题与目标

当前 completed/failed 同时承担动作结果和业务分支，failed 被用于返工、任务穷尽、取消和跳审。Child 到达 END 后只走父调用节点 onPass，业务返回含义只能从 handoff 猜测。Actor 收到 instruction，Judge 以 criteria 为权威，二者容易发生合同漂移。

本轮只围绕命名结果、出口验收合同和显式 Workflow 返回，减少专门选路的节点及重复解释。结果名称由工作流声明，不内置开发角色、GitHub、单仓或多仓业务语义。

## 方案基线

- Actor 以单一 `result` 表达命名业务结果，并保留唯一 `handoff`；不叠加 outcome 和 exit 两套业务分类。
- 每个节点声明有限结果集合与静态目标；Actor 不能指定任意 nodeId 或动态修改 Graph。
- 验收合同包含所有出口的共同条件及每个出口的结果条件。Actor 与 Judge 使用同一份随 Run 冻结的合同。
- Judge 保留 ACCEPT / REJECT / NEED_CONTEXT，核验共同条件和当前 claim 所选结果的 criteria，不改选业务结果，不要求逐个排除其余出口。事实明确不符合标准时 REJECT；需要补充信息时 NEED_CONTEXT。
- 出口合同设计为互斥；一次 claim 只能选择一个 result 并沿一条边推进，不引入优先级路由或多分支执行。插件不声称能静态证明自然语言条件互斥。
- ACCEPT 后才按已确认 result 原子推进。REJECT 留在同一工作单修正；NEED_CONTEXT 保留 claim 并 BLOCK。
- 缺权限、网络故障、证据不足仍使用 BLOCK，不当作业务出口。
- Child 声明有限返回集合，父调用节点显式映射；返回值来自已结算的子流程终局，不从自由文本提取。
- Child 包装层不追加 Actor/Judge；支持嵌套返回及父层继续返回。
- Root 运行生命周期与业务终局分离：执行结束不等于业务交付成功。取消是已定义的业务终局，reset/terminated 是控制面终止。
- 沿用派发身份、nodeToken、claim/input version、CAS、Actor/Judge 安全收口、原子交接与恢复约束。

## 领域术语

- **Node Result（节点结果）**：本节点声明且由执行者提交的业务结论，名字只在该节点的结果集合中解释。
- **Exit Contract（出口验收合同）**：确认节点结果成立所需的共同条件及该结果的验收条件；由工作流定义为互斥，不依靠出口优先级解决冲突。
- **Workflow Return（流程返回）**：流程正常结束时对调用方暴露的业务结果；由终局路由显式产生。
- **Return Mapping（返回映射）**：调用节点将被调用流程的返回值映射到本层后继或本层返回的静态声明。

术语已纳入 CONTEXT.md 的“下一版、尚未实施”区块，现行 v2 合同在实施前保持不变。

## 已确认决策（Q1–Q6）

1. 停机切换：先结束旧 Run，再迁移配置；不保留 v2 运行兼容。不实施双版本运行时和 outcome/result 双协议工具。
2. 出口互斥：一次提交一个结果，走一条分支；不支持重叠出口及优先级选路。
3. 通用协议与测试示例属于本轮；实际 milestone-delivery 配置及配套合同迁移另开关联 Issue。
4. 审查示例中，存在未解决争议则 disputed；无争议且有必修项则 changes-required；无争议且无必修项则 approved。这是工作流示例，不是插件内置规则。
5. Judge 按共同条件及所选结果的 criteria 核验；需要补充信息再 NEED_CONTEXT。不增加遍历所有出口并证明唯一性的额外任务。
6. 选择停机切换方案 A：结束旧 Run，显式备份旧状态库，再初始化新库；旧历史保留在离线备份中，新版本不提供旧历史查询。

## 配置与工具合同

配置版本改为 `agent-workflow/v3`；不接受 v2 配置，不把 v2 的 failed 猜测转换为任何业务结果。沿用受限 YAML、严格未知字段拒绝、固定角色引用、Root manager 起点、Child 无递归和可达性约束。

### 统一目标与流程返回

- Root 与每个 Child WorkflowDef 均声明非空且不重复的 `returns` 名称列表。
- 统一 Target 是严格互斥的 `{ node: <本流程节点名> }` 或 `{ return: <本流程返回名> }`，恰好一个字段。
- 不再使用裸字符串 END，不提供默认路由、通配映射、表达式或动态目标。
- 节点结果名与流程返回名各自在其局部集合中解释，沿用小写 `[a-z][a-z0-9-]*` 标识符规则。
- 每个声明返回至少存在一条结构可达的返回路径；这只保证图结构，不声称自然语言条件一定能被满足。

### Actor Node

保留 execution 与 `checker.checkerId: judge.claim-correct`。`checker.config.criteria` 为可选的非空共同条件；`results` 是必填非空映射，每项必须含非空 criteria 和一个 target。单结果节点也明确声明，不隐含 completed。Actor Node 不再接受 onPass/onFail。

```yaml
# 节点片段：不是完整 catalog
review:
  execution:
    type: actor-task
    role: reviewer
    instruction: 审查本次交付，给出发现、依据和结果。
  checker:
    checkerId: judge.claim-correct
    config:
      criteria: 报告绑定当前对象与确切修订，证据可读。
  results:
    approved:
      criteria: 无未解决争议，且无本次必修项。
      target: { node: merge }
    changes-required:
      criteria: 无未解决争议，存在有依据的本次必修清单。
      target: { node: implement }
    disputed:
      criteria: 存在有证据说明的未解决业务争议；单纯缺少执行或核验信息不满足此条件。
      target: { node: adjudicate }
```

`node_claim` 严格只接受 `{ result, handoff }`，两者必填；不接受 outcome、exit、nodeId、额外业务字段。handoff 沿用 trim 后 1..8000 字符，终局也必填。result 必须在当前冻结节点声明中，运行时校验与身份/phase 校验在写入 claim 前完成；非法提交不得消费派发或写入部分状态。工具提供语法说明，运行时的当前节点枚举校验是权威。

Actor 初次派发、REJECT 修正和恢复均收到同源的共同条件及全部合法结果条件。Judge 收到共同条件、所选结果条件、result、handoff 和现有核验上下文；不要求注入所有分支或完整 instruction。需要强制核验的业务要求须进入验收合同，不能只藏在 instruction 中。

persona 继续承担 system 层稳定职责；更新插件拥有的提交说明以匹配新协议，不把原有 system 层业务纪律批量挪到普通上下文。本轮不建设通用 system prompt 编排框架。

### Child Node

Child caller 保留 `execution: { type: child-workflow, workflowId: ... }`，以必填 `onReturn` 替代 onPass，其键集合必须与被调用流程的 returns 集合完全一致，值为本层 Target。缺映射和多余映射均静态拒绝。

```yaml
# 父流程中的调用节点片段
run-issue-cycle:
  execution: { type: child-workflow, workflowId: issue-cycle }
  onReturn:
    exhausted: { node: integrate }
    cancelled: { return: cancelled }
```

子流程的某个结果通过 `{ return: exhausted }` 返回时，保存返回名、终局来源 executionId 和 handoff；父 caller 按自己的映射继续。每层可以映射为另一个本层返回名，不能把最底层结果名未经映射直接穿透所有祖先。

handoff 原文逐层传递，不重新摘要或追加第二份 handoff。后继派发的控制上下文提供已确认的直接前驱结果：Actor 使用节点结果名，Child caller 使用该 Child 返回名，Program 使用 PASS/FAIL；该字段由插件提供，不从文本猜测，也不允许 Actor 伪造。Root 初始输入没有前驱结果。

### Program Node

首版保留现有 Program 的 PASS/FAIL/ERROR 执行协议和 Manager 参数提供机制，不引入自定义 Program result 或自动执行框架。Program Node 必填 onPass 和 onFail，二者值改为统一 Target，因此可继续到节点或显式返回流程结果；不配置 ERROR 路由，不给 Program 增加 Judge。

ERROR/抛错/结果未知继续 BLOCK。保留 Manager-only 的 `node_resolve_program` 事实确认与审计能力；显式确认 PASS/FAIL 后沿相应静态目标推进。不能把“ERROR 不自动路由”误写成“永久禁止人工核实恢复”。

## 状态、恢复与升级

- claim、previousClaim、judgment 关联、事件、状态校验与 trace 从 outcome 改为 result；保留精确身份和防重复机制。
- ACCEPT、节点退出、各层 Child 返回记录、后继登记或 Root 终局在同一事务提交；事务失败不得留下部分 pop/返回/后继。
- REJECT 归档原 claim，在同一 execution 重新提交；可以选择另一合法 result，但仍需重新 Judge，不能沿原边偷跑。
- NEED_CONTEXT 保留当前 claim；Manager 补充事实不改冻结合同。恢复/respawn 仍绑定 claim 和 inputVersion；旧 Judge 无权推进。
- Root 终局记录业务返回名与其来源，唯一 handoff 仍从终局工作单读取；不得再造一份可漂移的 Run.finalHandoff。status 保持 completed 表示执行已结束，业务返回单独展示；terminated 不伪造业务返回。
- status、最终通知与 trace 展示已选节点结果/Child 返回/Root 业务返回，不将 cancelled 一概渲染为交付成功。
- 升级状态格式（从当前 v9 到新版本）；旧库进入显式不兼容维护路径，不静默写入、转换、清空或恢复旧 Run。
- 停机前使用旧版结束或显式终止活动 Run，并核查参与者/外部操作已安全收尾；reset 不被描述为已经取消全部外部副作用。
- 沿用现有显式备份后新建状态库机制。备份失败不得初始化新库；SQLite/WAL 一致性及异常库保护沿用既有实现。旧历史离线保存，新运行时不提供旧历史查询。
- 回滚须停机，保留新库备份，再恢复匹配旧版的旧库/配置；不允许旧插件直接打开新格式，也不承诺自动合并切换后的历史。
- 本 Issue 只实现能力、隔离测试、升级手册；部署、重置真实库和修改真实 catalog 是另行明确授权的操作。

## 验收条件

- [ ] A01：完整 v3 示例包含至少三出口 Actor、单出口 Actor、两个不同 Child 返回及 Root 终局；schema 严格拒绝 v2 和混用旧字段。
- [ ] A02：未知 result、额外字段、无/空 handoff、旧派发及跨节点提交被拒绝且不消费资格、不写入部分状态。
- [ ] A03：三个互斥业务结果分别在 ACCEPT 后进入对应唯一后继；每次只创建一个后继，无额外选路 Actor/Judge。
- [ ] A04：Actor 和 Judge 的共同/所选条件同源于冻结快照；修改磁盘配置不影响活动 Run；初次派发及恢复/REJECT 均覆盖。
- [ ] A05：REJECT 不走业务返工边，留在同一 execution；改选结果后必须重新核验。NEED_CONTEXT 保留 claim 并可补证恢复。
- [ ] A06：重复 ACCEPT、旧 claim/inputVersion、迟到 Judge 不重复推进；保留安全收口时序，Judge 不在自身工具中 drain 自己。
- [ ] A07：Child 不同返回映射到不同父后继；两层返回可以逐层重命名并到达 Root；来源、handoff 和直接前驱结果正确，包装层不多派 Judge。
- [ ] A08：缺失/额外返回映射、未知返回名、非法目标、同时 node+return、裸 END、不可达节点/返回及 Child 递归均在 catalog 校验时拒绝。
- [ ] A09：交接事务故障全部回滚；重启恢复 checking/BLOCK/已登记后继及嵌套返回时不丢业务结果、不重复推进。
- [ ] A10：Root delivered/cancelled/no-change 等配置名称明确区分；reset 仍为 terminated，不制造业务结果。
- [ ] A11：Program PASS/FAIL 支持节点和返回目标；ERROR 不自动路由，合法 Manager 事实确认后恰好推进一次，越权/旧 token 拒绝。
- [ ] A12：临时旧库升级测试证明不静默改写；备份失败不建新库，备份成功后新库可启动 v3。所有切换测试使用隔离临时 home，绝不触碰真实 home。
- [ ] A13：同步领域文档、用户手册、示例和提交协议；清理现行入口中的旧 outcome/onPass/onFail Actor/Child 用法，历史文档明确版本不伪改历史。
- [ ] A14：`pnpm run verify` 按现行验收/环境 skip 规则通过；修改涉及 Host 派发合同则补相应真实 Host 检查，并与受控 smoke 分开报告。

## 实施切分建议（同一 Issue 内）

1. v3 类型/schema/静态验证及最小配置用例。
2. claim 工具与同源验收合同派发、Judge 判定和节点路由。
3. Child/Program 目标、原子返回与 Root 终局、状态事件/恢复。
4. 不兼容库切换保护、文档/示例迁移和整体验收。

修改前复核最新主线，复用现有状态事务、身份校验与安全收口实现；不为这次协议建立第二套 Runtime。

## 当前明确不扩展

不增加并行调度、任意脚本/表达式路由、动态改图、结构化业务 payload 平台、GitHub 专用角色或多仓调度器。其他 token 优化另行立项。

## 相关工作

- 后续配置迁移：[#129](https://github.com/hua0424/dsh-workflow-plugin/issues/129)，以前置依赖 #128 独立验收。
- 现有 #126 涉及 milestone-delivery 跳审及收尾合同矛盾；本方案提供通用表达能力，不自动视为已修复该配置。
- 工作区已有 INDEX.md、review-contract.md 修改和新增流程合同/operations 文档，本轮保留，不覆盖。
