# Workflow Policy Profile 与静态校验设计

- 状态：已确认（Policy v1 骨架、静态校验与热重载边界）
- 日期：2026-08-18
- 主题：固定 Workflow Definition 上的受限声明式配置、静态校验与受控热重载
- 关联设计：`docs/design/parent-child-workflow-instances.md`、`docs/design/trusted-actor-role-binding.md`

## 1. 背景

父子工作流实例设计已经冻结 Parent/Child 职责、严格串行、读写屏障、三层 Review Gate、SHA-bound evidence、候选失效、修复回路和多仓库最终交付语义。

Trusted Actor 设计已经冻结主会话 Manager、持续 Role Actor、`(parentId, roleKey) → agent.id` 映射以及 Role Agent 直接提交权威 evidence 的规则。

后续配置必须建立在这些已确认语义之上，而不能通过另一套可编程状态机或隐藏授权规则绕过它们。

## 2. 术语

### 2.1 Workflow Policy Profile

对固定 Workflow Definition 开放的受限声明式配置。它只能为引擎预先定义的配置槽位提供值，不能创造新的工作流语义。

本文继续保留“policy”简称，但首期的“Workflow policy DSL”不表示通用编程语言或通用状态机 DSL。

### 2.2 Workflow Definition

由引擎实现的一套完整 Parent/Child 状态机、Gate、失败回路和恢复路由。

### 2.3 Engine Invariant

无论 Policy Profile 如何配置都必须成立的规则。Policy 不能关闭、替换或绕过 Engine Invariant。

## 3. 已确认决策

### 3.1 首期不允许 Policy 定义状态和 transition

首期只实现一个固定的功能交付 Workflow Definition：

- Parent/Child 状态机由引擎固定；
- Gate 的存在、先后关系和失效语义由引擎固定；
- FAIL 后的开发、remediation、conflict-resolution 和 recovery 路由由引擎固定；
- Policy 不能新增、删除、改名或重排状态和 transition；
- Policy 不能通过表达式、脚本或 hook 自行决定状态推进；
- Policy 只能配置引擎明确开放的安全参数。

选择该方案的原因：

1. 当前只有一个经过确认的功能交付工作流，没有足够的真实差异支持通用抽象；
2. 通用状态机 DSL 会显著增加静态分析、恢复、授权、迁移和 UI 的复杂度；
3. 已确认的 Gate、SHA 和角色边界不能被配置绕过；
4. 首期优先保证确定性、可解释性和失败关闭。

未来出现其他真实 Workflow Definition 后，再依据实际共同点和差异讨论抽象，不在首期预建通用状态机层。

### 3.2 Policy 不能降低固定保障强度

首期 Policy 只能配置运行环境和引擎明确开放的参数，不能关闭、跳过、重排或弱化固定保障。

以下内容属于 Engine Invariant：

- PRD Review、Child Code Review、正式单元测试、Milestone Aggregate Code Review 和集成测试均不可由 Policy 关闭；
- Gate 顺序不可配置；
- evidence 必须绑定当前 SHA 或 release candidate manifest；
- 候选或基线变化后，相关旧 evidence 按固定规则失效；
- Child 严格串行，强制读/验证阶段与写阶段互斥；
- Manager 不得修改业务代码；
- 最终交付必须执行固定的全量预检、顺序合并和远端验证；
- 不存在 Policy 级 `skip`、`forcePass`、`ignoreFailure` 或 Manager 任意 override；
- Host 在运行时继续校验这些不变量，不能只依赖 Policy 已通过静态校验。

首期 Policy 可以配置的方向限于：

- 仓库清单和交付顺序；
- 各类引擎分支的安全 prefix；
- Manager-owned 非代码路径；
- Role Agent 运行 definition；
- 仓库和工作区内联的测试或验证 definition；
- provider、model、persona 和 tool filter 等运行参数。

这里确认的是：Policy 可以改变“在哪里执行、使用哪个预定义运行方式”，并配置固定角色的运行参数；不能改变“由哪个角色负责”或“哪些保障必须成立”。

### 3.3 首期不开放 optional Child

- 所有新建 Child 默认且固定参与完成条件，不允许 Policy 将其声明为 optional；
- Policy 不能把 `failed`、`blocked` 或其他失败状态配置为可接受完成状态；
- 确实不再需要且尚未开始开发的 Child，只能通过引擎定义的显式取消 transition 处理；
- 取消必须记录原因并保留历史，不能删除 Child；
- 显式取消是固定领域行为，不是 Policy 可扩展的“可接受终态”列表。

这收紧了父子实例设计中为 `required/optional` 和可接受终态预留的配置空间。首期不实现该扩展点。

### 3.4 每个 Manager Turn 只加载固定路径的唯一 Policy Source Document

首期采用单一完整配置，不支持配置选择、继承或多层覆盖。Parent 不保存完整 snapshot，而是在每个 Manager Turn 重新加载并分类同一个固定路径源文件：

- 不存在 Policy Registry 或 profile selector；
- 不支持 `extends`、overlay、仓库局部覆盖或 Parent 启动参数 override；
- 缺省字段只能使用当前 schema 明确定义的固定默认值；
- 仓库、分支、ownership、team 和 validation 参数必须在同一个有效配置中完整解析；
- PRD 后选择本次受影响仓库属于 Parent 实例事实，不是 Policy override；
- Milestone、Issue、branch 和 SHA 等运行时事实不写回 Policy；
- GitHub credential 和密钥材料不属于 Policy，首期使用 Host 当前默认 credential。

首期以单个根配置文档作为输入。未来可以增加不带覆盖语义的多文件引用，但必须先完全展开并校验为一个规范化的完整 Policy Profile，运行时不直接解释多层配置。

只有出现其他真实 Workflow Definition 或明确的跨项目复用需求后，才重新评估继承和 overlay，不在首期预建合并规则。

### 3.5 Policy 变化按连续性影响分类

首期不保存完整不可变 Policy snapshot，但也不再把任意源文件字节变化直接等同于 Parent 废弃。Host 同时记录原始文件 hash 和若干规范化语义投影 hash，用于区分可热重载变化与破坏流程连续性的变化。

Parent 启动时：

1. 读取单一 Policy Source Document 的原始字节并计算 `policySourceHash`；
2. 解析受限 YAML，执行 Strict Schema 和 Static Policy Validation；
3. 应用 schema 固定默认值，生成规范化有效配置；
4. 计算并记录 `policyContinuityHash`、每个 `roleDefinitionHash[roleKey]` 和 `managerOwnershipHash`；
5. 记录 `schemaVersion` 和 Host 当前 `workflowDefinitionVersion`；
6. 使用该 Validated Policy 启动 Parent。

