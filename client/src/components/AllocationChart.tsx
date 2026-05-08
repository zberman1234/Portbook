import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { EnrichedPosition } from '../types';
import { fmtPct, fmtUSD } from '../lib/format';

const PALETTE = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#f472b6', '#84cc16', '#facc15', '#64748b',
  '#e879f9', '#0ea5e9', '#fb923c', '#22c55e', '#a78bfa',
];

interface Props {
  enriched: EnrichedPosition[];
  cashUSD?: number;
}

interface AllocationDatum {
  name: string;
  value: number;
  pct: number;
}

function allocationName(position: EnrichedPosition): string {
  const symbol = position.symbol.trim().toUpperCase();
  return position.shares < 0 ? `${symbol} short` : symbol;
}

export function AllocationChart({ enriched, cashUSD = 0 }: Props) {
  const data = useMemo(() => {
    const valid = enriched.filter((p) => !p.error && Math.abs(p.marketValueUSD) > 0);
    const total = valid.reduce((s, p) => s + Math.abs(p.marketValueUSD), 0) + cashUSD;
    const holdingsByName = valid.reduce<Map<string, Omit<AllocationDatum, 'pct'>>>((groups, position) => {
      const name = allocationName(position);
      const existing = groups.get(name);
      groups.set(name, {
        name,
        value: (existing?.value ?? 0) + Math.abs(position.marketValueUSD),
      });
      return groups;
    }, new Map());
    const holdings = [...holdingsByName.values()].map((holding) => ({
      ...holding,
      pct: total > 0 ? holding.value / total : 0,
    }));
    const rows =
      cashUSD > 0
        ? [...holdings, { name: 'Cash', value: cashUSD, pct: total > 0 ? cashUSD / total : 0 }]
        : holdings;
    return rows.sort((a, b) => b.value - a.value);
  }, [cashUSD, enriched]);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-5 flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-neutral-300">Allocation</h2>
        <span className="text-xs text-neutral-500">by gross market value</span>
      </div>
      {data.length === 0 ? (
        <div className="flex-1 min-h-64 flex items-center justify-center text-sm text-neutral-500">No data</div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 items-center lg:items-stretch overflow-hidden">
          <div className="w-full lg:w-2/3 h-64 lg:h-full min-h-64">
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="95%"
                  stroke="#0b0f14"
                  strokeWidth={2}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: '#111827',
                    border: '1px solid #374151',
                    borderRadius: 6,
                    fontSize: 12,
                    color: '#e5e7eb',
                  }}
                  itemStyle={{ color: '#e5e7eb' }}
                  labelStyle={{ color: '#e5e7eb' }}
                  formatter={(value: number, _name, item) => {
                    const pct = (item.payload as { pct: number }).pct;
                    return [`${fmtUSD(value)} (${fmtPct(pct, false)})`, item.payload.name];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="w-full lg:w-1/3 h-64 lg:h-full min-h-0 overflow-y-auto pr-1">
            <ul className="space-y-1">
              {data.map((d, i) => (
                <li key={d.name} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: PALETTE[i % PALETTE.length] }}
                    />
                    <span className="font-mono text-neutral-300 truncate">{d.name}</span>
                  </div>
                  <span className="num text-neutral-400 tabular-nums">{fmtPct(d.pct, false)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
