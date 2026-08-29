# Domain Glossary

## Workflow Policy Profile

对固定 Workflow Definition 开放的受限声明式配置。它只能为引擎预先定义的配置槽位提供值，不能创建状态、transition、Gate 或新的工作流语义。

首期文档中出现的“Workflow policy DSL”均指 Workflow Policy Profile，而不是可编程的通用状态机语言。

## Engine Invariant

无论 Workflow Policy Profile 如何配置都必须成立的工作流规则，例如固定的 Parent/Child 结构、状态转换、Gate 顺序、读写屏障、角色职责边界以及 evidence 与候选 SHA 的绑定关系。

## Workflow Definition

由引擎实现的一套完整 Parent/Child 状态机、Gate、失败回路和恢复路由。首期只提供一个固定的功能交付 Workflow Definition；当未来出现其他真实工作流后，再基于实际差异讨论 Definition 抽象。

## Policy Parameter

Workflow Policy Profile 中由引擎明确开放的配置槽位。Policy Parameter 可以描述执行环境或选择引擎已知的执行方式，但不能关闭 Gate、改变状态转换、接受失败结果或降低 Engine Invariant 的保障强度。

## Effective Policy

某个 Parent 在当前 Manager Turn 从唯一固定 Policy Location 加载、完整解析并接受的 Workflow Policy Profile。首期不存在 Registry、选择、继承、overlay、仓库局部覆盖或启动参数覆盖。Parent 不保存完整不可变 Policy snapshot；每个 Manager Turn 重新加载，并根据连续性投影区分可热重载变化与不兼容变化。

## Policy Continuity Projection

Policy 中会影响 schema 语义、baseline/remote、权威 PRD、Repository Catalog、交付顺序、分支身份或强制验证的字段集合。该投影变化后，既有 Parent 不能继续，进入 Abandoned。

## Reloadable Policy Field

可以在 Manager Turn 边界重新加载且不重新解释既有状态或 Gate evidence 的 Policy 字段。首期仅包括固定 Role Agent 的 subagentProvider/model/persona/tools.deny，以及 ownership.managerOwned 文件和目录规则。Role definition reload 接受前必须确认旧 Actor 无运行 turn，并通过所需定向 preflight；随后原子推进 accepted hashes，将旧 mapping 标记 stale 并禁止继续派发。Replacement 失败时不回滚新 Policy 或恢复旧 Actor，Parent 进入 Workflow Recovery。

## Abandoned Parent

因 Policy Continuity Projection 变化或 Workflow Definition 不兼容而不可继续的 Parent 终态。仅注释/格式等源表示变化或 Reloadable Policy Field 变化不使 Parent abandoned。Abandoned Parent 不等于完成或可恢复暂停；Host 只记录原因、提示用户并停止推进，不自动处理其本地或远端产物。

## Manager Turn

主会话 Manager 响应一次用户输入并编排当前 Workflow 的执行轮次。首期在每个 Manager Turn 开始时完整加载、校验并分类 Policy 变化；该轮派发的 Role Actor 工作不再独立加载。

## Policy Source Document

管理员编写并由 Host 加载的 Workflow Policy Profile 源文件。首期只接受受限 YAML 1.2；它是纯声明式数据，不支持 anchor、alias、merge、自定义 tag、多文档、模板或脚本执行。

## Strict Policy Schema

对 Policy Source Document 采取失败关闭的结构契约。未知字段、错误类型、未知枚举、无效引用或缺失的关键字段都会阻止 Workflow 启动；Host 不通过忽略字段或类型转换猜测管理员意图。

## Static Policy Validation

只根据 Policy 数据、schema 和 Workflow Definition 判断配置是否合法的确定性校验，不读取 GitHub、provider、仓库或其他外部环境。

## Environment Preflight

在产生对应外部 effect 前，对 credential、provider、repository、branch、ruleset、远端 SHA 等当前环境事实进行的阶段性检查。Parent 创建前失败只拒绝启动；创建后的可修复环境失败进入 Workflow Recovery，而不是 Abandoned。Reloadable Role Agent definition 变化还需对受影响 provider/model/tool-filter capability 执行定向 preflight。

## Product Workspace

由一个伞仓和一个固定代码仓库 Catalog 共同构成的产品交付范围。首期一个 Workflow Policy Profile 只描述一个 Product Workspace。

## Repository Catalog

Product Workspace 中由稳定 repositoryKey 标识的允许仓库集合。Parent 只能从 Catalog 选择本次受影响的代码仓库子集，不能在运行时加入任意仓库。首期 Catalog 中的代码仓库都必须来自伞仓 `.gitmodules`。

