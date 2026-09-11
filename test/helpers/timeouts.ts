import { DISPATCH_TIMEOUTS } from '../../src/engine/timeouts.ts'

/** #21 F1 故障注入：把统一超时 SLO 压到毫秒级，结束后恢复。 */
export async function withShortTimeouts(values: Partial<typeof DISPATCH_TIMEOUTS>, body: () => Promise<void>): Promise<void> {
  const saved = { ...DISPATCH_TIMEOUTS }
  Object.assign(DISPATCH_TIMEOUTS, values)
  try { await body() } finally { Object.assign(DISPATCH_TIMEOUTS, saved) }
}