规范化 hash 使用确定性 JSON 投影：object key 稳定排序、schema 默认值显式物化；deliveryOrder 等有序 array 保留顺序，tools.deny 与 ownership paths 等集合语义 array 先排序；再计算 SHA-256。`policyContinuityHash` 明确排除 reloadable 白名单字段，这些字段分别进入 roleDefinitionHash 或 managerOwnershipHash。

后续每个 Manager Turn 开始时完整加载并校验当前 Policy。active Parent 场景在 YAML 成功解析后先检查根 `schemaVersion`：如果它是显式字符串且与 Parent 已记录值不同，即使新值不受当前 Host 支持，也视为已证明的 continuity 变化并立即进入 `abandoned(cause=policy-incompatible-change)`；如果字段缺失、类型错误或 YAML 本身无法解析，则无法可靠确认新的 schema 契约，按非法新配置进入 `workflow-recovery`。

其余分类规则为：

- 原始 hash 和所有语义 hash 都相同：正常继续；
- 只有注释、空白、object key 顺序等源表示变化：接受新 `policySourceHash`，不改变运行语义；deliveryOrder 等有序 array 重排仍是语义变化；
- `policyContinuityHash` 相同，但 reloadable 投影变化：先执行受影响字段的定向 Environment Preflight；成功后接受热重载并记录 `policy-reloaded` 事件，失败则不采用新配置并进入 `workflow-recovery`；
- `policyContinuityHash` 不同：Parent 进入不可恢复的 `abandoned(cause=policy-incompatible-change)`；
- 新文件无法读取、解析或通过静态校验：不采用新配置，fail closed 并进入 `workflow-recovery`；
- 当前 Host 与已记录的 `workflowDefinitionVersion` 不兼容：进入 `abandoned(cause=workflow-definition-incompatible)`。

首期明确允许热重载的字段白名单只有：

```text
team.<role>.subagentProvider
team.<role>.model
team.<role>.persona
team.<role>.tools.deny
ownership.managerOwned.files
ownership.managerOwned.directories
```

成功接受热重载是一次原子 ledger transition：

1. 确认所有受影响旧 Role Actor 都没有运行中的 turn；否则不接受新 hashes，进入 `workflow-recovery`；
2. 对变更的 subagentProvider/model/tool filter 执行定向 Environment Preflight；失败时不接受新 hashes，进入 `workflow-recovery`；
3. 在同一事务中更新已接受的 `policySourceHash`、全部语义投影 hash，更新当前 Manager-owned authorization，标记受影响 Role Actor mapping 为 `stale-policy-reload`，并追加 `policy-reloaded` 事件；
4. 从该事务提交后开始，旧 stale mapping 禁止接受新任务；其他未受影响角色可以继续；
5. 下一次派发受影响角色前创建 replacement Role Actor。创建失败时保留已经接受的新 Policy 和 stale mapping，Parent 进入 `workflow-recovery`，不能回退使用旧 Actor。

纯 source 表示变化也在一次 ledger transition 中推进已接受的 `policySourceHash` 并记录 source reload；语义投影 hash 不变，不创建 replacement。这样后续 Manager Turn 不会重复处理同一版本。

Role Agent definition 变化通过 `roleDefinitionHash` 检测。DSH continuable child 不能原地修改 provider/model/persona/tool filter，因此 reload transaction 先把无运行中 turn 的旧 Role Actor mapping 标记为 stale；下一次派发前再转为历史，并按新 definition 创建新的 agent.id。旧 session、mapping 和 evidence 保留；既有 evidence 仍只按 Gate scope、状态和 SHA/manifest 判断有效性。

Manager-owned 规则变化通过 `managerOwnershipHash` 检测，从当前 Manager Turn 起用于后续 Manager 写操作；它不重新解释过去的 commit 或 evidence。这里不新增通用 per-role writable paths，reloadable 文件范围只指现有 `ownership.managerOwned`。固定拒绝目标始终优先，不能通过热重载开放。

以下字段全部属于 continuity projection，任何变化都会废弃当前 Parent：

```text
schemaVersion
workspace.*
artifacts.*
repositories.*
branches.*
validation.*
```

它们分别影响 schema 语义、baseline/remote、权威 PRD、仓库范围和交付顺序、分支身份或强制 Gate 验证。未来新增字段默认属于 continuity projection，只有新的 schema 契约明确列入 reloadable 白名单后才能热重载。

进入 `abandoned` 后，Host 只记录终态、原因和检测到的 hash，提示用户并停止推进，拒绝该 Parent 后续 mutation/evidence。Host 不自动提交、回滚、清理、关闭、删除、重置或恢复任何本地与远端产物。下一次启动创建全新 Parent，从当前远端 baseline branch 开始，不复用旧 Child、Gate evidence、Role Actor 或 Milestone version line。

Role Actor turn 不独立加载 Policy，内部 worker 也不在同一 Manager Turn 内重复检查。管理员只能在 Manager Turn 之间修改 Policy，并且必须先停止 Agent loop、Role Actor turn 和内部 background work，确认该轮派发的执行已经全部结束。首期不处理“本轮检查后又修改配置”的竞态；违反该操作约定的结果不属于保证范围。

### 3.6 不使用人工 revision 替代内容 hash

人工维护的 revision 可能在修改文件后忘记递增，因此首期不配置人工 revision 或 policyId。`policySourceHash` 负责检测源文件字节变化，规范化语义投影 hash 负责判断该变化能否热重载；两者不能互相替代。

### 3.7 首期使用受限 YAML 1.2

Policy Source Document 首期只接受 YAML 1.2。YAML 只作为人类编写的声明式数据格式，不提供程序执行或复用机制。

解析器必须拒绝：

- 重复 key；
- anchor 和 alias；
- `<<` merge key；
- 自定义 tag；
- 多文档输入；
- YAML 1.1 风格的 `yes/no/on/off` 隐式布尔值；
- 环境变量表达式、模板表达式和脚本；
- 任意对象反序列化。

解析结果只能由 object、array、string、number、boolean 和 null 组成，并在解析后继续接受严格 schema 与语义校验。禁止的 YAML 特性直接产生配置错误，不自动展开或容错。

