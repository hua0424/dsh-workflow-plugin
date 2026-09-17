# Runtime 重构旧测试迁移账本

本账本记录 T9 删除旧 `MemState` / 单表合同测试前的行为替代证据，并（#101 起）作为**现行验收入口与删除/替代映射**的权威入口。迁移原则：只删除实现耦合 fixture；仍有效而未覆盖的行为必须先进入真实 Runtime + 临时 SQLite seam。所有 replacement 都由全量 suite 收集。

## 现行验收入口（#101 收敛）

```text
pnpm run verify        # 单入口 = typecheck + test:suite + test:smoke（下列三段的串联）
pnpm run typecheck     # node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
pnpm run test:suite    # node --test --test-isolation=none "test/*.test.ts"（受限环境等价全量入口）
pnpm test              # 同一全量套件，标准按文件隔离子进程写法（Node 22.x 无法用 --test-isolation 时用它）
pnpm run test:smoke    # 统一受控 smoke 入口 = scripts/t3-smoke.mjs && scripts/e2e-smoke.mjs
pnpm run test:real-host  # node test/runtime-real-host.test.ts（exact 0.1.5-rc.2 真实 Host，单文件直跑；与受控 smoke 分开报告）
```

两套受控 smoke 的分工（合起来才是完整受控闭环，任一单独跑都不完整）：

| 脚本 | 角色生命周期合同 | 独有断言 |
|---|---|---|
| `scripts/t3-smoke.mjs` | 显式 `reuse: continuable`（旧行为基线） | Role 跨节点复用（`rolesCreated=1`）、节点边界 compact（`compacts=1`）、三节点 → 业务终局（`{ return: delivered }`）、关库重开后的终局 handoff 与事件顺序 |
| `scripts/e2e-smoke.mjs` | 缺省 `reuse: node`（现行缺省） | REJECT 修正环路、`retry` 结果自环、离开节点 drain + 新 visit 新会话、旧会话迟到 claim 失权、`#59` 警告型 catalog 可加载、`#131` Child 显式返回 → Root 业务返回、`#132` Program ERROR BLOCK/人工确认恰好推进一次 + Program FAIL → Root 业务返回（#133 补）、`fmt=3` trace |

**skip 口径（AC2）**：0 fail 必须无条件成立；skip 只允许**环境条件**，且不得把失败藏成 skip。当前唯一两处是 `test/programs.test.ts` 的 `runProgram captures output of a real command` 与 `runProgram reports ENOENT for missing commands`——它们在启动时探测 `spawn(..., {stdio:['ignore','pipe','pipe']})`，只有探测到沙箱 `EPERM` 才带原因跳过；`runProgram`/`spawnCollect` 的同一逻辑由受控进程适配器与受控 `SpawnDriver` 用例覆盖（Issue #92/#95），因此受限环境下跳过的是"真实子进程可跑性"，不是未被验证的行为。

## 本轮（工作流优化 C）删除测试的现行替代

| 删除项 | 出处 | 现行替代 |
|---|---|---|
| `test/judge.test.ts` 两条 `parseJudgeClaim` 自证用例 | #100（删除仅测试引用的旧 validator） | 生产合同单源仍在工具层 `judge_claim` 的 parameters/enum + `tools.ts` 长度校验 + `engine.handleJudgeClaim`；路由与 reason 边界由 `test/tools.test.ts`（judge_claim 分组）与 `test/judge-surface.test.ts` 覆盖 |
| `judgeSessions` 相关无测试的 write-only 状态 | #99 | 无测试删除（该项本无测试）；参与者证据寿命由 `test/participants.test.ts` 9 例覆盖 |

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

- 现行单入口 `pnpm run verify` 必须 exit 0：typecheck 干净、全量 suite **0 fail**（skip 仅限上面登记的环境条件）、两套受控 smoke 均 PASS。受限环境之外的等价入口是 `pnpm test`。
- `node scripts/t3-smoke.mjs` 与 `pnpm run test:e2e`（合称 `pnpm run test:smoke`）必须通过；二者是 controlled Host，不冒充 A30 真实 Host。
- A01–A30 的最终证据另见 `docs/testing/node-execution-runtime-acceptance.md`。
