/**
 * Fixed dispatch texts shared by the engine (which appends them) and the Judge
 * projection (which must exclude them, A3 R1/AC6).
 */

/** v3 提交单源：结果只通过 node_claim 交付，且只接受 { result, handoff }。
 * 追加到每次 actor-task 派发——无需 token，绑定由派发租约自动完成。末尾一句
 * 先占宿主 continuable 的 send_message 汇报指引（宿主会在本段之后追加）。 */
export const SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n结果只通过 node_claim 交付：result（必须是本节点已声明的结果名之一）+ 唯一 handoff（trim 后 1..8000 字符，终局节点也必须交付），无需 token，绑定由派发自动完成。不接受 outcome/exit/nodeId 或额外业务字段。\nhandoff 是 Judge、Manager、后继与最终结果共用的唯一交接文本：实际完成内容、产物位置与核验依据、剩余问题和后续约束。\nnode_claim 必须是本轮对话的最后一个动作：调用后本 turn 其余输出全部无效，不要再输出文字或调用任何工具；仅输出文字不视为提交，会导致当前 Node BLOCK。\n额度不足、缺少条件或临时无法继续：node_block（reason 说明问题、证据、缺失信息与需要 Manager 决定的事项），不伪报结果。\n收到 Judge REJECT 后：认可则按意见修正并重新 node_claim（可改选另一个合法结果）；意见与既有 criteria 或可验证事实冲突、超出范围或缺权限时，node_block 说明分歧、证据与需要 Manager 决定的事项，不为迎合判定伪报结果。\n本轮对话是在node工作节点运行，工作流的交付与推进只认 node_claim，不需要向父会话 send_message 汇报结果，以下汇报的说明可以忽略：`

export const ACTOR_RECOVERY_INSTRUCTION = `\n\n[中断恢复]\n之前中断，请先检查实际完成情况；已完成勿重复副作用，未完继续；不确定/缺权限BLOCK。完成后重新提交 result 与完整 handoff。`
export const JUDGE_RECOVERY_INSTRUCTION = `\n\n[中断恢复]\n之前中断；只读核验当前 claim 与实际现场，不补做 Actor 工作。信息不足请 NEED_CONTEXT。`

/**
 * Issue #173：Run 本地材料目录（单源）。用该 Run 已绑定的 workspace + runId
 * 计算，不猜测 cwd、不推断 Git 根、不改用户目录。
 */
export function runArtifactsDir(workspace: string, runId: string): string {
  return `${workspace.replace(/[/\\]+$/, '')}/.dsh-workflow/runs/${runId}/`
}

/**
 * Issue #173：每次派发给 Manager、Actor、Judge 时统一附带的简短规则。
 * 调用方把它放在 `[instruction]` 之后、`SUBMISSION_CONSTRAINT` 之前——投影按
 * `[instruction]` 截断（compressDispatchToHandoff），末尾固定后缀剥离
 * （stripSubmissionConstraint）都不受影响。
 */
export function runMaterialsSection(workspace: string, runId: string): string {
  return `\n\n[run-materials]\nrunId: ${runId}\ndir: ${runArtifactsDir(workspace, runId)}\n本地临时材料放该目录，按需创建；不预建空报告，不强制生成 run.md。应写 Issue/PR 或提交 Git 的项目文档保持原归属不变。`
}
