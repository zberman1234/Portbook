import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import {
  searchSymbols,
  getQuotes,
  getChart,
  closestTradingClose,
  getFxRate,
} from './yahoo.js';
import {
  loadPortfolios,
  addPortfolio,
  removePortfolio,
  addPositionToPortfolio,
  removePositionFromPortfolio,
  type Position,
  PORTFOLIOS_FILE,
} from './storage.js';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, file: PORTFOLIOS_FILE });
});

// --- Portfolio CRUD ---

app.get('/api/portfolios', async (_req, res, next) => {
  try {
    const portfolios = await loadPortfolios();
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
    } = req.body as Partial<Position>;

    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'symbol required' });
      return;
    }
    if (!purchaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
      res.status(400).json({ error: 'purchaseDate must be YYYY-MM-DD' });
      return;
    }

    // Preserve case on currency: Yahoo uses lowercase suffixes (GBp, ZAc, ILA)
    // to indicate sub-unit pricing (pence/cents/agorot). Uppercasing here would
    // erase that signal and produce purchase prices 100x too high for LSE etc.
    const rawCurrency = (currency ?? 'USD').trim();
    const position: Position = {
      id: randomUUID(),
      symbol: symbol.trim().toUpperCase(),
      name: name?.trim() ?? symbol.trim().toUpperCase(),
      exchange: exchange ?? '',
      currency: rawCurrency || 'USD',
      purchaseDate,
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

app.get('/api/history', async (req, res, next) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim();
    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!symbol) {
      res.status(400).json({ error: 'symbol required' });
      return;
    }
    const fromDate = from ? new Date(`${from}T00:00:00Z`) : new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const toDate = to ? new Date(`${to}T00:00:00Z`) : new Date();
    const rows = await getChart(symbol, fromDate, toDate);
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
