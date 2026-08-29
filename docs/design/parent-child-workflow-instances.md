# 父子工作流实例设计

- 状态：已确认（父子实例领域语义）
- 适用阶段：固定 Workflow Definition 的父子实例设计
- 主题：功能需求、Milestone、Issue、分支、Review、测试与最终交付之间的父子实例关系

## 1. 目标

本设计定义工作流父实例与子实例的职责、生命周期、聚合规则和跨仓库交付语义，解决以下问题：

1. 一次功能需求如何映射为可持久化的父工作流实例；
2. 多个开发 Issue 如何映射为独立且严格串行的子实例；
3. 单仓库和多仓库 Milestone 版本线如何表达；
4. PRD Review、子 Issue Code Review、Milestone 整体 Code Review 和测试门禁如何组合；
5. baseline branch 变化和最终 PR 冲突如何处理；
6. 多仓库最终合并无法原子完成时，如何保证最终状态一致性。

本文只冻结父子实例的领域语义，不冻结数据库 schema、DSH adapter、GitHub API 或自动化测试框架。Workflow Policy Profile 的首期边界另见 `docs/design/workflow-policy-dsl-static-validation.md`。

本文中的 baseline branch 指 Policy `workspace.baselineBranch`；远端引用使用相应仓库配置或默认解析出的 remote alias，不假定分支名一定是 `dev1` 或 remote 一定是 `origin`。

## 2. 核心术语

### 2.1 父实例（Milestone instance）

父实例对应一次完整功能需求及其 GitHub Milestone，负责跨 Issue、跨仓库的编排和最终交付。

父实例拥有：

- PRD 及验收标准引用；
- GitHub Milestone 引用；
- 涉及的仓库集合；
- 每个受影响仓库的 Milestone 集成分支；
- 有序的 Issue 子实例集合；
- 当前流程阶段和聚合门禁；
- Milestone 整体 Code Review 证据；
- 集成测试证据；
- release candidate manifest；
- 每个仓库最终 `milestone → baseline` PR 的交付状态。

### 2.2 子实例（Issue instance）

子实例对应一个开发 Issue，使用独立状态机执行一个仓库内的开发任务。

首版约束：

- 一个开发 Issue 只绑定一个当前 Parent 已选择、且存在于 Policy Repository Catalog 的 GitHub 代码仓库；
- 一个开发 Issue 对应一个主要 feature branch 和一个主要 PR；
- 子 PR 的目标分支是该仓库的 Milestone 集成分支，而不是 baseline branch；
- 跨多个仓库的需求拆为多个 Issue 子实例。

### 2.3 逻辑版本线（Milestone version line）

一个 Milestone 对应一条逻辑版本线。逻辑版本线分两个阶段建立：

1. `initialized`：父实例创建 GitHub Milestone，并在伞仓建立 Milestone 分支；该分支在 PRD 草拟前存在，用于承载 PRD、验收标准、决策文档和后续共享文档。
2. `materialized`：PRD Review 通过、Issue 拆分完成并确定受影响仓库后，只在这些代码仓库中建立对应的 Milestone 集成分支。

- 单代码仓需求：逻辑版本线由伞仓分支和一个代码仓 Milestone 分支组成；
- 多代码仓需求：每个受影响代码仓各有一个 Milestone 集成分支，这些分支与伞仓分支共同组成逻辑版本线。
- 首期所有代码仓都必须是伞仓 `.gitmodules` 中登记的 submodule/Gitlink；本地位置和 GitHub 身份由 Manager session cwd、`.gitmodules` 与已验证 Git remote 推导。

示例：

```text
Milestone M-42
├─ umbrella: milestone/m-42   # PRD、决策文档和后续共享文档
├─ frontend: milestone/m-42
├─ server:   milestone/m-42
└─ plugins:  未涉及
```

逻辑版本线不是一个可以跨仓库存在的物理 Git 分支。PRD 前只初始化伞仓分支，避免在实现范围尚未确定时为所有代码仓创建无用分支。

### 2.4 修复子实例（Corrective child）

父实例进入整体 Review、集成测试或最终交付阶段后发现问题时，通过显式 transition 追加修复子实例。

首版保留两类修复子实例：

- `remediation`：处理 Milestone 整体 Code Review、集成测试或其他验证发现的一般代码问题，并通过 `cause` 记录问题来源；
- `conflict-resolution`：处理同步 baseline branch 或最终交付时出现的 Git 冲突，其分支和合并策略需要保留 Git ancestry。

