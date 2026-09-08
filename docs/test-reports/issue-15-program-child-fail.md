# T7 / Issue #15：Program、Child 与 FAIL 分支交接恢复

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/15>。
- 分支：refact；代码基线是已冻结但未提交的T6工作树（最后已提交点`1db6302`）。
- 状态：T7实现与定向测试已冻结；T6–T9统一测试已通过，正在修复最终双轴审查发现，尚未最终提交/关闭子票。
- 不修改用户示例，不push、部署或操作真实Run。

## 目标

三表Runtime接通Builtin Program、嵌套Child Workflow、Actor FAIL有/无onFail以及相应恢复。Program/Child使用同一工作单/事务/事件原则，但不存在的Actor/Judge阶段不强行模拟。

## Red → Green / 当前进度

- Program已完成6个逐片GREEN：参数/invocation先存再effect，显式PASS handoff进入实际working后继并v8关闭重开保持；无handoff透传input且details不泄漏；ERROR重开后Manager manual resolve不重跑effect；显式retry后迟到旧result按invocation/CAS忽略；FAIL有onFail直接携handoff路由且无Judge；FAIL无onFail保留result并停在同execution settling BLOCK。两个builtin Program均新增明确有界业务handoff。
- 在实现Program前先处理T6迟到finding：Host tri-state接口/typed NotFound测试先RED，NotFound被包装为unknown又RED；现用正式SessionPersistence/SessionInspection类型，available/missing/unknown正确。Runtime settled Role重新active、available/unknown unjudged Judge同Session followup三项先RED，连同missing fresh现4/4 GREEN；完整runtime-work-order 47/47 GREEN。
- Manager executor显式target=judge按用户更具体合同保留，不用当前新Turn的active状态误判旧Turn。

- Child pattern 3/3 GREEN：CallFrame.executionId保存每层当前caller；单层父caller working→result+exited、最深terminal settlement id和handoff原子返回；SQLite重开只恢复存储中的Child栈顶不重复push；两层嵌套逐层传播，父后继等待最终Actor Judge turn settlement。Root/Child共享Role mapping，返回同Role新visit执行一次compact；重复Child Judge结果拒绝。
- Actor FAIL无onFail reopen 1/1 GREEN：failed+Judge ACCEPT进入同execution settling BLOCK；重开后Manager target actor保留previous claim、清旧judgment/资格、轮换token/dispatch，迟到Actor/Judge拒绝，不重Judge旧claim。
- terminal Program+Child status final handoff 1/1 GREEN：统一effective handoff，不再只读Actor claim。

Model replacement与T7定向收口均已完成；focused 13/13、扩展定向118/118与build通过。T9统一full/A30已通过，最终双轴审查正在收口。

## 最终统一审查

T9统一full 229/229、T3/e2e和真实Host interrupt均通过；A21–A23及A02/A16复核均PASS。最终Standards Hard 0（1项非阻断possible已登记），Spec确定问题0。已随提交`c263e64`结案#15。
