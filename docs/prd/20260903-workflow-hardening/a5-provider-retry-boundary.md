# PRD：A5 Provider Retry 有界化与 Workflow 中断边界

- 日期：2026-09-03
- 来源：真实 `milestone-delivery` run `b2697138-3db5-4ab8-ac11-75e4777f91ac` 的额度耗尽事件
- 状态：跨插件依赖；Workflow 不增加细粒度错误分类
- 主要责任方：Command Code provider / DSH LLM retry 层

## 1. 背景与事实

本次运行中，Manager 使用的 `commandcode` provider 返回：

```text
已用尽全部 1 个 Command Code 账户的用量窗口——窗口重置后请求会自动恢复
code=RATE_LIMIT
```

持久 Session `llm/retry` 事件显示有效 policy 为：

```json
{
  "provider": "commandcode",
  "mode": "normal",
  "maxRetries": 1000,
  "retryableCodes": ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
  "initialDelayMs": 500,
  "maxDelayMs": 900000,
  "jitterRatio": 0.1
}
```

该 policy 来自 `@mars-sea/dsh-commandcode-provider` 的硬编码 `providerRetryPolicy()`，不是本 workflow 插件配置：

- 第一条额度耗尽 retry chain 实际产生 retry 1～15，后期单次等待达到 15 分钟；
- 新 turn 又重新产生 retry 1～3；
- 用户在第二条 chain 的 3/1000 时手工停止并切换模型；
- provider retry 未结束前，Actor turn 没有终态，workflow 无法得到可分类的 turn/end 错误，因此不能及时把“额度耗尽类型”反馈为 Node BLOCK。

## 2. 已确认决策

1. Workflow 插件不为 `actor-turn-ended-without-result` 增加 quota/network/auth 等细粒度子类型。
2. 原因：provider retry 尚未停止时，workflow 根本收不到终态；在 workflow 层猜测类型不能解决无限等待。
3. 应先在 provider/retry 层确保请求可在合理时间内停止、暂停或被用户取消。
4. retry 终止后，workflow 继续使用通用 fail-closed 行为：Actor 没有 claim → BLOCK；Manager 换模型后 `node_resume`。

## 3. 目标

1. Command Code 的 1000 次 retry 不再是不可配置的固定行为。
2. 永久或长窗口额度耗尽不会让交互式 Agent 在后台持续数十分钟到数小时。
3. 用户能在 retry UI 中立即停止当前 chain并换模型。
4. retry 停止后 Agent turn 正常 settle，使 workflow 能进入通用 BLOCK/resume 路径。
5. 不要求 workflow 理解 provider 专用账户、额度窗口或 reset 时间。

## 4. Provider 要求

### R1：策略可配置

Command Code provider 暴露至少：

```yaml
llm-commandcode:
  retryPolicy:
    mode: normal
    maxRetries: <integer>
    backoff:
      initialDelayMs: <integer>
      maxDelayMs: <integer>
      jitterRatio: <number>
```

或提供等价的 `maxElapsedMs` / `maxInteractiveWaitMs` / `usageWindowRecovery` 配置。

不得只在源码硬编码 `maxRetries: 1000`。

### R2：合理默认值

交互式默认建议：

- transient transport/server：有限 3～5 次；
- 全账户 usage window exhausted：仅当明确 reset-after 不超过 `maxInteractiveWaitMs` 时等待；建议默认 `maxInteractiveWaitMs=300000`（5 分钟），超过该值立即终止并提示换模型；
- 不应默认持续到 1000 次。

最终默认值由 provider 项目决定，但必须在 UI/README 中明确。

### R3：显式取消

retry UI 提供“停止重试”动作，取消：

- 当前 backoff timer；
- 后续 provider attempts；
- 当前 Agent request/turn；

并保证 turn 最终 settle，而不是只隐藏 UI 状态。

### R4：切换模型

用户停止 retry 后可切换 Manager/Role/Judge 模型。已有 workflow BLOCK 时，可使用现有 `node_resume` 或 `workflow_set_role_model` 恢复。

Workflow 不尝试在一个仍活跃的 provider request 中热切路由。

## 5. Workflow 侧要求

### R5：保持通用安全暂停

provider retry 最终失败或用户取消，且 Actor 未 claim 时：

- 当前 Node BLOCK；
- 不走 Graph Edge；
- 保留 Node/call stack；
- Manager 可切换模型后 resume；
- 提示无需细分 quota 类型，但应明确“Actor turn 未产出 claim，当前工作未丢失”。

### R6：Trace

A3 trace 至少记录最终：

```text
BLOCK ... source=actor reason="actor-turn-ended-without-result"
RESUME ...
```

不要求复制每条 `llm/retry`；可选记录一条聚合摘要（provider、attempt count、elapsed time、terminal/cancelled），前提是 Host 能提供安全事实。

## 6. 非目标

- 不在 workflow plugin 中复制 provider retry engine。
- 不从错误文案解析账户额度状态。
- 不给 `actor-turn-ended-without-result` 增加 provider-specific enum。
- 不自动替用户选择或购买模型额度。
- 不保证长时间 reset window 内自动保持 workflow 活跃。

## 7. 验收标准

- **AC1 可配置**：Command Code retry 上限/总时长不再只能是源码固定 1000。
- **AC2 默认有界**：默认交互路径在产品定义的有限预算内终止或暂停。
- **AC3 取消有效**：用户停止后不再产生新的 `llm/retry-started`，turn 能 settle。
- **AC4 Workflow可恢复**：取消后当前 Node fail-closed BLOCK，换模型 + resume 能继续。
- **AC5 无错误前进**：额度耗尽/取消不会产生 Actor completed 或 Graph PASS。
- **AC6 不做细分类**：workflow State 不新增 quota/network/auth faultKind。
- **AC7 持久事件正确**：retry/cancel/terminal 事件在 refresh 后仍能重建一致 UI。
- **AC8 隔离测试**：使用 fake provider 与虚拟/短 timer，不请求真实额度账户，不影响真实运行环境。

## 8. 跨仓实施说明

本 PRD 可保存在当前 workflow plugin 仓库作为运行依赖记录，但主要代码修改位于 Command Code provider 或 DSH LLM retry/UI 项目。创建 Issue 时必须标明目标仓库，避免误把 1000 次重试归因于 `milestone-delivery` Graph 循环。
