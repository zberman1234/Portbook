# Portbook

A local, single-user theoretical investment portfolio dashboard. Add any ticker from
any exchange Yahoo Finance supports, pick a purchase date, and the dashboard assumes
you bought **$100 USD** of that stock at that day's close. It tracks current value,
total gain/loss, today's change, allocation, and portfolio value over time in a
Fidelity-style positions view.

![overview](./docs/screenshot.png)

## Architecture

```
Portbook/
  client/            Vite + React + TypeScript + Tailwind + TanStack Query + Recharts
  server/            Express + TypeScript + yahoo-finance2 (unofficial Yahoo Finance client)
  portfolio.json     Your portfolio — auto-created on first add
```

- The server owns the data: every add/remove is a REST call to `/api/positions*`
  and is persisted to `portfolio.json` next to `package.json`.
- The client is a dashboard UI that reads from `/api/positions` and proxies Yahoo
  Finance calls (`/api/search`, `/api/quote`, `/api/history`, `/api/fx`,
  `/api/close-on`) through the same server, which handles CORS and caches results
  with LRU.
- All prices are normalized to USD using Yahoo FX pairs (e.g. `GBPUSD=X`). LSE
  symbols that report in GBp (pence) are converted to GBP before FX.

## Setup

Requires Node.js 20+.

```bash
npm install
npm run dev
```

This runs both the server (`http://localhost:8787`) and the client (`http://localhost:5173`)
together. Open http://localhost:5173.

Your portfolio will be written to `./portfolio.json` on the first add. Feel free to
back it up, edit it by hand, or delete it to start over.

## Usage

1. In the **Add position** form, start typing a company name or ticker. Results
   come from Yahoo Finance across all the exchanges they index (NYSE, Nasdaq, LSE,
   XETRA, TSE, HKEX, Euronext, crypto, ETFs, etc.).
2. Pick a date — the dashboard will look up that day's adjusted close (walking
   forward to the next trading day if needed), convert it to USD using that day's
   FX rate, and record `shares = $100 / purchasePriceUSD`.
3. Hit **Refresh** to repoll current quotes. Historical/FX data is cached on the
   server so clicking refresh is cheap.

## API

- `GET  /api/positions` — read portfolio
- `POST /api/positions` — `{ symbol, name?, exchange?, currency?, purchaseDate }`
- `DELETE /api/positions/:id`
- `GET /api/search?q=…`
- `GET /api/quote?symbols=AAPL,MSFT`
- `GET /api/history?symbol=AAPL&from=2023-01-01&to=2024-01-01`
- `GET /api/close-on?symbol=AAPL&on=2023-01-10`
- `GET /api/fx?base=GBP&quote=USD&on=2023-01-10`

## Notes & out of scope

- **Unofficial data**: `yahoo-finance2` scrapes Yahoo; rate limits are modest but
  real. The server caches quotes (10 min) and history/FX (24 h) to be polite.
- **Adjusted close** is used for historical pricing, which accounts for splits and
  dividends on the underlying series.
- Dividends are not separately reinvested on top of that adjusted-close logic.
- No auth or multi-user support — this is designed for a single machine.
- No real-time streaming — quotes refresh on demand via the Refresh button.
