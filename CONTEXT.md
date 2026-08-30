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

## Workflow Ledger

由 Host 维护的 Parent/Child 工作流持久化事实与审计记录，包括当前状态、revision、transition history、evidence reference、Role Actor mapping 和待协调的外部 effect。它是工作流状态的权威本地记录，但不是 GitHub、Git remote、provider 或测试环境等外部事实的替代品。

## Parent Revision

一个 Parent 一致性聚合的单调提交序号。该 Parent 下所有 Child、Gate、evidence、Role Actor mapping 和 delivery 状态 mutation 共用同一 revision；调用方必须基于明确的预期 revision 发起 mutation，过期请求不能自动套用到新状态。不同 Parent 的 revision 相互独立。

## Canonical Parent State

固定 Workflow Definition 为 Parent 定义的唯一当前状态值。Active、Terminal、Recovery 和 Delivery Partial 等分类从该状态及明确关系推导，不保存可能互相矛盾的状态布尔列；Host readiness、main session mode、Task/Child/Effect state 属于其他状态域。

## Workflow Event

对一次已提交 Workflow mutation 的不可修改审计记录，与对应当前状态和 Parent Revision 在同一原子提交中产生。Workflow Event 用于解释历史和关联 evidence、Actor 与外部 effect，但首期不是可脱离当前状态独立重建整个 Workflow Ledger 的唯一事实源。记录在所属 Parent 保留期间不可改写；Parent 终态满 30 天后的整聚合 purge 会删除全部 Event 且不留 Tombstone。

## Effect Intent

Host 在执行外部 effect 前原子记录的不可变执行意图，绑定目标 Parent、触发 revision、effect 类型、已解析目标和确定参数。Effect Intent 提交后 Workflow 仅表示该操作待执行或待确认；只有外部结果经验证并再次提交 Ledger 后，才能进入 Workflow Definition 规定的后继状态。

## Command ID

由可信调用边界为一次 Workflow 命令派生的稳定幂等身份。它用于识别同一调用的重入或重复交付，不来自 Agent 可自由填写的参数，也不替代 Actor authorization、Parent Revision 或 Workflow 状态校验。

## Command Receipt

一次成功 Workflow mutation 的不可变幂等回执，绑定 Command ID、规范化请求语义、提交后的 Parent Revision、Workflow Event 及可选 Effect Intent。相同命令重入时返回原提交结果而不再次产生状态变化；同一 Command ID 对应不同请求语义时必须失败关闭。该保证只在所属 Parent 保留期间成立；Parent 终态满 30 天后 Receipt 随整聚合删除。

## Command Attempt

Host 对一次被拒 Workflow 命令形成的独立安全审计事实。它只在 caller 与目标 Parent 可从可信上下文确定时记录结构化 denial，不产生 Command Receipt 或 Workflow Event，也不推进 Parent Revision。

## Effect ID

Host 为一个逻辑 Effect Intent 分配的不可变幂等身份。该 effect 的执行、结果未知、对账和受控重试始终共用同一个 Effect ID；首期不为每次执行尝试创建独立 Attempt 身份，只在 effect 上保留安全恢复所需的最小执行元数据。

## Active Parent

尚未进入 `completed` 或 `abandoned` 终态的 Parent。正常推进、Workflow Recovery、Delivery Partial、等待修复和存在未决 Effect Intent 的 Parent 都仍是 Active Parent；首期一个 Product Workspace 在同一正常 Ledger Generation 中最多存在一个 Active Parent。SQLite schema 不兼容时经直接人类确认的 Ledger Generation Reset 可以结束整个旧 generation，但不会把其中的 Active Parent 伪造为终态。

## Durable Lease

Host 为跨事务、跨进程的长时间工作或独占资源记录的持久执行所有权。首期 lease 不使用时间 TTL；它在 owner 正常释放、固定取消流程确认停止，或所属 Host Boot 终结后被恢复流程判为 orphaned 时失效。它用于防止旧 worker 与新 owner 同时操作，但不替代 Parent Revision、Actor authorization、Workflow 状态校验或外部事实 preflight。

## Workflow Task

由固定 Workflow Definition 根据 Parent/Child 当前状态创建的持久化必需工作单元，绑定明确的 task type、scope、授权 Actor/Host executor 和完成条件。它不是通用任务池或 Agent 自行创建的 assignment；首期长时间 Task 执行通过固定 `task-execution` lease 取得单一 owner。

## Fencing Token

某个 Durable Lease key 每次成功获取执行世代时严格递增的不可复用序号。Host 用当前 owner 与 token 共同拒绝已经释放、orphaned 或被 takeover 的旧 worker、旧 Actor turn 和延迟消息；token 不由 Agent 参数提供。

## Host Boot Epoch

一次 Host 进程启动形成的不可复用运行世代，由持久化 `hostBootId` 标识。首期 Durable Lease 绑定获得它的 Host Boot Epoch；新 Host 冷启动将旧 boot 中未释放的 lease 标记为 orphaned，再按 Task/Effect 恢复规则决定是否以更大 Fencing Token 接管。

## Lease Audit

对 Durable Lease acquire、release、orphan 和 takeover 的不可修改运维审计记录，与 lease current record 在同一运维事务提交。Lease Audit 不属于 Parent 领域事件序列，因此不推进 Parent Revision，也不产生 Workflow Event 或 Command Receipt。

## Workspace Storage Identity

Host 根据 Workspace Root 的 canonical real path 计算的本地持久化范围身份。它使同一 checkout 跨 DSH profile 共享一个 Workflow Ledger，同时把不同 clone 视为不同 Product Workspace；checkout 路径变化不会自动迁移旧 Ledger。

## Ledger Generation

一个 Product Workspace 在某一精确 SQLite schema 下连续使用的一代 Workflow Ledger。正常情况下 Active Parent 必须进入终态后才能启动新 Parent；SQLite schema 不兼容时，直接人类可以选择归档整个旧 generation 并创建空的新 generation。该重置不迁移旧状态、不伪造旧 Parent 终态，也不处理旧本地或远端产物。

## Effect Catalog

固定 Workflow Definition/Host 支持的外部 effect type 闭集。每种类型必须预先定义 intent schema、实时 preflight、远端幂等或 reconciliation identity、已发生/未发生判据和未知结果处理；Policy 与 Agent 不能新增 effect type 或改变其恢复契约。

## Evidence Observation

Host 对某一确定 subject fingerprint 在特定时点完成验证后产生的不可变证据事实，绑定 Gate scope、remote/reference、SHA 或 candidate manifest、verdict、collector 和验证契约版本。所属 Parent 保留期间，重新验证产生新的 observation 且旧记录不被覆盖；Parent 终态满 30 天后 observations 随整聚合删除。当前 Gate 是否满足由独立 projection 表达。

## Evidence Artifact

Evidence Observation 可选引用的不可变本地内容对象，用于保存无法合理内联到 Ledger 的受控报告或诊断材料。Artifact 按最终字节 SHA-256 存入 Workspace 私有 content-addressed store；Ledger 只保存 digest、类型、大小和生产契约，不保存 blob 或任意本地路径。

## Parent Retention Window

Parent 从提交 `completed` 或 `abandoned` 终态起固定保留 30 天的期限。期限内 Parent-owned Event、Receipt、Evidence、Actor mapping、Task、Effect 和 Audit 保持既定不可变历史；到期后 Host 从 current Ledger 与 current rotating backups 物理删除整个 Parent 聚合，不留 Tombstone，也不处理任何外部资源。已存在的永久 generation/incident archive 不重写。
