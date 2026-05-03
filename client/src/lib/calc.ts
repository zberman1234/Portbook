import type { EnrichedPosition, Position, QuoteSnapshot } from '../types';

export const DEFAULT_COST_BASIS_USD = 100;

export function explicitShares(position: Pick<Position, 'shares'>): number | null {
  const shares = position.shares;
  return typeof shares === 'number' && Number.isFinite(shares) && shares > 0 ? shares : null;
}

export function explicitPurchasePriceUSD(
  position: Pick<Position, 'purchasePriceUSD'>,
): number | null {
  const price = position.purchasePriceUSD;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
}

export function costBasisUSD(
  position: Pick<Position, 'costBasisUSD' | 'shares' | 'purchasePriceUSD'>,
): number {
  const shareQuantity = explicitShares(position);
  const purchasePrice = explicitPurchasePriceUSD(position);
  if (shareQuantity !== null) {
    return purchasePrice !== null ? shareQuantity * purchasePrice : 0;
  }
  const amount = position.costBasisUSD;
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0
    ? amount
    : DEFAULT_COST_BASIS_USD;
}

export function purchaseLot(
  position: Pick<Position, 'costBasisUSD' | 'shares' | 'purchasePriceUSD'>,
  fallbackPurchasePriceUSD: number | null | undefined,
): { shares: number; costBasisUSD: number } | null {
  const purchasePriceUSD = explicitPurchasePriceUSD(position) ?? fallbackPurchasePriceUSD;
  if (
    typeof purchasePriceUSD !== 'number' ||
    !Number.isFinite(purchasePriceUSD) ||
    purchasePriceUSD <= 0
  ) {
    return null;
  }

  const shareQuantity = explicitShares(position);
  if (shareQuantity !== null) {
    return {
      shares: shareQuantity,
      costBasisUSD: shareQuantity * purchasePriceUSD,
    };
  }

  const costBasis = costBasisUSD(position);
  return {
    shares: costBasis / purchasePriceUSD,
    costBasisUSD: costBasis,
  };
}

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
  const fallbackCostBasis = costBasisUSD(position);
  const priceOverride = explicitPurchasePriceUSD(position);
  const base: EnrichedPosition = {
    ...position,
    shares: 0,
    purchasePriceDate: position.purchaseDate,
    quotePriceDate: null,
    purchasePriceUSD: 0,
    purchasePriceNative: 0,
    currentPriceUSD: 0,
    currentPriceNative: 0,
    costBasisUSD: fallbackCostBasis,
    marketValueUSD: 0,
    totalGainUSD: 0,
    totalGainPct: 0,
    dayChangePct: 0,
  };

  if (!bundle.purchaseClose && priceOverride === null) {
    return { ...base, error: 'No price data on or near purchase date' };
  }

  const buyNative = bundle.purchaseClose
    ? normalizeNativePrice(
        bundle.purchaseClose.close,
        position.currency,
        position.symbol,
      )
    : null;
  const buyFx = bundle.purchaseFx ?? 1;
  const fallbackPurchasePriceUSD = buyNative ? buyNative.price * buyFx : null;
  const resolvedPurchasePriceUSD = priceOverride ?? fallbackPurchasePriceUSD;
  const lot = purchaseLot(position, fallbackPurchasePriceUSD);
  if (!lot) {
    return { ...base, error: 'Invalid purchase price' };
  }

  const q = bundle.quote;
  const currentNativeRaw = q?.regularMarketPrice ?? null;
  if (currentNativeRaw === null || currentNativeRaw === undefined) {
    return {
      ...base,
      shares: lot.shares,
      purchasePriceDate: bundle.purchaseClose?.date ?? position.purchaseDate,
      purchasePriceNative: buyNative?.price ?? resolvedPurchasePriceUSD ?? 0,
      purchasePriceUSD: resolvedPurchasePriceUSD ?? 0,
      costBasisUSD: lot.costBasisUSD,
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

  const marketValueUSD = lot.shares * currentPriceUSD;
  const totalGainUSD = marketValueUSD - lot.costBasisUSD;
  const totalGainPct = totalGainUSD / lot.costBasisUSD;
  const quotePriceDate = typeof q?.regularMarketTime === 'string' ? q.regularMarketTime.slice(0, 10) : null;
  const quoteDayChangePct =
    typeof q?.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent / 100 : 0;
  const purchasePriceDate = bundle.purchaseClose?.date ?? position.purchaseDate;
  const dayChangePct =
    quotePriceDate && purchasePriceDate >= quotePriceDate ? totalGainPct : quoteDayChangePct;

  return {
    ...position,
    shares: lot.shares,
    purchasePriceDate,
    quotePriceDate,
    purchasePriceNative: buyNative?.price ?? resolvedPurchasePriceUSD ?? 0,
    purchasePriceUSD: resolvedPurchasePriceUSD ?? 0,
    currentPriceNative: currentNative.price,
    currentPriceUSD,
    costBasisUSD: lot.costBasisUSD,
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
  const cost = valid.reduce((s, p) => s + p.costBasisUSD, 0);
  const value = valid.reduce((s, p) => s + p.marketValueUSD, 0);
  const gain = value - cost;
  const gainPct = cost > 0 ? gain / cost : 0;
  const dayChangeUSD = valid.reduce((s, p) => {
    const quoteDate = p.quotePriceDate;
    if (quoteDate && p.purchasePriceDate >= quoteDate) return s + p.totalGainUSD;

    // Approximate quote-day delta from current value and quoted day percent.
    const priorValue = p.marketValueUSD / (1 + p.dayChangePct);
    return s + (p.marketValueUSD - priorValue);
  }, 0);
  const priorValue = value - dayChangeUSD;
  const dayChangePct = priorValue > 0 ? dayChangeUSD / priorValue : 0;
  return { cost, value, gain, gainPct, dayChangeUSD, dayChangePct, validCount: valid.length };
}
