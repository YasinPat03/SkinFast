// How fresh and how complete the market data is. Shown on /api/status for the
// operator, and used by the pages to tell visitors when figures rest on old or
// incomplete data instead of presenting them as if nothing were wrong.

import sql from '../db';
import { LISTINGS_STATE_KEYS } from './listings-scan';
import { type JobHealth, getJobHealth, getStates } from './state';
import { STEAM_GUARD_KEYS } from './steam-guard';

// Promise: every listed price was confirmed against Steam within this many
// hours. A healthy scan re-confirms each one about every 8 hours (see
// market/scheduler.ts); any listed price older than this makes the pages say so.
export const LISTINGS_MAX_AGE_HOURS = 24;
// Below this share of priced outcomes, EV figures are called out as incomplete.
export const SALES_COVERAGE_WARN = 0.9;

export interface DataStatus {
  generated_at: string;
  listings: {
    tracked_variants: number;
    listed_variants: number;
    newest_update_at: string | null;
    // Listed variants whose price was confirmed in the last 24 hours.
    listed_confirmed_last_24h: number;
    // Listed variants whose price is older than that (should be 0).
    listed_older_than_24h: number;
    oldest_listed_update_at: string | null;
    last_cycle_completed_at: string | null;
    cycle_progress: { offset: number; total: number } | null;
    job: JobHealth;
  };
  // Set while Steam's rate limit has every server request backing off.
  steam_cooldown_until: string | null;
  sales: {
    // Variants whose sale history has been read at least once.
    variants_read: number;
    variants_with_sales: number;
    newest_update_at: string | null;
    read_last_24h: number;
    // Listed, non-souvenir variants (what a contract can hand back) and how
    // many of them have a sale price to be valued at.
    outcome_variants: number;
    outcome_variants_priced: number;
    job: JobHealth;
  };
  metadata: { last_import_at: string | null; job: JobHealth };
  // The two conditions worth telling a visitor about.
  listings_fresh_share: number;
  listings_stale: boolean;
  sales_coverage: number;
  sales_incomplete: boolean;
}

const STATUS_TTL_MS = 60_000;
let cached: { status: DataStatus; expiresAt: number } | null = null;

const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);

export async function getDataStatus(): Promise<DataStatus> {
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const [listingRows, salesRows, state, listingsJob, salesJob, metadataJob] = await Promise.all([
    sql<{ tracked: number; listed: number; newest: Date | null; oldest_listed: Date | null; last_24h: number }[]>`
      SELECT COUNT(*)::int AS tracked,
             COUNT(*) FILTER (WHERE p.lowest_price_cents > 0)::int AS listed,
             MAX(p.updated_at) AS newest,
             MIN(p.updated_at) FILTER (WHERE p.lowest_price_cents > 0) AS oldest_listed,
             COUNT(*) FILTER (WHERE p.lowest_price_cents > 0
                                AND p.updated_at > NOW() - (${LISTINGS_MAX_AGE_HOURS} || ' hours')::INTERVAL)::int AS last_24h
      FROM skin_variants sv
      LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
    `,
    sql<{ read: number; with_sales: number; newest: Date | null; last_24h: number; outcomes: number; outcomes_priced: number }[]>`
      SELECT COUNT(*) FILTER (WHERE l.sample_count IS NOT NULL)::int AS read,
             COUNT(*) FILTER (WHERE l.avg_last5_cents > 0)::int AS with_sales,
             MAX(l.updated_at) FILTER (WHERE l.sample_count IS NOT NULL) AS newest,
             COUNT(*) FILTER (WHERE l.sample_count IS NOT NULL AND l.updated_at > NOW() - INTERVAL '24 hours')::int AS last_24h,
             COUNT(*) FILTER (WHERE NOT sv.is_souvenir AND p.lowest_price_cents > 0)::int AS outcomes,
             COUNT(*) FILTER (WHERE NOT sv.is_souvenir AND p.lowest_price_cents > 0 AND l.avg_last5_cents > 0)::int AS outcomes_priced
      FROM skin_variants sv
      LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
      LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
    `,
    getStates([...Object.values(LISTINGS_STATE_KEYS), STEAM_GUARD_KEYS.until, 'last_metadata_import']),
    getJobHealth('listings'),
    getJobHealth('sales'),
    getJobHealth('metadata'),
  ]);

  const listings = listingRows[0];
  const sales = salesRows[0];
  const offset = Number.parseInt(state[LISTINGS_STATE_KEYS.offset] ?? '', 10);
  const total = Number.parseInt(state[LISTINGS_STATE_KEYS.totalCount] ?? '', 10);

  const freshShare = listings.listed > 0 ? listings.last_24h / listings.listed : 0;
  const coverage = sales.outcomes > 0 ? sales.outcomes_priced / sales.outcomes : 0;

  const status: DataStatus = {
    generated_at: new Date().toISOString(),
    listings: {
      tracked_variants: listings.tracked,
      listed_variants: listings.listed,
      newest_update_at: iso(listings.newest),
      listed_confirmed_last_24h: listings.last_24h,
      listed_older_than_24h: listings.listed - listings.last_24h,
      oldest_listed_update_at: iso(listings.oldest_listed),
      last_cycle_completed_at: state[LISTINGS_STATE_KEYS.lastCycleCompletedAt] || null,
      cycle_progress: Number.isFinite(offset) && Number.isFinite(total) ? { offset, total } : null,
      job: listingsJob,
    },
    steam_cooldown_until:
      state[STEAM_GUARD_KEYS.until] && new Date(state[STEAM_GUARD_KEYS.until]).getTime() > Date.now()
        ? state[STEAM_GUARD_KEYS.until]
        : null,
    sales: {
      variants_read: sales.read,
      variants_with_sales: sales.with_sales,
      newest_update_at: iso(sales.newest),
      read_last_24h: sales.last_24h,
      outcome_variants: sales.outcomes,
      outcome_variants_priced: sales.outcomes_priced,
      job: salesJob,
    },
    metadata: { last_import_at: state.last_metadata_import || null, job: metadataJob },
    listings_fresh_share: Math.round(freshShare * 1000) / 1000,
    listings_stale: listings.listed - listings.last_24h > 0,
    sales_coverage: Math.round(coverage * 1000) / 1000,
    sales_incomplete: coverage < SALES_COVERAGE_WARN,
  };

  cached = { status, expiresAt: Date.now() + STATUS_TTL_MS };
  return status;
}
