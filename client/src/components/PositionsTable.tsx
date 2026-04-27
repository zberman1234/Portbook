import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usePortfolio } from '../hooks/usePortfolio';
import { api } from '../lib/api';
import { colorClass, fmtPct, fmtPrice, fmtShares, fmtUSD, fmtUSDSigned } from '../lib/format';
import type { EnrichedPosition, HistoryRow } from '../types';

type SortKey =
  | 'symbol'
  | 'name'
  | 'purchaseDate'
  | 'costBasisUSD'
  | 'shares'
  | 'purchasePriceUSD'
  | 'currentPriceUSD'
  | 'dayChangePct'
  | 'marketValueUSD'
  | 'totalGainUSD'
  | 'totalGainPct';

interface Props {
  enriched: EnrichedPosition[];
  loading: boolean;
}

const columns: { key: SortKey; label: string; align?: 'left' | 'right' }[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'name', label: 'Name' },
  { key: 'purchaseDate', label: 'Purchased' },
  { key: 'costBasisUSD', label: 'Cost Basis', align: 'right' },
  { key: 'shares', label: 'Shares', align: 'right' },
  { key: 'purchasePriceUSD', label: 'Cost/Share', align: 'right' },
  { key: 'currentPriceUSD', label: 'Last', align: 'right' },
  { key: 'dayChangePct', label: 'Day %', align: 'right' },
  { key: 'marketValueUSD', label: 'Market Value', align: 'right' },
  { key: 'totalGainUSD', label: 'Total G/L $', align: 'right' },
  { key: 'totalGainPct', label: 'Total G/L %', align: 'right' },
];

type PriceChartRow = {
  date: string;
  price: number;
};

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

function buildPriceChartRows(history: HistoryRow[] | undefined, currency: string): PriceChartRow[] {
  return (history ?? [])
    .map((row) => {
      const price = normalizeNative(row.adjclose ?? row.close, currency);
      return typeof price === 'number' && Number.isFinite(price)
        ? { date: row.date, price }
        : null;
    })
    .filter((row): row is PriceChartRow => row !== null);
}

