# AIChat 伞仓文档解耦方案与实施记录

## 2026-09-21 修正：项目事实与执行流程分离

用户指出上一轮仍把项目文档绑定到两套工作流，并将测试 skill 缩成必须跳转其他文件的薄入口。本节取代下方 2026-09-20 记录中的相关设计选择；下方保留为历史，不是 AIChat 当前规范。

- 根 AGENTS 恢复 Issue tracker / Triage labels / Domain docs 配置入口，沿用本机已安装 setup-matt-pocock-skills 的 GitHub 方式，并保留多仓身份映射。移除工作流白名单及选型表，不规定节点、角色、分支层次或验证时点。
- issue-tracker.md 提供 GitHub Issue 存储位置、基本命令、PR 关联、报告位置及 skills 的 publish/fetch 对接，不要求固定 Milestone/子票结构。workflow.md 仅作为旧路径兼容说明，不再是加载链中的流程配置。
- verification.md 仅规定技术证据与质量标准；移除开 PR 前、合并前后等执行时点，以及 manifest/publication/handoff/Run/BLOCK 等运行协议术语。子仓及技术参考同步去掉相关耦合。具体流程由实际采用的工作流或 skill 定义。
- 桌面/API 测试 SKILL.md 恢复可直接使用的基本命令、必要参数、环境、工作目录与结果判据；hula-skill 包含常用实现和构建方法。复杂 WS、故障注入、长参数表和故障配方留在 references，避免基础操作必须再加载全文。
- 本轮只改文档与 skill，不修改工作流 YAML 或插件代码。检查31份变更文档的78个本地引用及16份核心归档哈希，无错误；四仓 diff --check 通过。未执行真实测试、登录、部署、提交或推送。

质量标准依然保留：真实客户端证据、独立验证真实性、实际服务版本与就绪判据、共享实例和授权边界。它们说明什么证据可信，不构成第二份业务执行流程。

## 2026-09-20 历史实施记录

版本：2026-09-20.2（已按用户确认实施）；配套 [coding-workflow](../example/coding-workflow.yaml) 与 [coding-workflow-rapid-multi](../example/coding-workflow-rapid-multi.yaml)。AIChat 后续实际开发使用这两套多仓流程。本文记录迁移设计与验证，不是 agent 的常驻规范；现行入口为 AIChat 根 AGENTS.md。本轮已修改伞仓与三个子仓的相应文档，补齐并安装完整流程发布后验证；未提交、推送、部署或运行真实开发流程。

## 实施结果

- 根 AGENTS/CLAUDE 与开发流程入口精简，质量与时点集中到 `docs/agents/verification.md`；GitHub、标签、子模块说明不再指定固定角色或 dev/dev1。
- 原 13 个角色退出 `.codex/agents/`，与旧根规范/流程逐字节归档到 `docs/_legacy/team-20260920/`。五个角色 MEMORY 索引改短入口，历史正文保留原位；专业方法和按主题入口分别进入 engineering/knowledge。
- SessionStart 只输出分支、变更数量和 HuLa PID，不派单、清进程或加载旧角色。项目及当前用户 Codex 配置的定向检索未发现这 13 个角色的注册引用；没有更改全局配置。
- 两个测试 skill 采用短入口与按需操作参考；前端规范去重，server/plugins 技术参考保留。部署说明如实记录版本能力缺口、WARN 与失败的区别，不修改部署脚本。
- 完整流程新增条件 `verification-required → verify-publication → passed → close-milestone`，原无发布后要求路径保留。live 与示例分别修改，保留各自模型及已有用户改动；本机配置安装前的备份为 `coding-workflow.yaml.before-postmerge-20260920.bak`。rapid-multi 路由不改。
- 验证：22 项完整流程定向路由测试通过；标准 `pnpm run verify` 的类型检查、516 项测试及 T3/E2E 受控 smoke 全过，零失败/跳过。31 份变更文档的75个 Markdown 本地引用有效，16份核心归档哈希相符，SessionStart 语法与各仓差异检查通过。此结果不等于真实部署或真实多仓 E2E 已通过。

