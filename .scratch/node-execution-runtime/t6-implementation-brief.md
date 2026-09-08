# T6 unified recovery implementation brief（待 #13 完成后执行）

## 原则

恢复重新进入同一个driver，不建RecoveryEngine/outbox/effect分类。重启可能没有interrupted事件；以最近SQLite阶段为起点。数据库身份/ownership/Snapshot/Graph损坏fail-closed，业务进度未知交Actor/Manager检查。

## 阶段动作

- ready/input完整：普通driver派发；若已有不确定派发意图，新增dispatch身份并附中断检查提示。
- working无claim：BLOCK后Manager resume actor；默认同Role Session，提示先检查现场，不盲重做。Host明确active/冲突则拒绝；Host unknown需Manager明确核查/承担接手决定，不能变成永远无法恢复的状态。
- checking+claim+actor dispatch settled：续/重建Judge，不重做Actor。未持久settled则先处理Actor尾部不确定性，不直接核验可能仍变化的现场。
- accepted/exited+successor ready：只继续后继，不重判/重建前驱。正常路径可等只读Judge turn/end；重启漏end时，已撤权只读Judge不得永久锁住后继。
- Program未知留T7 Manager核实；settling/FAIL无出口留T7。

## Actor检查提示

完整input/instruction/criteria、已有claim/feedback/Manager resolution一并发送，并明确：此前中断；先核对External Facts；已完成勿重复副作用，未完成继续/补做；完成后新claim；不确定/缺权限BLOCK。不是一句空泛“继续”。

Manager resume是显式恢复决定，但不覆盖Host已知active冲突。unknown经Manager核查后可继续，避免`safeToInspect=false`成为永久锁；具体用same Session还是replacement由可用性/显式模型更换决定，正常路径仍same Role continuable。

## Judge恢复

完整claim、feedback、Manager context及只读中断提示。若持久Judge Session存在且合法，新的真实followup dispatch/message；不存在/明确respawn则fresh Session。旧turn/session/inputVersion不能提交。Judge不得补做。

## 重启与原子性

- handleRestartReconcile只把未结束Run置可恢复BLOCK，保留phase/input/claim/events；每workspace冲突隔离。
- 不重建内存lease；resume创建新dispatch和新资格。SQLite安排先存，外部返回后CAS重验。
- 不能把settlement notice缺失解释为工作未做或盲重放。通知是触发器，不是状态真值。
- 不自动解析GitHub/文件/SSH业务状态，不承诺exactly-once。

## 测试

真实SQLite关库重开：working无中断事件、checking settled claim、Judge Session存在/缺失、消息可能已送达无回执、Role Session不可用/replacement、Manager补充发送失败、迟到回调、已退出前驱漏Judge end。用受控Host检查完整提示和最终可完成结果；不只共享MemState。保留T4权限/分页/争议，T5compact/安全收口。全量失败逐项减少，T9最终归零。
