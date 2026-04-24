import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { usePortfolio } from '../hooks/usePortfolio';

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Yahoo symbols can include letters, digits, dots, hyphens, equals (for FX),
// and carets (for indices). We only accept tokens that start with a letter to
// avoid pulling in random "$10" price mentions.
const TICKER_REGEX = /\$([A-Za-z][A-Za-z0-9.\-=^]{0,14})/g;

function extractTickers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(TICKER_REGEX)) {
    const sym = match[1].toUpperCase();
    if (!seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  return out;
}

type RowStatus = 'pending' | 'adding' | 'added' | 'skipped' | 'failed';

interface Row {
  ticker: string;
  status: RowStatus;
  message?: string;
  resolvedSymbol?: string;
}

export function BulkAddForm() {
  const { add } = usePortfolio();
  const [text, setText] = useState('');
  const [date, setDate] = useState(todayISO());
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detected = useMemo(() => extractTickers(text), [text]);

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
    if (detected.length === 0) {
      setError('No $TICKERs found. Make sure each ticker is preceded by a $ (e.g. $AAPL).');
      return;
    }

    const initial: Row[] = detected.map((ticker) => ({ ticker, status: 'pending' }));
    setRows(initial);
    setRunning(true);

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

        await add({
          symbol,
          name,
          exchange,
          currency,
          purchaseDate: date,
        });
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
          <div className="text-xs text-neutral-500">
            Detected{' '}
            <span className="text-neutral-300 font-medium">{detected.length}</span>{' '}
            unique ticker{detected.length === 1 ? '' : 's'}
            {detected.length > 0 ? (
              <span className="text-neutral-600">
                {' '}· {detected.slice(0, 8).map((t) => `$${t}`).join(' ')}
                {detected.length > 8 ? ` +${detected.length - 8} more` : ''}
              </span>
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
                : `Add ${detected.length || ''} position${detected.length === 1 ? '' : 's'}`.trim()}
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
