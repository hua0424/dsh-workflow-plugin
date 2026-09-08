# T8 / Issue #12：旧 State 退出与授权终止

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/12>。
- 分支：refact；基线为同一未提交工作树中的T6/T7冻结实现（最后已提交点`1db6302`）。
- 状态：T8实现与focused 13/13、build已冻结；T6–T9统一测试/A30已通过，正在修复最终双轴审查发现，尚未最终提交/关闭子票。
- 不修改用户示例，不push、部署或操作真实Run。

## 目标

兼容新库中把活动Run标为terminated并保留三表历史；旧/不兼容库可只读诊断、备份后授权退出，不自动重置、不静默丢数据、不实现旧Run迁移或双引擎。

## Red → Green / 当前设计

- 兼容v9库：普通`/dsh-flow reset`仅由当前Run Manager执行，写terminated并保留三表材料/历史；不完成、不取消外部动作。
- maintenance模式：普通reset只诊断并回显精确影响；必须显式`/dsh-flow reset --incompatible-store`才进行全存储cutover，严格拒绝多余参数，Host传Agent+mode，仅root Agent可授权。
- 可读旧SQLite优先使用Node原生backup保存含WAL一致内容；损坏库只能标明raw bytes归档，不伪称可读备份。备份/归档成功后才初始化新库，任何失败保留原源文件。

Compatible现有行为已GREEN：Manager reset→terminated/材料保留/token轮换/event/无handoff；terminated后新Run插入且旧execution/events仍在SQLite保留，但公开workflow_status只允许当前Run并拒绝旧/新Manager跨Run查询；old current/mapped Role与current/predecessor Judge在new start前检查，known active/idle unsafe拒绝，safe或unknown显式start允许。

Maintenance已逐片GREEN：真实v8三表进入StateAccess diagnostic；普通接口诊断拒绝；root+`--incompatible-store`才cutover。native SQLite backup测试在backup期间另开WAL writer提交sentinel，备份可读sentinel；backup注入失败时源bytes/maintenance状态不变且无partial；corrupt原始bytes归档后才热切空v9。fake-Context apply不抛，no-cwd status/cutover可用，child无权，全流程后同进程healthy。

Compatible补充迟到回调：Program effect pending时Reset→terminated→new Run，旧Program PASS返回后按run/execution/invocation CAS拒绝，new Run字节级状态不变。

## T8 冻结结果

T8 focused 13/13 PASS，`pnpm run build` PASS；README/CONTEXT同步State v9与maintenance命令。T9统一full 229/229、T3/e2e及真实Host interrupt均通过；A24/A28 PASS，A26修复为公开status只查当前Run、旧events仍由Store保留。

## 最终统一审查

Standards Hard 0（1项非阻断possible已登记），Spec确定问题0。已随提交`c263e64`结案#12。
