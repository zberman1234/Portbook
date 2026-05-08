import { Fragment, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usePortfolio } from '../hooks/usePortfolio';
import { api } from '../lib/api';
import { colorClass, fmtPct, fmtPrice, fmtShares, fmtUSD, fmtUSDSigned } from '../lib/format';
import { closingCashFlowUSD, SHARE_EPSILON } from '../lib/positions';
import type { EnrichedPosition, HistoryRow, PositionSale } from '../types';

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
  onSell: (
    positionId: string,
    sale: { saleDate: string; shares: number; salePriceUSD?: number },
  ) => Promise<unknown>;
  selling: boolean;
  onUndoSale: (positionId: string, saleId: string) => Promise<unknown>;
  undoingSale: boolean;
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

type TimeWindowKey = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' | 'ALL';

const TIME_WINDOWS: { key: TimeWindowKey; label: string }[] = [
  { key: '1D', label: '1D' },
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: '6M', label: '6M' },
  { key: '1Y', label: '1Y' },
  { key: '2Y', label: '2Y' },
  { key: '5Y', label: '5Y' },
  { key: 'ALL', label: 'ALL' },
];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDateISO(dateISO: string, amount: number, unit: 'day' | 'month' | 'year'): string {
  const date = new Date(`${dateISO}T00:00:00Z`);
  if (unit === 'day') date.setUTCDate(date.getUTCDate() + amount);
  if (unit === 'month') date.setUTCMonth(date.getUTCMonth() + amount);
  if (unit === 'year') date.setUTCFullYear(date.getUTCFullYear() + amount);
  return date.toISOString().slice(0, 10);
}

function windowStartDate(windowKey: TimeWindowKey, today: string): string | null {
  switch (windowKey) {
    case '1D':
      return shiftDateISO(today, -1, 'day');
    case '1W':
      return shiftDateISO(today, -7, 'day');
    case '1M':
      return shiftDateISO(today, -1, 'month');
    case '3M':
      return shiftDateISO(today, -3, 'month');
    case '6M':
      return shiftDateISO(today, -6, 'month');
    case '1Y':
      return shiftDateISO(today, -1, 'year');
    case '2Y':
      return shiftDateISO(today, -2, 'year');
    case '5Y':
      return shiftDateISO(today, -5, 'year');
    case 'ALL':
      return null;
  }
}

function historyStartDate(windowKey: TimeWindowKey, today: string): string {
  if (windowKey === 'ALL') return '1900-01-01';
  if (windowKey === '1D') return shiftDateISO(today, -7, 'day');
  return windowStartDate(windowKey, today) ?? '1900-01-01';
}

function normalizeNative(price: number | null, currency: string | undefined): number | null {
  if (price === null) return null;
  if (!currency) return price;
  if (currency === 'GBp' || currency.toUpperCase() === 'GBX') return price / 100;
  if (currency === 'ZAc' || currency.toUpperCase() === 'ZAX') return price / 100;
  return price;
}

function buildPriceChartRows(
  history: HistoryRow[] | undefined,
  currency: string,
  quotePriceDate: string | null,
  currentPriceNative: number,
): PriceChartRow[] {
  const rows = (history ?? [])
    .map((row) => {
      const price = normalizeNative(row.adjclose ?? row.close, currency);
      return typeof price === 'number' && Number.isFinite(price)
        ? { date: row.date, price }
        : null;
    })
    .filter((row): row is PriceChartRow => row !== null);

  if (
    quotePriceDate &&
    Number.isFinite(currentPriceNative) &&
    currentPriceNative > 0
  ) {
    const quoteRow = { date: quotePriceDate, price: currentPriceNative };
    const existingIndex = rows.findIndex((row) => row.date === quotePriceDate);
    if (existingIndex >= 0) rows[existingIndex] = quoteRow;
    else rows.push(quoteRow);
    rows.sort((a, b) => a.date.localeCompare(b.date));
  }

  return rows;
}

