import type { Context } from '@deepseek-ai/cordis'
import {
  makeParticipantIndex, participantServicesOf,
  type ParticipantIndex, type ParticipantServices, type WorkOrderPort,
} from '../../src/plugin/participants.ts'

/**
 * #99 测试装配：与生产同一条服务切片路径（`participantServicesOf`），工作单端口按用例
 * 注入；默认"没有行"，因此路由只来自内存。
 */
export function testParticipants(ctx: Context, workOrder: Partial<WorkOrderPort> = {}): ParticipantIndex {
  return makeParticipantIndex(participantServicesOf(ctx as unknown as ParticipantServices), {
    workspaceKeyOf: async () => undefined,
    facts: async () => undefined,
    factsBySession: async () => undefined,
    ...workOrder,
  })
}
