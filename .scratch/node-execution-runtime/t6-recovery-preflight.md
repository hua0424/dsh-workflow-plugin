# T6 恢复接入注意（准备，不解除依赖）

- T3 已把安全收口抽到 Host 的 native active/idle/unknown 证据；实施前重读该接口与测试，尤其当代 Agent 引用、jobs/后代与 orphan evidence 的生命周期。
- 不要让“unknown 交给 Manager 核查”变成永远无法恢复的口号：核查后必须有现有 Manager-only resume/明确 Actor 接手路径能继续；程序仍不可绕过已知活跃冲突。避免为此增加庞大恢复状态机。
- 留意 Role Session 正常复用与异常 replacement 的区别；若只能 replacement 才能安全接手，必须保留工作材料并在结果中明确。不要把所有普通 resume 都改成新 Session。
- 已保存有效 claim 且已有可靠 Actor 收口事实时，应直接续/重建 Judge；不要因为没有恢复旧 Agent 对象就默认重做 Actor。
- T3 普通 ready 驱动目前等待 predecessor.judge.settled；T6 必须处理“前驱 ACCEPT/离开与后继 ready 已入库，但旧 Judge 最后 end 丢失”的断点，不能把可继续的后继永久挂住，也不能为恢复重做/重判前驱。保留工具返回后异步驱动的宿主安全，优先简化这一技术等待依赖，仍使用同一驱动器；T7 接 Program/Child 时也不能假定所有前驱都有 Judge。
- 状态明确的 completed Run 不因已撤权只读 Judge 漏最后 turn/end 继续占用 workspace；T3 已明确撤销这一额外锁，不要恢复它。
- 外部等待返回后重验 Run/execution/dispatch/版本；不能在旧 safeToInspect/compact 返回后覆盖已 BLOCK、已换人的新状态。
- 不增加可靠消息回放，允许重派提示执行者先检查完成情况；持久阶段与材料是权威，日志用来解释，不用于重建整个执行。
