// Server entry points for trade-up features: load the catalog, then run the
// pure engine over it.

import type { Catalog } from './catalog';
import { getCatalog } from './catalog-db';
import { describeEligibility } from './eligibility';
import { evaluateExactContract, findBestTradeups } from './finder';
import { type TradeupLeaderboardFilters, buildLeaderboard, filterLeaderboard } from './leaderboard';
import type {
  ExactTradeupInput,
  TradeupCombo,
  TradeupEligibility,
  TradeupFinderResult,
  TradeupLeaderboardEntry,
  TradeupLeaderboardResult,
  TradeupSort,
} from './types';

export async function findBestTradeup(
  skinId: string,
  wear: string,
  statTrak: boolean,
  sort: TradeupSort = 'cost_per_hit',
): Promise<TradeupFinderResult | { error: string }> {
  return findBestTradeups(await getCatalog(), skinId, wear, statTrak, sort);
}

export async function evaluateTradeupContract(
  skinId: string,
  wear: string,
  statTrak: boolean,
  inputs: ExactTradeupInput[],
): Promise<TradeupCombo | { error: string }> {
  return evaluateExactContract(await getCatalog(), skinId, wear, statTrak, inputs);
}

export async function getTradeupEligibility(skinId: string): Promise<TradeupEligibility> {
  return describeEligibility(await getCatalog(), skinId);
}

// The leaderboard is derived from the catalog, so it is rebuilt exactly when
// the catalog is reloaded and shared by every request in between.
const leaderboards = new WeakMap<Catalog, TradeupLeaderboardEntry[]>();

export async function getTradeupLeaderboard(
  filters: TradeupLeaderboardFilters = {},
): Promise<TradeupLeaderboardResult> {
  const catalog = await getCatalog();
  let entries = leaderboards.get(catalog);
  if (!entries) {
    entries = buildLeaderboard(catalog);
    leaderboards.set(catalog, entries);
  }
  return filterLeaderboard(entries, filters);
}
