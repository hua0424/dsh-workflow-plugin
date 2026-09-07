# refact 执行索引

总规格：[Issue #7](https://github.com/hua0424/dsh-workflow-plugin/issues/7)。设计与规格已提交：`d816aacf9037f5741469e49a76d70480c8b254c3`。用户已确认以下拆分并授权按依赖实施、审查和本地提交；没有 push、部署或操作真实 Run 的授权。

## 工单与依赖

| 票 | Issue | 交付 | Blocked by | 状态 |
|---|---|---|---|---|
| T1 | [#8](https://github.com/hua0424/dsh-workflow-plugin/issues/8) | DSH 0.1.2-rc.1 兼容基线 | 无 | 实施中 |
| T2 | [#9](https://github.com/hua0424/dsh-workflow-plugin/issues/9) | outcome+handoff 单文本闭环 | #8 | 待开始 |
| T3 | [#10](https://github.com/hua0424/dsh-workflow-plugin/issues/10) | 三表工作单 Actor/Judge 事务闭环 | #9 | 待开始 |
| T4 | [#11](https://github.com/hua0424/dsh-workflow-plugin/issues/11) | 同节点返工、历史与争议协调 | #10 | 待开始 |
| T5 | [#13](https://github.com/hua0424/dsh-workflow-plugin/issues/13) | Role 复用、compact 与安全收口 | #11 | 待开始 |
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

逐票在完成后补充测试报告/commit/审查结论。尚未完成的票不能仅凭设计或代码存在被标记通过。
