# T2 / Issue #9：单文本 claim 与交接

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/9>。
- 分支：refact。起始代码基线：`e245289991b9606e0fe186c406d90c34d49bfa83`；后续只有独立准备文档提交，正式提交前审查固定 `e9a822771125c0e6fdbc28ac52fc8f60aae4ea67`。
- 状态：T2 验收与双轴审查通过，变更随本报告提交；后续票能力不计入本票完成范围。
- 环境：Windows，Node v24.16.0，pnpm 10.10.0；宿主开发依赖已由 T1 对齐 0.1.2-rc.1。

## 范围与已批准取舍

Actor 业务提交只保留 outcome(completed/failed) 与必填、有界 handoff。Judge、Manager、后继及 END 使用同一文本，不保留 summary 双入口或旧字段 fallback。

T2 不提前建设三表或新恢复引擎：completed-only finalHandoff 是单行存储期间的最小终局保存，T3 移入工作单；State format v2 显式拒绝旧格式并保留原行，授权备份/退出由 T8 接通；trace fmt3 不再含 summary 字段。

用户的示例配置不修改，不部署，不操作真实 Run，不推送。

## 改动前基线

T1 冻结版本经实施者及父任务分别验证：build exit 0，222/222 单测通过，隔离真实 SQLite/Catalog smoke PASS。该 smoke 的派发层是 stub，不冒充真实宿主 E2E。

## 实施者记录的 Red → Green

- 新 handoff 工具调用先因旧 schema 仍要求 summary 失败，切换后通过。
- 真实 SQLite 的 Actor→Judge→后继→END 同文交接先因旧 engine 的 summary.trim 失败，切换后通过。
- handoff 内的占位符及 `$&` 在旧逐次 renderer 中被再次解释；单次 callback 替换后保持原文。
- NEED_CONTEXT 续接 Judge 的旧提示不含交付材料；补齐后，followup 与关闭重开数据库后的 Judge 重建读取同一 failed handoff。
- Manager 状态预览原来没有可测的统一 Runtime 状态入口；现在工具/命令共用状态投影，预览截取原文，不另存摘要。
- Runtime 入口原本接受空/超长交付；新增边界检查，拒绝时不消费派发资格。
- DSH defineTool 的参数根是 open object，单纯移除字段不等于拒绝旧属性；显式 ToolArgsError 拒绝旧字段及未知业务属性，拒绝时不调用 Host、不 concludeTurn。
- State v2 对旧格式 get/list/create/update/delete 明确拒绝，原行内容保持；包括旧 completed 行不会被新 start 自动覆盖。实施者报告该组 14/14 通过。

## 最终检查

| 检查 | 实施者结果 | 父任务独立复验 |
|---|---|---|
| pnpm run build | 通过 | exit 0 |
| pnpm test | 228/228 通过 | 228/228，fail/cancelled/skipped/todo 均为 0，exit 0 |
| pnpm run test:e2e | PASS，15 条 fmt3 trace 断言通过 | E2E SMOKE PASS，exit 0 |
| 本票代码/测试/当前文档 git diff --check | 通过 | 通过 |

smoke 使用临时 home、真实 Engine/SQLite/Catalog、模型派发 stub；未运行真实宿主端到端流程。用户示例文件原有空白告警保留，不纳入本票。

源码文本检查中 summary/handoffContext 只剩旧字段拒绝说明及 compaction summary model 注释，没有新 claim 的独立 summary 数据入口。

## Standards

独立审查：0 项明确文档标准违规，0 项值得报告的 possible smell。对照项目与用户全局标准、12 类 smell baseline，逐文件审阅固定 e9a8227 的 19 文件 precommit diff（含 staged 新测试）。未将必要合同迁移或真实 SQLite 闭环测试视为额外抽象；批准的 finalHandoff/State v2/trace fmt3 过渡均在范围内。

## Spec

独立审查：0 项确定发现（缺失/部分 0、scope creep 0、语义错误 0）。核对工具与 Runtime 共同校验、完整 handoff 在各 Judge 路径及 immediate/deferred 后继的保真传递、单次模板渲染、Root END 保存与新 Run 清理、旧格式各入口拒绝与数据保留、当前合同文档同步。

两轴均为只读审查，无未解决发现。父任务执行复验与审查结论分别记录，不把静态审查当测试。

## 提交

实现与本报告同票提交，提交消息关联 #9；具体 commit 见 Git 历史及工单结案评论。没有 push、部署或真实 Run 操作，用户示例改动未纳入。

## 后续范围

三表、关键事件历史、新恢复 driver、Role compact 策略、Program/Child 完整新交接和授权旧格式退出仍按 T3–T9 开发；不得把这些后续票能力标成 T2 已实现。
