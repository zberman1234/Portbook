export interface Position {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  purchaseDate: string; // YYYY-MM-DD
  costBasisUSD?: number;
  createdAt: string;
}

export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
  positions: Position[];
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

export interface HistoryRow {
  date: string;
  close: number | null;
  adjclose: number | null;
}

export interface EnrichedPosition extends Position {
  shares: number;
  purchasePriceUSD: number;
  purchasePriceNative: number;
  currentPriceUSD: number;
  currentPriceNative: number;
  costBasisUSD: number;
  marketValueUSD: number;
  totalGainUSD: number;
  totalGainPct: number;
  dayChangePct: number;
  error?: string;
}
