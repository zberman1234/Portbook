import { totals } from '../lib/calc';
import { colorClass, fmtPct, fmtUSD, fmtUSDSigned } from '../lib/format';
import type { EnrichedPosition } from '../types';

interface Props {
  enriched: EnrichedPosition[];
  loading: boolean;
  cashUSD?: number;
  totalCostBasisUSD?: number;
}

export function PortfolioSummary({ enriched, loading, cashUSD = 0, totalCostBasisUSD }: Props) {
  const t = totals(enriched);
  const cost = totalCostBasisUSD ?? t.cost;
  const value = t.value + cashUSD;
  const gain = value - cost;
  const gainPct = Math.abs(cost) > 0 ? gain / Math.abs(cost) : 0;
  const dayChangePct = t.dayChangePct;

  const cards = [
    {
      label: 'Portfolio value',
      value: fmtUSD(value),
      hint: `${t.validCount} position${t.validCount === 1 ? '' : 's'} + ${fmtUSD(cashUSD)} cash`,
      color: 'text-neutral-100',
    },
    {
      label: 'Net cost basis',
      value: fmtUSD(cost),
      hint: 'signed opening cost',
      color: 'text-neutral-300',
    },
    {
      label: 'Total gain / loss',
      value: fmtUSDSigned(gain),
      hint: fmtPct(gainPct),
      color: colorClass(gain),
    },
    {
      label: "Today's change",
      value: fmtUSDSigned(t.dayChangeUSD),
      hint: fmtPct(dayChangePct),
      color: colorClass(t.dayChangeUSD),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4"
        >
          <div className="text-xs uppercase tracking-wide text-neutral-500">{c.label}</div>
          <div className={`mt-1 text-2xl num font-semibold ${c.color}`}>
            {loading && enriched.length === 0 ? '—' : c.value}
          </div>
          <div className={`text-xs mt-0.5 num ${c.color}`}>{loading && enriched.length === 0 ? '' : c.hint}</div>
        </div>
      ))}
    </div>
  );
}