首期不同时支持 JSON、JavaScript 或 TypeScript 配置，避免形成多套输入语义。未来若增加其他输入格式，也必须先转换成同一个受校验的纯数据模型。

### 3.8 Schema 严格校验并失败关闭

首期 Schema 采用严格模式：

- `schemaVersion` 必填；
- 未知字段一律报错；
- 不进行字符串、数字、布尔值之间的隐式类型转换；
- `null` 不等同于字段缺失；
- 未知枚举值报错；
- 非空数组、元素唯一性和顺序要求由 schema 明确声明；
- 所有引用必须指向同一完整 Policy Profile 中已定义且类型匹配的对象；
- 校验器应尽可能一次汇总多个相互独立的错误；
- 任一 schema 错误都阻止 Workflow 启动。

默认值只允许用于没有安全歧义的少量字段。仓库、基线分支、交付顺序、Role Agent persona 和 validation definition 等关键内容必须显式声明；额外 Manager-owned 路径未声明时固定为空集合。

同一个 `schemaVersion` 下的字段语义和默认值不能静默变化。此类变化必须升级 `schemaVersion` 或 `workflowDefinitionVersion`，避免配置文件 hash 不变但执行语义发生变化。

首期不提供“忽略未知字段”“类型自动转换”或“只警告后继续启动”的兼容模式。

### 3.9 纯静态校验与分阶段环境预检分离

Host 先从固定路径读取 Policy Source Document；Static Policy Validation 对已读取的 source/AST 执行确定性校验。除读取这一个源文件外，它不查询其他文件系统事实、GitHub、provider、模型或仓库。相同 Policy 数据、schema 版本和 Workflow Definition 必须得到相同结果。

静态校验至少负责：

- 受限 YAML 和 Strict Schema；
- key、ID 和有序集合的唯一性；
- role、repository 等内部引用完整性；
- branch prefix 和 Manager-owned path 规则是否合法；
- 跨字段组合约束；
- 配置没有试图关闭、重排或绕过 Engine Invariant。

Environment Preflight 负责依赖当前外部事实的检查，不把网络或环境故障伪装成 Policy schema 错误。首期有三个 Workflow 生命周期阶段，以及一个由 Policy reload 触发的定向阶段：

1. **Parent 启动前**：检查伞仓、Host 默认 GitHub credential、四个 Role Agent 的有效 subagent provider/LLM route 及所需能力，以及启动资源命名冲突；失败时不创建 Parent，也不产生远端 effect。
2. **PRD PASS 并确定受影响仓库后**：只检查本次实际涉及的代码仓、baseline branch、权限、ruleset、Milestone branch 冲突和需要的 validation 环境；未涉及仓库不可用不阻止当前 Parent。
3. **最终交付前**：重新检查当前远端 SHA、PR、required checks、mergeability、ruleset 和权限；沿用父子实例设计中的全量最终预检。
4. **Reloadable Role Agent definition 变化时**：只对受影响角色的新 subagentProvider、LLM route 和 tool-filter capability 执行定向 preflight；通过后才能原子接受 reload。该事件驱动检查不取代上述三个 Workflow 生命周期阶段。

共同原则是：能只靠 Policy 判断的问题必须在启动前静态发现；依赖外部事实的问题必须在首次产生对应 effect 前完成预检。具体 adapter 检查项和错误码在各专项设计中细化。

### 3.10 一个 Policy 对应一个产品工作区和固定仓库 Catalog

首期一个完整 Policy Profile 只描述一个产品工作区：

- 恰好一个伞仓；
- 一个由稳定 `repositoryKey` 标识的代码仓库 catalog；
- Product Workspace 显式声明一个由伞仓和全部 Catalog 代码仓共用的 baseline branch；
- 一个覆盖 catalog 中全部代码仓的固定交付顺序；
- 该工作区使用的 team、validation 和 ownership 配置。

首期不在一个 Policy 中增加多 `workspaces` scope，也不允许 Parent、Manager 或 Role Agent 通过启动参数临时加入任意仓库。

PRD PASS 后，Manager 只能从当前 Policy catalog 中选择本次受影响的代码仓库子集。Host 验证每个 repositoryKey 均存在且类型为代码仓库。实际交付顺序是 Policy 全局顺序对受影响仓库集合的稳定投影，不能由 Manager 重新排序。

伞仓不参与代码仓交付顺序；它按照父子实例设计在所有受影响代码仓均完成交付后最后收尾。

如果需要增加或移除 catalog 仓库，管理员修改 Policy。Repository Catalog 属于 continuity projection，已有 active Parent 将进入 `abandoned(cause=policy-incompatible-change)`；新 Parent 使用新 catalog 从当前远端基线开始。

多个产品使用不同 Policy Source Document，不共享同一文件中的多层 workspace 定义。

### 3.11 伞仓由 Manager session cwd 确定，代码仓来自 `.gitmodules`

首期不在 Policy 中配置本地 `checkoutPath` 或 GitHub `owner/repository`。

DSH 主会话的 `SessionHeader.cwd` 是会话创建时的绝对工作目录；Role Actor child session 继承 Parent 的 cwd。Workflow 启动时，Host 将 Manager session cwd 作为 Product Workspace 的伞仓候选根目录，并通过 Environment Preflight 验证它是有效的伞仓 Git 根目录。

伞仓远端从其 Git 配置读取。Policy 只允许配置 remote alias，缺省为 `origin`；不配置重复的远端 URL 或 GitHub slug。

Repository Catalog 中的所有代码仓首期都必须是伞仓 `.gitmodules` 中已登记的 Git submodule/Gitlink。代码仓 checkout 位置由伞仓 cwd 与 `.gitmodules` 中的相对 path 推导；代码仓 GitHub 身份从对应 checkout 的已配置 remote 推导。代码仓也可以配置 remote alias，缺省为 `origin`。

Environment Preflight 按作用域验证：

**Parent 启动前的伞仓与 Catalog 结构检查：**

- Manager session cwd 存在且是伞仓 Git 根目录；
- 伞仓配置的 remote alias、GitHub identity 和 baseline branch 可用；
- Catalog 中每个 repositoryKey 能唯一解析到 `.gitmodules` 中的 submodule；
- 每个声明的 submodule path 规范化后仍位于伞仓范围内。

这一步不要求所有 Catalog checkout 已初始化或远端当前可用。

**PRD PASS 并确定受影响仓库后的定向检查：**

