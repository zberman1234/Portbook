import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { costBasisUSD, explicitPurchasePriceUSD, purchaseLot } from '../lib/calc';
import { fmtPct, fmtUSD, fmtUSDSigned } from '../lib/format';
import { closingCashFlowUSD } from '../lib/positions';
import type { HistoryRow, Position } from '../types';

interface Props {
  positions: Position[];
  portfolioReturn?: {
    gain: number;
    pct: number;
    endValue: number;
  };
}

// `flow` = cumulative external cash flow into the portfolio at this row:
// + new-position cost basis on activation, − withdrawn sale proceeds on
// withdrawal. Used as the TWR cash-flow proxy. `cost` is gross cost basis
// (constant once activated, ignores withdrawals) and is what the Balance-mode
// reference line / dollar-gain math uses.
type ChartRow = {
  date: string;
  value: number;
  cost: number;
  flow: number;
  [key: string]: number | string;
};

type DateSelection = {
  startDate: string;
  endDate: string;
};

type TimeWindowKey = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' | 'ALL';

type ChartInterval = '5m' | '30m' | '1d' | '1wk';

const TIME_WINDOWS: { key: TimeWindowKey; label: string }[] = [
  { key: '1D', label: '1D' },
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: '6M', label: '6M' },
  { key: '1Y', label: '1Y' },
  { key: '2Y', label: '2Y' },
  { key: '5Y', label: '5Y' },
  { key: 'ALL', label: 'ALL' },
];

const DEFAULT_PERFORMANCE_WINDOW: TimeWindowKey = 'ALL';

type ChartMode = 'twr' | 'balance';
const DEFAULT_CHART_MODE: ChartMode = 'twr';

const CHART_MODES: { key: ChartMode; label: string }[] = [
  { key: 'twr', label: 'TWR' },
  { key: 'balance', label: 'Balance' },
];

function intervalForWindow(w: TimeWindowKey): ChartInterval {
  switch (w) {
    case '1D':
      return '5m';
    case '1W':
      return '30m';
    case '1M':
    case '3M':
    case '6M':
      return '1d';
    case '1Y':
    case '2Y':
    case '5Y':
    case 'ALL':
      return '1wk';
  }
}

// Yahoo caps 5m at ~7 days and 30m at ~60 days; for short windows we fetch
// only the recent slice we'll display (with a small cushion for weekends).
function historyFromForWindow(
  w: TimeWindowKey,
  purchaseDate: string,
  today: string,
): string {
  switch (w) {
    case '1D':
      return shiftDateISO(today, -4, 'day');
    case '1W':
      return shiftDateISO(today, -14, 'day');
    default:
      return purchaseDate;
  }
}

// React Query staleTime per interval — mirror the server's HISTORY_TTLS.
function staleTimeForInterval(interval: ChartInterval): number {
  switch (interval) {
    case '5m':
      return 1000 * 60;
    case '30m':
      return 1000 * 60 * 5;
    case '1d':
      return 1000 * 60 * 60;
    case '1wk':
      return 1000 * 60 * 60 * 24;
  }
}

function dateKey(s: string): string {
  return s.slice(0, 10);
}

function formatTickLabel(s: string, interval: ChartInterval): string {
  if (interval === '5m') {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }
  if (interval === '30m') {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  }
  return s.slice(0, 10);
}

const BENCHMARKS: { symbol: string; label: string; color: string }[] = [
  { symbol: 'SPY', label: 'S&P 500 (SPY)', color: '#60a5fa' },
  { symbol: 'SMH', label: 'SMH', color: '#f59e0b' },
];

