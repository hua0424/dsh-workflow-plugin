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

## 配置面速查

顶层字段（strict schema，unknown 字段一律拒绝）：

| 字段 | 必填 | 内容 |
| --- | --- | --- |
| `schemaVersion` | ✓ | 固定 `agent-workflow/v2` |
| `roles` | ✓ | worker Role 定义表；key 即 roleKey |
| `judgeRole` | ✓ | Judge 定义（persona 必填，model 可选） |
| `workflow` | ✓ | 根工作流图 |
| `childWorkflows` | ✗ | 子工作流图（按 workflowId 引用） |

Role 定义：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `persona` | ✓ | 非空，trim 后存储 |
| `model` | ✗ | `{ provider, modelId }`，见上文 |
| `tools.deny` | ✗ | 非空列表；Judge 的工具面固定，不走此配置 |

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
