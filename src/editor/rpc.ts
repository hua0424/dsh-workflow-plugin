/**
 * T1 同源鉴权 RPC（host 侧）：只接受受限文本/JSON，复用真实 parser/schema/validator
 * 的解析、诊断与规范化能力；校验副本，不原地改写调用方数据。
 *
 * - 不接受任意服务端文件路径（payload 只有 workflowId + 文本/JSON）。
 * - 不访问 catalog、Run 或引擎状态库（纯函数，无 Store/Engine 依赖）。
 * - 宿主鉴权与同源通道由 Connection 拥有（channel 注册即纳入其鉴权）；
 *   非 Web 环境（无 `connection` 服务）下注册跳过，不破坏插件加载。
 */
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { parseCatalogConfig } from '../catalog/parse.ts'
import { parseWorkflowConfig } from '../catalog/schema.ts'
import { validateAndNormalize } from '../catalog/validate.ts'
import { BUILTIN_PROGRAM_METADATA } from '../programs/metadata.ts'
import { ID_PATTERN } from '../types.ts'
import { findDirectSelfLoops, serializeConfig } from './draft.ts'
import { emptyLayout, fillMissingPositions, parseLayoutFile, type EditorLayout } from './layout.ts'

/** RPC channel（Connection 单段绝对路径规则）。 */
export const EDITOR_RPC_CHANNEL = '/workflow-config-editor'

/** 单个文本/JSON payload 上限（受限输入；超限明确拒绝）。 */
export const MAX_RPC_TEXT_BYTES = 512 * 1024

/** Carrier-neutral 结果形状（对齐宿主 ConnectionRpcResult，不导入 client 包）。 */
export type EditorRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

export type EditorRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<EditorRpcResult>

function fail(code: string, message: string, details: Record<string, unknown> = {}): EditorRpcResult {
  return { ok: false, error: { code, message, details } }
}

function checkWorkflowId(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined
}

function checkTextSize(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= MAX_RPC_TEXT_BYTES
}

