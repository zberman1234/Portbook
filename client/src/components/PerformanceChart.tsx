import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { COST_BASIS_USD } from '../lib/calc';
import { fmtUSD } from '../lib/format';
import type { Position } from '../types';

interface Props {
  positions: Position[];
}

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

export function PerformanceChart({ positions }: Props) {
  const today = todayISO();

  const earliest = useMemo(() => {
    if (positions.length === 0) return today;
    return positions.reduce((min, p) => (p.purchaseDate < min ? p.purchaseDate : min), positions[0].purchaseDate);
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

  const isLoading =
    historyQueries.some((q) => q.isLoading) ||
    fxSeriesQueries.some((q) => q.isLoading) ||
    buyCloseQueries.some((q) => q.isLoading) ||
    buyFxQueries.some((q) => q.isLoading);

  const chartData = useMemo(() => {
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

    const rows: { date: string; value: number; cost: number }[] = [];
    let prevPerSymbol = new Array<number>(positions.length).fill(0);
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
      if (cost > 0) rows.push({ date: d, value, cost });
    }
    return rows;
  }, [positions, historyQueries, fxSeriesQueries, buyCloseQueries, buyFxQueries]);

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
        <div className="h-64">
          <ResponsiveContainer>
            <AreaChart data={chartData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
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
                formatter={(value: number, name) => [fmtUSD(value), name === 'value' ? 'Value' : 'Cost']}
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
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