精简效果按字符计算而非 token 实测：根 AGENTS 7461→1461、根 CLAUDE 7958→85、旧流程入口13158→487；前端 AGENTS 8540→1155、CLAUDE 13953→241。技术知识下沉与历史归档不计作删除；常驻输入减少，所需质量条款仍有明确入口。

后续能力项：现有部署脚本缺少显式 revision/受验制品输入，部分就绪失败仅 WARN；本轮已校正文档，未改脚本或以真实发布试跑。需要该能力时另行改造，当前无法证明所需版本或门槛时仍 BLOCK。修改涉及伞仓与三个子仓工作树，尚未创建提交或更新 gitlink。

## 合并后的事实与已确认决策

迁移前复核基点：`D:/project/hx/aichatoverview` 为 `dev`，HEAD `efa1318`（Merge branch 'dev1' into dev），工作树干净；三个子仓为 `dev1`，`.gitmodules` 记录 `dev1`。本次未改分支、HEAD 或长期跟踪配置。伞仓分支合并不代表子仓基线或部署源自动改成 `dev`。

相对第一父提交，本次合并新增根 AGENTS 及 13 个 `.codex/agents/*.toml`，修改旧 workflow、submodules、CLAUDE 和 `.gitmodules`。因此迁移范围必须覆盖新入口和反复注入的提示，不能只删旧 workflow 正文。当前 `.codex/config.toml` 未发现这 13 个角色的注册项，不能把 AGENTS 的“全部已注册”当运行事实；外部注册如存在，落地时另核对。

| 决策 | 推荐 | 状态 |
|---|---|---|
| 实际开发入口 | 只使用上述两套多仓工作流 | 用户已确定 |
| dev/dev1 与每次 Run 基线 | 每次初始化确认各仓基线；长期跟踪分支与本次基线分开，不因这次文档迁移修改 `.gitmodules` | Q1 用户已确认 |
| 旧 Codex 团队 | 退出旧团队入口，归档角色文件；先提取专业知识至按需文档/skill | Q2 用户已确认 |
| 验证时点 | 保留原质量要求及合并前后时点，补齐完整流程的合并后验证缺口 | Q3 用户已确认 |

上述设计选择及实施范围均已确认。保留下方审查基点和设计理由，发现项描述的是迁移前状态；已实施情况以上方记录为准，不把此长方案作为开发必读材料。

审查范围：根 AGENTS/CLAUDE、docs/agents/{workflow,issue-tracker,triage-labels,domain}、docs/shared/submodules、角色 TOML 与 memory 入口、SessionStart 和 submodule hook、关票/merge 辅助脚本、测试/部署 skill 的相关段落，以及子仓规范入口。两套流程行为以本机 `C:/Users/hua/.dsh/workflows/` 当前 YAML 为依据；仓库示例存在自定义差异，不用示例覆盖本机配置。未读取凭据文件或执行 GitHub 写操作。

## 结论

文档应保留项目事实、质量门槛与安全约束，把角色、阶段、路由、分支层次、何时拆票/提交审查/合并/关票、报告落点放到所选工作流。不能仅在 AGENTS 加一句“以工作流为准”就算完成：现有角色 persona 也写死流程，仍会重复注入；旧 memory 索引也会把旧规则重新带回。

两套流程的共同项目要求与不同执行策略必须分开：