- 只对本 Parent 实际选择的 Catalog Repository 要求 submodule 已初始化且对应目录是 Git 仓库；
- 对这些仓库验证 remote alias 存在；
- 支持的 Git URL 规范化后能得到唯一 GitHub repository identity；
- `.gitmodules` URL 与 checkout remote 指向同一仓库；
- baseline branch 在相应远端存在。

未受影响 Catalog Repository 的 checkout 未初始化或远端暂时不可用，不阻止当前 Parent。

解析出的 GitHub owner/repository、submodule path 和 remote URL 是 Parent 的已解析仓库事实，后续 adapter 不从 Agent 参数接受任意仓库目标。

如果未来需要支持不属于伞仓 submodule 的外部代码仓，再单独设计 checkout registry；首期不预留任意路径入口。

### 3.12 Repository Catalog 是 Policy 显式白名单

Host 不自动把 `.gitmodules` 中的全部 submodule 纳入 Workflow。Policy 必须显式列出允许参与开发和交付的代码仓库 Catalog。

边界划分为：

```text
Policy Catalog
  → 决定允许操作哪些 repositoryKey

.gitmodules
  → 解析对应 submodule 的相对 path 和声明 URL

checkout Git remote
  → 解析当前本地 checkout 实际连接的远端

Environment Preflight
  → 验证三者一致
```

`.gitmodules` 可以包含不属于 Catalog 的第三方依赖或其他 submodule；它们不能被 Parent 选择，也不能因为被仓库内容新增而自动扩大 Workflow 范围。

静态校验必须保证：

- repositoryKey 唯一；
- 每个 repositoryKey 本身作为同名 `.gitmodules` submodule 引用，不存在额外 alias 字段；
- repositories.deliveryOrder 是 Catalog 中全部代码仓的无重复完整排列；
- umbrella 不出现在代码仓 delivery order 中。

环境预检负责保证每个声明的 submodule 在当前伞仓中存在且唯一匹配。新增允许仓库必须修改只读 Policy，并因 continuity projection 变化废弃 active Parent。

### 3.13 Repository Catalog 使用最小命名结构

首期不增加 repositoryKey 到 submodule name 的映射层：

```text
repositoryKey == .gitmodules submodule name
```

一个 Product Workspace 中的伞仓和全部 Catalog 代码仓共用一个显式 `workspace.baselineBranch`。不提供每仓 baseline override。`.gitmodules` 中存在 `branch` 声明时，Environment Preflight 必须验证它与该 baselineBranch 一致；相应远端 baseline branch 也必须存在。

Git remote alias 缺省为 `origin`。只有某个代码仓实际使用不同 alias 时，才允许在对应 Catalog entry 中显式配置 `remote`；不配置 URL、路径、submodule alias 或 GitHub slug。

概念结构：

```yaml
workspace:
  baselineBranch: dev1
  remote: origin

repositories:
  catalog:
    frontend: {}
    plugins:
      remote: upstream
    server: {}

  deliveryOrder:
    - server
    - plugins
    - frontend
```

静态校验保证 deliveryOrder 是 catalog keys 的无重复完整排列。环境预检使用相同 key 查找 `.gitmodules` submodule section，并解析 path 和远端身份。

### 3.14 分支配置只开放 prefix

首期不提供任意 branch template。Policy 只允许分别配置以下 branch prefix：

- milestone；
- feature；
- remediation；
- conflict-resolution；
- baseline sync。

分支名后缀和唯一 ID 组合由引擎固定，例如：

```text
{milestonePrefix}m-{milestoneNumber}
{featurePrefix}i-{issueNumber}
{remediationPrefix}i-{issueNumber}
{conflictResolutionPrefix}i-{issueNumber}
{syncPrefix}m-{milestoneNumber}/{shortBaseSha}
```

Policy 不能定义占位符、删除稳定 ID、改变 branch 类型映射或执行动态表达式。

静态校验必须验证 prefix 非空、类型间不重复，并拒绝 Git ref 中危险或非法的结构，例如控制字符、反斜杠、`..`、`@{` 和 `.lock` 结尾。校验器使用代表性固定后缀验证完整拼接结果。Environment Preflight 再调用 Git ref 校验并检查本地与远端命名冲突。

默认 prefix 已在本设计的 schema v1 固定默认值中冻结；稳定 ID 后缀格式由 Workflow Definition 固定，同一 `schemaVersion`/`workflowDefinitionVersion` 下不能静默改变。

### 3.15 Manager-owned 路径使用精确目录和受限文件 `*`

Manager-owned 路径只作用于伞仓，不授予任何 Catalog 代码仓写权限。概念配置分为：

- `files`：精确文件或受限文件名 pattern；
- `directories`：精确目录前缀及其后代。

`files` 中的 `*` 规则固定为：

- 只允许出现在最后一个文件名 segment；
- 匹配当前目录内文件名的零个或多个字符，永远不跨越 `/`；
- pattern 至少包含一个非 `*` 固定字符，单独的 `*` 非法；
- `*.md` 只匹配伞仓根目录直属 Markdown 文件；
- `docs/*.md` 只匹配 `docs` 直属文件，不递归；
- `*` 不匹配以 `.` 开头的文件，除非 pattern 的文件名 segment 也以 `.` 开头。

首期不支持 `**`、`?`、字符类、brace、否定规则、extglob、正则表达式或目录 segment 通配符。`directories` 完全不支持通配符。

静态校验拒绝空路径、`.`、绝对路径、drive/UNC 路径、`..`、非法分隔符和可能覆盖整个 Workspace Root 的规则。运行时对目标做规范化和 realpath/junction 校验。

无论普通规则是否匹配，以下目标始终优先拒绝：

- `.git` 及其内容；
- `.gitmodules`；
- Policy Source Document；
- Catalog submodule/Gitlink entry；
- Catalog checkout 内任何路径；
- 规范化后逃出伞仓的路径；
- 通过 symlink/junction 指向上述目标的路径。

Gitlink/submodule pointer 更新使用引擎控制的专用 Host effect，根据已验证 repositoryKey 和真实 merge SHA 执行，不属于通用 Manager-owned 文件写入。

### 3.16 Role 集合和职责映射由引擎固定

首期 Policy 的 `team` 必须且只能包含四个 Role Agent definition：

- `prd-reviewer`；
- `developer`；
- `code-reviewer`；
- `tester`。

四个 key 全部必填，不允许缺少、增加或改名。`manager` 由主会话隐式担任，禁止出现在 `team` 中。

Role 到 authoritative action/Gate 的映射由引擎固定，Policy 不能改派：

