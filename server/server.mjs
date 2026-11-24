// Cover Me backend. Runs on the user's own machine, next to the keys.
// The glasses app only gets prices and sends taps; keys never leave this process.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './env.mjs'
import { WS, pub, syncClock, account, filters, toStep, marketOrder, signed, explain } from './binance.mjs'
import { fetchEvents, occurrences } from './calendar.mjs'

const cfg = loadConfig()
const STALE_ORDER_MS = 5000 // never send an order on a price older than this
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const state = {
  price: null,      // best bid as Binance sent it (string): the price a sell would hit
  priceTs: 0,       // when this process last received a price
  holding: null,    // free BTC (string from Binance)
  cover: null,      // { since, till, basePrice, line, guardQty, event, coveredMs, orders, calls, holds, missed }
  call: null,       // { id, ts, price, seenByGlasses, clientOrderId?, order?: Promise }
  missed: null,     // { ts }: the line was crossed while nobody could be asked. Shown first on reconnect.
  recap: null,      // summary of the cover that just ended, until the user taps it away
  lastOrder: null,  // Binance's response to the last sell, untouched
  note: null,
}
const STATE_FILE = path.join(cfg.dataDir, 'state.json')
const FRESH_MS = 15000 // same limit the glasses use for STALE
const cal = { events: [], ok: false, fetchedAt: 0, error: cfg.icalUrl ? 'not read yet' : 'not configured' }
const handled = new Set() // calendar occurrences already started (title@start), so one meeting starts one cover
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
  if (c && !state.call && Number(c.guardQty) > 0 && Number(bid) <= c.line) {
    state.call = { id: ++callSeq, ts: Date.now(), price: bid, seenByGlasses: clients.size > 0 }
    c.calls++
    if (!clients.size && !state.missed) { state.missed = { ts: Date.now(), line: c.line }; c.missed++ } // nobody to ask: no order, say so on reconnect
    log(`line reached: bid ${bid} <= line ${c.line} (call ${state.call.id}, glasses ${clients.size ? 'connected' : 'NOT connected -> MISSED'})`)
    persist(); push()
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
// Template sentences only. Inputs: the price move, Binance's own order strings, minutes really covered.
function buildRecap(c, endPrice) {
  const start = c.event?.start ?? c.since, end = c.till
  const total = Math.max(1, Math.round((end - start) / 60000))
  const covered = Math.min(total, Math.round(c.coveredMs / 60000))
  const move = endPrice ? `BTC ${((Number(endPrice) / c.basePrice - 1) * 100 >= 0 ? '+' : '')}${((Number(endPrice) / c.basePrice - 1) * 100).toFixed(2)}%.` : 'BTC move unknown (backend was down).'
  const o = c.orders
  const did = o.length === 1 ? `Sold ${o[0].executedQty} BTC, order ${o[0].orderId}.`
    : o.length > 1 ? `${o.length} sells: orders ${o.map(x => x.orderId).join(', ')}.`
    : c.holds ? 'Line reached, you held. No order.'
    : c.calls ? 'Line reached, no answer. No order.' : 'Line not reached. No order.'
  return {
    title: c.event?.title ?? 'Manual cover', start, end,
    lines: [`${move} ${did}`, `Covered ${covered} of ${total} min.${c.missed ? ` Missed ${c.missed} while offline.` : ''}`],
  }
}
function endCoverIfDue() {
  const c = state.cover
  if (c && Date.now() >= c.till) {
    state.recap = buildRecap(c, Date.now() - state.priceTs < FRESH_MS ? state.price : null)
    log(`cover ended: ${state.recap.title} | ${state.recap.lines.join(' | ')}`)
    state.cover = null; state.call = null; state.missed = null
    persist()
  }
}

// ---------- persistence: a restart must not silently drop a cover ----------
function persist() {
  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true })
    const call = state.call && { id: state.call.id, ts: state.call.ts, price: state.call.price, seenByGlasses: state.call.seenByGlasses, clientOrderId: state.call.clientOrderId }
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ v: 1, alive: Date.now(), cover: state.cover, call, missed: state.missed, recap: state.recap, lastOrder: state.lastOrder, callSeq, handled: [...handled].slice(-50) }))
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE)
  } catch (e) { log(`could not save state: ${e.message}`) }
}
async function restore() {
  let s
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return }
  if (s?.v !== 1) return
  callSeq = s.callSeq ?? 0
  for (const h of s.handled ?? []) handled.add(h)
  state.recap = s.recap ?? null
  state.lastOrder = s.lastOrder ?? null
  state.missed = s.missed ?? null
  const c = s.cover
  if (!c) return
  const now = Date.now(), downFrom = s.alive ?? now
  state.cover = c
  state.call = s.call ?? null
  log(`restored cover from ${new Date(c.since).toTimeString().slice(0, 5)} till ${new Date(c.till).toTimeString().slice(0, 5)}; backend was down ${Math.round((now - downFrom) / 1000)} s`)
  // An order may have been on its way when the process died. Ask Binance instead of guessing.
  if (state.call?.clientOrderId) {
    try {
      const { body: order, text } = await signed(cfg, 'GET', '/api/v3/order', { symbol: cfg.symbol, origClientOrderId: state.call.clientOrderId })
      fs.appendFileSync(path.join(cfg.dataDir, 'orders.jsonl'), text + '\n')
      applyOrder(c, order); state.call = null
      log(`found order ${order.orderId} sent just before the restart`)
    } catch { state.call.clientOrderId = undefined }
  }
  // Did the line get crossed while this process was not watching? Read Binance's own trade tape for the gap.
  let endPrice = null
  const upTo = Math.min(now, c.till)
  if (Number(c.guardQty) > 0 && !state.call && now - downFrom > 5000) {
    try {
      const hit = await firstTradeAtOrBelow(c.line, downFrom, upTo)
      if (hit) {
        state.missed = { ts: hit.ts, line: c.line }
        c.missed++
        log(`MISSED: ${hit.how} ${hit.price} <= line ${c.line} at ${new Date(hit.ts).toTimeString().slice(0, 8)} while the backend was down. No order was sent.`)
      } else log(`gap checked against Binance trades: line ${c.line} was not crossed while down`)
    } catch (e) { log(`could not read trades for the gap: ${explain(e)}`) }
  }
  if (now >= c.till) {
    try { endPrice = (await pub('/api/v3/klines', { symbol: cfg.symbol, interval: '1m', startTime: Math.floor((c.till - 1) / 60000) * 60000, limit: 1 }))[0]?.[4] ?? null } catch {}
  }
  if (now >= c.till) { // the meeting ended while we were down
    state.recap = buildRecap(c, endPrice)
    log(`cover ended while the backend was down: ${state.recap.lines.join(' | ')}`)
    state.cover = null; state.call = null; state.missed = null
  }
  persist()
}
// First real trade at or below `line` between two moments. A trade at that price means the best bid was there.
// Falls back to 1 minute candle lows (whole minutes after the gap began) if the tape is too long to page through.
async function firstTradeAtOrBelow(line, from, to) {
  let params = { symbol: cfg.symbol, startTime: from, endTime: Math.min(to, from + 3599000), limit: 1000 }
  for (let page = 0; page < 25; page++) {
    const rows = await pub('/api/v3/aggTrades', params)
    for (const t of rows) {
      if (t.T > to) return null
      if (Number(t.p) <= line) return { ts: t.T, price: t.p, how: 'trade' }
    }
    if (rows.length < 1000) {
      if (params.endTime && params.endTime < to) { params = { symbol: cfg.symbol, startTime: params.endTime + 1, endTime: Math.min(to, params.endTime + 3600000), limit: 1000 }; continue }
      return null
    }
    params = { symbol: cfg.symbol, fromId: rows.at(-1).a + 1, limit: 1000 }
  }
  const candles = await pub('/api/v3/klines', { symbol: cfg.symbol, interval: '1m', startTime: Math.ceil(from / 60000) * 60000, endTime: to, limit: 1000 })
  const c = candles.find(r => Number(r[3]) <= line)
  return c ? { ts: c[0], price: c[3], how: '1m low' } : null
}
function applyOrder(c, order) {
  state.lastOrder = order
  c.orders.push({ orderId: order.orderId, executedQty: order.executedQty, cummulativeQuoteQty: order.cummulativeQuoteQty, status: order.status })
  c.guardQty = toStep(Math.max(0, Number(c.guardQty) - Number(order.executedQty)), step)
  c.line = nextLine(c.line)
  state.missed = null
}

