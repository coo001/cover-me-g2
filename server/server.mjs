// Cover Me backend. Runs on the user's own machine, next to the keys.
// The glasses app only gets prices and sends taps; keys never leave this process.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, APP_DIR } from './env.mjs'
import { WS, pub, syncClock, account, filters, toStep, marketOrder, explain } from './binance.mjs'

const cfg = loadConfig()
const STALE_ORDER_MS = 5000 // never send an order on a price older than this
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const state = {
  price: null,      // best bid as Binance sent it (string): the price a sell would hit
  priceTs: 0,       // when this process last received a price
  holding: null,    // free BTC (string from Binance)
  cover: null,      // { since, till, basePrice, line, guardQty }
  call: null,       // { id, ts, price, order?: Promise }
  lastOrder: null,  // Binance's response to the last sell, untouched
  note: null,
}
let step = '0.00001000'
let callSeq = 0
let feedOn = true
const clients = new Set()
const ordersById = new Map() // clientOrderId -> Promise<result>

// ---------- price feed (real testnet best bid; no synthetic prices anywhere) ----------
function onPrice(bid) {
  state.price = bid
  state.priceTs = Date.now()
  const c = state.cover
  if (c && !state.call && Number(bid) <= c.line) {
    state.call = { id: ++callSeq, ts: Date.now(), price: bid, seenByGlasses: clients.size > 0 }
    log(`line reached: bid ${bid} <= line ${c.line} (call ${state.call.id}, glasses ${clients.size ? 'connected' : 'NOT connected'})`)
    push()
  }
}
let ws = null
function connectFeed() {
  if (!feedOn) return
  try {
    ws = new WebSocket(`${WS}/${cfg.symbol.toLowerCase()}@bookTicker`)
    ws.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m.b) onPrice(m.b) } catch {} }
    ws.onclose = () => { ws = null; setTimeout(connectFeed, 2000) }
    ws.onerror = () => { try { ws?.close() } catch {} }
  } catch { setTimeout(connectFeed, 2000) }
}
// REST fallback: if the stream has been silent for 3 s, read the book directly.
setInterval(async () => {
  if (!feedOn || Date.now() - state.priceTs < 3000) return
  try { onPrice((await pub('/api/v3/ticker/bookTicker', { symbol: cfg.symbol })).bidPrice) } catch {}
}, 2000)

async function refreshHolding() {
  try { state.holding = (await account(cfg)).base } catch (e) { state.note = explain(e) }
}

// ---------- cover ----------
function endCoverIfDue() {
  if (state.cover && Date.now() >= state.cover.till) {
    log('cover ended')
    state.cover = null; state.call = null
  }
}
const nextLine = line => Math.round(line * (1 - cfg.linePct / 100) * 100) / 100

function snapshot() {
  endCoverIfDue()
  return {
    now: Date.now(), net: 'TESTNET', symbol: cfg.symbol,
    price: state.price, priceTs: state.priceTs,
    holding: state.holding, guardBtc: cfg.guardBtc, linePct: cfg.linePct, coverMin: cfg.coverMin,
    cover: state.cover,
    call: state.call ? { id: state.call.id, ts: state.call.ts, price: state.call.price, nextLine: nextLine(state.cover.line) } : null,
    lastOrder: state.lastOrder, note: state.note,
  }
}
function push() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of clients) res.write(data)
}
setInterval(push, 2000) // doubles as the heartbeat the glasses use to detect OFFLINE

// ---------- actions ----------
async function start() {
  if (state.cover) return { ok: true }
  if (!state.price || Date.now() - state.priceTs > STALE_ORDER_MS) return { ok: false, error: 'stale' }
  await refreshHolding()
  const guardQty = toStep(Math.min(Number(state.holding ?? 0), cfg.guardBtc), step)
  if (Number(guardQty) <= 0) return { ok: false, error: 'no_holding' }
  const basePrice = Number(state.price)
  state.cover = {
    since: Date.now(), till: Date.now() + cfg.coverMin * 60000,
    basePrice, line: Math.round(basePrice * (1 - cfg.linePct / 100) * 100) / 100, guardQty,
  }
  state.call = null
  log(`cover started: ${guardQty} ${cfg.base} at ${basePrice}, line ${state.cover.line}`)
  return { ok: true }
}