- PRD Review → `prd-reviewer`；
- 业务开发、remediation 和业务代码 conflict → `developer`；
- Child Code Review 与 Milestone Aggregate Code Review → `code-reviewer`；
- 需要 Agent 判断的测试准备、协调和分析 → `tester`；
- Manager-owned 非代码 effect → 隐式 `manager`。

`conflict-resolution` 仍是 Child 类型，不是 roleKey。Policy 只配置固定 Role Agent 的运行定义，不形成自定义角色、RBAC 或 action-role mapping。

### 3.17 Role Agent definition 内联在 Policy 中

四个固定 Role Agent 的运行定义全部内联在同一个 Policy Source Document，不引用外部 DSH agent preset 或独立 Role Profile Registry。

每个 definition 可以表达与 DSH continuable child 创建接口对应的运行参数：

- subagent provider；
- LLM provider/model/maxTokens；
- persona；
- tool filter。

以下内容由引擎固定而不是 Policy Parameter：

- mode 必须是 continuable；
- Role Actor 必须是 Manager 的直接 child；
- roleKey 来自 `team` map key，不在 definition 内重复声明；
- delegation topology 和 max depth；
- Role 到 action/Gate 的授权映射；
- Role Actor mapping 的注册和恢复规则。

Host 使用经过严格校验的 definition 直接创建 continuable Role Actor。当前 DSH child 会继承 Manager 的 preset composition，再应用 child persona 和 tool restriction；Policy 不尝试在 child 启动时选择另一个外部 preset。

内联方式使显式 Role Agent model block、persona 和工具范围同时进入 `policySourceHash` 与对应 `roleDefinitionHash`。这些字段属于 reloadable 白名单，变化后替换受影响 Role Actor，不废弃 Parent。省略 model 时继承的 Manager 当前路由是运行时事实，不进入 Policy hash；其变化按 3.19 的替换规则处理。

Static Policy Validation 校验字段结构和固定角色完整性；Environment Preflight 校验 subagent provider 是否支持 continuable，以及所配置的 model、persona 和 tool filter 能力当前是否可用。

### 3.18 可选 per-role deny-list 直接映射 DSH toolFilter

Policy 不建立独立工具权限系统。每个 Role Agent definition 可以省略 `tools`，或配置可选的 `tools.deny`：

```yaml
team:
  prd-reviewer:
    tools:
      deny:
        - edit
        - write
```

该字段由 Host 原样转换为创建 continuable child 时的 DSH `toolFilter.deny`。它只收窄相应 Role Actor 从 Manager preset/tool registry 继承的工具，不修改 Manager 自己的工具范围，也不能增加 Manager 原本没有的工具。

首期规则：

- 只支持 deny-list，不支持 allow-list；
- `tools` 省略等价于空 deny-list；
- tool names 必须是非空唯一字符串；
- 新增且未被 deny 的普通工具默认对 Role Actor 可见；这是首期明确接受的边界；
- 固定角色所需 Workflow Tool categories 由 Host 提供，不要求管理员列入配置；
- 具体 tool 名称在后续 tool/action contract 中冻结；冻结后，Static Validator 使用该固定集合拒绝 deny-list 禁止角色必需工具；
- 非空 deny-list 要求 subagent provider 支持 tool filter，否则 Environment Preflight 失败；
- 即使某个错误角色能看到其他角色的 workflow tool，Host 仍根据 agent.id、role mapping、状态和 SHA 拒绝未授权调用。

Tool filter 用于减少模型可见工具和误操作，不是最终授权证明，也不声称阻止所有 shell/Git/GitHub 旁路。

### 3.19 Role Agent 默认继承 Manager 模型并支持路由变化替换

Role Agent definition 的 `model` 整块可省略：

- 省略时，Role Actor 每次创建时继承 Manager 当前 LLM provider、model 和 maxTokens；
- 显式配置 `model` 时，provider、name 和 maxTokens 全部必填，不允许部分继承；
- `subagentProvider` 可省略，首期固定默认值为 `spawn`；
- persona 必填且非空；
- tools.deny 可选。

Manager 当前模型路由是运行时输入，不属于 Policy Source Document；切换 Manager 模型不会改变 `policySourceHash`，也不会废弃 Parent。

DSH continuable child 的实际模型路由在创建时固定并进入 descriptor，已存在的 Role Actor 不会自动随 Manager 改变。因此 Host 为 Role Actor mapping 记录：

```text
resolvedProvider
resolvedModel
resolvedMaxTokens
routeSource = inherited | explicit
```

下一次派发某角色前，Host 比较其现有 Role Actor route：

- `routeSource=explicit` 且 Policy definition 未变化：继续复用，不受 Manager 模型变化影响；
- `routeSource=inherited` 且 route 与 Manager 当前 route 相同、definition 未变化：继续复用；
- `routeSource=inherited` 且 route 不同：使用 Manager 当前 route 替换 Role Actor；
- 热重载导致该角色 `roleDefinitionHash` 变化：无论 routeSource 为何，都按新的 subagentProvider/model/persona/tools.deny 替换 Role Actor。

替换前必须确认旧 Role Actor 没有运行中的 turn，再将旧 mapping 转为历史，创建替代 Role Actor，登记新的 agent.id 并派发任务。

替换规则：

- 不静默复用旧 agent.id；
- 旧 session、mapping 和 evidence 保留；
- 既有 evidence 是否有效仍只由 Gate scope、状态和 SHA/manifest 决定，不因模型替换自动失效；
- 新 Role Actor 必须收到完整 Parent/Child/Gate/repository/branch/SHA 上下文；
- 如果旧 Role Actor 仍在运行，替换 fail closed，Manager 必须先停止 Agent loop；
- 替换事件进入 ledger。

该机制用于流程中途模型额度耗尽或 Manager 主动切换模型，不建立 fallback model 列表或自动供应商选择器。

### 3.20 Validation definition 直接归属 repository 或 workspace

首期不建立命名 Validation Profile Registry，也不引用 Policy 外部 runner profile。

- 每个 Catalog Repository 直接内联唯一的 authoritative unit test definition；
- Product Workspace 直接内联唯一的 release candidate integration test definition；
- feature、remediation 和 conflict-resolution Child 使用所属 repository 的同一个 unit test definition；
- Milestone release candidate 使用 workspace integration test definition；
- Manager、Child 或 Role Agent 不能在运行时选择替代 definition；
- unit test 和 integration test 都是固定强制 Gate，Policy 不能省略或关闭。

