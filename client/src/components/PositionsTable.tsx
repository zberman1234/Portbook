import { useMemo, useState } from 'react';
import { usePortfolio } from '../hooks/usePortfolio';
import { colorClass, fmtPct, fmtPrice, fmtShares, fmtUSD, fmtUSDSigned } from '../lib/format';
import type { EnrichedPosition } from '../types';

type SortKey =
  | 'symbol'
  | 'name'
  | 'purchaseDate'
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
  { key: 'shares', label: 'Shares', align: 'right' },
  { key: 'purchasePriceUSD', label: 'Cost/Share', align: 'right' },
  { key: 'currentPriceUSD', label: 'Last', align: 'right' },
  { key: 'dayChangePct', label: 'Day %', align: 'right' },
  { key: 'marketValueUSD', label: 'Market Value', align: 'right' },
  { key: 'totalGainUSD', label: 'Total G/L $', align: 'right' },
  { key: 'totalGainPct', label: 'Total G/L %', align: 'right' },
];

export function PositionsTable({ enriched, loading }: Props) {
  const { remove, removing } = usePortfolio();
  const [sortKey, setSortKey] = useState<SortKey>('marketValueUSD');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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

  if (!loading && enriched.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-950/40 p-12 text-center">
        <div className="text-neutral-300 font-medium mb-1">No positions yet</div>
        <div className="text-sm text-neutral-500">
          Use the form above to add your first ticker. Every position represents a hypothetical $100 USD buy on its purchase date.
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
            {sorted.map((p) => (
              <tr key={p.id} className="border-t border-neutral-800 hover:bg-neutral-900/40">
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
                    onClick={() => remove(p.id)}
                    disabled={removing}
                    title="Remove position"
                    className="text-neutral-500 hover:text-red-400 text-xs px-2 py-1 rounded border border-neutral-800 hover:border-red-500/40 transition"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
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
