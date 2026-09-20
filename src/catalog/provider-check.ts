/**
 * Catalog 模型路由静态检查（Issue #23 provider 注册；#151 T2 modelId 本地列表）。
 *
 * 纯静态、无网络发现：把 catalog 每个角色（含 judgeRole）的显式路由与宿主
 * 本地事实比对。两层装配：
 *
 * - 判定层（纯函数、同步、可注入）：`checkCatalogProviders`，调用边界把宿主
 *   查询结果装配成 `ModelListFacts` 再传入；check/start 共用同一规则。
 * - 查询层（异步）：`queryModelLists` 按 provider 去重查询一次
 *   `ctx.llm.listModels`，同步抛错与异步拒绝一律转为故障事实（绝不误报空列表）；
 *   `checkCatalogProvidersWithModelLists` 把两层串起来供命令入口使用。
 *
 * 组合语义（#149 矩阵）：
 *
 * - provider 未注册：确定误配，阻断，跳过该角色后续模型/档位查询。
 * - listModels 成功为空或不含 modelId：确定误配，阻断，不进入档位查询。
 * - listModels 抛错/拒绝：fail-open，跳过 modelId 与后续档位两维，不再
 *   resolveModelInfo；行内注明“无法解析本地模型列表”及原因。T2 只建立该故障
 *   事实（`modelList: 'list-unavailable'`），T3 消费它决定是否进入档位检查。
 * - 未配置 model 的角色保留既有继承，跳过显式路由检查。
 * - 某角色查询失败不掩盖其他角色确定误配；后者仍阻断 start。
 * - 跳过只表示允许尝试，不表示模型已验证或运行必然成功。
 */
import { readRoleDefModel, type WorkflowConfig } from '../types.ts'

/**
 * T2 modelId 本地列表检查结论（T3 消费：只有 `listed` 进入档位检查；
 * `list-unavailable` 跳过档位检查；其余要么阻断要么不查）。
 */
export type ModelListStatus =
  | 'inherited'
  | 'provider-unregistered'
  | 'list-unavailable'
  | 'empty-list'
  | 'unlisted'
  | 'listed'

export interface ProviderCheckRow {
  role: string
  provider: string | null
  modelId: string | null
  ok: boolean
  reason: string
  /** T2：本角色 modelId 列表维度的结论；provider 维度的误配仍由 ok/reason 表达。 */
  modelList: ModelListStatus
}

export interface ProviderCheckReport {
  workflowId: string
  ok: boolean
  rows: ProviderCheckRow[]
}

/**
 * 调用边界装配好的宿主查询事实：`models` 为各 provider 的本地模型 id 集；
 * `failures` 为查询失败的 provider 与原因（同步抛错/异步拒绝都在此处归一）。
 * 两表都不含某已注册 provider（历史调用方未查询）时按查询失败处理并注明。
 */
export interface ModelListFacts {
  models?: ReadonlyMap<string, readonly string[]>
  failures?: ReadonlyMap<string, string>
}

/** 收集 catalog 全部待查角色：roles 各键 + judgeRole（键名固定 `judge`）。def 层读取走共享单源。 */
export function collectRoleRoutes(config: WorkflowConfig): Array<{ role: string; provider?: string; modelId?: string }> {
  const routes: Array<{ role: string; provider?: string; modelId?: string }> = []
  for (const roleKey of Object.keys(config.roles)) {
    const def = readRoleDefModel(config, roleKey)
    routes.push({ role: roleKey, provider: def?.provider, modelId: def?.modelId })
  }
  const judge = readRoleDefModel(config, 'judge')
  routes.push({ role: 'judge', provider: judge?.provider, modelId: judge?.modelId })
  return routes
}

/**
 * 对给定 provider 清单 + 本地模型列表事实做静态判定；available 为已注册
 * provider id 集。纯函数：同一输入同一报告，check/start 共用。
 */
export function checkCatalogProviders(
  workflowId: string,
  config: WorkflowConfig,
  available: ReadonlySet<string> | readonly string[],
  lists?: ModelListFacts,
): ProviderCheckReport {
  const known = available instanceof Set ? available : new Set(available)
  const rows: ProviderCheckRow[] = collectRoleRoutes(config).map(({ role, provider, modelId }) => {
    if (provider === undefined) {
      return { role, provider: null, modelId: modelId ?? null, ok: true, reason: '未配置 model，运行时继承 Manager route', modelList: 'inherited' as const }
    }
    if (!known.has(provider)) {
      return { role, provider, modelId: modelId ?? null, ok: false, reason: `provider "${provider}" 未在当前 profile 注册`, modelList: 'provider-unregistered' as const }
    }
    const failure = lists?.failures?.get(provider)
    if (failure !== undefined) {
      return {
        role, provider, modelId: modelId ?? null, ok: true,
        reason: `无法解析 provider "${provider}" 的本地模型列表（${failure}）；已跳过 modelId 与后续档位检查，允许尝试启动（不代表模型可用）`,
        modelList: 'list-unavailable' as const,
      }
    }
    const models = lists?.models?.get(provider)
    if (models === undefined) {
      return {
        role, provider, modelId: modelId ?? null, ok: true,
        reason: `未查询 provider "${provider}" 的本地模型列表；已跳过 modelId 与后续档位检查，允许尝试启动（不代表模型可用）`,
        modelList: 'list-unavailable' as const,
      }
    }
    if (models.length === 0) {
      return {
        role, provider, modelId: modelId ?? null, ok: false,
        reason: `provider "${provider}" 的本地模型列表为空（未实现 listModels 的适配器视为不可用）；请检查该 provider 的本地配置`,
        modelList: 'empty-list' as const,
      }
    }
    if (modelId !== undefined && !models.includes(modelId)) {
      return {
        role, provider, modelId, ok: false,
        reason: `modelId "${modelId}" 不在 provider "${provider}" 的本地模型列表中；请先在本地 settings/config 声明该模型后再 start`,
        modelList: 'unlisted' as const,
      }
    }
    return { role, provider, modelId: modelId ?? null, ok: true, reason: 'provider 已注册；modelId 在本地模型列表中', modelList: 'listed' as const }
  })
  return { workflowId, ok: rows.every(row => row.ok), rows }
}

