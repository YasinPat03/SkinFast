// On-demand refresh of one skin, triggered from its page when the stored data
// is old. Two sources, each used for what it is exact at:
//   1. a market search for the skin  -> USD listing prices of every variant
//   2. the skin's listing-group page -> sale history of every variant, and an
//                                       authoritative "no active listing" flag
//
// The result says what was actually written, so the page can never claim
// "prices updated" when nothing was.

import { SteamRateLimitError } from '../steam/http';
import { fetchListingGroup } from '../steam/listing-page';
import { type SearchItem, TRACKED_TYPE_TAGS, buildSearchQuery, fetchSearchPage } from '../steam/search';
import { invalidateCatalog } from '../tradeup/catalog-db';
import { syncListingGroup } from './group-sync';
import { loadMarketItem, markUnlisted, pickGroupEntryVariant, saveListings } from './store';

// Steam serves 10 results per page; the largest skin has 15 variants, so this
// covers a skin plus loosely matched neighbours. Unpainted knives match every
// finish of the knife and can exceed it; the listing page covers those.
const MAX_QUERY_PAGES = 4;

// Sale history read more recently than this is not fetched again.
const SALES_FRESH_MS = 12 * 60 * 60 * 1000;

export type SkinRefreshStatus = 'ok' | 'no_results' | 'rate_limited' | 'error' | 'not_found';

export interface SkinRefreshResult {
  status: SkinRefreshStatus;
  query: string;
  // Market names of this skin's variants.
  requested: string[];
  // Names whose listing price was written (may include neighbours found by the search).
  updated: string[];
  // Requested names confirmed to have no active listing right now.
  missing: string[];
  // Names whose sale history was written.
  last_sold_updated: string[];
  // True when the search was read to the end.
  complete: boolean;
  // Anything that did not go as planned, in plain words.
  notes: string[];
}

async function searchSkin(query: string, result: SkinRefreshResult): Promise<SearchItem[]> {
  const wanted = new Set(result.requested);
  const found: SearchItem[] = [];
  let start = 0;

  try {
    for (let page = 0; page < MAX_QUERY_PAGES; page++) {
      const response = await fetchSearchPage({ start, query, typeTags: TRACKED_TYPE_TAGS });
      found.push(...response.items);
      start += response.resultCount;
      if (response.resultCount === 0 || start >= response.totalCount) {
        result.complete = true;
        break;
      }
      // Everything this skin has is already in hand; later pages are neighbours.
      if ([...wanted].every((name) => found.some((entry) => entry.marketHashName === name))) break;
    }
  } catch (error) {
    if (error instanceof SteamRateLimitError) {
      result.status = 'rate_limited';
      result.notes.push('Steam rate-limited the price search.');
    } else {
      result.status = 'error';
      result.notes.push(`Price search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return found;
}

export async function refreshSkin(skinId: string): Promise<SkinRefreshResult> {
  const result: SkinRefreshResult = {
    status: 'ok',
    query: '',
    requested: [],
    updated: [],
    missing: [],
    last_sold_updated: [],
    complete: false,
    notes: [],
  };

  const item = await loadMarketItem(skinId);
  if (!item) return { ...result, status: 'not_found' };

  result.requested = item.variants.map((variant) => variant.marketHashName);
  result.query = buildSearchQuery(item.weaponName, item.patternName);

  // 1. Listing prices from search.
  const found = await searchSkin(result.query, result);
  const saved = await saveListings(
    found.map((entry) => ({
      marketHashName: entry.marketHashName,
      priceCents: entry.sellPriceCents,
      listings: entry.sellListings,
    })),
  );
  result.updated = saved.written;
  const livePrices = new Map(found.map((entry) => [entry.marketHashName, entry.sellPriceCents]));
  const requestedFound = result.requested.filter((name) => livePrices.has(name));

  // Search only returns listed items, so when it was read to the end and did
  // find this skin, a variant it did not return has no active listing. If it
  // found nothing of the skin, the query may simply not have matched, and
  // nothing is concluded.
  if (result.complete && requestedFound.length > 0) {
    result.missing = await markUnlisted(result.requested.filter((name) => !livePrices.has(name)));
  }

  // 2. Sale history (and unlisted flags) from the listing-group page.
  const salesStale = item.variants.some(
    (variant) => variant.salesCheckedAt == null || Date.now() - variant.salesCheckedAt.getTime() > SALES_FRESH_MS,
  );
  const entryName =
    requestedFound.find((name) => !name.includes('Souvenir') && !name.includes('StatTrak')) ??
    requestedFound[0] ??
    pickGroupEntryVariant(item)?.marketHashName;

  if (result.status !== 'rate_limited' && entryName && (salesStale || !result.complete)) {
    try {
      const group = await fetchListingGroup(entryName);
      const synced = await syncListingGroup(item, group, {
        liveUsdPrices: livePrices,
        // Variants the search could not reach are priced from the page instead.
        convertListingsFor: result.complete ? undefined : new Set(result.requested.filter((name) => !livePrices.has(name))),
      });
      result.last_sold_updated = synced.salesWritten;
      result.updated = [...new Set([...result.updated, ...synced.listingsWritten])];
      result.missing = [...new Set([...result.missing, ...synced.unlistedMarked])].filter((name) =>
        result.requested.includes(name),
      );
      if (synced.status === 'no_data') result.notes.push('Steam returned no sale history for this skin.');
      if (synced.status === 'currency_unknown') {
        result.notes.push('Sale history was in a currency that could not be converted to USD reliably; it was not stored.');
      }
    } catch (error) {
      if (error instanceof SteamRateLimitError) {
        result.notes.push('Steam rate-limited the sale history request.');
        if (result.updated.length === 0) result.status = 'rate_limited';
      } else {
        result.notes.push(`Sale history could not be read: ${error instanceof Error ? error.message : String(error)}`);
        if (result.updated.length === 0 && result.status === 'ok') result.status = 'error';
      }
    }
  }

  const wroteSomething = result.updated.length > 0 || result.missing.length > 0 || result.last_sold_updated.length > 0;
  if (result.status === 'ok' && !wroteSomething) result.status = 'no_results';
  if (wroteSomething) invalidateCatalog();
  return result;
}
