// npm run verify -- <orderId>: asks Binance for the order and prints three plain
// lines plus the untouched response, to compare with the glasses Filled screen.
import { loadConfig } from './env.mjs'
import { syncClock, signed, explain } from './binance.mjs'

const cfg = loadConfig()
const orderId = process.argv[2]
if (!/^\d+$/.test(orderId ?? '')) { console.log('Usage: npm run verify -- <orderId>'); process.exit(1) }
try {
  await syncClock()
  const { body, text } = await signed(cfg, 'GET', '/api/v3/order', { symbol: cfg.symbol, orderId })
  console.log(`Order   ${body.orderId}`)
  console.log(`Qty     ${body.executedQty} ${cfg.base}  (${body.side} ${body.type})`)
  console.log(`Status  ${body.status}`)
  console.log(`For     ${body.cummulativeQuoteQty} ${cfg.quote}`)
  console.log('--- raw response from GET /api/v3/order (testnet.binance.vision) ---')
  console.log(text)
} catch (e) { console.log(`[FAIL] ${explain(e)}`); process.exit(1) }