| 事项 | coding-workflow 当前行为 | coding-workflow-rapid-multi 当前行为 |
|---|---|---|
| 跟踪单元 | 主/子 Issue + 伞仓 Milestone | 唯一伞仓 Issue，不创建子票或 Milestone |
| 分支 | 全部受管仓 feature → milestone → baseline，未改仓也准备 milestone 分支 | 只给修改仓及需改指针的伞仓建立任务分支 → 各仓基线 |
| gitlink 组装 | coordinator 在 prepare-integration 组装；developer 不更新 | developer 在 implement 组装；发布者不改候选 |
| 固定版本 | 保留受验候选 SHA；不追逐 baseline tip 或发布后的 merge SHA | 同左；未改依赖保留原 gitlink |
| 独立验证 | 按需单票验证 + 发布前集成验证 + 按项目要求的 verify-publication | 同一 verify 按计划分别执行 premerge/postmerge |
| 收尾 | 发布后统一关闭所有实施票/主票/Milestone | 全部发布及所需阶段验证通过后关闭唯一 Issue |

此表用于本次迁移审查，不复制到 AIChat 的常驻提示。尤其不能在项目规范统一写“developer 不得改伞仓”“每个需求必须建 Milestone”或“全部仓每次都建分支”。这些要求会使另一套流程无法执行。

这些执行选择只写工作流配置，不迁入项目 AGENTS。全部 Issue/Milestone 仍在伞仓，不复制工单、不另建标签节点状态机，环境由 Manager 在有效授权下按需准备。项目固定角色权限冲突仍须处理，配置不能自行修改项目授权；真实客户端、部署就绪与独立 E2E 等质量要求继续有效。

推荐核心加载链：AGENTS → 按操作读取 issue-tracker / submodules / verification → 必要的技术 skill。执行流程从当前冻结配置获得。人工讨论、只读分析和规则维护不必虚构开发 Run；实际开发入口沿用用户指定的两套工作流。

### 提示词放置与用语

- **项目质量要求**：切换流程仍须满足的验收条件，保存在项目按需文档；不能通过精简变成可选项。
- **执行策略**：角色、路由、分支层次、验证阶段和关票动作，由所选流程规定。
- **长期跟踪分支**：`.gitmodules`/upstream 的仓库配置；**本次基线**：Run 确认的 PR 目标。二者不混用。
- **候选版本集合**（manifest）与**发布记录**（publication）：沿用工作流中的不同概念，不把发布成功当验收通过。

跨节点必须持续遵守的执行约束留在工作流 `actorCommonPersona`，角色职责留在 persona；节点 instruction 只给当前任务，criteria 定义当前出口。persona 作为 system prompt 注入，不把关键约束只放在长篇上下文中。Manager 不继承 actorCommonPersona，继续使用通用 milestone-manager preset 和当前 Manager 节点合同；Judge 使用自己的核验协议。项目 AGENTS 不复制这三套协议，也不加入让读者必须扮演某个角色的提示。

本轮是在澄清配置术语，没有新增 AIChat 产品领域概念，不把流程规范塞入产品 CONTEXT.md，也不为可逆的文档拆分新增 ADR。

## 文件迁移表

