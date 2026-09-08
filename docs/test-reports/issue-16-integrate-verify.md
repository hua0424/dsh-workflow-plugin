# T9 / Issue #16：唯一 Runtime 收敛与整体验收

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/16>；Parent #7。
- 分支：refact；基线为同一未提交工作树中的T6–T8实现（最后已提交点`1db6302`）。
- 状态：T6–T9实现、统一测试与最终双轴审查完成；A01–A30全部PASS，待最终提交并按依赖结案Issues。
- 不修改用户示例，不push、部署或操作真实Run。
- 用户确认：长尾问题可登记后续讨论，交付门槛聚焦主要流程与功能测试；确定性授权/数据完整性/核心验收缺陷仍必须修复。清单见`docs/pending-discussions/runtime-refact-long-tail.md`。

## 收敛目标

删除/迁移旧Runtime与测试，消除未接通入口；A01–A30逐项给出证据，区分受控Host、真实Host+脚本LLM和未运行项。最终只保留三表工作单driver，不建设兼容双引擎。

## 首轮统一基线

- `pnpm install --frozen-lockfile`：PASS（534ms，仅DEP0169 warning）。
- `pnpm run build`：PASS。
- `pnpm test`：333项 / 229 PASS / 104 FAIL / 0 skip，exit1。
- 失败分类：旧`test/engine.test.ts` 91；旧`test/state.test.ts` 11；`test/review-fixes.test.ts` 1（旧MemState Program resolve）；`test/single-handoff.test.ts` 1（旧Host桩缺availability接口）。

## 旧测试迁移方向

旧engine的start/claim/Judge/CAS/迟到来源/恢复由`runtime-work-order`+`runtime-store-safety`覆盖；REJECT/NEED/respawn/history同上；Role/compact由`host-compact`；Program/Child/FAIL/model由`runtime-program-child-fail`；Reset/旧库由`runtime-upgrade-reset`。旧state单表overwrite/deleteRow合同被三表history+terminated明确取代；仍有效trace断言迁到真实Runtime seam。`review-fixes`仍有效Program no-stuck断言迁入新测试；`single-handoff`优先更新Host stub保留有效文本合同。

迁移账本已落`docs/testing/runtime-refact-test-migration.md`，旧`engine.test.ts`/`state.test.ts`删除；`review-fixes`只移除旧MemState F6，`single-handoff`更新三态Host stub保留。删除后`pnpm test`精确为227/227 PASS，0 fail/cancelled/skipped/todo，exit0。

Legacy grep：src无PendingRun/pendingClaim/pendingDispatch/pendingCorrection/DispatchBook/deleteRow/RecoveryEngine；唯一T5–T8 unsupported stub已删除。保留summary/handoffContext仅用于明确拒绝旧输入；workflow_state仅maintenance诊断；Host/projection中的summary/model/time fallback均为目标宿主真实语义而非业务权威镜像。

A30真实Host fixture `test/runtime-real-host.test.ts` 已创建。首RED：静态加载Workflow/dsh-home-paths早于临时DSH_HOME导致catalog not found，改为env后dynamic import。二RED：最小Context缺标准Web只读工具，Judge restrict正确fail-closed；fixture用真实ToolRuntime注册4个controlled read-only placeholder，不改生产allowlist。三RED：zero-latency Judge ACCEPT早于Role首Activation自然`subagent/end`，resident compact与dispose竞争而被cancel；fixture按真实subagent runId gate Judge响应，在end同步确认registry已释放后再允许推进，不用sleep/改生产Host。四RED：script只读顶层text，漏掉真实ToolResultMessage的`tool-result.content[]`，导致Role/Manager无法解析status；改为递归读取，并让Role每个任务先经真实`workflow_status`再按nodeId/token行动。

最终A30 `node --test test/runtime-real-host.test.ts` 1/1 PASS、0fail/0skip。实际覆盖真实Context/AgentLoop/JSONL/SessionQuery/AgentRegistry/ToolRuntime/SubagentRuntime/Spawn/JobsLocal/BasicCompaction/TokenMeter/Workflow apply；Role同Session跨visit、首Activation end内确认释放；真实purpose=compaction一次、non-null summary/shadow/replacement，后续请求含checkpoint且不含旧surface。第二visit Role在模型请求中挂起，测试调用正式Host interrupt，持久Turn以aborted结束且无claim，Runtime形成actor-turn-ended-without-result BLOCK；Manager真实status/resume保持executionId并轮换token，恢复claim→Judge→END，同execution无额外compact。模型文本/工具选择/摘要为scripted，不代表外部模型质量。

A30已读实际exports/types。除预检7包外，真实composition另需`dsh-jobs-local`、`dsh-session-query`、`dsh-session-query-sqlite`，均exact加入0.1.2-rc.1 devDependencies；具体SQLite Query provider使用`{path: ':memory:', openAt:'never'}`。Testkit只mount LlmRuntime/SessionStore/SystemPrompt/ToolRuntime/AgentRegistry；其余服务按真实依赖挂载。BasicCompaction用auto:false+真实compactNow，script adapter仅提供模型响应，不stub Host Adapter。

## 最终统一冻结验证

审查修复后，实施者五项回归全部GREEN：build exit0；full 229/229 PASS、0 fail/cancelled/skipped/todo（3874ms）；T3 smoke PASS；e2e PASS；real-host Host interrupt 1/1 PASS（724ms，case458ms）。父任务重跑完整六项同样全部exit0：frozen install PASS（仅DEP0169 warning）；build PASS；full 229/229、0 fail/skip（3999ms）；T3/e2e PASS；real-host Host interrupt 1/1 PASS（797ms，case503ms）。

## 最终双轴审查

- Standards：首轮Hard 1（T7/T8报告状态陈旧）和事件枚举重复均已修复；最终Hard 0。保留1项非阻断possible judgement：`handleResume`较长且局部名`e`，已在长尾清单登记仅当新增恢复目标或再现确定性回归时抽取纯plan helper，避免冻结期高风险大拆。
- Spec：首轮A26跨Run history与A30主动BLOCK冒充interrupt两项均已TDD修复；代码/测试/验收账本delta复审确认A26=0、A30=0。maintenance root判定同时补强为parent/origin/depth三条件。同步本报告后最终确定Spec问题0项。
