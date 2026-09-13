# 工作流配置模板（docs/example/）

本目录存放 `agent-workflow/v2` 工作流的**可复制模板**。新建工作流时，把
`workflow-template.yaml` 复制到 catalog 目录后按需修改，不要从零手写。

## 使用方法

1. 复制模板：

   ```powershell
   Copy-Item docs/example/workflow-template.yaml "$env:USERPROFILE\.dsh\workflows\<workflow-id>.yaml"
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
  Worker 的覆盖在 actor 空闲时生效（删除旧映射，下次派发按新路由创建
  replacement），Judge 的覆盖只影响下一次 Judge 重建。
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
| `schemaVersion` | ✓ | 固定 `agent-workflow/v2` |
| `roles` | ✓ | worker Role 定义表；key 即 roleKey |
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

节点（`workflow.nodes.<nodeId>`）三种 execution：

| type | 必填字段 | 可选字段 | 说明 |
| --- | --- | --- | --- |
| `actor-task` | `role`、`instruction` | — | 派发给 Role（或 manager）执行，需配 `checker` |
| `builtin-program` | `programId` | `instruction`、`config` | 仅内置程序：`github.initialize-milestone`、`github.all-milestone-issues-complete` |
| `child-workflow` | `workflowId` | — | 引用 `childWorkflows` 中的子图，禁止递归/引用根 |

边与判定：

- `checker`：目前仅 `judge.claim-correct`，`config.criteria` 为 trim 后
  1..8000 字符，是 Judge 判定的权威标准。
- `onPass` 必填，指向节点 id 或 `END`；`onFail` 可选，可指向节点 id
  或 `END`（#17 起允许，FAIL→END 为业务终局：根 Run 状态沿用 `completed`
  表示执行结束，终局业务结果由终局 claim outcome + handoff 表达；终局通知
  按 PASS/FAIL 区分措辞，不把取消/失败报成“已完成”。子流程 FAIL→END
  pop 回父节点 `onPass`，对父读作 PASS，父只能经 handoff 文本感知失败）。
- FAIL 且未配置 `onFail` → 进入 BLOCK（Manager 处理后 resume 同一节点），
  这不是一种边。

静态校验（复制模板后常见报错）：

- id 语法（workflowId/roleKey/nodeId）：`[a-z][a-z0-9-]*`。
- 根 `startNode` 必须是 `role: manager` 的 `actor-task` 节点。
- 每个工作流的所有节点从 `startNode` 可达，且至少一条路径到 `END`。
- `actor-task` 引用的 role 必须在 `roles` 中定义（或为 `manager`）；
  `judge` 不能当 worker 用。
- YAML 限制：单文档、无 duplicate key、无 anchor/alias/merge key、
  无自定义 tag、无模板插值。

## 完整示例

真实生产配置见
[`docs/prd/20260903-workflow-hardening/milestone-delivery.yaml`](../prd/20260903-workflow-hardening/milestone-delivery.yaml)
（里程碑交付：plan → builtin-program → PRD → issues → child-workflow 循环
→ 终审 → close，覆盖全部三种节点类型与 onFail 修复回路）。
