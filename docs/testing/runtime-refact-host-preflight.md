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

T9 的 #15/#12 依赖完成后，核实目标 Node 与实际测试依赖版本。新组合 fixture 和最终执行报告必须在 refact 项目中保留，不为跑测试擅改宿主 tracked files，不复制庞大测试框架或引入新运行依赖。

### 本机已核实的限制与更小替代路径

- 宿主源码 checkout 保持 Git 洁净，但没有 node_modules，也没有可直接执行的 Vitest；检查目录失败的原因就是依赖未安装，不是已执行测试失败。当前未运行宿主已有 continuation/manual-compaction 测试，也没有安装整个宿主仓库。
- 宿主 manifest 指定 pnpm 11.7.0，插件当前为 10.10.0。不要为了这一预检修改宿主 package/lock 或假报已有源码 fixture 可运行。
- 已通过只读 registry 查询确认以下精确 `0.1.2-rc.1` 发布包存在：agent-loop-testkit、agent-loop、session-persistence-jsonl、session-projection、subagent-spawn-in-process、compaction-basic、token-meter（均为 `@deepseek-ai/dsh-` 前缀）。尚未安装或运行它们的组合场景。
- 更小的优先路线：沿用插件已有 node:test，按需要声明目标版本宿主 devDependencies，复用已发布的 `mountAgentLoopTestDependencies` 等原生服务；只写薄的脚本化 LlmAdapter 与场景装配，不增加 Vitest/第二套测试框架，也不在源码 checkout 安装全仓库依赖。实际安装后仍须核对 exports 与 SDK 单一模块闭包，避免加载两份私有 Symbol/Context 服务。
- 如果后来确实使用宿主源码 fixture，才核实其工具/alias 环境；已有宿主测试通过也只算设施基线，不算插件 A30 通过。
