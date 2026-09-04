# PRD 总览：2026-09-03 milestone-delivery 真实试跑强化

- 来源 run：`b2697138-3db5-4ab8-ac11-75e4777f91ac`
- Trace：`~/.dsh/workflows/milestone-delivery/20260903-191156-b2697138.txt`
- 试跑目标：Judge subagent label 携带当前 nodeId
- 最终结果：功能实现与测试通过，Issue #4 closed；复盘发现协议、配置、日志、compaction 与 provider retry 问题
- 本目录状态：A2（配置强化）已按 v1 兼容语义落地并部署；A4 代码层调研完成（[a4-code-findings.md](a4-code-findings.md)，方案 A 可行）；A1/A3/A5 仍为需求与方案文档，尚未实现
- 批次进度看板：[TODO.md](TODO.md)（状态变化以该文件为准）

## 1. 文档索引

| PRD | 主题 | 主要覆盖问题 |
|---|---|---|
| [A1 Claim Admission 与 Judge 确认协议](a1-claim-admission-and-judge-confirmation.md) | 核心 Engine/Tool 协议 | 1、2、7 |
| [A2 milestone-delivery 配置强化](a2-milestone-delivery-config-hardening.md) | Workflow YAML、角色职责、真正交付闭环 | 3、4、5、6、10 |
| [A3 Workflow Trace 可观测性](a3-workflow-trace-observability.md) | Actor/Judge/BLOCK/RESUME/PUSH/POP 日志 | 9 |
| [A4 Cold-resume Compaction 调查](a4-cold-resume-compaction-investigation.md) | 诊断为何新 Node 未压缩 | 11 |
| [A5 Provider Retry 边界](a5-provider-retry-boundary.md) | Command Code 1000 次重试、取消与通用 BLOCK | 8及用户发现的额度问题 |

问题 12“改插件自身无法在当前旧 runtime 中验证新行为”已确认为**非问题**：这是自举边界，后续由专用测试环境解决，不在本轮实现 PRD 中增加要求。

## 2. 用户确认的核心决策

### D1：Judge 是 Claim Verifier

Actor outcome 产生候选 Graph 结果，Judge 只判断 Actor claim 是否正确：

- completed + ACCEPT → onPass；
- failed + ACCEPT → onFail/BLOCK；
- 任意 outcome + REJECT → 不走 Graph Edge，带 Judge 反馈重派当前 Actor；
- NEED_CONTEXT → BLOCK/followup。

为避免混淆，Judge 结果建议从 `PASS|FAIL|NEED_CONTEXT` 改名为 `ACCEPT|REJECT|NEED_CONTEXT`。

### D2：Actor claim 不手填 nodeToken

内部 token 保留，但 `node_claim` 不再要求 Actor 传入。Host 必须把 tool call 绑定到精确 dispatch lease；不能简单读取最新 topFrame token冒充 stale-safe。

### D3：Implement 负责 publish

Developer 在 claim completed 前必须测试、commit、push implementation commit；instruction 与 checker criteria 同步明确。

### D4：默认分支包含交付才算集成

Feature branch push 不等于 delivery。Manager 按 repository policy 走 PR merge 或 direct merge；Judge 验证远端默认分支包含交付 commit 后才允许关闭 Issue。

### D5：增加 Manager close-milestone Node

Reviewer/Judge 只读，无法靠 criteria 主动关闭 Milestone。因此 final-review PASS 后增加 Manager `close-milestone` actor-task，Judge 验证 Milestone state=closed 后才 END。

### D6：先建 branch，再写 PRD

新增 Manager `plan-milestone` root start Node：先确定 title/branch → builtin 初始化 branch → 在 milestone branch 创建、commit、push PRD。

### D7：Trace 记录完整但有界的结果

记录 accepted Actor claim、accepted Judge result、BLOCK/RESUME，以及显式 child POP；字段沿用协议长度上限并做 JSON escaping，不记录 reasoning/tool transcript。

### D8：Tester 负责发布测试报告

Tester 在 claim 前创建、commit、push report；handoff 包含 implementation commit、report path 与 report commit。

### D9：不细分额度中断类型