`remediation.cause` 至少可以区分：

- `milestone-review-failed`；
- `integration-test-failed`；
- `other-validation-failed`。

修复子实例使用 Workflow Definition 固定的精简 corrective route，不存在 per-child Policy、Policy override 或替代验证定义。业务代码修改必须由被授权的开发角色在子实例内完成，Manager 不直接修改业务代码；Policy `ownership.managerOwned` 明确允许的伞仓非代码文档和决策记录可以由 Manager 在相应子实例中处理。Gitlink/submodule pointer 不属于普通 Manager-owned 资源，只能由引擎控制的专用 Host effect 更新。多仓库部分交付不再创建独立的 `delivery-recovery` 子实例，而由父实例保持 `delivery-partial`，再根据具体失败原因选择冲突修复、一般 remediation、重试对账或运维阻塞。

## 3. 核心设计原则

1. 父实例负责阶段编排和聚合门禁，子实例负责具体开发任务。
2. 父、子实例使用独立状态机，不将全部子状态组合进父状态。
3. 子实例由父实例的明确 transition 创建，不能依赖 LLM 判断工作属于哪种实例。
4. 子实例有稳定顺序；已创建和已完成的子实例不删除、不改写历史。
5. 后续发现的新任务通过追加修复子实例处理。
6. 所有开发 Issue 严格串行；前一个未取消子实例未 `integrated`，下一个不得开始开发。
7. 强制读任务与写任务互斥；读任务之间可以并行。
8. PRD Review、子实例 Code Review、Milestone 整体 Code Review 是三个不同作用域的门禁。
9. 集成测试只验证冻结的 release candidate；分支或基线发生变化后，旧证据失效。
10. 多仓库最终交付不追求原子性，但必须达到所有目标仓库均成功合入 baseline branch 的最终一致状态。
11. 任何不可验证、状态不完整或远端不可达的关键步骤均失败关闭。

## 4. 父实例生命周期

父实例的概念阶段如下；首期具体状态名由固定 Workflow Definition 和 ledger schema 冻结，不由 Policy 配置：

```text
加载并静态校验 Policy
→ Parent 启动前 Environment Preflight
→ 父实例创建
→ 创建 GitHub Milestone
→ 初始化伞仓 Milestone 分支
→ PRD 草拟
→ PRD Review
├─ FAIL → 修改 PRD → 重新 PRD Review
└─ PASS
   → Issue 拆分、排序并确定受影响代码仓库
   → 对受影响代码仓库执行 Environment Preflight
   → 在受影响代码仓库中物化 Milestone 集成分支
   → 严格串行执行 Issue 子实例
   → 同步最新 baseline 到各 Milestone 分支
      ├─ 有冲突 → 追加 conflict-resolution 子实例
      └─ 无冲突
   → 冻结 release candidate
   → Milestone 整体 Code Review
      ├─ FAIL → 追加 remediation(cause=milestone-review-failed)
      │          → 串行执行
      │          → 重新计算最早失效门禁
      └─ PASS
         → 集成测试
            ├─ FAIL → 追加 remediation(cause=integration-test-failed)
            │          → 串行执行
            │          → 重新计算最早失效门禁
            └─ PASS
               → 最终交付预检
               → 各代码仓串行合入 baseline
               ├─ 部分成功 → delivery-partial
               │                  → 按失败原因恢复剩余代码仓
               └─ 全部成功
                  → 更新伞仓 submodule 指针和最终文档
                  → 伞仓 milestone 分支合入伞仓 baseline
                  ├─ 未完成 → delivery-partial
                  └─ 成功 → completed
```

父实例只在阶段边界发生状态变化。子实例内部的每个开发、Review 和测试状态不复制到父实例中。

父流程不保存一个可以直接跳回的“中断点”。每次子实例集成或远端事实变化后，父实例重新计算门禁有效性，并路由到最早一个尚未满足或已经失效的强制门禁。旧的 Review、测试和交付尝试保留为审计历史，不通过覆盖状态实现“重置”。

除正常完成和 recovery/blocker 外，Parent 还可以进入不可恢复的 `abandoned` 终态。首期使用的原因包括 `policy-incompatible-change` 和 `workflow-definition-incompatible`。进入该终态后 Host 只记录原因、提示用户并停止推进，不自动清理、回滚或恢复任何本地与远端产物；后续工作必须创建全新 Parent 并从当前远端基线重新开始。具体检测规则见 `docs/design/workflow-policy-dsl-static-validation.md`。

