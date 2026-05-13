import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import {
  searchSymbols,
  getQuotes,
  getChart,
  closestTradingClose,
  getFxRate,
  normalizeCurrency,
  type ChartInterval,
} from './yahoo.js';
import {
  loadPortfolios,
  savePortfolios,
  addPortfolio,
  removePortfolio,
  renamePortfolio,
  addPositionToPortfolio,
  removePositionFromPortfolio,
  setPositionHiddenInPortfolio,
  addSaleToPosition,
  removeSaleFromPosition,
  type Portfolio,
  type Position,
  type PositionSale,
  PORTFOLIOS_FILE,
} from './storage.js';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const DEFAULT_COST_BASIS_USD = 100;

function hasProvidedValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function parsePositiveNumber(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseNonZeroNumber(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(amount) && amount !== 0 ? amount : null;
}

function parseCostBasisUSD(value: unknown): number | null {
  if (!hasProvidedValue(value)) {
    return DEFAULT_COST_BASIS_USD;
  }
  return parseNonZeroNumber(value);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function isISODate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function explicitPositionShares(position: Position): number | null {
  const shares = position.shares;
  return typeof shares === 'number' && Number.isFinite(shares) && shares !== 0 ? shares : null;
}

function explicitPurchasePriceUSD(position: Position): number | null {
  const price = position.purchasePriceUSD;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

function positionCostBasisUSD(position: Position): number {
  const amount = position.costBasisUSD;
  return typeof amount === 'number' && Number.isFinite(amount) && amount !== 0
    ? amount
    : DEFAULT_COST_BASIS_USD;
}

async function resolvePurchasedShares(position: Position): Promise<number | null> {
  const explicitShares = explicitPositionShares(position);
  if (explicitShares !== null) return explicitShares;

  let purchasePriceUSD = explicitPurchasePriceUSD(position);
  if (purchasePriceUSD === null) {
    const close = await closestTradingClose(position.symbol, position.purchaseDate);
    if (!close) return null;
    const normalized = normalizeCurrency(close.close, position.currency, position.symbol);
    const fx = await getFxRate(normalized.currency, 'USD', position.purchaseDate);
    if (fx === null) return null;
    purchasePriceUSD = normalized.price * fx;
  }

  return purchasePriceUSD > 0 ? positionCostBasisUSD(position) / purchasePriceUSD : null;
}

async function resolveSalePriceUSD(position: Position, saleDate: string): Promise<number | null> {
  const close = await closestTradingClose(position.symbol, saleDate);
  if (!close) return null;
  const normalized = normalizeCurrency(close.close, position.currency, position.symbol);
  const fx = await getFxRate(normalized.currency, 'USD', close.date);
  return fx === null ? null : normalized.price * fx;
}

function soldShares(position: Position): number {
  return (position.sales ?? []).reduce((sum, sale) => sum + sale.shares, 0);
}

async function backfillMissingSalePrices(portfolios: Portfolio[]): Promise<Portfolio[]> {
  let changed = false;
  const updated = await Promise.all(
    portfolios.map(async (portfolio) => ({
      ...portfolio,
      positions: await Promise.all(
        portfolio.positions.map(async (position) => {
          if (!position.sales?.some((sale) => sale.salePriceUSD === undefined)) {
            return position;
          }
          const sales = await Promise.all(
            position.sales.map(async (sale) => {
              if (sale.salePriceUSD !== undefined) return sale;
              const salePriceUSD = await resolveSalePriceUSD(position, sale.saleDate);
              if (salePriceUSD === null) return sale;
              changed = true;
              return { ...sale, salePriceUSD };
            }),
          );
          return { ...position, sales };
        }),
      ),
    })),
  );
  if (changed) {
    await savePortfolios(updated);
  }
  return updated;
}

/**
 * Heal positions whose stored `currency` doesn't match the live quote's
 * trading currency. Earlier code paths could fall back to "USD" when Yahoo's
 * `search` response omitted a currency, which then poisoned downstream FX
 * lookups (e.g. 2337.TW reporting TWD prices as USD). The trading currency
 * for a listed symbol is fixed by the exchange, so the live quote is the
 * authoritative source. Best-effort: silently skip when Yahoo is unreachable
 * or the symbol can't be resolved.
 */
async function backfillPositionCurrencies(portfolios: Portfolio[]): Promise<Portfolio[]> {
  const symbols = new Set<string>();
  for (const portfolio of portfolios) {
    for (const position of portfolio.positions) {
      if (position.symbol) symbols.add(position.symbol);
    }
  }
  if (symbols.size === 0) return portfolios;

  const liveCurrencies = new Map<string, string>();
  try {
    const quotes = await getQuotes(Array.from(symbols));
    for (const q of quotes) {
      if (q.currency) liveCurrencies.set(q.symbol, q.currency);
    }
  } catch {
    return portfolios;
  }

  let changed = false;
  const updated = portfolios.map((portfolio) => ({
    ...portfolio,
    positions: portfolio.positions.map((position) => {
      const live = liveCurrencies.get(position.symbol);
      if (!live || live === position.currency) return position;
      changed = true;
      return { ...position, currency: live };
    }),
  }));

  if (changed) {
    await savePortfolios(updated);
  }
  return updated;
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, file: PORTFOLIOS_FILE });
});

