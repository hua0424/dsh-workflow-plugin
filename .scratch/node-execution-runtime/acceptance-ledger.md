# A01–A30 验收账本（工作稿）

最终证据必须来自 T9 完成后的最终 commit，不用中间态结果代替。每项填 `PASS / FAIL / NOT RUN / BLOCKED`、命令/测试名、报告路径；真实宿主 A30 与 stub smoke 分栏。

| AC | 状态 | 最终证据 | 中间票来源/待复核 |
|---|---|---|---|
| A01 | 待复核 |  | T3 workspace唯一/Snapshot；T8 terminated |
| A02 | 待复核 |  | T3新visit/自环；T7 Child |
| A03 | 待复核 |  | T3 input/claim/events重开；T7 Program参数 |
| A04 | 待复核 |  | T3 SQL trigger/dispatch retry |
| A05 | 待复核 |  | T2工具/Runtime边界 |
| A06 | 待复核 |  | T2 Actor；T7 Program/Child/END |
| A07 | 待复核 |  | T3 Actor→Judge→后继 |
| A08 | 待复核 |  | T4多轮历史 |
| A09 | 待复核 |  | T4 REJECT/争议BLOCK |
| A10 | 待复核 |  | T4 NEED_CONTEXT/inputVersion |
| A11 | 待复核 |  | T6重启Judge |
| A12 | 待复核 |  | T3原子后继 |
| A13 | 待复核 |  | T6 working无中断事件 |
| A14 | 待复核 |  | T6现场检查提示 |
| A15 | 待复核 |  | T6 Session/replacement |
| A16 | 待复核 |  | T3/T5 Role复用/compact；T7 Root/Child |
| A17 | 待复核 |  | T5 cold/compact结果 |
| A18 | 待复核 |  | T3/T5安全收口 |
| A19 | 待复核 |  | T3 dispatch/claim身份；T4输入版本 |
| A20 | 待复核 |  | T1/T3/T5 Judge只读/事件安全 |
| A21 | 待复核 |  | T7 FAIL无出口 |
| A22 | 待复核 |  | T7 Program |
| A23 | 待复核 |  | T7 Child |
| A24 | 待复核 |  | T8 Reset/历史 |
| A25 | 待复核 |  | T4/T6 resume target |
| A26 | 待复核 |  | T4 history分页/授权 |
| A27 | 待复核 |  | T3无claim暂停；T4/T5事件回调 |
| A28 | 待复核 |  | T2/T3旧格式拒绝；T8备份退出 |
| A29 | 待复核 |  | T3删除清单；T9 grep/架构复核 |
| A30 | 待复核 |  | T1版本；T9真实宿主+mock LLM组合 |

## 最终命令

- pnpm install --frozen-lockfile --ignore-scripts
- pnpm run build
- pnpm test
- pnpm run test:e2e
- 独立真实宿主组合命令（待T9 fixture确定）
- git diff/工作区检查，排除用户模板；codebase-memory重建后 detect_changes
- Standards/Spec双轴最终审查
