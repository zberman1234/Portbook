import { totals } from '../lib/calc';
import { colorClass, fmtPct, fmtUSD, fmtUSDSigned } from '../lib/format';
import type { EnrichedPosition } from '../types';

interface Props {
  enriched: EnrichedPosition[];
  loading: boolean;
}

export function PortfolioSummary({ enriched, loading }: Props) {
  const t = totals(enriched);

  const cards = [
    {
      label: 'Total market value',
      value: fmtUSD(t.value),
      hint: `${t.validCount} position${t.validCount === 1 ? '' : 's'} priced`,
      color: 'text-neutral-100',
    },
    {
      label: 'Total cost basis',
      value: fmtUSD(t.cost),
      hint: '$100 per position',
      color: 'text-neutral-300',
    },
    {
      label: 'Total gain / loss',
      value: fmtUSDSigned(t.gain),
      hint: fmtPct(t.gainPct),
      color: colorClass(t.gain),
    },
    {
      label: "Today's change",
      value: fmtUSDSigned(t.dayChangeUSD),
      hint: fmtPct(t.dayChangePct),
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
