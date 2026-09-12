/**
 * Fixed dispatch texts shared by the engine (which appends them) and the Judge
 * projection (which must exclude them, A3 R1/AC6).
 */

/** #42 P5 (#46) submission single-source: the user-confirmed consolidated text
 * (absorbs the catalog discipline semantics). Appended to every actor-task
 * dispatch — no token needed, the dispatch lease binds the claim. The trailing
 * note preempts the host's continuable send_message guidance, which the host
 * appends AFTER this text. */
export const SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n结果只通过 node_claim 交付：outcome（completed | failed）+ 唯一 handoff（trim 后 1..8000 字符，END 节点也必须交付），无需 token，绑定由派发自动完成。handoff 是 Judge、Manager、后继与最终结果共用的唯一交接文本：实际完成/失败内容、产物位置与核验依据、剩余问题和后续约束。\nnode_claim 必须是本轮对话的最后一个动作：调用后本 turn 其余输出全部无效，不要再输出文字或调用任何工具；仅输出文字不视为提交，会导致当前 Node BLOCK。\n额度不足、缺少条件或临时无法继续：node_block（reason 说明问题、证据、缺失信息与需要 Manager 决定的事项），不伪报 failed。\n收到 Judge REJECT 后：认可则按意见修正并重新 node_claim；意见与既有 criteria 或可验证事实冲突、超出范围或缺权限时，node_block 说明分歧、证据与需要 Manager 决定的事项，不为迎合判定伪报 failed。\n本轮对话是在node工作节点运行，工作流的交付与推进只认 node_claim，不需要向父会话 send_message 汇报结果，以下汇报的说明可以忽略：`

export const ACTOR_RECOVERY_INSTRUCTION = `\n\n[中断恢复]\n之前中断，请先检查实际完成情况；已完成勿重复副作用，未完继续；不确定/缺权限BLOCK。完成后重新提交 outcome 与完整 handoff。`
export const JUDGE_RECOVERY_INSTRUCTION = `\n\n[中断恢复]\n之前中断；只读核验当前 claim 与实际现场，不补做 Actor 工作。信息不足请 NEED_CONTEXT。`
