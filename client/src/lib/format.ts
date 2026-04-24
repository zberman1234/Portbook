const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PCT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  signDisplay: 'exceptZero',
});

const PCT_NOSIGN = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUM4 = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const NUM2 = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function fmtUSD(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return USD.format(n);
}

export function fmtUSDSigned(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${USD.format(Math.abs(n))}`;
}

export function fmtPct(n: number | undefined | null, signed = true): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return (signed ? PCT : PCT_NOSIGN).format(n);
}

export function fmtShares(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return NUM4.format(n);
}

export function fmtPrice(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  return NUM2.format(n);
}

export function colorClass(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n) || n === 0) return 'text-neutral-300';
  return n > 0 ? 'text-emerald-400' : 'text-red-400';
}
