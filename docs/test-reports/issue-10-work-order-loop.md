# T3 / Issue #10：三表工作单事务闭环

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/10>。
- 分支：refact；固定代码基点 `6927fe79280ed9bd625e1cad679c85eebafbef9d`。
- 状态：T3 本票验收及双轴审查完成，按批准的集成中间态随本报告提交；全量107项失败与后续票边界继续保留，不冒充最终完成。
- 这是批准的 refact 集成中间态，不可部署。全量旧测试与完整旧 smoke 当前不通过，不能用本票局部验收冒充全规格完成。

## 本票实现范围

直接替换现有 Runtime/Store 为唯一三表路径：Run 管快照/ownership/位置/Role 映射，Node Execution 管当前阶段、输入、派发、claim 和 Judge，Events 保存同事务的关键快照。没有旧、新双引擎。

Root extraText 在派发前入库；Actor/Judge 安排先保存，Host 返回后按真实身份与版本核对；claim 成功提交后才消费资格；ACCEPT、前驱离开、后继 input/进入事件及 Run 指针原子提交。Actor 收口前不核验，外部等待返回后再次确认仍为当前工作。精确 turn/end 来源由宿主 seq/turn 关联产生，不仅凭复用 Session ID。

completed 指向终局工作单，最终 handoff 从该单读取；移除 Run.finalHandoff 等材料镜像。Role 跨 visit 复用，基本 compact/只读 Judge 门槛保留；未来功能通过显式未接通错误拒绝，而不是隐藏回退到旧引擎。

## Red → Green 与设计纠偏

实施者记录：

1. 真实 Runtime+SQLite 的第一次派发读不到 root request（undefined）→ 三表输入先存后发。
2. safeToInspect 等待期间被 Manager BLOCK，返回后仍 compact → 立即重验身份/版本后停止过期操作。
3. 新 Runtime 未接回基本 trace → 复用原脱敏/转义 helper，恢复 START/CLAIM/JUDGE/ROUTE/BLOCK 的 best-effort 日志。
4. Host 精确 turn/end 关联方法缺失 → 根据真实 seq/turn 取得限定消息集合。

中途试探过“completed 必须等末 Judge settled”的额外业务锁。父审视后撤销：Actor 已在判定前安全收口、Judge 已只读且撤权，不能因漏最后 end 让已完成 Run 永久占 workspace。移除的是本轮自造锁及其两条试探测试，替换为终局结果保存、新 Run 不受此锁影响的规格测试；没有取消原有有效安全规则。仍禁止在 Judge 自己提交 Turn 内 await/drain 自己。

其他新增安全测试作为 regression-green 如实记录，不虚构曾经失败。

## 实施者验证结果

| 检查 | 结果 |
|---|---|
| pnpm run build | PASS |
| runtime-work-order / runtime-store-safety / host-settlement / host-compact / turnbind / tools 六组 | 修复安排故障边界后 69/69 PASS，0 skip |
| node scripts/t3-smoke.mjs | PASS：临时 home，真实 Catalog/Runtime/SQLite、受控模型派发，三节点→END→关库重开 |
| pnpm test | 修复后 249 tests，142 PASS、107 FAIL、0 skip、0 cancelled；原107分类未变 |
| pnpm run test:e2e | FAIL：旧 StateHost 未传 execution，state is not lossless JSON；脚本还包含后票返工/恢复流程 |
| 本票 CONTEXT/src/test/scripts diff --check | PASS |

实施者完整日志依次保留在 `.scratch/node-execution-runtime/t3-unit-final.txt`、`t3-unit-review-p2.txt`、`t3-unit-arranged-fault-final.txt`。父在最终修复后独立复验：build、69/69 相关测试、新 T3 smoke 均通过；全量同为249 tests、142 PASS/107 FAIL/0 skip，原 smoke 因旧 StateHost 未传 execution 报 state is not lossless JSON，exit 1。已按实际调用栈定位，并非把失败忽略为通过。新 T3 smoke 不是原完整 smoke，也不是 A30 真实宿主 E2E。

## 旧失败测试的明确归属

| 文件/组 | 失败数 | 处理边界 |
|---|---:|---|
| test/engine.test.ts | 91 | 旧 MemState 只返回 run/version，旧 pending、即时 Judge spawn、trace-before-state 假设不再适用；本票安全行为在新真实 SQLite Seam 复验。返工/恢复/模型/Program/Child/Reset 按 T4–T9 迁移 |
| test/state.test.ts | 11 | 旧单表 createRow、overwrite/delete、纯 Run invariants；三表原子/隔离/坏库已另验，授权退出/完整迁移由 T8/T9 完成 |
| test/single-handoff.test.ts | 4 | 旧 StateHost Adapter；当前闭环与公开 normalize 已重验，补充/恢复归 T4/T6 |
| test/review-fixes.test.ts | 1 | Program resolution 尚未接通，归 T7 |