Provider retry 不结束时 workflow 得不到终态，无法反馈 quota 子类型。先解决 provider 1000 次重试的有界/取消问题；retry 停止后 workflow 继续使用通用 actor-no-result BLOCK/resume。

### D10：Cold-resume 先调查后定方案

不直接把 skip 改成 BLOCK。先证明 Actor lifecycle、cold-resume 实际上下文与可行 compact seam，再选择 cold materialize、persistence compact 或 fresh Actor。

## 3. 本次试跑的权威事实

### 3.1 流程结果

```text
draft-prd PASS
initialize-milestone PASS
plan-issues PASS
select-next-issue PASS
implement FAIL
implement FAIL
implement PASS
review PASS
test PASS
complete-issue BLOCK（额度/turn中断后无claim）
complete-issue resume → PASS
all-issues-complete PASS
final-review PASS
END
```

### 3.2 两次 implement FAIL

两次 Judge reason 相同：实现内容正确、测试通过，但没有 commit/push，所以不满足 checker 的 `published`。Judge reason 没有传给 Developer，导致第二次重复提交同一未发布状态。

### 3.3 额度重试

真实 Session 记录的是 `commandcode` provider 的 `normal/maxRetries=1000/maxDelayMs=900000` policy。第一条 chain 到 retry 15，第二条 chain 到 retry 3 时用户手工停止并换模型。它不是 Workflow Graph 的重试次数。

### 3.4 最终交付缺口

试跑结束时：

- Issue #4：closed；
- feature branch：已 push；
- `origin/main`：不含实现；
- Milestone #2：仍 open。

因此旧配置中的“workflow completed”不等于“默认分支已集成且 Milestone 已关闭”。

## 4. 依赖与实施顺序

建议按以下顺序拆 Issue/Milestone：

### Phase 1：核心协议

1. A1 dispatch lease 与未 dispatch claim 拒绝。
2. Actor `node_claim` 去除手填 token，Host 自动绑定。
3. Judge ACCEPT/REJECT 语义与 Actor correction feedback。

A1 是后续配置和日志语义的基础。

### Phase 2：可观测性与调查（可并行）

4. A3 Claim/Judge/BLOCK/RESUME trace。
5. A4 Cold-resume compaction investigation。
6. A5 在目标 provider 仓库建立 retry boundedness Issue。

### Phase 3：配置闭环

7. A2 更新 `milestone-delivery.yaml`：plan branch → PRD、职责对齐、Tester publish、default integration、close milestone。
8. 使用隔离 GitHub 测试仓库执行完整 acceptance run。

A2 应在 A1 协议落地后最终定稿，否则配置中的 Judge/FAIL 文案会与新语义冲突。

## 5. 兼容性决策待实现时确认

A1 是不兼容语义变化。设计文档现有原则是：既有语义不兼容变化应升级 schema version。因此推荐：

- 保留 `agent-workflow/v1` 旧语义；
- 新增 `agent-workflow/v2` / `judge.claim-correct`；
- 将 milestone-delivery 迁移到 v2。

如果项目决定 v1 尚未稳定发布、允许原地 breaking change，必须明确记录在 ADR/CHANGELOG，并同步所有示例、tests 与部署配置。

## 6. 不在本轮处理

- 插件修改无法在运行中的旧 runtime 自证：由未来专用测试环境处理。
- 不开发 Web Workflow Dashboard。
- 不引入通用表达式/变量/循环计数 DSL。
- 不让 Judge/Reviewer获得写权限。
- 不在 workflow State 中复制完整 Actor/Judge transcript。

## 7. Definition of Done（整组）

- A1 协议实现并有未 dispatch、迟到 claim、REJECT correction 回归测试。
- A2 新配置通过 schema/static/semantic responsibility review。
- A3 trace 能单文件解释本次试跑中的两次 REJECT 与 BLOCK/resume。
- A4 给出有数据支持的 compaction 根因与选型。
- A5 provider retry 可有界/可取消，workflow 通用恢复通过。
- 隔离真实演练最终满足：default branch contains delivery、所有 Issues closed、Milestone closed、workflow END。
