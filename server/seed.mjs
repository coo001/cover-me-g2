// npm run seed: rebuilds the starting state after a testnet reset or a full sell.
// Buys just enough BTC with testnet USDT to hold the guard amount. Real testnet order.
import { loadConfig } from './env.mjs'
import { pub, syncClock, account, filters, toStep, marketOrder, explain } from './binance.mjs'

const cfg = loadConfig()
try {
  await syncClock()
  const a = await account(cfg)
  const have = Number(a.base)
  console.log(`${cfg.base} free ${a.base}, ${cfg.quote} free ${a.quote}, guard ${cfg.guardBtc}`)
  if (have >= cfg.guardBtc) { console.log('Nothing to do: holding already covers the guard.'); process.exit(0) }
  const f = await filters(cfg)
  const ask = Number((await pub('/api/v3/ticker/bookTicker', { symbol: cfg.symbol })).askPrice)
  const step = Number(f.stepSize)
  let need = Math.ceil((cfg.guardBtc - have) / step - 1e-9) * step
  const minQty = Math.ceil(Number(f.minNotional) / ask / step) * step
  if (need < minQty) need = minQty // exchange minimum order value
  const qty = toStep(need + step / 10, f.stepSize)
  if (Number(a.quote) < need * ask * 1.01) {
    console.log(`[FAIL] not enough testnet ${cfg.quote} (${a.quote}) to buy ${qty} ${cfg.base}. Testnet balances come back at the next reset.`)
    process.exit(1)
  }
  const { body } = await marketOrder(cfg, 'BUY', qty, `coverme-seed-${Date.now()}`)
  console.log(`BUY ${body.executedQty} ${cfg.base} for ${body.cummulativeQuoteQty} ${cfg.quote}  order ${body.orderId}  ${body.status}`)
  const after = await account(cfg)
  console.log(`${cfg.base} free ${after.base}. Seeded. Next: npm run doctor`)
} catch (e) { console.log(`[FAIL] ${explain(e)}`); process.exit(1) }
