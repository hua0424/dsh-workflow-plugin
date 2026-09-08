## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T7：三表 Runtime 完整支持 Program、嵌套 Child、PASS/FAIL 分支及 FAIL 无出口的恢复，统一交接文本与 Root/Child Role 身份。

## Acceptance criteria

- [ ] Program 参数先持久化再执行；确定结果直接结算，无额外 LLM Judge；效果不确定先暂停，由 Manager 核实后显式重试/裁决，不盲重跑。
- [ ] Program 固定实现可输出安全有界 handoff，有则作为后继 input，无新文本则透传原 input；任意 details 不被自动 stringify 注入，需交接的新产物由对应 Program 明确输出。
- [ ] Child 首节点收到调用 input；Child末节点交接文本层层传给父后继，不被父旧input覆盖。Child END、父调用PASS和后继原子更新，无新Child FAIL终点。
- [ ] Parent 等待 Child 时只有栈顶工作活跃，整个 Root/Child 共用 Run 的 Role映射和workspace资格；重复/迟到返回不二次推进。
- [ ] accepted failed 有 onFail 时对称交接；无 onFail 保留失败材料、settling+BLOCK，resume重开同一工作版本而非重判旧claim。REJECT不是Graph FAIL。
- [ ] red→green 覆盖嵌套Child最终handoff、Program两种交接来源及不确定结果、FAIL两种出口、关闭重开后的恢复。
- [ ] 对应 #7 A02/A16的完整调用场景、A21–A23；完成类型检查、相关/全量测试、双轴审查与提交。

## Blocked by

#14 — T6：统一中断恢复。
