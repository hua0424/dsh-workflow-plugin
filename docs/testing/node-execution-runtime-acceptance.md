# Node Execution Runtime 验收账本（A01–A30）

- 依据：`docs/specs/node-execution-runtime.md` T2。
- 状态词仅使用 `PASS` / `NOT RUN` / `BLOCKED`。静态 grep 只用于 A29 删除证明，不冒充 Host 行为。
- `controlled seam` = 真实 Workflow Runtime + 临时真实 SQLite + 受控 Host Adapter；`real Host` = DSH `0.1.2-rc.1` 已发布包组成的真实 Cordis/AgentLoop/Session/Tool/Subagent/JSONL/Compaction 栈，只有 LLM 文本、tool choice 与 usage 是脚本化的。

| ID | 状态 | 证据（测试名 / 命令） | 边界 |
|---|---|---|---|
| A01 | PASS | `runtime-store-safety`: Store rejects mutable input/snapshot and BLOCK retains workspace slot；catalog/start tests | controlled seam |
| A02 | PASS | `runtime-work-order`: REJECT keeps one execution；Role self-loop smoke；`runtime-program-child-fail`: repeated/nested Child visits | controlled seam + smoke |
| A03 | PASS | `runtime-work-order` recovery group、`runtime-program-child-fail` Program/Child reopen、`runtime-store-safety` event reopen | real SQLite close/reopen |
| A04 | PASS | `runtime-store-safety`: BLOCK/claim event rollback、ACCEPT+successor rollback、exact dispatch retry | fault-injected SQLite seam |
| A05 | PASS | `single-handoff`: invalid Runtime claims；`tools`: legacy fields and invalid handoff symmetrically rejected | Runtime + tool interface |
| A06 | PASS | `single-handoff`: identical Judge/successor/END handoff；Program/Child effective terminal handoff tests | controlled seam |
| A07 | PASS | `runtime-work-order`: start→claim→exact settlement→Judge ACCEPT→successor/END；T3 smoke | controlled seam |
| A08 | PASS | `runtime-work-order`: REJECT keeps one execution and binds corrected claim to fresh Judge | controlled seam + ordered events |
| A09 | PASS | `runtime-work-order`: REJECT/correction and NEED_CONTEXT→Actor dispute path；e2e failed-onFail self-loop | controlled seam |
| A10 | PASS | `runtime-work-order`: NEED_CONTEXT context/followup failure/late-input rejection groups | controlled seam |
| A11 | PASS | `runtime-work-order`: checking recovery keeps settled claim and follows/respawns Judge | SQLite close/reopen |
| A12 | PASS | `runtime-store-safety`: ACCEPT/successor transaction fault；duplicate callback tests | fault-injected SQLite seam |
| A13 | PASS | `runtime-work-order`: working without interrupted event reopens into recoverable BLOCK | SQLite close/reopen |
| A14 | PASS | same recovery test verifies complete saved materials, explicit inspect-first prompt, new dispatch and re-claim; no automatic effect replay | controlled seam；external side-effect exactly-once is out of scope |
| A15 | PASS | `runtime-work-order`: available/unknown same Session、missing replacement、old identity rejected | controlled seam + persistence tri-state |
| A16 | PASS | `runtime-work-order`: same Role across visits reuse/compact, same-execution correction no compact；Program/Child nested Role reuse | controlled seam |
| A17 | PASS | `host-compact`: cold/resident success/no-range/busy/error/dispose；`runtime-real-host`: real non-null Basic compaction | controlled Host + real Host |
| A18 | PASS | `runtime-work-order`: Actor tail/stale end/interrupt receipt cannot start Judge；host settlement tests | exact turn + jobs/descendant seam |
| A19 | PASS | `runtime-work-order` stale dispatch；`runtime-store-safety` exact Manager/Role/Judge identities；A30 token rotation | controlled seam + real Host |
| A20 | PASS | `host-compact` Judge allow-list assertion、authz tests；`runtime-real-host` actual Judge `judge_claim` through real ToolRuntime | real ToolRuntime；four controlled read-only placeholder schemas satisfy isolated test composition, no fake Host Adapter |
| A21 | PASS | `runtime-program-child-fail`: accepted FAIL without onFail reopens same execution；e2e onFail route | controlled seam |
| A22 | PASS | Program six-slice group: parameters-before-effect、ERROR reopen/manual resolve、retry stale result、PASS/FAIL handoff/no-details | controlled seam + real SQLite |
| A23 | PASS | one-level/reopen/nested Child tests: stable caller execution, top-only drive, atomic unwind, exact handoff | controlled seam + real SQLite |
| A24 | PASS | `runtime-upgrade-reset`: terminated 后三表历史由 Store 保留、公开 status 拒绝跨 Run、token revocation/new-start safety/late Program result | controlled seam + real SQLite |
| A25 | PASS | `runtime-work-order`: actor/judge target guards/drains；`runtime-program-child-fail` FAIL reopen | controlled seam |
| A26 | PASS | `runtime-work-order`: Manager-only current-Run event pagination；跨 Role 与跨 Run 均拒绝；旧 events 仅由 Store maintenance seam 证明保留 | real SQLite |
| A27 | PASS | host settlement + `runtime-work-order`: turn without result BLOCK、deferred event handling、Judge self-drain avoidance | controlled Host |
| A28 | PASS | `runtime-store-safety` v3–v7/legacy refusal；`runtime-upgrade-reset` v8 native backup、corrupt raw archive、root cutover/failure retention | real SQLite/WAL |
| A29 | PASS | `docs/testing/runtime-refact-test-migration.md`；删除旧 `engine.test.ts`/`state.test.ts` 和 MemState F6；src grep 仅剩旧输入显式拒绝/maintenance诊断/compaction术语 | deletion + dynamic suite evidence |
| A30 | PASS | `pnpm run test:real-host` / `runtime-real-host.test.ts` | 见下节真实边界 |

