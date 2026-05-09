import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { enrich, type PriceBundle } from '../lib/calc';
import type { EnrichedPosition, Position } from '../types';

function todayLocalISO(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function quoteDateISO(regularMarketTime: string | undefined): string | null {
  if (!regularMarketTime || regularMarketTime.length < 10) return null;
  const date = regularMarketTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * Fetch current quotes (batched) + per-position purchase-day close + FX on both dates.
 */
export function useEnrichedPositions(positions: Position[]) {
  const symbols = positions.map((p) => p.symbol);

  const quotesQuery = useQuery({
    queryKey: ['quote', [...symbols].sort().join(',')],
    queryFn: () => (symbols.length === 0 ? [] : api.quote(symbols)),
    enabled: true,
    staleTime: 1000 * 60,
  });

  const closeOnQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['close-on', p.symbol, p.purchaseDate],
      queryFn: () => api.closeOn(p.symbol, p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const quotesBySymbol = new Map((quotesQuery.data ?? []).map((q) => [q.symbol, q]));

  // Prefer the live quote's currency as the trading-currency for FX lookups.
  // Stored currency can be wrong (e.g. saved as "USD" for 2337.TW when Yahoo's
  // search omitted the currency on the original hit); the live quote is fixed
  // by the exchange and is therefore authoritative. Falls back to the stored
  // currency until quotes have loaded.
  const effectiveCurrencies = positions.map(
    (p) => quotesBySymbol.get(p.symbol)?.currency ?? p.currency ?? 'USD',
  );
  const fallbackToday = todayLocalISO();
  const effectiveCurrentDates = positions.map((p) =>
    quoteDateISO(quotesBySymbol.get(p.symbol)?.regularMarketTime) ?? fallbackToday,
  );

  const buyFxQueries = useQueries({
    queries: positions.map((p, i) => ({
      queryKey: ['fx', effectiveCurrencies[i], p.purchaseDate],
      queryFn: () => api.fx(effectiveCurrencies[i], p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const currentFxQueries = useQueries({
    queries: positions.map((_, i) => ({
      queryKey: ['fx', effectiveCurrencies[i], effectiveCurrentDates[i], 'current'],
      queryFn: () => api.fx(effectiveCurrencies[i], effectiveCurrentDates[i]),
      staleTime: 1000 * 60 * 10,
    })),
  });

  const enriched: EnrichedPosition[] = positions.map((p, i) => {
    const bundle: PriceBundle = {
      quote: quotesBySymbol.get(p.symbol),
      purchaseClose: closeOnQueries[i]?.data ?? null,
      purchaseFx: buyFxQueries[i]?.data?.rate ?? null,
      currentFx: currentFxQueries[i]?.data?.rate ?? null,
    };
    return enrich(p, bundle);
  });

  const isLoading =
    quotesQuery.isLoading ||
    closeOnQueries.some((q) => q.isLoading) ||
    buyFxQueries.some((q) => q.isLoading) ||
    currentFxQueries.some((q) => q.isLoading);

  const isFetching =
    quotesQuery.isFetching ||
    closeOnQueries.some((q) => q.isFetching) ||
    buyFxQueries.some((q) => q.isFetching) ||
    currentFxQueries.some((q) => q.isFetching);

  return { enriched, isLoading, isFetching };
}
