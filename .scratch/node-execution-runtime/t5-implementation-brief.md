# T5 implementation brief（待 #11 完成后执行）

## 目标

在标准 DSH Web composition 下，把 Role continuable Session复用、Node边界compact和安全收口变成正式Host合同，消除T3时期duck type/启动竞态。只实施#13，不提前做T6恢复或T7 Program/Child。

## 必要实现

1. exact devDependencies：`@deepseek-ai/dsh-jobs@0.1.2-rc.1`、`@deepseek-ai/dsh-compaction@0.1.2-rc.1`；只用于正式类型/Context augmentation，运行仍由profile fallback，dependencies保持yaml/zod。
2. 标准Web base已保证jobs-local、compaction-basic。将`jobs`、`compaction`加入顶层required inject，使用`ctx.jobs`/`ctx.compaction`，删除手写Jobs/CompactionService和apply时一次性`ctx.get('jobs')`竞态。缺服务时插件不激活，不运行半套Workflow。
3. 保留Session与Activation区别。首次Role创建不compact；同Role新execution（含自环/Root↔Child未来场景）必须先确认旧可观察工作安全收口，再compact，再续同Session。same execution REJECT/resume不compact，但旧dispatch未settled仍safeToInspect。
4. safeToInspect：当代/observed exact Agent、idle、inbox无pending、owned jobs全terminal、descendants/registry可观察且安全；unknown/diagnostic/orphan detail=false。等待每个外部事实后driver重验execution/dispatch/version。
5. compact：resident/cold、成功/null-noop/busy/manual failure/resume failure/dispose failure清楚区分。cold使用agents.resume无prompt→compactNow→finally dispose→Host Queue续接；busy/missing/error不当成功，进入工作单BLOCK，材料不丢。
6. observed/unsafe按插件生命周期清理，旧orphan不能因job记录删除洗白；不同新Session不受旧ID污染。解除unknown/orphan由T6 Manager检查/replacement，不在T5造自动恢复器。
7. compaction结果可写基本trace/status原因，但不复制compaction内部event到工作单。Manager不做Role compact，Judge不复用Role Session。

## 测试

- 既有`test/host-compact.test.ts`+Runtime真实SQLite，逐行为red→green。
- first use、new visit、自环、same execution correction/resume。
- resident idle/null/busy/error；cold resume/result/null/error/dispose。
- jobs/descendant/inbox/orphan/unknown；等待期间BLOCK或新版本不继续compact/派发。
- required inject和正式Context service wiring；frozen install/build。
- 最终运行相关测试、全量unit、T3/T4 smoke/e2e，后票失败如实保留。

真实宿主Session/Agent/compaction组合仍属T9 A30，本票Adapter/SDK合同测试不冒充。