## Workspace Root

启动 Workflow 的 Manager session 的绝对工作目录。首期 Host 将它作为伞仓候选根目录并执行环境预检，不在 Policy 中重复配置本地 checkoutPath。

## Resolved Repository Identity

Host 根据伞仓、`.gitmodules` 和 checkout 的 Git remote 解析并验证出的具体 GitHub 仓库身份。它是 Parent 的运行时事实，不由 Agent 参数或 Policy 中重复填写的 owner/repository 决定。

## Catalog Repository

由 Policy 明确列入 Repository Catalog、允许 Parent 选择和交付的代码仓库。`.gitmodules` 中未被 Policy 列出的 submodule 不是 Catalog Repository，不能自动获得 Workflow 操作范围。首期 repositoryKey 必须等于 `.gitmodules` 的 submodule name。

## Baseline Branch

Product Workspace 中伞仓和全部 Catalog Repository 共同使用的目标基线分支。首期由 Policy 在 workspace 级显式声明，不允许每仓覆盖。

## Branch Prefix

Policy 为某类引擎分支声明的固定名称前缀。首期 Policy 只能配置 prefix，稳定 ID 和后缀格式由引擎生成，不提供任意 branch template。

## Manager-owned Path

Policy 明确允许 Manager 修改的伞仓非代码文件或目录范围。首期目录规则是精确前缀；文件规则只支持最终文件名 segment 中非递归的 `*`。该范围可以在 Manager Turn 边界热重载；固定拒绝目标和 Catalog 代码仓永远不因该规则获得 Manager 写权限。

## Fixed Workflow Role

首期由引擎固定职责和 Gate 映射的 Role Agent key，包括 prd-reviewer、developer、code-reviewer 和 tester。Policy 只能配置它们的运行定义，不能增删角色或重新分配职责。

## Role Agent Definition

Policy 中为一个 Fixed Workflow Role 内联声明的 continuable child 运行配置，包括 subagentProvider、LLM model route、persona 和可选 per-role tool deny-list。它不是运行时身份；创建后产生的 durable agent.id 才是当前 Parent 的 Role Actor。Definition 可以热重载，但既有 continuable child 不能原地修改，必须以新的 agent.id 替换。

## Role Tool Deny-list

Role Agent Definition 中可选的 DSH child toolFilter 配置，只从该 Role Actor 继承的 Manager 工具集合中移除指定工具，不限制 Manager，也不构成新的 Policy 权限层。

## Role Model Route

Role Actor 创建时解析并固定的 LLM provider、model 和 maxTokens。来源可以是 Policy 中的显式配置，也可以继承 Manager 当前路由；继承型路由在 Manager 切换模型后通过创建新的 Role Actor 生效，而不是修改既有 agent.id。

## Validation Definition

Policy 中直接归属于一个 Catalog Repository 或 Product Workspace 的强制验证配置。首期不通过可复用 Profile ID 间接引用：每仓唯一 unit test definition，工作区唯一 integration test definition。

## Policy Diagnostic

Static Policy Validation 或 Environment Preflight 产生的结构化问题记录，包含稳定 code、phase、配置 path 和管理员可读 message。Validator 汇总相互独立的问题但不自动修改 Policy。

## Policy Location

首期固定为 Product Workspace 根目录下的 `.dsh/workflow-policy.yaml`。它不通过搜索、环境变量、启动参数或 Agent 参数定位。

## Policy Schema Version

Policy Source Document 所遵循的精确结构契约版本。首期唯一值是 `workflow-policy/v1`；Host 不进行别名解析、版本范围协商或自动迁移。

## Validated Policy

某个 Manager Turn 开始时，对当前 Policy Source Document 完成源 hash、受限 YAML、Strict Schema、Static Policy Validation 和语义投影分类后得到的本轮有效配置对象。它只在该 Manager Turn 内复用，不跨 turn 缓存。

## Workflow Artifact Directory

Policy 配置的伞仓相对目录，自动属于 Manager-owned 范围。首期只有其中固定位置的 `prd.md` 是权威 Workflow 文档；其他辅助文档由 Manager 按需创建，GitHub 和 ledger 事实不生成 Markdown 镜像。

## Host GitHub Credential

Host 当前用于 GitHub adapter 的默认运行时凭据。首期它不由 Policy 选择，也不进入 Policy hash；Environment Preflight 验证其当前可用性和阶段所需权限。
