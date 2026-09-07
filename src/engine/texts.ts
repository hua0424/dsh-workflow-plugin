/**
 * Fixed dispatch texts shared by the engine (which appends them) and the Judge
 * projection (which must exclude them, A3 R1/AC6).
 */

/** A3 R1 (A1 §7.3 revision): the submission hard constraint appended to every
 * actor-task dispatch — no token needed, the dispatch lease binds the claim. */
export const SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n完成后必须调用 node_claim 提交结果（outcome: completed | failed，handoff 必填且 trim 后 1..8000 字符，END 也必须交付）；无需任何 token，绑定由派发自动完成。\n只提交一份 handoff：实际完成/失败内容、产物位置与核验依据、剩余问题和后续约束；Judge、Manager、后继及最终结果共用该文本。旧 summary/handoffContext 参数不再接受。额度不足、缺少条件或临时无法继续请 node_block，不伪报 failed。\n收到 Judge REJECT 后：认可则按意见修正；若意见与既有 criteria 或可验证事实冲突、超出范围或缺少权限，请调用 node_block，reason 说明分歧、证据、阻碍及需要 Manager 决定的事项，不为迎合判定伪报 failed。\n仅输出文字不视为提交，会导致当前 Node BLOCK。`
