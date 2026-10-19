/**
 * Issue #216：按 Run + 角色（或 judge）动态注册的 Agent Preset 台账。
 *
 * 0.2.1 起 spawn 请求不再接受 persona/toolFilter——persona 经 `dsh-persona`
 * 插件行、deny 经 `preset-deny.ts` 行组装进一个派生 preset，spawn 请求只带
 * `agentPreset` id。派生方式是克隆 Manager 当前的组合 preset（readDocument 的
 * YAML roundtrip 保留 !!js/组结构/config），在其上替换 persona 行、追加 deny
 * 行；Manager 组合缺席时退化为仅 persona + deny 两行（与 composeFrom 无父时
 * 不 join 等价）。
 *
 * preset 服务缺席（base-only profile / 旧版 dsh）→ 返回 undefined 降级为不
 * 选 preset 的 spawn（persona/deny 失效，host 侧告警一次），与子会话宿主
 * 回退语义一致。
 *
 * 注册/注销与 Run 生命周期严格配对：spawn 前各派发入口 ensure（幂等，进程
 * 重启后注册表为空也能按需重建同 id preset，冷 resume 才能按 id mount）；
 * drain/Run 终局/reset/插件卸载时注销。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { load as loadEntryList } from 'js-yaml'
import { WorkflowError } from '../types.ts'
import { denyRowName } from './preset-deny.ts'

/** persona 行的插件名（替换父 preset 已有 persona 行的 prefix）。 */
const PERSONA_ENTRY = '@deepseek-ai/dsh-persona'

/** 本台账消费的 preset 服务面（宿主 `agentPresets`，roster 缺席时 undefined）。 */
interface AgentPresetService {
  composedPreset(ctx: Context): string | undefined
  readDocument(agentPreset: string): Promise<{ agentPreset: string; content: string }>
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

/** 角色 preset id：runId 是 UUID（小写 hex + 连字符），roleKey/judge 受 catalog 命名约束。 */
export function rolePresetId(runId: string, scope: string): string {
  return `dsh-wf-${runId}-${scope}`
}

/**
 * 派生行组装（纯函数，便于单测）：父行数组上替换/追加 persona 行、追加 deny 行。
 * ponytail: persona 前缀是 dsh-persona 的严格 {{…}} 模板插值——catalog persona
 * 含 {{…}} 且变量未注册时该行渲染会抛错；当前 catalog 语义是纯文本，不在此
 * 预检，升级路径是 persona 行改用非插值通道。
 */
export function derivePresetRows(parent: EntryOptions[] | undefined, presetId: string, persona: string, deny: readonly string[]): EntryOptions[] {
  const rows = [...(parent ?? [])]
  if (persona !== '') {
    const existing = rows.find(row => row.name === PERSONA_ENTRY)
    if (existing === undefined) {
      rows.push({ id: 'workflow-persona', name: PERSONA_ENTRY, config: { prefix: persona } })
    } else {
      existing.config = { ...existing.config, prefix: persona }
    }
  }
  if (deny.length > 0) rows.push({ id: 'workflow-deny', name: denyRowName, config: { presetId, deny: [...deny] } })
  return rows
}

/** 动态 preset 的注册/注销台账：每 Run 每 scope 一条，幂等。 */
export class RolePresetBook {
  private readonly byRun = new Map<string, Map<string, () => Promise<void>>>()
  private readonly degraded = new Set<string>()

  /** 已注册即直接返回 id；缺席服务降级返回 undefined（每 run+scope 告警一次）。 */
  async ensure(ctx: Context, manager: Agent, runId: string, scope: string, persona: string, deny: readonly string[]): Promise<string | undefined> {
    const id = rolePresetId(runId, scope)
    // fake ctx（单测）可能没有 get——缺席服务同样走降级告警路径。
    const presets = (ctx as { get?: (key: string) => unknown }).get?.('agentPresets') as AgentPresetService | undefined
    if (presets === undefined) {
      const key = `${runId}:${scope}`
      if (!this.degraded.has(key)) {
        this.degraded.add(key)
        // fake ctx（单测）可能没有 logger——降级告警 best-effort。
        ;(ctx as { logger?: { warn?: (message: string) => void } }).logger?.warn?.(`workflow preset degraded for ${scope} (run ${runId}): agentPresets service absent; spawn proceeds without persona/tool deny`)
      }
      return undefined
    }
    if (this.byRun.get(runId)?.has(scope)) return id
    let parentRows: EntryOptions[] | undefined
    const parentId = presets.composedPreset(manager.ctx)
    if (parentId !== undefined) {
      const document = await presets.readDocument(parentId)
      const parsed = loadEntryList(document.content, { schema: entryListSchema })
      if (!Array.isArray(parsed)) throw new WorkflowError(`agent preset ${parentId} document is not an entry list`)
      parentRows = parsed as EntryOptions[]
    }
    const definition: PresetDefinition = { id, plugins: derivePresetRows(parentRows, id, persona, deny) }
    try {
      const unregister = await presets.register(definition)
      const scopes = this.byRun.get(runId) ?? new Map()
      scopes.set(scope, unregister)
      this.byRun.set(runId, scopes)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new WorkflowError(`workflow preset registration failed for ${scope} (run ${runId}): ${detail}`)
    }
    return id
  }

  /** 注册过即返回 id（未注册/降级均 undefined）——冷物化等只读场景使用。 */
  idOf(runId: string, scope: string): string | undefined {
    return this.byRun.get(runId)?.has(scope) ? rolePresetId(runId, scope) : undefined
  }

  /** 注销一个 scope（drain / respawn 换代）；未注册为 no-op。 */
  async release(ctx: Context, runId: string, scope: string): Promise<void> {
    const unregister = this.byRun.get(runId)?.get(scope)
    if (unregister === undefined) return
    this.byRun.get(runId)!.delete(scope)
    try {
      await unregister()
    } catch (error) {
      ctx.logger.warn(`workflow preset unregister failed for ${scope} (run ${runId}): ${String(error)}`)
    }
  }

  /** Run 终局（completed/terminated）注销该 Run 全部 preset。 */
  async releaseRun(ctx: Context, runId: string): Promise<void> {
    for (const scope of [...(this.byRun.get(runId)?.keys() ?? [])]) await this.release(ctx, runId, scope)
    this.byRun.delete(runId)
    for (const key of [...this.degraded]) if (key.startsWith(`${runId}:`)) this.degraded.delete(key)
  }

  /** 插件卸载：注销全部（best-effort）。 */
  async releaseAll(ctx: Context): Promise<void> {
    for (const runId of [...this.byRun.keys()]) await this.releaseRun(ctx, runId)
  }
}
