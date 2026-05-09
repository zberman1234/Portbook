import { Fragment, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { usePortfolio } from '../hooks/usePortfolio';
import { api } from '../lib/api';
import { colorClass, fmtPct, fmtPrice, fmtShares, fmtUSD, fmtUSDSigned } from '../lib/format';
import { closingCashFlowUSD, SHARE_EPSILON, totalSoldShares } from '../lib/positions';
import type { EnrichedPosition, HistoryRow, Position, PositionSale } from '../types';

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
  { key: 'purchasePriceUSD', label: 'Price', align: 'right' },
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
  defaultShares,
  selling,
  onCancel,
  onSubmit,
}: {
  position: EnrichedPosition;
  defaultShares: number;
  selling: boolean;
  onCancel: () => void;
  onSubmit: (sale: { saleDate: string; shares: number; salePriceUSD?: number }) => Promise<unknown>;
}) {
  const today = todayISO();
  const [saleDate, setSaleDate] = useState(today);
  const [shares, setShares] = useState(() =>
    defaultShares > 0 ? fmtShares(defaultShares).replace(/,/g, '') : '',
  );
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

type ActivePositionRow = EnrichedPosition & {
  groupKey: string;
  lots: EnrichedPosition[];
  purchaseDateLabel: string;
  purchaseCount: number;
};

type SoldGroup = {
  groupKey: string;
  symbol: string;
  name: string;
  exchange: string;
  rows: SoldRow[];
  purchaseDateLabel: string;
  purchaseCount: number;
  saleDateLabel: string;
  saleCount: number;
  shares: number;
  purchasePriceUSD: number;
  salePriceUSD: number | null;
  cashFlowUSD: number;
};

type HiddenPositionRow = {
  position: Position;
  soldShares: number;
  openShares: number | null;
  closed: boolean;
};

function groupKeyForSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function dateSummary(items: { key: string; date: string }[]) {
  const datesByItem = new Map<string, string>();
  for (const item of items) {
    if (item.date && !datesByItem.has(item.key)) {
      datesByItem.set(item.key, item.date);
    }
  }

  const dates = [...datesByItem.values()].sort((a, b) => a.localeCompare(b));
  return {
    firstDate: dates[0] ?? '—',
    count: dates.length,
  };
}

function DateWithCountValue({ date, count, label }: { date: string; count: number; label: string }) {
  const additionalItems = Math.max(0, count - 1);

  return (
    <span className="whitespace-nowrap">
      <span>{date}</span>
      {additionalItems > 0 ? (
        <sup className="ml-0.5 text-[9px] font-medium text-neutral-500" title={`${count} ${label}`}>
          +{additionalItems}
        </sup>
      ) : null}
    </span>
  );
}

function weightedAverageByShares(rows: { shares: number; value: number | null | undefined }[]): number | null {
  const totals = rows.reduce<{ shares: number; value: number }>(
    (acc, row) => {
      if (typeof row.value !== 'number' || !Number.isFinite(row.value)) return acc;
      const shares = Math.abs(row.shares);
      return {
        shares: acc.shares + shares,
        value: acc.value + row.value * shares,
      };
    },
    { shares: 0, value: 0 },
  );
  return totals.shares > SHARE_EPSILON ? totals.value / totals.shares : null;
}

function aggregateDayChangePct(lots: EnrichedPosition[]): number {
  const totals = lots.reduce(
    (acc, lot) => {
      if (lot.error || !Number.isFinite(lot.dayChangePct) || !Number.isFinite(lot.marketValueUSD)) {
        return acc;
      }
      const weight = Math.abs(lot.marketValueUSD);
      return {
        weight: acc.weight + weight,
        value: acc.value + lot.dayChangePct * weight,
      };
    },
    { weight: 0, value: 0 },
  );
  return totals.weight > SHARE_EPSILON ? totals.value / totals.weight : 0;
}

function aggregateActiveGroup(groupKey: string, lots: EnrichedPosition[]): ActivePositionRow {
  const sortedLots = [...lots].sort(
    (a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.createdAt.localeCompare(b.createdAt),
  );
  const primary = sortedLots[0];
  const validLots = sortedLots.filter((lot) => !lot.error);
  const shares = sortedLots.reduce((sum, lot) => sum + lot.shares, 0);
  const costBasisUSD = sortedLots.reduce((sum, lot) => sum + lot.costBasisUSD, 0);
  const marketValueUSD = validLots.reduce((sum, lot) => sum + lot.marketValueUSD, 0);
  const totalGainUSD = marketValueUSD - costBasisUSD;
  const grossCostBasisUSD = sortedLots.reduce((sum, lot) => sum + Math.abs(lot.costBasisUSD), 0);
  const grossShares = sortedLots.reduce((sum, lot) => sum + Math.abs(lot.shares), 0);
  const firstPricedLot = validLots[0] ?? primary;
  const purchaseSummary = dateSummary(sortedLots.map((lot) => ({ key: lot.id, date: lot.purchaseDate })));

  return {
    ...primary,
    id: groupKey,
    groupKey,
    lots: sortedLots,
    purchaseDateLabel: purchaseSummary.firstDate,
    purchaseCount: purchaseSummary.count,
    shares,
    purchaseDate: sortedLots[0]?.purchaseDate ?? primary.purchaseDate,
    purchasePriceDate: sortedLots[0]?.purchasePriceDate ?? primary.purchasePriceDate,
    purchasePriceUSD: grossShares > SHARE_EPSILON ? grossCostBasisUSD / grossShares : 0,
    purchasePriceNative: firstPricedLot.purchasePriceNative,
    currentPriceUSD: firstPricedLot.currentPriceUSD,
    currentPriceNative: firstPricedLot.currentPriceNative,
    costBasisUSD,
    marketValueUSD,
    totalGainUSD,
    totalGainPct: grossCostBasisUSD > SHARE_EPSILON ? totalGainUSD / grossCostBasisUSD : 0,
    dayChangePct: aggregateDayChangePct(sortedLots),
    error: sortedLots.some((lot) => lot.error) ? sortedLots.find((lot) => lot.error)?.error : undefined,
    sales: sortedLots.flatMap((lot) => lot.sales ?? []),
    createdAt: sortedLots[0]?.createdAt ?? primary.createdAt,
  };
}

function groupActivePositions(positions: EnrichedPosition[]): ActivePositionRow[] {
  const groups = new Map<string, EnrichedPosition[]>();
  for (const position of positions) {
    if (Math.abs(position.shares) <= SHARE_EPSILON) continue;
    const key = groupKeyForSymbol(position.symbol);
    groups.set(key, [...(groups.get(key) ?? []), position]);
  }
  return [...groups.entries()].map(([groupKey, lots]) => aggregateActiveGroup(groupKey, lots));
}

function groupSoldRows(rows: SoldRow[]): SoldGroup[] {
  const groups = new Map<string, SoldRow[]>();
  for (const row of rows) {
    const key = groupKeyForSymbol(row.position.symbol);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.entries()]
    .map(([groupKey, groupRows]) => {
      const sortedRows = [...groupRows].sort(
        (a, b) =>
          b.sale.saleDate.localeCompare(a.sale.saleDate) ||
          a.position.purchaseDate.localeCompare(b.position.purchaseDate),
      );
      const primary = sortedRows[0].position;
      const shares = sortedRows.reduce((sum, row) => sum + row.sale.shares, 0);
      const purchaseSummary = dateSummary(
        sortedRows.map((row) => ({ key: row.position.id, date: row.position.purchaseDate })),
      );
      const saleSummary = dateSummary(sortedRows.map((row) => ({ key: row.sale.id, date: row.sale.saleDate })));
      return {
        groupKey,
        symbol: primary.symbol,
        name: primary.name,
        exchange: primary.exchange,
        rows: sortedRows,
        purchaseDateLabel: purchaseSummary.firstDate,
        purchaseCount: purchaseSummary.count,
        saleDateLabel: saleSummary.firstDate,
        saleCount: saleSummary.count,
        shares,
        purchasePriceUSD:
          weightedAverageByShares(
            sortedRows.map((row) => ({ shares: row.sale.shares, value: row.position.purchasePriceUSD })),
          ) ?? 0,
        salePriceUSD: weightedAverageByShares(
          sortedRows.map((row) => ({ shares: row.sale.shares, value: row.sale.salePriceUSD })),
        ),
        cashFlowUSD: sortedRows.reduce(
          (sum, row) => sum + closingCashFlowUSD(row.position, row.sale),
          0,
        ),
      };
    })
    .sort((a, b) => b.rows[0].sale.saleDate.localeCompare(a.rows[0].sale.saleDate));
}

function hiddenPositionsFromPortfolio(positions: Position[]): HiddenPositionRow[] {
  return positions
    .filter((position) => position.hidden)
    .map((position) => {
      const soldShares = totalSoldShares(position);
      if (typeof position.shares === 'number' && Number.isFinite(position.shares)) {
        const openSharesAbs = Math.max(0, Math.abs(position.shares) - soldShares);
        const openShares = Math.sign(position.shares) * openSharesAbs;
        return {
          position,
          soldShares,
          openShares,
          closed: Math.abs(openShares) <= SHARE_EPSILON,
        };
      }
      return {
        position,
        soldShares,
        openShares: null,
        closed: false,
      };
    })
    .sort(
      (a, b) =>
        b.position.purchaseDate.localeCompare(a.position.purchaseDate) ||
        b.position.createdAt.localeCompare(a.position.createdAt),
    );
}

function SoldPositionsDropdown({
  rows,
  open,
  hidingPosition,
  undoingSale,
  onToggle,
  onHidePositions,
  onUndoSale,
}: {
  rows: SoldRow[];
  open: boolean;
  hidingPosition: boolean;
  undoingSale: boolean;
  onToggle: () => void;
  onHidePositions: (positionIds: string[]) => Promise<unknown>;
  onUndoSale: (positionId: string, saleId: string) => Promise<unknown>;
}) {
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null);
  const [undoPopoverGroupKey, setUndoPopoverGroupKey] = useState<string | null>(null);
  const [selectedUndoSaleIds, setSelectedUndoSaleIds] = useState<string[]>([]);
  const groups = useMemo(() => groupSoldRows(rows), [rows]);

  function closeUndoPopover() {
    setUndoPopoverGroupKey(null);
    setSelectedUndoSaleIds([]);
  }

  useEffect(() => {
    if (!undoPopoverGroupKey) return;

    function handleMouseDown(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('[data-undo-popover-root]')) return;
      closeUndoPopover();
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [undoPopoverGroupKey]);

  async function undoSaleRows(saleRows: SoldRow[]) {
    for (const row of saleRows) {
      await onUndoSale(row.position.id, row.sale.id);
    }
    closeUndoPopover();
  }

  function toggleUndoPopover(group: SoldGroup) {
    if (group.rows.length <= 1) {
      void undoSaleRows(group.rows);
      return;
    }

    const opening = undoPopoverGroupKey !== group.groupKey;
    setUndoPopoverGroupKey(opening ? group.groupKey : null);
    setSelectedUndoSaleIds(opening ? group.rows.map((row) => row.sale.id) : []);
  }

  function toggleUndoSale(saleId: string) {
    setSelectedUndoSaleIds((current) =>
      current.includes(saleId) ? current.filter((id) => id !== saleId) : [...current, saleId],
    );
  }

  async function undoSelectedSales(group: SoldGroup) {
    const selectedRows = group.rows.filter((row) => selectedUndoSaleIds.includes(row.sale.id));
    if (selectedRows.length === 0) return;
    await undoSaleRows(selectedRows);
  }

  if (rows.length === 0) return null;

  const totalShares = rows.reduce((sum, row) => sum + row.sale.shares, 0);
  const closedTickerText =
    groups.length === rows.length
      ? `${rows.length} close${rows.length === 1 ? '' : 's'}`
      : `${rows.length} closes across ${groups.length} ticker${groups.length === 1 ? '' : 's'}`;

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
            {closedTickerText} ·{' '}
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
              <thead className="sticky top-0 z-10 bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="min-w-[8.5rem] px-3 py-2 text-left whitespace-nowrap">Bought</th>
                  <th className="min-w-[8.5rem] px-3 py-2 text-left whitespace-nowrap">Closed</th>
                  <th className="px-3 py-2 text-right">Shares</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Close Price</th>
                  <th className="px-3 py-2 text-right">Cash Flow</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const isPopoverOpen = undoPopoverGroupKey === group.groupKey;
                  const hasMultiple = group.rows.length > 1;
                  const isExpanded = hasMultiple && expandedGroupKey === group.groupKey;
                  const uniquePositionIds = Array.from(
                    new Set(group.rows.map((row) => row.position.id)),
                  );
                  return (
                    <Fragment key={group.groupKey}>
                    <tr
                      onClick={
                        hasMultiple
                          ? () =>
                            setExpandedGroupKey((current) =>
                              current === group.groupKey ? null : group.groupKey,
                            )
                          : undefined
                      }
                      className={`border-t border-neutral-800 hover:bg-neutral-900/40 ${hasMultiple ? 'cursor-pointer' : ''
                        }`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-mono text-neutral-300">{group.symbol}</div>
                        <div className="text-[10px] leading-tight text-neutral-500">
                          {group.rows.length} close{group.rows.length === 1 ? '' : 's'}
                        </div>
                      </td>
                      <td className="max-w-[15ch] truncate px-3 py-2 text-neutral-300" title={group.name}>
                        {group.name}
                      </td>
                      <td className="min-w-[8.5rem] px-3 py-2 num text-neutral-400 whitespace-nowrap">
                        <DateWithCountValue
                          date={group.purchaseDateLabel}
                          count={group.purchaseCount}
                          label="purchases"
                        />
                      </td>
                      <td className="min-w-[8.5rem] px-3 py-2 num text-neutral-400 whitespace-nowrap">
                        <DateWithCountValue date={group.saleDateLabel} count={group.saleCount} label="closes" />
                      </td>
                      <td className="px-3 py-2 text-right num text-neutral-300">{fmtShares(group.shares)}</td>
                      <td className="px-3 py-2 text-right num text-neutral-300">{fmtPrice(group.purchasePriceUSD)}</td>
                      <td className="px-3 py-2 text-right num text-neutral-300">
                        {group.salePriceUSD === null ? '—' : fmtPrice(group.salePriceUSD)}
                      </td>
                      <td className="px-3 py-2 text-right num text-neutral-100">
                        {group.cashFlowUSD === 0 ? '—' : fmtUSDSigned(group.cashFlowUSD)}
                      </td>
                      <td className="px-3 py-2 text-right" onClick={(event) => event.stopPropagation()}>
                        <div className="relative inline-flex items-center gap-1 text-left" data-undo-popover-root>
                          <button
                            type="button"
                            disabled={hidingPosition}
                            onClick={(event) => {
                              event.stopPropagation();
                              void onHidePositions(uniquePositionIds);
                            }}
                            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-50"
                            title={hasMultiple ? 'Hide closes in this row' : 'Hide close'}
                          >
                            {hidingPosition ? 'Hiding…' : 'Hide'}
                          </button>
                          <button
                            type="button"
                            disabled={undoingSale}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleUndoPopover(group);
                            }}
                            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                            title={hasMultiple ? 'Choose closes to undo' : 'Undo sale'}
                          >
                            {undoingSale ? 'Undoing…' : 'Undo'}
                          </button>
                          {isPopoverOpen ? (
                            <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left shadow-xl">
                              <div className="mb-2 flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-xs font-medium text-neutral-300">Undo closes</div>
                                  <div className="text-[11px] text-neutral-500">
                                    Choose which {group.symbol} closes to undo.
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={closeUndoPopover}
                                  className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                                >
                                  x
                                </button>
                              </div>
                              <div className="max-h-48 overflow-auto rounded border border-neutral-800">
                                {group.rows.map(({ position, sale }) => {
                                  const cashFlow = closingCashFlowUSD(position, sale);
                                  return (
                                    <label
                                      key={sale.id}
                                      className="flex cursor-pointer items-center gap-2 border-t border-neutral-800 px-2 py-2 first:border-t-0 hover:bg-neutral-900/60"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedUndoSaleIds.includes(sale.id)}
                                        disabled={undoingSale}
                                        onChange={() => toggleUndoSale(sale.id)}
                                        className="h-3.5 w-3.5 accent-emerald-500"
                                      />
                                      <span className="min-w-0 flex-1">
                                        <span className="block truncate text-xs text-neutral-300">
                                          {sale.saleDate}
                                        </span>
                                        <span className="block text-[11px] text-neutral-500">
                                          <span className="num">{fmtShares(sale.shares)}</span> shares · bought{' '}
                                          {position.purchaseDate}
                                        </span>
                                      </span>
                                      <span className="num text-xs text-neutral-400">
                                        {cashFlow === 0 ? '—' : fmtUSDSigned(cashFlow)}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                              <div className="mt-3 flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => void undoSaleRows(group.rows)}
                                  disabled={undoingSale}
                                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                                >
                                  Undo all
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void undoSelectedSales(group)}
                                  disabled={undoingSale || selectedUndoSaleIds.length === 0}
                                  className="rounded bg-emerald-500 px-2 py-1 text-xs font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
                                >
                                  Undo selected
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr className="border-t border-neutral-900 bg-neutral-900/20">
                        <td colSpan={9} className="px-3 py-3">
                          <div className="rounded-lg border border-neutral-800 bg-neutral-950">
                            <table className="w-full text-xs">
                              <thead className="bg-neutral-950 text-neutral-500">
                                <tr>
                                  <th className="min-w-[8.5rem] px-3 py-2 text-left whitespace-nowrap">Bought</th>
                                  <th className="min-w-[8.5rem] px-3 py-2 text-left whitespace-nowrap">Closed</th>
                                  <th className="px-3 py-2 text-right">Shares</th>
                                  <th className="px-3 py-2 text-right">Price</th>
                                  <th className="px-3 py-2 text-right">Close Price</th>
                                  <th className="px-3 py-2 text-right">Cash Flow</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.rows.map(({ position, sale }) => {
                                  const cashFlow = closingCashFlowUSD(position, sale);
                                  return (
                                    <tr key={sale.id} className="border-t border-neutral-800">
                                      <td className="min-w-[8.5rem] px-3 py-2 num text-neutral-400 whitespace-nowrap">
                                        {position.purchaseDate}
                                      </td>
                                      <td className="min-w-[8.5rem] px-3 py-2 num text-neutral-400 whitespace-nowrap">
                                        {sale.saleDate}
                                      </td>
                                      <td className="px-3 py-2 text-right num text-neutral-300">
                                        {fmtShares(sale.shares)}
                                      </td>
                                      <td className="px-3 py-2 text-right num text-neutral-300">
                                        {fmtPrice(position.purchasePriceUSD)}
                                      </td>
                                      <td className="px-3 py-2 text-right num text-neutral-300">
                                        {sale.salePriceUSD === undefined ? '—' : fmtPrice(sale.salePriceUSD)}
                                      </td>
                                      <td className="px-3 py-2 text-right num text-neutral-100">
                                        {cashFlow === 0 ? '—' : fmtUSDSigned(cashFlow)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
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

function HiddenPositionsDropdown({
  rows,
  open,
  hidingPosition,
  removing,
  onToggle,
  onUnhide,
  onUnhideAll,
  onRemove,
  onRemoveAll,
}: {
  rows: HiddenPositionRow[];
  open: boolean;
  hidingPosition: boolean;
  removing: boolean;
  onToggle: () => void;
  onUnhide: (positionId: string) => Promise<unknown>;
  onUnhideAll: () => Promise<unknown>;
  onRemove: (positionId: string) => Promise<unknown>;
  onRemoveAll: () => Promise<unknown>;
}) {
  if (rows.length === 0) return null;
  const openCount = rows.filter((row) => !row.closed).length;
  const closedCount = rows.length - openCount;
  return (
    <div className="border-t border-neutral-800">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-5 py-3 text-left transition hover:bg-neutral-900/50"
      >
        <div>
          <div className="text-sm font-medium text-neutral-400">Hidden</div>
          <div className="text-xs text-neutral-600">
            {rows.length} position{rows.length === 1 ? '' : 's'} hidden · {openCount} open · {closedCount} closed
          </div>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 1 ? (
            <>
              <button
                type="button"
                disabled={hidingPosition || removing}
                onClick={(e) => {
                  e.stopPropagation();
                  void onUnhideAll();
                }}
                className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
              >
                {hidingPosition ? 'Saving…' : 'Unhide all'}
              </button>
              <button
                type="button"
                disabled={hidingPosition || removing}
                onClick={(e) => {
                  e.stopPropagation();
                  void onRemoveAll();
                }}
                className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
              >
                {removing ? 'Removing…' : 'Remove all'}
              </button>
            </>
          ) : null}
          <span className={`text-sm text-neutral-500 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}>▶</span>
        </div>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr', opacity: open ? 1 : 0 }}
      >
        <div className="overflow-hidden">
          <div className="overflow-auto border-t border-neutral-800" style={{ maxHeight: 'min(40vh, 360px)' }}>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-neutral-900 text-xs uppercase tracking-wide text-neutral-500">
                <tr>
                  <th className="px-3 py-2 text-left">Symbol</th>
                  <th className="px-3 py-2 text-left">Name</th>
                  <th className="min-w-[8.5rem] px-3 py-2 text-left whitespace-nowrap">Bought</th>
                  <th className="px-3 py-2 text-right">Open</th>
                  <th className="px-3 py-2 text-right">Closed</th>
                  <th className="px-3 py-2 text-right">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.position.id} className="border-t border-neutral-800 hover:bg-neutral-900/40">
                    <td className="px-3 py-2">
                      <div className="font-mono text-amber-300">{row.position.symbol}</div>
                      {row.position.exchange ? (
                        <div className="text-[10px] leading-tight text-neutral-500">{row.position.exchange}</div>
                      ) : null}
                    </td>
                    <td className="max-w-[15ch] truncate px-3 py-2 text-neutral-300" title={row.position.name}>
                      {row.position.name}
                    </td>
                    <td className="min-w-[8.5rem] px-3 py-2 num text-neutral-400 whitespace-nowrap">
                      {row.position.purchaseDate}
                    </td>
                    <td className="px-3 py-2 text-right num text-neutral-300">
                      {row.openShares === null ? '—' : fmtShares(row.openShares)}
                    </td>
                    <td className="px-3 py-2 text-right num text-neutral-300">
                      {row.soldShares > SHARE_EPSILON ? fmtShares(row.soldShares) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-neutral-400">
                      {row.closed ? 'Closed' : 'Open'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={hidingPosition || removing}
                          onClick={() => void onUnhide(row.position.id)}
                          className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:opacity-50"
                        >
                          {hidingPosition ? 'Saving…' : 'Unhide'}
                        </button>
                        <button
                          type="button"
                          disabled={hidingPosition || removing}
                          onClick={() => void onRemove(row.position.id)}
                          className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
                        >
                          {removing ? 'Removing…' : 'Remove'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function PositionDropdown({ position, open }: { position: ActivePositionRow; open: boolean }) {
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
  const showLots =
    position.lots.length > 1 || position.lots.some((lot) => (lot.sales?.length ?? 0) > 0);

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
              {showLots ? (
                <div className="mt-3 rounded-lg border border-neutral-800 bg-neutral-950/70">
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="text-xs font-medium text-neutral-300">Purchases</div>
                    <div className="text-xs text-neutral-500">
                      {position.lots.length} lot{position.lots.length === 1 ? '' : 's'} ·{' '}
                      <span className="num">{fmtShares(Math.abs(position.shares))}</span> open shares
                    </div>
                  </div>
                  <div className="overflow-auto border-t border-neutral-800">
                    <table className="w-full text-xs">
                      <thead className="text-neutral-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Bought</th>
                          <th className="px-3 py-2 text-right">Shares</th>
                          <th className="px-3 py-2 text-right">Cost Basis</th>
                          <th className="px-3 py-2 text-right">Price</th>
                          <th className="px-3 py-2 text-right">Market Value</th>
                          <th className="px-3 py-2 text-right">Total G/L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {position.lots.map((lot) => (
                          <tr key={lot.id} className="border-t border-neutral-800">
                            <td className="px-3 py-2 num text-neutral-400">{lot.purchaseDate}</td>
                            <td className="px-3 py-2 text-right num text-neutral-300">{fmtShares(lot.shares)}</td>
                            <td className="px-3 py-2 text-right num text-neutral-300">{fmtUSD(lot.costBasisUSD)}</td>
                            <td className="px-3 py-2 text-right num text-neutral-300">
                              {fmtPrice(lot.purchasePriceUSD)}
                            </td>
                            <td className="px-3 py-2 text-right num text-neutral-100">
                              {lot.error ? '—' : fmtUSD(lot.marketValueUSD)}
                            </td>
                            <td className={`px-3 py-2 text-right num ${colorClass(lot.totalGainUSD)}`}>
                              {lot.error ? '—' : fmtUSDSigned(lot.totalGainUSD)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
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
  const { positions, remove, removing, setPositionHidden, hidingPosition } = usePortfolio();
  const [sortKey, setSortKey] = useState<SortKey>('marketValueUSD');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [expandedPositionId, setExpandedPositionId] = useState<string | null>(null);
  const [sellingPositionId, setSellingPositionId] = useState<string | null>(null);
  const [hidePopoverGroupKey, setHidePopoverGroupKey] = useState<string | null>(null);
  const [selectedHiddenLotIds, setSelectedHiddenLotIds] = useState<string[]>([]);
  const [removePopoverGroupKey, setRemovePopoverGroupKey] = useState<string | null>(null);
  const [selectedRemovalLotIds, setSelectedRemovalLotIds] = useState<string[]>([]);
  const [soldOpen, setSoldOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);

  const sorted = useMemo(() => {
    const rows = groupActivePositions(enriched);
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
  const soldGroups = useMemo(() => groupSoldRows(soldRows), [soldRows]);
  const hiddenRows = useMemo(() => hiddenPositionsFromPortfolio(positions), [positions]);

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'symbol' || key === 'name' || key === 'purchaseDate' ? 'asc' : 'desc');
    }
  }

  function toggleExpanded(groupKey: string) {
    setExpandedPositionId((current) => (current === groupKey ? null : groupKey));
  }

  function openSellForm(groupKey: string) {
    closeHidePopover();
    setRemovePopoverGroupKey(null);
    setSelectedRemovalLotIds([]);
    setSellingPositionId(groupKey);
  }

  async function submitSaleForRow(
    row: ActivePositionRow,
    sale: { saleDate: string; shares: number; salePriceUSD?: number },
  ) {
    const isShort = row.shares < 0;
    const eligibleLots = row.lots
      .filter(
        (lot) =>
          lot.purchaseDate <= sale.saleDate &&
          (isShort ? lot.shares < -SHARE_EPSILON : lot.shares > SHARE_EPSILON),
      )
      .sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate) || a.createdAt.localeCompare(b.createdAt));
    const availableShares = eligibleLots.reduce((sum, lot) => sum + Math.abs(lot.shares), 0);
    if (sale.shares > availableShares + SHARE_EPSILON) {
      throw new Error(`Only ${fmtShares(availableShares)} shares are available to close by that date.`);
    }

    let remainingShares = sale.shares;
    for (const lot of eligibleLots) {
      if (remainingShares <= SHARE_EPSILON) break;
      const shares = Math.min(Math.abs(lot.shares), remainingShares);
      await onSell(lot.id, { ...sale, shares });
      remainingShares -= shares;
    }
  }

  function closeHidePopover() {
    setHidePopoverGroupKey(null);
    setSelectedHiddenLotIds([]);
  }

  async function setHiddenForPositionIds(positionIds: string[], hidden: boolean) {
    const uniqueIds = Array.from(new Set(positionIds));
    for (const positionId of uniqueIds) {
      await setPositionHidden({ positionId, hidden });
    }
  }

  async function hideLots(lots: EnrichedPosition[]) {
    await setHiddenForPositionIds(
      lots.map((lot) => lot.id),
      true,
    );
    closeHidePopover();
  }

  function toggleHidePopover(row: ActivePositionRow) {
    closeRemovePopover();
    if (row.lots.length <= 1) {
      void hideLots(row.lots);
      return;
    }

    const opening = hidePopoverGroupKey !== row.groupKey;
    setHidePopoverGroupKey(opening ? row.groupKey : null);
    setSelectedHiddenLotIds(opening ? row.lots.map((lot) => lot.id) : []);
  }

  function toggleHiddenLot(lotId: string) {
    setSelectedHiddenLotIds((current) =>
      current.includes(lotId) ? current.filter((id) => id !== lotId) : [...current, lotId],
    );
  }

  async function hideSelectedLots(row: ActivePositionRow) {
    const selectedLots = row.lots.filter((lot) => selectedHiddenLotIds.includes(lot.id));
    if (selectedLots.length === 0) return;
    await hideLots(selectedLots);
  }

  function closeRemovePopover() {
    setRemovePopoverGroupKey(null);
    setSelectedRemovalLotIds([]);
  }

  function toggleRemovePopover(row: ActivePositionRow) {
    closeHidePopover();
    if (row.lots.length <= 1) {
      void removeLots(row.lots);
      return;
    }

    const opening = removePopoverGroupKey !== row.groupKey;
    setRemovePopoverGroupKey(opening ? row.groupKey : null);
    setSelectedRemovalLotIds(opening ? row.lots.map((lot) => lot.id) : []);
  }

  function toggleRemovalLot(lotId: string) {
    setSelectedRemovalLotIds((current) =>
      current.includes(lotId) ? current.filter((id) => id !== lotId) : [...current, lotId],
    );
  }

  async function removeLots(lots: EnrichedPosition[]) {
    await removePositionIds(lots.map((lot) => lot.id));
    closeRemovePopover();
  }

  async function removePositionIds(positionIds: string[]) {
    const uniqueIds = Array.from(new Set(positionIds));
    for (const positionId of uniqueIds) {
      await remove(positionId);
    }
  }

  async function removeSelectedLots(row: ActivePositionRow) {
    const selectedLots = row.lots.filter((lot) => selectedRemovalLotIds.includes(lot.id));
    if (selectedLots.length === 0) return;
    await removeLots(selectedLots);
  }

  useEffect(() => {
    if (!hidePopoverGroupKey) return;

    function handleMouseDown(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('[data-hide-popover-root]')) return;
      closeHidePopover();
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [hidePopoverGroupKey]);

  useEffect(() => {
    if (!removePopoverGroupKey) return;

    function handleMouseDown(event: MouseEvent) {
      if (event.target instanceof Element && event.target.closest('[data-remove-popover-root]')) return;
      closeRemovePopover();
    }

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [removePopoverGroupKey]);

  if (!loading && enriched.length === 0 && hiddenRows.length === 0) {
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
          {sorted.length} active · {soldGroups.length} closed · {hiddenRows.length} hidden
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
                  className={`px-3 py-2 cursor-pointer select-none hover:text-neutral-200 ${c.key === 'purchaseDate' ? 'min-w-[8.5rem] whitespace-nowrap' : ''
                    } ${c.align === 'right' ? 'text-right' : 'text-left'
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
              const isExpanded = expandedPositionId === p.groupKey;
              const isShort = p.shares < 0;
              return (
                <Fragment key={p.groupKey}>
                  <tr
                    onClick={() => toggleExpanded(p.groupKey)}
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
                    <td className="px-3 py-2 text-neutral-300 max-w-[15ch] truncate" title={p.name}>
                      {p.name}
                    </td>
                    <td className="px-3 py-2 text-neutral-400 num min-w-[8.5rem] whitespace-nowrap">
                      <DateWithCountValue date={p.purchaseDateLabel} count={p.purchaseCount} label="purchases" />
                    </td>
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
                    <td className="px-3 py-2 text-right" onClick={(event) => event.stopPropagation()}>
                      <div className="inline-flex items-center gap-1 text-left">
                        <button
                          type="button"
                          onClick={() => openSellForm(p.groupKey)}
                          disabled={selling || removing || Math.abs(p.shares) <= SHARE_EPSILON}
                          title={isShort ? 'Record cover' : 'Record sale'}
                          className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-emerald-500/40 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {isShort ? 'Cover' : 'Sell'}
                        </button>
                        <div className="relative inline-block" data-hide-popover-root>
                          <button
                            type="button"
                            onClick={() => toggleHidePopover(p)}
                            disabled={hidingPosition}
                            title={p.lots.length > 1 ? 'Choose positions to hide' : 'Hide position'}
                            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-amber-500/40 hover:text-amber-300 disabled:opacity-40"
                          >
                            {hidingPosition ? 'Hiding…' : 'Hide'}
                          </button>
                          {hidePopoverGroupKey === p.groupKey ? (
                            <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left shadow-xl">
                              <div className="mb-2 flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-xs font-medium text-neutral-300">Hide positions</div>
                                  <div className="text-[11px] text-neutral-500">Choose which {p.symbol} buys to hide.</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={closeHidePopover}
                                  className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                                >
                                  x
                                </button>
                              </div>
                              <div className="max-h-48 overflow-auto rounded border border-neutral-800">
                                {p.lots.map((lot) => (
                                  <label
                                    key={lot.id}
                                    className="flex cursor-pointer items-center gap-2 border-t border-neutral-800 px-2 py-2 first:border-t-0 hover:bg-neutral-900/60"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedHiddenLotIds.includes(lot.id)}
                                      disabled={hidingPosition}
                                      onChange={() => toggleHiddenLot(lot.id)}
                                      className="h-3.5 w-3.5 accent-amber-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-xs text-neutral-300">{lot.purchaseDate}</span>
                                      <span className="block text-[11px] text-neutral-500">
                                        <span className="num">{fmtShares(lot.shares)}</span> shares
                                      </span>
                                    </span>
                                    <span className="num text-xs text-neutral-400">{fmtUSD(lot.costBasisUSD)}</span>
                                  </label>
                                ))}
                              </div>
                              <div className="mt-3 flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => void hideLots(p.lots)}
                                  disabled={hidingPosition}
                                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 transition hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-50"
                                >
                                  Hide all
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void hideSelectedLots(p)}
                                  disabled={hidingPosition || selectedHiddenLotIds.length === 0}
                                  className="rounded bg-amber-500 px-2 py-1 text-xs font-medium text-neutral-950 transition hover:bg-amber-400 disabled:opacity-50"
                                >
                                  Hide selected
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                        <div className="relative inline-block" data-remove-popover-root>
                          <button
                            type="button"
                            onClick={() => toggleRemovePopover(p)}
                            disabled={removing}
                            title={p.lots.length > 1 ? 'Choose positions to remove' : 'Remove position'}
                            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-500 transition hover:border-red-500/50 hover:text-red-400 disabled:opacity-40"
                          >
                            Remove
                          </button>
                          {removePopoverGroupKey === p.groupKey ? (
                            <div className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left shadow-xl">
                              <div className="mb-2 flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-xs font-medium text-neutral-300">Remove positions</div>
                                  <div className="text-[11px] text-neutral-500">Choose which {p.symbol} buys to remove.</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={closeRemovePopover}
                                  className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                                >
                                  x
                                </button>
                              </div>
                              <div className="max-h-48 overflow-auto rounded border border-neutral-800">
                                {p.lots.map((lot) => (
                                  <label
                                    key={lot.id}
                                    className="flex cursor-pointer items-center gap-2 border-t border-neutral-800 px-2 py-2 first:border-t-0 hover:bg-neutral-900/60"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={selectedRemovalLotIds.includes(lot.id)}
                                      disabled={removing}
                                      onChange={() => toggleRemovalLot(lot.id)}
                                      className="h-3.5 w-3.5 accent-red-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-xs text-neutral-300">{lot.purchaseDate}</span>
                                      <span className="block text-[11px] text-neutral-500">
                                        <span className="num">{fmtShares(lot.shares)}</span> shares
                                      </span>
                                    </span>
                                    <span className="num text-xs text-neutral-400">{fmtUSD(lot.costBasisUSD)}</span>
                                  </label>
                                ))}
                              </div>
                              <div className="mt-3 flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  onClick={() => void removeLots(p.lots)}
                                  disabled={removing}
                                  className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-400 transition hover:border-red-500/50 hover:text-red-300 disabled:opacity-50"
                                >
                                  Remove all
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void removeSelectedLots(p)}
                                  disabled={removing || selectedRemovalLotIds.length === 0}
                                  className="rounded bg-red-500 px-2 py-1 text-xs font-medium text-neutral-950 transition hover:bg-red-400 disabled:opacity-50"
                                >
                                  Remove selected
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                  {sellingPositionId === p.groupKey ? (
                    <SellFormRow
                      position={p}
                      defaultShares={Math.abs(p.lots[0]?.shares ?? p.shares)}
                      selling={selling}
                      onCancel={() => setSellingPositionId(null)}
                      onSubmit={(sale) => submitSaleForRow(p, sale)}
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
          hidingPosition={hidingPosition}
          undoingSale={undoingSale}
          onToggle={() => setSoldOpen((open) => !open)}
          onHidePositions={(positionIds) => setHiddenForPositionIds(positionIds, true)}
          onUndoSale={onUndoSale}
        />
        <HiddenPositionsDropdown
          rows={hiddenRows}
          open={hiddenOpen}
          hidingPosition={hidingPosition}
          removing={removing}
          onToggle={() => setHiddenOpen((open) => !open)}
          onUnhide={(positionId) => setHiddenForPositionIds([positionId], false)}
          onUnhideAll={() => setHiddenForPositionIds(hiddenRows.map((r) => r.position.id), false)}
          onRemove={(positionId) => removePositionIds([positionId])}
          onRemoveAll={() => removePositionIds(hiddenRows.map((r) => r.position.id))}
        />
      </div>
    </div>
  );
}
