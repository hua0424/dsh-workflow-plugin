# coding-workflow 使用说明

版本：2026-09-19.2。本配置只用于伞仓与子仓组成的多仓 Milestone 交付；单仓使用 [coding-workflow-single.yaml](../example/coding-workflow-single.yaml)。多仓配置见 [coding-workflow.yaml](../example/coding-workflow.yaml)，详细规则见[合同](coding-workflow-contract.md)。

## 启动与确认

在伞仓根核对工作区干净及已有主 Issue/子票，实际插件须支持 v3 命名结果、Child 返回和 actorCommonPersona。将配置放入 catalog，用 `/dsh-flow list` 校验，再 `/dsh-flow start coding-workflow`；不在子仓并行启动另一个 Run，也不用 reset 代替外部收尾。

Manager 优先复用已有票；必要时用实际可用的 to-tickets 或项目等价 to-issues 拆票。用户一次确认 baseline、Milestone 名、统一 milestone 分支名与每仓起点。缺失的子仓 baseline 从伞仓所选 baseline 的 gitlink SHA 建立；已有 baseline 与 gitlink 不同则展示差异确认，不移动已有分支。

伞仓 baseline 缺失时也须明确创建起点。伞仓和全部子仓都创建并推送统一命名的 milestone 分支，包括未改仓；显式切换，不修改 .gitmodules 长期跟踪分支。全部 Issue/Milestone 留在伞仓，PR 按代码仓划分。每仓都是 feature → milestone → baseline；无差异不建空 PR。

## 执行与信任

正常路径：初始化与拆票 → 选票 → 实现/审查/按需独立单票测试 → 合入目标仓 milestone → 再选票 → prepare-integration → 整体审查 → 独立集成测试 → publish-integration → 统一关闭收尾。

实施票合入 milestone 后记 code-integrated，保持 open，到最终一起关闭。本轮实现依赖按前置 code-integrated 推进；外部依赖、明确验收依赖、人工 hold 仍需满足真实条件。初始化解决依赖与最终关票形成的等待闭环，不新增标签节点状态机。

选票独占任务穷尽判定。prepare 信任 code-complete，不扫工单、不检查剩余任务、没有 work-remaining；范围变化由 Manager 处理。各 Actor/Judge 信任已验收上游，只核本节点动作的当前对象、修订和结果，减少重复审查与全历史读取。

## 候选与发布

prepare 固定全部子仓 milestone head，在伞仓 milestone 提交这些受验 gitlink，创建各仓 milestone → baseline PR。版本集合包含各仓固定 base/head/待测 tree、PR 或 no-change、未改依赖及制品映射，先提交候选再审查/测试。

publish 先所有子仓、最后伞仓，逐仓证明实际 merge tree 与受验 tree 相同，baseline 包含受验 SHA。伞仓指针保持原测试 SHA，不追逐子仓 merge commit 或最新 tip。no-change 使用固定 baseline SHA/tree，不造空 PR；尚待确认的基线漂移也适用发布前的失效处理。重试先区分已完成与待发布仓，不把本次成功合并造成的基线前进当作漂移。

publication 逐仓记录不可变发布结果。部分发布成功后只补未完成仓；已有仓合并时不能 stale-review 回 prepare，实质问题 BLOCK 交 Manager。尚未发布时，整体审查/测试/发布发现候选失效可回 prepare。产品必修问题由 planner 规划修复票再回实施循环。

close-milestone 只依据 publication 统一关票/Milestone 和恢复工作区，不重新发布或改指针。后续基线正常前进不改变已发布事实；缺证据或新增范围 BLOCK。

## 质量与材料

项目真实客户端自检、独立合并前验证及部署就绪/独立 E2E 门槛保持不变，环境由 Manager 在有效授权下按需协调，不设必经环境节点。部署脚本必须能证明实际运行版本对应候选；不能拿旧 baseline 的通过代替 milestone 验收。纯文档按适用检查验证。

普通证据写伞仓 Issue，handoff 传精确链接；只把复杂长报告放 ignored、未跟踪 run 目录，Issue 登记摘要、版本与路径。不要求 run.md/合同副本，不重复维护节点标签状态机。保护用户改动、hook 后核版本、先子仓推送后伞仓；单例客户端互斥。

公共 persona 只注入 Role Actor，Manager/Judge 独立配置。冻结 YAML 决定当前流程；root delivered 才表示全部交付。新配置只影响新 Run，single 备份不变。AIChat 旧文档本次未改，权限与旧流程冲突见[解耦方案](aichatoverview-workflow-decoupling-proposal.md)。尚未完成真实多仓 GitHub 交付、部署或 E2E 实测。
