# milestone-delivery 迁移到命名结果与显式子流程返回

状态：后续配置迁移规格；跟踪 Issue：[#129](https://github.com/hua0424/dsh-workflow-plugin/issues/129)。Blocked by #128（插件 v3 协议交付）。未修改真实 catalog、未部署。

## 目标与边界

将现有 milestone-delivery 配置与配套合同迁移到 agent-workflow/v3，消除 failed 多义及子流程返回信息丢失，修复已识别的出口/验收矛盾。本票与插件通用协议实现分开验收；不在插件里固化 coordinator/planner/reviewer 等角色、GitHub 或单仓约定。

源配置为 `C:/Users/hua/.dsh/workflows/milestone-delivery.yaml`；实施时读取当时最新文件，与当前仓库合同核对，不能用聊天中的旧全文覆盖用户修改。先在仓库内提供可审查的 v3 候选和验证结果；替换真实 catalog、部署和旧库切换须在用户明确授权的维护窗口执行。

## 迁移要求

- 所有 Actor 改用 result/handoff；每节点声明语义明确且互斥的结果与 criteria，不继续把取消、穷尽、返工或跳审称为 failed。
- Child issue-cycle/issue-delivery 声明 returns，各调用方完整 onReturn 映射；根正常交付与取消明确区分业务返回。
- 原 workflow Judge 与业务审查/裁决分工保留；本票不默认删除专业裁决角色或改变两级 PR 策略。协议迁移不得顺带放宽验收和合并授权。
- 每个需要 Judge 核验的强制结果条件写入共同/结果 criteria；Actor 与 Judge 使用插件同源合同。persona 保留 system 层稳定职责，不与新增结果路由冲突。
- 修复有独立验收父 Issue 的循环依赖：实施叶任务已完成时允许进入集成，父验收项在集成核验通过后结算；不得要求后续尚未生成的 review/decision 才能进入审查。
- 修复单 Issue 跳审批准缺口：Issue 数量不能作为自动批准依据。迁移默认走当前集成修订的审查/裁决，除非已有明确等价核验合同及当前集成修订批准记录；缺 decision 不等于允许免审。
- 对 selected、exhausted、changes-required、approved、cancelled 等实际结果定义事实条件；环境/权限/信息不足用 BLOCK，不发明正常业务出口绕过核验。
- INDEX 只保留跨工作流通用约定；角色/节点/报告结构/两级 PR 规则放工作流专属合同。不因另一工作流没有特定角色或报告而 BLOCK。
- 保留用户现有 INDEX、review-contract、milestone-delivery-contract、operations 修改，按实施时最新版本做最小增量迁移。

## 验收

- [ ] 插件 v3 主票已交付；候选配置通过实际 catalog 解析/静态校验，所有结果和返回映射齐全。
- [ ] 受控测试覆盖：简单单票、多叶票、带独立验收的父 Issue、单票返工、集成修复再循环、明确取消及无下一票。
- [ ] 不存在依赖未来报告才能进入当前节点的循环；缺批准或修订漂移不得进入合并。
- [ ] 角色 persona、instruction、共同 criteria、结果 criteria、工作流专属合同一致；不要求不存在的角色或产物。
- [ ] 通用 INDEX 不含固定角色专属必需项；不同角色名称/子仓结构的最小示例可复用通用规则，不新增真实多仓工作流。
- [ ] 输出可审查候选配置、改动摘要、实际验证结果和维护窗口操作清单；不把受控测试写成真实交付成功。

## 关联

Blocked by #128：https://github.com/hua0424/dsh-workflow-plugin/issues/128 。关联 #126 的单 Issue 跳审/收尾合同问题；本票验收通过前不自动关闭 #126，也不只加一条失败边掩盖批准缺口。
