# Portbook

A local, single-user theoretical investment portfolio dashboard. Add any ticker
from any exchange Yahoo Finance supports, pick a purchase date, and the
dashboard assumes you bought **$100 USD** of that stock at that day's close by
default, or you can enter a custom USD amount for that position. It
tracks current value, total gain/loss, today's change, allocation, and
portfolio value over time in a Fidelity-style positions view. You can organize
holdings into multiple named portfolios and switch between them with tabs.

## Architecture

```
Portbook/
  client/           Vite + React + TypeScript + Tailwind + TanStack Query + Recharts
  server/           Express + TypeScript + yahoo-finance2 (unofficial Yahoo Finance client)
  portfolios.json   Your data — auto-created on first run (gitignored)
```

- The server owns the data: every portfolio/position mutation is a REST call
  and is persisted to `portfolios.json` next to `package.json` (atomic
  write-then-rename, with writes serialized through a promise chain).
- The client is a dashboard UI that reads from `/api/portfolios` and proxies
  Yahoo Finance calls (`/api/search`, `/api/quote`, `/api/history`, `/api/fx`,
  `/api/close-on`) through the same server, which handles CORS and caches
  results with LRU.
- The active portfolio id is persisted in `localStorage` so tab selection
  survives reloads.
- All prices are normalized to USD using Yahoo FX pairs (e.g. `GBPUSD=X`). LSE
  symbols that report in GBp (pence) — and similar sub-unit quotes like ZAc or
  ILA — are converted to their major unit before FX.
- If an older `portfolio.json` (flat positions array) exists on first run, it
  is migrated into a `Default` portfolio inside `portfolios.json` automatically.

## Setup

Requires Node.js 20+.

```bash
npm install
npm run dev
```

This runs both the server (`http://localhost:8787`) and the client
(`http://localhost:5173`) together. Open http://localhost:5173.

Your portfolios will be written to `./portfolios.json` on the first add. Feel
free to back it up, edit it by hand, or delete it to start over.

To produce a production build:

```bash
npm run build     # compiles server (tsc) and client (vite build)
npm run start     # runs the compiled server from server/dist
```

## Usage

1. Use the **portfolio tabs** at the top to pick a portfolio, or click **+ New
   portfolio** to create another one. Click the ✎ button (or double-click a
   tab) to rename a portfolio inline — Enter saves, Esc cancels. Delete
   removes the active portfolio and all its positions.
2. In **Add position**, choose a mode:
   - **Single** — start typing a company name or ticker. Results come from
     Yahoo Finance across every exchange they index (NYSE, Nasdaq, LSE, XETRA,
     TSE, HKEX, Euronext, crypto, ETFs, etc.). Pick a result, pick a date,
     optionally edit the USD amount, add.
   - **Bulk paste** — paste any text and every `$TICKER` mention is extracted,
     resolved against Yahoo's search (preferring exact symbol matches), and
     added to the active portfolio at the chosen date and amount. Per-ticker
     progress is shown as each one is added.
3. The chosen date is used to look up that day's adjusted close (walking
   forward to the next trading day if needed), convert it to USD using that
   day's FX rate, and record `shares = costBasisUSD / purchasePriceUSD`.
4. Hit **Refresh** to repoll current quotes. Historical and FX data are cached
   on the server so refreshes are cheap.

## API

Portfolio CRUD:

- `GET    /api/portfolios` — list all portfolios (with their positions)
- `POST   /api/portfolios` — `{ name }` → `{ portfolio, portfolios }`
- `PATCH  /api/portfolios/:portfolioId` — `{ name }` → `{ portfolio, portfolios }`
- `DELETE /api/portfolios/:portfolioId`

Positions (nested under a portfolio):

- `POST   /api/portfolios/:portfolioId/positions` —
  `{ symbol, name?, exchange?, currency?, purchaseDate, costBasisUSD? }` →
  `{ position, portfolios }`
- `DELETE /api/portfolios/:portfolioId/positions/:positionId`

Yahoo Finance proxy:

- `GET /api/search?q=…`
- `GET /api/quote?symbols=AAPL,MSFT`
- `GET /api/history?symbol=AAPL&from=2023-01-01&to=2024-01-01`
- `GET /api/close-on?symbol=AAPL&on=2023-01-10`
- `GET /api/fx?base=GBP&quote=USD&on=2023-01-10`

Misc:

- `GET /api/health` — liveness + the resolved path of `portfolios.json`

## Notes & out of scope

- **Unofficial data**: `yahoo-finance2` scrapes Yahoo; rate limits are modest
  but real. The server caches quotes (10 min) and history/FX (24 h) to be
  polite.
- **Adjusted close** is used for historical pricing, which accounts for splits
  and dividends on the underlying series.
- Dividends are not separately reinvested on top of that adjusted-close logic.
- No auth or multi-user support — this is designed for a single machine.
- No real-time streaming — quotes refresh on demand via the Refresh button.