本节只冻结 definition 的归属和唯一性。command/runner 表达、工作目录、超时、缓存、CI、本地执行和 Tester evidence 留给自动测试专项设计。

内联 validation definition 属于 continuity projection；任何字段变化都会产生不同 `policyContinuityHash`，使 active Parent 进入 `abandoned(cause=policy-incompatible-change)`。

### 3.21 Validator 返回分阶段结构化 Diagnostics

Static Policy Validation 不采用只返回首个错误的 fail-fast 文本，也不自动修复 Policy。它按依赖顺序执行：

1. source/YAML；
2. strict schema；
3. internal references；
4. cross-field semantics；
5. Engine Invariant。

YAML 无法解析时不继续执行依赖 AST 的检查；schema 严重错误的节点应抑制无意义的级联语义错误。相互独立的问题尽量在一次调用中汇总。

每条 diagnostic 至少包含：

```text
code        稳定机器错误码
phase       source | schema | reference | semantic | invariant
path        统一配置路径
message     管理员可读说明
```

可确定时增加：

```text
line
column
suggestion
```

输出按 phase、path、code 稳定排序，不能在错误信息中回显 credential secret 或不必要的完整 persona 内容。Host 只报告问题，不修改、格式化或重写 Policy Source Document。

Environment Preflight 使用独立的 `environment` phase 和错误码，并标明 `repositoryKey`、外部目标以及错误是否 retryable，从而区分 Policy 非法、环境暂时不可用和环境确定不满足要求。

任一 error diagnostic 都阻止当前阶段继续；首期不使用 warning 将非法配置降级为可启动。

### 3.22 Policy Source Document 使用固定根相对路径

首期 Policy 路径固定为：

```text
<Manager session cwd>/.dsh/workflow-policy.yaml
```

不向父目录搜索，不支持多个候选文件名，也不接受 Agent tool argument、Parent 启动参数或环境变量指定其他路径。

Workflow 启动前必须验证：

- Manager session cwd 是伞仓根目录；
- `.dsh/workflow-policy.yaml` 存在且是普通文件；
- 文件不是 symlink/junction；
- 文件可由 Host 完整读取；
- Agent-facing sandbox/path policy 将该文件保持为只读；
- Manager-owned 规则没有且不能覆盖该文件。

缺失、非法或不可读的 Policy 阻止新 Workflow 启动。active Parent 运行中暂时不可读、无法解析或静态校验失败时进入 recovery；原始文件 hash 变化时按 continuity/reloadable 投影分类处理。

该固定路径可以进入伞仓版本控制。管理员对它的任何字节修改都会在下一 Manager Turn 触发重新加载和语义分类，而不是必然废弃 Parent。

### 3.23 不配置 policyId 或人工 revision

单文件固定路径下不存在 Policy 选择和 Profile Registry，因此首期删除 `policyId`，也不要求管理员维护 revision。

Policy Source Document 顶层唯一的版本身份字段是必填 `schemaVersion`。Parent 记录：

```text
policyPath
policySourceHash
policyContinuityHash
roleDefinitionHash[roleKey]
managerOwnershipHash
schemaVersion
workflowDefinitionVersion
resolved umbrella repository identity
```

这些 hash 字段表示 Parent 当前已接受的 Policy baseline；成功 reload 时原子更新，reload event append-only 保存 old/new hashes 和受影响 roleKey/ownership 标识。固定路径、hash 历史和 Environment Preflight 解析出的真实伞仓身份共同提供足够的审计与热重载判断，避免人工 ID 与实际 Workspace 不一致。

### 3.24 schemaVersion 使用精确命名版本

首期唯一支持值为：

```yaml
schemaVersion: workflow-policy/v1
```

Host 只接受精确字符串，不接受数字、简称、`latest`、semver range 或兼容猜测。不支持的值返回稳定错误码 `POLICY_SCHEMA_VERSION_UNSUPPORTED`。新 Workflow 遇到该错误只拒绝启动；active Parent 若读到一个显式且不同的 schemaVersion 字符串，则按 continuity 变化 abandoned。缺失或类型错误仍属于无法采用的新配置，进入 recovery。

Host 不自动迁移、重写或降级 Policy。字段结构、默认值或匹配语义需要变化时发布新的精确 schemaVersion；同一版本下不得静默改变。schemaVersion 属于 continuity projection，active Parent 检测到变化后进入 `abandoned(cause=policy-incompatible-change)`。

Workflow Definition 的运行兼容性继续由 Host 记录的独立 `workflowDefinitionVersion` 判断，不与 Policy schemaVersion 混为一个版本。

### 3.25 artifacts.directory 只固定权威 PRD 位置

Policy 必须配置一个相对于伞仓根目录的 `artifacts.directory`。该目录自动进入 Manager-owned 范围，并接受与普通 Manager-owned directory 相同的静态、containment 和 reserved-path 校验，不需要在 ownership 中重复声明。

首期只有一个由引擎固定路径和语义的权威 Workflow 文档：

```text
{artifacts.directory}/m-{milestoneNumber}/prd.md
```

`prd.md` 同时承载需求背景、范围、非目标、验收标准和 Issue 拆分依据。PRD Review Gate 绑定伞仓 repository、Milestone branch、该固定 path 和 candidate commit SHA。

GitHub 与 ledger 已经是以下事实的权威来源，因此 Host 不生成对应 Markdown 镜像：

- GitHub Issue 和 Milestone；
- Child/Parent 状态；
- Review evidence；
- 测试 evidence；
- PR、merge 和 delivery 状态；
- release candidate manifest；
- Role Actor mapping。

Manager 可以按需在 artifacts.directory 或其他 Manager-owned 路径创建 decision、note、research、migration plan 等辅助文档。其名称和是否创建由 Manager 判断，Host 不解析它们推进状态，也不把它们视为完成条件。

首期不固定 `issues/`、`reviews/`、`tests/` 或 `delivery/` 文档目录，避免与 GitHub/ledger 形成双重事实来源。

### 3.26 GitHub credential 属于 Host 运行环境

首期 Policy 不配置 GitHub credential、credential reference 或每仓账号。Host 使用当前默认 GitHub credential。

Environment Preflight 按阶段验证当前 credential 是否已登录、能访问所有当前目标仓库，并具备该阶段读取 branch/ruleset/check 或创建 Milestone、Issue、branch、PR、merge 所需权限。