function visibleRowsForWindow(
  rows: PriceChartRow[],
  windowKey: TimeWindowKey,
  today: string,
): PriceChartRow[] {
  const startDate = windowStartDate(windowKey, today);
  if (!startDate) return rows;

  const windowRows = rows.filter((row) => row.date >= startDate);
  if (windowRows.length > 0) return windowRows;
  return windowKey === '1D' ? rows.slice(-2) : rows.slice(-1);
}

type DateSelection = {
  startDate: string;
  endDate: string;
};

function orderedSelection(a: string, b: string): DateSelection {
  return a <= b ? { startDate: a, endDate: b } : { startDate: b, endDate: a };
}

function getActiveDate(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const activeLabel = (state as { activeLabel?: unknown }).activeLabel;
  return typeof activeLabel === 'string' ? activeLabel : null;
}

function rangePriceReturn(rows: PriceChartRow[], startDate: string, endDate: string) {
  const windowRows = rows.filter((row) => row.date >= startDate && row.date <= endDate);
  return priceReturnFromRows(windowRows);
}

function priceReturn(rows: PriceChartRow[]) {
  return priceReturnFromRows(rows);
}

function priceReturnFromRows(rows: PriceChartRow[]) {
  const start = rows[0];
  const end = rows[rows.length - 1];
  if (!start || !end || start.price <= 0) return null;
  const gain = end.price - start.price;
  return {
    gain,
    pct: gain / start.price,
    startPrice: start.price,
    endPrice: end.price,
  };
}

function windowPhrase(windowKey: TimeWindowKey): string {
  switch (windowKey) {
    case '1D':
      return 'today';
    case '1W':
      return 'past week';
    case '1M':
      return 'past month';
    case '3M':
      return 'past 3 months';
    case '6M':
      return 'past 6 months';
    case '1Y':
      return 'past year';
    case '2Y':
      return 'past 2 years';
    case '5Y':
      return 'past 5 years';
    case 'ALL':
      return 'all time';
  }
}

function formatDateRange(startDate: string | null, endDate: string | null): string {
  if (!startDate || !endDate) return '';
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${formatter.format(new Date(`${startDate}T00:00:00Z`))}-${formatter.format(
    new Date(`${endDate}T00:00:00Z`),
  )}`;
}

function customRangeCalloutLeft(rows: PriceChartRow[], range: DateSelection | null): string {
  if (!range || rows.length < 2) return '50%';
  const startIndex = rows.findIndex((row) => row.date >= range.startDate);
  const endIndexFromEnd = rows
    .slice()
    .reverse()
    .findIndex((row) => row.date <= range.endDate);
  if (startIndex < 0 || endIndexFromEnd < 0) return '50%';

  const endIndex = rows.length - 1 - endIndexFromEnd;
  const center = ((startIndex + endIndex) / 2 / (rows.length - 1)) * 100;
  return `${Math.min(82, Math.max(18, center))}%`;
}

function fmtPriceSigned(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${fmtPrice(Math.abs(n))}`;
}

