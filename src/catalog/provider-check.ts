/**
 * Catalog provider 可达性静态检查（Issue #23）。
 *
 * 纯静态、同步、无网络：把 catalog 每个角色（含 judgeRole）的
 * `model.provider` 与宿主当前 profile 已注册 provider 清单（`ctx.llm`
 * 的 `listProviders()` 结果 id 集）比对。未配置 model 的角色视为 OK
 *（运行时继承 Manager route，不属误配）。检查只报告、不阻断加载。
 */
import { readRoleDefModel, type WorkflowConfig } from '../types.ts'

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
  lines.push(`start ${report.workflowId} 已拒绝：${bad.length}/${report.rows.length} 个角色的 provider 不可用；用 /dsh-flow check ${report.workflowId} 诊断或修正 catalog`)
  return lines.join('\n')
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