Credential identity、token 和 secret 不进入 Policy，不参与 `policySourceHash`。Credential 轮换不废弃 Parent；暂时失效进入 recovery，确定权限不足则停止在对应 preflight。Host 不自动在多个 GitHub 账号之间选择或 fallback。

GitHub App、token、`gh` auth 或其他 adapter credential 的具体实现留给 GitHub adapter 专项设计。

### 3.27 Policy v1 不提供通用 runtime retry/timeout

首期不定义顶层 `runtime` section，也不提供可以同时影响 GitHub、Git、Provider、Role Actor、outbox 和测试的通用 timeout/retry 参数。

各类运行控制由所属专项负责：

- GitHub/outbox retry 由 ledger/outbox 和 GitHub adapter 设计；
- Provider 与 Role Actor timeout 使用 DSH/Host 规则；
- test timeout 只能在未来 Validation Definition 的明确 runner 语义中定义；
- Git 命令和 Environment Preflight timeout 使用 adapter 固定策略。

未来新增参数必须位于拥有明确语义的局部对象中，不能用一个全局值模糊控制不同幂等性和时长特征的操作。

### 3.28 无歧义字段使用 schema v1 固定默认值

Strict Schema 不要求所有已知字段都显式出现。首期允许以下无歧义默认值：

```text
workspace remote alias                 origin
catalog repository remote alias        origin
Role Agent subagentProvider            spawn
Role Agent tools.deny                   []
ownership.managerOwned.files            []
ownership.managerOwned.directories      []
branches.milestonePrefix                milestone/
branches.featurePrefix                  feature/
branches.remediationPrefix              remediation/
branches.conflictResolutionPrefix       conflict/
branches.syncPrefix                     sync/
```

整个 `branches` section 在全部使用默认值时可以省略，显式字段只替换对应 schema default，不形成配置继承或多文件 overlay。

以下关键字段仍必须显式配置：

- schemaVersion；
- workspace baselineBranch；
- Repository Catalog；
- delivery order；
- artifacts.directory；
- 四个 Role Agent 的非空 persona；
- 每仓 unit test definition；
- workspace integration test definition。

默认值是 `workflow-policy/v1` 契约的一部分，同一 schemaVersion 下不得改变。Static Validator 对默认值与显式值执行相同语义校验，并可以输出完整 effective configuration 供管理员查看。

### 3.29 Policy v1 顶层骨架

首期顶层只允许八个字段：

```text
schemaVersion
workspace
artifacts
repositories
branches
ownership
team
validation
```

其中 `branches` 和 `ownership` 可以整体省略，其余必填。概念骨架为：

```yaml
schemaVersion: workflow-policy/v1

workspace:
  baselineBranch: dev1
  # remote: origin

artifacts:
  directory: docs/workflows

repositories:
  catalog:
    frontend:
      # remote: origin
      validation:
        authoritativeUnitTest: <由自动测试专项冻结>
    plugins:
      validation:
        authoritativeUnitTest: <由自动测试专项冻结>
    server:
      validation:
        authoritativeUnitTest: <由自动测试专项冻结>
  deliveryOrder:
    - server
    - plugins
    - frontend

branches:
  milestonePrefix: milestone/
  featurePrefix: feature/
  remediationPrefix: remediation/
  conflictResolutionPrefix: conflict/
  syncPrefix: sync/

ownership:
  managerOwned:
    files:
      - "*.md"
    directories:
      - docs/design

team:
  prd-reviewer:
    persona: |
      ...
    tools:
      deny:
        - edit
        - write
  developer:
    persona: |
      ...
  code-reviewer:
    model:
      provider: configured-provider
      name: configured-model
      maxTokens: 32000
    persona: |
      ...
  tester:
    persona: |
      ...

validation:
  integrationTest: <由自动测试专项冻结>
```

顶层不出现 policyId、Workflow Definition selector、states、transitions、gates、动态 roles/authorization、GitHub credential、checkout path、GitHub owner/repository、runtime、extends、overrides、scripts、hooks 或 Validation Profile Registry。

这里的 Workflow Definition 指固定 Parent/Child 状态机、Gate、失败回路和交付语义，不是 LLM Model。Role Agent 的 LLM Model Route 仍可以省略后继承 Manager，也可以在 definition 中显式覆盖。

### 3.30 每个 Manager Turn 完整加载一次，不跨 turn 缓存

每个主会话 Manager Turn 开始时执行一次：

```text
读取 Policy 原始文件并计算 policySourceHash
→ 解析受限 YAML
→ active Parent 的显式 schemaVersion 与已记录值不同？
   └─ 是：持久化 abandoned(policy-incompatible-change) → STOP
→ Strict Schema
→ Static Policy Validation
→ 物化 schema defaults
→ 计算 policyContinuityHash、roleDefinitionHash[]、managerOwnershipHash
→ active Parent 存在时与已接受 hashes 比较
   ├─ continuity 变化：持久化 abandoned(policy-incompatible-change) → STOP
   ├─ 仅 reloadable 变化：定向 preflight 后原子推进 accepted hashes、标记 stale mappings 并记录 policy-reloaded
   ├─ 仅 source 表示变化：推进 accepted policySourceHash
   └─ 无变化：正常继续
→ 仅非终止分支得到本轮 Validated Policy
```

同一 Manager Turn 内后续编排共用该 Validated Policy，不重复读取。Role Actor turn 和同轮内部 worker 不独立加载 Policy；Host 不跨 Manager Turn 缓存 YAML AST 或 Validated Policy。

Host 重启后的第一个 Manager Turn 使用同一流程。如果当前文件无法读取、解析或静态验证，fail closed 进入 recovery，不采用新配置；修正后在下一 Manager Turn 重新分类。

Manager 派发时把当前步骤需要的 repository identity、branch、SHA、Gate、Role Actor definition fingerprint 和其他已解析参数写入 task/attempt/dispatch 事实。Role Actor 后续 mutation 依赖这些 ledger 事实和固定 Host 校验，不在 child turn 中重新解释 Policy。

Environment Preflight 仍只在相应阶段执行，不因为每轮重新静态校验而每轮重复查询全部外部环境。

### 3.31 首期不增加自定义 Parser 资源上限

首期依赖所选 YAML parser 和 Host 运行环境的默认资源边界，不额外定义 Policy 文件大小、AST 节点数、嵌套深度、persona 长度、Catalog 数量或列表项数上限。

受限 YAML 仍然禁止 anchor、alias、merge、自定义 tag、多文档和动态表达式；Strict Schema 仍拒绝不符合结构的内容。Host 不建立可由 Policy 调高资源限制的参数。