function SellFormRow({
  position,
  selling,
  onCancel,
  onSubmit,
}: {
  position: EnrichedPosition;
  selling: boolean;
  onCancel: () => void;
  onSubmit: (sale: { saleDate: string; shares: number; salePriceUSD?: number }) => Promise<unknown>;
}) {
  const today = todayISO();
  const [saleDate, setSaleDate] = useState(today);
  const [shares, setShares] = useState('');
  const [salePrice, setSalePrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isShort = position.shares < 0;
  const openSharesAbs = Math.abs(position.shares);
  const shareValue = Number(shares);
  const estimatedRemaining =
    Number.isFinite(shareValue) && shareValue > 0
      ? Math.max(0, openSharesAbs - shareValue)
      : openSharesAbs;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!saleDate) {
      setError('Please pick a sale date.');
      return;
    }
    if (saleDate < position.purchaseDate) {
      setError('Sale date cannot be before the purchase date.');
      return;
    }
    if (saleDate > today) {
      setError('Sale date cannot be in the future.');
      return;
    }
    if (!Number.isFinite(shareValue) || shareValue <= 0) {
      setError('Please enter a share quantity greater than 0.');
      return;
    }
    if (shareValue > openSharesAbs + SHARE_EPSILON) {
      setError(`You only have ${fmtShares(openSharesAbs)} open shares.`);
      return;
    }

    const salePriceUSD = salePrice.trim() === '' ? undefined : Number(salePrice);
    if (
      salePriceUSD !== undefined &&
      (!Number.isFinite(salePriceUSD) || salePriceUSD <= 0)
    ) {
      setError('Please enter a sale price greater than $0, or leave it blank.');
      return;
    }

    try {
      await onSubmit({
        saleDate,
        shares: shareValue,
        ...(salePriceUSD !== undefined ? { salePriceUSD } : {}),
      });
      onCancel();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <tr className="border-t border-neutral-800 bg-neutral-900/30">
      <td colSpan={columns.length + 1} className="px-3 py-3">
        <form onSubmit={handleSubmit} className="rounded-lg border border-neutral-800 bg-neutral-950/80 p-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-neutral-300">
                {isShort ? 'Record cover' : 'Record sale'} for {position.symbol}
              </div>
              <div className="text-xs text-neutral-500">
                Open {isShort ? 'short' : 'long'} shares:{' '}
                <span className="num">{fmtShares(openSharesAbs)}</span>
              </div>
            </div>
            <button
              type="button"
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
              onClick={onCancel}
            >
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
            <div>
              <label className="mb-1 block text-xs text-neutral-500">Sale date</label>
              <input
                type="date"
                value={saleDate}
                min={position.purchaseDate}
                max={today}
                onChange={(event) => setSaleDate(event.target.value)}
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-500">
                Shares to {isShort ? 'cover' : 'sell'}
              </label>
              <input
                type="number"
                value={shares}
                min="0.000001"
                max={String(openSharesAbs)}
                step="0.000001"
                inputMode="decimal"
                placeholder={fmtShares(openSharesAbs)}
                onChange={(event) => setShares(event.target.value)}
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-neutral-500">
                {isShort ? 'Cover' : 'Sale'} price/share USD (optional)
              </label>
              <input
                type="number"
                value={salePrice}
                min="0.01"
                step="0.01"
                inputMode="decimal"
                placeholder="Yahoo close"
                onChange={(event) => setSalePrice(event.target.value)}
                className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
              />
            </div>
            <button
              type="submit"
              disabled={selling}
              className="h-[38px] rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-60"
            >
              {selling ? 'Saving…' : isShort ? 'Record cover' : 'Record sale'}
            </button>
          </div>
          <div className="mt-2 text-xs text-neutral-500">
            Remaining after {isShort ? 'cover' : 'sale'}:{' '}
            <span className="num text-neutral-300">{fmtShares(estimatedRemaining)}</span>
          </div>
          {error ? <div className="mt-2 text-xs text-red-400">{error}</div> : null}
        </form>
      </td>
    </tr>
  );
}

type SoldRow = {
  position: EnrichedPosition;
  sale: PositionSale;
};

