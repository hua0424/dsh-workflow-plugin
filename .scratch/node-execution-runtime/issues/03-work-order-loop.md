## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T3：用 Run、Node Execution、Node Execution Events 三张核心业务表，接通启动→Actor claim→独立 Judge ACCEPT→后继/END 的真实 SQLite 闭环。工作单是当前事实，事件是关键历史，不通过日志回放恢复。

## Acceptance criteria

- [ ] 固定完整 Definition Snapshot；workspace 最多一个未结束 Root Run，BLOCK 仍占用。每个 Graph visit 有独立 execution，当前 Run 指针唯一。
- [ ] 工作单承载输入、粗粒度 phase、当前安排/claim/Judge 与必要版本；不继续把相同材料镜像为 Run pending 权威来源。
- [ ] 保存安排后才调用 Host；claim 更新和关键事件原子提交，失败不消耗提交资格，同一真实 dispatch 可重试；成功后重复提交拒绝。
- [ ] 有合法出口的判定、离开事件、后继/input/进入事件、Run 指针在同一事务提交；失败与重复触发不制造半个交接或第二后继。
- [ ] invocation/dispatch/claim 身份与 row revision 分工明确，宿主实际来源参与验证。claim 之后先安全收口再启动 Judge 现场核验，保留只读与异步事件安全规则。
- [ ] 真实 SQLite 关闭重开可读到当前工作与事件；输入快照不被前驱修改。旧 State format fail-closed，未接通的执行类型在集成期明确拒绝，不偷偷退回旧引擎。
- [ ] red→green 覆盖事务故障、重复与迟到、claim 后工具 tail 和最小 Actor/Judge/后继闭环。对应 #7 A01–A04、A07、A12、A18–A20 的基础部分。
- [ ] 本票使用 refact 集成分支，不部署中间实现；记录暂未接通功能，最终全量绿由 T9 收口，不建设长期双引擎。
- [ ] 类型检查、票内验收、双轴审查与提交完成。

## Blocked by

#9 — T2：单文本 claim 与交接合同。
