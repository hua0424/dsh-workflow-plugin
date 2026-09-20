# modelId 与思考强度的本地列表静态阻断

> 修订状态：本 ADR 以 #149 修订为准。本地草稿中“reasoning 缺失跳过”“空 efforts 表示不支持”“不传即默认”三条旧规则已被取代，下文为修订后语义；实施分票：T1（#150）字段/派发/默认与继承/状态兼容，T2（#151）modelId 本地列表校验，T3（#152）档位矩阵与命令验收，T4（#153）set 清空。

Catalog 角色模型路由新增可选思考强度（`model.reasoningEffort`）后，静态校验扩展为三维度：provider 已注册、modelId 在该 provider 的本地模型列表内、思考强度在该模型的档位列表内。宿主 `listModels` 契约明确是 advisory（"consumers must not turn absence into request rejection"，deepseek 适配器对未列出 id 也 pass-through），本插件仍决定：**unlisted modelId 阻断，`listModels` 返回空列表同样阻断**。

理由：pi-ai 路由对未配置模型运行时直接抛 `UNKNOWN_MODEL`，静态阻断只是把必然失败提前到 start 之前；deepseek 的 pass-through 放宽（新模型无需注册即可请求）与“工作流 catalog 是长期冻结配置、笔误应在 start 前拦下”的立场冲突，属有意取舍。

配置、默认与继承（T1）：

- 配置位置为 `roles.<role>.model.reasoningEffort` / `judgeRole.model.reasoningEffort`，与 provider/modelId 同级；不支持只填档位而不提供模型路由。档位 id 是适配器自有 opaque 字符串，schema 只做 trim/非空/长度约束，不 hardcode 档位枚举。
- 显式 model + 显式档位：实际请求采用该值。
- 显式 model + 省略档位：主动回落模型默认（宿主使用 `reasoning.defaultEffort`，未声明则保留 provider 默认），不继承 Manager 的显式档位。宿主对同路由子会话保留父档位，故“省略键”不等于“恢复默认”——插件在派发边界显式清除继承值（复用宿主展开语义，零宿主改动），并验证有效请求而非 options 缺键。
- 完全未配置 model：保留既有 Manager 路由继承行为（含冻结档位）。
- 旧快照兼容 = 可读取、可继续、无需迁移：不向旧定义补默认档位，不重写旧定义 hash，state 格式版本不变；不为升级主动重建存量会话。

边界语义（T2/T3 按 #149 矩阵交付）：

- 校验顺序：先 provider 注册（同步），再本地列表包含（unlisted/空列表在此拦截），最后才 resolve 档位——走到 resolve 时 modelId 已在列表内，此时抛错才是真故障。
- 成功解析但缺少 reasoning 元数据的模型，若显式配置档位则提前阻断（宿主对此类请求必然抛 `UNSUPPORTED_REASONING_EFFORT`）；未配置档位则无需档位检查。
- `reasoning.efforts=[]` 在基线宿主中属于非法元数据（抛 `INVALID_MODEL_REASONING`），不是“明确不支持思考”的正常返回，按元数据查询异常处理（fail-open 跳过并注明，不把空数组当不支持）。
- `listModels` 抛错/拒绝或 `resolveModelInfo` 抛错/拒绝时 fail-open：仅跳过该故障维度并明确注明，其他角色的确定误配仍须报告并阻断 start。“允许尝试启动”不等于证明模型可运行。
- 三维度共用同一报告与阻断通道：`/dsh-flow check` 逐角色只报告（含跳过原因，不把未验证伪装成通过），`start` 对确定误配前置拒绝且不创建 Run。

## 后果

- 未在本地注册的 DeepSeek 新模型 id 实际能请求，但会被 `start` 拒绝——用户需先在 settings 声明。
- 未实现 `listModels` 的第三方适配器（基线返回空）整个 provider 视为不可用。
- 显式 model 省略档位的新建/重建派发不再意外继承 Manager 档位（过去可运行的同路由配置行为变化，属有意修正）。
- 运行期 `workflow_set_role_model` 更换模型时清空原思考强度，回落新模型默认档位（先保证能运行，T4）。
