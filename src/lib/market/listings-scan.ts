// The bulk listing-price scan: walks Steam's market search for every weapon,
// knife and glove (name order, 10 per page) and stores each item's lowest
// listing. Runs in bounded slices from a cron job or the CLI; progress is saved
// after every page, so the next slice continues where this one stopped.
//
// What a full pass ("cycle") establishes:
//  - every item it saw has an active listing at the stored price, and
//  - an item it did not see has none. Search pagination over a live list can
//    skip an item when listings appear or vanish mid-pass, so a price is only
//    cleared after the item was missing from two consecutive cycles.

import { SteamError, SteamRateLimitError, sleep } from '../steam/http';
import { type SearchPage, TRACKED_TYPE_TAGS, fetchSearchPage } from '../steam/search';
import { getStates, setStates } from './state';
import { clearListingsNotSeenSince, countListedVariants, countListingsNotSeenSince, saveListings } from './store';

const KEY = {
  offset: 'listings:offset',
  cycleStartedAt: 'listings:cycle_started_at',
  cycleItems: 'listings:cycle_items',
  prevCycleStartedAt: 'listings:prev_cycle_started_at',
  lastCycleCompletedAt: 'listings:last_cycle_completed_at',
  totalCount: 'listings:total_count',
  stuck: 'listings:stuck',
} as const;

export const LISTINGS_STATE_KEYS = KEY;

// Time one more page may need (request spacing, a retry, the DB write).
const PAGE_RESERVE_MS = 30_000;
const RATE_LIMIT_RETRY_MS = 15_000;
const TRANSIENT_RETRY_MS = 5_000;
// An empty page before the end of the list is retried on later runs; after
// this many runs stuck on the same offset the scan steps past it.
const MAX_STUCK_RUNS = 3;
// The sweep that clears vanished listings is skipped when the cycle saw less
// than this share of the catalogue, or would clear more than this share of
// what is listed. Either means the cycle is not a reliable picture.
const MIN_CYCLE_COVERAGE = 0.9;
const MAX_SWEEP_SHARE = 0.2;

export type ScanStop = 'cycle_complete' | 'budget' | 'max_pages' | 'rate_limited' | 'empty_page' | 'error';

export interface ListingScanResult {
  pagesFetched: number;
  itemsSeen: number;
  pricesWritten: number;
  // Results the catalog does not know, i.e. skins newer than the metadata import.
  unknownItems: number;
  startOffset: number;
  offset: number;
  totalCount: number | null;
  stoppedBy: ScanStop;
  completedCycle: boolean;
  // Variants whose listing price was cleared because two cycles did not see them.
  clearedUnlisted: number;
  sweepSkipped: string | null;
  error: string | null;
}

// One retry for things that usually pass on a second attempt: a 429 (after a
// pause), `success: false`, or a 5xx. A second failure ends the run.
async function fetchPageWithRetry(start: number): Promise<SearchPage> {
  try {
    return await fetchSearchPage({ start, typeTags: TRACKED_TYPE_TAGS });
  } catch (error) {
    if (!(error instanceof SteamError)) throw error;
    await sleep(error instanceof SteamRateLimitError ? RATE_LIMIT_RETRY_MS : TRANSIENT_RETRY_MS);
    return fetchSearchPage({ start, typeTags: TRACKED_TYPE_TAGS });
  }
}

async function finishCycle(
  cycleStartedAt: string,
  prevCycleStartedAt: string | null,
  cycleItems: number,
  totalCount: number,
): Promise<{ cleared: number; skipped: string | null }> {
  let cleared = 0;
  let skipped: string | null = null;

  if (!prevCycleStartedAt) {
    skipped = 'first completed cycle; vanished listings are cleared from the second one on';
  } else if (cycleItems < totalCount * MIN_CYCLE_COVERAGE) {
    skipped = `cycle only saw ${cycleItems} of ${totalCount} items`;
  } else {
    const [stale, listed] = await Promise.all([countListingsNotSeenSince(prevCycleStartedAt), countListedVariants()]);
    if (stale > Math.max(50, listed * MAX_SWEEP_SHARE)) {
      skipped = `${stale} of ${listed} listed variants were not seen in two cycles; too many to be real`;
    } else if (stale > 0) {
      cleared = await clearListingsNotSeenSince(prevCycleStartedAt);
    }
  }

  await setStates({
    [KEY.offset]: '0',
    [KEY.cycleItems]: '0',
    [KEY.cycleStartedAt]: '',
    [KEY.prevCycleStartedAt]: cycleStartedAt,
    [KEY.lastCycleCompletedAt]: new Date().toISOString(),
    [KEY.stuck]: '',
  });
  return { cleared, skipped };
}