| 文件 | 保留 | 移出或改写 |
|---|---|---|
| AGENTS.md | 仓库拓扑、真实远端定位、源码与部署环境、共享资源互斥、凭据边界、代码/测试质量、用户改动保护、条件式文档入口 | §1团队层级、§2的manager唯一调度和阶段分工、§4整段manager章程中的流程、§5固定roster、§8无条件查ready和全部回dev1；改为当前工作流分工 |
| docs/agents/workflow.md | 旧流程作为有日期的历史资料 | 正文移至docs/_legacy/，原入口改为很短的“流程由当前配置定义”；不逐节点复述新YAML；质量条款先迁出再归档 |
| docs/agents/issue-tracker.md | umbrella Issue身份、代码PR仓身份、全限定引用、AI来源声明、gh --body-file和显式-R、分页查询原则 | 一个REQ必建Milestone、固定manager权限、Comment-only review、合并即关、强制两份审查评论；改为流程选定操作人与记录落点 |
| docs/agents/triage-labels.md | label字典、成功close和wontfix区别、人工阻塞保护 | 删除每票恰一category+一状态的强约束（与prd/聚合票不兼容）；PRD定义与Milestone绑定方式归配置；只负责词义，不定义步骤状态机 |
| docs/shared/submodules.md | hook安装、远端可获取gitlink、先子仓push后伞仓、用户工作树保护、同步跳过条件 | “开发前全部checkout跟踪分支”、通配git add frontend server plugins；替换为逐仓检查当前操作授权的分支和精确指针，仅暂存本任务路径 |
| .codex/agents/*.toml | 提取专业验证方法、构建/技能入口，归入按需技术参考 | 13份旧团队角色归档至非发现目录；移除有效注册/启动入口中的引用（若存在），固定派发者、manager唯一权、[7c]/[9]与角色权限不迁入新规则 |
| docs/roles/*/memory_history/MEMORY.md | 技术事实和事故教训，按主题按需读 | 五份全读/开工无条件读/每票强制写记忆；旧manager权限和固定分支条目标记历史适用域。增一个薄主题索引，使任意角色可查runtime/deploy/frontend等事实 |
| CLAUDE.md | 到AGENTS的兼容入口 | 虽首行标历史，后面仍包含整套强命令；将全文移到历史目录，根只留入口，避免自动加载双份规则 |
| docs/agents/domain.md | CONTEXT/ADR术语和冲突处理 | 删除要求读workflow.md获取流程的链；改指issue-tracker保存位置，旧历史不自动加载 |
| .codex/hooks/session-start.ps1 | 必要时只报实际分支、工作树和客户端进程事实 | 删除“派发写型代理前”“先 kill”“查 ready 任务”“角色宪章/角色记忆活本”等引导；检查是否仍需该 hook，不能在 resume/compact 后重新注入旧流程 |
| 测试 skills 与 references | 启动、编译、CDP、用例设计、日志排查、单例资源归属等专业方法 | 删除“当前 dev tip”作为必定测试目标，改消费本次验收的实际版本/环境；去掉固定汇报角色。技能内的测试操作步骤保留，不把一切名为 workflow 的技术配方都归档 |
| 部署 skills 与脚本说明 | 构建/备份/恢复/就绪探针等操作方法 | 区分部署源实际能力与业务流程；清理 dev/dev1 自适应的不实说明，显式接收或核实本次版本，操作成功不自动等于验收通过 |
| 子仓 AGENTS/CLAUDE 入口 | 该仓编码/构建/测试约束 | 当前四份为 frontend/AGENTS、frontend/CLAUDE、server/CLAUDE、plugins/CLAUDE；前端两份去重，后两份保留技术参考，不将所有CLAUDE一刀切归档。去掉前端三份全文同步约定，长testid表移按需参考，不顺手重写.rules |
| .githooks/README.md | hooks 安装和实际行为说明 | 原链接根CLAUDE摘要的入口改指submodules稳定规范，避免从工具说明重读旧流程 |

## 迁移前确认的矛盾与处理依据

