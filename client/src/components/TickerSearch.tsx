import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useDebounced } from '../hooks/useDebounced';
import type { SearchHit } from '../types';

interface Props {
  value: SearchHit | null;
  onChange: (hit: SearchHit | null) => void;
}

export function TickerSearch({ value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(query, 250);
  // Allow pasted "$TICKER" notation (e.g. "$AIXA") — Yahoo's search doesn't
  // recognize the leading sigil.
  const searchTerm = debounced.trim().replace(/^\$+/, '');

  const searchQuery = useQuery({
    queryKey: ['search', searchTerm],
    queryFn: () => api.search(searchTerm),
    enabled: searchTerm.length > 0,
    staleTime: 1000 * 60 * 5,
  });

  const hits = searchQuery.data ?? [];

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    setHighlight(0);
  }, [searchTerm]);

  function pick(hit: SearchHit) {
    onChange(hit);
    setQuery(`${hit.symbol} — ${hit.name}`);
    setOpen(false);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(hits.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits[highlight];
      if (hit) pick(hit);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="text-xs text-neutral-500 block mb-1">Ticker</label>
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          if (value) onChange(null);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKey}
        placeholder="Search symbol or company name (e.g. AAPL, AIXA.DE, IQE.L, $SIVE)"
        className="w-full px-3 py-2 rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 text-sm"
        autoComplete="off"
      />
      {open && searchTerm.length > 0 ? (
        <div className="absolute z-30 mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 shadow-xl max-h-80 overflow-auto">
          {searchQuery.isLoading ? (
            <div className="px-3 py-2 text-sm text-neutral-500">Searching…</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-2 text-sm text-neutral-500">No matches for “{searchTerm}”.</div>
          ) : (
            hits.map((hit, i) => (
              <button
                key={`${hit.symbol}-${i}`}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(hit)}
                className={`w-full text-left px-3 py-2 border-b border-neutral-800 last:border-b-0 flex items-center justify-between gap-3 ${
                  i === highlight ? 'bg-neutral-800' : 'bg-transparent'
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-emerald-400">{hit.symbol}</span>
                    {hit.quoteType ? (
                      <span className="text-[10px] uppercase tracking-wide text-neutral-500 border border-neutral-700 rounded px-1">
                        {hit.quoteType}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-neutral-400 truncate">{hit.name}</div>
                </div>
                <div className="text-xs text-neutral-500 shrink-0">
                  {hit.exchangeDisplay ?? hit.exchange}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
