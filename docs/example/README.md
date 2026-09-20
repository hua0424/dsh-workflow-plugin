# 工作流配置模板（docs/example/）

> ✅ **版本状态（#129 起）**：运行时只接受 `agent-workflow/v3`。本目录的
> [`coding-workflow.yaml`](coding-workflow.yaml) 与
> [`coding-workflow-rapid.yaml`](coding-workflow-rapid.yaml) 是**可直接加载的 v3
> 生产配置**（#129 迁移落地，与本文件字段说明同源维护）；
> [`v3-combined-example.yaml`](v3-combined-example.yaml) 是覆盖全部节点类型的
> v3 组合示例。`workflow-template.yaml` 仍是 **v2 时代**的遗留模板，
> **不可加载**，仅作历史参考保留（不半迁移成中间态）。
> v3 的节点形状是「命名结果 + 统一 Target + 流程 returns」，`node_claim` 只接受
> `{ result, handoff }`，Child 调用节点用 `onReturn` 显式映射（#131 已接通执行）。
> Program 节点的 `PASS`/`FAIL` 按统一 Target 路由**自 #130（T1）起即生效**；
> #132（T3）交付 Program 定向证据、ERROR 人工恢复（`node_run_program` /
> `node_resolve_program`）的文档与示例入口。
> 更多可运行示例见 `test/v3-actor-root.test.ts`、`test/v3-child-returns.test.ts`、
> `test/v3-program-targets.test.ts`。

本目录存放 `agent-workflow/v3` 工作流的**示例与字段说明**。新建工作流时，选择模板复制到
catalog 目录后按需修改，不要从零手写。

| 场景 | 模板 |
|---|---|
| 单仓、单任务 | [coding-workflow-rapid.yaml](coding-workflow-rapid.yaml) |
| 伞仓多仓、小范围单 Issue | [coding-workflow-rapid-multi.yaml](coding-workflow-rapid-multi.yaml) |
| 伞仓多仓、分票及 Milestone 交付 | [coding-workflow.yaml](coding-workflow.yaml) |
| 单仓、分票及 Milestone 完整交付 | [coding-workflow-single.yaml](coding-workflow-single.yaml) |

## 使用方法

1. 复制模板：

   ```powershell
   Copy-Item docs/example/coding-workflow-rapid.yaml "$env:USERPROFILE\.dsh\workflows\<workflow-id>.yaml"
   ```

   （`%DSH_HOME%\workflows\`，DSH_HOME 默认为 `~/.dsh`。）

2. **文件名去掉 `.yaml` 后即 workflowId**，必须匹配 `[a-z][a-z0-9-]*`
   （小写字母开头，只含小写字母/数字/连字符）；`.yml` 会被直接忽略。
3. 修改 roles / judgeRole / workflow / childWorkflows 后，用 `/dsh-flow list`
   校验：invalid 文件**只阻塞自身**并在诊断中列出原因，不影响其他工作流。
4. `/dsh-flow start <workflowId>` 启动 Run；`/dsh-flow status` 查看进度。

## model 如何配置（subagent Role 与 judgeRole）

worker subagent 和 Judge 的模型路由配置格式相同，都是一个**可选**的
`model` 块，只有 `provider` + `modelId` 两个必填字段（unknown 字段会被
strict schema 拒绝）：

```yaml
roles:
  developer:                 # worker subagent
    persona: |
      ……
    model:                   # 可选：省略则继承 Manager 路由
      provider: deepseek     # trim 后 1..64 字符
      modelId: glm-4.7       # trim 后 1..128 字符

judgeRole:                   # Judge
  persona: |
    ……
  model:                     # 同样可选
    provider: deepseek
    modelId: glm-4.7
  tools:                     # 可选：在插件默认 deny 清单之上再收紧
    deny: [pwsh]