这是首期为了减少实现复杂度明确接受的边界。如果真实配置规模或解析器行为出现问题，再依据观测增加实现级限制，而不在当前设计中预设。

### 3.32 Environment Preflight 失败状态边界

Parent 创建前的 Environment Preflight 失败只拒绝启动、返回 diagnostics，并保持主会话 `normal`；此时不创建 Parent，也不产生远端 effect。

Parent 已创建后的仓库阶段或其他可修复环境预检失败：

- 记录 preflight attempt 和 diagnostics；
- 不产生该阶段后续 effect；
- Parent 进入 `workflow-recovery`；
- Host 不自动修改 remote、初始化 submodule、创建 baseline branch 或调整 GitHub ruleset/权限；
- 用户修复环境后，下一 Manager Turn 重新执行对应 preflight；
- 成功后返回 `workflow-active`；
- 如果用户修改了 Policy 文件，则下一 Manager Turn 先执行完整 reload classification：reloadable 变化可以被接受，但不会自动清除原有 recovery cause；只有原失败 preflight 重新执行成功后才返回 `workflow-active`。continuity 变化仍进入 `abandoned`。

最终交付 preflight 继续优先使用已确认的领域路由：baseline 漂移重新同步，Git conflict 创建 conflict-resolution，required check 失败且需要代码修改时创建 remediation，暂时外部故障进入 recovery，权限/ruleset 错误保持 recovery 等待管理员处理。

只有 `policyContinuityHash` 变化或 Workflow Definition 不兼容进入不可恢复的 `abandoned`；reloadable Policy 变化和普通环境故障都不会冒充不兼容变更或永久废弃。

## 4. 延后到关联专项的内容

以下内容不改变本文已经冻结的 Policy v1 边界，但需要在对应实现专项中继续确定：

1. Validation Definition 的 runner/command/evidence 内部 schema；
2. Static Validator 和 Environment Preflight 的完整错误码清单；
3. Environment Preflight 的 GitHub/Git/Provider adapter 级检查细节；
4. Role Agent 和 Workflow tool/action 的最终具体名称。

## 5. 已确认不变量

1. 首期只有一个由 Host 固定的功能交付 Workflow Definition，Policy 不能定义状态、transition、Gate 或失败路由。
2. Policy 不能关闭、跳过、重排或降低固定 Review、测试、SHA 和交付保障。
3. 所有新建 Child 固定参与完成条件，不开放 optional 或自定义可接受失败终态。
4. Policy Source Document 固定为 Workspace Root 下 `.dsh/workflow-policy.yaml`，Agent 不可修改。
5. 首期只接受受限 YAML 1.2，Strict Schema 拒绝未知字段、隐式类型转换和动态表达式。
6. 唯一 schemaVersion 是 `workflow-policy/v1`，不配置 policyId、人工 revision、继承、overlay 或启动参数 override。
7. 一个 Policy 只描述一个 Product Workspace；Manager session cwd 是伞仓候选根目录。
8. Repository Catalog 是 Policy 显式白名单；repositoryKey 必须等于 `.gitmodules` submodule name。
9. 伞仓和全部 Catalog Repository 共用一个显式 baseline branch，deliveryOrder 是 Catalog keys 的无重复完整排列。
10. Checkout path 与 GitHub identity 从 cwd、`.gitmodules` 和 Git remote 解析；Policy 不重复配置绝对路径或 owner/repository。
11. GitHub credential 使用 Host 当前默认运行时凭据，不进入 Policy hash。
12. Policy 只配置 branch prefix，稳定 ID 和后缀格式由 Workflow Definition 固定。
13. Manager-owned 路径只作用于伞仓，目录为精确前缀，文件只支持最终 segment 非递归 `*`；固定拒绝目标始终优先。
14. Gitlink 更新使用专用 Host effect，不属于普通 Manager-owned 写入。
15. artifacts.directory 自动属于 Manager-owned；首期仅固定位置的 `prd.md` 是权威 Workflow 文档。
16. Policy 必须且只能内联四个固定 Role Agent definition，职责和 action/Gate 映射不可配置。
17. Role Agent mode 固定为 continuable；persona 必填，subagentProvider 默认 spawn，model 可显式配置或在创建时继承 Manager。
18. 可选 per-role tools.deny 直接映射 DSH child toolFilter，不限制 Manager，也不是最终授权边界。
19. 每仓唯一 authoritative unit test definition，workspace 唯一 integration test definition；两者强制且不可替代。
20. Policy v1 不建立 Validation Profile Registry，也不提供顶层 runtime retry/timeout。
21. 每个 Manager Turn 完整加载和静态校验 Policy 一次，不跨 turn 缓存；Role Actor turn 不独立加载。
22. `policySourceHash` 检测原始字节变化；规范化 `policyContinuityHash`、`roleDefinitionHash[]` 和 `managerOwnershipHash` 判断变化影响，成功分类后原子推进 accepted hashes。
23. 首期 reloadable 白名单仅包含 Role Agent subagentProvider/model/persona/tools.deny 和 ownership.managerOwned；接受前执行所需定向 preflight。
24. Role Agent definition 热重载时先将无运行 turn 的旧 mapping 标记 stale；下一次派发前以新的 agent.id 替换。继承模型路由变化使用同类替换，旧 session、mapping 和 evidence 保留。
25. active Parent 读到显式且不同的 schemaVersion 字符串，或有效 workspace、artifacts、repositories、branches、validation 投影变化时，属于 continuity 不兼容并进入 `abandoned(policy-incompatible-change)`。
26. Workflow Definition 不兼容进入 `abandoned(workflow-definition-incompatible)`；abandoned 后 Host 只记录、提示和停止，不自动清理本地或远端产物。
27. 新 Policy 无法读取/YAML 解析、schemaVersion 缺失或类型错误，或在 schemaVersion 未明确变化时无法通过静态验证，则不采用并使 active Parent 进入 workflow-recovery；管理员修正后重新分类。
28. Static Policy Validation 不查询外部环境；Environment Preflight 在 Parent 创建前、受影响仓库确定后和最终交付前分阶段执行，并在 reloadable Role Agent definition 变化时执行定向 preflight。
29. Validator 返回稳定、结构化、尽量汇总的 diagnostics，只报告不自动修复 Policy。
30. 首期不增加自定义 Parser 资源上限，也不增加通用 per-role writable paths。
