# T7 Program / Child / FAIL 实施预检（非实现）

## Program

- Manager 在 builtin-program 工作单调用 node_run_program；动态参数在 ProgramHost.run 之前写入当前工作单和关键事件。进程在外部效果之后、结果入库之前崩溃时，SQLite 只能证明“已安排/参数已存”，不能证明未执行；T6/T7 让 Manager核实，不盲目重跑。
- ProgramResult 应允许固定实现显式返回安全、有界 handoff。没有新交付文本则透传该工作单 input；不得自动 stringify 任意 details。details/参数仍是核实材料，不自动成为 prompt。
- 明确 PASS/FAIL 可直接原子离开，不额外 LLM Judge。ERROR/未知结果 BLOCK；Manual Program Resolution 保存决定/理由并显式路由，不能成为任意 Actor claim override。

## Child

- child-workflow Node 的父调用工作单保持 working/等待，不与栈顶 Child 同时推进。进入 Child 时，在同一事务保存父调用关联、push frame、创建 Child 首工作单/input/entered事件与Run.currentExecutionId。
- CallFrame 需要能稳定指回该层当前/父调用 execution。优先显式 executionId 关联，并校验栈顶与 Run.currentExecutionId 一致；不要仅靠 nodeId 或遍历 predecessor 猜Parent。
- Child 首节点接收父调用 input。Child 最终执行类型形成的 handoff 在 Child END 时成为父调用 PASS 输出，再原子创建 Parent 后继；嵌套 Child 逐层同理，不能被父旧 input 覆盖，也不额外安排 Judge。
- Role mappings 始终归同一 Root Run；Child 不另占 workspace，不创建另一 Run row。Child重复/迟到结果按 execution/dispatch/version拒绝。

## FAIL

- Actor failed + ACCEPT 有 onFail：与completed完全对称，handoff传onFail后继。
- 无 onFail：当前 claim/judgment保留，phase settling + BLOCK，无虚构后继。Manager resume actor 时将旧结论转为历史、增加工作版本、回同 execution ready；不能把旧claim再发Judge。Program的无出口/未知结果分别走同样可解释材料与Manager核实，但不伪造Actor claim。
- REJECT不是Graph FAIL，不适用此分支。

## 事务、阶段与测试

- Program结论、Child pop/Parent PASS、前驱离开、后继input/entered、Run指针/栈均使用与Actor ACCEPT同一事务原则。外部长调用在事务外，返回后CAS重验。
- events扩充必须保持有界业务快照，不引入event replay/attempt表。
- 覆盖嵌套Child最终handoff、Child等待串行、重复返回、Program显式/透传handoff、Program未知效果、Actor FAIL两种出口及真实SQLite重开。
- T3旧测试中 child/program/fail无出口由本票恢复；原 smoke包含这些场景，T7结束时应尽量恢复。完整文档/真实宿主仍由T9。

实施前重读T4–T6后的实际工作单、resume和Role接口；本预检不解除依赖或改Runtime。