```

优先级与生效规则（`resolveRoleModel`，src/roles/roles.ts）：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1（最高） | 运行时 override | Manager 调用 `workflow_set_role_model({ roleKey, provider, modelId })`；`roleKey` 填 `"judge"` 即覆盖 Judge |
| 2 | YAML 定义 | `roles.<key>.model` / `judgeRole.model` |
| 3（兜底） | 冻结的 Manager 路由 | Run 启动时解析一次并冻结；YAML 省略 `model` 即走这条 |

要点：

- **省略 `model` = 继承 Manager**：Run 启动时把当前 Manager 的模型路由
  冻结进 Run State，之后修改主会话模型不影响进行中的 Run。
- **Manager 本身不可配 model**：`manager` 是保留 roleKey，禁止出现在
  `roles` 中，YAML 不伪装修改它的 persona/model/tools——它始终由当前
  主会话承担。
- **运行时覆盖的限制**：目标 Worker 有活跃 turn、或当前节点的 actor 正在
  等待判定/修正（pendingClaim/pendingCorrection）时，override 被拒绝；
  覆盖只影响之后新建的会话——Worker 的覆盖在 actor 空闲时生效（删除旧映射，
  下次派发按新路由创建 replacement），Judge 的覆盖后 `node_resume` 自动对旧
  会话走 fresh（释放旧会话 + 按新路由 spawn，与 Worker 一致）；正在判定的
  live Judge 会话不受影响，旧模型额度耗尽时用新模型覆盖后直接 `node_resume`
  即可，无需先 `judge_respawn`（Issue #22）。
- **只允许 provider + modelId**：不配置 maxTokens / temperature / fallback
  等 provider 属性；subagent 的 spawn provider（in-process continuable）
  也是固定的，YAML 不配置。
- provider/modelId 会写入 trace log 的 `MODEL` 行（见 README「Run trace
  logs」），凭据形状的值会被 redact。

## 会话复用粒度（Issue #60）

`roles.<roleKey>.reuse` 选择该 worker Role 的会话复用粒度：

| 取值 | 语义 |
| --- | --- |
| `node`（缺省） | 节点级复用：同一节点的重复派发/修正复用同一会话，离开节点即 drain + 撤权，跨节点边界不再 compact |
| `continuable` | 旧行为：Role 的 continuable 会话跨节点复用，每次派发新节点前执行 Node 边界 compact |

```yaml
roles:
  developer:
    persona: |
      Implement the current issue.
    reuse: continuable      # 省略即 node
