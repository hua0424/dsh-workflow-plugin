# orphan 判定按新 jobs 事件语义重写

状态：accepted（2026-09-30，milestone `dsh-020-migration` / #185 / #190 实现、#191 收尾）。

0.2.0 宿主删除了旧 jobs 接线（`JobDoneListener` / `JobSnapshot` 不复存在），新语义是事件流：`JobRegistry.list(caller?)` + `JobEvents.subscribe(filter, listener)`，`settled` 事件自带 `{ job: JobView, cause: JobSettleCause, awaited }`（`cause = producer | kill | teardown`），且新注册表只在 cancel 抛错强行结算时才写 `cancel threw during teardown; work may be orphaned: ...`。

采用重写而非最小映射：旧回调/快照入口已删除，不存在可适配的对等语义——任何“映射层”都得把新事件流反推回旧快照，等于在插件内重实现一份已删除的宿主语义，漂移面更大。重写后 orphan 判定为三重匹配（`settled` 事件 + `cause === 'teardown'` + 保留的 teardown 抛错 detail 子串 `work may be orphaned`）：合规 teardown（cancel 未抛错）与 producer/kill 结算一律不算 orphan，不误判、不漏判（#185 用户故事 9）。owner 由 `event.job.owner` 会话 id 反查精确引用（当代观察优先，其次宿主 registry，只做 transient 使用）；反查不到仍按 id 钉 tombstone，保留 #54 嵌套 middle-unavailable 能力。终态集合与 id 级证据寿命纪律不变。

代价：与旧宿主的构建兼容一并放弃（单轨，#185 已决策）；`detail` 子串是宿主写入约定的弱耦合，若宿主改写措辞此处先响（`test/participants.test.ts` 三重匹配单测钉住三场景）。
