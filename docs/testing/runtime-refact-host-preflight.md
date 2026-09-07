# T9 / A30：隔离真实宿主验收预检

状态：只读准备完成，尚未编写或运行组合 fixture；不解除 T9 的工单阻塞关系，也不代表 A30 已通过。用户已批准后续实施，实际执行仍按工单依赖进行。

## 目标与证据边界

当前插件 smoke 使用真实 Runtime/SQLite/Catalog，但整层模型派发是 stub。T9 需要额外验证实际 DSH Session、Agent、SubagentRuntime、cold continuation、compact 和一次中断续作，通过真实插件 Host Adapter 调用这些能力。

允许使用脚本化 LlmAdapter 避免费用/网络/凭据：模型文本、工具选择、摘要和 usage 是合成的，宿主执行、维护、持久化和插件调用是真实的。不能把这类结果称为真实外部模型行为质量验证。

Activation 被释放后的 cold-resume 不等于整个进程重启。若报告进程重启恢复，必须实际退出 Context/进程，再从同一隔离 home 重载，而非用同一个内存对象冒充。

## 核实的宿主基线

源码根：`D:\project\github\deepseek-harness`。HEAD 与 `dsh-v0.1.2-rc.1` 均为 `a66e4702047846cdaa10c66c9d3df3951f5ea70d`。

图索引只用于发现；测试路径有 excluded/fast-pattern，其余多为 metadata_changed。以下路径和行为经实际源码读取核实，实施时仍须复核目标 checkout。

## 五个可复用入口（相对宿主根）

1. `packages/subagent/subagent/tests/continuation.spec.ts`：69–104 的 setup 挂真实 Context、AgentLoop、SessionProjectionRegistry、JSONL persistence、SubagentRuntime 与进程内 Spawn/Fork。695–708 验证 Activation 真正释放后同 childId 冷恢复；2766–2806 验证 interrupt、停放 inbox 与显式唤醒。文件内穿透私有 continuations 的 queuePrompt 不是插件应该复制的公共入口；新组合走实际插件已适配的 Host Queue。
2. `packages/test-support/agent-loop-testkit/src/index.ts`：37–46 的依赖挂载使用真实 LlmRuntime、SessionStore、SystemPrompt、ToolRuntime、AgentRegistry；loop/persistence/provider 需要按上项补齐，不会自动加载 GUI/profile。
3. `packages/core/agent-loop/tests/mock-adapter.ts`：提供真正的 LlmAdapter 子类与脚本化请求处理，可读取动态 token/dispatch 后返回工具调用，支持挂起/取消。脚本应通过真实 ToolRuntime 调插件工具，不直接 mock 插件 Host Adapter 或写工作单库绕过协议。
4. `packages/compaction/compaction-basic/tests/manual-compaction.spec.ts`：99–135 的 loopHarness/seedHistory 和 239–280 的维护/checkpoint/flush 断言可参考。已有 GatedCompactionEngine 覆写 summarize，因此不能把其通过当作默认摘要派发通过。组合 fixture 应使用未覆写的 BasicCompactionEngine（auto:false）与 TokenMeter，仅在 LLM adapter 层脚本化；实际默认摘要请求的 purpose 为 compaction，检查其持久事件、后续请求和重载 surface。
5. `vitest.config.ts`：16–20 的源码 aliases 优先于 lib，113–117 定义宿主测试范围；复用宿主既有工具/配置思路，避免插件和宿主加载两份 DSH 模块。不要另建测试框架或启动 dsh web。

## 最小组合方向

- 独立进程中设置临时绝对 DSH_HOME，JSONL、SQLite、Catalog、业务 workspace 全部显式位于隔离根。
- 只注册可控 mock LLM 路由，禁止继承真实 provider、用户 profile 或凭据。
- 挂真实宿主服务与完成重构后的插件 Runtime/Store/Host Adapter，执行 Role→claim→Judge→下一 visit。
- 等待 Role Activation 确实消失后续接同 Session；下一 visit 前执行真正 compact，验证 summary/compaction 事件及后续请求内容，不把 null/no-op 当已真正压缩。
- 另做挂起→宿主 interrupt→插件 resume，观察旧 claim/Turn 无权误结算、同 execution 继续、不额外触发 Node 边界 compact。
- Windows 清理前先 dispose Context、persistence 和 SQLite；不操作现有 GUI、不部署真实 profile、不触碰用户 Run。

## 实施时的前置检查

T9 的 #15/#12 依赖完成；目标 Node、宿主现有依赖/测试工具、源码 alias 可解析且版本一致。宿主 manifest 指定的 pnpm 版本与当前插件环境可能不同，执行前核实实际可用入口，不为跑测试擅改宿主 tracked files 或声称未运行的命令成功。

可先运行宿主已有 continuation/manual-compaction 测试建立 fixture 基线，但这本身不算插件 A30 通过。新组合 fixture 和最终执行报告必须在 refact 项目中保留；优先复用已有宿主测试设施，不复制庞大测试框架或引入新运行依赖。
