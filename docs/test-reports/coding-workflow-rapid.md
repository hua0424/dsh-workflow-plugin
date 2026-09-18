# coding-workflow-rapid 验证记录

> 以下创建与精简记录为历史现场；当前调整见文末「GitHub Issue 主跟踪」。

日期：2026-09-18。创建独立四节点轻量配置与合同，未修改原工作流、共享 INDEX 或生产代码；未启动 Run、操作真实 Issue/PR、部署插件或修改状态库。

- 配置：`docs/example/coding-workflow-rapid.yaml`；合同：`docs/dsh-workflow/coding-workflow-rapid-contract.md`。
- 初次以 CreateNew 写入 `C:/Users/hua/.dsh/workflows/coding-workflow-rapid.yaml`。提示词精简后校验旧哈希再同步，保留用户关于 Actor 自述/Manager 补证的措辞意图；与仓库示例字节一致。当前 SHA256：`897042eef24fd3fc0ee0d77f9c4c8135bf1862005ef9b0f1b140a888ba91929c`。
- 真实 parseCatalogConfig + validateAndNormalize：v3 合法，4 节点，0 warnings。插件硬约束首节点为 manager，所以由 Manager 初始化，coordinator 合并；不增加节点。Manager 无可配置 Role persona，初始化约束落入当前 instruction 与 Judge criteria。
- `pnpm run typecheck`：通过。
- `node --test --test-isolation=none test/coding-workflow.test.ts test/coding-workflow-rapid.test.ts`：11/11 通过，0 fail/skip；其中新增 4 项覆盖交付、返工、批准漂移重审、非法结果与 Judge REJECT 不推进。
- 测试使用真实 Engine 和临时 SQLite，模型判定受控。只证明路由与协议行为，不证明模型能正确理解自然语言、真实 Git/GitHub 操作或并发合并安全；本次未运行真实宿主端到端测试或全量 suite。
- 独立合同/配置审查发现合并并发窗口的验收缺口，已补充实际合并起点等于 approvedBase 的主动核验及 delivered 条件。配置不能原子锁住远端 base；事后发现竞态 BLOCK，不伪称未产生副作用。
- 本次只读检查 `C:/Users/hua/.dsh/profiles/web/wfdev/lib/types.js` 已声明 v3；这不证明正在运行的进程已重载该产物。启动前使用 v3 插件及适用状态库，仓库必须提供本合同和通用 INDEX。

正常路径四次业务节点执行，相比 coding-workflow 单 Issue 的两级 PR 流程减少规划、选票、子流程交接、独立裁决和集成阶段。实际 token 收益未测量，不宣称固定节省比例。

## 提示词精简复核（合同 2026-09-18.2）

- 应用 writing-for-agents：persona 保留职责、入口、权限边界和一句提交纪律；instruction 仅写节点动作及每种 result 的产物/handoff；异常操作按标题读取专属合同。
- 节点 instruction 字符合计由 2235 降至 1171（约 48%），不是 token 实测或模型遵循率评估。persona 未因迁入细节而膨胀。
- 逐节点比较确认 checker/criteria/results/target 均与精简前一致，未降低验收要求。解析零警告，11 项相关路由测试重新通过。未改生产代码，无需为纯文本重写增加实现镜像测试。
- 独立复核补回合同中用户明确的“不管理 Milestone”边界，其余动作及交接完整。
- 源码核实：SUBMISSION_CONSTRAINT 每次拼入派发上下文，不是 Role system；保留 persona 中一句“提交为最后动作”补足层级。当前没有共用 persona 字段，也没有覆盖所有工具的 claim 后封锁，不将提示纪律描述成外部副作用可撤销的技术保证。
- 后续最小插件建议：可选 actorCommonPersona 拼入 Role Actor 的系统 persona，Judge 不自动继承执行者写入/提交义务；Manager 仍需单独评估宿主系统注入能力。不添加模板继承或 include 机制。该改造本次未实施。

## 公共 persona 与合同一致性优化（合同 2026-09-18.3）

