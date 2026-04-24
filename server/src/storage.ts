import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root is two levels up from server/src (or server/dist).
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const PORTFOLIOS_FILE = path.join(PROJECT_ROOT, 'portfolios.json');
const LEGACY_FILE = path.join(PROJECT_ROOT, 'portfolio.json');

export interface Position {
  id: string;
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  purchaseDate: string; // YYYY-MM-DD
  createdAt: string; // ISO timestamp
}

export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
  positions: Position[];
}

let writeChain: Promise<void> = Promise.resolve();

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadPortfolios(): Promise<Portfolio[]> {
  const existing = await readJson<unknown>(PORTFOLIOS_FILE);
  if (Array.isArray(existing)) {
    return existing as Portfolio[];
  }

  // First-run migration: wrap any legacy flat portfolio.json into a Default portfolio.
  const legacy = await readJson<unknown>(LEGACY_FILE);
  const legacyPositions = Array.isArray(legacy) ? (legacy as Position[]) : [];
  const seeded: Portfolio[] = [
    {
      id: randomUUID(),
      name: 'Default',
      createdAt: new Date().toISOString(),
      positions: legacyPositions,
    },
  ];
  await savePortfolios(seeded);
  return seeded;
}

export async function savePortfolios(portfolios: Portfolio[]): Promise<void> {
  const next = writeChain.then(async () => {
    const tmp = `${PORTFOLIOS_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(portfolios, null, 2), 'utf8');
    await fs.rename(tmp, PORTFOLIOS_FILE);
  });
  writeChain = next.catch(() => undefined);
  await next;
}

export async function addPortfolio(name: string): Promise<{ portfolio: Portfolio; portfolios: Portfolio[] }> {
  const current = await loadPortfolios();
  const portfolio: Portfolio = {
    id: randomUUID(),
    name: name.trim() || 'Untitled',
    createdAt: new Date().toISOString(),
    positions: [],
  };
  const updated = [...current, portfolio];
  await savePortfolios(updated);
  return { portfolio, portfolios: updated };
}

export async function removePortfolio(id: string): Promise<Portfolio[]> {
  const current = await loadPortfolios();
  const updated = current.filter((p) => p.id !== id);
  await savePortfolios(updated);
  return updated;
}

export async function addPositionToPortfolio(
  portfolioId: string,
  position: Position,
): Promise<Portfolio[]> {
  const current = await loadPortfolios();
  let found = false;
  const updated = current.map((p) => {
    if (p.id !== portfolioId) return p;
    found = true;
    return { ...p, positions: [...p.positions, position] };
  });
  if (!found) {
    const err = new Error(`portfolio not found: ${portfolioId}`);
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    throw err;
  }
  await savePortfolios(updated);
  return updated;
}

export async function removePositionFromPortfolio(
  portfolioId: string,
  positionId: string,
): Promise<Portfolio[]> {
  const current = await loadPortfolios();
  let found = false;
  const updated = current.map((p) => {
    if (p.id !== portfolioId) return p;
    found = true;
    return { ...p, positions: p.positions.filter((pos) => pos.id !== positionId) };
  });
  if (!found) {
    const err = new Error(`portfolio not found: ${portfolioId}`);
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    throw err;
  }
  await savePortfolios(updated);
  return updated;
}
