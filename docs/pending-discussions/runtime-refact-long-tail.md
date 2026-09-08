# Runtime Refact 长尾讨论清单

本文件只登记不阻断主流程交付的低频、外部或可选边界。主流程、授权、SQLite 数据完整性、Role/Judge 身份与 A01–A30 已声明的核心场景仍必须通过；确定性缺陷不能以“长尾”名义延期。

| 事项 | 当前行为 / 本轮边界 | 何时升级 |
|---|---|---|
| 未登记外部副作用 exactly-once | Actor 恢复提示要求先检查现场；工作单只保证身份/CAS，不补偿任意 shell、网络或人工副作用 | 出现可复现的重复业务副作用且可定义幂等键/补偿协议时 |
| 真实外部模型行为质量 | T9 使用真实 DSH Host 与 scripted LLM，验证协议和生命周期，不评价外部 provider 的推理质量 | 发布前需要指定 provider/model 的质量或成本基准时 |
| DSH code-mode / PTC 组合 | A30 使用 native ToolRuntime；code-mode 还需具体 CodeRuntime backend，不用伪实现冒充 | 目标 Web profile 正式启用并固定该 backend 时 |
| 整进程真实 Host 重启组合 | T6 用真实 SQLite 关闭重开验证恢复；A30 优先证明真实 Host Activation cold release/continuation，不把同进程 cold 冒充进程重启 | 需要发布级 crash/restart 演练或宿主提供稳定进程 fixture 时 |
| maintenance 归档期间进程被强杀 | 同步错误会回滚 main/WAL/SHM rename；不承诺操作系统在任意强杀点提供多文件事务 | 出现实际归档中断事故，或需要引入manifest/恢复命令时 |
| plugin-lifetime observed/parents/unsafe 缓存增长 | 随插件 effect 释放；代码以 `ponytail:` 标明长期 Session churn ceiling | 长驻进程内 Session 数量造成可测内存压力时，按 Run completion/Reset 清理 |
| Session persistence availability=unknown | 保留旧 identity，由 Manager 显式核查后尝试原 Session；只有 typed NotFound 才 replacement/fresh | 宿主提供更细的稳定错误分类或可证明的 unavailable 状态时 |
| trace 派生日志细粒度 | SQLite events 是业务历史；trace 只保留 best-effort 核心记录，不恢复旧 pending 专属 PROGRAM/PUSH/POP 文本合同 | 运维明确需要机器可查询的额外 trace schema 时 |
| 旧 State 精确迁移 | 不兼容/损坏库只诊断、完整备份并授权切空 v9；不迁活动 Run | 存在必须保留并继续执行的实际旧库，且有冻结版本转换规格时 |
| `handleResume` 协调器长度 | 当前保留单一事务协调入口，避免在最终冻结期拆散Actor/Judge/前驱CAS安全顺序；局部变量仍沿用`e` | 新增第二类恢复目标或该函数再次出现确定性回归时，按target抽取纯plan helper并改名 |

更新原则：每项新增讨论必须写明触发证据；没有证据的“以后可能需要”不扩展当前 Runtime。
