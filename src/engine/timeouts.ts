/**
 * 派发/恢复链路的统一超时 SLO（#21 F1）。
 *
 * 真实 Run 实测暴露的可用性缺陷：恢复/派发链上的 await 无超时，且 Host 侧
 * `new AbortController().signal` 创建后从未 abort（signal 形同装饰），一个卡住的
 * Host 调用会永久 pending 宿主进程。常量集中在此，超时抛出携带阶段名的
 * {@link DispatchTimeoutError}，由调用方降级为 BLOCK/rejected，绝不挂死 Manager turn。
 * 对象可变：测试注入短值。
 */
import { WorkflowError } from '../types.ts'

export const DISPATCH_TIMEOUTS = {
  /** safeToInspect 内部的 agent.whenIdle()（该 API 无 signal，只能放弃等待）。 */
  whenIdle: 60_000,
  /** 冷会话维护物化 agents.resume()（含 preset join）。 */
  coldMaterialize: 60_000,
  /** compactNow 是真实模型调用，窗口更宽裕。 */
  compactNow: 180_000,
  /** 维护物化拆卸 handle.dispose()。 */
  dispose: 30_000,
  /** send/steer 排队投递（queueHostSubagentPrompt）。 */
  send: 60_000,
  /** 会话可用性探针（持久化 inspect）。 */
  availability: 30_000,
  /** startContinuable 冷启动（首次角色派发、Judge spawn）：查表 + 物化 + 准入。 */
  spawn: 60_000,
  /** drainContinuableChildren（无 signal 形参，只能放弃等待并 fail-closed）。 */
  drain: 60_000,
}

/** 阶段超时=技术故障（非业务结论）：reason 必带阶段名，便于诊断与人工接手。 */
export class DispatchTimeoutError extends WorkflowError {
  readonly stage: string
  readonly ms: number
  constructor(stage: string, ms: number) {
    super(`timeout after ${ms}ms at stage "${stage}"`)
    this.name = 'DispatchTimeoutError'
    this.stage = stage
    this.ms = ms
  }
}

/**
 * 给一个 Host await 加超时；超时时 abort 传入的 controller，让 Host 侧 signal 成为
 * 真实中断源（compactNow/queueHostSubagentPrompt 都接受 signal）。`work` 之后的
 * settle 已被 race 接管，不会变成 unhandled rejection。
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, stage: string, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller?.abort()
          reject(new DispatchTimeoutError(stage, ms))
        }, ms)
      }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}
