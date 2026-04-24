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
}

export function AllocationChart({ enriched }: Props) {
  const data = useMemo(() => {
    const valid = enriched.filter((p) => !p.error && p.marketValueUSD > 0);
    const total = valid.reduce((s, p) => s + p.marketValueUSD, 0);
    return valid
      .map((p) => ({
        name: p.symbol,
        value: p.marketValueUSD,
        pct: total > 0 ? p.marketValueUSD / total : 0,
      }))
      .sort((a, b) => b.value - a.value);
  }, [enriched]);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-neutral-300">Allocation</h2>
        <span className="text-xs text-neutral-500">by market value</span>
      </div>
      {data.length === 0 ? (
        <div className="h-64 flex items-center justify-center text-sm text-neutral-500">No data</div>
      ) : (
        <div className="flex flex-col lg:flex-row gap-4 items-center">
          <div className="w-full lg:w-2/3 h-64">
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={95}
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
                  }}
                  formatter={(value: number, _name, item) => {
                    const pct = (item.payload as { pct: number }).pct;
                    return [`${fmtUSD(value)} (${fmtPct(pct, false)})`, item.payload.name];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="w-full lg:w-1/3 max-h-64 overflow-auto">
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
