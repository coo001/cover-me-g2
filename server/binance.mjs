// Binance Spot TESTNET client. The testnet host is fixed here on purpose:
// there is no mainnet address anywhere in this project.
import crypto from 'node:crypto'

export const REST = 'https://testnet.binance.vision'
export const WS = 'wss://stream.testnet.binance.vision/ws'

export class BinanceError extends Error {
  constructor(status, code, msg) {
    super(`HTTP ${status}${code != null ? ` code ${code}` : ''}: ${msg}`)
    this.status = status; this.code = code; this.msg = msg
  }
}

// Turns a failure into one plain sentence a person can act on.
export function explain(err) {
  if (err instanceof BinanceError) {
    if (err.status === 451) return 'restricted location: Binance testnet refuses this IP (HTTP 451). Run the backend from a non-US network.'
    if (err.status === 401 || err.code === -2014 || err.code === -2015 || err.code === -2008)
      return 'regenerate key: the testnet rejected this API key (testnet resets wipe keys about monthly). Create a new HMAC key at https://testnet.binance.vision and update your env file.'
    if (err.code === -1022) return 'regenerate key: signature rejected, the secret does not match the API key.'
    if (err.code === -1021) return 'clock: this computer clock is too far from Binance time. Sync the system clock.'
    if (err.code === -2010) return `order rejected: ${err.msg}`
    if (err.status === 429 || err.status === 418) return 'rate limited by Binance, wait a minute.'
    return err.message
  }
  if (err?.name === 'TimeoutError' || err?.cause?.code) return `network: cannot reach testnet.binance.vision (${err.cause?.code ?? 'timeout'}).`
  return String(err?.message ?? err)
}

async function parse(res) {
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = null }
  if (!res.ok) throw new BinanceError(res.status, body?.code, body?.msg ?? text.slice(0, 120))
  return { body, text }
}

export async function pub(path, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${REST}${path}${qs ? `?${qs}` : ''}`, { signal: AbortSignal.timeout(8000) })
  return (await parse(res)).body
}

let clockOffset = 0 // serverTime - localTime, ms
export async function syncClock() {
  const t0 = Date.now()
  const { serverTime } = await pub('/api/v3/time')
  const t1 = Date.now()
  clockOffset = Math.round(serverTime - (t0 + t1) / 2)
  return { offsetMs: clockOffset, rttMs: t1 - t0 }
}

// Signed call. Returns { body, text } so callers can show Binance's raw text untouched.
export async function signed(cfg, method, path, params = {}) {
  if (!cfg.apiKey || !cfg.secret) throw new BinanceError(401, -2014, 'API key or secret is missing')
  const qs = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now() + clockOffset) }).toString()
  const sig = crypto.createHmac('sha256', cfg.secret).update(qs).digest('hex')
  const res = await fetch(`${REST}${path}?${qs}&signature=${sig}`, {
    method, headers: { 'X-MBX-APIKEY': cfg.apiKey }, signal: AbortSignal.timeout(8000),
  })
  return parse(res)
}

export async function account(cfg) {
  const { body } = await signed(cfg, 'GET', '/api/v3/account', { omitZeroBalances: 'true' })
  const free = a => body.balances.find(b => b.asset === a)?.free ?? '0.00000000'
  return { canTrade: body.canTrade, base: free(cfg.base), quote: free(cfg.quote) }
}

export async function filters(cfg) {
  const info = await pub('/api/v3/exchangeInfo', { symbol: cfg.symbol })
  const f = info.symbols[0].filters
  const lot = f.find(x => x.filterType === 'LOT_SIZE')
  const notional = f.find(x => x.filterType === 'NOTIONAL' || x.filterType === 'MIN_NOTIONAL')
  return { stepSize: lot.stepSize, minQty: lot.minQty, minNotional: notional?.minNotional ?? '0' }
}

// Floors a quantity to the exchange step and returns the exact string to send.
export function toStep(qty, stepSize) {
  const decimals = (stepSize.split('.')[1] ?? '').replace(/0+$/, '').length
  const k = 10 ** decimals
  return (Math.floor(qty * k + 1e-9) / k).toFixed(decimals)
}

export function marketOrder(cfg, side, quantity, clientOrderId) {
  return signed(cfg, 'POST', '/api/v3/order', {
    symbol: cfg.symbol, side, type: 'MARKET', quantity, newOrderRespType: 'FULL',
    ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
  })
}