// --- Portfolio CRUD ---

app.get('/api/portfolios', async (_req, res, next) => {
  try {
    const loaded = await loadPortfolios();
    const withCurrencies = await backfillPositionCurrencies(loaded);
    const portfolios = await backfillMissingSalePrices(withCurrencies);
    res.json(portfolios);
  } catch (err) {
    next(err);
  }
});

app.post('/api/portfolios', async (req, res, next) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const result = await addPortfolio(name);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

app.patch('/api/portfolios/:portfolioId', async (req, res, next) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    try {
      const result = await renamePortfolio(req.params.portfolioId, name);
      res.json(result);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'portfolio not found' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.delete('/api/portfolios/:portfolioId', async (req, res, next) => {
  try {
    const updated = await removePortfolio(req.params.portfolioId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// --- Positions (nested under a portfolio) ---

app.post('/api/portfolios/:portfolioId/positions', async (req, res, next) => {
  try {
    const {
      symbol,
      name,
      exchange,
      currency,
      purchaseDate,
      costBasisUSD: rawCostBasisUSD,
      shares: rawShares,
      purchasePriceUSD: rawPurchasePriceUSD,
    } = req.body as Partial<Position>;

    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'symbol required' });
      return;
    }
    if (!purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      res.status(400).json({ error: 'purchaseDate must be YYYY-MM-DD' });
      return;
    }
    const hasCostBasis = hasProvidedValue(rawCostBasisUSD);
    const hasShares = hasProvidedValue(rawShares);
    if (hasCostBasis && hasShares) {
      res.status(400).json({ error: 'provide either costBasisUSD or shares, not both' });
      return;
    }

    const purchasePriceUSD = hasProvidedValue(rawPurchasePriceUSD)
      ? parsePositiveNumber(rawPurchasePriceUSD)
      : undefined;
    if (purchasePriceUSD === null) {
      res.status(400).json({ error: 'purchasePriceUSD must be a positive number' });
      return;
    }

    let buyFields: Pick<Position, 'costBasisUSD' | 'shares'>;
    if (hasShares) {
      const shares = parseNonZeroNumber(rawShares);
      if (shares === null) {
        res.status(400).json({ error: 'shares must be a non-zero number' });
        return;
      }
      buyFields = { shares };
    } else {
      const costBasisUSD = parseCostBasisUSD(rawCostBasisUSD);
      if (costBasisUSD === null) {
        res.status(400).json({ error: 'costBasisUSD must be a non-zero number' });
        return;
      }
      buyFields = { costBasisUSD };
    }

    // Preserve case on currency: Yahoo uses lowercase suffixes (GBp, ZAc, ILA)
    // to indicate sub-unit pricing (pence/cents/agorot). Uppercasing here would
    // erase that signal and produce purchase prices 100x too high for LSE etc.
    const rawCurrency = (currency ?? '').trim();
    const normalizedSymbol = symbol.trim().toUpperCase();
    // Yahoo's `search` endpoint sometimes omits `currency` on a hit, which
    // historically caused the client to fall back to "USD" for foreign
    // listings (e.g. 2337.TW persisted as USD instead of TWD). Use the live
    // `quote` as the authoritative source — the trading currency is fixed
    // by the exchange.
    let resolvedCurrency = rawCurrency || 'USD';
    try {
      const liveQuote = (await getQuotes([normalizedSymbol]))[0];
      if (liveQuote?.currency) resolvedCurrency = liveQuote.currency;
    } catch {
      /* best-effort: fall back to caller-supplied currency */
    }

    const position: Position = {
      id: randomUUID(),
      symbol: normalizedSymbol,
      name: name?.trim() ?? normalizedSymbol,
      exchange: exchange ?? '',
      currency: resolvedCurrency,
      purchaseDate,
      hidden: false,
      ...buyFields,
      ...(purchasePriceUSD !== undefined ? { purchasePriceUSD } : {}),
      createdAt: new Date().toISOString(),
    };
    try {
      const updated = await addPositionToPortfolio(req.params.portfolioId, position);
      res.status(201).json({ position, portfolios: updated });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'portfolio not found' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.post('/api/portfolios/:portfolioId/positions/:positionId/sales', async (req, res, next) => {
  try {
    const {
      saleDate,
      shares: rawShares,
      salePriceUSD: rawSalePriceUSD,
      cashWithdrawn: rawCashWithdrawn,
    } = req.body as Partial<PositionSale>;

    if (!isISODate(saleDate)) {
      res.status(400).json({ error: 'saleDate must be YYYY-MM-DD' });
      return;
    }
    if (saleDate > todayISO()) {
      res.status(400).json({ error: 'saleDate cannot be in the future' });
      return;
    }

    const shares = parsePositiveNumber(rawShares);
    if (shares === null) {
      res.status(400).json({ error: 'shares must be a positive number' });
      return;
    }

    let salePriceUSD = hasProvidedValue(rawSalePriceUSD)
      ? parsePositiveNumber(rawSalePriceUSD)
      : undefined;
    if (salePriceUSD === null) {
      res.status(400).json({ error: 'salePriceUSD must be a positive number' });
      return;
    }

    const portfolios = await loadPortfolios();
    const portfolio = portfolios.find((p) => p.id === req.params.portfolioId);
    const position = portfolio?.positions.find((p) => p.id === req.params.positionId);
    if (!portfolio || !position) {
      res.status(404).json({ error: !portfolio ? 'portfolio not found' : 'position not found' });
      return;
    }
    if (saleDate < position.purchaseDate) {
      res.status(400).json({ error: 'saleDate cannot be before purchaseDate' });
      return;
    }

    const purchasedShares = await resolvePurchasedShares(position);
    if (purchasedShares === null || !Number.isFinite(purchasedShares) || purchasedShares === 0) {
      res.status(400).json({ error: 'could not resolve purchased shares for position' });
      return;
    }
    const maxPurchasedShares = Math.abs(purchasedShares);
    const openShares = maxPurchasedShares - soldShares(position);
    if (shares > openShares + 1e-8) {
      res.status(400).json({ error: 'sale exceeds open shares' });
      return;
    }
    if (salePriceUSD === undefined) {
      salePriceUSD = await resolveSalePriceUSD(position, saleDate);
      if (salePriceUSD === null) {
        res.status(400).json({ error: 'could not resolve sale price on or near saleDate' });
        return;
      }
    }

    const sale: PositionSale = {
      id: randomUUID(),
      saleDate,
      shares,
      salePriceUSD,
      cashWithdrawn: rawCashWithdrawn === true,
      createdAt: new Date().toISOString(),
    };

    try {
      const updated = await addSaleToPosition(
        req.params.portfolioId,
        req.params.positionId,
        sale,
        maxPurchasedShares,
      );
      res.status(201).json({ sale, portfolios: updated });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'portfolio or position not found' });
        return;
      }
      if ((err as NodeJS.ErrnoException).code === 'ERANGE') {
        res.status(400).json({ error: 'sale exceeds open shares' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.patch('/api/portfolios/:portfolioId/positions/:positionId', async (req, res, next) => {
  try {
    const { hidden } = req.body as { hidden?: unknown };
    if (typeof hidden !== 'boolean') {
      res.status(400).json({ error: 'hidden must be boolean' });
      return;
    }
    try {
      const updated = await setPositionHiddenInPortfolio(
        req.params.portfolioId,
        req.params.positionId,
        hidden,
      );
      res.json(updated);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'portfolio or position not found' });
        return;
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

app.delete('/api/portfolios/:portfolioId/positions/:positionId/sales/:saleId', async (req, res, next) => {
  try {
    const updated = await removeSaleFromPosition(
      req.params.portfolioId,
      req.params.positionId,
      req.params.saleId,
    );
    res.json(updated);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'portfolio, position, or sale not found' });
      return;
    }
    next(err);
  }
});

app.delete('/api/portfolios/:portfolioId/positions/:positionId', async (req, res, next) => {
  try {
    const updated = await removePositionFromPortfolio(
      req.params.portfolioId,
      req.params.positionId,
    );
    res.json(updated);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'portfolio not found' });
      return;
    }
    next(err);
  }
});

// --- Yahoo Finance proxy ---

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.json([]);
      return;
    }
    const hits = await searchSymbols(q);
    res.json(hits);
  } catch (err) {
    next(err);
  }
});

app.get('/api/quote', async (req, res, next) => {
  try {
    const raw = String(req.query.symbols ?? '').trim();
    if (!raw) {
      res.json([]);
      return;
    }
    const symbols = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (symbols.length === 0) {
      res.json([]);
      return;
    }
    const quotes = await getQuotes(symbols);
    res.json(quotes);
  } catch (err) {
    next(err);
  }
});

const ALLOWED_INTERVALS: readonly ChartInterval[] = ['5m', '30m', '1d', '1wk'] as const;

function parseInterval(raw: unknown): ChartInterval {
  const s = String(raw ?? '').trim();
  return (ALLOWED_INTERVALS as readonly string[]).includes(s) ? (s as ChartInterval) : '1d';
}

app.get('/api/history', async (req, res, next) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim();
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    const interval = parseInterval(req.query.interval);
    if (!symbol) {
      res.status(400).json({ error: 'symbol required' });
      return;
    }
    const fromDate = from ? new Date(`${from}T00:00:00Z`) : new Date(Date.now() - 365 * 24 * 3600 * 1000);
    // End-of-day so the requested calendar day is fully included. With T00:00Z
    // the upper bound was 8pm ET the day before, which excluded today's
    // intraday bars from 5m/30m fetches.
    const toDate = to ? new Date(`${to}T23:59:59Z`) : new Date();
    const rows = await getChart(symbol, fromDate, toDate, interval);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

app.get('/api/close-on', async (req, res, next) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim();
    const on = String(req.query.on ?? '').trim();
    if (!symbol || !on) {
      res.status(400).json({ error: 'symbol and on (YYYY-MM-DD) required' });
      return;
    }
    const close = await closestTradingClose(symbol, on);
    res.json(close);
  } catch (err) {
    next(err);
  }
});

app.get('/api/fx', async (req, res, next) => {
  try {
    const base = String(req.query.base ?? '').trim();
    const quote = String(req.query.quote ?? 'USD').trim();
    const on = String(req.query.on ?? '').trim();
    if (!base || !on) {
      res.status(400).json({ error: 'base and on required' });
      return;
    }
    const rate = await getFxRate(base, quote, on);
    res.json({ base, quote, on, rate });
  } catch (err) {
    next(err);
  }
});

// --- Error handler ---

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[api-error]', err);
  const msg = err.message ?? 'internal error';
  res.status(500).json({ error: msg });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] portfolios file: ${PORTFOLIOS_FILE}`);
});
