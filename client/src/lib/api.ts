import type { HistoryRow, Portfolio, Position, QuoteSnapshot, SearchHit } from '../types';

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listPortfolios: () => http<Portfolio[]>('/api/portfolios'),
  createPortfolio: (name: string) =>
    http<{ portfolio: Portfolio; portfolios: Portfolio[] }>('/api/portfolios', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renamePortfolio: (portfolioId: string, name: string) =>
    http<{ portfolio: Portfolio; portfolios: Portfolio[] }>(
      `/api/portfolios/${encodeURIComponent(portfolioId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      },
    ),
  deletePortfolio: (portfolioId: string) =>
    http<Portfolio[]>(`/api/portfolios/${encodeURIComponent(portfolioId)}`, {
      method: 'DELETE',
    }),

  addPosition: (
    portfolioId: string,
    body: {
      symbol: string;
      name?: string;
      exchange?: string;
      currency?: string;
      purchaseDate: string;
      costBasisUSD?: number;
    },
  ) =>
    http<{ position: Position; portfolios: Portfolio[] }>(
      `/api/portfolios/${encodeURIComponent(portfolioId)}/positions`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    ),
  removePosition: (portfolioId: string, positionId: string) =>
    http<Portfolio[]>(
      `/api/portfolios/${encodeURIComponent(portfolioId)}/positions/${encodeURIComponent(positionId)}`,
      { method: 'DELETE' },
    ),

  search: (q: string) =>
    http<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`),

  quote: (symbols: string[]) =>
    http<QuoteSnapshot[]>(
      `/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`,
    ),

  history: (symbol: string, from: string, to?: string) => {
    const params = new URLSearchParams({ symbol, from });
    if (to) params.set('to', to);
    return http<HistoryRow[]>(`/api/history?${params.toString()}`);
  },

  closeOn: (symbol: string, on: string) =>
    http<{ date: string; close: number } | null>(
      `/api/close-on?symbol=${encodeURIComponent(symbol)}&on=${encodeURIComponent(on)}`,
    ),

  fx: (base: string, on: string, quote = 'USD') =>
    http<{ base: string; quote: string; on: string; rate: number | null }>(
      `/api/fx?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}&on=${encodeURIComponent(on)}`,
    ),
};
