# AIChat 伞仓文档解耦方案（仅提案，未修改伞仓）

版本：2026-09-19.2；配套 [coding-workflow 多仓配置](../example/coding-workflow.yaml) 与[交付合同](coding-workflow-contract.md)。本文件是可审查的迁移方案，不是目标伞仓现行规则；本次未修改其 AGENTS、persona、memory、hooks 或部署脚本，也没有验证真实跨仓 GitHub 交付、部署或 E2E。

审查范围：`D:/project/hx/aichatoverview` 的 AGENTS.md、CLAUDE.md、docs/agents/{workflow,issue-tracker,triage-labels,domain}.md、docs/shared/submodules.md、.codex/agents/*.toml、五个角色的 MEMORY.md 索引，以及同步 hook、关票/merge 辅助脚本和部署 skill 的有关段落。未读取凭据文件，未运行任何 GitHub 写操作、部署或工作流。

## 结论

文档应保留项目事实、质量门槛与安全约束，把角色、阶段、路由、分支层次、何时拆票/提交审查/合并/关票、报告落点放到所选工作流。不能仅在 AGENTS 加一句“以工作流为准”就算完成：现有角色 persona 也写死流程，仍会重复注入；旧 memory 索引也会把旧规则重新带回。

当前多仓配置采用全部仓统一 `feature → milestone → baseline`：用户一次确认 baseline、Milestone 名、统一分支名和每仓起点，未改仓也建 milestone 分支。缺子仓 baseline 从所选伞仓 baseline 的 gitlink 建立，已有分支差异展示确认，不擅自移动。选票独占代码穷尽判定，prepare 信任 code-complete，只在伞仓 milestone 提交固定子仓 milestone head 的 gitlink、建立各仓集成 PR，不重扫工单。整体审查/独立测试后先发布子仓、伞仓最后，指针保持受验 SHA，no-change 不造空 PR，部分发布只补未完成仓。全部实施票统一到最终收尾才关闭，不再设置 closeGate；本轮实现依赖以 code-integrated 满足，外部/明确验收依赖/人工 hold 仍保留真实条件。Actor/Judge 信任已验收上游，不重复审查；当前节点仍核对象身份/修订与自身结果。

这些执行选择只写工作流配置，不迁入项目 AGENTS。全部 Issue/Milestone 仍在伞仓，不复制工单、不另建标签节点状态机，环境由 Manager 在有效授权下按需准备。项目固定角色权限冲突仍须处理，配置不能自行修改项目授权；真实客户端、部署就绪与独立 E2E 等质量要求继续有效。

推荐核心加载链：AGENTS → 按操作读取 issue-tracker / submodules / verification；执行流程只从当前冻结的工作流获得。没有工作流时按当前用户任务执行，无需构造 manager、tester、Milestone 才能动手。

## 文件迁移表

| 文件 | 保留 | 移出或改写 |
|---|---|---|
| AGENTS.md | 仓库拓扑、真实远端定位、源码与部署环境、共享资源互斥、凭据边界、代码/测试质量、用户改动保护、条件式文档入口 | §1团队层级、§2的manager唯一调度和阶段分工、§4整段manager章程中的流程、§5固定roster、§8无条件查ready和全部回dev1；改为当前工作流分工 |
| docs/agents/workflow.md | 旧流程作为有日期的历史资料 | 正文移至docs/_legacy/，原入口改为很短的“流程由当前配置定义”；不逐节点复述新YAML；质量条款先迁出再归档 |
| docs/agents/issue-tracker.md | umbrella Issue身份、代码PR仓身份、全限定引用、AI来源声明、gh --body-file和显式-R、分页查询原则 | 一个REQ必建Milestone、固定manager权限、Comment-only review、合并即关、强制两份审查评论；改为流程选定操作人与记录落点 |
| docs/agents/triage-labels.md | label字典、成功close和wontfix区别、人工阻塞保护 | 删除每票恰一category+一状态的强约束（与prd/聚合票不兼容）；PRD定义与Milestone绑定方式归配置；只负责词义，不定义步骤状态机 |
| docs/shared/submodules.md | hook安装、远端可获取gitlink、先子仓push后伞仓、用户工作树保护、同步跳过条件 | “开发前全部checkout跟踪分支”、通配git add frontend server plugins；替换为逐仓检查当前操作授权的分支和精确指针，仅暂存本任务路径 |
| .codex/agents/*.toml | 可选专家能力、读写范围、专业验证方法、构建/技能入口 | 固定派发者、manager裁决唯一权、[7c]/[9]、dev/dev1、禁止任何umbrella指针、固定回报路径；工作流若选用该agent仍遵守当前任务边界；若想保留旧团队模式则显式标legacy，禁止误用 |
| docs/roles/*/memory_history/MEMORY.md | 技术事实和事故教训，按主题按需读 | 五份全读/开工无条件读/每票强制写记忆；旧manager权限和固定分支条目标记历史适用域。增一个薄主题索引，使任意角色可查runtime/deploy/frontend等事实 |
| CLAUDE.md | 到AGENTS的兼容入口 | 虽首行标历史，后面仍包含整套强命令；将全文移到历史目录，根只留入口，避免自动加载双份规则 |
| docs/agents/domain.md | CONTEXT/ADR术语和冲突处理 | 删除要求读workflow.md获取流程的链；改指issue-tracker保存位置，旧历史不自动加载 |

