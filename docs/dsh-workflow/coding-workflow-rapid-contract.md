# coding-workflow-rapid：单仓 GitHub Issue 跟踪合同

版本：2026-09-20.1；协议：agent-workflow/v3。单仓、单 Issue、单 PR、四节点，不负责拆票或 Milestone。配置见 [coding-workflow-rapid.yaml](../example/coding-workflow-rapid.yaml)。YAML 是执行依据，本合同只作说明，不额外增加 Judge 门槛。

## 职责与信任

| 节点 | 结果 | 后继 |
|---|---|---|
| initialize（Manager） | ready | implement |
| implement（developer） | implemented | review |
| review（独立 reviewer） | approved | merge |
| review | changes-required | implement |
| merge（coordinator） | delivered | 返回 delivered |

各节点消费前序经 Judge ACCEPT 的 handoff，信任上游已验收结果，不重新审查上游或全流程巡检。Actor/Judge 只核验本阶段职责、操作对象的当前身份/修订和实际结果。merge 没有 stale-review 出口，不决定重审；当前操作异常以 node_block 携 handoff 交 Manager 处理。

actorCommonPersona 只注入 Role Actor system，Manager/Judge 使用各自规则。节点提交协议由插件统一注入；命名结果通过 Judge 后才推进。completed 本身不等于业务交付。

## 初始化与实现

Manager 先核对干净工作树/索引及本仓身份，再读取 Issue 的范围、依赖和验收。需求不清时用实际可用的 grill-with-docs 澄清；复杂到需要拆票或多阶段调度时 BLOCK，由 Manager 协调切换完整流程，不能硬塞进快速链路。

用户确认本次基线与目标；缺失基线须明确创建来源。已有明确决定可沿用，不重复询问。建立或核验复用开发分支，记录原始 baseCommit，创建、推送并切换到该分支后发布初始化评论。分支身份不明或用户已有改动需先处理，不自动认领其他任务分支或重置工作树。

developer 遵循 Ponytail 的最小可行实现，按需使用实际 implement、TDD/诊断能力，完成本票及当前返工，运行项目要求的验证后提交推送 PR。技能不扩大授权，不虚构未执行的能力；必需环境或验证缺口 BLOCK。实施结果交给独立 review，不自行合并关票。

review 审查当前实现与验收，核对本轮验证和必修项；增量审查可复用明确证据，覆盖变化及交互。明确可执行的产品必修项走 changes-required，其他权限、环境、证据或范围问题 BLOCK。通过时记录确切 approvedBase/approvedHead 和结果入口；内部批准不替代 GitHub 分支保护要求。

## merge 只执行合并与收尾

coordinator 直接消费 approved handoff，读取其中的目标 PR、approvedBase/approvedHead、合并方式和必要操作信息，不重新阅读评判 review、搜索新反证或决定是否再审。已知输入矛盾和当前操作异常交 Manager，不借合并节点扩大职责。

开放 PR 只检查本次操作需要的当前仓库/PR 身份、base/head、仓库 checks/保护及合并条件。对象或修订变化、冲突、检查/权限问题等，以 node_block 记录事实和当前 handoff，交 Manager 处理；不合并、不擅自关票、不路由回 review。

项目规定的合并方式优先，无规定默认 squash，不自动删分支。合并前成功发布核验评论，紧邻操作读取 base/head，使用工具支持的 head 条件保护；此条件不原子锁定 base，仍保留仓库保护。远端结果未知先查当前 PR，不重复执行。

合并后核验实际起点与 approvedBase 一致：squash/merge 核对 mergeCommit 第一父，rebase 使用可追溯提交链或可靠远端证据。目标须包含 mergeCommit，merge 方式还须包含批准 head。不能证明或结果不符时如实 BLOCK，不自动回滚或手动关票；已经发生的自动关票也如实记录。

已合并 PR 在重入时仅按本次原批准、合并前记录及实际合并结果补收尾，不因目标分支正常推进而重审或重并。核验成功后发布交付记录，关闭 Issue（已关闭则核实复用），安全切回并快进目标分支、完成工作区收尾后 delivered。评论、关票或本地切换失败保留远端事实，只补遗漏步骤。

## 远端证据与交接

规格、进度、自测、审查及交付集中在 GitHub Issue；沿用项目已有 tracker、CONTEXT/ADR 等约定，不重新 setup。评论绑定 workflowId/runId、阶段、对象/修订和相关入口，PR 留必要摘要与链接。初始化记录仓库/workspace、范围/验收/授权、分支与原始起点、合并方式和版本；实现、review、合并分别记录各自结果，不复制整份上游报告。

handoff 传 Issue URL、runId、初始化及当前结果评论 URL、PR/确切修订、后续操作所需约束。按精确链接读取当前职责所需信息，不倾倒全历史。Issue 评论是证据入口，不代替本节点动作的真实结果。

多行正文用临时文件及 --body-file，gh 明确仓库并采用非交互参数。发布结果未知先查询，同执行/输入/结果可复用；新结果追加并保留历史。GitHub 不可用则 BLOCK，不能将本地草稿冒充远端留痕；无法发阻塞评论时先把事实写入阻塞原因。不记录凭据或未脱敏日志。

## 本地材料与生效范围

不要求 run.md、合同副本、本地普通审查文件或 completion.md。仅确需复杂长报告时写本仓 ignored、未跟踪目录，默认 docs/dsh-workflow/runs/<runId>/；首次落文件确认路径和忽略状态，不预建空报告、不擅自取消跟踪。

Issue 留报告摘要、适用版本、workspace、绝对/相对路径及内容标识；本地路径不是异机下载链接，关键结果须在远端可读。developer 如需最小忽略规则变更，纳入本次实现和审查；reviewer/coordinator 不为报告创建代码提交。正式规格和长期设计仍按项目约定维护。

强推、硬重置、绕过保护、部署、扩范围/拆票/子仓改动不因启动快速流程自动获准。Manager 接收 BLOCK 后按有效授权处理，不代 Judge 宣布通过。新配置只供新 Run，不改已有冻结定义或旧材料；文档/静态校验不代表真实 GitHub 合并或交付已执行。
