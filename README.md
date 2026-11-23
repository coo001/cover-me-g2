# Cover Me (G2)

Open Cover Me before you walk into a meeting. It stays on one quiet line and asks you once,
only if your Binance **Spot Testnet** holding falls to your line. Two taps sell on the testnet;
the glasses then show Binance's own order number, quantity and status.

Track: 03 Exchanges & Stocks. **Testnet only.** Status: work in progress (day 1 of the hackathon).

## What this app does not do

- It covers only while it is open on the glasses. If you leave the app, it cannot ask and no order goes out.
- It never trades by itself. No tap, no order.
- It is testnet only. There is no mainnet address in the code.
- It has not been tested on real G2 hardware, only in the Even Hub simulator 0.9.5.

## Before you start

- Binance Spot Testnet refuses US IP addresses (HTTP 451). Run the backend from another network. `npm run doctor` tells you.
- Get a key at https://testnet.binance.vision with "Log In with GitHub" (HMAC key; no Binance account, no KYC).
- The testnet is wiped about once a month without notice. After a reset: new key, then `npm run doctor` and `npm run seed`.

## Run it

```bash
npm install
cp .env.example .env        # put your TESTNET key and secret in .env (never commit it)
npm run doctor              # reachability, key, clock, holding - one verdict per line
npm run seed                # buys the 0.020 BTC starting holding with testnet USDT, if missing
npm run server              # backend on http://127.0.0.1:8787 (keys stay here)
npm run dev                 # glasses app on http://localhost:5173
npm run simulate            # Even Hub simulator
```

On the glasses: tap = start a 30 minute cover. When the best bid falls to your line a card appears:
up/down = move, tap = choose, tap again = send, double tap = back. `Hold` takes one tap.

Check any order against Binance itself:

```bash
npm run verify -- <orderId>   # prints order id, executed quantity, status and the raw response
```

The line at the bottom tells you whether the watch is alive: `live HH:MM`, `STALE since HH:MM`
(no price for 15 s) or `OFFLINE - not covering` (backend silent for 10 s). In the last two states
no order can be sent. An order is also refused when the price is older than 5 s, and a call can
produce at most one order however many taps arrive.

`npm run drain` is a test helper: it sells all free testnet BTC so you can try `doctor` and `seed` from zero.

## What existed before Nov 23

Planning notes only. No app code, prototype or video material existed before the kickoff
(Nov 23, 17:00 KST). Before that we read the rules and checked that the simulator starts on this machine.
Existing code used: the official `even-realities/evenhub-templates` minimal template, the Even Hub SDK/CLI/simulator.
The backend has no runtime dependencies beyond Node.js 22+.