// ---------- calendar: the meeting turns the cover on and off ----------
const cleanTitle = t => (t.replace(/[^\x20-\x7E]/g, '').trim() || 'Meeting').slice(0, 22)
function nextMeeting(now = Date.now()) {
  const o = occurrences(cal.events, now, now + 7 * 86400000)[0]
  return o ? { title: cleanTitle(o.title), start: o.start, end: o.end } : null
}
async function pollCalendar() {
  if (!cfg.icalUrl) return
  try {
    cal.events = await fetchEvents(cfg.icalUrl)
    if (!cal.ok) log(`calendar read: ${cal.events.length} events`)
    cal.ok = true; cal.error = null; cal.fetchedAt = Date.now()
  } catch (e) {
    if (cal.ok || cal.error === 'not read yet') log(`calendar unreachable: ${e.message}`) // message only; the address is a secret
    cal.ok = false; cal.error = String(e.message).slice(0, 40)
  }
}
let autoNote = ''
async function followCalendar() {
  const m = nextMeeting()
  if (!m || Date.now() < m.start) return
  const key = `${m.title}@${m.start}`
  if (handled.has(key)) return
  const c = state.cover
  if (c) { // a manual cover is running into a meeting: the meeting takes over the end time
    c.event = m; c.till = m.end; handled.add(key)
    log(`meeting "${m.title}" took over the running cover, till ${new Date(m.end).toTimeString().slice(0, 5)}`)
    return persist()
  }
  const r = await start(m)
  if (!r.ok && autoNote !== key + r.error) { autoNote = key + r.error; log(`meeting "${m.title}" started but cover could not: ${r.error}`) }
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
    missed: state.missed, recap: state.recap,
    calendar: { configured: !!cfg.icalUrl, ok: cal.ok, fetchedAt: cal.fetchedAt, error: cal.error, next: nextMeeting() },
    lastOrder: state.lastOrder, note: state.note,
  }
}
function push() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of clients) res.write(data)
}
setInterval(push, 2000) // doubles as the heartbeat the glasses use to detect OFFLINE