## 5. 子实例生命周期

普通 Issue 子实例的概念流程如下：

```text
planned
→ branch-ready
→ development
→ code-review
├─ FAIL → development → code-review
└─ PASS
   → authoritative-unit-test
   ├─ FAIL → development → code-review → authoritative-unit-test
   └─ PASS
      → merge-ready
      → PR merge into milestone branch
      → integrated
```

### 5.1 分支规则

- feature branch 必须从对应仓库最新的 Milestone 分支创建；
- feature branch 必须遵循 policy 配置的命名规则；
- 子 PR base 必须是对应仓库的 Milestone 分支；
- 子 PR 合并后，从远端验证真实 merge 状态和结果 SHA；
- 只有完成远端验证，子实例才能进入 `integrated`。

### 5.2 Review 与单元测试顺序

子实例开发完成后，先进行 Code Review，通过后再运行可作为门禁证据的正式单元测试。

开发阶段仍允许并鼓励使用 TDD、编写测试并运行开发者自测。这里的 `authoritative-unit-test` 指 Review 通过后对确定 PR head SHA 执行的正式验证。

如果正式单元测试失败，需要返回开发阶段；代码发生变化后，旧 Code Review 失效，必须重新 Review 后才能重新运行正式单元测试。

## 6. 严格串行与读写屏障

### 6.1 Issue 严格串行

父实例维护有序子项，例如：

```text
children:
  - issue-101, sequence=1
  - issue-102, sequence=2
  - issue-103, sequence=3
```

首期所有新建 Child 默认且固定参与完成条件，不提供 `optional` 配置。尚未开始开发且确实不再需要的 Child，只能通过引擎定义的显式取消 transition 处理，并保留取消原因和历史。

父实例计算：

```text
nextRunnableChild =
  第一个尚未 integrated 且未取消，并且所有前序未取消 children 均已 integrated 的子实例
```

只有 `nextRunnableChild` 可以进入开发。后续 Issue 的 feature branch 必须基于前序 Issue 已合入后的最新 Milestone 分支。

### 6.2 读写屏障

工作流采用比普通 writer lease 更严格的阶段约束：

```text
WRITE phase
- 恰好一个写型子实例可以修改代码
- 不允许强制 Review、审计或测试任务同时进行

READ/VALIDATION phase
- 多个只读任务可以并行
- 不允许任何开发子实例开始或恢复代码修改
```

“存在读任务”仅指固定 Workflow Definition 已要求、并由 Parent/Child 当前 task facts 创建且尚未完成的强制读/验证任务，不包括无关的临时只读 Agent。

Manager 调度、状态查询和不会改变代码候选的只读操作不自动获得代码修改权限。

## 7. 三层 Review 门禁

### 7.1 PRD Review

- 作用域：伞仓 Milestone branch 上固定位置 `{artifacts.directory}/m-{milestoneNumber}/prd.md` 中的需求、验收标准和拆分依据；
- 证据绑定：该固定 path 和伞仓 candidate commit SHA；
- 时机：创建开发 Issue 前；
- FAIL：修改 PRD 后重新 Review；
- PASS：父实例才可创建和排序 Issue 子实例。

### 7.2 子实例 Code Review

- 作用域：单个 Issue 的 feature branch/PR head；
- 时机：开发完成后、正式单元测试前；
- FAIL：返回同一子实例的开发阶段；
- PASS：允许对同一 PR head 执行正式单元测试；
- 代码 SHA 变化：旧 Review 失效。

### 7.3 Milestone 整体 Code Review

- 作用域：所有受影响仓库共同组成的 release candidate；
- 时机：全部未取消子实例均已 `integrated`，且最新 baseline branch 已同步到 Milestone 分支之后；
- FAIL：追加 `remediation(cause=milestone-review-failed)` 子实例并返回严格串行子实例执行；
- remediation 完成后：代码候选已经变化，父实例重新计算门禁，从最早失效门禁继续；
- PASS：允许启动集成测试；
- release candidate 变化：旧整体 Review 失效。

### 7.4 门禁失效与重新路由

父实例按固定先后关系维护门禁：

