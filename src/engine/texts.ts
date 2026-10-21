/**
 * Fixed dispatch texts shared by the engine (which appends them) and the Judge
 * projection (which must exclude them, A1 R3/A3 R1/AC6).
 */

/**
 * Issue #226：Role Actor 固定提交协议（系统 persona 版）。经
 * `roleActorPersona`（src/roles/roles.ts）拼入每个 Role Actor 的 system
 * persona，随派生 preset 挂载——压缩/冷恢复后依然有效，因此每次派发不再
 * 重复追加。
 *
 * 合约覆盖：node_claim 提交（参数与 token 规则）/ handoff 唯一交接 /
 * node_claim 或 node_block 作为最后一个动作（工具确认成功即结束）/
 * 缺少条件 BLOCK（不伪报）/ Judge REJECT 后返工或分歧 BLOCK /
 * 文字总结不能代替提交（不禁止任务必需的协作通信）。
 *
 * 稳定性约束：只用稳定名词——不出现 runId、token 实值、结果枚举值，不搬
 * 派发尾的 send_message 忽略句；"最后一个动作"只表述 Actor 自律，不表述
 * 宿主会自动阻止或撤销后续输出。
 */
export const ROLE_ACTOR_SUBMISSION_PROTOCOL = `【Role Actor 固定提交协议（系统级，长期有效）】\n完成当前节点任务后，以 node_claim({ result, handoff }) 声明结果：result 取自本节点声明的合法结果，不使用 outcome/exit/nodeId 等其他提交参数；node_claim 无需 token，来源由派发绑定自动完成。\nhandoff 是 Judge、Manager、后继与最终交付共用的完整交接：实际完成内容、产物位置与核验依据、剩余问题及后续约束；终局节点同样必填。\n完成必要操作后，以 node_claim 或 node_block 作为本 turn 的最后一个动作；工具确认成功后立即结束，不再追加文字或调用工具。工具拒绝不算提交成功，按返回原因处理；派发资格失效后停止业务操作，等待 Manager 恢复。\n额度不足、缺少条件或临时无法继续时，用 node_block 说明问题、证据、缺失信息与需要 Manager 决定的事项，不伪报业务结果。\n文字总结或向父会话汇报不能代替工作流提交；本约束只限定工作流交付，不禁止任务必需的协作通信。\n收到 Judge REJECT 后：认可则修正并重新提交，可选择另一个合法结果；反馈与既有 criteria 或可验证事实冲突、超出范围或无权限执行时，用 node_block 说明分歧、证据与需要 Manager 决定的事项，不迎合判定伪报结果。`

/** v3 提交单源：结果只通过 node_claim 交付，且只接受 { result, handoff }。
 * Issue #226 后不再追加到新派发（Role 协议已迁入 system persona，Manager
 * 派发用 MANAGER_SUBMISSION_CONSTRAINT）；保留该常量及变体集合，仅用于
 * 历史转录的投影剥离——无需 token，绑定由派发租约自动完成。末尾一句
 * 先占宿主 continuable 的 send_message 汇报指引（宿主会在本段之后追加）。 */
