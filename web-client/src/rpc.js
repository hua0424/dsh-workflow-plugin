/**
 * T1 编辑器 RPC 客户端：经宿主 Connection 同源鉴权通道调用
 * `/workflow-config-editor` 的 parse/validate/preview。
 *
 * 只发受限文本/JSON（workflowId + text/config），不发任何服务端路径；
 * 目录文件读写全部经浏览器 File System Access API 在本地完成。
 */

export const EDITOR_RPC_CHANNEL = '/workflow-config-editor'

function normalizeResult(result) {
  if (result !== null && typeof result === 'object' && 'ok' in result) return result
  return { ok: false, error: { code: 'editor/bad-envelope', message: 'RPC 返回不是有效的结果信封', details: {} } }
}

/**
 * @param connection 宿主浏览器端的 ctx.connection（结构：{ rpc: { call } }）。
 * @param {string} endpoint parse | validate | preview
 */
export async function callEditor(connection, endpoint, payload, signal) {
  const call = connection?.rpc?.call
  if (typeof call !== 'function') {
    return { ok: false, error: { code: 'editor/no-channel', message: '当前页面没有可用的编辑器 RPC 通道', details: {} } }
  }
  try {
    return normalizeResult(await call.call(connection.rpc, EDITOR_RPC_CHANNEL, endpoint, payload, signal))
  } catch (error) {
    return { ok: false, error: { code: 'editor/transport', message: String(error), details: {} } }
  }
}

export function rpcErrorMessage(result) {
  if (result.ok) return ''
  const error = result.error ?? {}
  return typeof error.message === 'string' && error.message !== '' ? error.message : String(error.code ?? 'unknown')
}