## A30 真实 Host 边界

`runtime-real-host.test.ts` 使用 exact `0.1.2-rc.1` 的 AgentLoop、Session、AgentRegistry、ToolRuntime、SubagentRuntime、in-process Spawn、JSONL persistence、SQLite SessionQuery、JobsLocal、SessionProjection、TokenMeter、`BasicCompactionEngine({auto:false})` 与本插件 `apply()`。测试通过真实 `/dsh-flow start` 与 Host Queue 执行：

1. Manager 与 Role 的 `workflow_status` / `node_claim`、Judge 的 `judge_claim` 都由脚本 LLM 选择、真实 ToolRuntime 执行；没有直接写 Workflow SQLite 或 mock Host Adapter。
2. Role 第一次 Activation 的 `subagent/start` / `subagent/end` 按 runId 配对，并在 end 回调同步确认 registry 已释放；这是 **Activation cold continuation**，不是整个进程重启。
3. 同 Role 的下一 visit 使用同一 Session ID；真实 Basic compaction 发出一次 `purpose=compaction` 请求，产生同 compactionId 的 start/summary/end、非空 shadowedSeqs、`llmStreamCall=true` 及 surface replace。随后模型请求包含 checkpoint，且不再含被 shadow 的旧文本。
4. 第二 visit 的 Role 在真实模型请求中挂起；测试通过正式 `ctx.subagents.interrupt(..., {kind:'ancestor', agent: manager})` 发出 Host interrupt，持久 Turn 以 `aborted` 结束且该旧 Turn 没有 `node_claim`，Runtime 形成 `actor-turn-ended-without-result` BLOCK。Manager 再通过真实 status/token 执行 `node_resume(target=actor)`；execution ID 保持、nodeToken 轮换，恢复 Turn 重新 claim/Judge/END，且同 execution 没有增加第二次 Node-boundary compact。
5. 四个基础 read-only 名称在隔离组合中以 controlled `defineTool` schema 注册，使 Judge 的正式 allow-list/restrict 可发布；Judge 实际调用的是插件 `judge_claim`。没有验证外部 provider 的判断质量。

进程级 Host 重启没有在 A30 fixture 中冒充；T6 的进程恢复由真实 SQLite close/reopen 测试证明。完整宿主进程重启组合、外部效果 exactly-once 等长尾见 `docs/pending-discussions/runtime-refact-long-tail.md`。

## 冻结命令

最终冻结时执行并记录：

```text
pnpm install --frozen-lockfile
pnpm run build
pnpm test
node scripts/t3-smoke.mjs
pnpm run test:e2e
pnpm run test:real-host
```

本账本不包含 Standards/Spec 终审结论；该 review 与 commit 由父代理在实现冻结后执行。
