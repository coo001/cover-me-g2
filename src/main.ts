// Cover Me - glasses app. One text container, one job per screen.
// Controls: up/down = move, tap = next/confirm, double tap = back (exit at root).
// This app holds no keys. It shows what the backend reports and sends taps.
import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

const BACKEND: string = (import.meta as any).env?.VITE_BACKEND_URL ?? 'http://127.0.0.1:8787'
const OFFLINE_MS = 10_000 // no word from the backend for this long = OFFLINE
const STALE_MS = 15_000   // price older than this = STALE
const ORDER_STALE_MS = 5_000

type Cover = { since: number; till: number; basePrice: number; line: number; guardQty: string }
type Tick = {
  now: number; net: string; price: string | null; priceTs: number; holding: string | null
  guardBtc: number; linePct: number; coverMin: number; cover: Cover | null
  call: { id: number; ts: number; price: string; nextLine: number } | null
}
type Order = { orderId: number; executedQty: string; cummulativeQuoteQty: string; status: string }
type Screen = 'ready' | 'covering' | 'peek' | 'call' | 'confirm' | 'sending' | 'filled' | 'message'

let tick: Tick | null = null
let lastHeard = 0        // local time of the last backend message
let skew = 0             // backend clock - local clock
let screen: Screen = 'ready'
let cursor = 0           // Call list position
let choice: 'half' | 'all' = 'half'
let orderId = ''         // clientOrderId for the call on screen
let filled: { order: Order; left: string } | null = null
let message = ''
let peekTimer: number | undefined

// ---------- formatting ----------
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5)
const money = (n: number) => Math.round(n).toLocaleString('en-US')
const btc = (n: number) => n.toFixed(3)
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
const lines = (rows: string[], total = 9) => rows.concat(Array(Math.max(0, total - rows.length)).fill('')).join('\n')

type Link = 'live' | 'stale' | 'offline'
function link(): Link {
  if (!tick || Date.now() - lastHeard > OFFLINE_MS) return 'offline'
  if (!tick.price || tick.now - tick.priceTs + (Date.now() - lastHeard) > STALE_MS) return 'stale'
  return 'live'
}
function statusLine(): string {
  const l = link()
  if (l === 'offline') return 'OFFLINE - not covering'
  if (l === 'stale') return `STALE since ${hhmm(tick!.priceTs - skew)}`
  return `live ${hhmm(tick!.priceTs - skew)}`
}
const priceAgeMs = () => (tick ? tick.now - tick.priceTs + (Date.now() - lastHeard) : Infinity)

// ---------- screens ----------
function view(): string {
  const t = tick
  const l = link()
  if (screen === 'message') return lines([message, '', '', '', '', '', '', '', 'tap = ok'])
  if (screen === 'filled' && filled) {
    // Every value on this screen is Binance's own string, untouched.
    const o = filled.order
    return lines([
      `${o.status}  ${o.executedQty} BTC`,
      `for ${o.cummulativeQuoteQty} USDT`,
      `Order ${o.orderId}   TESTNET`,
      `Left ${filled.left} BTC`,
      '', '', '', '', 'tap = done',
    ])
  }
  if (!t || l === 'offline') {
    return lines(['COVER ME   TESTNET', '', 'OFFLINE - not covering', 'No orders can be sent.', '', 'Start the backend: npm run server', '', '', 'double tap = exit'])
  }
  const price = Number(t.price)
  if (screen === 'ready') {
    const guard = Math.min(Number(t.holding ?? 0), t.guardBtc)
    return lines([
      'COVER ME   TESTNET',
      `Holding ${btc(guard)} BTC  @ ${money(price)}`,
      `Line  ${money(price * (1 - t.linePct / 100))}  (-${t.linePct}%)`,
      '',
      'Covers only while this app is open.',
      '', '',
      statusLine(),
      `tap = cover for ${t.coverMin} min`,
    ])
  }
  const c = t.cover
  if (!c) return lines(['COVER ME   TESTNET', '', 'Cover ended.', '', '', '', '', statusLine(), 'tap = ok'])
  const since = pct((price / c.basePrice - 1) * 100)
  if (screen === 'peek') {
    return lines([`BTC ${money(price)}   ${since} since ${hhmm(c.since - skew)}`, `Line ${money(c.line)}`, `Watching ${c.guardQty} BTC`, '', '', '', '', '', `covering till ${hhmm(c.till - skew)}    ${statusLine()}`])
  }
  if (screen === 'call' && t.call) {
    const g = Number(c.guardQty)
    const rows = [`Sell half   ${btc(g / 2)} BTC`, `Sell all    ${btc(g)} BTC`, `Hold, ask again at ${money(t.call.nextLine)}`]
    return lines([
      `BTC ${money(price)}   ${since} since ${hhmm(c.since - skew)}`,
      `Below your line ${money(c.line)}`,
      '',
      ...rows.map((r, i) => `${i === cursor ? '>' : '  '} ${r}`),
      '', '',
      l === 'live' ? 'tap = choose' : statusLine(),
    ])
  }
  if ((screen === 'confirm' || screen === 'sending') && t.call) {
    const g = Number(c.guardQty)
    const qty = choice === 'half' ? g / 2 : g
    const stale = priceAgeMs() > ORDER_STALE_MS
    return lines([
      `TESTNET  SELL ${btc(qty)} BTC  market`,
      `about ${money(qty * price)} USDT`,
      '', '', '', '', '',
      screen === 'sending' ? 'sending...' : stale ? 'Price stale, wait' : '',
      screen === 'sending' ? '' : stale ? 'double tap = back' : 'tap = send     double tap = back',
    ])
  }
  // covering: one quiet line at the bottom
  return lines(['', '', '', '', '', '', '', '', `covering till ${hhmm(c.till - skew)}    ${statusLine()}`])
}

