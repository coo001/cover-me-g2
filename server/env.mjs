// Loads configuration. Precedence: process.env > app/.env > files named in COVERME_KEYS_FILE.
// Values are never printed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseEnvFile(file) {
  const out = {}
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return out }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export function loadConfig() {
  const local = parseEnvFile(path.join(APP_DIR, '.env'))
  const keyFiles = (process.env.COVERME_KEYS_FILE || local.COVERME_KEYS_FILE || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  let fromFiles = {}
  for (const f of keyFiles) fromFiles = { ...fromFiles, ...parseEnvFile(f) }
  const get = k => process.env[k] || local[k] || fromFiles[k] || '' // an empty line in .env does not hide a value from a keys file
  const num = (k, d) => { const n = Number(get(k)); return get(k) !== '' && Number.isFinite(n) ? n : d }
  return {
    apiKey: get('BINANCE_TESTNET_API_KEY'),
    secret: get('BINANCE_TESTNET_SECRET_KEY'),
    symbol: 'BTCUSDT',
    base: 'BTC',
    quote: 'USDT',
    port: num('COVERME_PORT', 8787),
    linePct: num('COVERME_LINE_PCT', 2.0),
    guardBtc: num('COVERME_GUARD_BTC', 0.02),
    coverMin: num('COVERME_COVER_MIN', 30),
    allowOrigin: get('COVERME_ALLOW_ORIGIN') || 'http://localhost:5173',
    testHooks: get('COVERME_TEST_HOOKS') === '1',
    icalUrl: get('COVERME_ICAL_URL') || get('DEMO_ICAL_URL'), // secret: never printed
    dataDir: get('COVERME_DATA_DIR') || path.join(APP_DIR, 'data'),
  }
}
