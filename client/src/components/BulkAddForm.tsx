import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { usePortfolio } from '../hooks/usePortfolio';
import { useEnrichedPositions } from '../hooks/usePrices';
import { DEFAULT_COST_BASIS_USD } from '../lib/calc';
import {
  applySalesToEnrichedPositions,
  openLongPositionsForSymbol,
  planLongShareSale,
  SHARE_EPSILON,
} from '../lib/positions';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Yahoo symbols can include letters, digits, dots, hyphens, equals (for FX),
// and carets (for indices). Numeric tickers are allowed, but tokens must
// include a letter so random "$10" price mentions are ignored.
const TICKER_REGEX = /\$([A-Za-z0-9^][A-Za-z0-9.\-=^]{0,14})/g;

function extractTickers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(TICKER_REGEX)) {
    const sym = match[1].toUpperCase();
    if (!/[A-Z]/.test(sym)) continue;
    if (!seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out;
}

type RowStatus = 'pending' | 'adding' | 'added' | 'skipped' | 'failed';
type BuyMode = 'amount' | 'shares';
type TradeAction = 'buy' | 'sell';

interface Row {
  ticker: string;
  status: RowStatus;
  message?: string;
  resolvedSymbol?: string;
}

export function BulkAddForm() {
  const { add, positions, addSale } = usePortfolio();
  const { enriched: savedEnriched } = useEnrichedPositions(positions);
  const enriched = applySalesToEnrichedPositions(savedEnriched);
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayISO());
  const [buyMode, setBuyMode] = useState<BuyMode>('amount');
  const [action, setAction] = useState<TradeAction>('buy');
  const [amount, setAmount] = useState(String(DEFAULT_COST_BASIS_USD));
  const [shares, setShares] = useState('');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const detected = useMemo(() => extractTickers(text), [text]);
  const PREVIEW_COUNT = 8;
  const hasOverflow = detected.length > PREVIEW_COUNT;
  const visibleTickers = expanded || !hasOverflow ? detected : detected.slice(0, PREVIEW_COUNT);

  function updateRow(ticker: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.ticker === ticker ? { ...r, ...patch } : r)));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (running) return;
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

    if (detected.length === 0) {
      setError('No $TICKERs found. Make sure each ticker is preceded by a $ (e.g. $AAPL).');
      return;
    }

    const initial: Row[] = detected.map((ticker) => ({ ticker, status: 'pending' }));
    setRows(initial);
    setRunning(true);

    async function sellResolvedSymbol({
      symbol,
      name,
      exchange,
      currency,
    }: {
      symbol: string;
      name?: string;
      exchange?: string;
      currency?: string;
    }) {
      const sellShares = async (requestedShares: number, salePriceUSD: number | undefined) => {
        const plan = planLongShareSale(enriched, symbol, date, requestedShares);
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
            symbol,
            name,
            exchange,
            currency,
            purchaseDate: date,
            shares: -plan.shortShares,
            ...(salePriceUSD !== undefined ? { purchasePriceUSD: salePriceUSD } : {}),
          });
        }
        return plan;
      };

      if (buyMode === 'shares') {
        return sellShares(shareQuantity, purchasePriceValue);
      }

      const openLongs = openLongPositionsForSymbol(enriched, symbol, date);
      if (openLongs.length === 0) {
        await add({
          symbol,
          name,
          exchange,
          currency,
          purchaseDate: date,
          costBasisUSD: -amountValue,
          ...(purchasePriceValue !== undefined ? { purchasePriceUSD: purchasePriceValue } : {}),
        });
        return { sales: [], shortShares: amountValue };
      }

      const salePriceUSD =
        purchasePriceValue ??
        (date === todayISO()
          ? openLongs.find((position) => position.currentPriceUSD > 0)?.currentPriceUSD
          : undefined);
      if (!salePriceUSD) {
        throw new Error('Enter a sell price/share to sell an existing position by USD amount.');
      }
      return sellShares(amountValue / salePriceUSD, salePriceUSD);
    }

    for (const { ticker } of initial) {
      updateRow(ticker, { status: 'adding' });
      try {
        // Best-effort enrichment: search Yahoo and prefer an exact symbol
        // match (case-insensitive) so we get the right exchange / currency.
        // If search fails or returns nothing usable, fall back to the raw
        // ticker and let the server attempt to resolve it.
        let symbol = ticker;
        let name: string | undefined;
        let exchange: string | undefined;
        let currency: string | undefined;
        try {
          const hits = await api.search(ticker);
          const exact = hits.find((h) => h.symbol.toUpperCase() === ticker.toUpperCase());
          const chosen = exact ?? hits[0];
          if (chosen) {
            symbol = chosen.symbol;
            name = chosen.name;
            exchange = chosen.exchangeDisplay ?? chosen.exchange;
            currency = chosen.currency ?? 'USD';
          }
        } catch {
          /* fall through to raw symbol */
        }

        if (action === 'buy') {
          await add({
            symbol,
            name,
            exchange,
            currency,
            purchaseDate: date,
            ...(buyMode === 'amount' ? { costBasisUSD: amountValue } : { shares: shareQuantity }),
            ...(purchasePriceValue !== undefined ? { purchasePriceUSD: purchasePriceValue } : {}),
          });
        } else {
          await sellResolvedSymbol({ symbol, name, exchange, currency });
        }
        updateRow(ticker, {
          status: 'added',
          resolvedSymbol: symbol,
          message: name ? `${symbol} — ${name}` : symbol,
        });
      } catch (err) {
        updateRow(ticker, {
          status: 'failed',
          message: (err as Error).message,
        });
      }
    }

    setRunning(false);
  }

  function handleClear() {
    setText('');
    setAmount(String(DEFAULT_COST_BASIS_USD));
    setShares('');
    setPurchasePrice('');
    setAction('buy');
    setRows([]);
    setError(null);
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
        <div>
          <label className="text-xs text-neutral-500 block mb-1">
            Paste text — every <span className="font-mono text-emerald-400">$TICKER</span> will be added
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            placeholder={'e.g. "Loving $NVDA and $AMD this week, but $TSLA is rough. Also watching $AIXA.DE."'}
            className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 text-sm font-mono leading-relaxed resize-y"
          />
        </div>
        <div className="flex flex-col gap-3">
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
            <label className="text-xs text-neutral-500 block mb-1">Action</label>
            <TradeActionSelect action={action} onChange={setAction} />
          </div>
          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="text-xs text-neutral-500">
                {buyMode === 'amount' ? 'Amount per ticker' : 'Shares per ticker'}
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
            <label className="text-xs text-neutral-500 block mb-1">
              Price/share USD per ticker (optional)
            </label>
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
          <div className="text-xs text-neutral-500">
            Detected{' '}
            <span className="text-neutral-300 font-medium">{detected.length}</span>{' '}
            unique ticker{detected.length === 1 ? '' : 's'}:
            {detected.length > 0 ? (
              hasOverflow ? (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="text-left text-neutral-500 hover:text-neutral-300 cursor-pointer"
                  title={expanded ? 'Click to collapse' : 'Click to show all'}
                >
                  {' '}{visibleTickers.map((t) => `$${t}`).join(' ')}
                  {expanded
                    ? ' (show less)'
                    : ` +${detected.length - PREVIEW_COUNT} more`}
                </button>
              ) : (
                <span className="text-neutral-500">
                  {' '}{detected.map((t) => `$${t}`).join(' ')}
                </span>
              )
            ) : null}
          </div>
          <div className="flex gap-2 mt-auto">
            <button
              type="submit"
              disabled={running || detected.length === 0}
              className="flex-1 px-4 py-2 rounded-md bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium text-sm disabled:opacity-60 transition h-[38px]"
            >
              {running
                ? `Adding ${rows.filter((r) => r.status === 'added' || r.status === 'failed').length}/${rows.length}…`
                : `${action === 'sell' ? 'Sell' : 'Buy'} ${detected.length || ''} position${detected.length === 1 ? '' : 's'}`.trim()}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={running}
              className="px-3 py-2 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-sm disabled:opacity-50 h-[38px]"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {error ? <div className="text-xs text-red-400 mt-3">{error}</div> : null}

      {rows.length > 0 ? (
        <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {rows.map((r) => (
            <li
              key={r.ticker}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-neutral-800 bg-neutral-900/60 text-xs"
            >
              <StatusDot status={r.status} />
              <span className="font-mono text-emerald-400 shrink-0">${r.ticker}</span>
              <span className="text-neutral-400 truncate">
                {r.status === 'pending'
                  ? 'queued'
                  : r.status === 'adding'
                    ? 'adding…'
                    : r.message ?? r.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
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

function StatusDot({ status }: { status: RowStatus }) {
  const cls =
    status === 'added'
      ? 'bg-emerald-500'
      : status === 'failed'
        ? 'bg-red-500'
        : status === 'adding'
          ? 'bg-amber-400 animate-pulse'
          : status === 'skipped'
            ? 'bg-neutral-500'
            : 'bg-neutral-700';
  return <span className={`h-2 w-2 rounded-full shrink-0 ${cls}`} />;
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