// Periods per year by bar interval — used to annualize per-period returns into
// Sharpe. 5m/30m use the ~6.5-hour US regular session (78 / 13 bars per day).
function periodsPerYear(interval: ChartInterval): number {
  switch (interval) {
    case '5m': return 252 * 78;
    case '30m': return 252 * 13;
    case '1d': return 252;
    case '1wk': return 52;
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDateISO(dateISO: string, amount: number, unit: 'day' | 'month' | 'year'): string {
  const date = new Date(`${dateISO}T00:00:00Z`);
  if (unit === 'day') date.setUTCDate(date.getUTCDate() + amount);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
  if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() + amount);
  return date.toISOString().slice(0, 10);
}

function windowStartDate(windowKey: TimeWindowKey, today: string): string | null {
  switch (windowKey) {
    case '1D':
      return shiftDateISO(today, -1, 'day');
    case '1W':
      return shiftDateISO(today, -7, 'day');
    case '1M':
      return shiftDateISO(today, -1, 'month');
    case '3M':
      return shiftDateISO(today, -3, 'month');
    case '6M':
      return shiftDateISO(today, -6, 'month');
    case '1Y':
      return shiftDateISO(today, -1, 'year');
    case '2Y':
      return shiftDateISO(today, -2, 'year');
    case '5Y':
      return shiftDateISO(today, -5, 'year');
    case 'ALL':
      return null;
  }
}

function visibleRowsForWindow(rows: ChartRow[], windowKey: TimeWindowKey, today: string): ChartRow[] {
  // For 1D we fetched a multi-day buffer (covers weekends/holidays); show only
  // the bars from the most recent trading day that actually has data.
  if (windowKey === '1D' && rows.length > 0) {
    const lastDate = rows[rows.length - 1].date.slice(0, 10);
    return rows.filter((r) => r.date.slice(0, 10) === lastDate);
  }
  const startDate = windowStartDate(windowKey, today);
  if (!startDate) return rows;
  const windowRows = rows.filter((row) => row.date >= startDate);
  if (windowRows.length > 0) return windowRows;
  return windowKey === '1D' ? rows.slice(-2) : rows.slice(-1);
}

function normalizeNative(price: number | null, currency: string | undefined): number | null {
  if (price === null) return null;
  if (!currency) return price;
  if (currency === 'GBp' || currency.toUpperCase() === 'GBX') return price / 100;
  if (currency === 'ZAc' || currency.toUpperCase() === 'ZAX') return price / 100;
  return price;
}

function buildPriceMap(history: HistoryRow[] | undefined): Map<string, number> {
  const m = new Map<string, number>();
  (history ?? []).forEach((r) => {
    const v = r.adjclose ?? r.close;
    if (v !== null) m.set(r.date, v);
  });
  return m;
}

function firstPriceOnOrAfter(
  sortedDates: string[],
  priceByDate: Map<string, number>,
  target: string,
): number | null {
  for (const d of sortedDates) {
    if (d >= target) {
      const v = priceByDate.get(d);
      if (typeof v === 'number') return v;
    }
  }
  return null;
}

function annualizedSharpe(dailyReturns: number[], interval: ChartInterval): number | null {
  if (dailyReturns.length < 2) return null;
  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((s, x) => s + x, 0) / n;
  const variance =
    dailyReturns.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;
  return (mean / std) * Math.sqrt(periodsPerYear(interval));
}

function performanceValueFromSignedExposure(value: number, cost: number, grossCost: number): number {
  return grossCost + (value - cost);
}

function orderedSelection(a: string, b: string): DateSelection {
  return a <= b ? { startDate: a, endDate: b } : { startDate: b, endDate: a };
}

function getActiveDate(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const activeLabel = (state as { activeLabel?: unknown }).activeLabel;
  return typeof activeLabel === 'string' ? activeLabel : null;
}

function rangeReturn(rows: ChartRow[], key: string, startDate: string, endDate: string) {
  const windowRows = rows.filter(
    (row) => row.date >= startDate && row.date <= endDate && typeof row[key] === 'number',
  );
  const start = windowRows[0];
  const end = windowRows[windowRows.length - 1];
  if (!start || !end) return null;
  const startValue = start[key];
  const endValue = end[key];
  if (typeof startValue !== 'number' || typeof endValue !== 'number' || startValue === 0) {
    return null;
  }
  const gain = endValue - startValue;
  return {
    gain,
    pct: gain / Math.abs(startValue),
    startValue,
    endValue,
  };
}

// Pick the row field to treat as the external cash flow for a given series.
// Portfolio uses `flow` (deposits − withdrawn sale proceeds). Benchmarks hold
// SPY/SMH bought at each purchase date and never sell — withdrawals don't
// affect them — so they use `cost` (activation deposits only).
function flowKeyFor(key: string): 'flow' | 'cost' {
  return key === 'value' ? 'flow' : 'cost';
}

// Daily-Valuation TWR: chain (1 + period_return) where period_return treats the
// row-to-row change in the series-specific flow field as an external cash flow
// that doesn't count as return. Cash flow assumed at start of period.
function twrRangeReturn(rows: ChartRow[], key: string, startDate: string, endDate: string) {
  const windowRows = rows.filter(
    (row) => row.date >= startDate && row.date <= endDate && typeof row[key] === 'number',
  );
  if (windowRows.length < 2) return null;
  const start = windowRows[0];
  const end = windowRows[windowRows.length - 1];
  const startValue = start[key];
  const endValue = end[key];
  if (typeof startValue !== 'number' || typeof endValue !== 'number') return null;

  const fk = flowKeyFor(key);
  let twr = 1;
  for (let i = 1; i < windowRows.length; i++) {
    const prev = windowRows[i - 1];
    const cur = windowRows[i];
    const prevV = prev[key];
    const curV = cur[key];
    if (typeof prevV !== 'number' || typeof curV !== 'number') continue;
    const cashFlow = (cur[fk] ?? 0) - (prev[fk] ?? 0);
    const denom = prevV + cashFlow;
    if (denom <= 0) continue;
    twr *= 1 + (curV - denom) / denom;
  }

  const pct = twr - 1;
  const netFlow = (end[fk] ?? 0) - (start[fk] ?? 0);
  const gain = endValue - startValue - netFlow;
  return { gain, pct, startValue, endValue };
}

// Transform a chart slice into a TWR series indexed from the window's start (0%).
// Each key gets its own series-specific flow term (portfolio = flow, benchmarks
// = cost), so a withdrawal on the portfolio side doesn't distort SPY/SMH.
function toTwrSeries(rows: ChartRow[], keys: string[]): ChartRow[] {
  if (rows.length === 0) return [];
  const twr: Record<string, number> = {};
  for (const k of keys) twr[k] = 1;
  const out: ChartRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      const prev = rows[i - 1];
      const cur = rows[i];
      for (const k of keys) {
        const prevV = prev[k];
        const curV = cur[k];
        if (typeof prevV !== 'number' || typeof curV !== 'number') continue;
        const fk = flowKeyFor(k);
        const cashFlow = (cur[fk] ?? 0) - (prev[fk] ?? 0);
        const denom = prevV + cashFlow;
        if (denom <= 0) continue;
        twr[k] *= 1 + (curV - denom) / denom;
      }
    }
    const row: ChartRow = { date: rows[i].date, value: 0, cost: 0, flow: 0 };
    for (const k of keys) {
      if (typeof rows[i][k] === 'number') row[k] = twr[k] - 1;
    }
    out.push(row);
  }
  return out;
}