## 必须先消除的矛盾

1. **关闭与验收矛盾**：workflow.md [8]、状态图、收尾五步写合并后立即close；AGENTS close gate和同文后段要求server/plugins运行时变更合入+部署就绪+独立E2E。应只保留后者为完成标准。流程单独记录“代码已整合、验收待办”，不可把Issue OPEN当未实现、把closed当可跳过验收。
2. **分支矛盾**：AGENTS无条件要求全部仓dev1；frontend-dev TOML与Rust专家还写base=dev。多仓Milestone分支不应被初始化/专家切回跟踪分支。项目文档只说明仓库事实、分支保护与安全操作；本Run按用户确认记录每仓baseline、起点、Milestone分支和Issue分支。gitlink应引用受验且已可达的子仓SHA，不强制等于最新baseline tip或merge commit。
3. **角色权力矛盾**：所有label、merge、部署、指针仅manager可做，与DSH配置的coordinator角色冲突。项目保留“仅当前获授权执行者可改”，由工作流指定是谁。
4. **标签语义矛盾**：词典needs-info是等信息，流程却当返工/部署未验；ready-for-human词典是人工实现，正文变业务决策。统一字典，节点进度写Issue评论并交给workflow runtime；人工暂停不因依赖关闭被抹掉。close标签是成功完成标记而非代码合并证明。
5. **跨仓自动关票描述错误**：GitHub支持`Fixes owner/repo#N`，是否自动关闭还受默认分支等条件影响。本流程选用`Implements owner/repo#N`是为避免多PR/部署未验时提前关闭，不能写成GitHub“不支持跨仓关闭”。依据：[GitHub官方](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)。
6. **hook不会替工作流整合指针**：_sync-submodules.sh跳过dirty和非跟踪分支；“同步完成”输出不能证明各仓SHA符合候选。切伞仓分支后逐仓重新读分支/SHA/gitlink，不禁用hook、不force覆盖；保留未纳入范围的子仓。
7. **现有辅助脚本只能辅助**：check-merge-gate.sh将全Issue评论拼接搜aichat-tester、PASS和部署关键词，未绑定同一评论/run/revision且部署缺失仅warn；close-issue.sh无显式仓参数、会先写close标签，旧close命令参数及失败回退也值得单独修正。工作流不可将脚本的GATE PASS替代真实证据；改造方案应接受repo、run、证据链接和revision集合，失败保留待处理状态。
8. **部署skill不天然支持候选集**：deploy-aichat-server当前同步跟踪分支（缺省dev1）。如果工作流要在最终合并前验证Milestone候选，先确认能部署指定SHA/制品；不能用旧dev1部署成功当新候选验收。能力不足应明确BLOCK；以后让部署工具接收不可变revision/制品摘要并返回实际版本证据。

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

本仓是伞仓：frontend（Tauri/Vue/Rust）、server（Java/Spring Cloud）、plugins（Node/TypeScript）为独立Git子模块；共享需求和Issue位于huaaichat/aichatoverview。仓库路径、远端和跟踪分支以.gitmodules及git实查为准。

本文件只规定项目事实、质量和安全边界。节点、角色、执行顺序、分支策略、报告位置及拆票/审查/合并/关票操作由当前工作流配置决定；没有工作流时按当前用户任务执行。选择流程不降低项目质量要求，不自动授予远端写入或部署权限。

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

验证可采用三个静态场景：①不启用工作流的单个文档修订不需要manager/PRD/Milestone；②单仓rapid不被迫创建另两个仓分支；③多仓Milestone由当前配置派出的coordinator可维护标签与指针，不被旧manager唯一权卡住。每个场景仍满足适用的质量、安全、授权门槛。扫描当前入口不可再强制[7c]/[9]、manager唯一权、全部dev1、旧角色必须存在。

本次只提出方案。脚本改造、部署指定revision能力和伞仓文档替换应形成独立、可审查的修改；当前配置不得假定这些已完成。
