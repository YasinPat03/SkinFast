// Keeps `last_sold_avg` fresh: for each skin, fetch Steam's listing-group page
// once and store the last-5-sold average of every variant on it.
//
// Runs in time-bounded slices (cron or CLI), taking the skins whose sale
// history is oldest first. A page takes 5-25 seconds to download, so a slice
// handles a few dozen skins and a full pass over ~1,900 skins takes hours;
// that is fine for a figure that moves slowly.
//
// A fetch that fails, a page that cannot be parsed, or a page in a currency
// that cannot be converted writes nothing. The skin is set aside for a few
// hours and the run reports the failure, so a breakage shows up in the job's
// health record instead of as silently empty data.

import { SteamRateLimitError } from '../steam/http';
import { PAGE_TIMEOUT_MS, fetchListingGroup } from '../steam/listing-page';
import { TRACKED_TYPE_TAGS, buildSearchQuery, fetchSearchPage } from '../steam/search';
import { syncListingGroup } from './group-sync';
import { getJsonState, setState } from './state';
import {
  type MarketItem,
  loadMarketItemByName,
  nextItemsForSales,
  pickCalibrationItem,
  pickGroupEntryVariant,
} from './store';

const SKIP_KEY = 'sales:skip';
// A skin that could not be read is not retried for this long.
const SKIP_MS = 6 * 60 * 60 * 1000;
// Time one more page may need: the download, its one retry, parsing and writes.
const FETCH_RESERVE_MS = 2 * PAGE_TIMEOUT_MS + 15_000;
// Stop a run after this many failures in a row: something is wrong with Steam
// or with the parser, and more requests will not fix it.
const MAX_CONSECUTIVE_FAILURES = 3;
const QUEUE_BATCH = 60;

export interface SalesScanResult {
  pagesFetched: number;
  // Skins whose sale history was written.
  itemsUpdated: number;
  salesWritten: number;
  unlistedMarked: number;
  // Pages that loaded but carried no market data.
  noData: number;
  // Pages in a currency no reliable USD rate could be found for.
  currencySkipped: number;
  failures: number;
  rateLimited: boolean;
  // True when the queue ran dry: nothing is older than the refresh window.
  caughtUp: boolean;
  lastError: string | null;
}

type SkipMap = Record<string, string>;

async function loadSkips(): Promise<SkipMap> {
  const stored = (await getJsonState<SkipMap>(SKIP_KEY)) ?? {};
  const cutoff = Date.now() - SKIP_MS;
  return Object.fromEntries(Object.entries(stored).filter(([, at]) => new Date(at).getTime() > cutoff));
}

// Read a skin's USD prices from search right now, so they are seconds apart
// from the listing page they are compared with.
async function liveUsdPrices(item: MarketItem): Promise<Map<string, number>> {
  const query = buildSearchQuery(item.weaponName, item.patternName);
  const page = await fetchSearchPage({ start: 0, query, typeTags: TRACKED_TYPE_TAGS });
  return new Map(page.items.map((entry) => [entry.marketHashName, entry.sellPriceCents]));
}

// Establish Steam's exchange rate for the currency its pages are arriving in,
// by reading one well-suited skin (several liquid variants above $20) both
// ways. Its sale history is stored as a by-product. Returns whether a rate
// was found; the rate itself lands in the store for syncListingGroup to use.
async function calibrateCurrency(log: (message: string) => void): Promise<boolean> {
  const name = await pickCalibrationItem();
  const item = name ? await loadMarketItemByName(name) : null;
  const entry = item ? pickGroupEntryVariant(item) : null;
  if (!item || !entry) return false;

  const live = await liveUsdPrices(item);
  const group = await fetchListingGroup(entry.marketHashName);
  const synced = await syncListingGroup(item, group, { liveUsdPrices: live });
  log(`Currency ${synced.currencyId}: ${synced.usdRate != null ? `rate ${synced.usdRate.toFixed(5)} read from ${item.name}` : `no clear rate from ${item.name}`}`);
  return synced.status === 'ok';
}