1. **关闭与验收矛盾**：workflow.md [8]、状态图、收尾五步写合并后立即close；AGENTS close gate和同文后段要求server/plugins运行时变更合入+部署就绪+独立E2E。应只保留后者为完成标准。流程单独记录“代码已整合、验收待办”，不可把Issue OPEN当未实现、把closed当可跳过验收。
2. **分支矛盾**：AGENTS无条件要求全部仓dev1；frontend-dev TOML与Rust专家还写base=dev。多仓Milestone分支不应被初始化/专家切回跟踪分支。项目文档只说明仓库事实、分支保护与安全操作；本Run按用户确认记录每仓baseline、起点、Milestone分支和Issue分支。gitlink应引用受验且已可达的子仓SHA，不强制等于最新baseline tip或merge commit。
3. **角色权力矛盾**：所有label、merge、部署、指针仅manager可做，与DSH配置的coordinator角色冲突。项目保留“仅当前获授权执行者可改”，由工作流指定是谁。
4. **标签语义矛盾**：词典needs-info是等信息，流程却当返工/部署未验；ready-for-human词典是人工实现，正文变业务决策。统一字典，节点进度写Issue评论并交给workflow runtime；人工暂停不因依赖关闭被抹掉。close标签是成功完成标记而非代码合并证明。
5. **跨仓自动关票描述错误**：GitHub支持`Fixes owner/repo#N`，是否自动关闭还受默认分支等条件影响。本流程选用`Implements owner/repo#N`是为避免多PR/部署未验时提前关闭，不能写成GitHub“不支持跨仓关闭”。依据：[GitHub官方](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)。
6. **hook不会替工作流整合指针**：_sync-submodules.sh跳过dirty和非跟踪分支；“同步完成”输出不能证明各仓SHA符合候选。切伞仓分支后逐仓重新读分支/SHA/gitlink，不禁用hook、不force覆盖；保留未纳入范围的子仓。
7. **现有辅助脚本只能辅助**：check-merge-gate.sh将全Issue评论拼接搜aichat-tester、PASS和部署关键词，未绑定同一评论/run/revision且部署缺失仅warn；close-issue.sh无显式仓参数、会先写close标签，旧close命令参数及失败回退也值得单独修正。工作流不可将脚本的GATE PASS替代真实证据；改造方案应接受repo、run、证据链接和revision集合，失败保留待处理状态。
8. **部署skill不天然支持候选集**：deploy-server.sh:50–53 读取远端 checkout 的 upstream，缺失才用 dev1；不会像 SKILL.md:42 宣称的那样把已有 dev upstream 自动改为 dev1。生产配方又固定 dev。必须按实际源码/制品核验部署目标，不能把此次伞仓分支合并当部署分支迁移。指定 revision/制品摘要能力属于脚本改造项，不通过改说明伪装成已支持。
9. **完整流程缺少合并后验收路由**：当前完整 YAML 的 verify-integration → publish → close-milestone 只覆盖发布前独立测试；AIChat AGENTS 要求 server/plugins 运行变更合入跟踪分支后部署并通过独立 E2E。rapid-multi 已有 postmergeRequired。Q3 已确认保留原时点，完整流程须在 publication 后接独立验证，再进入关票；发布后失败 BLOCK 并保留事实，不能回尚未发布的候选分支假装返工。前后阶段检查按不同验收目的安排，不简单复制整套测试两遍。
10. **自动注入仍会恢复旧规则**：SessionStart hook:9–14 输出派单、清进程和角色记忆入口，根 CLAUDE 虽标历史仍保留全文命令。只改 AGENTS 会留下两条回流路径；归档文件必须离开自动加载/注册入口，活入口不再链接历史流程作为必读。
11. **技术事实需单独标记矛盾**：根 AGENTS 仍称通过 hula_send_message 回复，plugins/CLAUDE.md:10–12、90 则称该工具已退役、改用 aichat send-message。这是文档间已证实的不一致，尚未以实现审计裁定；根入口建议删去这类可从子仓按需读取的易变架构摘要，避免顺手把其中一个版本当新权威。测试 skill 的“当前 dev tip”也改为本次版本入口。

12. **子仓测试说明过时且相互冲突**：frontend/AGENTS.md:138 称“目前无测试”，frontend/CLAUDE.md:42 则列 specs；server/CLAUDE.md:34 将跳测构建作为默认。这里先确认文档冲突，不据数字推断当前测试覆盖。迁移时指向实际测试命令和范围，删去易漂移数量/“无测试”绝对结论；跳测构建只能证明构建，不能充当单测通过。

## 质量条款迁移矩阵（已确认保留门槛与时点）

| 适用范围 | 保留的项目要求 | 配置负责的动作 |
|---|---|---|
| frontend | 必需单测/构建、开 PR 前真实客户端自检、独立合并前验证；开发自检不能代独立验收 | 选择执行者、输入隔离和对应节点/出口 |
| server/plugins 运行时行为 | 合入交付基线、部署实际版本、就绪证据、独立 E2E，满足后才算完成 | 区分 premerge/postmerge；完整流程缺口另修 |
| 纯文档/不影响运行的改动 | 按范围执行实际适用检查并说明适用性 | 不为走节点虚构运行测试或部署 |
| 所有验证 | 版本与环境可追溯、失败和未测边界如实记录、共享客户端归属明确 | 将报告关联当前 Issue/manifest/publication |