function hold(body) {
  if (!state.cover || !state.call || state.call.id !== body.callId) return { ok: false, error: 'no_call' }
  if (state.call.order) return { ok: false, error: 'order_in_flight' }
  state.cover.line = nextLine(state.cover.line)
  state.call = null
  log(`hold: next line ${state.cover.line}`)
  return { ok: true }
}

// One sell per call, whatever the glasses send. A repeated or doubled tap gets the first result back.
function sell(body) {
  const id = String(body.clientOrderId ?? '')
  if (ordersById.has(id)) return ordersById.get(id)
  const call = state.call
  if (!state.cover || !call || call.id !== body.callId) return { ok: false, error: 'no_call' }
  if (call.order) return call.order
  if (!/^[A-Za-z0-9_-]{8,36}$/.test(id)) return { ok: false, error: 'bad_id' }
  if (body.choice !== 'half' && body.choice !== 'all') return { ok: false, error: 'bad_choice' }
  if (!feedOn || Date.now() - state.priceTs > STALE_ORDER_MS) return { ok: false, error: 'stale' } // not recorded: user may retry
  const guard = Number(state.cover.guardQty)
  const qty = toStep(body.choice === 'half' ? guard / 2 : guard, step)
  const p = (async () => {
    try {
      log(`SELL ${qty} ${cfg.base} market (call ${call.id}, ${body.choice})`)
      const { body: order, text } = await marketOrder(cfg, 'SELL', qty, id)
      fs.mkdirSync(path.join(APP_DIR, 'data'), { recursive: true })
      fs.appendFileSync(path.join(APP_DIR, 'data', 'orders.jsonl'), text + '\n')
      log(`order ${order.orderId} ${order.status} executedQty ${order.executedQty}`)
      await refreshHolding()
      state.lastOrder = order
      if (state.cover) {
        state.cover.guardQty = toStep(Math.max(0, guard - Number(order.executedQty)), step)
        state.cover.line = nextLine(state.cover.line)
        if (Number(state.cover.guardQty) <= 0) state.cover = null // nothing left to watch
      }
      state.call = null
      return { ok: true, order, left: state.holding }
    } catch (e) {
      log(`order failed: ${explain(e)}`)
      call.order = null; ordersById.delete(id)
      return { ok: false, error: 'rejected', message: explain(e) }
    }
  })()
  call.order = p
  ordersById.set(id, p)
  return p
}

// ---------- http ----------
function readJson(req) {
  return new Promise(resolve => {
    let s = ''
    req.on('data', d => { s += d; if (s.length > 4096) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })
}
const server = http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': cfg.allowOrigin, 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', Vary: 'Origin' }
  const json = (code, obj) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const url = new URL(req.url, 'http://x')
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    clients.add(res)
    log(`glasses connected (${clients.size})`)
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    req.on('close', () => { clients.delete(res); log(`glasses disconnected (${clients.size})`) })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, snapshot())
  if (req.method === 'POST') {
    const body = await readJson(req)
    let out
    if (url.pathname === '/api/start') out = await start()
    else if (url.pathname === '/api/stop') { state.cover = null; state.call = null; out = { ok: true } }
    else if (url.pathname === '/api/hold') out = hold(body)
    else if (url.pathname === '/api/order') out = await sell(body)
    else if (cfg.testHooks && url.pathname === '/api/test/feed') {
      // TEST HOOK (COVERME_TEST_HOOKS=1): really stops/starts the price feed. It never invents a price.
      feedOn = body.on !== false
      if (!feedOn) { try { ws?.close() } catch {} } else connectFeed()
      log(`test hook: feed ${feedOn ? 'on' : 'off'}`)
      out = { ok: true, feedOn }
    } else return json(404, { ok: false, error: 'not_found' })
    push()
    return json(out.ok ? 200 : 409, out)
  }
  json(404, { ok: false, error: 'not_found' })
})

try {
  await syncClock()
  step = (await filters(cfg)).stepSize
  const a = await account(cfg)
  state.holding = a.base
} catch (e) {
  console.log(`[FAIL] ${explain(e)}\nRun: npm run doctor`)
  process.exit(1)
}
setInterval(() => syncClock().catch(() => {}), 10 * 60000)
setInterval(refreshHolding, 30000)
connectFeed()
server.listen(cfg.port, '127.0.0.1', () => log(`Cover Me backend on http://127.0.0.1:${cfg.port}  (TESTNET, guard ${cfg.guardBtc} ${cfg.base}, line -${cfg.linePct}%, origin ${cfg.allowOrigin})`))
