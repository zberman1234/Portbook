import { useEffect, useRef, useState } from 'react';
import type { Portfolio } from '../types';

interface Props {
  portfolios: Portfolio[];
  activePortfolioId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<unknown>;
  onRename: (portfolioId: string, name: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  creating: boolean;
  renaming: boolean;
  deleting: boolean;
}

export function PortfolioTabs({
  portfolios,
  activePortfolioId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  creating,
  renaming,
  deleting,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

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

  function startRename(p: Portfolio) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditError(null);
  }

  function cancelRename() {
    setEditingId(null);
    setEditName('');
    setEditError(null);
  }

  async function submitRename(p: Portfolio) {
    const trimmed = editName.trim();
    if (!trimmed) {
      setEditError('Name required');
      return;
    }
    if (trimmed === p.name) {
      cancelRename();
      return;
    }
    if (
      portfolios.some(
        (other) => other.id !== p.id && other.name.toLowerCase() === trimmed.toLowerCase(),
      )
    ) {
      setEditError('Name already in use');
      return;
    }
    try {
      await onRename(p.id, trimmed);
      cancelRename();
    } catch (err) {
      setEditError((err as Error).message);
    }
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
          const isEditing = editingId === p.id;

          if (isEditing) {
            return (
              <div
                key={p.id}
                className="flex items-center gap-1 rounded-md border border-emerald-500/60 bg-emerald-500/10 px-1.5 py-1"
              >
                <input
                  ref={editInputRef}
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value);
                    setEditError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void submitRename(p);
                    } else if (e.key === 'Escape') {
                      cancelRename();
                    }
                  }}
                  onBlur={() => {
                    if (editName.trim() && editName.trim() !== p.name) {
                      void submitRename(p);
                    } else {
                      cancelRename();
                    }
                  }}
                  maxLength={40}
                  className="px-2 py-0.5 text-sm rounded bg-neutral-900 border border-neutral-700 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500/50 w-40"
                />
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void submitRename(p)}
                  disabled={renaming}
                  className="px-2 py-0.5 text-xs rounded bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium disabled:opacity-60"
                >
                  {renaming ? '…' : 'Save'}
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelRename}
                  className="px-1.5 py-0.5 text-xs rounded border border-neutral-800 text-neutral-400 hover:text-neutral-200"
                >
                  Esc
                </button>
              </div>
            );
          }

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
                onDoubleClick={() => startRename(p)}
                className="px-3 py-1.5 flex items-center gap-2"
                title={`${p.name} (double-click to rename)`}
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
                onClick={() => startRename(p)}
                title="Rename portfolio"
                className={`px-1.5 py-1.5 text-xs transition ${
                  active
                    ? 'text-emerald-400/70 hover:text-emerald-200 border-l border-emerald-500/40'
                    : 'text-neutral-500 hover:text-neutral-200 border-l border-neutral-800'
                }`}
              >
                ✎
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
      {editError ? <div className="text-xs text-red-400 mt-2 px-1">{editError}</div> : null}
    </div>
  );
}