质量要求只保留一份权威内容在 verification；测试 skill 说明“怎样操作”，部署 skill 说明“怎样构建部署并核实”，workflow 说明“何时由谁做以及失败去哪里”。原始故障教训保留为按主题查询的历史证据，常驻提示只留能防止复发的当前规则。

## 完整流程需要配套的最小改动

1. 初始化登记项目要求的合并前/合并后验证范围及 `postmergeRequired`，连同授权环境和版本入口一起交接。前端单票自检与独立合并前验证维持现行要求。
2. 保留发布前 `verify-integration` 的候选验证；只把项目允许发布后执行的部署/E2E安排到发布后，不能用此迁移跳过开发期必需环境或客户端自检。
3. `publish` 完成所有仓后固定 publication。`postmergeRequired=false` 按现有路径收尾；为 true 时以命名结果进入新增 `verify-publication`，复用现有 tester 角色。独立节点可避免发布后错误沿旧 `changes-required/stale-review` 回到未发布分支。
4. `verify-publication` 只验本次 publication 对应的实际部署与独立用例；通过交 `close-milestone`。失败、环境缺口、实际版本不符均 BLOCK，不重复发布、不重建 publication、不关闭 Issue。
5. `close-milestone` 消费相应阶段的通过结果，不重新跑测试。rapid-multi 已具该阶段路径，本次只核对和统一项目引用，不重构五节点结构。
6. 工作流验收覆盖：无 postmerge 要求正常收尾；有要求先验证再关闭；发布后失败/版本漂移不能返工旧 PR；关票重试不重复发布/验证；原 premerge 返工路径正常。保留各自现有模型、system persona 和用户未提交的环境证据/Judge改动。

该改动使用已有角色、命名结果和路由即可，不要求插件新增能力。本次落地范围为文档/提示入口与工作流配套修改。部署工具的精确版本能力另外评估：先校正说明并记录缺口，脚本改造作为单独可审查项；能力不足仍 BLOCK，不假称已支持。本次设计确认不授权执行真实部署。

## 不因流程解耦而削弱的要求

- frontend改动仍需真实客户端自检及独立验证；保留独立测试基于验收标准推导、不能拿实现者自检当独立通过。开PR之前还是其他受控阶段执行由工作流安排，但原“自检未过不进入审查”的时序若要放宽，须单独形成可见变更，不能以删文档悄悄降低现要求。
- server/plugins运行时改动交付前需部署实际验收revision、服务Started日志、目标服务路由可用、plugins WS Connected、独立E2E通过；容器up/网关login200不是就绪证明。
- HuLa同机单例（com.hula.pc、9222、共享配置），同一时刻只有一个驱动者；运行前确认实例归属，结束释放本任务实例，不能简单“发现任意HuLa就kill”。共享环境故障注入需授权和可执行回滚。
- 代码审查、必要测试、调用点语义核对、回归用例正向保护、数据库结构实查、保护分支和gitlink远端可获取仍保留。
- 生产部署需有效授权；变更流程不会获得历史任务或角色记忆中的一次性授权。

## AGENTS.md 候选简版

以下是骨架，需先迁出上述质量细则至`docs/agents/verification.md`才可替换原文，不能先删后补。