```

要点：

- **缺省是 `node`**：省略 `reuse` 时静态校验把它归一化为 `node` 并写入
  `definitionSnapshot`，Run 启动时冻结；之后再改 YAML 只影响下一个 Run。
- **非法值只阻塞自己**：`reuse` 只接受 `node` / `continuable`，其他值（含大小写
  变体）被 strict schema 拒绝，该 catalog 文件在 `/dsh-flow list` 显示为
  diagnostic，其他 workflow 不受影响。
- **`manager` 不适用 `reuse`**：`manager` 是保留 roleKey，禁止出现在 `roles` 中，
  所以 `roles.manager.reuse` 在校验期直接失败（"reserved"）；manager 节点始终由
  当前主会话承担，不参与 Role 会话复用。`judgeRole` 同样不接受 `reuse`——Judge
  每个节点都是全新会话。
- **`continuable` 的代价与选型**：单一权威说明在 `docs/user-guide.md` §3.1
  「会话复用粒度 `reuse`」——边界 compact 的派发前时延、compact 失败 fail-closed
  BLOCK（风险面见 issue #55）与何时该选它。

## Judge 工具面（Issue #25）

Judge 与其他 Role 一样继承**全量工具目录**，插件只把写类/副作用工具默认 deny
掉，保持"只读核验"姿态。生效的 deny 清单 = 插件默认清单 ∪ `judgeRole.tools.deny`：

| 类别 | 默认 deny 的工具 | 说明 |
| --- | --- | --- |
| 文件写入 | `edit`、`write` | Judge 只核验，不改工作树 |
| Run 控制 | `node_claim`、`node_block`、`node_resume`、`node_run_program`、`node_resolve_program`、`workflow_set_role_model`、`judge_respawn` | 会改变 Run 状态；`workflow_status` 是只读查询，**不** deny |
| 委托机制 | `report`、`structured_output` | 子运行时自己的机制层，从不参与可见性过滤 |
| 受保护（不可 deny） | `read`、`glob`、`grep`、`read_image`、`workflow_inspect_git`、`workflow_inspect_github`、`judge_claim` | 写进 `judgeRole.tools.deny` 会在 catalog 校验期直接失败（deny 掉 `judge_claim` 会让 Judge 无法交判定） |

放行指引：

- **想放开查询类工具**：不用改插件——`gh`、`git`、`pwsh` 等本来就不在默认 deny
  清单里，Judge 直接可见可用（`pwsh`/`gh` 是宿主工具，改动不会影响其他角色）。
- **想再收紧**：在 `judgeRole.tools.deny` 里加名字，例如 `deny: [pwsh]` 让 Judge
  只能用 inspection wrappers。
- **维护义务**：默认清单是"默认开放 + 配置收敛"姿态，宿主新增的副作用工具会在
  插件更新默认清单之前对 Judge 可见。升级 DSH 后如发现新的写类/副作用工具，请在
  本仓库提 issue 扩充 `src/roles/roles.ts` 的 `JUDGE_DEFAULT_DENY`。
- **配置冻结**：`judgeRole.tools.deny` 与其他静态定义一起在 Run 启动时冻结进
  `definitionSnapshot`，Run 中途改 YAML 对进行中的 Run 不生效（下次 start 才生效）。
- 三层强制同源（spawn 过滤 / spawn 后断言 / 运行期鉴权）都从同一份 deny 清单派生，
  只改其中一层会静默失效。

## 配置面速查

顶层字段（strict schema，unknown 字段一律拒绝）：

| 字段 | 必填 | 内容 |
| --- | --- | --- |
| `schemaVersion` | ✓ | `agent-workflow/v3`（v2 配置自 #128 起不再接受） |
| `roles` | ✓ | worker Role 定义表；key 即 roleKey |
| `actorCommonPersona` | ✗ | 工作流级公共 persona：可选非空字符串，见「工作流级公共 persona（Issue #140）」 |
| `judgeRole` | ✓ | Judge 定义（persona 必填，model / tools.deny 可选，见「Judge 工具面」） |
| `workflow` | ✓ | 根工作流图 |
| `childWorkflows` | ✗ | 子工作流图（按 workflowId 引用） |

Role 定义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `persona` | ✓ | 非空，trim 后存储 |
| `model` | ✗ | `{ provider, modelId }`，见上文 |
| `tools.deny` | ✗ | 非空列表；在插件默认 deny 清单（`edit`/`write` + workflow 控制工具）之上再收紧，受保护工具不可 deny |
| `reuse` | ✗ | `node`（缺省）或 `continuable`；会话复用粒度，见「会话复用粒度（Issue #60）」 |

## 工作流级公共 persona（Issue #140）

顶层可选字段 `actorCommonPersona`：各 Role Actor 共同遵守的 system 约定。

```yaml
schemaVersion: agent-workflow/v3
actorCommonPersona: |
  本工作流所有执行角色共同遵守的 system 约定。
roles:
  developer:
    persona: |
      开发角色专属职责。
