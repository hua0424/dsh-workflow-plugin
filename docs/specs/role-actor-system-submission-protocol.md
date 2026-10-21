# Role Actor 固定提交协议迁入系统 Persona

状态：设计澄清已确认（2026-10-21），待实施。本轮仅编写规格，不代表插件已经实现或部署；未创建跟踪 Issue。

## 1. 问题与目标

当前插件在每次 Role Actor 派发消息末尾追加固定提交要求。用户观察到长上下文任务中多次出现任务结束却未调用 node_claim；历史消息被压缩后，提交要求可能不再完整保留。该相关性不等于已证明所有事故都由压缩导致。

将 Role Actor 的固定提交协议作为插件生成 persona 的一部分，经现有 persona 链路进入系统提示，使其不依赖历史派发消息存续。新 Role 派发消息不再追加同义固定协议。系统提示的持续可见性不是模型服从保证，也不替代派发失败、结束事件遗漏等生命周期修复。

## 2. 已确认范围

- 仅针对采用新实现启动的新 Run；不迁移历史 Run，不热补旧驻留会话，不改冻结定义、历史消息或状态库。
- 覆盖所有非 manager 的 Role Actor，不依赖具体工作流、角色名或用户是否填写 actorCommonPersona。
- Manager 不调整：包括承担 Actor 节点时，继续使用原派发提交要求。本次不新增 Manager system section，不声称覆盖其长上下文问题。
- Judge 的 persona、judge_claim 协议和工具面不调整，不向 Judge 注入 Actor 提交协议。
- Role 协议与业务 persona 一起注入，不新增独立注入检测器、配置开关、降级协议或专用 BLOCK 状态。失败沿用现有派发错误处理；不借本改动重构 preset 服务缺席时的通用降级行为。
- 部署并验证生效后，一次性删除当前用户四个工作流中此前人工加入的节点收尾段落；不开发通用 persona 扫描或自动清洗功能。

## 3. 内容归属

本改动沿用 Role Actor、Manager、Judge、Node Claim、Handoff、BLOCK 等既有领域术语，不新增业务实体。

| 内容 | 权威位置 |
| --- | --- |
| 固定 Actor 提交与收尾协议 | 插件维护的固定文本，经 Role persona 组合入口注入 |
| 公共业务约束和角色职责 | 冻结配置中的 actorCommonPersona 与角色 persona |
| 本节点 input、instruction、合法结果、criteria、修正与恢复事实 | 当次派发消息 |
| Manager 提交要求 | 既有 Manager 派发文本，保持行为不变 |

固定 Role 协议只维护一份。保留原公共 persona 与角色 persona 的内容及相对顺序，在组合后的 persona 中追加固定协议；不要改写用户 YAML 或把协议写入 definitionSnapshot。固定协议不含 runId、token、当前节点结果枚举或其他易变事实。

## 4. 固定协议合同

迁移的是现有 Role 固定提交要求的完整有效语义，不只是“最后调用工具”一句。实现文案可以精简，但须覆盖以下合同：

1. 完成当前节点任务后，以 node_claim({ result, handoff }) 声明结果；result 必须来自本节点声明的合法结果。不新增 outcome、exit、nodeId 等提交参数；node_claim 无需 token，来源由派发绑定。
2. handoff 为 Judge、Manager、后继与最终交付共用的完整交接：实际完成内容、产物位置与核验依据、剩余问题及后续约束。沿用 trim 后 1..8000 字符限制，终局节点同样必填。
3. 额度不足、缺少条件或临时无法继续时，用 node_block 说明问题、证据、缺失信息与所需 Manager 决策，不伪造业务结果。
4. 完成必要操作后，以 node_claim 或 node_block 收尾。工具确认成功后立即结束本 turn，不再追加文字或调用工具；工具拒绝不算成功，按返回原因处理；派发资格失效后停止业务操作，等待 Manager 恢复，不绕过来源校验。
5. 文字总结或向父会话 send_message 汇报不能代替工作流提交。该规则仅限定工作流交付，不禁止任务中必要的协作通信。
6. 收到 Judge REJECT 后，认可则修正并重新提交，可选择另一个合法结果；反馈与既有 criteria 或可验证事实冲突、超范围或缺权限时，node_block 说明分歧与证据，不迎合判定伪报结果。

### 节点收尾核心文案

以下为已确认的行为文案；与上述参数及 REJECT 规则合并时去除同义重复，不叠加两套完整纪律：

> 【节点收尾】
> 以工作流工具成功接收提交作为本轮任务的收尾标准：完成任务后调用 node_claim，将结果、核验依据与剩余事项完整写入 handoff；缺少条件或无法继续时调用 node_block，说明阻塞原因与所需决策。文字总结或向父会话汇报不能代替提交。
>
> 先完成所有必要操作，再将 node_claim 或 node_block 作为本 turn 的最后一个动作；工具确认成功后立即结束，不再追加文字或调用工具。工具拒绝不算提交成功；按返回原因处理，派发资格失效时停止业务操作，等待 Manager 恢复。

不得把“后续输出无效”表述成宿主会自动阻止或撤销后续工具副作用。不得把原派发末尾依赖相邻宿主文案的“以下汇报说明可以忽略”搬入系统提示，改用明确的工作流提交规则。