/**
 * 异步装配：对给定 provider 逐个查询本地模型 id（去重，一家只查一次）。
 * 查询函数的同步抛错与返回 promise 的异步拒绝一律转为 `failures` 事实——
 * 调用方不得把故障误报成空列表。成功结果原样收录（含空数组，空列表是阻断事实）。
 */
export async function queryModelLists(
  providers: readonly string[],
  listModels: (provider: string) => Promise<readonly string[]>,
): Promise<{ models: Map<string, readonly string[]>; failures: Map<string, string> }> {
  const models = new Map<string, readonly string[]>()
  const failures = new Map<string, string>()
  for (const provider of new Set(providers)) {
    try {
      models.set(provider, await listModels(provider))
    } catch (error) {
      failures.set(provider, error instanceof Error ? error.message : String(error))
    }
  }
  return { models, failures }
}

/**
 * 命令入口装配体：已注册且配置了显式路由的 provider 才需查询（未注册的阻断在
 * 先，继承角色不查），查完走同一纯判定。`listModels` 在此把宿主
 * `LlmModelInfo[]` 拍平成 id 数组。
 */
export async function checkCatalogProvidersWithModelLists(
  workflowId: string,
  config: WorkflowConfig,
  available: ReadonlySet<string> | readonly string[],
  listModels: (provider: string) => Promise<readonly string[]>,
): Promise<ProviderCheckReport> {
  const known = available instanceof Set ? available : new Set(available)
  const toQuery = collectRoleRoutes(config)
    .filter(route => route.provider !== undefined && known.has(route.provider))
    .map(route => route.provider as string)
  const { models, failures } = await queryModelLists(toQuery, listModels)
  return checkCatalogProviders(workflowId, config, available, { models, failures })
}

/** T2：行内 modelId 维度后缀；跳过行必须带具体原因，不得只写 OK。 */
function modelListSuffix(row: ProviderCheckRow): string {
  switch (row.modelList) {
    case 'inherited': return '（未配置 model，运行时继承 Manager route）'
    case 'provider-unregistered': return ''
    case 'listed': return '（modelId 已在本地列表验证通过）'
    case 'list-unavailable': return `（modelId 检查已跳过：${row.reason}）`
    case 'empty-list': return ''
    case 'unlisted': return ''
  }
}

/**
 * Issue #41：start 前置阻断用的失败渲染。逐角色点名（角色/provider/原因），
 * 与 check 命令的纯诊断渲染区分（check 保持非阻断，见 renderProviderCheckReport）。
 */
export function renderStartProviderBlock(report: ProviderCheckReport): string {
  const bad = report.rows.filter(row => !row.ok)
  const lines = bad.map(row => {
    const route = row.provider === null ? '(inherit)' : `${row.provider}${row.modelId === null ? '' : `/${row.modelId}`}`
    return `- ${row.role}: ${route} — ${row.reason}`
  })
  lines.push(`start ${report.workflowId} 已拒绝：${bad.length}/${report.rows.length} 个角色的模型路由不可用；用 /dsh-flow check ${report.workflowId} 诊断或修正 catalog（unlisted 模型需先在本地 settings/config 声明）`)
  return lines.join('\n')
}

/** 逐角色一行 + 总计；失败只报告。成功但有跳过时总计必须点名跳过数，不得宣称全维度已验证。 */
export function renderProviderCheckReport(report: ProviderCheckReport): string {
  const lines = report.rows.map(row => {
    const route = row.provider === null ? '(inherit)' : `${row.provider}${row.modelId === null ? '' : `/${row.modelId}`}`
    if (!row.ok) return `- ${row.role}: ${route} — 不可用（${row.reason}）`
    return `- ${row.role}: ${route} — OK${modelListSuffix(row)}`
  })
  const bad = report.rows.filter(row => !row.ok).length
  if (bad > 0) {
    lines.push(`check ${report.workflowId}: ${bad}/${report.rows.length} 个角色不可用（仅报告，不阻断加载）`)
    return lines.join('\n')
  }
  const skipped = report.rows.filter(row => row.modelList === 'list-unavailable').length
  lines.push(skipped === 0
    ? `check ${report.workflowId}: 全过（${report.rows.length} 个角色）`
    : `check ${report.workflowId}: 全过（${report.rows.length} 个角色；其中 ${skipped} 个跳过 modelId 检查，见行内原因，仅报告）`)
  return lines.join('\n')
}