export async function runSalesScan(
  options: {
    budgetMs?: number;
    maxFetches?: number;
    staleHours?: number;
    concurrency?: number;
    log?: (message: string) => void;
  } = {},
): Promise<SalesScanResult> {
  const { budgetMs = 240_000, maxFetches = Infinity, staleHours = 24, concurrency = 2, log = () => {} } = options;
  const deadline = Date.now() + budgetMs;

  const result: SalesScanResult = {
    pagesFetched: 0,
    itemsUpdated: 0,
    salesWritten: 0,
    unlistedMarked: 0,
    noData: 0,
    currencySkipped: 0,
    failures: 0,
    rateLimited: false,
    caughtUp: false,
    lastError: null,
  };

  const skips = await loadSkips();
  const queue: string[] = [];
  // Every name handed out or queued in this run, so workers never share one.
  const seen = new Set<string>();
  let queueExhausted = false;
  let refill: Promise<void> | null = null;
  let started = 0;
  let consecutiveFailures = 0;
  let stop = false;
  let calibration: Promise<boolean> | null = null;

  const nextName = async (): Promise<string | null> => {
    while (queue.length === 0 && !queueExhausted) {
      refill ??= (async () => {
        const names = await nextItemsForSales({
          limit: QUEUE_BATCH,
          olderThanHours: staleHours,
          exclude: [...Object.keys(skips), ...seen],
        });
        if (names.length < QUEUE_BATCH) queueExhausted = true;
        for (const name of names) {
          if (seen.has(name)) continue;
          seen.add(name);
          queue.push(name);
        }
      })().finally(() => {
        refill = null;
      });
      await refill;
    }
    return queue.shift() ?? null;
  };

  const worker = async (): Promise<void> => {
    while (!stop && Date.now() + FETCH_RESERVE_MS <= deadline) {
      const name = await nextName();
      if (!name) {
        result.caughtUp = queueExhausted;
        return;
      }
      if (stop || started >= maxFetches) return;
      started++;

      const item = await loadMarketItemByName(name);
      const entry = item ? pickGroupEntryVariant(item) : null;
      if (!item || !entry) {
        // Its last listing sold since the queue was built; nothing to fetch.
        started--;
        skips[name] = new Date().toISOString();
        continue;
      }

      try {
        const group = await fetchListingGroup(entry.marketHashName);
        result.pagesFetched++;

        let synced = await syncListingGroup(item, group);
        if (synced.status === 'currency_unknown') {
          // One calibration per run, shared by both workers.
          calibration ??= calibrateCurrency(log);
          if (await calibration) synced = await syncListingGroup(item, group);
        }

        result.unlistedMarked += synced.unlistedMarked.length;
        if (synced.status === 'ok') {
          result.itemsUpdated++;
          result.salesWritten += synced.salesWritten.length;
          consecutiveFailures = 0;
          log(`${name}: ${synced.salesWritten.length} variants${synced.usdRate !== 1 ? ` (currency ${synced.currencyId} x${synced.usdRate?.toFixed(5)})` : ''}`);
        } else {
          if (synced.status === 'no_data') result.noData++;
          else result.currencySkipped++;
          skips[name] = new Date().toISOString();
          log(`${name}: skipped (${synced.status})`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.lastError = `${name}: ${message}`;
        if (error instanceof SteamRateLimitError) {
          result.rateLimited = true;
          stop = true;
          log(`Rate limited by Steam; stopping this run.`);
          return;
        }
        result.failures++;
        skips[name] = new Date().toISOString();
        log(`${name}: failed (${message})`);
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stop = true;
          return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  await setState(SKIP_KEY, JSON.stringify(skips));
  return result;
}

// Whether the run did its job, for the health record: it wrote sale history,
// or there was genuinely nothing due.
export function salesScanSucceeded(result: SalesScanResult): boolean {
  if (result.itemsUpdated > 0) return true;
  return result.caughtUp && result.failures === 0 && result.currencySkipped === 0;
}

export function salesScanError(result: SalesScanResult): string | null {
  if (salesScanSucceeded(result)) return null;
  if (result.rateLimited) return 'Rate limited by Steam before any sale history could be read';
  if (result.lastError) return result.lastError;
  if (result.currencySkipped > 0) return 'Pages were not in USD and no reliable conversion rate was available';
  if (result.noData > 0) return 'Steam returned pages without market data';
  return 'No sale history could be read';
}