## 5. 生命周期与派发要求

- 新 Run 的 Role 首次创建、同节点返工/恢复、continuable 跨节点复用均携带同一协议，不重复累加。
- 新实现启动的 Run 在宿主重启后冷恢复仍在本次范围内；“不兼容历史 Run”指不处理升级前启动的 Run，不代表取消正常冷恢复支持。
- 必须覆盖 compactBeforeReuse=false、node_resume skipCompact=true 等不经过压缩的复用路径，不能把 preset 准备仅挂在压缩分支。
- 复用或恢复所需的现有 preset 注册准备应在适当的共享入口完成，不新造另一套生命周期或无授权替换活动会话。
- 普通压缩后协议仍由系统 persona 提供；验收看实际组装结果，不仅检查常量字符串或注册调用。
- Role 派发保留动态任务与合同，移除固定提交协议副本；Manager 派发保留原要求。
- 不修改 claim/block 授权、工作单资格、安全收口、Judge 判定或结果路由规则。

## 6. 实现定位与边界

已调查的修改落点（供实施核对，不规定新的抽象层）：

- `src/engine/texts.ts`：固定协议文本与现有 Actor/Manager 派发要求。
- `src/roles/roles.ts`：roleActorPersona 组合入口，保持 Judge 分支隔离。
- `src/plugin/host.ts`、`src/plugin/presets.ts`：生成/注册派生 persona，以及普通复用和冷恢复的准备路径。
- `src/engine/engine.ts`：按执行身份保留 Manager 派发协议，停止向 Role 派发追加固定协议。
- `src/judge/projection.ts`：确认新 Role 派发无固定协议污染，Manager 现有文本剥离仍有效。

不为历史 Role 消息新增兼容器或迁移器。已有剥离代码可在不影响 Manager 当前行为的前提下保留或精简；不要为“清理旧常量”误删 Manager 仍在使用的规则。不开启独立 Manager system section，不为 complete persona 等其他入口扩建设计。

## 7. 用户配置清理与交付顺序

插件实现和验证完成前，不提前删除用户配置中的临时纪律。顺序为：实现与验证 → 获授权部署 → 核实新 Run 的系统 persona → 备份并清理四个配置 → 验证配置差异。

本机一次性清理对象：

- `C:/Users/hua/.dsh/workflows/coding-workflow.yaml`
- `C:/Users/hua/.dsh/workflows/coding-workflow-rapid.yaml`
- `C:/Users/hua/.dsh/workflows/coding-workflow-single.yaml`
- `C:/Users/hua/.dsh/workflows/coding-workflow-single-rapid.yaml`

仅删除本次讨论中添加到 actorCommonPersona 开头的完整原文段落。执行时重新读取并确认匹配；内容已被用户改写时不得模糊删除。保留其他 persona、模型、节点和 YAML 内容。已有备份目录 `C:/Users/hua/.dsh/workflows/bak/node-closure-20261021/` 不覆盖，清理前另保留当时版本。校验四份 YAML 可解析，且除目标段落外无变化。

该清理不修改已有 Run 的冻结快照。规格确认不等同于本轮已授权立即部署或操作真实 Run。

## 8. 验收条件

1. **系统层存在**：支持的实际宿主组合中，新 Run 的 Role 最终系统 persona 包含完整固定协议且仅一次；用户公共/角色 persona 内容保留。
2. **无需配置**：actorCommonPersona 缺省时仍注入；无新增 YAML 字段或用户开关。
3. **压缩稳定**：至少一个真实宿主验证在实际压缩前后组装系统提示，协议均存在；无法运行时明确报告未验，不用字符串单测代替。
4. **复用稳定**：首次、REJECT 返工、BLOCK 恢复、continuable 跨节点、跳过压缩与冷恢复路径不丢失或累加协议；至少覆盖无压缩路径的注册准备回归。
5. **派发去重**：新 Role 派发无固定提交要求副本，但合法结果、criteria、instruction、handoff 与恢复/修正材料完整。
6. **身份隔离**：Manager 派发行为保持原样；Judge 未注入 Actor 协议；其他非工作流会话不受影响。
7. **投影正确**：新 Role transcript 和现有 Manager transcript 经 Judge 投影处理，不引入固定协议泄漏或误删业务证据。
8. **状态不变**：不改 schema、状态格式、冻结合同、提交权限及 BLOCK/REJECT 业务语义。
9. **清理准确**：部署生效后四个用户配置仅去除确认的临时段落，YAML 解析通过，有备份。

实施验证沿用项目 `pnpm run verify`；真实宿主验证与受控测试分别报告。为新增组合/派发分支保留最小可运行回归测试，不新增测试框架，不接入真实 provider 请求作为单元测试前提。

## 9. 非目标

- 修复或宣称解决 #220–225 的全部事故；尤其不替代 #221 生命周期观察闭环。
- 保证模型一定提交或自动把 closing message 转成 claim。
- Manager 系统协议迁移、Judge 协议改造、历史 Run 热升级。
- 新增 force-rebuild、超时抢交、提交资格放宽或通用 persona 清洗器。
- 本规格阶段修改插件源码、部署运行环境、删除用户配置或运行真实工作流。
