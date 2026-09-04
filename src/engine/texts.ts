/**
 * Fixed dispatch texts shared by the engine (which appends them) and the Judge
 * projection (which must exclude them, A3 R1/AC6).
 */

/** A3 R1 (A1 §7.3 revision): the submission hard constraint appended to every
 * actor-task dispatch — no token needed, the dispatch lease binds the claim. */
export const SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n完成后必须调用 node_claim 提交结果（outcome: completed | failed，并附 summary）；无需任何 token，绑定由派发自动完成。\n仅输出文字不视为提交，会导致当前 Node BLOCK。`