```text
PRD Review
→ all non-cancelled children integrated
→ baseline synchronized
→ release candidate frozen
→ Milestone overall Code Review
→ integration test
→ final delivery
```

父实例不依赖“失败前停在哪一步”决定恢复位置，而是在每次 mutation 或远端事实变化后计算：

```text
nextRequiredGate = 最早一个尚未满足或证据已经失效的强制门禁
```

例如集成测试失败后创建 remediation 子实例。该子实例合入 Milestone 会改变候选 SHA，因此 release candidate、整体 Review 和集成测试证据都不再适用于当前候选。父实例自然返回基线同步/候选冻结，再重新执行整体 Review 和集成测试，而不是从旧集成测试中断点直接继续。

门禁的历史尝试 append-only 保留；“重新执行”创建新的 gate attempt，不删除或覆盖旧证据。

## 8. Milestone 基线同步

### 8.1 同步方向

整体 Code Review 前，各仓库执行：

```text
<remoteAlias>/<baselineBranch> → milestone branch
```

同步不会把 Milestone 未测试代码推入 baseline branch。变化只发生在同步分支和 Milestone 集成分支。

不采用只在本地同步而不 push 的方案，因为 Review、CI、集成环境、重启恢复和远端审计都需要稳定的远端 SHA。

### 8.2 无冲突同步

可以使用受控的自动同步分支/PR完成：

```text
{syncPrefix}m-<milestone>/<baseline-sha>
→ merge <remoteAlias>/<baselineBranch>
→ 自动检查
→ PR 回 milestone branch
```

同步合并必须保留 Git ancestry；不能使用会丢失 baseline branch 祖先关系的 squash 方式。

### 8.3 有冲突同步

如果合并 baseline branch 时产生冲突：

1. 父实例追加 `conflict-resolution` Issue 子实例；
2. 从干净的 Milestone 分支创建冲突修复分支；
3. 在修复分支上合入最新 `<remoteAlias>/<baselineBranch>`；
4. 冲突文件只存在于该修复分支的工作区；
5. 开发角色解决冲突并提交；
6. 执行 Code Review 和正式验证；
7. 通过 PR 合入 Milestone 分支；
8. 保留 merge ancestry，不使用 squash；
9. 冻结新的 release candidate；
10. 重新执行 Milestone 整体 Code Review；
11. 按 `workflow-policy/v1` 固定要求重新执行完整集成测试。

Manager 负责创建、派发和裁决冲突修复子实例，但不直接修改冲突代码。手工冲突修复产生新的代码候选，因此旧 Milestone 整体 Code Review 必然失效；`workflow-policy/v1` 固定重新执行整体 Review 和完整集成测试，不提供替代验证。

## 9. Release candidate 与 SHA 绑定

### 9.1 Manifest

基线同步完成后，父实例冻结一个 release candidate manifest。每个受影响仓库至少记录：

```text
repository
milestoneBranch
milestoneHeadSha
baselineBranch
baselineBaseSha
```

多仓库 manifest 是一组 SHA，而不是单个 SHA。

Milestone 整体 Code Review 和集成测试均绑定 manifest。不能只绑定可移动的分支名。

### 9.2 最终合并前检查

每个仓库必须满足：

```text
current milestone head SHA == tested milestoneHeadSha
AND
current baseline head SHA == recorded baselineBaseSha
```

处理规则：

- 两者均未变化：允许进入最终合并；
- Milestone SHA 变化：拒绝合并，重新整体 Review 和集成测试；
- baseline branch SHA 变化：重新执行 `baseline → milestone` 同步；
- 同步无冲突：生成新候选并重新整体 Review、集成测试；
- 同步有冲突：追加冲突修复子实例，完成后生成新候选并重新验证。

首期不引入文件风险分类、增量测试豁免或 Manager 任意 override：任何候选或基线变化都重新执行整体 Review 和集成测试，以较低配置复杂度换取安全性。未来新的 schemaVersion 可以另行讨论受控替代验证，但 `workflow-policy/v1` 不提供该能力。

Git 无冲突不等于集成测试仍然有效，因此不能只依赖最终 PR 的 conflict 状态。

## 10. 集成测试循环

集成测试只能在以下条件全部满足后开始：

1. 所有未取消 Issue 子实例均已 `integrated`；
2. 最新 baseline branch 已同步到全部受影响的 Milestone 分支；
3. release candidate manifest 已冻结；
4. Milestone 整体 Code Review 对该 manifest 判定 PASS；
5. 没有写型子实例或其他强制读任务仍在运行。