- 依据更新后的 `docs/example/README.md`，将 Role 的入口、范围/权限、材料、交接和一句终止纪律集中到 `actorCommonPersona`。Manager/Judge 不继承该字段，保留独立约束；通用 INDEX 未修改，插件源码未修改。
- 以用户现行 catalog 为基准，保留模型路由、developer 的 continuable、技能偏好、Issue 评论及返修先核实/反证要求；同步仓库示例的业务配置，但保留示例原模型路由。两份配置除 model 外的归一化结构相同，已用断言检查。
- 修复 live 缺失的 `merge.stale-review → review`，把终局节点结果统一为合同约定的 `delivered`；正常路径仍为四节点，不增加模型调用步骤。
- 初始化改为先确认目标与授权，再核验/建任务分支、处理忽略规则、写运行材料。补全 implemented 的实现/真实验证/差异边界条件与 review 的证据处置条件；允许具体反证进入 reviewer，不将反证当批准。
- 远端留痕只在同一执行、修订及输入/结论均未变的重入复用；新反证/验证证据即使不改变 head，也更新摘要并按新审查输入开轮次。独立复核提出的此歧义已修复。
- 候选与示例通过项目原生 catalog 校验，0 warnings；11 项现有相关测试通过（`node --test --test-isolation=none test/coding-workflow.test.ts test/coding-workflow-rapid.test.ts`），覆盖交付、返工、漂移重审、非法结果/REJECT 和相关子流程路由。未运行真实模型/GitHub 端到端流程，不把受控测试视为提示词遵循率验证。
- 写入前校验 live 原文件 SHA256，备份为 `C:/Users/hua/.dsh/workflows/coding-workflow-rapid.yaml.before-common-persona-20260918-162701.bak`，写入后与候选逐字节哈希一致。live definitionHash：`c58171c72792a907f6db55452d5ea7be0b8e556fadcfdad8103cc30788fd6d87`；示例 definitionHash：`2596fc0f7541a9e7f0b66526d0d6ca61fd131d75323b72134f6bab97415c5e13`。
- 配置与合同仅供新 Run 采用；未启动、终止或迁移现有 Run，未改状态库或部署插件。公共 persona 每个 Actor 仍会收到，去重收益是规则一致性；实际 token 收益未测量。

## GitHub Issue 主跟踪（合同 2026-09-18.4）

- 按用户要求重新组织 rapid：Issue 正文/授权澄清承载规格，初始化/实现/审查/合并前核验/交付用同 Issue 评论跟踪，handoff 传 Issue、真实 runId、初始化及当前证据评论 URL。PR 保留必要摘要与链接，不复制整套记录。
- 已读取上游 [setup 技能](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/SKILL.md) 及 [GitHub tracker 模板](https://github.com/mattpocock/skills/blob/main/skills/engineering/setup-matt-pocock-skills/issue-tracker-github.md)。本仓库已有 GitHub tracker 设置，未重跑 setup 问答或改 AGENTS/CLAUDE/通用 INDEX。
- 去除强制 run.md、合同快照、rNNN-review 本地文件及 completion.md。普通审查报告直接是 Issue 评论；长报告才按需建 ignored runDir，评论登记结论/修订、workspace、绝对与相对路径及 SHA256。缺少未使用的本地文件不阻塞；跨环境确需全文时才补证。
- 初始节点不再为跟踪创建目录或 .gitignore 提交。归属按真实 runId 和前序评论链接核对，最近几条评论不是完整历史；同输入重入复用，反证/验证变化即使同 SHA 也开新审查轮次。
- 合并前核验必须先发布评论，再紧邻操作重查并条件合并；远端写入不确定先查询，不能把本地草稿或事后核验当作已发布证据。实际已合并/自动关票的重入只核验补收尾。
- 独立审查提出批准后同 SHA 新证据边界：已将 stale-review 条件扩展为修订漂移，或既定验收内有效批准未覆盖的新失败验证/实质反证。普通进度不触发重审，范围变更仍 BLOCK。
- 候选与示例经原生 parser/static validation 校验零警告；11 项既有相关路由测试通过，0 fail/skip。断言确认四节点/结果目标、模型路由、reuse 和 Judge 工具配置未改变，示例与实际候选除模型外相同；git diff --check 通过。自然语言判定未通过真实模型或 GitHub 端到端运行验证。
- 最终候选 definitionHash：`accc681a6d62a0e401aee9a399c8d895d48ea11227f81b31694d242a83ca12a6`；示例：`64b04d44ed25a4ab646c9ef7b545b688df7a3fe58a7641bc1bdf13d1873d0201`。不宣称固定 token 节省比例；减少的是正常节点的强制本地材料读写与重复台账。
- 已核对 live 原哈希后写入，并验证与候选哈希一致；原配置备份为 `C:/Users/hua/.dsh/workflows/coding-workflow-rapid.yaml.before-issue-tracking-20260918-170049.bak`。未操作真实 Issue/PR、启动或迁移 Run、修改状态库或部署插件；只对新 Run 生效。