// Once a second: count the time really covered, follow the calendar, keep the saved state fresh.
let lastTick = Date.now(), lastSave = 0, following = false
setInterval(async () => {
  const now = Date.now(), dt = Math.min(now - lastTick, 5000)
  lastTick = now
  // "Covered" means: a fresh price here AND the glasses listening.
  if (state.cover && feedOn && now - state.priceTs < FRESH_MS && clients.size) state.cover.coveredMs += dt
  const had = !!state.cover
  endCoverIfDue()
  if (!following) { following = true; try { await followCalendar() } finally { following = false } }
  if (had !== !!state.cover) push()
  if (now - lastSave > 5000) { lastSave = now; persist() }
}, 1000)

// ---------- actions ----------
async function start(meeting = null) {
  if (state.cover) return { ok: true }
  if (!meeting) { // a tap just before a meeting covers through that meeting
    const m = nextMeeting()
    if (m && m.start - Date.now() <= cfg.coverMin * 60000) meeting = m
  }
  if (!state.price || Date.now() - state.priceTs > STALE_ORDER_MS) return { ok: false, error: 'stale' }
  await refreshHolding()
  const guardQty = toStep(Math.min(Number(state.holding ?? 0), cfg.guardBtc), step)
  if (Number(guardQty) <= 0) return { ok: false, error: 'no_holding' }
  const basePrice = Number(state.price)
  state.cover = {
    since: Date.now(), till: meeting ? meeting.end : Date.now() + cfg.coverMin * 60000,
    basePrice, line: Math.round(basePrice * (1 - cfg.linePct / 100) * 100) / 100, guardQty,
    event: meeting, coveredMs: 0, orders: [], calls: 0, holds: 0, missed: 0,
  }
  if (meeting) handled.add(`${meeting.title}@${meeting.start}`)
  state.call = null; state.missed = null; state.recap = null
  log(`cover started${meeting ? ` by meeting "${meeting.title}"` : ' by tap'}: ${guardQty} ${cfg.base} at ${basePrice}, line ${state.cover.line}, till ${new Date(state.cover.till).toTimeString().slice(0, 5)}`)
  persist()
  return { ok: true }
}