集成测试 FAIL 时：

1. 父实例追加 `remediation(cause=integration-test-failed)` 子实例；
2. 子实例按严格串行规则开发、Review、单元测试并合入 Milestone 分支；
3. 父实例重新计算门禁有效性；
4. 因候选 SHA 已变化，重新同步最新 baseline branch；
5. 冻结新的 release candidate；
6. 重新执行 Milestone 整体 Code Review；
7. Review PASS 后重新执行集成测试。

这不是从旧集成测试中断点恢复，而是从最早失效门禁重新推进。旧 release candidate、Review 和测试结果保留为历史事件，不覆盖或删除。

自动化测试执行和测试经验沉淀方案另见：

`../pending-discussions/automated-testing-and-test-learning.md`

## 11. 多仓库最终交付

### 11.1 不追求跨仓库原子合并

GitHub 无法为多个独立仓库提供原子 merge。首版明确接受非原子现实，目标是最终一致性：

> 父实例涉及的所有目标仓库最终都成功将对应 Milestone 版本线合入 baseline branch。

### 11.2 代码仓全量预检、串行合并

代码仓最终交付流程：

```text
获得父实例级 release lease
→ 对所有代码仓最终 PR 做全量预检
→ 任意一个失败：一个代码仓都不开始合并
→ 全部通过：按 policy 声明的代码仓顺序串行合并
→ 每次合并后从远端验证
```

全量预检至少包括：

- 当前 Milestone head SHA 与已测试候选一致；
- 当前 baseline branch SHA 与候选基线一致；
- PR 仍 open 且 base/head 正确；
- PR mergeable；
- required checks 成功；
- 远端 branch protection/ruleset 满足要求。

仓库合并顺序由 policy 明确声明，例如先 server/plugins、后 frontend，不能由模型临时发明。

### 11.3 部分成功

如果在已经成功合并一个或多个仓库后，后续仓库合并失败：

```text
parent state → delivery-partial
```

`delivery-partial` 是父实例对非原子远端事实的明确表达，不对应一种固定的开发子实例。处理原则：

- 不把父实例标记为完成；
- 停止剩余自动 merge；
- 不自动回滚已经成功的 merge；
- 记录每个仓库的 `pending/merged/failed` 交付状态；
- 根据失败原因选择恢复动作；
- 只有所有目标仓库均远端验证为已合入 baseline branch，父实例才能完成。

失败原因与恢复动作：

```text
Git 冲突或需要人工解决的基线漂移
→ conflict-resolution 子实例
→ 冻结新候选
→ 重新整体 Code Review
→ 按 workflow-policy/v1 固定要求执行完整集成测试
→ 继续交付剩余仓库

required checks 失败且需要修改代码
→ remediation 子实例
→ 重新计算最早失效门禁

GitHub 暂时不可达、rate limit 或进程崩溃
→ outbox retry / reconciliation
→ 不创建开发 Issue

权限、branch protection 或运维配置错误
→ 保持阻塞并等待管理员修复
→ 不创建代码修复子实例
```

已经成功合并的仓库保持 `merged`，不重复回滚或重新 merge。恢复阶段形成的候选和验证范围必须能够表达“已合并仓库的当前 baseline branch 状态 + 尚未合并仓库的待交付 Milestone 状态”。具体 recovery manifest 表达和测试执行器机制留给持久化/自动测试专项，但不能降低 workflow-policy/v1 固定的整体 Code Review、完整集成测试和候选失效规则。

未全部交付前，不关闭 Milestone，也不将本次版本视为可部署完成。

release lease 只能阻止由本插件管理的并发写任务，不能阻止插件外的 GitHub 操作者更新 baseline branch。最终 merge 前仍必须重新读取和验证远端事实。

### 11.4 伞仓最终收尾

所有受影响代码仓均成功合入各自 baseline branch 后，父实例最后处理伞仓：

```text
读取并验证各代码仓实际 merge 后的 baseline SHA
→ 在伞仓 Milestone 分支更新 submodule/Gitlink 指针
→ 完成最终文档和一致性检查
→ 创建伞仓 milestone → 伞仓 baseline 的最终 PR
→ 受控合并并从远端验证
```

规则：