function PositionDropdown({ position, open }: { position: EnrichedPosition; open: boolean }) {
  const today = todayISO();
  const historyQuery = useQuery({
    queryKey: ['history', position.symbol, position.purchaseDate],
    queryFn: () => api.history(position.symbol, position.purchaseDate, today),
    staleTime: 1000 * 60 * 60,
    enabled: open && !position.error,
  });

  const chartData = useMemo(
    () => buildPriceChartRows(historyQuery.data, position.currency),
    [historyQuery.data, position.currency],
  );
  const stroke = position.totalGainUSD >= 0 ? '#10b981' : '#f87171';

  return (
    <tr
      className={`${
        open ? 'border-t border-neutral-900 bg-neutral-900/20' : 'border-t border-transparent'
      }`}
    >
      <td colSpan={columns.length + 1} className="p-0">
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="overflow-hidden">
            <div className="px-3 py-3">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-medium text-neutral-300">Price history</div>
                  <div className="text-xs text-neutral-500">{position.currency}</div>
                </div>
                <div className="h-44">
                  {position.error ? (
                    <div className="flex h-full items-center justify-center rounded border border-amber-700/40 bg-amber-900/20 px-3 text-center text-xs text-amber-300/90">
                      Pricing unavailable for this symbol/date: {position.error}
                    </div>
                  ) : historyQuery.isLoading ? (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                      Loading chart...
                    </div>
                  ) : chartData.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                      No chart data available
                    </div>
                  ) : (
                    <ResponsiveContainer>
                      <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                        <XAxis
                          dataKey="date"
                          tick={{ fill: '#6b7280', fontSize: 10 }}
                          axisLine={{ stroke: '#374151' }}
                          tickLine={false}
                          minTickGap={48}
                        />
                        <YAxis
                          tick={{ fill: '#6b7280', fontSize: 10 }}
                          axisLine={{ stroke: '#374151' }}
                          tickLine={false}
                          width={48}
                          domain={['dataMin', 'dataMax']}
                          tickFormatter={(value) => fmtPrice(Number(value))}
                        />
                        <Tooltip
                          contentStyle={{
                            background: '#111827',
                            border: '1px solid #374151',
                            borderRadius: 6,
                            fontSize: 12,
                          }}
                          labelStyle={{ color: '#9ca3af' }}
                          formatter={(value) => [fmtPrice(Number(value)), 'Price']}
                        />
                        <Line
                          type="monotone"
                          dataKey="price"
                          stroke={stroke}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function PositionsTable({ enriched, loading }: Props) {
  const { remove, removing } = usePortfolio();
  const [sortKey, setSortKey] = useState<SortKey>('marketValueUSD');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedPositionId, setExpandedPositionId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const rows = enriched.slice();
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = String(av ?? '');
      const bs = String(bv ?? '');
      return sortDir === 'asc' ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return rows;
  }, [enriched, sortKey, sortDir]);

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'symbol' || key === 'name' || key === 'purchaseDate' ? 'asc' : 'desc');
    }
  }

  function toggleExpanded(positionId: string) {
    setExpandedPositionId((current) => (current === positionId ? null : positionId));
  }

  if (!loading && enriched.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 p-12 text-center">
        <div className="text-neutral-300 font-medium mb-1">No positions yet</div>
        <div className="text-sm text-neutral-500">
          Use the form above to add your first ticker. Each position represents a hypothetical USD buy on its purchase date.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-300">Positions</h2>
        <span className="text-xs text-neutral-500">{enriched.length} holding{enriched.length === 1 ? '' : 's'}</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900/80 text-neutral-400 text-xs uppercase tracking-wide">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => onSort(c.key)}
                  className={`px-3 py-2 cursor-pointer select-none hover:text-neutral-200 ${
                    c.align === 'right' ? 'text-right' : 'text-left'
                  }`}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.label}
                    {sortKey === c.key ? (
                      <span className="text-[10px]">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    ) : null}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const isExpanded = expandedPositionId === p.id;
              return (
                <Fragment key={p.id}>
                  <tr
                    onClick={() => toggleExpanded(p.id)}
                    className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-900/40"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-emerald-400">{p.symbol}</span>
                        {p.exchange ? (
                          <span className="text-[10px] text-neutral-500 border border-neutral-700 rounded px-1">
                            {p.exchange}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-neutral-300 max-w-[22ch] truncate" title={p.name}>
                      {p.name}
                    </td>
                    <td className="px-3 py-2 text-neutral-400 num">{p.purchaseDate}</td>
                    <td className="px-3 py-2 text-right num text-neutral-300">{fmtUSD(p.costBasisUSD)}</td>
                    <td className="px-3 py-2 text-right num text-neutral-300">{fmtShares(p.shares)}</td>
                    <td className="px-3 py-2 text-right num text-neutral-300">{fmtPrice(p.purchasePriceUSD)}</td>
                    <td className="px-3 py-2 text-right num text-neutral-300">{fmtPrice(p.currentPriceUSD)}</td>
                    <td className={`px-3 py-2 text-right num ${colorClass(p.dayChangePct)}`}>
                      {p.error ? '—' : fmtPct(p.dayChangePct)}
                    </td>
                    <td className="px-3 py-2 text-right num text-neutral-100">
                      {p.error ? '—' : fmtUSD(p.marketValueUSD)}
                    </td>
                    <td className={`px-3 py-2 text-right num ${colorClass(p.totalGainUSD)}`}>
                      {p.error ? '—' : fmtUSDSigned(p.totalGainUSD)}
                    </td>
                    <td className={`px-3 py-2 text-right num ${colorClass(p.totalGainPct)}`}>
                      {p.error ? '—' : fmtPct(p.totalGainPct)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(p.id);
                        }}
                        disabled={removing}
                        title="Remove position"
                        className="text-neutral-500 hover:text-red-400 text-xs px-2 py-1 rounded border border-neutral-800 hover:border-red-500/40 transition"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  <PositionDropdown position={p} open={isExpanded} />
                </Fragment>
              );
            })}
            {loading && enriched.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">
                  Loading…
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {sorted.some((p) => p.error) ? (
          <div className="px-5 py-2 border-t border-neutral-800 text-xs text-amber-400/80">
            Some positions could not be priced. Yahoo may not have history for the requested symbol/date.
          </div>
        ) : null}
      </div>
    </div>
  );
}
