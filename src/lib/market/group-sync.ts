// Writes what one Steam listing-group page says about an item into the
// database: sale history for every variant, which variants have no listing,
// and (when the page is in USD) the listing prices themselves.
//
// The rule this module exists to enforce: only write what the page actually
// established. A page with no data, or in a currency that cannot be converted
// reliably, changes nothing.

import { type ListingGroup, USD_CURRENCY_ID } from '../steam/listing-page';
import { summarizeRecentSales } from '../steam/sales';
import { type FxPair, deriveUsdRate } from './fx';
import { getStoredUsdRate, storeUsdRate } from './fx-store';
import {
  type MarketItem,
  type SaleQuote,
  loadListingPrices,
  markUnlisted,
  saveListings,
  saveSales,
} from './store';

export type GroupSyncStatus =
  // Sale history was written.
  | 'ok'
  // The page carried no market data (Steam serves that for an unlisted variant).
  | 'no_data'
  // The page is not in USD and no trustworthy conversion rate is available.
  | 'currency_unknown';

export interface GroupSyncResult {
  status: GroupSyncStatus;
  currencyId: number | null;
  // USD cents per minor unit of the page currency (1 for a USD page).
  usdRate: number | null;
  salesWritten: string[];
  unlistedMarked: string[];
  listingsWritten: string[];
}

// Smallest/largest plausible ratio between an item's latest sale and its
// lowest listing. Outside it, the page's amounts are not in the units assumed
// (hundredths of the currency), and converting them would be wrong by orders
// of magnitude.
const SCALE_CHECK_MIN = 0.1;
const SCALE_CHECK_MAX = 10;

function scaleLooksRight(group: ListingGroup): boolean {
  const ratios: number[] = [];
  for (const bucket of group.buckets) {
    if (bucket.minPriceMinor <= 0) continue;
    const recent = summarizeRecentSales(group.histories.get(bucket.marketHashName) ?? [], 1);
    if (recent) ratios.push((recent.averagePrice * 100) / bucket.minPriceMinor);
  }
  if (ratios.length === 0) return true; // nothing to check against
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  return median >= SCALE_CHECK_MIN && median <= SCALE_CHECK_MAX;
}

async function resolveUsdRate(group: ListingGroup, liveUsdPrices: Map<string, number> | undefined): Promise<number | null> {
  if (group.currencyId == null) return null;
  if (group.currencyId === USD_CURRENCY_ID) return 1;
  if (!scaleLooksRight(group)) return null;

  const listed = group.buckets.filter((bucket) => bucket.minPriceMinor > 0);
  const usdPrices = new Map(await loadListingPrices(listed.map((bucket) => bucket.marketHashName)));
  // Prices read from Steam seconds ago beat whatever the last scan stored.
  for (const [name, cents] of liveUsdPrices ?? []) usdPrices.set(name, cents);

  const pairs: FxPair[] = [];
  for (const bucket of listed) {
    const usdCents = usdPrices.get(bucket.marketHashName);
    if (usdCents != null) pairs.push({ usdCents, localMinor: bucket.minPriceMinor });
  }

  // A rate read off this very page is the most current one there is. Pages of
  // cheap items cannot give one, and fall back to the last rate that was found.
  const derived = deriveUsdRate(pairs);
  if (derived != null) {
    await storeUsdRate(group.currencyId, derived);
    return derived;
  }
  return (await getStoredUsdRate(group.currencyId))?.rate ?? null;
}

export async function syncListingGroup(
  item: MarketItem,
  group: ListingGroup,
  options: { liveUsdPrices?: Map<string, number>; convertListingsFor?: Set<string> } = {},
): Promise<GroupSyncResult> {
  const result: GroupSyncResult = {
    status: 'no_data',
    currencyId: group.currencyId,
    usdRate: null,
    salesWritten: [],
    unlistedMarked: [],
    listingsWritten: [],
  };
  if (!group.hasMarketData) return result;

  // A bucket with no lowest price has no active listing. That holds whatever
  // currency the page is in.
  const unlisted = group.buckets.filter((bucket) => bucket.minPriceMinor === 0).map((bucket) => bucket.marketHashName);
  result.unlistedMarked = await markUnlisted(unlisted);

  const usdRate = await resolveUsdRate(group, options.liveUsdPrices);
  result.usdRate = usdRate;
  if (usdRate == null) {
    result.status = 'currency_unknown';
    return result;
  }

  const sales: SaleQuote[] = [];
  for (const [marketHashName, history] of group.histories) {
    const recent = summarizeRecentSales(history);
    sales.push({
      marketHashName,
      avgCents: recent ? Math.round(recent.averagePrice * 100 * usdRate) : null,
      sampleCount: recent?.sampleCount ?? 0,
      lastSaleAt: recent?.lastSaleAt ?? null,
    });
  }

  // Variants in our metadata that Steam's group does not have at all were
  // never on the market (e.g. a souvenir wear that was never dropped). Record
  // that, so they stop counting as "not read yet" - unless a scan saw them
  // listed, in which case the two sources disagree and nothing is concluded.
  if (group.buckets.length > 0) {
    const onPage = new Set([...group.buckets.map((bucket) => bucket.marketHashName), ...group.histories.keys()]);
    for (const variant of item.variants) {
      if (onPage.has(variant.marketHashName) || variant.listed) continue;
      sales.push({ marketHashName: variant.marketHashName, avgCents: null, sampleCount: 0, lastSaleAt: null });
    }
  }
  result.salesWritten = await saveSales(sales);

  // On a USD page the lowest listings are exact, so take them as a free price
  // refresh. On any other page a converted price is within a fraction of a
  // percent, which is only worth storing for variants the caller could not
  // price through search (`convertListingsFor`).
  const exact = group.currencyId === USD_CURRENCY_ID;
  const saved = await saveListings(
    group.buckets
      .filter(
        (bucket) => bucket.minPriceMinor > 0 && (exact || options.convertListingsFor?.has(bucket.marketHashName)),
      )
      .map((bucket) => ({
        marketHashName: bucket.marketHashName,
        priceCents: Math.max(1, Math.round(bucket.minPriceMinor * usdRate)),
        listings: null,
      })),
  );
  result.listingsWritten = saved.written;

  result.status = 'ok';
  return result;
}