```markdown
# AIChat 项目规范

本仓是伞仓，frontend、server、plugins 为独立 Git 子模块；需求与 Issue 集中在 huaaichat/aichatoverview。仓库路径/远端/长期跟踪分支查 .gitmodules 和 git；本次开发基线按工作流初始化确认，不能用当前 checkout 推断。

本文件规定项目事实、质量和安全边界。实际开发使用 coding-workflow 或 coding-workflow-rapid-multi；角色、顺序、分支策略与交付记录按当前运行的冻结配置执行。讨论/只读分析按当前用户任务进行。流程选择不降低项目质量要求，远端写入与部署遵循当前有效授权。

## 工作树与仓库

- 修改前核实所属仓、分支和用户已有改动，仅暂存本任务文件；子仓独立提交，伞仓只记录获准的gitlink及自身文件。
- 代码按受保护分支的PR要求交付；不绕过保护或hooks。先推子仓，再推引用该提交的伞仓；记录的gitlink必须可从对应远端获取。
- 涉子模块checkout/pull/merge/push/指针时先读docs/shared/submodules.md。hooks会跳过dirty/feature分支，执行后核对实际SHA；不强制同步覆盖工作树。

## 质量与环境

- 涉实现或验收先读docs/agents/verification.md，按改动范围执行代码审查、单元和真实环境验证。独立验证不可由实现者自检代替；任何失败/未验项如实记录。
- HuLa同机只允许一个客户端驱动者。测试需确认实例归属，结束释放本任务资源；共享环境故障注入须具备授权和自动回滚。
- server/plugins运行环境在远端，本机负责编译单测。部署前读相应deploy skill，核对实际源码/制品版本和部署就绪证据；运行时变更完成前须满足真实环境验收。
- 凭据从获准的环境入口按需取用，报告与日志不含秘密；共享测试账号入口tests/docs/aichat-test-env.md，其他凭据保存在ignored本地文件。

## 按需入口

- 操作Issue/PR/Milestone：docs/agents/issue-tracker.md；标签含义：docs/agents/triage-labels.md。
- 领域设计和接口变更：CONTEXT.md及相关docs/adr/；子仓实施先读该仓的适用规范与构建说明。
- 部署、客户端自动化及历史事故：按主题读相应skill与memory索引；历史任务状态和授权不作为当前规则。
- 长期架构/操作知识写入对应参考文档；当前进度与验收结论记录到所选工作流的跟踪入口。
```

## 执行顺序与验收

先将质量标准从旧流程移到verification（不新增角色约束），再精简AGENTS/issue-tracker/labels；随后改可选persona及记忆入口，最后将旧workflow与CLAUDE归档。不要一次删除历史事故证据。

迁移验收逐项检查：

1. 完整 Milestone 流程可创建全部受管仓的 milestone 分支，由其指定节点更新 gitlink，实施票不因仍 open 而重复实施。
2. rapid-multi 的单 Issue 可只改一个子仓加伞仓指针，不被迫建立 Milestone、子票或另外两个仓的任务分支；developer 可按配置组装候选。
3. 前端开发自检与独立验证输入分离；后端运行变更按确认时点完成部署/E2E，任何必需检查失败都不能关票。
4. 未改依赖可保持固定旧 SHA；合并后的 SHA 与候选 SHA 不同但有受验 tree/包含映射，不被文档要求追最新 tip。
5. 发布后验收失败保留 publication 和开放 Issue，不重开旧 PR 路径；部分成功只补遗漏。
6. 新会话/resume/compact 的常驻输入无旧 manager 唯一权、[7c]/[9]、无条件全部 dev1、固定角色 memory 必读；归档文档不在自动加载链。
7. 每个按需入口能找到唯一权威技术方法；历史事故按需可查，纯文档改动不触发无关部署。比较常驻入口的字符/行数作为缩减指标，不将其冒称实际 token 节省量。

本轮已按“质量条款提取 → 常驻入口与角色清理 → 技术文档精简 → 工作流配套路由 → 静态/受控检查”完成。小范围真实 Run/部署另按当次用户任务与授权执行；部署版本能力仍需实查，不宣称已经完成真实运行验收。

部署脚本改造和指定 revision 能力仍是独立事项；本次文档与配置修改没有实现这些能力，也未自动授予真实部署权限。
