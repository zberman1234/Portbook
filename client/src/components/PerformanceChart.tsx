import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { COST_BASIS_USD } from '../lib/calc';
import { fmtPct, fmtUSD, fmtUSDSigned } from '../lib/format';
import type { HistoryRow, Position } from '../types';

interface Props {
  positions: Position[];
}

const BENCHMARKS: { symbol: string; label: string; color: string }[] = [
  { symbol: 'SPY', label: 'S&P 500 (SPY)', color: '#60a5fa' },
  { symbol: 'SMH', label: 'SMH', color: '#f59e0b' },
];

const TRADING_DAYS = 252;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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

function annualizedSharpe(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 2) return null;
  const n = dailyReturns.length;
  const mean = dailyReturns.reduce((s, x) => s + x, 0) / n;
  const variance =
    dailyReturns.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (n - 1);
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;
  return (mean / std) * Math.sqrt(TRADING_DAYS);
}

export function PerformanceChart({ positions }: Props) {
  const today = todayISO();

  const earliest = useMemo(() => {
    if (positions.length === 0) return today;
    return positions.reduce(
      (min, p) => (p.purchaseDate < min ? p.purchaseDate : min),
      positions[0].purchaseDate,
    );
  }, [positions, today]);

  const historyQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['history', p.symbol, p.purchaseDate],
      queryFn: () => api.history(p.symbol, p.purchaseDate, today),
      staleTime: 1000 * 60 * 60,
    })),
  });

  const fxSeriesQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['history', `${(p.currency ?? 'USD').toUpperCase()}USD=X`, p.purchaseDate],
      queryFn: () => {
        const cur = (p.currency ?? 'USD').toUpperCase();
        if (cur === 'USD') return Promise.resolve([]);
        const pair = `${cur}USD=X`;
        return api.history(pair, p.purchaseDate, today);
      },
      staleTime: 1000 * 60 * 60,
    })),
  });

  const buyCloseQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['close-on', p.symbol, p.purchaseDate],
      queryFn: () => api.closeOn(p.symbol, p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const buyFxQueries = useQueries({
    queries: positions.map((p) => ({
      queryKey: ['fx', (p.currency ?? 'USD').toUpperCase(), p.purchaseDate],
      queryFn: () => api.fx(p.currency ?? 'USD', p.purchaseDate),
      staleTime: 1000 * 60 * 60 * 24,
    })),
  });

  const spyHistoryQuery = useQuery({
    queryKey: ['history', 'SPY', earliest],
    queryFn: () => api.history('SPY', earliest, today),
    staleTime: 1000 * 60 * 60,
    enabled: positions.length > 0,
  });

  const smhHistoryQuery = useQuery({
    queryKey: ['history', 'SMH', earliest],
    queryFn: () => api.history('SMH', earliest, today),
    staleTime: 1000 * 60 * 60,
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

    type Snap = { shares: number; usdByDate: Map<string, number> };

    const snaps: (Snap | null)[] = positions.map((p, i) => {
      const buyClose = buyCloseQueries[i]?.data;
      const buyFxRate = buyFxQueries[i]?.data?.rate ?? (p.currency.toUpperCase() === 'USD' ? 1 : null);
      if (!buyClose || buyFxRate === null || buyFxRate === undefined) return null;

      const buyNative = normalizeNative(buyClose.close, p.currency) ?? 0;
      const purchasePriceUSD = buyNative * buyFxRate;
      if (!Number.isFinite(purchasePriceUSD) || purchasePriceUSD <= 0) return null;
      const shares = COST_BASIS_USD / purchasePriceUSD;

      const history = historyQueries[i]?.data ?? [];
      const fxHistory = fxSeriesQueries[i]?.data ?? [];
      const fxByDate = new Map<string, number>();
      if (p.currency.toUpperCase() === 'USD') {
        fxByDate.set('__identity__', 1);
      } else {
        fxHistory.forEach((r) => {
          const v = r.adjclose ?? r.close;
          if (v !== null) fxByDate.set(r.date, v);
        });
      }

      const usdByDate = new Map<string, number>();
      let lastFx = buyFxRate;
      history.forEach((r) => {
        const closeNative = normalizeNative(r.adjclose ?? r.close, p.currency);
        if (closeNative === null) return;
        if (p.currency.toUpperCase() !== 'USD') {
          const fxOnDay = fxByDate.get(r.date);
          if (typeof fxOnDay === 'number') lastFx = fxOnDay;
        }
        const priceUSD = closeNative * lastFx;
        usdByDate.set(r.date, priceUSD * shares);
      });

      return { shares, usdByDate };
    });

    type BenchSnap = { sharesPerPosition: (number | null)[]; priceByDate: Map<string, number>; sortedDates: string[] };
    const benchSnaps: BenchSnap[] = benchmarkQueries.map((q) => {
      const priceByDate = buildPriceMap(q.data);
      const sortedDates = Array.from(priceByDate.keys()).sort();
      const sharesPerPosition = positions.map((p) => {
        const buyPrice = firstPriceOnOrAfter(sortedDates, priceByDate, p.purchaseDate);
        if (buyPrice === null || buyPrice <= 0) return null;
        return COST_BASIS_USD / buyPrice;
      });
      return { sharesPerPosition, priceByDate, sortedDates };
    });

    type Row = { date: string; value: number; cost: number; [key: string]: number | string };
    const rows: Row[] = [];
    const prevPerSymbol = new Array<number>(positions.length).fill(0);
    const benchLastPrice: (number | null)[] = benchmarkQueries.map(() => null);
    for (const d of allDates) {
      let value = 0;
      let cost = 0;
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        const active = p.purchaseDate <= d;
        if (!active) continue;
        cost += COST_BASIS_USD;
        const snap = snaps[i];
        if (!snap) continue;
        const v = snap.usdByDate.get(d);
        if (typeof v === 'number') {
          prevPerSymbol[i] = v;
          value += v;
        } else if (prevPerSymbol[i] > 0) {
          value += prevPerSymbol[i];
        }
      }
      if (cost <= 0) continue;

      const row: Row = { date: d, value, cost };

      benchSnaps.forEach((bs, bi) => {
        const priceOnDay = bs.priceByDate.get(d);
        if (typeof priceOnDay === 'number') benchLastPrice[bi] = priceOnDay;
        const price = benchLastPrice[bi];
        if (price === null) return;
        let bval = 0;
        let any = false;
        for (let i = 0; i < positions.length; i++) {
          const p = positions[i];
          if (p.purchaseDate > d) continue;
          const sh = bs.sharesPerPosition[i];
          if (sh === null) continue;
          bval += sh * price;
          any = true;
        }
        if (any) row[BENCHMARKS[bi].symbol] = bval;
      });

      rows.push(row);
    }

    function dailyReturnsFrom(series: Row[], key: string): number[] {
      const out: number[] = [];
      for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1];
        const cur = series[i];
        if (cur.cost !== prev.cost) continue;
        const a = cur[key];
        const b = prev[key];
        if (typeof a !== 'number' || typeof b !== 'number' || b <= 0) continue;
        out.push(a / b - 1);
      }
      return out;
    }

    const lastRow = rows[rows.length - 1];
    const endCost = lastRow?.cost ?? 0;

    function totalReturn(key: string): { gain: number; pct: number; endValue: number } | null {
      if (!lastRow || endCost <= 0) return null;
      const endValue = lastRow[key];
      if (typeof endValue !== 'number') return null;
      const gain = endValue - endCost;
      return { gain, pct: gain / endCost, endValue };
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
        sharpe: annualizedSharpe(dailyReturnsFrom(rows, 'value')),
        ret: totalReturn('value'),
      },
      ...BENCHMARKS.map((b) => ({
        label: b.label,
        color: b.color,
        sharpe: annualizedSharpe(dailyReturnsFrom(rows, b.symbol)),
        ret: totalReturn(b.symbol),
      })),
    ];

    return { chartData: rows, stats };
  }, [positions, historyQueries, fxSeriesQueries, buyCloseQueries, buyFxQueries, spyHistoryQuery.data, smhHistoryQuery.data]);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-neutral-300">Performance</h2>
        <span className="text-xs text-neutral-500">since {earliest}</span>
      </div>
      {chartData.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-sm text-neutral-500">
          {isLoading ? 'Loading history…' : 'No data'}
        </div>
      ) : (
        <>
          <div className="h-64">
            <ResponsiveContainer>
              <ComposedChart data={chartData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
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
                />
                <YAxis
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={{ stroke: '#374151' }}
                  width={64}
                  tickFormatter={(v) => fmtUSD(Number(v))}
                />
                <Tooltip
                  contentStyle={{
                    background: '#111827',
                    border: '1px solid #374151',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: '#9ca3af' }}
                  formatter={(value: number, name) => {
                    const label =
                      name === 'value'
                        ? 'Portfolio'
                        : BENCHMARKS.find((b) => b.symbol === name)?.label ?? String(name);
                    return [fmtUSD(value), label];
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
                  y={chartData[chartData.length - 1]?.cost ?? 0}
                  stroke="#6b7280"
                  strokeDasharray="4 4"
                  label={{ value: 'Cost basis', fill: '#6b7280', fontSize: 10, position: 'right' }}
                />
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
                {stats.map((s) => {
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
