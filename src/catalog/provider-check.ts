/**
 * Catalog provider 可达性静态检查（Issue #23）。
 *
 * 纯静态、同步、无网络：把 catalog 每个角色（含 judgeRole）的
 * `model.provider` 与宿主当前 profile 已注册 provider 清单（`ctx.llm`
 * 的 `listProviders()` 结果 id 集）比对。未配置 model 的角色视为 OK
 *（运行时继承 Manager route，不属误配）。检查只报告、不阻断加载。
 */
import type { WorkflowConfig } from '../types.ts'

export interface ProviderCheckRow {
  role: string
  provider: string | null
  modelId: string | null
  ok: boolean
  reason: string
}

export interface ProviderCheckReport {
  workflowId: string
  ok: boolean
  rows: ProviderCheckRow[]
}

/** 收集 catalog 全部待查角色：roles 各键 + judgeRole（键名固定 `judge`）。 */
export function collectRoleRoutes(config: WorkflowConfig): Array<{ role: string; provider?: string; modelId?: string }> {
  const routes: Array<{ role: string; provider?: string; modelId?: string }> = []
  for (const [roleKey, role] of Object.entries(config.roles)) {
    routes.push({ role: roleKey, provider: role.model?.provider, modelId: role.model?.modelId })
  }
  routes.push({ role: 'judge', provider: config.judgeRole.model?.provider, modelId: config.judgeRole.model?.modelId })
  return routes
}

/** 对给定 provider 清单做静态比对；available 为已注册 provider id 集。 */
export function checkCatalogProviders(workflowId: string, config: WorkflowConfig, available: ReadonlySet<string> | readonly string[]): ProviderCheckReport {
  const known = available instanceof Set ? available : new Set(available)
  const rows: ProviderCheckRow[] = collectRoleRoutes(config).map(({ role, provider, modelId }) => {
    if (provider === undefined) {
      return { role, provider: null, modelId: modelId ?? null, ok: true, reason: '未配置 model，运行时继承 Manager route' }
    }
    if (known.has(provider)) {
      return { role, provider, modelId: modelId ?? null, ok: true, reason: 'provider 已注册' }
    }
    return { role, provider, modelId: modelId ?? null, ok: false, reason: `provider "${provider}" 未在当前 profile 注册` }
  })
  return { workflowId, ok: rows.every(row => row.ok), rows }
}

/** 逐角色一行 + 总计；失败只报告。 */
export function renderProviderCheckReport(report: ProviderCheckReport): string {
  const lines = report.rows.map(row => {
    const route = row.provider === null ? '(inherit)' : `${row.provider}${row.modelId === null ? '' : `/${row.modelId}`}`
    return `- ${row.role}: ${route} — ${row.ok ? 'OK' : `不可用（${row.reason}）`}`
  })
  const bad = report.rows.filter(row => !row.ok).length
  lines.push(bad === 0
    ? `check ${report.workflowId}: 全过（${report.rows.length} 个角色）`
    : `check ${report.workflowId}: ${bad}/${report.rows.length} 个角色不可用（仅报告，不阻断加载）`)
  return lines.join('\n')
}
