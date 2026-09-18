# #140：工作流级 actorCommonPersona 测试报告

日期：2026-09-18。范围：Issue #140 `actorCommonPersona` 首次实现（任务分支
`feat/140-actor-common-persona`，提交 `d5c52c1`，PR #141）。实现内容：
顶层可选 `actorCommonPersona` 字段——schema trim 非空严格拒绝、validate
归一化 trim + 冻结快照 + 协议关键词警告、唯一组合函数
`roleActorPersona`（公共在前、角色在后，`\n\n` 单源分隔符，缺省原样）、
spawn 唯一注入点 `host.ts ensureRoleActor`；`judgeRole` 与 Manager 派发不注入。

## 验收边界（验收标准 6）

本报告按两类边界归纳 `test/actor-common-persona.test.ts` 11 例
（测试命名本身亦作此区分）：

### Role Actor system prompt 已组合（10 例）

- 组合顺序/分隔符（两个角色 developer + reviewer）：公共在前、角色在后，
  `ACTOR_PERSONA_SEPARATOR = '\n\n'`。
- 缺省行为：未配置时 `in config === false`，角色 persona 原样返回。
- trim + 冻结：前后空格 trim 后进快照；含字段与缺省配置的
  `definitionHash` 不同。
- 协议关键词警告：公共 persona 手写 `node_claim` 只告警、不阻塞（1 条警告）。
- 严格拒绝 ×4：空白值（schema）、非字符串（schema）、未知字段、
  绕过 schema 的手工构造空白值（静态校验期拒绝）。
- 冷恢复一致：重复组合不叠加、快照角色 persona 不被改写、
  `structuredClone` 重载得同一组合结果。
- spawn 路径（两个角色）：受控 subagent 替身断言
  `workflow-role:developer/reviewer` 收到的 persona 即同一组合结果。

### Manager/Judge 未覆盖（1 例）

- `judgeSpawnPlan(run).persona` 仍为 Judge 专属 persona，不含公共 persona；
  真实 `WorkflowEngine.startRun` 的 Manager 派发文本不含公共 persona。

## 验证结果

- `pnpm run verify`（2026-09-18，head `d5c52c1`）：typecheck 0 错；
  `test:suite` 440/440（含本报告 11 例全过）、0 fail 0 skip；
  t3 + e2e smoke PASS。
- `test/v3-combined-example.test.ts` 4/4：示例 yaml 增字段后仍可加载。

## 未测边界

- 真实 Host spawn 的 system prompt 落盘形态未实测（受控替身覆盖组合与派发参数）。
- live `coding-workflow-rapid.yaml` 未启用该字段（刻意避免本运行行为漂移）。