export async function runListingScan(
  options: { maxPages?: number; budgetMs?: number; log?: (message: string) => void } = {},
): Promise<ListingScanResult> {
  const { maxPages = Infinity, budgetMs = 240_000, log = () => {} } = options;
  const deadline = Date.now() + budgetMs;

  const state = await getStates(Object.values(KEY));
  let offset = Number.parseInt(state[KEY.offset] ?? '0', 10) || 0;
  let cycleItems = Number.parseInt(state[KEY.cycleItems] ?? '0', 10) || 0;
  let cycleStartedAt = state[KEY.cycleStartedAt] || '';
  const prevCycleStartedAt = state[KEY.prevCycleStartedAt] || null;

  if (offset === 0 || !cycleStartedAt) {
    offset = 0;
    cycleItems = 0;
    cycleStartedAt = new Date().toISOString();
    await setStates({ [KEY.offset]: '0', [KEY.cycleItems]: '0', [KEY.cycleStartedAt]: cycleStartedAt });
  }

  const result: ListingScanResult = {
    pagesFetched: 0,
    itemsSeen: 0,
    pricesWritten: 0,
    unknownItems: 0,
    startOffset: offset,
    offset,
    totalCount: null,
    stoppedBy: 'max_pages',
    completedCycle: false,
    clearedUnlisted: 0,
    sweepSkipped: null,
    error: null,
  };

  log(`Scanning listings from offset ${offset}`);

  while (result.pagesFetched < maxPages) {
    if (Date.now() + PAGE_RESERVE_MS > deadline) {
      result.stoppedBy = 'budget';
      break;
    }

    let page: SearchPage;
    try {
      page = await fetchPageWithRetry(offset);
    } catch (error) {
      result.stoppedBy = error instanceof SteamRateLimitError ? 'rate_limited' : 'error';
      result.error = error instanceof Error ? error.message : String(error);
      break;
    }

    result.pagesFetched++;
    result.totalCount = page.totalCount;

    if (page.resultCount === 0) {
      if (offset >= page.totalCount) {
        result.completedCycle = true;
        result.stoppedBy = 'cycle_complete';
        break;
      }
      // Steam sometimes serves an empty page in the middle of the list. Leave
      // the offset alone so the next run retries it, but do not get stuck.
      let stuck: { offset: number; runs: number } = { offset, runs: 0 };
      try {
        const parsed = JSON.parse(state[KEY.stuck] || 'null');
        if (parsed && parsed.offset === offset) stuck = parsed;
      } catch {
        // unreadable marker: start counting again
      }
      stuck.runs++;
      if (stuck.runs >= MAX_STUCK_RUNS) {
        offset += 10;
        result.offset = offset;
        await setStates({ [KEY.offset]: String(offset), [KEY.stuck]: '' });
        log(`Empty page ${stuck.runs} runs in a row; stepping past it to offset ${offset}`);
      } else {
        await setStates({ [KEY.stuck]: JSON.stringify(stuck) });
      }
      result.stoppedBy = 'empty_page';
      result.error = `Steam returned an empty page at offset ${stuck.offset} of ${page.totalCount}`;
      break;
    }

    const saved = await saveListings(
      page.items.map((item) => ({
        marketHashName: item.marketHashName,
        priceCents: item.sellPriceCents,
        listings: item.sellListings,
      })),
    );
    result.pricesWritten += saved.written.length;
    result.unknownItems += saved.unknown.length;
    result.itemsSeen += page.resultCount;

    offset += page.resultCount;
    cycleItems += page.resultCount;
    result.offset = offset;
    await setStates({
      [KEY.offset]: String(offset),
      [KEY.cycleItems]: String(cycleItems),
      [KEY.totalCount]: String(page.totalCount),
    });
    log(`Page ${result.pagesFetched}: offset ${offset}/${page.totalCount} (+${saved.written.length} prices)`);

    if (offset >= page.totalCount) {
      result.completedCycle = true;
      result.stoppedBy = 'cycle_complete';
      break;
    }
  }

  if (result.completedCycle && result.totalCount != null) {
    const sweep = await finishCycle(cycleStartedAt, prevCycleStartedAt, cycleItems, result.totalCount);
    result.clearedUnlisted = sweep.cleared;
    result.sweepSkipped = sweep.skipped;
    log(`Cycle complete: ${cycleItems} items seen, ${sweep.cleared} vanished listings cleared`);
  }

  return result;
}

// Whether the run did its job, for the health record. Being rate-limited after
// making progress is normal; making no progress at all is not.
export function listingScanSucceeded(result: ListingScanResult): boolean {
  if (result.stoppedBy === 'error' || result.stoppedBy === 'empty_page') return false;
  return result.pagesFetched > 0 && (result.itemsSeen > 0 || result.completedCycle);
}