function SoldPositionsDropdown({
  rows,
  open,
  undoingSale,
  onToggle,
  onUndoSale,
}: {
  rows: SoldRow[];
  open: boolean;
  undoingSale: boolean;
  onToggle: () => void;
  onUndoSale: (positionId: string, saleId: string) => Promise<unknown>;
}) {
  if (rows.length === 0) return null;

  const totalShares = rows.reduce((sum, row) => sum + row.sale.shares, 0);

  return (
    <div className="border-t border-neutral-800">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-3 text-left transition hover:bg-neutral-900/50"
      >
        <div>
          <div className="text-sm font-medium text-neutral-400">Closed</div>
          <div className="text-xs text-neutral-600">
            {rows.length} close{rows.length === 1 ? '' : 's'} ·{' '}
            <span className="num">{fmtShares(totalShares)}</span> share
            {Math.abs(totalShares - 1) <= SHARE_EPSILON ? '' : 's'} closed
          </div>
        </div>
        <span className={`text-sm text-neutral-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>▶</span>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className="overflow-auto border-t border-neutral-800" style={{ maxHeight: 'min(40vh, 360px)' }}>
            <table className="w-full text-sm">
              <thead className="bg-neutral-900/60 text-xs uppercase tracking-wide text-neutral-500 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="px-3 py-2 text-left">Bought</th>
                  <th className="px-3 py-2 text-left">Closed</th>
                  <th className="px-3 py-2 text-right">Shares Closed</th>
                  <th className="px-3 py-2 text-right">Cost/Share</th>
                  <th className="px-3 py-2 text-right">Close Price/Share</th>
                  <th className="px-3 py-2 text-right">Cash Flow</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ position, sale }) => {
                  const cashFlow = closingCashFlowUSD(position, sale);
                  return (
                    <tr key={sale.id} className="border-t border-neutral-800">
                      <td className="px-3 py-2 font-mono text-neutral-300">{position.symbol}</td>
                      <td className="max-w-[22ch] truncate px-3 py-2 text-neutral-300" title={position.name}>
                        {position.name}
                      </td>
                      <td className="px-3 py-2 num text-neutral-400">{position.purchaseDate}</td>
                      <td className="px-3 py-2 num text-neutral-400">{sale.saleDate}</td>
                      <td className="px-3 py-2 text-right num text-neutral-300">{fmtShares(sale.shares)}</td>
                      <td className="px-3 py-2 text-right num text-neutral-300">{fmtPrice(position.purchasePriceUSD)}</td>
                      <td className="px-3 py-2 text-right num text-neutral-300">
                        {sale.salePriceUSD === undefined ? '—' : fmtPrice(sale.salePriceUSD)}
                      </td>
                      <td className="px-3 py-2 text-right num text-neutral-100">
                        {cashFlow === 0 ? '—' : fmtUSDSigned(cashFlow)}
                      </td>
                      <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={undoingSale}
                        onClick={() => onUndoSale(position.id, sale.id)}
                        className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                        title="Undo sale"
                      >
                        {undoingSale ? 'Undoing…' : 'Undo'}
                      </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function PositionDropdown({ position, open }: { position: EnrichedPosition; open: boolean }) {
  const today = todayISO();
  const [selectedWindow, setSelectedWindow] = useState<TimeWindowKey>('1W');
  const [dragStartDate, setDragStartDate] = useState<string | null>(null);
  const [dragEndDate, setDragEndDate] = useState<string | null>(null);
  const [customRange, setCustomRange] = useState<DateSelection | null>(null);
  const historyFrom = historyStartDate(selectedWindow, today);
  const historyQuery = useQuery({
    queryKey: ['history', position.symbol, historyFrom, today],
    queryFn: () => api.history(position.symbol, historyFrom, today),
    staleTime: 1000 * 60 * 60,
    enabled: open && !position.error,
  });

  const chartData = useMemo(
    () =>
      buildPriceChartRows(
        historyQuery.data,
        position.currency,
        position.quotePriceDate,
        position.currentPriceNative,
      ),
    [historyQuery.data, position.currency, position.quotePriceDate, position.currentPriceNative],
  );
  const visibleChartData = useMemo(
    () => visibleRowsForWindow(chartData, selectedWindow, today),
    [chartData, selectedWindow, today],
  );
  const stroke =
    position.dayChangePct === 0 ? '#d4d4d4' : position.dayChangePct > 0 ? '#10b981' : '#f87171';

  const activeRange =
    dragStartDate && dragEndDate ? orderedSelection(dragStartDate, dragEndDate) : customRange;

  const windowStats = useMemo(() => {
    const ret = priceReturn(visibleChartData);
    return {
      ret,
      valueGain: ret ? ret.gain * position.shares : null,
      startDate: visibleChartData[0]?.date ?? null,
      endDate: visibleChartData[visibleChartData.length - 1]?.date ?? null,
    };
  }, [position.shares, visibleChartData]);

  const customStats = useMemo(() => {
    if (customRange) {
      const ret = rangePriceReturn(visibleChartData, customRange.startDate, customRange.endDate);
      return {
        ret,
        valueGain: ret ? ret.gain * position.shares : null,
        startDate: customRange.startDate,
        endDate: customRange.endDate,
      };
    }
    return null;
  }, [customRange, position.shares, visibleChartData]);

  const customCalloutLeft = customRangeCalloutLeft(visibleChartData, customRange);

  const handleMouseDown = (state: unknown) => {
    const date = getActiveDate(state);
    if (!date) return;
    setDragStartDate(date);
    setDragEndDate(date);
  };

  const handleMouseMove = (state: unknown) => {
    if (!dragStartDate) return;
    const date = getActiveDate(state);
    if (date) setDragEndDate(date);
  };

  const handleMouseUp = (state: unknown) => {
    if (!dragStartDate) return;
    const date = getActiveDate(state) ?? dragEndDate ?? dragStartDate;
    const range = orderedSelection(dragStartDate, date);
    setCustomRange(range.startDate === range.endDate ? null : range);
    setDragStartDate(null);
    setDragEndDate(null);
  };

  const handleMouseLeave = () => {
    setDragStartDate(null);
    setDragEndDate(null);
  };

  return (
    <tr
      className={`${open ? 'border-t border-neutral-900 bg-neutral-900/20' : 'border-t border-transparent'
        }`}
    >
      <td colSpan={columns.length + 1} className="p-0">
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            }`}
        >
          <div className="overflow-hidden">
            <div className="px-3 py-3">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs font-medium text-neutral-300">Price history</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {TIME_WINDOWS.map((window) => (
                        <button
                          key={window.key}
                          type="button"
                          className={`rounded border px-2 py-1 text-[11px] transition ${selectedWindow === window.key
                            ? 'border-emerald-500/70 bg-emerald-500/10 text-emerald-300'
                            : 'border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                            }`}
                          onClick={() => { setSelectedWindow(window.key); setCustomRange(null); }}
                        >
                          {window.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-neutral-500">{position.currency}</div>
                    {!position.error && windowStats.ret ? (
                      <div className={`text-xs num ${colorClass(windowStats.ret.pct)}`}>
                        {fmtPriceSigned(windowStats.ret.gain)} ({fmtPct(windowStats.ret.pct)}){' '}
                        {windowStats.ret.gain >= 0 ? '↑' : '↓'} {windowPhrase(selectedWindow)}
                      </div>
                    ) : (
                      <div className="text-xs text-neutral-500">—</div>
                    )}
                  </div>
                </div>
                <div className="relative h-44 cursor-crosshair select-none">
                  {position.error ? (
                    <div className="flex h-full items-center justify-center rounded border border-amber-700/40 bg-amber-900/20 px-3 text-center text-xs text-amber-300/90">
                      Pricing unavailable for this symbol/date: {position.error}
                    </div>
                  ) : historyQuery.isLoading ? (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                      Loading chart...
                    </div>
                  ) : visibleChartData.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                      No chart data available
                    </div>
                  ) : (
                    <ResponsiveContainer>
                      <LineChart
                        data={visibleChartData}
                        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseLeave}
                      >
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
                        {activeRange && activeRange.startDate !== activeRange.endDate ? (
                          <ReferenceArea
                            x1={activeRange.startDate}
                            x2={activeRange.endDate}
                            stroke="#a78bfa"
                            strokeOpacity={0.7}
                            fill="#8b5cf6"
                            fillOpacity={0.12}
                          />
                        ) : null}
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
                  {customStats?.ret ? (
                    <div
                      className={`pointer-events-none absolute top-3 z-10 -translate-x-1/2 rounded border border-neutral-700 bg-neutral-950/95 px-2.5 py-1.5 text-xs shadow-lg ${colorClass(
                        customStats.ret.pct,
                      )}`}
                      style={{ left: customCalloutLeft }}
                    >
                      <span className="num">
                        {fmtPriceSigned(customStats.ret.gain)} ({fmtPct(customStats.ret.pct)}){' '}
                        {customStats.ret.gain >= 0 ? '↑' : '↓'}
                      </span>
                      <span className="ml-2 text-neutral-300">
                        {formatDateRange(customStats.startDate, customStats.endDate)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function PositionsTable({
  enriched,
  loading,
  onSell,
  selling,
  onUndoSale,
  undoingSale,
}: Props) {
  const { remove, removing } = usePortfolio();
  const [sortKey, setSortKey] = useState<SortKey>('marketValueUSD');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedPositionId, setExpandedPositionId] = useState<string | null>(null);
  const [sellingPositionId, setSellingPositionId] = useState<string | null>(null);
  const [soldOpen, setSoldOpen] = useState(false);

  const sorted = useMemo(() => {
    const rows = enriched.filter((position) => Math.abs(position.shares) > SHARE_EPSILON);
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

  const soldRows = useMemo(
    () =>
      enriched
        .flatMap((position) =>
          (position.sales ?? []).map((sale) => ({
            position,
            sale,
          })),
        )
        .sort((a, b) => b.sale.saleDate.localeCompare(a.sale.saleDate)),
    [enriched],
  );

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

  function openSellForm(positionId: string) {
    setSellingPositionId(positionId);
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
        <span className="text-xs text-neutral-500">
          {sorted.length} active · {soldRows.length} closed
        </span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900/80 text-neutral-400 text-xs uppercase tracking-wide">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => onSort(c.key)}
                  className={`px-3 py-2 cursor-pointer select-none hover:text-neutral-200 ${c.align === 'right' ? 'text-right' : 'text-left'
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
              const isShort = p.shares < 0;
              return (
                <Fragment key={p.id}>
                  <tr
                    onClick={() => toggleExpanded(p.id)}
                    className="cursor-pointer border-t border-neutral-800 hover:bg-neutral-900/40"
                  >
                    <td className="px-3 py-2">
                      <div className={isShort ? 'font-mono text-red-300' : 'font-mono text-emerald-400'}>
                        {p.symbol}
                      </div>
                      {isShort ? (
                        <div className="text-[10px] leading-tight text-red-400/80">SHORT</div>
                      ) : null}
                      {p.exchange ? (
                        <div className="text-[10px] leading-tight text-neutral-500">{p.exchange}</div>
                      ) : null}
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
                      <div className="inline-flex divide-x divide-neutral-800 rounded border border-neutral-800 overflow-hidden">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            openSellForm(p.id);
                          }}
                          disabled={selling || removing || Math.abs(p.shares) <= SHARE_EPSILON}
                          title={isShort ? 'Record cover' : 'Record sale'}
                          className="px-2 py-1 text-xs text-neutral-500 transition hover:bg-neutral-800/60 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isShort ? 'Cover' : 'Sell'}
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(p.id);
                          }}
                          disabled={removing}
                          title="Remove position"
                          className="px-2 py-1 text-xs text-neutral-500 transition hover:bg-neutral-800/60 hover:text-red-400 disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                  {sellingPositionId === p.id ? (
                    <SellFormRow
                      position={p}
                      selling={selling}
                      onCancel={() => setSellingPositionId(null)}
                      onSubmit={(sale) => onSell(p.id, sale)}
                    />
                  ) : null}
                  <PositionDropdown position={p} open={isExpanded} />
                </Fragment>
              );
            })}
            {!loading && sorted.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">
                  No active positions
                </td>
              </tr>
            ) : null}
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
        <SoldPositionsDropdown
          rows={soldRows}
          open={soldOpen}
          undoingSale={undoingSale}
          onToggle={() => setSoldOpen((open) => !open)}
          onUndoSale={onUndoSale}
        />
      </div>
    </div>
  );
}
