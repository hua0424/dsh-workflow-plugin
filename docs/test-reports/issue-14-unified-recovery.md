# T6 / Issue #14：统一中断恢复与现场检查续作

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/14>。
- 分支：refact；起始代码固定点 `296110b2daec34b06b1562f1bce5d940549fe696`。
- 状态：T6实现冻结，按用户更新后的流程不单独审查/提交/关闭；在同一工作树继续T7–T9，最后统一测试、双轴审查与提交。
- 不修改用户示例，不 push、部署或操作真实 Run。

## 目标

正常执行与重启/resume/replacement共用工作单driver。记录明确时继续对应阶段；working或投递结果未知时，在Manager确认无已知冲突后续接Role并注入“先检查现场再继续”提示，不建设异常分类恢复引擎或exactly-once协议。

## 前置约束

- T5只完成同进程正常运行的exact Host安全收口；cold restart、Session不可用、unknown外部进度由本票处理。
- 当前重启会把running Run置BLOCK，但恢复提示/方向和部分阶段仍未接通。
- 已保存且Actor settled的claim应续/重建Judge；前驱已ACCEPT/exited、后继ready时不因只读Judge漏end永久停住。
- Host明确active冲突不能绕过；unknown经Manager核查后允许同Role或replacement接手，插件不自动判断业务副作用。

## Red → Green / 当前实现

- 首个真实SQLite关闭重开测试：working且无事先BLOCK event→restart reconcile BLOCK→Manager auto resume重入普通driver、轮换dispatch、注入现场检查提示、旧来源失权并最终Judge完成。原实现只有普通提示/旧resume行为，测试先RED；Actor恢复提示已接入。
- Role安全分流测试已定义：safe=false+activity idle/active拒绝且不改旧dispatch；activity unknown仅在Manager显式actor resume后允许cold同Session接手。
- Role持久Session missing测试已定义：resume事务清旧mapping、`roleBoundaryPrepared=true`，fresh replacement取得完整材料；旧Actor失权，replacement的同execution REJECT修正复用自身且不compact。
- settled=false claim遵循已确认的安全策略：auto→Actor检查并重claim，旧claim转previous；显式target=judge经Manager确认后才可保claim并同事务settled，known active/idle unsafe拒绝，unknown允许。Manager executor不以当前新Turn的agent.status误判旧Turn。
- Judge恢复正在收敛为工作单`resolution.judgeMode=followup|fresh`：仅合法NEED_CONTEXT+可用Session走followup；Session missing、unjudged旧Judge或显式unsettled claim走fresh，避免将无judgment Judge伪装成previousJudge。该字段将使State升级v7并拒绝v6。

## T6 冻结结果

- working无预先中断记录、Role safe/active/idle/unknown、Session exists/missing replacement、settled/unsettled claim、Judge followup/fresh、already-BLOCK restart、前驱accepted漏end、interrupted event、派发窗口与多workspace冲突均已接入普通driver并有真实SQLite回归。
- State format v7：`restartPending`与Judge recovery mode；相邻v6拒绝保留。Judge followup Session严格关联historical NEED_CONTEXT/previousJudge，unjudged attempt被drain后fresh。
- 实施者验证：frozen install、build、核心85/85、T3smoke、e2e PASS；更宽T4–T6集合173项中172 PASS/1项T7 Program FAIL；全量304项201 PASS/103后票FAIL/0skip（旧engine91、旧state11、T7 Program1）；scoped diff check PASS。
- codebase-memory刷新为500 nodes/1451 edges，0 skipped/partial；最终T7–T9完成后再重建一次并更新AGENTS。

## 冻结后统一审查待处理项

被中止的T6子审查仍返回了3项有效finding，已交同一工作树的T7先修复：

1. Session persistence `inspect` 只有明确NotFound才是missing；服务缺失/读取/损坏错误必须unknown，不能触发fresh Judge/Role replacement。改为available|missing|unknown tri-state。
2. 重启时已有合法unjudged current Judge且Session available/unknown时，应在Manager确认后同Session新followup Turn；不能一律fresh。恢复事务预安排新Judge dispatch，普通driver送达，不存无judgment previousJudge；missing才fresh。
3. target=actor即使旧workflow dispatch已settled，也要防同Session被其他Turn重新active：safe失败后active/idle拒绝，unknown再按availability决定保留或missing replacement。Manager executor显式judge不按当前新Turnstatus误判，保持用户确认的例外。

## 最终统一审查

T7已修复上述三项；T9最终统一full 229/229、T3/e2e和真实Host interrupt均通过。A01–A30账本中A11、A13–A15、A19–A20覆盖本票恢复行为。

## Standards / Spec

最终统一审查：Standards Hard 0（`handleResume`长度为已登记的非阻断possible judgement）；Spec确定问题0。随最终提交结案#14。
