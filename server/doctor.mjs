// npm run doctor: one verdict per line. Exit 0 = ready, 1 = something to fix.
import { loadConfig } from './env.mjs'
import { pub, syncClock, account, explain, REST } from './binance.mjs'

const cfg = loadConfig()
let bad = false
const ok = m => console.log(`[ ok ] ${m}`)
const fail = m => { bad = true; console.log(`[FAIL] ${m}`) }

console.log(`Cover Me doctor - ${REST} (TESTNET only)`)
try {
  const t = Date.now(); await pub('/api/v3/ping'); ok(`testnet reachable (${Date.now() - t} ms)`)
} catch (e) { fail(`testnet: ${explain(e)}`); process.exit(1) }

try {
  const { offsetMs } = await syncClock()
  Math.abs(offsetMs) < 1000 ? ok(`clock offset ${offsetMs} ms`) : fail(`clock offset ${offsetMs} ms: sync the system clock (limit 1000 ms)`)
} catch (e) { fail(`clock: ${explain(e)}`) }

if (!cfg.apiKey || !cfg.secret) {
  fail('key: BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_SECRET_KEY not found. Copy .env.example to .env and fill it in.')
  process.exit(1)
}
try {
  const a = await account(cfg)
  a.canTrade ? ok('API key valid, trading enabled') : fail('key: valid but trading is disabled; enable TRADE on the key')
  const px = await pub('/api/v3/ticker/bookTicker', { symbol: cfg.symbol })
  ok(`${cfg.symbol} best bid ${px.bidPrice}`)
  ok(`${cfg.quote} free ${a.quote}`)
  if (Number(a.base) >= cfg.guardBtc) ok(`${cfg.base} free ${a.base} (covers the ${cfg.guardBtc} ${cfg.base} guard)`)
  else fail(`holding: ${cfg.base} free ${a.base}, need ${cfg.guardBtc}. Run: npm run seed`)
} catch (e) { fail(`key: ${explain(e)}`) }

console.log(bad ? 'Not ready. Fix the FAIL lines above.' : 'Ready. Next: npm run server')
process.exit(bad ? 1 : 0)
