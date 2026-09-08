# Runtime 重构旧测试迁移账本

本账本记录 T9 删除旧 `MemState` / 单表合同测试前的行为替代证据。迁移原则：只删除实现耦合 fixture；仍有效而未覆盖的行为必须先进入真实 Runtime + 临时 SQLite seam。所有 replacement 都由 `pnpm test` 收集，测试不得 skip。

## `test/engine.test.ts`（91 项，整文件删除）

该文件的手写 `MemState` 只保存旧 Run 单行与内存派发材料，已不能构造 `NodeExecution`，91 项均在新 driver 的 `execution.phase` 读取前失败。以下按行为组证明替代，不把“旧测试失败”本身当删除理由。

| 旧行为组 / 代表测试 | replacement evidence |
|---|---|
| start、root input、Actor 安排、claim、Judge ACCEPT、后继与 END | `runtime-work-order.test.ts`: `start persists root input before dispatch; claim waits for its Actor tail`、`END final handoff persists...`；`scripts/t3-smoke.mjs` |
| Actor tail、精确 message 来源、旧 dispatch/Turn、重复 claim、claim/BLOCK 竞争 | `runtime-work-order.test.ts`: `Actor tail and stale turn-end...`、`same Role across visits...old dispatch cannot claim`；`runtime-store-safety.test.ts`: Manager Actor exact message、BLOCK event rollback、sibling mapping drift |
| claim/Judgment/后继事务失败与 CAS winner | `runtime-store-safety.test.ts`: claim event retry、ACCEPT/successor rollback、competing SQLite CAS；`runtime-work-order.test.ts`: failed Actor/Judge arrangement、late preparation、concurrent BLOCK gates |
| REJECT correction、NEED_CONTEXT、Manager 补充、Judge respawn/drain、旧 Judge 失权 | `runtime-work-order.test.ts`: REJECT、NEED_CONTEXT、supplement→REJECT、respawn、三组 drain/CAS 回归；`single-handoff.test.ts` 保留单文本材料闭环 |
| failed→onFail 与 failed 无出口 BLOCK/reopen | `runtime-program-child-fail.test.ts`: `accepted Actor FAIL without onFail reopens...`；`scripts/e2e-smoke.mjs` 覆盖 failed onFail 自环、同 Role 新 visit |
| restart、无 interrupted 记录、dispatch 回执丢失、Role/Judge cold 恢复 | `runtime-work-order.test.ts` 的 17 项 recovery 组：working reopen、unknown/missing Session、settled/unsettled claim、Judge followup/fresh、前驱安全收口、多 workspace CAS |
| Role Session 复用、首次/新 visit compact、同 execution 不 compact、busy/failure/Queue 窗口 | `runtime-work-order.test.ts`: Role reuse/compact、correction、compact failure retry、prepared-before-Queue、并发 BLOCK；`host-compact.test.ts` 覆盖真实 Host Adapter 的 compact 与 availability |
| model override active/idle/replacement/route validation | `runtime-program-child-fail.test.ts`: `model override safely replaces one blocked Role once...`；`tools.test.ts` 覆盖工具 schema/路由；Runtime 使用 `normalizeModelRoute` |
| builtin Program 参数/ERROR/resolve/结果路由 | `runtime-program-child-fail.test.ts` Program 6 片；其中 `Program ERROR retains parameters across reopen and manual resolution routes once...` 精确替代旧 `review-fixes` F6，并证明非 END 后继不残留 BLOCK |
| Child push/pop、嵌套返回、Root/Child Role mapping | `runtime-program-child-fail.test.ts`: one-level、reopen、nested Child 三组与 terminal effective handoff |
| trace 创建、核心 transition、转义/脱敏/失败容忍 | `runtime-work-order.test.ts`: `work order transitions retain best-effort redacted trace...`；`scripts/e2e-smoke.mjs`；`tracelog.test.ts` 保留全部 helper 边界。旧 pending 专属 PROGRAM/PUSH/POP/RESPAWN 文本不是三表业务事件合同，已由 `node_execution_events` 对应事件替代 |
| status、最终 handoff、事件历史分页 | `runtime-work-order.test.ts`: END/status 与 Manager-only retained history；`runtime-program-child-fail.test.ts`: Program/Child terminal handoff |
| Reset 删除行、旧 pending/summary/DispatchBook 细节 | **合同被替代**：`runtime-upgrade-reset.test.ts` 证明 terminated 保留三表历史、撤权及新 Run 安全门；新 Runtime 不再删除行或维护 pending 镜像 |

## `test/state.test.ts`（14 项，整文件删除；首轮 11 fail）

旧 helper 构造 `workflow_state` 单表 Run，缺 `currentExecutionId`、frame `executionId` 与 `NodeExecution`，无法表达 v9 三表合同。

| 旧行为组 | replacement evidence |
|---|---|
| DB 路径、create/get、workspace 独立、running 冲突 | 所有 `runtime-*.test.ts` 使用 `stateDbPath` 的临时真实 SQLite；`runtime-store-safety.test.ts` 覆盖 competing workspace/CAS 与 BLOCK 占位 |
| completed overwrite / deleteRow | **合同被替代**：`runs` 历史不覆盖；`runtime-upgrade-reset.test.ts` 覆盖 terminated/completed 后新 Run 与旧 history 可读；`deleteRow` 已删除 |
| stale version 与 invariants | `runtime-store-safety.test.ts` 覆盖 CAS、run/execution/frame 漂移、immutable input/snapshot、Judge 关联与事务回滚 |
| nodeToken UUID 与 deepest frame | Runtime 创建路径统一使用 `newNodeToken`；`runtime-program-child-fail.test.ts` 的嵌套 Child 验证栈顶 execution/frame 一致，Store schema/invariants 每次真实写入均执行 |
| 旧格式保留 | `runtime-store-safety.test.ts` 覆盖 v3–v7/legacy 拒绝不改；`runtime-upgrade-reset.test.ts` 覆盖 v8 maintenance、原生 backup、坏库 raw archive 与 root-only cutover |

## 其余首轮失败

- `test/review-fixes.test.ts` 的旧 `MemState` Program F6 case 已删除；相同行为由 `runtime-program-child-fail.test.ts` 的真实 SQLite `Program ERROR retains parameters across reopen and manual resolution routes once with audited reason` 覆盖。该文件其余纯 `gh`/catalog 测试保留。
- `test/single-handoff.test.ts` 不是旧单表 fixture，保留；仅把 Host Adapter seam 更新为三态 `judgeSessionAvailability` / `roleSessionAvailability`。它继续覆盖 Runtime 边界拒绝、failed handoff Judge 恢复、correction/respawn 与终局同文。

## 删除后的门槛

- `pnpm test` 必须 `0 fail / 0 skipped`。
- `node scripts/t3-smoke.mjs` 与 `pnpm run test:e2e` 必须通过；二者是 controlled Host，不冒充 A30 真实 Host。
- A01–A30 的最终证据另见 `docs/testing/node-execution-runtime-acceptance.md`。
