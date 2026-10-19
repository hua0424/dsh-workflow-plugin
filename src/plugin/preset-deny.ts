/**
 * Issue #216：动态 preset 的 deny 行插件。
 *
 * 0.2.1 起 spawn 请求不再接受 persona/toolFilter，工具收敛只能经 Agent
 * Preset 组装。preset 的行都挂在同一 generation 层，`tools.restrict()` 在
 * 兄弟行自己的 ctx 里只能看到 own-layer 工具，掩不掉 preset 提供的祖先层
 * 工具——所以 deny 不能在行 apply 里直接 restrict，而是监听 `agent/created`，
 * 命中本 preset（config.presetId）时以该 agent 为父建 scope 挂 mask（与
 * harness browser-use-runtime 的 mask 先例同构），restrictableNames 此时
 * 含 global + 全部祖先层。deny 名单由调用方先过 `knownDenyList`（restrict
 * 对未知 global 名直接抛错，fail-closed）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createScope } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'

/** Cordis 插件名。 */
export const name = 'dsh-workflow-preset-deny'

// cordis 4 对未声明 inject 的 ctx 禁止属性访问（`cannot get property ... without inject`）。
export const inject = ['tools', 'agentPresets'] as const

/** 插件配置：命中的 preset id + 要掩掉的工具名。 */
export interface Config {
  presetId: string
  deny: string[]
}

/** 运行期配置 schema。 */
export const Config: z<Config> = z.object({
  presetId: z.string().required(),
  deny: z.array(z.string()).required(),
})

export function apply(ctx: Context, config: Config): void {
  ctx.on('agent/created', ({ agent }): undefined => {
    if (ctx.get('agentPresets')?.composedPreset(agent.ctx) !== config.presetId) return
    const mask = createScope(ctx, agent)
    try {
      mask.ctx.tools.restrict({ deny: config.deny })
    } catch (error) {
      void mask.dispose()
      throw error
    }
    agent.ctx.effect(() => async () => { await mask.dispose() }, 'workflow-preset-deny.mask')
  })
}

/**
 * preset 行的 entry name（file URL）：loader 按模块 specifier 导入。
 * 源码态（src/，测试/开发直接跑 .ts）与编译产物（lib/ 的 .js，目录结构同构）
 * 各自指向同目录文件。
 */
export const denyRowName: string = new URL(
  import.meta.url.endsWith('.ts') ? './preset-deny.ts' : './preset-deny.js',
  import.meta.url,
).href