107 项均保留，没有 skip/delete 来制造全绿。T9 必须迁移并验证所有仍有效的行为，不能仅按“旧测试”标签忽略；不再适用的内部字段/日志时序断言需明确替代依据。

## 已重验的关键安全行为

- SQL trigger 注入 claim/判定/后继进入事件失败，Run/工作单/events 全回滚；同真实 dispatch 可原样重试，成功后重复拒绝。
- BLOCK 事务失败不提前消费资格；成功后 claim/重复 block 拒绝；claim 后 Actor 再 block 拒绝。
- Manager 自己是 Actor 时同样要求真实派发；Manager 对 Role 节点的控制面及 sibling/mapping 漂移区别对待。
- 两个真实 SQLite 连接 CAS 竞争、跨 workspace 身份、callStack/node/token 一致性拒绝且无部分状态事件。
- 旧格式有行时保留原数据，不创建空三表伪装恢复；关闭重开保留 input/claim/events。
- 同 Role 自环创建新 execution、保持 input 快照并 compact；旧 Turn 不能结算新派发。
- Actor claim 后已知 tail / interrupt 回执不放行 Judge；等待期间 BLOCK 后不继续 compact。

## 显式未接通范围

T4：REJECT、NEED_CONTEXT、公开历史查询。T5/T6：完整 replacement/resume/respawn。T7：Program/Child、FAIL 无出口恢复、模型 replacement。T8：Reset/terminated 授权退出。T9：所有旧有效测试迁移、完整 trace 细格式/文档与真实宿主组合验收。

含 Program/Child 的图目前启动前拒绝；有 onFail 的 Actor failed 可按当前闭环交接。未知宿主活动保守拒绝，不把不可观察的外部孤儿效果假定为已停止。

## 删除与保留

删除 Run pendingClaim/pendingCorrection/pendingDispatchContext/nodeBoundary/judgeSessionId/finalHandoff 权威字段，删除内存 DispatchBook/leaseConsumed/transientContext 唯一材料，删除 dispatchNow/persistDeferred 及多套旧恢复推进分支、TransientDispatch 和整 Promise workspace 队列。

保留身份与只读约束、Role 复用、必要 native 安全证据、三表事务和基本 trace；旧 trace orphan 时序不是新状态权威。后票接口当前明确拒绝，未偷偷保留旧引擎。

## Standards

首轮独立审查：1 项 P2，possible smells 0。

Judge 准备中的 cwdResolver 位于故障 try 外；Manager 不驻留/无 cwd 时抛错，Actor settled 已保存，但工作单停在 running/checking、没有 Judge 或可见 BLOCK。违反 Judge 技术故障可见暂停规则。

第一轮修复完成 resolver 拒绝的真实 SQLite red→green，并增加迟到解析失败不覆盖较新 Judge 安排的回归。父进一步检查同一故障边界：安排事务失败时，本地尚未提交的新 dispatch/Judge id 不能让 fault 处理误认为已过期而忽略暂停。

最终修复使用最后成功提交的 Run/visit/CAS version 判定故障归属，而不比较未提交候选 ID。分别用只拒 judge-arranged 和 actor-arranged 事件的真实 SQLite trigger 复现 running 不 BLOCK/异常逃逸，再验证变为持久 BLOCK、原 input/claim 保留、无外部派发；成功的新 Judge 安排仍不被迟到旧错误覆盖。相关测试增至 69。Standards 最终复审确认该 P2 已闭合，未新增明确违规或 smell。

父同时修正 README 的旧“实现完成/全绿/State v2 单表”声明，明确当前三表集成状态、107 旧失败项、未接通范围与禁止部署，避免入口文档误报完成。

## Spec

首轮独立审查：本票缺失/部分 0、scope creep 0、确定语义错误 0。核对三表约束/稳定最新 Run 读取、CAS、不可变输入/Snapshot、真实派发身份与事件/交接原子性、实际 index/Host wiring。原生收口证据仅涵盖已登记/可观察活动，不证明任意外部孤儿工作停止。

最终 Spec 复审发现 1 个低优先级文档问题：README 仍写修复前的 67 项相关测试；已改为 69。除此之外本票缺失/部分 0、scope creep 0、实现语义错误 0；安排失败与迟到故障的 Run/execution/committedVersion 门控、事务回滚和原 dispatch 重试均复核通过。

文档数字修复后两轴无未解决发现。107 个旧测试与 A30 缺口仍按集成计划保留。

## 操作范围

没有 push、部署、真实 Run 或外部业务资源操作；用户示例配置未修改。父维护的执行索引及宿主预检文档不属于本票源码差异。
