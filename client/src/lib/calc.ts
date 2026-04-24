import type { EnrichedPosition, Position, QuoteSnapshot } from '../types';

export const COST_BASIS_USD = 100;

export interface PriceBundle {
  quote?: QuoteSnapshot;
  purchaseClose: { date: string; close: number } | null;
  purchaseFx: number | null;
  currentFx: number | null;
}

/**
 * Some Yahoo symbols report in sub-units. Known cases:
 *   - LSE (London, .L)         → GBp (pence, 1/100 GBP)
 *   - JSE (Johannesburg, .JO)  → ZAc (cents, 1/100 ZAR)
 *   - TASE (Tel Aviv, .TA)     → ILA (agorot, 1/100 ILS)
 *
 * Pass `symbol` so we can defensively detect pence on `.L` listings even when
 * the upstream currency string has been accidentally uppercased.
 */
function normalizeNativePrice(
  price: number,
  currency: string | undefined,
  symbol?: string,
): { price: number; currency: string } {
  if (!currency) return { price, currency: 'USD' };
  const c = currency;
  const cu = c.toUpperCase();

  if (c === 'GBp' || cu === 'GBX') return { price: price / 100, currency: 'GBP' };
  if (c === 'ZAc' || cu === 'ZAX') return { price: price / 100, currency: 'ZAR' };
  if (c === 'ILA' || cu === 'ILA') return { price: price / 100, currency: 'ILS' };

  if (symbol) {
    const s = symbol.toUpperCase();
    if (s.endsWith('.L') && cu === 'GBP' && price > 1000) {
      return { price: price / 100, currency: 'GBP' };
    }
    if (s.endsWith('.JO') && cu === 'ZAR' && price > 10000) {
      return { price: price / 100, currency: 'ZAR' };
    }
  }

  return { price, currency: cu };
}

export function enrich(position: Position, bundle: PriceBundle): EnrichedPosition {
  const base: EnrichedPosition = {
    ...position,
    shares: 0,
    purchasePriceUSD: 0,
    purchasePriceNative: 0,
    currentPriceUSD: 0,
    currentPriceNative: 0,
    costBasisUSD: COST_BASIS_USD,
    marketValueUSD: 0,
    totalGainUSD: 0,
    totalGainPct: 0,
    dayChangePct: 0,
  };

  if (!bundle.purchaseClose) {
    return { ...base, error: 'No price data on or near purchase date' };
  }

  const buyNative = normalizeNativePrice(
    bundle.purchaseClose.close,
    position.currency,
    position.symbol,
  );
  const buyFx = bundle.purchaseFx ?? 1;
  const purchasePriceUSD = buyNative.price * buyFx;
  if (!Number.isFinite(purchasePriceUSD) || purchasePriceUSD <= 0) {
    return { ...base, error: 'Invalid purchase price' };
  }

  const shares = COST_BASIS_USD / purchasePriceUSD;

  const q = bundle.quote;
  const currentNativeRaw = q?.regularMarketPrice ?? null;
  if (currentNativeRaw === null || currentNativeRaw === undefined) {
    return {
      ...base,
      shares,
      purchasePriceNative: buyNative.price,
      purchasePriceUSD,
      error: 'No current quote',
    };
  }

  const currentNative = normalizeNativePrice(
    currentNativeRaw,
    q?.currency ?? position.currency,
    position.symbol,
  );
  const curFx = bundle.currentFx ?? 1;
  const currentPriceUSD = currentNative.price * curFx;

  const marketValueUSD = shares * currentPriceUSD;
  const totalGainUSD = marketValueUSD - COST_BASIS_USD;
  const totalGainPct = totalGainUSD / COST_BASIS_USD;
  const dayChangePct =
    typeof q?.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent / 100 : 0;

  return {
    ...position,
    shares,
    purchasePriceNative: buyNative.price,
    purchasePriceUSD,
    currentPriceNative: currentNative.price,
    currentPriceUSD,
    costBasisUSD: COST_BASIS_USD,
    marketValueUSD,
    totalGainUSD,
    totalGainPct,
    dayChangePct,
  };
}

export interface Totals {
  cost: number;
  value: number;
  gain: number;
  gainPct: number;
  dayChangeUSD: number;
  dayChangePct: number;
  validCount: number;
}

export function totals(positions: EnrichedPosition[]): Totals {
  const valid = positions.filter((p) => !p.error && p.marketValueUSD > 0);
  const cost = valid.length * COST_BASIS_USD;
  const value = valid.reduce((s, p) => s + p.marketValueUSD, 0);
  const gain = value - cost;
  const gainPct = cost > 0 ? gain / cost : 0;
  const dayChangeUSD = valid.reduce((s, p) => {
    // approximate: market value * day pct / (1 + day pct) = prior-day value delta
    const priorValue = p.marketValueUSD / (1 + p.dayChangePct);
    return s + (p.marketValueUSD - priorValue);
  }, 0);
  const priorValue = valid.reduce((s, p) => s + p.marketValueUSD / (1 + p.dayChangePct), 0);
  const dayChangePct = priorValue > 0 ? dayChangeUSD / priorValue : 0;
  return { cost, value, gain, gainPct, dayChangeUSD, dayChangePct, validCount: valid.length };
}