- 伞仓指针必须引用代码仓真实合并后的 SHA，不能引用旧候选、临时分支或未验证提交；
- 正常指针更新是确定性的父级 effect，可以由 Manager 通过受控工具执行，不视为编写业务代码；
- 伞仓最终 PR 是父实例完成条件的一部分，未成功合入伞仓 baseline branch 时父实例保持 `delivery-partial`；
- 伞仓发生文档、决策记录或 Gitlink/submodule 指针冲突时，创建 `conflict-resolution` 子实例并由 Manager 执行；
- 如果冲突超出 policy 定义的 Manager-owned 非代码路径，则必须改派给相应开发角色，不能由 Manager 自行扩大权限范围；
- 仅更新伞仓文档或指针不会改变已通过集成测试的代码仓提交，因此只需验证文档、指针和目标 SHA 一致性，不触发完整集成测试；
- 如果任何代码仓 SHA 再次变化，则对应 release candidate 和测试有效性按正常门禁规则重新计算。

父实例只有在所有代码仓和伞仓均远端验证成功合入各自 baseline branch 后，才能进入 `completed`。

## 12. 父子聚合规则

父实例不复制所有子状态，而根据子实例和远端事实计算门禁：

- `nextRunnableChild`：第一个尚未完成且未取消，并且前序未取消 children 全部 `integrated` 的子实例；
- `allNonCancelledChildrenIntegrated`：所有未取消 children 均达到 `integrated`；
- `candidateReady`：全部未取消 children 均已 `integrated`，且所有仓库已同步最新基线；
- `milestoneReviewValid`：整体 Review 绑定当前 manifest 且 PASS；
- `integrationTestValid`：测试绑定当前 manifest 且 PASS；
- `deliveryComplete`：所有受影响代码仓和伞仓均远端验证已合入各自 baseline branch，且伞仓指针与代码仓真实 merge SHA 一致。

父 transition 每次重新计算这些条件。缓存的 projection 可以用于展示，但不能替代关键 transition 前的权威检查。

## 13. 子集合变更规则

- PRD Review PASS 后才能创建首批普通 Issue 子实例；
- 首批子实例按明确顺序登记；
- 开发开始后，不静默修改原有子实例含义或顺序；
- 整体 Review、集成测试和交付恢复产生的新任务使用追加子实例；
- 首期所有新建 Child 均固定参与完成条件，不开放 Policy 级 `required/optional` 配置；
- 尚未开始开发且确实不再需要的 Child，可以通过引擎定义的显式取消 transition 进入固定的 `cancelled` 终态，不物理删除；
- `failed`、`blocked` 或其他失败状态不能由 Policy 配置为可接受完成状态；
- 追加或取消子实例必须由受权 transition 完成并留下事件和原因。

## 14. 已确认的不变量

