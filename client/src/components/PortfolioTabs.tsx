import { useEffect, useRef, useState } from 'react';
import type { Portfolio } from '../types';

interface Props {
  portfolios: Portfolio[];
  activePortfolioId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  creating: boolean;
  deleting: boolean;
}

export function PortfolioTabs({
  portfolios,
  activePortfolioId,
  onSelect,
  onCreate,
  onDelete,
  creating,
  deleting,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name required');
      return;
    }
    if (portfolios.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setError('Name already in use');
      return;
    }
    try {
      await onCreate(trimmed);
      setName('');
      setAdding(false);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function cancelAdd() {
    setAdding(false);
    setName('');
    setError(null);
  }

  async function handleDelete(p: Portfolio) {
    if (portfolios.length <= 1) return;
    const ok = window.confirm(
      `Delete portfolio "${p.name}"? This will remove ${p.positions.length} position${
        p.positions.length === 1 ? '' : 's'
      }.`,
    );
    if (!ok) return;
    try {
      await onDelete(p.id);
    } catch (err) {
      window.alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-2">
      <div className="flex flex-wrap items-center gap-1">
        {portfolios.map((p) => {
          const active = p.id === activePortfolioId;
          const canDelete = portfolios.length > 1;
          return (
            <div
              key={p.id}
              className={`group flex items-center rounded-md border text-sm transition ${
                active
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                  : 'border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                className="px-3 py-1.5 flex items-center gap-2"
                title={p.name}
              >
                <span className="font-medium max-w-[18ch] truncate">{p.name}</span>
                <span
                  className={`text-[10px] rounded px-1 ${
                    active
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'bg-neutral-800 text-neutral-500'
                  }`}
                >
                  {p.positions.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => handleDelete(p)}
                disabled={!canDelete || deleting}
                title={canDelete ? 'Delete portfolio' : 'Cannot delete the last portfolio'}
                className={`px-2 py-1.5 text-xs rounded-r-md transition ${
                  canDelete
                    ? 'text-neutral-500 hover:text-red-400'
                    : 'text-neutral-700 cursor-not-allowed'
                } ${active ? 'border-l border-emerald-500/40' : 'border-l border-neutral-800'}`}
              >
                ×
              </button>
            </div>
          );
        })}

        {adding ? (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                } else if (e.key === 'Escape') {
                  cancelAdd();
                }
              }}
              placeholder="Portfolio name"
              maxLength={40}
              className="px-2 py-1.5 text-sm rounded-md bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 w-44"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={creating}
              className="px-2 py-1.5 text-sm rounded-md bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium disabled:opacity-60"
            >
              {creating ? '…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={cancelAdd}
              className="px-2 py-1.5 text-sm rounded-md border border-neutral-800 text-neutral-400 hover:text-neutral-200"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="px-2 py-1.5 text-sm rounded-md border border-dashed border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500"
            title="Create a new portfolio"
          >
            + New portfolio
          </button>
        )}
      </div>
      {error ? <div className="text-xs text-red-400 mt-2 px-1">{error}</div> : null}
    </div>
  );
}