function dailyReturnsFromSeries(series: ChartRow[], key: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (cur.cost !== prev.cost || cur.flow !== prev.flow) continue;
    const a = cur[key];
    const b = prev[key];
    if (typeof a !== 'number' || typeof b !== 'number' || b === 0) continue;
    out.push((a - b) / Math.abs(b));
  }
  return out;
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return '';
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${formatter.format(new Date(`${startDate.slice(0, 10)}T00:00:00Z`))}–${formatter.format(
    new Date(`${endDate.slice(0, 10)}T00:00:00Z`),
  )}`;
}

export function PerformanceChart({ positions, portfolioReturn }: Props) {
  const today = todayISO();
  const [selectedWindow, setSelectedWindow] = useState<TimeWindowKey>(DEFAULT_PERFORMANCE_WINDOW);
  const [chartMode, setChartMode] = useState<ChartMode>(DEFAULT_CHART_MODE);
  const [dragStartDate, setDragStartDate] = useState<string | null>(null);
  const [dragEndDate, setDragEndDate] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<DateSelection | null>(null);

  const earliest = useMemo(() => {
    if (positions.length === 0) return today;
    return positions.reduce(
      (min, p) => (p.purchaseDate < min ? p.purchaseDate : min),
      positions[0].purchaseDate,
    );
  }, [positions, today]);

  const symbols = useMemo(() => positions.map((p) => p.symbol), [positions]);

  const interval = intervalForWindow(selectedWindow);
  const historyStaleTime = staleTimeForInterval(interval);

  const quotesQuery = useQuery({
    queryKey: ['quote', [...symbols].sort().join(',')],
    queryFn: () => (symbols.length === 0 ? [] : api.quote(symbols)),
    enabled: positions.length > 0,
    staleTime: 1000 * 60,
  });

  const quotesBySymbol = useMemo(
    () => new Map((quotesQuery.data ?? []).map((q) => [q.symbol, q])),
    [quotesQuery.data],
  );

  // Prefer the live quote's currency as the trading-currency for FX lookups.
  // Stored currency can be stale (e.g. legacy data saved as "USD" for 2337.TW
  // when Yahoo's search omitted the currency on the hit); the live quote is
  // fixed by the exchange and is therefore authoritative.
  const effectiveCurrencies = useMemo(
    () => positions.map((p) => quotesBySymbol.get(p.symbol)?.currency ?? p.currency ?? 'USD'),
    [positions, quotesBySymbol],
  );

  const historyQueries = useQueries({
    queries: positions.map((p) => {
      const from = historyFromForWindow(selectedWindow, p.purchaseDate, today);
      return {
        queryKey: ['history', p.symbol, from, interval],
        queryFn: () => api.history(p.symbol, from, today, interval),
        staleTime: historyStaleTime,
      };
    }),
  });

  // FX rates are kept at daily granularity regardless of window — intraday FX
  // jitter doesn't meaningfully affect the chart, and daily keys merge cleanly
  // with intraday stock timestamps via dateKey(). The from-date matches the
  // stock window so short views don't drag in years of FX data.
  const fxSeriesQueries = useQueries({
    queries: positions.map((p, i) => {
      const cur = effectiveCurrencies[i];
      const cu = cur.toUpperCase();
      const fxFrom = historyFromForWindow(selectedWindow, p.purchaseDate, today);
      return {
        queryKey: ['history', `${cu}USD=X`, fxFrom, '1d'],
        queryFn: () => {
          if (cu === 'USD') return Promise.resolve([]);
          const pair = `${cu}USD=X`;
          return api.history(pair, fxFrom, today, '1d');
        },
        staleTime: 1000 * 60 * 60,
      };
    }),
  });

  const buyCloseQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['close-on', p.symbol, p.purchaseDate],
      queryFn: () => api.closeOn(p.symbol, p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const buyFxQueries = useQueries({
    queries: positions.map((p, i) => ({
      queryKey: ['fx', effectiveCurrencies[i].toUpperCase(), p.purchaseDate],
      queryFn: () => api.fx(effectiveCurrencies[i], p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const benchmarkFrom = historyFromForWindow(selectedWindow, earliest, today);

  const spyHistoryQuery = useQuery({
    queryKey: ['history', 'SPY', benchmarkFrom, interval],
    queryFn: () => api.history('SPY', benchmarkFrom, today, interval),
    staleTime: historyStaleTime,
    enabled: positions.length > 0,
  });

  const smhHistoryQuery = useQuery({
    queryKey: ['history', 'SMH', benchmarkFrom, interval],
    queryFn: () => api.history('SMH', benchmarkFrom, today, interval),
    staleTime: historyStaleTime,
    enabled: positions.length > 0,
  });

  const benchmarkQueries = [spyHistoryQuery, smhHistoryQuery];

  const isLoading =
    historyQueries.some((q) => q.isLoading) ||
    fxSeriesQueries.some((q) => q.isLoading) ||
    buyCloseQueries.some((q) => q.isLoading) ||
    buyFxQueries.some((q) => q.isLoading) ||
    benchmarkQueries.some((q) => q.isLoading);

  const { chartData, stats } = useMemo(() => {
    const datesSet = new Set<string>();
    positions.forEach((_, i) => {
      (historyQueries[i]?.data ?? []).forEach((r) => datesSet.add(r.date));
    });
    const allDates = Array.from(datesSet).sort();

    // Activate each position at the midpoint of its bars on purchaseDate so the
    // cost-basis injection lands at the local midday of the position's exchange
    // (NYSE ≈ 17:30 UTC, Tokyo ≈ 03:00 UTC, etc.) instead of UTC midnight.
    // Daily/weekly intervals naturally collapse to the purchaseDate bar.
    const activationByPosition: string[] = positions.map((p, i) => {
      const history = historyQueries[i]?.data ?? [];
      const dayBars = history
        .filter((r) => r.date.startsWith(p.purchaseDate))
        .map((r) => r.date)
        .sort();
      return dayBars.length > 0
        ? dayBars[Math.floor(dayBars.length / 2)]
        : `${p.purchaseDate}T12:00:00.000Z`;
    });

    type Snap = {
      costBasisUSD: number;
      usdByDate: Map<string, number>;
      withdrawnByDate: Map<string, number>;
    };

    const snaps: (Snap | null)[] = positions.map((p, i) => {
      const buyClose = buyCloseQueries[i]?.data;
      const effectiveCurrency = effectiveCurrencies[i];
      const isUsd = effectiveCurrency.toUpperCase() === 'USD';
      const buyFxRate = buyFxQueries[i]?.data?.rate ?? (isUsd ? 1 : null);
      const priceOverride = explicitPurchasePriceUSD(p);
      if (
        priceOverride === null &&
        (!buyClose || buyFxRate === null || buyFxRate === undefined)
      ) {
        return null;
      }

      const buyNative = buyClose ? normalizeNative(buyClose.close, effectiveCurrency) ?? 0 : null;
      const purchasePriceUSD =
        buyNative !== null && buyFxRate !== null && buyFxRate !== undefined
          ? buyNative * buyFxRate
          : null;
      const lot = purchaseLot(p, purchasePriceUSD);
      if (!lot) return null;

      const history = historyQueries[i]?.data ?? [];
      const fxHistory = fxSeriesQueries[i]?.data ?? [];
      const fxByDate = new Map<string, number>();
      if (isUsd) {
        fxByDate.set('__identity__', 1);
      } else {
        fxHistory.forEach((r) => {
          const v = r.adjclose ?? r.close;
          if (v !== null) fxByDate.set(dateKey(r.date), v);
        });
      }

      const usdByDate = new Map<string, number>();
      const withdrawnByDate = new Map<string, number>();
      const sales = (p.sales ?? []).slice().sort((a, b) => a.saleDate.localeCompare(b.saleDate));
      let lastFx = buyFxRate ?? null;
      history.forEach((r) => {
        const closeNative = normalizeNative(r.adjclose ?? r.close, effectiveCurrency);
        if (closeNative === null) return;
        if (!isUsd) {
          const fxOnDay = fxByDate.get(dateKey(r.date));
          if (typeof fxOnDay === 'number') lastFx = fxOnDay;
        }
        if (lastFx === null) return;
        const priceUSD = closeNative * lastFx;
        const completedSales = sales.filter((sale) => sale.saleDate <= dateKey(r.date));
        const soldShares = completedSales.reduce((sum, sale) => sum + sale.shares, 0);
        // Retained sale proceeds stay inside the portfolio's market value;
        // withdrawn proceeds are tracked separately as external cash flows for
        // TWR (the value below intentionally excludes them).
        const retainedSaleCash = completedSales
          .filter((sale) => !sale.cashWithdrawn)
          .reduce((sum, sale) => sum + closingCashFlowUSD(p, sale), 0);
        const withdrawnSaleCash = completedSales
          .filter((sale) => sale.cashWithdrawn)
          .reduce((sum, sale) => sum + closingCashFlowUSD(p, sale), 0);
        const openSharesAbs = Math.max(0, Math.abs(lot.shares) - soldShares);
        const openShares = Math.sign(lot.shares) * openSharesAbs;
        usdByDate.set(r.date, priceUSD * openShares + retainedSaleCash);
        withdrawnByDate.set(r.date, withdrawnSaleCash);
      });

      return { costBasisUSD: lot.costBasisUSD, usdByDate, withdrawnByDate };
    });

    const costBasisByPosition = positions.map((p, i) => snaps[i]?.costBasisUSD ?? costBasisUSD(p));

    type BenchSnap = { sharesPerPosition: (number | null)[]; priceByDate: Map<string, number>; sortedDates: string[] };
    const benchSnaps: BenchSnap[] = benchmarkQueries.map((q) => {
      const priceByDate = buildPriceMap(q.data);
      const sortedDates = Array.from(priceByDate.keys()).sort();
      const sharesPerPosition = positions.map((p, i) => {
        const buyPrice = firstPriceOnOrAfter(sortedDates, priceByDate, p.purchaseDate);
        if (buyPrice === null || buyPrice <= 0) return null;
        const startingCapital = Math.abs(costBasisByPosition[i]);
        return startingCapital !== 0 ? startingCapital / buyPrice : null;
      });
      return { sharesPerPosition, priceByDate, sortedDates };
    });

    const rows: ChartRow[] = [];
    const prevPerSymbol = new Array<number | null>(positions.length).fill(null);
    const prevWithdrawnPerSymbol = new Array<number>(positions.length).fill(0);
    const benchLastPrice: (number | null)[] = benchmarkQueries.map(() => null);
    for (const d of allDates) {
      let value = 0;
      let cost = 0;
      let grossCost = 0;
      let flow = 0;
      for (let i = 0; i < positions.length; i++) {
        const active = activationByPosition[i] <= d;
        if (!active) continue;
        const positionCost = costBasisByPosition[i];
        cost += positionCost;
        grossCost += Math.abs(positionCost);
        flow += positionCost; // activation contributes cost basis as a deposit
        const snap = snaps[i];
        if (!snap) continue;
        const v = snap.usdByDate.get(d);
        if (typeof v === 'number') {
          prevPerSymbol[i] = v;
          value += v;
        } else {
          const previousValue = prevPerSymbol[i];
          if (previousValue !== null) value += previousValue;
        }
        const w = snap.withdrawnByDate.get(d);
        if (typeof w === 'number') prevWithdrawnPerSymbol[i] = w;
        flow -= prevWithdrawnPerSymbol[i];
      }
      if (grossCost <= 0) continue;

      const row: ChartRow = {
        date: d,
        value: performanceValueFromSignedExposure(value, cost, grossCost),
        cost: grossCost,
        flow,
      };

      benchSnaps.forEach((bs, bi) => {
        const priceOnDay = bs.priceByDate.get(d);
        if (typeof priceOnDay === 'number') benchLastPrice[bi] = priceOnDay;
        const price = benchLastPrice[bi];
        if (price === null) return;
        let bval = 0;
        let any = false;
        for (let i = 0; i < positions.length; i++) {
          if (activationByPosition[i] > d) continue;
          const sh = bs.sharesPerPosition[i];
          if (sh === null) continue;
          bval += sh * price;
          any = true;
        }
        if (any) row[BENCHMARKS[bi].symbol] = bval;
      });

      rows.push(row);
    }

    const lastRow = rows[rows.length - 1];
    const endCost = lastRow?.cost ?? 0;

    function totalReturn(key: string): { gain: number; pct: number; endValue: number } | null {
      if (!lastRow || endCost === 0) return null;
      const endValue = lastRow[key];
      if (typeof endValue !== 'number') return null;
      const gain = endValue - endCost;
      return { gain, pct: gain / Math.abs(endCost), endValue };
    }

    type Stat = {
      label: string;
      color: string;
      sharpe: number | null;
      ret: { gain: number; pct: number; endValue: number } | null;
    };

    const stats: Stat[] = [
      {
        label: 'Portfolio',
        color: '#10b981',
        sharpe: annualizedSharpe(dailyReturnsFromSeries(rows, 'value'), interval),
        ret: portfolioReturn ?? totalReturn('value'),
      },
      ...BENCHMARKS.map((b) => ({
        label: b.label,
        color: b.color,
        sharpe: annualizedSharpe(dailyReturnsFromSeries(rows, b.symbol), interval),
        ret: totalReturn(b.symbol),
      })),
    ];

    return { chartData: rows, stats };
  }, [positions, portfolioReturn, effectiveCurrencies, historyQueries, fxSeriesQueries, buyCloseQueries, buyFxQueries, spyHistoryQuery.data, smhHistoryQuery.data, interval]);

  const visibleChartData = useMemo(
    () => visibleRowsForWindow(chartData, selectedWindow, today),
    [chartData, selectedWindow, today],
  );

  const balanceChartDataForPlot = selectedRange !== null ? chartData : visibleChartData;

  const twrKeys = useMemo(() => ['value', ...BENCHMARKS.map((b) => b.symbol)], []);

  const chartDataForPlot = useMemo(() => {
    if (chartMode === 'balance') return balanceChartDataForPlot;
    return toTwrSeries(balanceChartDataForPlot, twrKeys);
  }, [chartMode, balanceChartDataForPlot, twrKeys]);

  const displayStats = useMemo(() => {
    const slice =
      selectedRange !== null
        ? chartData.filter((r) => r.date >= selectedRange.startDate && r.date <= selectedRange.endDate)
        : selectedWindow === 'ALL'
          ? chartData
          : visibleChartData;
    if (slice.length === 0) return stats;
    const startDate = slice[0].date;
    const endDate = slice[slice.length - 1].date;
    const returnFor = (key: string) =>
      chartMode === 'twr'
        ? twrRangeReturn(chartData, key, startDate, endDate)
        : rangeReturn(chartData, key, startDate, endDate);
    return [
      {
        label: 'Portfolio',
        color: '#10b981',
        sharpe: annualizedSharpe(dailyReturnsFromSeries(slice, 'value'), interval),
        ret:
          chartMode === 'balance' && selectedRange === null && selectedWindow === 'ALL' && portfolioReturn
            ? portfolioReturn
            : returnFor('value'),
      },
      ...BENCHMARKS.map((b) => ({
        label: b.label,
        color: b.color,
        sharpe: annualizedSharpe(dailyReturnsFromSeries(slice, b.symbol), interval),
        ret: returnFor(b.symbol),
      })),
    ];
  }, [chartData, chartMode, interval, portfolioReturn, selectedRange, selectedWindow, stats, visibleChartData]);

  const activeRange =
    dragStartDate && dragEndDate ? orderedSelection(dragStartDate, dragEndDate) : selectedRange;

  const selectedRangeStats = useMemo(() => {
    if (!selectedRange) return null;
    const series = [
      { key: 'value', label: 'Portfolio', color: '#10b981' },
      ...BENCHMARKS.map((b) => ({ key: b.symbol, label: b.label, color: b.color })),
    ];
    const returnFor = (key: string) =>
      chartMode === 'twr'
        ? twrRangeReturn(chartData, key, selectedRange.startDate, selectedRange.endDate)
        : rangeReturn(chartData, key, selectedRange.startDate, selectedRange.endDate);
    return {
      ...selectedRange,
      series: series.map((s) => ({ ...s, ret: returnFor(s.key) })),
    };
  }, [chartData, chartMode, selectedRange]);

  const handleMouseDown = (state: unknown) => {
    const date = getActiveDate(state);
    if (!date) return;
    setDragStartDate(date);
    setDragEndDate(date);
  };

  const handleMouseMove = (state: unknown) => {
    if (!dragStartDate) return;
    const date = getActiveDate(state);
    if (date) setDragEndDate(date);
  };

  const handleMouseUp = (state: unknown) => {
    if (!dragStartDate) return;
    const date = getActiveDate(state) ?? dragEndDate ?? dragStartDate;
    const range = orderedSelection(dragStartDate, date);
    setSelectedRange(range.startDate === range.endDate ? null : range);
    setDragStartDate(null);
    setDragEndDate(null);
  };

  const handleMouseLeave = () => {
    setDragStartDate(null);
    setDragEndDate(null);
  };

  const rangeSubtitle =
    selectedWindow === 'ALL'
      ? `since ${earliest}`
      : formatDateRange(
          visibleChartData[0]?.date ?? null,
          visibleChartData[visibleChartData.length - 1]?.date ?? null,
        );

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-5 lg:min-h-[30.25rem]">
      <div className="mb-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-neutral-300">Performance</h2>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TIME_WINDOWS.map((window) => (
                <button
                  key={window.key}
                  type="button"
                  className={`rounded border px-2 py-1 text-[11px] transition ${selectedWindow === window.key
                    ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-300'
                    : 'border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                    }`}
                  onClick={() => {
                    setSelectedWindow(window.key);
                    setSelectedRange(null);
                  }}
                >
                  {window.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              {CHART_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`rounded border px-2 py-1 text-[11px] transition ${chartMode === m.key
                    ? 'border-sky-500/70 bg-sky-500/10 text-sky-300'
                    : 'border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                    }`}
                  onClick={() => setChartMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <span className="shrink-0 text-right text-xs text-neutral-500">{rangeSubtitle}</span>
        </div>
      </div>
      {chartData.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-sm text-neutral-500">
          {isLoading ? 'Loading history…' : 'No data'}
        </div>
      ) : (
        <>
          <div className="h-64 cursor-crosshair select-none">
            <ResponsiveContainer>
              <ComposedChart
                data={chartDataForPlot}
                margin={{ top: 10, right: 16, bottom: 0, left: 0 }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
              >
                <defs>
                  <linearGradient id="perf" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#374151' }}
                  minTickGap={48}
                  tickFormatter={(v) => formatTickLabel(String(v), interval)}
                />
                <YAxis
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#374151' }}
                  width={64}
                  tickFormatter={(v) =>
                    chartMode === 'twr' ? fmtPct(Number(v), false) : fmtUSD(Number(v))
                  }
                />
                <Tooltip
                  contentStyle={{
                    background: '#111827',
                    border: '1px solid #374151',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#9ca3af' }}
                  labelFormatter={(label) => formatTickLabel(String(label), interval)}
                  formatter={(value: number, name) => {
                    const label =
                      name === 'value'
                        ? 'Portfolio'
                        : BENCHMARKS.find((b) => b.symbol === name)?.label ?? String(name);
                    return [chartMode === 'twr' ? fmtPct(value) : fmtUSD(value), label];
                  }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
                  iconType="plainline"
                  formatter={(value) => {
                    if (value === 'value') return <span style={{ color: '#d1d5db' }}>Portfolio</span>;
                    const b = BENCHMARKS.find((x) => x.symbol === value);
                    return <span style={{ color: '#d1d5db' }}>{b?.label ?? value}</span>;
                  }}
                />
                <ReferenceLine
                  y={chartMode === 'twr' ? 0 : chartData[chartData.length - 1]?.cost ?? 0}
                  stroke="#6b7280"
                  strokeDasharray="4 4"
                  label={{
                    value: chartMode === 'twr' ? 'Baseline' : 'Cost basis',
                    fill: '#6b7280',
                    fontSize: 10,
                    position: 'right',
                  }}
                />
                {activeRange && activeRange.startDate !== activeRange.endDate ? (
                  <ReferenceArea
                    x1={activeRange.startDate}
                    x2={activeRange.endDate}
                    stroke="#a78bfa"
                    strokeOpacity={0.7}
                    fill="#8b5cf6"
                    fillOpacity={0.12}
                  />
                ) : null}
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#10b981"
                  fill="url(#perf)"
                  strokeWidth={2}
                  isAnimationActive={false}
                />
                {BENCHMARKS.map((b) => (
                  <Line
                    key={b.symbol}
                    type="monotone"
                    dataKey={b.symbol}
                    stroke={b.color}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {selectedRangeStats ? (
            <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-neutral-300">Selected window</div>
                  <div className="text-xs text-neutral-500">
                    {formatTickLabel(selectedRangeStats.startDate, interval)} to{' '}
                    {formatTickLabel(selectedRangeStats.endDate, interval)}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
                  onClick={() => setSelectedRange(null)}
                >
                  Clear
                </button>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-neutral-500">
                    <th className="pb-2 text-left font-normal"> </th>
                    <th className="pb-2 text-right font-normal">Return</th>
                    <th className="pb-2 text-right font-normal">Gain / loss</th>
                    <th className="pb-2 text-right font-normal">Start</th>
                    <th className="pb-2 text-right font-normal">End</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedRangeStats.series.map((s) => {
                    const gain = s.ret?.gain ?? null;
                    const tone =
                      gain === null || gain === 0
                        ? 'text-neutral-300'
                        : gain > 0
                          ? 'text-emerald-400'
                          : 'text-red-400';
                    return (
                      <tr key={s.key} className="border-t border-neutral-900">
                        <td className="py-1.5">
                          <div className="flex items-center gap-2 text-neutral-300">
                            <span
                              className="inline-block h-2 w-2 rounded-full"
                              style={{ background: s.color }}
                            />
                            {s.label}
                          </div>
                        </td>
                        <td className={`py-1.5 text-right num ${tone}`}>
                          {s.ret === null ? '—' : fmtPct(s.ret.pct)}
                        </td>
                        <td className={`py-1.5 text-right num ${tone}`}>
                          {s.ret === null ? '—' : fmtUSDSigned(s.ret.gain)}
                        </td>
                        <td className="py-1.5 text-right num text-neutral-300">
                          {s.ret === null ? '—' : fmtUSD(s.ret.startValue)}
                        </td>
                        <td className="py-1.5 text-right num text-neutral-100">
                          {s.ret === null ? '—' : fmtUSD(s.ret.endValue)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
          <div className="mt-4 pt-4 border-t border-neutral-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-neutral-500">
                  <th className="text-left font-normal pb-2"> </th>
                  <th className="text-right font-normal pb-2">Return</th>
                  <th className="text-right font-normal pb-2">Gain / loss</th>
                  <th className="text-right font-normal pb-2">
                    Sharpe <span className="normal-case text-neutral-600">(ann.)</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayStats.map((s) => {
                  const pct = s.ret?.pct ?? null;
                  const gain = s.ret?.gain ?? null;
                  const pctColor =
                    pct === null || pct === 0
                      ? 'text-neutral-300'
                      : pct > 0
                        ? 'text-emerald-400'
                        : 'text-red-400';
                  const gainColor =
                    gain === null || gain === 0
                      ? 'text-neutral-300'
                      : gain > 0
                        ? 'text-emerald-400'
                        : 'text-red-400';
                  return (
                    <tr key={s.label} className="border-t border-neutral-900">
                      <td className="py-1.5">
                        <div className="flex items-center gap-2 text-neutral-300">
                          <span
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ background: s.color }}
                          />
                          {s.label}
                        </div>
                      </td>
                      <td className={`py-1.5 text-right num ${pctColor}`}>
                        {pct === null ? '—' : fmtPct(pct)}
                      </td>
                      <td className={`py-1.5 text-right num ${gainColor}`}>
                        {gain === null ? '—' : fmtUSDSigned(gain)}
                      </td>
                      <td className="py-1.5 text-right num text-neutral-100">
                        {s.sharpe === null || !Number.isFinite(s.sharpe)
                          ? '—'
                          : s.sharpe.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
