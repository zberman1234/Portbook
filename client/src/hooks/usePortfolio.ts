import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Portfolio, Position } from '../types';

const ACTIVE_PORTFOLIO_KEY = 'pt:activePortfolioId';

function readStoredActiveId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTIVE_PORTFOLIO_KEY);
  } catch {
    return null;
  }
}

function writeStoredActiveId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id == null) window.localStorage.removeItem(ACTIVE_PORTFOLIO_KEY);
    else window.localStorage.setItem(ACTIVE_PORTFOLIO_KEY, id);
  } catch {
    /* ignore quota / privacy mode */
  }
}

export function usePortfolio() {
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['portfolios'],
    queryFn: api.listPortfolios,
  });

  const portfolios: Portfolio[] = useMemo(() => query.data ?? [], [query.data]);

  const [activePortfolioIdState, setActivePortfolioIdState] = useState<string | null>(
    () => readStoredActiveId(),
  );

  // Reconcile the active id with whatever portfolios came back from the server.
  // If the stored id is missing or no longer exists, fall back to the first one.
  useEffect(() => {
    if (portfolios.length === 0) {
      if (activePortfolioIdState !== null) {
        setActivePortfolioIdState(null);
        writeStoredActiveId(null);
      }
      return;
    }
    const exists = activePortfolioIdState
      ? portfolios.some((p) => p.id === activePortfolioIdState)
      : false;
    if (!exists) {
      const fallback = portfolios[0].id;
      setActivePortfolioIdState(fallback);
      writeStoredActiveId(fallback);
    }
  }, [portfolios, activePortfolioIdState]);

  const setActivePortfolioId = useCallback((id: string) => {
    setActivePortfolioIdState(id);
    writeStoredActiveId(id);
  }, []);

  const activePortfolio: Portfolio | null = useMemo(() => {
    if (!activePortfolioIdState) return null;
    return portfolios.find((p) => p.id === activePortfolioIdState) ?? null;
  }, [portfolios, activePortfolioIdState]);

  const positions: Position[] = activePortfolio?.positions ?? [];

  const addMutation = useMutation({
    mutationFn: (body: {
      symbol: string;
      name?: string;
      exchange?: string;
      currency?: string;
      purchaseDate: string;
    }) => {
      if (!activePortfolioIdState) {
        return Promise.reject(new Error('no active portfolio'));
      }
      return api.addPosition(activePortfolioIdState, body);
    },
    onSuccess: (data) => {
      qc.setQueryData(['portfolios'], data.portfolios);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (positionId: string) => {
      if (!activePortfolioIdState) {
        return Promise.reject(new Error('no active portfolio'));
      }
      return api.removePosition(activePortfolioIdState, positionId);
    },
    onSuccess: (data) => {
      qc.setQueryData(['portfolios'], data);
    },
  });

  const createPortfolioMutation = useMutation({
    mutationFn: (name: string) => api.createPortfolio(name),
    onSuccess: (data) => {
      qc.setQueryData(['portfolios'], data.portfolios);
      setActivePortfolioId(data.portfolio.id);
    },
  });

  const renamePortfolioMutation = useMutation({
    mutationFn: ({ portfolioId, name }: { portfolioId: string; name: string }) =>
      api.renamePortfolio(portfolioId, name),
    onSuccess: (data) => {
      qc.setQueryData(['portfolios'], data.portfolios);
    },
  });

  const deletePortfolioMutation = useMutation({
    mutationFn: (portfolioId: string) => api.deletePortfolio(portfolioId),
    onSuccess: (data, deletedId) => {
      qc.setQueryData(['portfolios'], data);
      if (activePortfolioIdState === deletedId) {
        const fallback = data[0]?.id ?? null;
        setActivePortfolioIdState(fallback);
        writeStoredActiveId(fallback);
      }
    },
  });

  return {
    portfolios,
    activePortfolio,
    activePortfolioId: activePortfolioIdState,
    setActivePortfolioId,
    positions,
    isLoading: query.isLoading,
    error: query.error,
    add: addMutation.mutateAsync,
    adding: addMutation.isPending,
    remove: removeMutation.mutateAsync,
    removing: removeMutation.isPending,
    createPortfolio: createPortfolioMutation.mutateAsync,
    creatingPortfolio: createPortfolioMutation.isPending,
    renamePortfolio: renamePortfolioMutation.mutateAsync,
    renamingPortfolio: renamePortfolioMutation.isPending,
    deletePortfolio: deletePortfolioMutation.mutateAsync,
    deletingPortfolio: deletePortfolioMutation.isPending,
  };
}
