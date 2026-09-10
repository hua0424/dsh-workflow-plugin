# 待办：支持 onFail: END 并明确终局语义

GitHub 待办：[#17](https://github.com/hua0424/dsh-workflow-plugin/issues/17)。

状态：仅登记，未实施、未部署。用户确认 milestone-delivery 保留两处 fail→END 语义；兼容期 YAML 用 coordinator 协调节点（handle-cancel / confirm-complete）经 onPass→END 绕行，本 issue 修复后可评估简化。

## 触发事实

真实配置 `~/.dsh/workflows/milestone-delivery.yaml` 有两个合法的业务诉求（兼容期以协调节点承接，语义不变）：

- 根流程 grilling：用户取消后以 failed 结束，不进入开发。
- issue-cycle/select-next-issue：全部 Issue 已关闭，无下一条可交付任务，以 failed 结束子流程并返回父流程的集成节点。

当前 `src/catalog/validate.ts` 的 `validateTargets` 禁止 `onFail: END`；`hasEndPath` 只把 onPass 的 END 当成终点。`src/engine/engine.ts` 的 `advanceKnownResult` 根据 PASS/FAIL 选边后统一处理 END：根 Run 标记 completed，子流程返回父节点 onPass。仅删除一处校验不能证明完整语义正确。

## 待实施范围

1. 允许 Actor/builtin-program 节点显式以 onFail 指向 END；同步 END 可达性判断。缺少 onFail 的 FAIL 仍 BLOCK。
2. 实施前确认：根 failed→END 的 Run 状态是“执行结束”还是“业务失败/取消”；是否沿用 completed 并由终局 claim/handoff 表达结果。不能让 UI 把用户取消描述为交付成功。
3. 明确子流程 END 是正常返回，不自动把叶节点 failed 传播成父节点失败；上述选票耗尽场景需要返回父 onPass。
4. 保留 outcome/handoff 和最终工作单证据；不通过空壳节点、伪报 completed 或修改真实活动 Run 快照绕过限制。

## 验收

- 配置中仅 onFail 可到 END 的图可通过校验，未知目标和真正无终点图仍拒绝。
- 根 Actor accepted failed→END、builtin FAIL→END、嵌套子流程 failed→END 均有回归测试，核验状态、callStack、最终 handoff、父后继输入。
- REJECT 仍回原节点；failed 无 onFail 仍 BLOCK；既有 onPass→END 不回归。
- 更新用户文档、必要的状态/UI说明和版本说明；验证真实 milestone-delivery 静态校验通过，不操作真实 Run。

本轮不修改插件源码；实现后的部署和活动 Run 处理另行确认。