/** 解析 YAML 文本 → 归一化配置（副本）+ 诊断；自环按编辑器限制拒绝。 */
export function rpcParseText(workflowId: string, text: string): EditorRpcResult {
  if (checkWorkflowId(workflowId) === undefined) {
    return fail('editor/invalid-workflow-id', `workflow id "${String(workflowId)}" 不是合法小写 [a-z][a-z0-9-]* 标识符`)
  }
  if (typeof text !== 'string') return fail('editor/invalid-payload', 'parse 需要 { workflowId, text }')
  if (!checkTextSize(text)) {
    return fail('editor/text-too-large', `文本超过 ${MAX_RPC_TEXT_BYTES} 字节上限`)
  }
  const warnings: string[] = []
  try {
    const normalized = validateAndNormalize(parseCatalogConfig(text), { workflowId, warnings })
    const selfLoops = findDirectSelfLoops(normalized, workflowId)
    if (selfLoops.length > 0) {
      return fail('editor/self-loop', selfLoops.join('; '), { problems: selfLoops })
    }
    return { ok: true, value: { normalized, warnings } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail('editor/invalid-config', message, { problems: [message] })
  }
}

/** 校验配置 JSON（已解析的草稿对象）→ 归一化副本 + 诊断；不接受路径。 */
export function rpcValidateConfig(workflowId: string, configJson: unknown): EditorRpcResult {
  if (checkWorkflowId(workflowId) === undefined) {
    return fail('editor/invalid-workflow-id', `workflow id "${String(workflowId)}" 不是合法小写 [a-z][a-z0-9-]* 标识符`)
  }
  const snapshot = snapshotJsonValue(configJson)
  if (snapshot === undefined) {
    return fail('editor/invalid-payload', 'validate 需要 lossless JSON 的 { workflowId, config }（exotic 值/循环/非有限数被拒）')
  }
  const warnings: string[] = []
  try {
    const normalized = validateAndNormalize(parseWorkflowConfig(snapshot), { workflowId, warnings })
    const selfLoops = findDirectSelfLoops(normalized, workflowId)
    if (selfLoops.length > 0) {
      return fail('editor/self-loop', selfLoops.join('; '), { problems: selfLoops })
    }
    return { ok: true, value: { normalized, warnings } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail('editor/invalid-config', message, { problems: [message] })
  }
}

/**
 * 只读预览：统一格式序列化完整草稿；暂时非法也返回 YAML（problems 非空标记为草稿），
 * 由调用方阻止业务保存。
 */
export function rpcPreview(configJson: unknown): EditorRpcResult {
  const snapshot = snapshotJsonValue(configJson)
  if (snapshot === undefined || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return fail('editor/invalid-payload', 'preview 需要 { config }（顶层对象，且为 lossless JSON）')
  }
  const yaml = serializeConfig(snapshot as unknown as Parameters<typeof serializeConfig>[0])
  const warnings: string[] = []
  try {
    const normalized = validateAndNormalize(parseWorkflowConfig(structuredClone(snapshot)), { warnings })
    const selfLoops = findDirectSelfLoops(normalized, '*')
    if (selfLoops.length > 0) return { ok: true, value: { yaml, problems: selfLoops, warnings } }
    return { ok: true, value: { yaml, problems: [], warnings } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, value: { yaml, problems: [message], warnings } }
  }
}

/**
 * 布局解析：布局文本（可缺席）+ 当前业务配置 → 补齐后的坐标表。
 * 缺文件静默网格补位；损坏警告回退；规则与服务端 loadDraft 完全一致
 * （浏览器不复制布局规则，只渲染结果）。
 */
export function rpcResolveLayout(configJson: unknown, layoutText?: string): EditorRpcResult {
  const snapshot = snapshotJsonValue(configJson)
  if (snapshot === undefined || typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    return fail('editor/invalid-payload', 'layout 需要 { config, layoutText? }（config 为 lossless JSON 对象）')
  }
  if (layoutText !== undefined && typeof layoutText !== 'string') {
    return fail('editor/invalid-payload', 'layoutText 必须是字符串或缺席')
  }
  if (typeof layoutText === 'string' && !checkTextSize(layoutText)) {
    return fail('editor/text-too-large', `文本超过 ${MAX_RPC_TEXT_BYTES} 字节上限`)
  }
  let parsed: { workflow?: unknown; childWorkflows?: unknown }
  try {
    parsed = parseWorkflowConfig(structuredClone(snapshot)) as { workflow?: unknown; childWorkflows?: unknown }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return fail('editor/invalid-config', message, { problems: [message] })
  }
  let layout: EditorLayout
  const warnings: string[] = []
  if (layoutText === undefined) {
    layout = emptyLayout()
  } else {
    const loaded = parseLayoutFile(layoutText)
    layout = loaded.layout
    warnings.push(...loaded.warnings)
  }
  const filled = fillMissingPositions(
    parsed as unknown as Parameters<typeof fillMissingPositions>[0],
    layout,
  )
  return { ok: true, value: { layout, warnings, filled } }
}

/**
 * T4（#163）程序元数据：固定 Program 的 id/描述/参数合同单源直出
 * （与静态校验、Runtime 参数校验同源；纯 JSON，无密钥/路径）。
 * 面板程序下拉与参数提示只读本端点，不硬编码第二份注册表。
 */
export function rpcProgramMetadata(): EditorRpcResult {
  return { ok: true, value: { programs: structuredClone(BUILTIN_PROGRAM_METADATA) } }
}

/** 按 endpoint 分派（payload 只读文本/JSON；未知 endpoint 明确拒绝）。 */
export function createEditorRpcHandler(): EditorRpcHandler {
  return async (endpoint, payload) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return fail('editor/invalid-payload', 'payload 必须是对象')
    }
    const body = payload as Record<string, unknown>
    if (endpoint === 'parse') {
      if (typeof body['workflowId'] !== 'string' || typeof body['text'] !== 'string') {
        return fail('editor/invalid-payload', 'parse 需要 { workflowId: string, text: string }')
      }
      return rpcParseText(body['workflowId'], body['text'])
    }
    if (endpoint === 'validate') {
      if (typeof body['workflowId'] !== 'string' || !('config' in body)) {
        return fail('editor/invalid-payload', 'validate 需要 { workflowId: string, config: unknown }')
      }
      return rpcValidateConfig(body['workflowId'], body['config'])
    }
    if (endpoint === 'preview') {
      if (!('config' in body)) return fail('editor/invalid-payload', 'preview 需要 { config: unknown }')
      return rpcPreview(body['config'])
    }
    if (endpoint === 'layout') {
      if (!('config' in body)) return fail('editor/invalid-payload', 'layout 需要 { config: unknown, layoutText?: string }')
      const layoutText = body['layoutText']
      if (layoutText !== undefined && typeof layoutText !== 'string') {
        return fail('editor/invalid-payload', 'layoutText 必须是字符串或缺席')
      }
      return rpcResolveLayout(body['config'], layoutText as string | undefined)
    }
    if (endpoint === 'metadata') {
      return rpcProgramMetadata()
    }
    return fail('editor/unknown-endpoint', `未知 endpoint "${endpoint}"（仅支持 parse/validate/preview/layout/metadata）`)
  }
}

/** Connection 通道注册表的最小结构形状（不导入未安装的 client 包）。 */
interface EditorRpcRegistry {
  handle(channel: string, handler: EditorRpcHandler): () => Promise<void>
}

interface ConnectionService {
  rpc: EditorRpcRegistry
}

/**
 * 在 host ctx 上注册编辑器 RPC（Web 同源鉴权通道），返回释放函数以便接入 effect 寿命。
 * @returns 已注册（含 dispose）或因无 connection 服务而跳过（非 Web 加载不被破坏）。
 */
export function registerEditorRpc(ctx: { get(name: string): unknown }):
  | { status: 'registered'; dispose: () => Promise<void> }
  | { status: 'skipped-no-connection' } {
  const connection = ctx.get('connection') as ConnectionService | undefined
  if (connection === undefined || typeof connection.rpc?.handle !== 'function') return { status: 'skipped-no-connection' }
  const dispose = connection.rpc.handle(EDITOR_RPC_CHANNEL, createEditorRpcHandler())
  return { status: 'registered', dispose }
}
