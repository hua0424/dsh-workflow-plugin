## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T5：Role 在 Root/Child Run 内复用 continuable Session，进入新 Node Execution 前 compact，冷续接、busy 和安全收口由 Host Adapter 统一处理。工作单独立，不按节点新建 Actor。

## Acceptance criteria

- [ ] 同 Role 跨 Node（含自环新 visit）复用 Session，新 visit 派发前 compact；同 execution 补充/返工/resume 不额外触发 Node 边界 compact。
- [ ] 持久 Session 与 live Activation 区分，冷 Actor 按目标宿主能力取得合适 idle Agent 完成维护后续接；Manager 主会话不做此 Role compact。
- [ ] 区分 compact 成功、合法无可压缩范围 no-op、busy 与失败；缺必要能力/busy/失败不能假成功派发，保留材料并可恢复暂停。
- [ ] 旧 Actor Turn/已知工具 tail 未收口时，Judge 核验、compact 与后继派发不抢跑；interrupt 请求回执不当作停止完成。
- [ ] Host 绑定真实 dispatch/Turn，跨节点同 Session 的迟到提交无权取得当前资格；宿主事件退出 append 回调后处理，不在 Judge 自己提交 Turn 中 drain 自己。
- [ ] 复用既有 Host Adapter seam，覆盖 resident/cold 路径及失败恢复。Child 共用映射机制在此建立，完整 Child 调用链验收由 T7 验证。
- [ ] 对应 #7 A16–A20；完成 red→green、类型检查、相关/全量测试、双轴审查与提交，不部署真实宿主。

## Blocked by

#11 — T4：同节点返工与争议协调。