```

要点：

- **可选非空**：缺省时行为与旧版完全一致（角色 persona 原样用作 system
  prompt）；提供时 trim 后存储，空白值与非字符串被严格拒绝（含绕过 schema
  的手工构造，静态校验同样拒绝）。
- **组合顺序固定**：`actorCommonPersona` 在前、角色专属 persona 在后，中间以
  单个空行（`\n\n`）分隔；原始角色 persona 的语义不被修改。
- **唯一组合点**：角色会话创建（spawn）与冷恢复后的一切读取都走
  `roleActorPersona`（`src/roles/roles.ts`），只读冻结快照、不改写快照，
  重复组合不会叠加；冷物化本身不重设 persona，沿用 spawn 时的会话。
- **不注入 Judge 与 Manager**：`judgeRole.persona` 与 Manager 派发的文本不受
  影响（除非作者在各自专属字段/节点 instruction 中明确写入）。
- **冻结进快照**：含该字段的配置与缺省配置的 `definitionHash` 不同，Run 启动
  时冻结；手写提交协议关键词（`node_claim` 等）只告警、不阻塞。
- **共同约定放这里，节点动作放 instruction**：result 的验收条件仍进各结果
  `criteria`，不能只依赖 persona 上下文。

节点（`workflow.nodes.<nodeId>`）三种 execution：

| type | 必填字段 | 可选字段 | 说明 |
| --- | --- | --- | --- |
| `actor-task` | `role`、`instruction` | — | 派发给 Role（或 manager）执行，需配 `checker` |
| `builtin-program` | `programId` | `instruction`、`config` | 仅内置程序：`github.initialize-milestone`、`github.all-milestone-issues-complete` |
| `child-workflow` | `workflowId` | — | 引用 `childWorkflows` 中的子图，禁止递归/引用根 |

边与判定（v3，#128/#130 起生效；v2 的 `onPass`/`onFail`/裸 `END` 已不存在）：

- `checker`：目前仅 `judge.claim-correct`。`config.criteria` 变为**可选**的共同条件
  （trim 后 1..8000 字符）；每个结果另有自己的必填 `criteria`，两者随 Run 冻结并同源
  下发给 Actor 与 Judge（Judge 只核验共同条件 + 本次所选结果条件）。
- 节点用 `results: { <result-name>: { criteria, target } }`；`target` 是严格互斥的
  `{ node: <本流程节点> }` 或 `{ return: <本流程返回名> }`，**没有**裸 `END`、
  `onPass`/`onFail`、默认路由或通配映射。单出口节点也必须显式声明结果名。
- 工作流（含 child）声明非空且不重复的 `returns`；每个返回至少需要一条结构可达的
  返回路径。走到 `{ return }` 即流程返回，Root 的返回就是 Run 的业务终局
  （`workflow_status` 的 `businessReturn`）。
- `node_claim` 只接受 `{ result, handoff }`；`result` 必须命中当前冻结节点声明的
  结果名，非法结果/额外字段在写入状态前被拒。
- Child 调用节点用 `onReturn`（键集必须与被调用流程的 `returns` 完全一致，值为本层
  Target）；子流程走到 `{ return }` 时按该映射继续，允许逐层重命名，调用层不派模型/
  Judge（#131 T2 起生效）。
- Program 节点的 `results` 键固定为 `PASS`/`FAIL`（其他键含 `ERROR` 在校验期拒绝），
  值为统一 Target：可继续到本流程节点，也可 `{ return }` 结束本流程；ERROR、抛错与
  结果未知只 BLOCK 保留参数，Manager 用 `node_resolve_program` 事实确认后恰好推进一次，
  Program 不派 Judge（Program 的路由自 #130 T1 起生效，#132 T3 交付定向证据与 ERROR
  人工恢复的文档/示例入口）。

静态校验（复制模板后常见报错）：

- id 语法（workflowId/roleKey/nodeId）：`[a-z][a-z0-9-]*`。
- 根 `startNode` 必须是 `role: manager` 的 `actor-task` 节点。
- 每个工作流的所有节点从 `startNode` 可达；每个声明的返回至少存在一条结构可达的
  返回路径（v3 没有裸 `END`，流程经 `{ return }` 结束）。
- `actor-task` 引用的 role 必须在 `roles` 中定义（或为 `manager`）；
  `judge` 不能当 worker 用。
- YAML 限制：单文档、无 duplicate key、无 anchor/alias/merge key、
  无自定义 tag、无模板插值。

## 完整示例

- **v3 生产配置（#129 起，可直接加载）**：
  [`coding-workflow.yaml`](coding-workflow.yaml)（2026-09-19.2：仅伞仓多仓 Milestone，含子流程；
  用户一次确认 baseline、Milestone 名、统一 milestone 分支名及每仓起点，全部仓走 feature → milestone → baseline。
  Issue/Milestone 只在伞仓；实施票合入 milestone 后保持 open，独立整体验收与逐仓发布后统一关闭）与
  [`coding-workflow-rapid.yaml`](coding-workflow-rapid.yaml)（单仓轻量任务，四节点无子流程；
  GitHub Issue 评论跟踪，仅长报告按需写 ignored run 目录。merge 消费上游 approved，只执行合并与收尾，
  对象/修订变化或当前操作异常 BLOCK 交 Manager，不自行重审或回 review；无项目规定时默认 squash）——
  配套参考合同见 `docs/dsh-workflow/` 对应 `*-contract.md`；两者均以 Issue 评论跟踪，
  不要求本地 run.md、合同副本或普通审查文件。完整流程用主 Issue 保存运行身份、
  计划、候选集合与 publication，用实施/修复 Issue 保存本票证据。选票独占穷尽判定；prepare-integration
  信任 code-complete，提交伞仓 milestone gitlink 并准备各仓集成 PR，不重扫工单。先整体审查和独立测试，
  再 publish-integration 发布子仓、伞仓最后；gitlink 保持受验 SHA，逐仓核验 merge tree 一致与包含关系。
  无差异仓记 no-change，不造空 PR；部分发布只补未完成仓，已合并不回 prepare。close-milestone 只统一关闭收尾。
  Actor/Judge 信任已验收上游，只检查本阶段动作；环境由 Manager 按需授权准备，不设必经环境节点或标签状态机。
  配置沿用已有 GitHub tracker，无须重新 setup；实际验收以冻结 YAML 为准。
  单仓完整流程见 [`coding-workflow-single.yaml`](coding-workflow-single.yaml)（2026-09-20.1，十节点、两级 merge commit）：
  选票独占穷尽判断并交接 completionSummary/pendingClosure，集成审查复用单票结果；两级合并只消费批准、
  执行当前合并及收尾，异常 BLOCK 交 Manager，不自行重审或重扫票务。配套合同为
  [coding-workflow-single-contract.md](../dsh-workflow/coding-workflow-single-contract.md)。
  新多仓配置尚未完成真实 GitHub 多仓交付、部署或 E2E 实测；AIChat 旧项目流程文档解耦见
  [优化提案](../dsh-workflow/aichatoverview-workflow-decoupling-proposal.md)，本次未改目标伞仓文件。
- **多仓单 Issue 快速模板**：[`coding-workflow-rapid-multi.yaml`](coding-workflow-rapid-multi.yaml)
  （2026-09-19.1）：initialize → implement → review → 按需 verify → merge，五节点、无子流程。
  一个伞仓 Issue 覆盖获准的小范围多仓改动，不管理 Milestone/子票/选票。实现阶段提交完整候选 gitlink，
  各任务 feature 直接 PR 到各仓基线；merge commit 先子仓后伞仓，保持受验 SHA，部分发布仅补遗漏。
  verify 按初始化 premergeRequired/postmergeRequired 在发布前后复用（无返工时零至两次），发布后必需验证通过才关票；
  发布后失败 BLOCK 保留事实，不回旧 PR。环境不支持同票跨仓的开发前置验证时，应拆阶段或改完整流程。
  见[使用说明](../dsh-workflow/coding-workflow-rapid-multi.md)。
  尚未完成真实多仓 GitHub 交付、部署或 E2E 实测。
- **完整 v3 组合示例**：[`docs/example/v3-combined-example.yaml`](v3-combined-example.yaml)
  ——覆盖三出口 Actor、单出口 Actor、同一 Child 的两个返回分别进入两个不同父后继、
  两层 Child 嵌套返回、Program 在 Child 内结束，以及 Root 的三个不同业务终局；
  想看 v3 合同的完整形状可从它入手（该文件是 v3 示例，不是生产配置）。
- 历史 v2 生产配置：
  [`docs/prd/20260903-workflow-hardening/milestone-delivery.yaml`](../prd/20260903-workflow-hardening/milestone-delivery.yaml)
  （v2 时代，**不可加载**，仅作历史参考）。
