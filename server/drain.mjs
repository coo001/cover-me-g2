// npm run drain: TEST HELPER. Sells every free BTC on the testnet account so that
// `doctor` (zero holding) and `seed` can be exercised from an empty state.
import { loadConfig } from './env.mjs'
import { syncClock, account, filters, toStep, marketOrder, explain } from './binance.mjs'

const cfg = loadConfig()
try {
  await syncClock()
  const f = await filters(cfg)
  for (let i = 0; i < 5; i++) {
    const a = await account(cfg)
    const qty = toStep(Number(a.base), f.stepSize)
    if (Number(qty) < Number(f.minQty)) { console.log(`${cfg.base} free ${a.base}. Drained.`); break }
    const { body } = await marketOrder(cfg, 'SELL', qty, `coverme-drain-${Date.now()}`)
    console.log(`SELL ${body.executedQty} ${cfg.base} for ${body.cummulativeQuoteQty} ${cfg.quote}  order ${body.orderId}  ${body.status}`)
    if (Number(body.executedQty) === 0) break
  }
} catch (e) { console.log(`[FAIL] ${explain(e)}`); process.exit(1) }
