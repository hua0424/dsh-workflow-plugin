/**
 * Fixed dispatch texts shared by the engine (which appends them) and the Judge
 * projection (which must exclude them, A3 R1/AC6).
 */

/** A3 R1: the submission hard constraint appended to every actor-task dispatch. */
export const SUBMISSION_CONSTRAINT = `\n\n[提交要求]\n完成后必须调用 node_claim 提交结果（outcome: completed | failed，并附 summary）。\n仅输出文字不视为提交，会导致当前 Node BLOCK。`
