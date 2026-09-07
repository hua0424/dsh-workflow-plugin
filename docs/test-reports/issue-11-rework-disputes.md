# T4 / Issue #11：同节点返工、判断历史与争议协调

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/11>。
- 分支：refact；起始代码固定点 `0be6fd19d3879efdb51e109f73396916a4baeed6`，正式 precommit 审查排除其后的独立文档提交。
- 状态：初次提交 `b060dab7bb57ae793991f5746bc4b7016bebfba6` 后因延迟终审重开；follow-up安全补丁、验证和重新双轴终审现已完成，随本报告更新提交。
- 用户示例配置不修改；不 push、部署或操作真实 Run。

## 目标

同一 execution 完成多轮 claim/Judge：REJECT 保存被拒 claim 和 Judge 关联、撤销当前资格并重派原 Actor；NEED_CONTEXT 保留当前 claim，Manager 补充先入库再续 Judge。Actor 对判断有异议时复用 node_block/resume，统一提示而不增加 appeal/辩论系统。

Manager 通过既有 workflow_status 入口请求当前 Run 某 execution 的有界事件页；默认 status 不倾倒历史，Actor/Judge/跨Run查询被拒。

## 数据取舍

State format 由 v3 正规升级 v4。NodeExecution 使用 ExecutionClaim、统一 ExecutionJudgment、已失效 previousClaim 和一个有界的当前 Manager resolution 结构；关键 events 保存旧快照，不建 attempt/outbox/新表，不靠事件回放恢复。ACCEPT/REJECT/NEED_CONTEXT 的当前有效性由 claim/Judge/inputVersion 关联决定。

## Red → Green

1. 真实 Runtime + 临时 SQLite：REJECT 原先返回 T4 unsupported；实现后同 execution 保存 previousClaim/统一 judgment，撤销旧资格、重派原 Actor，新 claim 绑定新 Judge。两claim/两judgment及迟到旧结果 RED→GREEN。
2. NEED_CONTEXT 原先未接通；实现为保留 current claim + BLOCK。Manager完整context先持久化、inputVersion递增，同 Judge Session使用新dispatch/message followup，旧Turn拒绝，RED→GREEN。
3. Judge packet 已泛化 previousFeedback：首次、same-session followup、fresh respawn 都从同一工作单生成，包含当前input/claim、上一轮 REJECT/NEED_CONTEXT 和 Manager context；不依赖旧 Session 历史，RED→GREEN。
4. Actor显式接手 NEED_CONTEXT 时完整收到Judge reason、旧claim/handoff和Manager context；与REJECT材料区分，RED→GREEN。
5. respawn 持久化fresh Judge意图和有界Manager decision，保留claim/feedback/context，从Manager Turn安全drain旧Judge，事件关闭重开仍可读，RED→GREEN。
6. 同execution重派只跳过Node边界compact。Actor主动BLOCK且旧dispatch未settled时先safeToInspect并重验CAS；不安全不重派，安全后继续，GREEN回归。
7. DSH Host followup 返回实际新messageId，不能以同Session代替派发身份；index动态授权按current claim/input判断旧/新Judge Turn。
8. resolution 只有context（判定输入）和decision（控制审计）两个职责，可同时存在；必须至少一个且inputVersion为当前。坏状态/发送失败回归正在补。
9. 普通resume与REJECT文案只承诺状态已提交/driver已触发，不把派发意图误报为已送达。Judge模板改为submitted claim，保持completed/failed对称。

10. workflow_status 增加executionId/after/limit，根参数open时显式拒绝unknown/非法组合。父检查发现实际index adapter只转发ws而静默丢caller/history（TypeScript允许少参数），已要求补完整wiring回归；分页空页游标也必须终止，不能返回原after造成循环。

11. `scripts/e2e-smoke.mjs` 已直接迁移到三表 Runtime 并实跑 PASS：Manager REJECT同execution纠正、旧Judge迟到拒绝；Role failed被ACCEPT后走onFail自环新visit/accepted handoff input/一次compact；同visit REJECT不compact；最终ACCEPT/END、两claim/两judgment事件、SQLite关闭重开和基础trace。模型派发仍为受控Host，不冒充A30真实宿主。

核心Runtime、历史查询实际wiring、公开工具和旧e2e迁移均已绿；测试分类、父独立复验及双轴审查见下文。

## 最终检查

| 检查 | 实施者 | 父任务独立复验 |
|---|---|---|
| pnpm run build | PASS | PASS |
| T4/T3相关组合 | 初次提交前114/114；follow-up最终121/121 PASS | 初次提交前93/93；follow-up最终100/100 PASS |
| test/single-handoff.test.ts | 迁移后4/4 PASS | 包含在父相关组，PASS |
| node scripts/t3-smoke.mjs | PASS | PASS |
| pnpm run test:e2e | 迁移后PASS | PASS |
| pnpm test | 初次提交前267项164 PASS；follow-up最终274项171 PASS/103 FAIL/0 skip/cancelled | 父复核最终同为274项171 PASS/103 FAIL/0 skip/cancelled，exit 1 |
| T4-owned git diff --check | PASS，仅换行提示 | PASS |

剩余103项精确归类：`test/engine.test.ts`旧MemState/Run pending及T5–T9行为91项，`test/state.test.ts`旧单表11项，`test/review-fixes.test.ts` T7 Program 1项。原single-handoff四项已迁回全绿。没有删除或skip；本票按批准的refact集成中间态交付，T9必须恢复最终全量绿。

两套smoke均使用隔离临时home和受控Host/模型派发，不冒充真实目标宿主Run；A30仍留T9。

## Standards

首轮独立审查：2项硬违规、1项possible smell。

