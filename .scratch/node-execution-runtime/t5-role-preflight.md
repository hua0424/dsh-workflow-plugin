# T5 Role lifecycle / compact 实施预检（非实现）

T3 已把以下 Host 行为接入真实工作单 driver，T5 应加深而不是另起 Module：

- `safeToInspect` 等待实际 Agent idle，并检查 inbox、jobs、descendants/registry；无 jobs 能力、未知/诊断、orphan detail 均 fail-closed。`observeTurnEnd` 在事件时保存当代 Agent 引用，避免 Activation 在 setImmediate 前冷释放后失去证据。
- Role 已映射的新 visit：safeToInspect→每次 await 后仍为当前 execution/dispatch/version→compact→再重验→Host Queue 派发。missing service、resident busy、manual error、cold resume/teardown failure 都不可当成功；null 只表示合法无可压缩范围。
- cold Role 使用 `ctx.agents.resume` 无 prompt 物化，compact 后始终 dispose，再由正式 Host Queue 续接原 Session。不能调用 model-facing nearest-step sendMessage 冒充独立 Node turn。
- 首次 Role 创建没有旧上下文，不执行边界 compact；同一 execution 的 REJECT/resume 继续原 Actor，不执行 Node 边界 compact。自环重新进入是新 execution，必须 compact。
- Manager 主会话不进入 Role mapping/compact。

需在 T5 收口的风险：

1. observed/unsafe 当前是整个插件进程 Map/Set。确认 cleanup、Session id 重用、不同 Run/工作区不会让旧 orphan 标志误伤无关新身份；若需要清除，必须由明确 replacement/termination 事实驱动，不因 job 从列表消失自动洗白未知副作用。
2. `listDescendants` 的 ready/idle/running 语义与 Agent registry 窗口使用目标 0.1.2-rc.1 实际合同；只对可观察 Host 活动作程序保证，不宣称未登记外部副作用停止。
3. Cordis `ctx.get(name)` 经 Cordis 4.0.2 当前类型/源码确认会绕过 inject requirement，只读取当时 ACTIVE 的服务，不建立激活顺序。当前 Host 在 makeSubagentHost/apply 时一次性捕获 jobs；若 jobs provider 尚未 active，会永久保存 undefined。compaction在每次调用时get，没有同样的一次捕获，但也没有依赖保证。
4. 目标base profile源码已核实包含 jobs-local、token-meter、compaction-basic 和 subagent rows，且注释明确row order不决定load、activation由服务可用性驱动；Web composition叠加base。`@deepseek-ai/dsh-jobs@0.1.2-rc.1` 与 `@deepseek-ai/dsh-compaction@0.1.2-rc.1` 精确发布并正式扩展 `Context.jobs` / `Context.compaction`。
5. 本插件目标就是当前标准Web profile，安全收口和Role边界compact又是必需行为，T5优先把 `jobs`、`compaction` 加为required顶层inject，使用正式接口类型和ctx属性；二者任一缺失则整个插件不激活，比运行到一半才BLOCK更清楚。包只加exact devDependencies，运行仍由profile fallback提供，不移入dependencies。若实施者发现必须支持删掉这些服务的非标准composition，才改用局部`ctx.inject(['jobs'], ...)`/调用时get；不要同时维护required+optional两套路径。
5. safeToInspect 返回期间发生 BLOCK/replacement/new execution，driver 的 CAS 重验必须阻止后续 compact/派发；已有T3回归继续保留。
6. compact 结果与 execution event/status/trace 的可见性：失败进入可恢复BLOCK并保留材料；成功/no-op后再派发。无需把compaction内部事件复制进工作单或建精确恢复协议。
7. T4完成后，correction/rework应有明确同execution判据，不能仅凭ready阶段误做compact；新visit仍不得被普通resume绕过。

测试复用 `test/host-compact.test.ts`、Host Adapter fake及实际Runtime/SQLite；覆盖首次/新visit/自环/同visit、resident/cold、busy/noop/failure/teardown、await期间失效。真实目标宿主组合留T9，不把受控Adapter测试称A30。