1. 一次功能需求对应一个父实例和一个 GitHub Milestone。
2. 父实例在 PRD 草拟前初始化伞仓 Milestone 分支，用于承载 PRD、验收标准和决策文档。
3. PRD Review PASS 并确定受影响仓库后，才在这些代码仓中物化 Milestone 集成分支。
4. 一个 Milestone 对应一条由伞仓分支及受影响代码仓分支组成的逻辑版本线。
5. 一个开发 Issue 对应一个仓库内的子实例。
6. 普通和修复子实例均使用独立状态机。
7. 一般代码问题统一使用 `remediation` 子实例，并通过 `cause` 记录问题来源。
8. Git 冲突使用 `conflict-resolution` 子实例；业务代码冲突由开发角色处理，Manager 只处理 policy 明确归类的 Manager-owned 非代码资源。
9. 子实例严格串行；前一项未合入 Milestone，后一项不启动开发。
10. 只有读任务允许并行；强制读/验证阶段不允许开发。
11. PRD Review PASS 后才能创建开发 Issues。
12. 子实例开发完成后先 Code Review，再执行正式单元测试。
13. 全部未取消 Issues 合入 Milestone 后，先执行整体 Code Review，再执行集成测试。
14. 父实例不从保存的中断点恢复，而是路由到最早一个未满足或已失效的强制门禁。
15. 集成测试前将最新 baseline branch 同步到各 Milestone 分支。
16. 整体 Review 和集成测试绑定跨仓库 release candidate manifest。
17. 新候选必须重新执行整体 Code Review 和完整集成测试；首期 Policy 不提供替代验证或跳过配置。
18. 最终交付对所有代码仓先全量预检，再按 policy 顺序串行 merge。
19. 多仓库 merge 不要求原子性，但要求最终全部成功合入 baseline branch。
20. 部分成功进入父状态 `delivery-partial`，按失败原因选择 conflict-resolution、remediation、重试对账或运维阻塞，不创建固定的 delivery-recovery 子实例，也不伪装成功或自动回滚。
21. 所有代码仓合入 baseline branch 后，伞仓更新 submodule/Gitlink 指针并最后合入伞仓 baseline branch；此前父实例不能完成。
22. 伞仓及 policy 明确归类的非代码路径冲突可由 Manager 在 conflict-resolution 子实例中处理；业务代码冲突仍必须交给开发角色。
23. 仅伞仓文档或指针变化不触发完整集成测试，但任何代码仓 SHA 变化仍按正常门禁规则使候选和测试证据失效。
24. 首期所有新建 Child 均固定参与完成条件，不开放 optional 或 Policy 自定义可接受终态；仅尚未开始开发的 Child 可通过固定显式 transition 取消并保留原因和历史。
25. Policy continuity projection 变化或 Workflow Definition 不兼容时，Parent 进入不可恢复的 `abandoned` 终态；源文件表示或 reloadable 字段变化不直接废弃 Parent。
26. Static Policy Validation 不访问外部环境；Environment Preflight 在 Parent 启动前、受影响仓库确定后和最终交付前分阶段执行，并在 reloadable Role Agent definition 变化时增加受影响角色的定向 preflight。
27. 一个 Policy 对应一个产品工作区、一个伞仓和固定 Repository Catalog；Parent 只能从该 Catalog 选择受影响代码仓库，交付顺序由 Policy 全局顺序投影得到。
28. 首期 Repository Catalog 中所有代码仓均来自伞仓 `.gitmodules`；Workspace Root 使用 Manager session cwd，本地 checkout 和 GitHub identity 由 `.gitmodules` 与已验证 Git remote 推导，不在 Policy 中重复配置绝对路径或 owner/repository。
29. Repository Catalog 是 Policy 显式白名单；`.gitmodules` 中未被列出的 submodule 不能被 Parent 选择，交付顺序必须是 Catalog 代码仓的无重复完整排列。
30. 首期 repositoryKey 必须等于 `.gitmodules` submodule name；伞仓与全部 Catalog 代码仓共用一个 Policy 声明的 baseline branch，不支持每仓覆盖。
31. Policy 只能配置各类引擎分支的 prefix；稳定 ID、后缀格式和 branch 类型映射由引擎固定，不开放完整模板。
32. Manager-owned 路径只作用于伞仓，使用精确目录和最终文件名 segment 的非递归 `*`；固定拒绝目标、Catalog 代码仓和 Gitlink 不受普通路径规则授权。
33. 首期每个 Catalog Repository 直接内联唯一 unit test definition，Product Workspace 直接内联唯一 integration test definition，不建立 Validation Profile Registry 或运行时替代选择。
34. Policy 只配置一个 artifacts.directory；首期仅固定位置的 `prd.md` 是权威 Workflow 文档，Issue、Review、测试、交付和 ledger 状态不生成 Markdown 镜像。
35. Parent 创建前 Environment Preflight 失败只拒绝启动；创建后的可修复环境失败进入 workflow-recovery。只有 Policy continuity projection 变化或 Workflow Definition 不兼容进入不可恢复的 abandoned。
36. 首期仅 Role Agent subagentProvider/model/persona/tools.deny 与 ownership.managerOwned 允许在 Manager Turn 边界热重载；接受前必须确认受影响 Actor 没有运行中的 turn，并完成所需定向 preflight；随后原子推进 accepted hashes 并将旧 mapping 标记 stale。下一次派发前以新的 agent.id 替换，既有 evidence 不因此失效；替换失败时保留新 Policy 和 stale mapping，Parent 进入 workflow-recovery。

## 15. 后续设计边界

Trusted Actor/Role Actor 与 Workflow Policy Profile 已由关联设计冻结。以下内容仍需分别讨论：

- SQLite ledger、revision、idempotency、lease 和 outbox；
- GitHub adapter 和 branch protection 校验；
- 自动化测试编排、缓存、增量测试和测试经验沉淀；
- Web UI、可解释 denial 和人工操作入口；
- 固定 Workflow Definition 的具体代码常量、tool/action 名和数据库字段。
