# 待讨论：自动化测试与测试经验沉淀

- 状态：待讨论
- 登记阶段：父子工作流与 Milestone 冲突处理设计期间
- 讨论时机：整体工作流框架和核心状态边界确定后

## 背景

工作流包含子 Issue 单元测试、Milestone 整体集成测试，以及失败或候选代码变化后的重复验证。为应对高强度、高频度测试，不能长期依赖 Agent 或人工逐次手动执行，需要设计自动化测试执行、证据采集和结果复用方案。

Workflow Policy Profile 已冻结以下输入边界：每个 Catalog Repository 必须内联唯一 authoritative unit test definition，Product Workspace 必须内联唯一 integration test definition；本专项负责冻结这些 definition 的 runner/command/evidence 内部 schema。Validation definition 属于 Policy continuity projection，active Parent 期间不能热重载；test timeout/retry 只能在本专项的明确 runner 语义中定义，不增加顶层通用 runtime 参数。

## 后续讨论范围

1. 单元测试、Milestone 集成测试及其他条件测试的自动触发方式。
2. 本地测试、CI、Windows 桌面测试和部署环境测试的统一编排。
3. 测试结果与 Issue PR head SHA、Milestone release candidate 的绑定方式。
4. 重复测试的缓存、增量选择、并行执行和失效规则。
5. flaky test 的识别、受控重试、隔离和审计。
6. 测试失败后如何创建或建议修复子实例。
7. 可采用的测试框架、CI 方案和开源项目，以及与 DSH 的集成方式。
8. 测试执行器的权限、资源锁、超时、取消、恢复和失败关闭语义。

## 测试经验沉淀（未来提案，不属于当前固定流程）

`workflow-policy/v1` 和当前 Workflow Definition 尚未包含强制 Tester 复盘 Gate，也没有 `test-maintenance` Child 类型。本专项可以研究是否将以下内容作为非权威测试报告或未来 Workflow Definition 的候选能力：

- 新发现的测试场景；
- 漏测路径和风险；
- flaky 或环境依赖问题；
- 建议新增或修改的自动化测试脚本；
- 可复用的测试数据、环境准备和诊断信息。

测试经验不能由 Agent 直接静默修改当前发布候选。首期若某项测试问题阻塞本次发布并需要修改代码或测试脚本，必须使用现有 `remediation` Child；任何代码候选变化继续按固定失效规则重新执行整体 Code Review 和完整集成测试。非阻塞改进可以记录为后续 GitHub Issue，不改变当前 release candidate。未来若新增复盘 Gate 或 Child 类型，必须升级 Workflow Definition/schemaVersion，不得由 Validation Definition 自行创造流程步骤。

## 必须保持的安全约束

- 测试 PASS 必须绑定被测试的确定代码候选，不能只绑定分支名。
- 测试脚本若属于仓库并在测试后发生修改，会产生新代码候选；旧测试结果不能自动覆盖新候选。
- 自动化测试失败、超时、环境不可达或结果不完整时，不得降级判定为通过。
- 测试缓存和增量测试只能优化执行，不能绕过 policy 要求的强制验证。
