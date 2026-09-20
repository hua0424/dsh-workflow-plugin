# modelId 与思考强度的本地列表静态阻断

Catalog 角色模型路由新增可选思考强度（`model.reasoningEffort`）后，静态校验扩展为三维度：provider 已注册、modelId 在该 provider 的本地模型列表内、思考强度在该模型的档位列表内。宿主 `listModels` 契约明确是 advisory（"consumers must not turn absence into request rejection"，deepseek 适配器对未列出 id 也 pass-through），本插件仍决定：**unlisted modelId 阻断，`listModels` 返回空列表同样阻断**。

理由：pi-ai 路由对未配置模型运行时直接抛 `UNKNOWN_MODEL`，静态阻断只是把必然失败提前到 start 之前；deepseek 的 pass-through 放宽（新模型无需注册即可请求）与"工作流 catalog 是长期冻结配置、笔误应在 start 前拦下"的立场冲突，属有意取舍。

边界语义：

- 思考强度档位来自 `resolveModelInfo().reasoning.efforts`（适配器本地声明）；模型明确不支持思考（efforts 为空）而配置了值 = 误配阻断；适配器未暴露 reasoning 元数据（`reasoning === undefined`）= 跳过并注明；resolve 意外抛错 = fail-open 跳过并注明。
- 校验顺序消解 UNKNOWN_MODEL 与 fail-open 的表面矛盾：先 provider 注册（同步）、再本地列表包含（unlisted/空列表在此拦截）、最后才 resolve 档位——走到 resolve 时 modelId 已在列表内，此时抛错才是真故障。
- 三维度共用同一报告与阻断通道：`/dsh-flow check` 逐角色只报告，`start` 前置阻断（与 provider 校验 Issue #41 语义同构）。

## 后果

- 未在本地注册的 DeepSeek 新模型 id 实际能请求，但会被 `start` 拒绝——用户需先在 settings 声明。
- 未实现 `listModels` 的第三方适配器（基线返回空）整个 provider 视为不可用。
- 运行期 `workflow_set_role_model` 更换模型时清空原思考强度，回落新模型默认档位（先保证能运行）。
