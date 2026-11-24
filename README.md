# Cover Me (G2)

Open Cover Me before you walk into a meeting. It stays on one quiet line and asks you once,
only if your Binance **Spot Testnet** holding falls to your line. Two taps sell on the testnet;
the glasses then show Binance's own order number, quantity and status.

Give it a private iCal address and your meetings switch the watch on and off: it starts by itself
at the meeting's start time and shows a short recap at the end.

Track: 03 Exchanges & Stocks. **Testnet only.** Status: work in progress (day 2 of the hackathon).

## What this app does not do

- It covers only while it is open on the glasses. If you leave the app, it cannot ask and no order goes out.
- It never trades by itself. No tap, no order.
- It is testnet only. There is no mainnet address in the code.
- It has not been tested on real G2 hardware, only in the Even Hub simulator 0.9.5.
- If the backend or the app was away when your line was crossed, nothing is sold. The first thing you see
  afterwards is `MISSED HH:MM while offline`.

## Before you start

- Binance Spot Testnet refuses US IP addresses (HTTP 451). Run the backend from another network. `npm run doctor` tells you.
- Get a key at https://testnet.binance.vision with "Log In with GitHub" (HMAC key; no Binance account, no KYC).
- The testnet is wiped about once a month without notice. After a reset: new key, then `npm run doctor` and `npm run seed`.

## Run it

You need Node.js 22 or newer.

```bash
npm install
cp .env.example .env        # put your TESTNET key and secret in .env (never commit it)
npm run doctor              # reachability, key, clock, holding - one verdict per line
npm run seed                # buys the 0.020 BTC starting holding with testnet USDT, if missing
```

Then three terminals, in this order:

```bash
npm run server              # 1. backend on http://127.0.0.1:8787 (keys stay here)
npm run dev                 # 2. glasses app on http://localhost:5173
npm run simulate            # 3. Even Hub simulator, opens the app
```

Keep the simulator window visible. While another window covers it completely, macOS pauses the
simulator's web view and the glasses display stops updating until the next input.

On the glasses: tap = start a 30 minute cover. When the best bid falls to your line a card appears:
up/down = move, tap = choose, tap again = send, double tap = back. `Hold` takes one tap.
The default line is 2% below the price at start, so on a quiet day no card appears. To see one within
a minute or two, start the backend with a line just under the price: `COVERME_LINE_PCT=0.01 npm run server`.
The price is always the real testnet best bid; nothing in this project invents or replays prices.

## Let your calendar start it

Put a private iCal address in `.env` (Google Calendar: Settings > your calendar > "Secret address in iCal format"):

```bash
COVERME_ICAL_URL=https://calendar.google.com/calendar/ical/.../basic.ics
```

The backend reads it once a minute and never prints it; the glasses only get the next meeting's title and times.

- Ready shows `NEXT 14:00  Portfolio review (20 min)`.
- At the start time the cover starts by itself, no tap, and runs until the meeting's end time.
  If the backend is started in the middle of a meeting, it starts right away.
- At the end time a recap appears: the price move since the cover started, what you sold (Binance's own
  order number and quantity) and `Covered N of M min` - the minutes with a fresh price and the app open.
- Daily and weekly repeats are understood; all-day events are ignored. Without a calendar, or when it
  cannot be read, Ready says so and a tap still gives you a 30 minute cover.

The recap is two template sentences. There is no AI in this app and it never suggests a trade.

Check any order against Binance itself:

```bash
npm run verify -- <orderId>   # prints order id, executed quantity, status and the raw response
```

The line at the bottom tells you whether the watch is alive: `live HH:MM`, `STALE since HH:MM`
(no price for 15 s) or `OFFLINE - not covering` (backend silent for 10 s). In the last two states
no order can be sent. An order is also refused when the price is older than 5 s, and a call can
produce at most one order however many taps arrive.

The backend saves the running cover in `data/state.json`. If it is restarted, the cover comes back and
the glasses reconnect by themselves. For the time it was down it reads Binance's trade history: if a trade
happened at or below your line, the glasses show `MISSED HH:MM while offline` first, and offer to sell only
if the price is still below the line. The same happens when the line is crossed while the app is closed.

`npm run drain` is a test helper: it sells all free testnet BTC so you can try `doctor` and `seed` from zero.

## What existed before Nov 23

Planning notes only. No app code, prototype or video material existed before the kickoff
(Nov 23, 17:00 KST). Before that we read the rules and checked that the simulator starts on this machine.
Existing code used: the official `even-realities/evenhub-templates` minimal template, the Even Hub SDK/CLI/simulator.
The backend has no runtime dependencies beyond Node.js 22+.