// ---------- display ----------
const bridge = await waitForEvenAppBridge()
let shown = lines(['COVER ME', '', 'connecting...'])
await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: 576, height: 288, borderWidth: 0, borderColor: 5,
      paddingLength: 6, containerID: 1, containerName: 'main', content: shown, isEventCapture: 1,
    })],
  }),
)
function render() {
  // Follow the backend: a call takes the screen, the end of a cover gives it back.
  if (tick) {
    const calling = !!tick.cover && !!tick.call && link() !== 'offline'
    if (calling && (screen === 'covering' || screen === 'peek' || screen === 'ready')) {
      screen = 'call'; cursor = 0; orderId = `cm-${tick.call!.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }
    if (!calling && (screen === 'call' || screen === 'confirm')) screen = tick.cover ? 'covering' : 'ready'
    if (tick.cover && screen === 'ready') screen = 'covering'
  }
  const next = view()
  if (next === shown) return
  shown = next
  bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 1, containerName: 'main', content: next }))
}

// ---------- backend link ----------
function connect() {
  const es = new EventSource(`${BACKEND}/api/events`)
  es.onmessage = ev => {
    tick = JSON.parse(ev.data) as Tick
    lastHeard = Date.now()
    skew = tick.now - lastHeard
    render()
  }
  // EventSource reconnects by itself; OFFLINE is decided by silence, not by this event.
  es.onerror = () => render()
}
async function post(path: string, body: unknown): Promise<any> {
  try {
    const r = await fetch(`${BACKEND}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return await r.json()
  } catch { return { ok: false, error: 'offline' } }
}
const say = (m: string) => { message = m; screen = 'message'; render() }
const reason: Record<string, string> = {
  stale: 'Price stale. No order sent.',
  offline: 'OFFLINE. No order sent.',
  no_call: 'That call is over. No order sent.',
  no_holding: 'No BTC to cover. Run: npm run seed',
}

// ---------- input ----------
async function onTap() {
  const l = link()
  if (screen === 'message' || screen === 'filled') { screen = tick?.cover ? 'covering' : 'ready'; filled = null; return render() }
  if (l === 'offline') return
  if (screen === 'ready') {
    const r = await post('/api/start', {})
    if (!r.ok) return say(reason[r.error] ?? 'Could not start.')
    screen = 'covering'; return render()
  }
  if (screen === 'covering') {
    if (!tick?.cover) { screen = 'ready'; return render() }
    screen = 'peek'; render()
    clearTimeout(peekTimer)
    peekTimer = window.setTimeout(() => { if (screen === 'peek') { screen = 'covering'; render() } }, 3000)
    return
  }
  if (screen === 'call' && tick?.call) {
    if (l !== 'live') return // no choices on a dead feed
    if (cursor === 2) { await post('/api/hold', { callId: tick.call.id }); screen = 'covering'; return render() }
    choice = cursor === 0 ? 'half' : 'all'
    screen = 'confirm'; return render()
  }
  if (screen === 'confirm' && tick?.call) {
    if (l !== 'live' || priceAgeMs() > ORDER_STALE_MS) return render() // shows "Price stale, wait"
    screen = 'sending'; render() // a second tap lands here and is ignored
    const r = await post('/api/order', { callId: tick.call.id, choice, clientOrderId: orderId })
    if (r.ok) { filled = { order: r.order, left: r.left }; screen = 'filled'; return render() }
    return say(r.message ?? reason[r.error] ?? 'Order not sent.')
  }
}
function onBack() {
  if (screen === 'confirm') { screen = 'call'; return render() }
  if (screen === 'peek' || screen === 'message') { screen = tick?.cover ? 'covering' : 'ready'; return render() }
  if (screen === 'sending') return
  bridge.shutDownPageContainer(1) // root: system exit dialog
}
function onMove(d: number) {
  if (screen !== 'call') return
  cursor = Math.max(0, Math.min(2, cursor + d)); render()
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT // protobuf drops the zero value (CLICK)
}
bridge.onEvenHubEvent(event => {
  const type = eventTypeOf(event.sysEvent) ?? eventTypeOf(event.textEvent)
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return onBack()
  if (type === OsEventTypeList.CLICK_EVENT) return void onTap()
  if (type === OsEventTypeList.SCROLL_TOP_EVENT) return onMove(-1)
  if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return onMove(1)
})

connect()
setInterval(render, 1000) // keeps the status line honest when the backend goes quiet
