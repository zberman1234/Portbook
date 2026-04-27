import { useState } from 'react';
import { TickerSearch } from './TickerSearch';
import { BulkAddForm } from './BulkAddForm';
import { usePortfolio } from '../hooks/usePortfolio';
import { DEFAULT_COST_BASIS_USD } from '../lib/calc';
import type { SearchHit } from '../types';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type Mode = 'single' | 'bulk';

export function AddPositionForm() {
  const { add, adding } = usePortfolio();
  const [mode, setMode] = useState<Mode>('single');
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState(String(DEFAULT_COST_BASIS_USD));
  const [error, setError] = useState<string | null>(null);
  // Bumped after a successful add to remount TickerSearch and clear its
  // internal input text (otherwise the previous symbol stays visible while
  // `selected` is null, leading to a confusing "pick a ticker" error on the
  // next submit).
  const [searchResetKey, setSearchResetKey] = useState(0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) {
      setError('Please pick a ticker from the search results.');
      return;
    }
    if (!date) {
      setError('Please pick a purchase date.');
      return;
    }
    if (date > todayISO()) {
      setError('Purchase date cannot be in the future.');
      return;
    }
    const costBasisUSD = Number(amount);
    if (!Number.isFinite(costBasisUSD) || costBasisUSD <= 0) {
      setError('Please enter an investment amount greater than $0.');
      return;
    }
    try {
      await add({
        symbol: selected.symbol,
        name: selected.name,
        exchange: selected.exchangeDisplay ?? selected.exchange,
        currency: selected.currency ?? 'USD',
        purchaseDate: date,
        costBasisUSD,
      });
      setSelected(null);
      setDate(todayISO());
      setAmount(String(DEFAULT_COST_BASIS_USD));
      setSearchResetKey((k) => k + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-5">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-neutral-300">Add position</h2>
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
        <span className="text-xs text-neutral-500">
          Default $100 USD per position; edit amount for custom buys
        </span>
      </div>

      {mode === 'single' ? (
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto] gap-3 md:items-end">
            <TickerSearch key={searchResetKey} value={selected} onChange={setSelected} />
            <div>
              <label className="text-xs text-neutral-500 block mb-1">Purchase date</label>
              <input
                type="date"
                value={date}
                max={todayISO()}
                min="1990-01-01"
                onChange={(e) => setDate(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-neutral-500 block mb-1">Amount (USD)</label>
              <input
                type="number"
                value={amount}
                min="0.01"
                step="0.01"
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={adding}
              className="px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium text-sm disabled:opacity-60 transition h-[38px]"
            >
              {adding ? 'Adding…' : 'Add position'}
            </button>
          </div>
          {error ? <div className="text-xs text-red-400 mt-3">{error}</div> : null}
        </form>
      ) : (
        <BulkAddForm />
      )}
    </div>
  );
}

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const base =
    'px-2.5 py-1 rounded-md text-xs font-medium transition border';
  const active = 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
  const idle =
    'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`${base} ${mode === 'single' ? active : idle}`}
        onClick={() => onChange('single')}
      >
        Single
      </button>
      <button
        type="button"
        className={`${base} ${mode === 'bulk' ? active : idle}`}
        onClick={() => onChange('bulk')}
      >
        Bulk paste
      </button>
    </div>
  );
}