function hold(body) {
  if (!state.cover || !state.call || state.call.id !== body.callId) return { ok: false, error: 'no_call' }
  if (state.call.order) return { ok: false, error: 'order_in_flight' }
  state.cover.line = nextLine(state.cover.line)
  state.cover.holds++
  state.call = null; state.missed = null
  log(`hold: next line ${state.cover.line}`)
  persist()
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
      call.clientOrderId = id; persist() // if we die mid-order, the restart asks Binance about this id
      const { body: order, text } = await marketOrder(cfg, 'SELL', qty, id)
      fs.mkdirSync(cfg.dataDir, { recursive: true })
      fs.appendFileSync(path.join(cfg.dataDir, 'orders.jsonl'), text + '\n')
      log(`order ${order.orderId} ${order.status} executedQty ${order.executedQty}`)
      await refreshHolding()
      if (state.cover) applyOrder(state.cover, order) // the cover stays on till its end, even with nothing left, so the recap still comes
      else state.lastOrder = order
      state.call = null
      persist()
      return { ok: true, order, left: state.holding }
    } catch (e) {
      log(`order failed: ${explain(e)}`)
      call.order = null; call.clientOrderId = undefined; ordersById.delete(id); persist()
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
    // A call raised while nobody was connected: offer it only if the price is still at or below the line.
    if (state.call && !state.call.seenByGlasses && !state.call.order) {
      const fresh = Date.now() - state.priceTs < STALE_ORDER_MS
      if (fresh && state.cover && Number(state.price) > state.cover.line) { log('missed call dropped: price is back above the line'); state.call = null }
      else state.call.seenByGlasses = true
      persist()
    }
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    req.on('close', () => { clients.delete(res); log(`glasses disconnected (${clients.size})`) })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, snapshot())
  if (req.method === 'POST') {
    const body = await readJson(req)
    let out
    if (url.pathname === '/api/start') out = await start()
    else if (url.pathname === '/api/stop') { state.cover = null; state.call = null; state.missed = null; state.recap = null; persist(); out = { ok: true } }
    else if (url.pathname === '/api/ack') { // the user tapped a MISSED notice or a Recap away
      if (body.what === 'recap') state.recap = null
      if (body.what === 'missed' && !state.call) state.missed = null
      persist(); out = { ok: true }
    }
    else if (cfg.testHooks && url.pathname === '/api/test/line') {
      // TEST HOOK: moves the user's line (a setting). Prices stay real.
      if (!state.cover || !(Number(body.line) > 0)) out = { ok: false, error: 'no_cover' }
      else { state.cover.line = Number(body.line); log(`test hook: line moved to ${state.cover.line}`); persist(); out = { ok: true, line: state.cover.line } }
    }
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
  await restore()
  await pollCalendar()
} catch (e) {
  console.log(`[FAIL] ${explain(e)}\nRun: npm run doctor`)
  process.exit(1)
}
setInterval(() => syncClock().catch(() => {}), 10 * 60000)
setInterval(refreshHolding, 30000)
setInterval(pollCalendar, 60000)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { persist(); process.exit(0) })
connectFeed()
server.listen(cfg.port, '127.0.0.1', () => log(`Cover Me backend on http://127.0.0.1:${cfg.port}  (TESTNET, guard ${cfg.guardBtc} ${cfg.base}, line -${cfg.linePct}%, origin ${cfg.allowOrigin})`))
