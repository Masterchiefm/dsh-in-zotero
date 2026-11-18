// Calls into Zotero's local HTTP server (the dsh-in-zotero bridge endpoints).
// Zotero passes DSH_ZOTERO_PORT and DSH_ZOTERO_TOKEN to this process; every
// request carries the shared token header. Writes execute inside Zotero via
// its own APIs (saveTx etc.) — this plugin never opens zotero.sqlite.

const PORT = String(process.env.DSH_ZOTERO_PORT ?? '23119')
const TOKEN = String(process.env.DSH_ZOTERO_TOKEN ?? '')
const BASE = `http://127.0.0.1:${PORT}/dsh-bridge/`

export class ZoteroBridgeError extends Error {
  constructor(message, code = 'zotero/bridge-error', status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * Invoke one bridge op.
 * @param {string} op - endpoint name under /dsh-bridge/
 * @param {object} [payload]
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<object>} the endpoint's JSON payload (already {ok:true,...})
 */
export async function call(op, payload = {}, { timeoutMs = 60_000 } = {}) {
  if (TOKEN === '') {
    throw new ZoteroBridgeError('缺少 DSH_ZOTERO_TOKEN（dsh-in-zotero 未通过环境变量传递令牌）', 'zotero/no-token')
  }
  let response
  try {
    response = await fetch(BASE + op, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-in-zotero-token': TOKEN,
      },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  catch (error) {
    const cause = String(error?.message ?? error)
    if (/timed? ?out|timeout/i.test(cause)) {
      throw new ZoteroBridgeError(`Zotero 桥接请求超时（${op}）`, 'zotero/timeout')
    }
    throw new ZoteroBridgeError(
      `无法连接 Zotero（127.0.0.1:${PORT}）。请确认 Zotero 正在运行且允许其他应用通信（设置 → 高级 → 允许本机其他应用与 Zotero 通信）。原始错误：${cause}`,
      'zotero/unreachable'
    )
  }
  let body
  try {
    body = await response.json()
  }
  catch {
    throw new ZoteroBridgeError(`Zotero 桥接返回非 JSON（HTTP ${response.status}）`, 'zotero/bad-response', response.status)
  }
  if (body?.ok !== true) {
    throw new ZoteroBridgeError(
      String(body?.error?.message ?? `桥接调用 ${op} 失败（HTTP ${response.status}）`),
      String(body?.error?.code ?? 'zotero/error'),
      response.status
    )
  }
  return body
}
