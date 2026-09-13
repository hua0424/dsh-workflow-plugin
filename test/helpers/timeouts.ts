import { DISPATCH_TIMEOUTS } from '../../src/engine/timeouts.ts'

/** #21 F1 故障注入：把统一超时 SLO 压到毫秒级，结束后恢复。 */
export async function withShortTimeouts(values: Partial<typeof DISPATCH_TIMEOUTS>, body: () => Promise<void>): Promise<void> {
  const saved = { ...DISPATCH_TIMEOUTS }
  Object.assign(DISPATCH_TIMEOUTS, values)
  try { await body() } finally { Object.assign(DISPATCH_TIMEOUTS, saved) }
}

/** #55 故障注入：压掉 compact 重试间隔，避免单测被真实退避拖成秒级。 */
export async function withFastCompactRetry<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.DSH_WF_COMPACT_RETRY_MS
  process.env.DSH_WF_COMPACT_RETRY_MS = '1'
  try { return await body() } finally {
    if (saved === undefined) delete process.env.DSH_WF_COMPACT_RETRY_MS
    else process.env.DSH_WF_COMPACT_RETRY_MS = saved
  }
}