1. 高：Host drainJudge 吞掉Manager缺失/宿主drain异常，respawn仍可能启动fresh Judge，不符合旧实例无法确认收口即BLOCK。修复要求错误传播至Runtime dispatchFault，阻止spawn并保留材料。
2. 中：工具/README仍有resolution/respawn reason写入trace的旧承诺，但T4专属trace明确留T9。修正文案，不提前新增trace。
3. possible Speculative Generality：PendingCorrection已无消费者，只剩死导出，应删除。

三项均已修复：drain/Manager缺失错误传播并按正确顺序重建；工具/README只承诺SQLite events；死PendingCorrection删除。最终Standards复审为0项，12类smell均无发现。后续Spec组合修复也未新增违规；previousClaim只保留一代当前材料，旧判定在append-only events中保留，不构成数据丢失。

## Spec

独立审查发现并进入修复：

1. drainJudge吞错已先修为传播，但这暴露顺序问题：respawn先覆盖并持久化new Judge，再drain old；drain失败后current state丢失原old身份，retry会drain不存在的新id后错误启动。修复采用先drain old成功、再重读CAS、再登记/spawn fresh，不新增retiring字段或事件回放；失败保留old身份。
2. ACCEPT后继ready若因前驱Judge无法安全收口而BLOCK，node_resume会把Run改running，随后drive因predecessor未settled直接return，形成永久静默。T4最小拒绝该不适用resume并保持可见BLOCK，完整未知恢复留T6。
3. 默认status返回整个execution，使Role可读完整claim/previousClaim/Manager context，违反I12/A26摘要+preview。改为有界当前投影；完整events只在Manager显式history。
4. respawn在cwd/安排前失败时仍返回ok和“committed”，与实际无event/无spawn不符；改为ok:false准确原因，BLOCK材料照常保留。
5. 运行时已拒绝v3三表，但缺少真实SQLite v3 fixture证明拒绝后schema/version/rows不变；补定向证据。
6. Judge可见工具描述仍把“证据不足”归REJECT，与协议冲突；改为仅既有criteria/事实冲突用REJECT，信息不足/要求不清必须NEED_CONTEXT。

前述 drain retry、silent stall、字段化status、失败返回、index forwarding和NEED_CONTEXT协议均已修复。最终Spec复审另发现3项未解决并进入第二轮修复：

- 高：claim1 REJECT→claim2→Judge2无结论BLOCK→target actor 会用claim2覆盖previousClaim但保留claim1 judgment，触发不变量异常。应清理不再对应当前退回claim的旧judgment，历史仍由events保存，并给Actor完整claim2+Manager context。
- 高：current judgment不变量缺 `judgment.judgeSessionId === judge.sessionId`，坏快照可能让NEED_CONTEXT续到错误Session。补身份一致校验和原始快照损坏拒绝。
- 中：v3测试只是v4库改版本，未证明真实历史v3 DDL及三表全部数据原样。改用T3固定v3 DDL+三表sentinel，比较文件hash、schema、user_version和全部rows。

三项均已修复：退回Actor只保留最新previousClaim，错配旧judgment从当前投影清除但events历史保留；current judgment同时绑定Judge dispatch/session；v3使用固定历史DDL与三表sentinel，拒绝前后SHA256、完整schema、user_version和全部rows一致。最终Spec复审为0项；此前drain顺序、silent stall、status投影、失败返回和Judge协议修复均无回归。

先前一度记录 Standards 0 / Spec 0 并提交，但 Spec 审查随后撤回批准并确认2项：

1. **高**：Judge无结论/不安全收口形成BLOCK后，`node_resume target=judge` 会删除并仅retire旧Judge，再由driver启动新Judge，绕过safeToInspect/drain，可能与旧Judge/工具并行。
2. **中**：historical REJECT只保留judgment中的dispatch/session字符串，工作单已删除旧judge；当前不变量无法验证这两个身份，坏快照仍会作为可信events/history输出，不满足A08关联正确与坏状态fail-closed。

两项follow-up先完成 target=judge drain/CAS 与单代previousJudge后，最新终审又找到同根因的2个sibling缺口：

- target=actor 放弃current Judge时也必须从Manager Turn先drain相关Judge并CAS，不能仅retire后派Actor。
- 没有judgment时previousJudge仍必须关联current/previousClaim且版本更旧；覆盖previousClaim时清除不匹配的旧previousJudge。resume/respawn只可选择与current/returned claim相关的previousJudge作为drain目标，不能被坏快照引向任意Session。

最终follow-up采用更强约束：

- target=actor/target=judge/respawn 在放弃相关Judge时共用mutation前drain+CAS；仅精确current NEED_CONTEXT保留同Session followup。CAS gate测试在drain等待期间提交并发winner，确保stale请求不写resolution或派发。
- previousJudge只与精确historical judgment成对；unjudged Judge drain后不进入当前控制材料。REJECT、NEED_CONTEXT、ACCEPT的current/historical位置均有不变量和篡改回归；fallback只选择由historical judgment佐证且claim相关的previousJudge。
- State format v5拒绝v4；真实v3/v4保护测试保留原数据。多代claim、Judge准备故障、actor/judge resume及事件篡改组合均覆盖。
- Standards唯一剩余possible smell（手写deferred Promise）改用项目已有`Promise.withResolvers`。

最终验证：实施者build、121项相关、T3smoke/e2e通过，全量274=171PASS/103后票FAIL/0skip；父build、最终100项相关、两套smoke通过，并复核全量相同。最新只读终审：Standards 0项硬违规/0 smell，Spec 0项缺失/scope/语义错误。#11可用follow-up提交重新关闭，T5随后解锁。
