import { useQueryClient } from '@tanstack/react-query';
import { AddPositionForm } from './components/AddPositionForm';
import { PortfolioSummary } from './components/PortfolioSummary';
import { PositionsTable } from './components/PositionsTable';
import { AllocationChart } from './components/AllocationChart';
import { PerformanceChart } from './components/PerformanceChart';
import { PortfolioTabs } from './components/PortfolioTabs';
import { usePortfolio } from './hooks/usePortfolio';
import { useEnrichedPositions } from './hooks/usePrices';
import { totals } from './lib/calc';
import { applySalesToEnrichedPositions, portfolioFunding } from './lib/positions';

export default function App() {
  const qc = useQueryClient();
  const {
    portfolios,
    activePortfolioId,
    setActivePortfolioId,
    positions,
    isLoading: positionsLoading,
    error: positionsError,
    createPortfolio,
    creatingPortfolio,
    renamePortfolio,
    renamingPortfolio,
    deletePortfolio,
    deletingPortfolio,
    addSale,
    selling,
    removeSale,
    undoingSale,
  } = usePortfolio();
  const visiblePositions = positions.filter((position) => !position.hidden);
  const {
    enriched: savedEnriched,
    isLoading: pricesLoading,
    isFetching: pricesFetching,
  } = useEnrichedPositions(visiblePositions);
  const enriched = applySalesToEnrichedPositions(savedEnriched);
  const { cashUSD, totalCostBasisUSD } = portfolioFunding(savedEnriched);
  const portfolioTotals = totals(enriched);
  const portfolioCostUSD = totalCostBasisUSD ?? portfolioTotals.cost;
  const portfolioValueUSD = portfolioTotals.value + cashUSD;
  const portfolioGainUSD = portfolioValueUSD - portfolioCostUSD;
  const portfolioGainPct =
    Math.abs(portfolioCostUSD) > 0 ? portfolioGainUSD / Math.abs(portfolioCostUSD) : 0;

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['portfolios'] });
    qc.invalidateQueries({ queryKey: ['quote'] });
    qc.invalidateQueries({ queryKey: ['close-on'] });
    qc.invalidateQueries({ queryKey: ['fx'] });
    qc.invalidateQueries({ queryKey: ['history'] });
  };

  return (
    <div className="min-h-full">
      <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 text-sm font-bold">
              PB
            </div>
            <div>
              <h1 className="text-lg font-semibold text-neutral-100 leading-tight">Portbook</h1>
              <p className="text-xs text-neutral-500 leading-tight">
                Hypothetical portfolios
              </p>
            </div>
          </div>
          <button
            onClick={handleRefresh}
            disabled={pricesFetching}
            className="px-3 py-1.5 text-sm rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 hover:border-neutral-600 transition disabled:opacity-50"
          >
            {pricesFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <PortfolioTabs
          portfolios={portfolios}
          activePortfolioId={activePortfolioId}
          onSelect={setActivePortfolioId}
          onCreate={createPortfolio}
          onRename={(portfolioId, name) => renamePortfolio({ portfolioId, name })}
          onDelete={deletePortfolio}
          creating={creatingPortfolio}
          renaming={renamingPortfolio}
          deleting={deletingPortfolio}
        />

        <AddPositionForm />

        {positionsError ? (
          <div className="rounded-lg border border-red-900/50 bg-red-950/30 p-4 text-red-200">
            Failed to load portfolio: {(positionsError as Error).message}
          </div>
        ) : null}

        <PortfolioSummary
          enriched={enriched}
          loading={positionsLoading || pricesLoading}
          cashUSD={cashUSD}
          totalCostBasisUSD={totalCostBasisUSD}
        />

        {visiblePositions.length > 0 ? (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
            <div className="lg:h-[30.25rem] lg:min-h-0">
              <AllocationChart enriched={enriched} cashUSD={cashUSD} />
            </div>
            <PerformanceChart
              key={activePortfolioId ?? ''}
              positions={visiblePositions}
              portfolioReturn={{
                gain: portfolioGainUSD,
                pct: portfolioGainPct,
                endValue: portfolioValueUSD,
              }}
            />
          </div>
        ) : null}

        <PositionsTable
          enriched={enriched}
          loading={positionsLoading || pricesLoading}
          onSell={(positionId, sale) => addSale({ positionId, sale })}
          selling={selling}
          onUndoSale={(positionId, saleId) => removeSale({ positionId, saleId })}
          undoingSale={undoingSale}
        />
      </main>

      <footer className="max-w-7xl mx-auto px-6 pb-10 pt-4 text-xs text-neutral-600">
        Data via Yahoo Finance (yfinance-2).
      </footer>
    </div>
  );
}
