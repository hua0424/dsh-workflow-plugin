# coding-workflow-rapid 验证记录

日期：2026-09-18。创建独立四节点轻量配置与合同，未修改原工作流、共享 INDEX 或生产代码；未启动 Run、操作真实 Issue/PR、部署插件或修改状态库。

- 配置：`docs/example/coding-workflow-rapid.yaml`；合同：`docs/dsh-workflow/coding-workflow-rapid-contract.md`。
- 初次以 CreateNew 写入 `C:/Users/hua/.dsh/workflows/coding-workflow-rapid.yaml`。提示词精简后校验旧哈希再同步，保留用户关于 Actor 自述/Manager 补证的措辞意图；与仓库示例字节一致。当前 SHA256：`897042eef24fd3fc0ee0d77f9c4c8135bf1862005ef9b0f1b140a888ba91929c`。
- 真实 parseCatalogConfig + validateAndNormalize：v3 合法，4 节点，0 warnings。插件硬约束首节点为 manager，所以由 Manager 初始化，coordinator 合并；不增加节点。Manager 无可配置 Role persona，初始化约束落入当前 instruction 与 Judge criteria。
- `pnpm run typecheck`：通过。
- `node --test --test-isolation=none test/coding-workflow.test.ts test/coding-workflow-rapid.test.ts`：11/11 通过，0 fail/skip；其中新增 4 项覆盖交付、返工、批准漂移重审、非法结果与 Judge REJECT 不推进。
- 测试使用真实 Engine 和临时 SQLite，模型判定受控。只证明路由与协议行为，不证明模型能正确理解自然语言、真实 Git/GitHub 操作或并发合并安全；本次未运行真实宿主端到端测试或全量 suite。
- 独立合同/配置审查发现合并并发窗口的验收缺口，已补充实际合并起点等于 approvedBase 的主动核验及 delivered 条件。配置不能原子锁住远端 base；事后发现竞态 BLOCK，不伪称未产生副作用。
- 本次只读检查 `C:/Users/hua/.dsh/profiles/web/wfdev/lib/types.js` 已声明 v3；这不证明正在运行的进程已重载该产物。启动前使用 v3 插件及适用状态库，仓库必须提供本合同和通用 INDEX。

正常路径四次业务节点执行，相比 coding-workflow 单 Issue 的两级 PR 流程减少规划、选票、子流程交接、独立裁决和集成阶段。实际 token 收益未测量，不宣称固定节省比例。

## 提示词精简复核（合同 2026-09-18.2）

- 应用 writing-for-agents：persona 保留职责、入口、权限边界和一句提交纪律；instruction 仅写节点动作及每种 result 的产物/handoff；异常操作按标题读取专属合同。
- 节点 instruction 字符合计由 2235 降至 1171（约 48%），不是 token 实测或模型遵循率评估。persona 未因迁入细节而膨胀。
- 逐节点比较确认 checker/criteria/results/target 均与精简前一致，未降低验收要求。解析零警告，11 项相关路由测试重新通过。未改生产代码，无需为纯文本重写增加实现镜像测试。
- 独立复核补回合同中用户明确的“不管理 Milestone”边界，其余动作及交接完整。
- 源码核实：SUBMISSION_CONSTRAINT 每次拼入派发上下文，不是 Role system；保留 persona 中一句“提交为最后动作”补足层级。当前没有共用 persona 字段，也没有覆盖所有工具的 claim 后封锁，不将提示纪律描述成外部副作用可撤销的技术保证。
- 后续最小插件建议：可选 actorCommonPersona 拼入 Role Actor 的系统 persona，Judge 不自动继承执行者写入/提交义务；Manager 仍需单独评估宿主系统注入能力。不添加模板继承或 include 机制。该改造本次未实施。
