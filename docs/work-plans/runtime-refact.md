# refact 执行索引

总规格：[Issue #7](https://github.com/hua0424/dsh-workflow-plugin/issues/7)。设计与规格已提交：`d816aacf9037f5741469e49a76d70480c8b254c3`。用户已确认以下拆分并授权按依赖实施、审查和本地提交；没有 push、部署或操作真实 Run 的授权。

## 工单与依赖

| 票 | Issue | 交付 | Blocked by | 状态 |
|---|---|---|---|---|
| T1 | [#8](https://github.com/hua0424/dsh-workflow-plugin/issues/8) | DSH 0.1.2-rc.1 兼容基线 | 无 | 完成 |
| T2 | [#9](https://github.com/hua0424/dsh-workflow-plugin/issues/9) | outcome+handoff 单文本闭环 | #8 | 完成 |
| T3 | [#10](https://github.com/hua0424/dsh-workflow-plugin/issues/10) | 三表工作单 Actor/Judge 事务闭环 | #9 | 完成 |
| T4 | [#11](https://github.com/hua0424/dsh-workflow-plugin/issues/11) | 同节点返工、历史与争议协调 | #10 | 完成（含follow-up） |
| T5 | [#13](https://github.com/hua0424/dsh-workflow-plugin/issues/13) | Role 复用、compact 与安全收口 | #11 | 完成 |
| T6 | [#14](https://github.com/hua0424/dsh-workflow-plugin/issues/14) | 统一中断恢复与现场检查 | #13 | 待开始 |
| T7 | [#15](https://github.com/hua0424/dsh-workflow-plugin/issues/15) | Program/Child/FAIL 交接恢复 | #14 | 待开始 |
| T8 | [#12](https://github.com/hua0424/dsh-workflow-plugin/issues/12) | 旧格式保护与 Reset 历史 | #10 | 待开始 |
| T9 | [#16](https://github.com/hua0424/dsh-workflow-plugin/issues/16) | 删除旧逻辑、整体验收与文档同步 | #15、#12 | 待开始 |

T8 与 T4–T7 的阻塞关系不同，但同一共享工作区默认顺序实施，避免同时改动状态模型。新鲜实施子会话按单票读取规格与本索引，不依赖上一票的聊天记忆。

每票遵循一个行为测试 red→最小 green，复用已确认 Runtime/临时 SQLite/Host Adapter Seam；票末类型检查、测试与 Standards/Spec 双轴审查后提交。三表切换期间使用 refact 集成，未接通的旧功能明确记录并拒绝，不部署中间状态、不为中间提交建设长期双引擎；T9 要求完整验收。

## T1 起始基线

- 起始 commit：`d816aacf9037f5741469e49a76d70480c8b254c3`。
- 改动前 `pnpm run build`：通过。
- 改动前 `pnpm test`：218/218 通过。
- 改动前 `pnpm run test:e2e`：通过；真实 Engine/SQLite/Catalog，模型派发 stub、临时 home/workspace，不是真实宿主 E2E。
- 精确发布包核实：原有七个 DSH devDependencies 的 `0.1.2-rc.1` 均存在。旧 `followup`、Session `events` 和 JSON helper exports 变化需要最小适配，不能仅改版本号宣称兼容。
- 目标版本已经提供 JSON helper 所在的 `dsh-util-values`；必要时将其作为宿主 devDependency 显式声明，复用原 helper，不引入运行依赖或兼容 shim。

## 实施证据

- T1：commit `e245289991b9606e0fe186c406d90c34d49bfa83`，#8 已关闭；`docs/test-reports/issue-8-host-baseline.md`；目标依赖适配后 build、222/222 unit、隔离 smoke 通过，父任务独立复验通过；Standards 0 项、Spec 0 项。
- T2：commit `6927fe79280ed9bd625e1cad679c85eebafbef9d`，#9 已关闭；`docs/test-reports/issue-9-single-handoff.md`；单文本交接、终局保存及旧格式保护完成，build、228/228 unit、隔离 smoke 经父独立复验通过；Standards 0 项、Spec 0 项。
- T3：commit `0be6fd19d3879efdb51e109f73396916a4baeed6`，#10 已关闭；`docs/test-reports/issue-10-work-order-loop.md`。三表 Actor→Judge→后继/END 闭环、事务/身份/收口门控完成。build、69/69本票相关测试、T3隔离smoke经父独立复验通过；全量249项中142通过/107失败且0skip，原e2e仍失败并按后票保留。首轮Standards P2已修复复审关闭，最终 Standards 0、Spec 0。
- T4：初次提交 `b060dab7bb57ae793991f5746bc4b7016bebfba6` 后收到延迟Spec终审更正，#11已重开；`docs/test-reports/issue-11-rework-disputes.md`。同execution REJECT/NEED_CONTEXT、定向resume、Judge respawn、争议协议、Manager-only事件分页完成，State v4。build、114项相关测试、T3smoke/e2e通过；父最终93项相关及两套smoke通过，全量267=164PASS/103后票FAIL/0skip。审查修复drain顺序/silent stall/status泄漏/身份不变量/多代退回/v3证据等，最终Standards 0、Spec 0。
- T4 follow-up已完成：actor/judge/respawn相关Judge mutation前drain+CAS；previousJudge仅与historical judgment成对；verdict位置/事件篡改/多代退回与并发winner测试齐。State v5；实施者121项相关、父100项相关及两套smoke通过，全量274=171PASS/103后票FAIL/0skip；重新终审Standards 0、Spec 0。T5首次agent已中止且未产生改动。
- T4 follow-up commit `3bce6faeb3a5b8e586d851ca2b386f48d1f6dc6b`，#11已重新关闭。
- T5：`docs/test-reports/issue-13-role-lifecycle.md`；正式required jobs/compaction、Role正常运行内Session复用/安全收口/Node边界compact与`roleBoundaryPrepared`完成，State v6。实施者frozen install/build/145项相关/T3smoke/e2e通过；父frozen install/build/67项相关/两套smoke通过，全量286=183PASS/103后票FAIL/0skip。nested orphan、compact/Queue失败和prepared后并发BLOCK均有敏感回归；最终Standards 0、Spec 0。起始代码固定点 `3bce6faeb3a5b8e586d851ca2b386f48d1f6dc6b`。标准Web的jobs/compaction按required service接入正式类型；不同时维护optional路径。
- T9 只读预检：`docs/testing/runtime-refact-host-preflight.md` 已核实可复用宿主入口；未编写/执行组合 fixture，A30 尚未通过，不解除工单依赖。

逐票在完成后补充测试报告/commit/审查结论。尚未完成的票不能仅凭设计或代码存在被标记通过。
