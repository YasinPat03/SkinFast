// Remembers the last Steam exchange rate derived for a currency, so a page
// whose own listings give no clear rate can still be converted for a while.

import { getJsonState, setState } from './state';

// Steam adjusts its rates about daily; a rate older than this is not reused.
const RATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

interface StoredRate {
  rate: number;
  at: string;
}

const rateKey = (currencyId: number) => `fx:${currencyId}`;

export async function getStoredUsdRate(currencyId: number): Promise<{ rate: number; ageMs: number } | null> {
  const stored = await getJsonState<StoredRate>(rateKey(currencyId));
  if (!stored || !(stored.rate > 0)) return null;
  const ageMs = Date.now() - new Date(stored.at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > RATE_MAX_AGE_MS) return null;
  return { rate: stored.rate, ageMs };
}

export async function storeUsdRate(currencyId: number, rate: number): Promise<void> {
  const stored: StoredRate = { rate, at: new Date().toISOString() };
  await setState(rateKey(currencyId), JSON.stringify(stored));
}
