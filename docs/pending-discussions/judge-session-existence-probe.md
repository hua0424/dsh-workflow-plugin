# Judge Session existence probe 的瞬时失败语义

## 状态

待真实 `milestone-delivery` 验证；当前不阻塞发布。

## 背景

Host restart reconcile 会通过 `sessionPersistence.inspect(judgeSessionId)` 判断 State 中的 Judge id 是否对应可 cold-resume 的 durable Session：

- Session 存在：保留 `judgeSessionId`，`node_resume` followup；
- Session 不存在或 inspect 失败：清除 `judgeSessionId`，保留 `pendingClaim`，`node_resume` spawn 重建。

## 已知长尾

若 Session 实际存在，但 persistence inspect 仅发生一次瞬时读取失败，系统会把它当作不存在并清除映射。该行为不会阻断 Workflow：Manager resume 时会根据持久化 `pendingClaim` 和 Node-local projection 创建新 Judge；旧 Session 只作为未再授权的历史记录保留。

影响仅为额外创建一个 Judge Session，以及丢失旧 Judge 的尚未提交上下文，不会导致错误 PASS/FAIL、跨 Node 复用或状态推进。

## 暂缓原因

区分 NOT_FOUND 与瞬时 persistence 故障需要依赖 DSH persistence 的稳定错误分类，当前 duck-typed `inspect()` 契约没有暴露该分类。先保持 fail-closed + spawn-rebuild；真实 e2e 若显示该路径频繁，再评估错误分类或一次有限重试。
