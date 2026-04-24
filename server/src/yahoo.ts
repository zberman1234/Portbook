import YahooFinance from 'yahoo-finance2';
import { LRUCache } from 'lru-cache';

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false, logOptionsErrors: false },
});

const quoteCache = new LRUCache<string, QuoteSnapshot[]>({
  max: 200,
  ttl: 1000 * 60 * 10,
});

const historyCache = new LRUCache<string, ChartQuote[]>({
  max: 500,
  ttl: 1000 * 60 * 60 * 24,
});

const fxCache = new LRUCache<string, number>({
  max: 500,
  ttl: 1000 * 60 * 60 * 24,
});

export interface ChartQuote {
  date: string;
  close: number | null;
  adjclose: number | null;
}

export interface SearchHit {
  symbol: string;
  name: string;
  exchange: string;
  exchangeDisplay?: string;
  quoteType?: string;
  currency?: string;
}

export interface QuoteSnapshot {
  symbol: string;
  shortName?: string;
  exchange?: string;
  currency?: string;
  regularMarketPrice?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: string;
}

export async function searchSymbols(q: string): Promise<SearchHit[]> {
  if (!q || q.trim().length === 0) return [];
  const res = await yahooFinance.search(q, { quotesCount: 20, newsCount: 0 });
  const hits: SearchHit[] = [];
  for (const item of res.quotes) {
    if (!('symbol' in item) || !item.symbol) continue;
    if (!('isYahooFinance' in item) || !item.isYahooFinance) continue;
    const anyItem = item as Record<string, unknown>;
    hits.push({
      symbol: String(anyItem.symbol),
      name: String(anyItem.longname ?? anyItem.shortname ?? anyItem.symbol),
      exchange: String(anyItem.exchange ?? ''),
      exchangeDisplay: anyItem.exchDisp ? String(anyItem.exchDisp) : undefined,
      quoteType: anyItem.quoteType ? String(anyItem.quoteType) : undefined,
      currency: anyItem.currency ? String(anyItem.currency) : undefined,
    });
  }
  return hits;
}

export async function getQuotes(symbols: string[]): Promise<QuoteSnapshot[]> {
  const key = symbols.slice().sort().join(',');
  const cached = quoteCache.get(key);
  if (cached) return cached;

  const result = await yahooFinance.quote(symbols);
  const arr = Array.isArray(result) ? result : [result];
  const snapshots: QuoteSnapshot[] = arr
    .filter(Boolean)
    .map((q: Record<string, unknown>) => ({
      symbol: String(q.symbol),
      shortName: q.shortName ? String(q.shortName) : (q.longName ? String(q.longName) : undefined),
      exchange: q.fullExchangeName ? String(q.fullExchangeName) : (q.exchange ? String(q.exchange) : undefined),
      currency: q.currency ? String(q.currency) : undefined,
      regularMarketPrice: typeof q.regularMarketPrice === 'number' ? q.regularMarketPrice : undefined,
      regularMarketChangePercent:
        typeof q.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent : undefined,
      regularMarketTime: q.regularMarketTime instanceof Date ? q.regularMarketTime.toISOString() : undefined,
    }));

  quoteCache.set(key, snapshots);
  return snapshots;
}

export async function getChart(symbol: string, from: Date, to: Date): Promise<ChartQuote[]> {
  const fromISO = from.toISOString().slice(0, 10);
  const toISO = to.toISOString().slice(0, 10);
  const key = `${symbol}|${fromISO}|${toISO}`;
  const cached = historyCache.get(key);
  if (cached) return cached;

  const res = await yahooFinance.chart(symbol, {
    period1: from,
    period2: to,
    interval: '1d',
  });

  const rows: ChartQuote[] = (res.quotes ?? []).map((q) => ({
    date: (q.date instanceof Date ? q.date : new Date(q.date as unknown as string))
      .toISOString()
      .slice(0, 10),
    close: typeof q.close === 'number' ? q.close : null,
    adjclose: typeof q.adjclose === 'number' ? q.adjclose : null,
  }));

  historyCache.set(key, rows);
  return rows;
}

/**
 * Find the close price on `date` (YYYY-MM-DD) or the next trading day within 7 days.
 * Returns adjusted close if available (already accounts for splits/dividends).
 */
export async function closestTradingClose(
  symbol: string,
  date: string,
): Promise<{ date: string; close: number } | null> {
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 8);
  const rows = await getChart(symbol, start, end);
  for (const row of rows) {
    const price = row.adjclose ?? row.close;
    if (price !== null && row.date >= date) {
      return { date: row.date, close: price };
    }
  }
  return null;
}

/**
 * Map Yahoo's sub-unit currency codes to their parent currencies for FX lookup.
 * Yahoo's FX pairs only exist in the parent code (GBPUSD=X, not GBpUSD=X).
 */
function canonicalCurrency(code: string): string {
  const c = code.trim();
  const u = c.toUpperCase();
  if (c === 'GBp' || u === 'GBX') return 'GBP';
  if (c === 'ZAc' || u === 'ZAX' || u === 'ZAC') return 'ZAR';
  if (u === 'ILA') return 'ILS';
  return u;
}

/**
 * Get FX rate from `base` to `quote` (e.g. GBP -> USD) on a given date.
 * Identity if base === quote. Sub-unit currencies are folded to their parent.
 */
export async function getFxRate(base: string, quote: string, on: string): Promise<number | null> {
  const B = canonicalCurrency(base);
  const Q = canonicalCurrency(quote);
  if (B === Q) return 1;

  const pair = `${B}${Q}=X`;
  const key = `${pair}|${on}`;
  const cached = fxCache.get(key);
  if (cached !== undefined) return cached;
  const rate = await fxHistorical(pair, on);
  if (rate !== null) fxCache.set(key, rate);
  return rate;
}

async function fxHistorical(pair: string, on: string): Promise<number | null> {
  try {
    const r = await closestTradingClose(pair, on);
    return r ? r.close : null;
  } catch {
    return null;
  }
}

/**
 * Normalize price currency quirks. Yahoo reports certain exchanges in sub-units
 * (LSE: GBp pence; JSE: ZAc cents; TASE: ILA agorot). Returns a price in the
 * "major" unit and the corrected currency code for FX lookup.
 *
 * Pass `symbol` if known so we can detect pence on `.L` listings even when the
 * caller has accidentally uppercased the currency (legacy stored positions).
 */
export function normalizeCurrency(
  price: number,
  currency: string | undefined,
  symbol?: string,
): { price: number; currency: string } {
  if (!currency) return { price, currency: 'USD' };
  const c = currency.toUpperCase();

  if (currency === 'GBp' || c === 'GBX') return { price: price / 100, currency: 'GBP' };
  if (currency === 'ZAc' || c === 'ZAX') return { price: price / 100, currency: 'ZAR' };
  if (currency === 'ILA' || c === 'ILA') return { price: price / 100, currency: 'ILS' };

  if (symbol) {
    const s = symbol.toUpperCase();
    if (s.endsWith('.L') && c === 'GBP' && price > 1000) {
      return { price: price / 100, currency: 'GBP' };
    }
    if (s.endsWith('.JO') && c === 'ZAR' && price > 10000) {
      return { price: price / 100, currency: 'ZAR' };
    }
  }

  return { price, currency: c };
}
