import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { enrich, type PriceBundle } from '../lib/calc';
import type { EnrichedPosition, Position } from '../types';

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

  const buyFxQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['fx', p.currency ?? 'USD', p.purchaseDate],
      queryFn: () => api.fx(p.currency ?? 'USD', p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const currentFxQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['fx', p.currency ?? 'USD', 'latest'],
      queryFn: () => {
        const today = new Date().toISOString().slice(0, 10);
        return api.fx(p.currency ?? 'USD', today);
      },
      staleTime: 1000 * 60 * 10,
    })),
  });

  const quotesBySymbol = new Map((quotesQuery.data ?? []).map((q) => [q.symbol, q]));

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
