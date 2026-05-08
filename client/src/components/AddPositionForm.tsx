import { useState } from 'react';
import { TickerSearch } from './TickerSearch';
import { BulkAddForm } from './BulkAddForm';
import { usePortfolio } from '../hooks/usePortfolio';
import { useEnrichedPositions } from '../hooks/usePrices';
import { DEFAULT_COST_BASIS_USD } from '../lib/calc';
import {
  applySalesToEnrichedPositions,
  openLongPositionsForSymbol,
  planLongShareSale,
  SHARE_EPSILON,
} from '../lib/positions';
import type { SearchHit } from '../types';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

type Mode = 'single' | 'bulk';
type BuyMode = 'amount' | 'shares';
type TradeAction = 'buy' | 'sell';

export function AddPositionForm() {
  const { add, adding, positions, addSale, selling } = usePortfolio();
  const { enriched: savedEnriched } = useEnrichedPositions(positions);
  const enriched = applySalesToEnrichedPositions(savedEnriched);
  const [mode, setMode] = useState<Mode>('single');
  const [buyMode, setBuyMode] = useState<BuyMode>('amount');
  const [action, setAction] = useState<TradeAction>('buy');
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState(String(DEFAULT_COST_BASIS_USD));
  const [shares, setShares] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Bumped after a successful add to remount TickerSearch and clear its
  // internal input text (otherwise the previous symbol stays visible while
  // `selected` is null, leading to a confusing "pick a ticker" error on the
  // next submit).
  const [searchResetKey, setSearchResetKey] = useState(0);
  const busy = adding || selling;

  async function sellShares(
    selected: SearchHit,
    shareQuantity: number,
    salePriceUSD: number | undefined,
  ) {
    const plan = planLongShareSale(enriched, selected.symbol, date, shareQuantity);

    for (const sale of plan.sales) {
      await addSale({
        positionId: sale.position.id,
        sale: {
          saleDate: date,
          shares: sale.shares,
          ...(salePriceUSD !== undefined ? { salePriceUSD } : {}),
        },
      });
    }

    if (plan.shortShares > SHARE_EPSILON) {
      await add({
        symbol: selected.symbol,
        name: selected.name,
        exchange: selected.exchangeDisplay ?? selected.exchange,
        currency: selected.currency ?? 'USD',
        purchaseDate: date,
        shares: -plan.shortShares,
        ...(salePriceUSD !== undefined ? { purchasePriceUSD: salePriceUSD } : {}),
      });
    }
  }

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
    const amountValue = Number(amount);
    const shareQuantity = Number(shares);
    if (buyMode === 'amount' && (!Number.isFinite(amountValue) || amountValue <= 0)) {
      setError('Please enter an amount greater than $0.');
      return;
    }
    if (buyMode === 'shares' && (!Number.isFinite(shareQuantity) || shareQuantity <= 0)) {
      setError('Please enter a share quantity greater than 0.');
      return;
    }

    const purchasePriceValue = purchasePrice.trim() === '' ? undefined : Number(purchasePrice);
    if (
      purchasePriceValue !== undefined &&
      (!Number.isFinite(purchasePriceValue) || purchasePriceValue <= 0)
    ) {
      setError('Please enter a purchase price greater than $0, or leave it blank.');
      return;
    }

    try {
      if (action === 'buy') {
        await add({
          symbol: selected.symbol,
          name: selected.name,
          exchange: selected.exchangeDisplay ?? selected.exchange,
          currency: selected.currency ?? 'USD',
          purchaseDate: date,
          ...(buyMode === 'amount' ? { costBasisUSD: amountValue } : { shares: shareQuantity }),
          ...(purchasePriceValue !== undefined ? { purchasePriceUSD: purchasePriceValue } : {}),
        });
      } else if (buyMode === 'shares') {
        await sellShares(selected, shareQuantity, purchasePriceValue);
      } else {
        const openLongs = openLongPositionsForSymbol(enriched, selected.symbol, date);
        if (openLongs.length === 0) {
          await add({
            symbol: selected.symbol,
            name: selected.name,
            exchange: selected.exchangeDisplay ?? selected.exchange,
            currency: selected.currency ?? 'USD',
            purchaseDate: date,
            costBasisUSD: -amountValue,
            ...(purchasePriceValue !== undefined ? { purchasePriceUSD: purchasePriceValue } : {}),
          });
        } else {
          const salePriceUSD =
            purchasePriceValue ??
            (date === todayISO()
              ? openLongs.find((position) => position.currentPriceUSD > 0)?.currentPriceUSD
              : undefined);
          if (!salePriceUSD) {
            setError('Enter a sell price/share to sell an existing position by USD amount.');
            return;
          }
          await sellShares(selected, amountValue / salePriceUSD, salePriceUSD);
        }
      }
      setSelected(null);
      setDate(todayISO());
      setAmount(String(DEFAULT_COST_BASIS_USD));
      setShares('');
      setPurchasePrice('');
      setAction('buy');
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
          Buy shares or sell existing shares; unmatched sells open a short
        </span>
      </div>

      {mode === 'single' ? (
        <form onSubmit={handleSubmit}>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] gap-3 md:items-end">
            <TickerSearch key={searchResetKey} value={selected} onChange={setSelected} />
            <div>
              <label className="text-xs text-neutral-500 block mb-1">Action</label>
              <TradeActionSelect action={action} onChange={setAction} />
            </div>
            <div>
              <label className="text-xs text-neutral-500 block mb-1">Trade date</label>
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
              <div className="flex items-center justify-between gap-2 mb-1">
                <label className="text-xs text-neutral-500">
                  {buyMode === 'amount' ? 'Amount' : 'Shares'}
                </label>
                <BuyModeToggle mode={buyMode} onChange={setBuyMode} />
              </div>
              <input
                type="number"
                value={buyMode === 'amount' ? amount : shares}
                min={buyMode === 'amount' ? '0.01' : '0.000001'}
                step={buyMode === 'amount' ? '0.01' : '0.000001'}
                inputMode="decimal"
                placeholder={buyMode === 'amount' ? '100.00' : '10'}
                onChange={(e) =>
                  buyMode === 'amount' ? setAmount(e.target.value) : setShares(e.target.value)
                }
                className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-neutral-500 block mb-1">Price/share USD (optional)</label>
              <input
                type="number"
                value={purchasePrice}
                min="0.01"
                step="0.01"
                inputMode="decimal"
                placeholder="Yahoo close"
                onChange={(e) => setPurchasePrice(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium text-sm disabled:opacity-60 transition h-[38px]"
            >
              {busy ? 'Saving…' : action === 'sell' ? 'Sell' : 'Buy'}
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

function TradeActionSelect({
  action,
  onChange,
}: {
  action: TradeAction;
  onChange: (action: TradeAction) => void;
}) {
  const tone = action === 'buy' ? 'text-emerald-400' : 'text-red-400';
  return (
    <select
      value={action}
      onChange={(event) => onChange(event.target.value as TradeAction)}
      className={`h-[38px] w-full appearance-none rounded-md border border-neutral-700 bg-neutral-900 pl-2.5 pr-5 py-2 text-sm font-medium ${tone} focus:outline-none`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 4.5l3 3 3-3' stroke='%23737373' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.45rem center',
        backgroundSize: '0.7rem 0.7rem',
      }}
    >
      <option value="buy">Buy</option>
      <option value="sell">Sell</option>
    </select>
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

function BuyModeToggle({ mode, onChange }: { mode: BuyMode; onChange: (m: BuyMode) => void }) {
  const base = 'px-1.5 py-0.5 rounded text-[10px] font-medium transition border';
  const active = 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
  const idle =
    'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700';
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`${base} ${mode === 'amount' ? active : idle}`}
        onClick={() => onChange('amount')}
      >
        USD
      </button>
      <button
        type="button"
        className={`${base} ${mode === 'shares' ? active : idle}`}
        onClick={() => onChange('shares')}
      >
        Shares
      </button>
    </div>
  );
}