export const SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n结果只通过 node_claim 交付：result（必须是本节点已声明的结果名之一）+ 唯一 handoff（trim 后 1..8000 字符，终局节点也必须交付），无需 token，绑定由派发自动完成。不接受 outcome/exit/nodeId 或额外业务字段。\nhandoff 是 Judge、Manager、后继与最终结果共用的唯一交接文本：实际完成内容、产物位置与核验依据、剩余问题和后续约束。\nnode_claim 必须是本轮对话的最后一个动作：调用后本 turn 其余输出全部无效，不要再输出文字或调用任何工具；仅输出文字不视为提交，会导致当前 Node BLOCK。\n额度不足、缺少条件或临时无法继续：node_block（reason 说明问题、证据、缺失信息与需要 Manager 决定的事项），不伪报结果。\n收到 Judge REJECT 后：认可则按意见修正并重新 node_claim（可改选另一个合法结果）；意见与既有 criteria 或可验证事实冲突、超出范围或缺权限时，node_block 说明分歧、证据与需要 Manager 决定的事项，不为迎合判定伪报结果。\n本轮对话是在node工作节点运行，工作流的交付与推进只认 node_claim，不需要向父会话 send_message 汇报结果，以下汇报的说明可以忽略：`

/**
 * Issue #200（并入原 #204）：manager 变体——删除 Actor 视角句与悬空占位句
 * （末句「本轮对话是在 node 工作节点运行……以下汇报的说明可以忽略：」），其余
 * 条款逐条保留。manager 派发不再携带 Actor 视角协议；Issue #226 后 actor 派发
 * 不再追加任何固定后缀（Role 协议已迁入 system persona）。
 */
export const MANAGER_SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n结果只通过 node_claim 交付：result（必须是本节点已声明的结果名之一）+ 唯一 handoff（trim 后 1..8000 字符，终局节点也必须交付），无需 token，绑定由派发自动完成。不接受 outcome/exit/nodeId 或额外业务字段。\nhandoff 是 Judge、Manager、后继与最终结果共用的唯一交接文本：实际完成内容、产物位置与核验依据、剩余问题和后续约束。\nnode_claim 必须是本轮对话的最后一个动作：调用后本 turn 其余输出全部无效，不要再输出文字或调用任何工具；仅输出文字不视为提交，会导致当前 Node BLOCK。\n额度不足、缺少条件或临时无法继续：node_block（reason 说明问题、证据、缺失信息与需要 Manager 决定的事项），不伪报结果。\n收到 Judge REJECT 后：认可则按意见修正并重新 node_claim（可改选另一个合法结果）；意见与既有 criteria 或可验证事实冲突、超出范围或缺权限时，node_block 说明分歧、证据与需要 Manager 决定的事项，不为迎合判定伪报结果。`

/** Judge 投影剥离按变体集合匹配（整段精确后缀剥离不变式保持）。 */
export const SUBMISSION_CONSTRAINT_VARIANTS = [SUBMISSION_CONSTRAINT, MANAGER_SUBMISSION_CONSTRAINT]

export const ACTOR_RECOVERY_INSTRUCTION = `\n\n[中断恢复]\n之前中断，请先检查实际完成情况；已完成勿重复副作用，未完继续；不确定/缺权限BLOCK。完成后重新提交 result 与完整 handoff。`
export const JUDGE_RECOVERY_INSTRUCTION = `\n\n[中断恢复]\n之前中断；只读核验当前 claim 与实际现场，不补做 Actor 工作。信息不足请 NEED_CONTEXT。`

/**
 * Issue #173：Run 本地材料目录（单源）。用该 Run 已绑定的 workspace + runId
 * 计算，不猜测 cwd、不推断 Git 根、不改用户目录。
 */
export function runArtifactsDir(workspace: string, runId: string): string {
  return `${workspace.replace(/[/\\]+$/, '')}/.dsh/.dsh-workflow/runs/${runId}/`
}

/**
 * Issue #173：每次派发给 Manager、Actor、Judge 时统一附带的简短规则。
 * 调用方把它放在 `[instruction]` 之后、固定后缀之前（Manager 派发是
 * MANAGER_SUBMISSION_CONSTRAINT；Issue #226 后 Role 派发无固定后缀，
 * 材料段即结尾）——投影按 `[instruction]` 截断（compressDispatchToHandoff），
 * 末尾固定后缀剥离（stripSubmissionConstraint）都不受影响。
 */
export function runMaterialsSection(workspace: string, runId: string): string {
  return `\n\n[run-materials]\nrunId: ${runId}\ndir: ${runArtifactsDir(workspace, runId)}\n本地临时材料放该目录，按需创建；不预建空报告，不强制生成 run.md。应写 Issue/PR 或提交 Git 的项目文档保持原归属不变。`
}
