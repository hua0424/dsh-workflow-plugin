# T3 只读预检（非新增需求，实施前重读 T2 完成后的源码）

基于 T1 commit e245289。T2 正在替换 claim 合同并可能暂存 completed-only finalHandoff、State v2；本文件没有修改任何实现，也不解除 T3 对 #9 的阻塞。

## 已核实的接缝

- StateStore 当前是一张 workspace-keyed snapshot 表；get/createRow/updateRow/list/deleteRow 通过同一同步 mutation queue。新的三表事务应在此收敛，复用 node:sqlite、snapshotJsonValue 和版本错误，不额外加 ORM。
- Engine StateHost 目前 get 返回 run+version，put 只保存 Run；makeStateHost 是其 Adapter。三表当前工作单不能再嵌入 Run.pending 作为第二权威来源；调整这个接缝时同步实际 Host 与测试宿主，而不是新增平行引擎。
- RunState 当前仍有 pendingClaim/pendingCorrection/pendingDispatchContext/nodeBoundary/judgeSessionId；这些是替换对象，不是新模型必须保留的字段。
- Host startJudge 当前通过 run.nodeBoundary 读取 Node-local transcript，JudgeSpawnInput 另带 claim/rejection。迁移时 projection 边界和 Judge 关联应来自当前工作单/本次安排，不借临时 Run 镜像继续读旧字段。
- Role 首次 startContinuable 与普通 followup/Host Queue 的身份返回都存在 admission→返回窗口。先登记安排/身份；未完成关联的早到调用要 fail-closed，不能为避免一次合法重试而放松来源校验，也不要建设整套 exactly-once 消息协议。
- 当前 Actor claim 即安排 Judge，Turn-end 只影响后继派发；T3 必须把 Judge 现场核验也放在安全收口之后。先保存 checking 不代表立刻 spawn Judge；收口触发只是统一 driver 的入口。
- 当前 get 返回独立 JSON 数据，写失败不能让内存提前消费 lease。三表故障测试要观察同一 dispatch 可原样重试、状态/事件无残留、不提前启动 Judge。
- index 的 toolHost 当前把完整 handleClaim/handleResume/handleRunProgram Promise 放进 workspace enqueue，不能仅因 Store 事务很短就声称长调用已出队。接入新 Runtime 时审查该调用链，外部 spawn/compact/Program 长调用应在状态锁外，返回后校验身份/版本。
- 现有 engine 测试的 MemState 只有 run/version，默认 caller 带所有历史派发 message IDs 的宽松集合；迁移关键安全用例时必须使用精确旧/新 dispatch 集合，且事务原子性与恢复使用真实临时 SQLite，不只把旧内存对象改几个字段。
- index 当前把 turn/end 简化成 handleTurnEnded(workspace, sessionId)，丢失真实 Turn 关联。新收口入口必须携带/核实当前派发来源，不能仅凭复用 Session 结算新 visit；事件回调已异步 defer 的规则继续保留。
- commandHost.start 当前在 startRun 成功后另行 steer extraText，未进入SQLite。Root 附加输入必须作为首次工作单输入，在任何派发前同事务登记，而不是继续额外发一条不持久化消息。

## T3 实施边界

优先完成一个真实 SQLite 的 start→Actor→Judge→后继/END 链；各 Graph visit 独立，跨事务结果/输入/指针不可半提交。保留现有公开命令和工具调用方式，必要不兼容执行类型在 refact 中间态明确拒绝，记录后续 T4–T8 接通项。不要为中间版本维护旧、新双引擎。

存储内部列/JSON 分配不预定；只要求约束、单一事实来源、短事务和公开接缝可验证。运行阶段不等于宿主瞬时状态，暂不增加大量 phase/subphase/回执表。events 是关键快照，不作为正常恢复的回放日志。

T2 的 completed-only finalHandoff 是无三表期间的过渡字段；T3 有退出工作单后，应从工作单取得最终 handoff，不长期保留另一份终局文本权威来源。
