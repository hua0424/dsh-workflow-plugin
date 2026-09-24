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
 * 服务读取用属性访问（`ctx.connection`）：真实 Cordis Context 经 proxy 解析服务名，
 * 没有 `ctx.get(name)` 方法——经 inject 回调拿到的 connCtx 同样如此。
 * @returns 已注册（含 dispose）或因无 connection 服务而跳过（非 Web 加载不被破坏）。
 */
export function registerEditorRpc(ctx: { connection?: ConnectionService }):
  | { status: 'registered'; dispose: () => Promise<void> }
  | { status: 'skipped-no-connection' } {
  const connection = ctx.connection
  if (connection === undefined || typeof connection.rpc?.handle !== 'function') return { status: 'skipped-no-connection' }
  const dispose = connection.rpc.handle(EDITOR_RPC_CHANNEL, createEditorRpcHandler())
  return { status: 'registered', dispose }
}

/**
 * dsh v0.1.5-alpha.1+ 的正式安装路径：client-connection 的 inject 收缩为 ['credentials']，
 * `connection.rpc.handle()` 内部访问 owner.webServer 必抛 "cannot get property without
 * inject"（实测 2026-09-24，dsh-pocket lib/web-rpc.js 记录了同一坑）。因此优先把通道
 * 路由直接挂到**本插件自己 inject 的 webServer** 上，鉴权以方法形式调用
 * `connection.requestRejection(req)`（401/403 均由它判定，丢失 this 会 TypeError →
 * fail-closed 403）；wire 协议（client-request → handler → server-response）与
 * Connection /api 通道逐字段一致，浏览器客户端无需改动。
 * 旧版宿主（无 webServer 服务，如 headless）回退 `connection.rpc.handle`。
 */
export function installEditorRpc(ctx: EditorWebCtx):
  | { status: 'mounted'; dispose: () => void }
  | { status: 'fallback'; dispose: () => Promise<void> }
  | { status: 'skipped' } {
  const connection = ctx.connection
  const webServer = ctx.webServer
  if (connection !== undefined && webServer !== undefined && typeof webServer.register === 'function') {
    const fetchHandler = editorFetchHandler(EDITOR_RPC_CHANNEL, createEditorRpcHandler())
    const route: WebRoute = {
      kind: 'prefix',
      path: EDITOR_RPC_CHANNEL,
      handler: async (req, res) => {
        let rejection: number | undefined = 403
        if (typeof connection.requestRejection === 'function') {
          try { rejection = connection.requestRejection(req) } catch { rejection = 403 }
        }
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await httpBridge(req, res, fetchHandler, EDITOR_RPC_BODY_MAX)
      },
    }
    const registered: unknown = webServer.register(route)
    // register 可能返回 disposer、Promise<disposer> 或 undefined；统一成幂等清理函数。
    const cleanup = typeof registered === 'function'
      ? () => { try { (registered as () => void)() } catch { /* 已清理 */ } }
      : registered !== null && typeof registered === 'object' && typeof (registered as { then?: unknown }).then === 'function'
        ? (() => {
          let done = false
          return () => { void (async () => {
            if (done) return
            done = true
            try {
              const dispose = await registered as unknown
              if (typeof dispose === 'function') (dispose as () => void)()
            } catch { /* 已清理 */ }
          })() }
        })()
        : () => {}
    return { status: 'mounted', dispose: cleanup }
  }
  const fallback = registerEditorRpc(ctx)
  if (fallback.status === 'registered') return { status: 'fallback', dispose: fallback.dispose }
  return { status: 'skipped' }
}

/** 单请求体上限：业务文本上限 512KB，信封开销留余量。 */
export const EDITOR_RPC_BODY_MAX = 2 * 1024 * 1024

/** endpoint 段字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** client-request 信封校验失败时使用的兜底 rpcId（与 dsh 内部 INVALID_REQUEST_RPC_ID 对齐）。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

interface NodeLikeRequest {
  method?: string
  url?: string
  headers: Record<string, unknown>
  destroy(): void
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>
}

interface NodeLikeResponse {
  writableEnded: boolean
  write(chunk: unknown): boolean
  end(chunk?: unknown): void
  writeHead(status: number, headers?: Record<string, unknown>): void
  on(event: string, listener: () => void): void
  off(event: string, listener: () => void): void
  once(event: string, listener: () => void): void
}

export interface WebRoute {
  kind: 'prefix'
  path: string
  handler: (req: NodeLikeRequest, res: NodeLikeResponse) => Promise<void>
}

export interface EditorWebCtx {
  connection?: ConnectionService & { requestRejection?: (req: NodeLikeRequest) => number | undefined }
  webServer?: { register(route: WebRoute): unknown }
}

/** 从 `${channel}/<endpoint>` 路径取 endpoint；段非法返回 undefined（与宿主对齐）。 */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function serverResponseJson(rpcId: string, result: EditorRpcResult): string {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

/**
 * 把编辑器 handler 包装成 fetch-shaped handler：404（非 POST / 无 endpoint）、
 * 415（content-type）、400（非 JSON）、bad-request（信封非法 / method 不匹配）、
 * 500（handler 抛错），成功 200 返回 server-response JSON。
 */
export function editorFetchHandler(channel: string, handler: EditorRpcHandler): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try { body = await request.json() } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = body as { rpcId?: unknown; method?: unknown } | null
      const rpcId = envelope !== null && typeof envelope.rpcId === 'string' ? envelope.rpcId : INVALID_REQUEST_RPC_ID
      const method = envelope !== null && typeof envelope.method === 'string' ? envelope.method : null
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return new Response(serverResponseJson(INVALID_REQUEST_RPC_ID, {
          ok: false,
          error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method !== endpoint) {
        return new Response(serverResponseJson(rpcId, {
          ok: false,
          error: {
            code: 'bad-request',
            message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      try {
        const result = await handler(endpoint, (envelope as { payload?: unknown }).payload, request.signal)
        return new Response(serverResponseJson(rpcId, result), { status: 200, headers: { 'content-type': 'application/json' } })
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

/**
 * node:http 请求 → fetch-shaped handler → node:http 响应的桥接（对齐宿主 bridge）：
 * res 关闭即 abort、超限 413 + 销毁 socket、数组请求头丢弃、背压等 drain/close。
 */
async function httpBridge(req: NodeLikeRequest, res: NodeLikeResponse, fetchHandler: { fetch(request: Request): Promise<Response> }, maxBodyBytes: number): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const declaredLen = req.headers['content-length']
  if (declaredLen !== undefined && Number(declaredLen) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  let tooLarge = false
  for await (const chunk of req) {
    received += chunk.length
    if (received > maxBodyBytes) { tooLarge = true; break }
    chunks.push(chunk)
  }
  if (tooLarge) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }
  const host = typeof req.headers['host'] === 'string' ? req.headers['host'] : '127.0.0.1'
  const url = `http://${host}${req.url ?? '/'}`
  const headerEntries = Object.entries(req.headers).filter((entry) => typeof entry[1] === 'string') as Array<[string, string]>
  const init: RequestInit = {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(headerEntries),
    signal: abort.signal,
  }
  if (chunks.length > 0) init.body = Buffer.concat(chunks)
  const response = await fetchHandler.fetch(new Request(url, init))
  const headers = Object.fromEntries(response.headers.entries())
  res.writeHead(response.status, headers)
  if (response.body === null) { res.end(); return }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve() }
        res.once('drain', done)
        res.once('close', done)
      })
    }
    if (res.writableEnded) break
  }
  res.end()
}
