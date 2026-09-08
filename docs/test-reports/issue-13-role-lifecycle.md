# T5 / Issue #13：Role continuable 复用与 Node 边界 compact

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/13>。
- 分支：refact；起始代码固定点 `3bce6faeb3a5b8e586d851ca2b386f48d1f6dc6b`。
- 状态：T5实现、验证与父双轴审查完成，随本报告提交；后票103项旧测试继续明确保留。首个实施agent异常终止后，新agent从原工作树接手并验证，未重做或回滚正确成果。
- 不修改用户示例，不 push、部署或操作真实 Run。

## 已核实前置事实

- 目标 DSH `0.1.2-rc.1` 的 Session 是持久身份，Activation 可冷释放；续接不能假定 Agent 常驻。
- `compactNow` 需要 idle live Agent；成功、合法无可压缩范围、busy 与失败不同，busy不能算成功。
- Cordis `ctx.get` 不建立激活顺序。当前Host在apply时一次捕获jobs存在竞态；标准Web base已提供jobs-local/compaction-basic。
- `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-compaction` 的精确0.1.2-rc.1接口包已发布并扩展 Context。T5优先把两服务作为required inject，只添加devDependencies，不改变运行依赖。

## 待实施验收

首次Role无需compact；同Role新visit/自环必须safe收口后compact；同execution correction/resume不compact，但旧dispatch未settled仍要safe。覆盖resident/cold、null-noop、busy、missing/error/teardown、等待期间BLOCK和迟到回调。真实宿主组合仍留T9。

## Red → Green / 当前验证

- inherited `test/host-compact.test.ts` 由接手agent首跑 14/14 PASS；该结果只确认已有compact切片，不虚构新的RED。
- 接手核查发现真实缺口：orphan job证据原来只标记child Session；durable descendant descriptor消失后父Role被错误判断safe。新增测试先得6 PASS/1 FAIL（actual true），随后在onJobDone时沿exact owner可观察parentSession链传播unsafe；嵌套descriptor消失后根Role仍fail-closed，新Session ID不受污染。
- 正式listDescendants底层activity仅running/inactive：inactive且无live Activation可安全（orphan证据除外）；running但current/observed Agent缺失为unknown=false。旧ready注释已移除。
- 首轮实现验证曾达到frozen install/build、142项相关、T3smoke/e2e通过，全量283=180PASS/103后票FAIL/0skip；但进入审查前发现新visit compact失败后普通resume会因`dispatch exists`误判same-execution并跳过mandatory compact，因此撤回冻结/审查。
- 修复方向：为当前execution派发持久化`boundaryPrepared`。manager/首次Role无需compact为true；已有Role的新visit为false；compact成功或合法no-range后、发送前CAS写true。compact失败resume仍重试；compact成功后send失败resume不重复compact。State严格合同正规升v6，不新增phase/outbox。

## 最终实现与检查

- 工作单新增`roleBoundaryPrepared`，State format升v6；manager/首次Role初始化true，已有Role新visit初始化false。compact成功或合法no-range后、Host Queue前CAS持久true；compact失败resume重试，Queue失败resume不重复。
- prepared写入后再次按新version核当前execution/dispatch；受控gate测试在该await窗口提交并发BLOCK，过期driver不发送。
- 正式`jobs`/`compaction` exact 0.1.2-rc.1仅devDependencies；顶层required inject，Host使用ctx正式属性，无optional/get竞态或自制错误类型。
- safeToInspect覆盖exact current/observed Agent、idle/inbox/owner jobs、durable running/inactive descendants、live registry竞态、diagnostic/orphan；effect-lifetime parent map使嵌套orphan在middle/descriptor消失后仍taint Role根，fresh Session不受影响并随effect清理。

| 检查 | 实施者 | 父任务独立复验 |
|---|---|---|
| pnpm install --frozen-lockfile | PASS，仅pnpm url.parse弃用warning | PASS（`--ignore-scripts`），同warning |
| pnpm run build | PASS | PASS |
| 相关测试 | 145/145 PASS | 所选67/67 PASS |
| node scripts/t3-smoke.mjs | PASS | PASS |
| pnpm run test:e2e | PASS | PASS |
| pnpm test | 286项183 PASS/103 FAIL/0skip | 同为286项183 PASS/103 FAIL/0skip，exit1 |
| scoped git diff --check | PASS，仅换行提示 | 待提交前复核 |

103项保持已知后票分类：旧engine MemState 91、旧state单表11、T7 Program 1；未删除/skip。两套smoke仍是隔离受控Host，不冒充A30真实宿主。

## Standards / Spec

- **Standards：0项。** 无hard-rule违反、无12类possible smell。双次durable/live快照和exact Agent/jobs/inbox检查是封闭发布/释放竞态所需复杂度；plugin-lifetime caches已用`ponytail:`记录ceiling与未来按Run/Reset清理路径。正式类型、required services、devDependencies和`roleBoundaryPrepared`职责均符合仓库约束。
- **Spec：0项。** required jobs/compaction、首次/新visit/同execution、resident/cold compact、安全收口、nested orphan、Queue前prepared CAS、两类失败恢复及State v6/v5保护均核对通过；T6/T7/T9和未登记external effects没有被误报完成。

两个轴都是独立只读审查，测试由实施者与父任务分别执行。真实宿主组合仍留T9；本票可提交并关闭#13。
