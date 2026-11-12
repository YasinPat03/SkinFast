// Steam's market listing page for one item. Requesting any *listed* variant
// redirects to the item's "bucket group" page, whose embedded data carries, for
// every wear / StatTrak / Souvenir variant of the skin at once:
//   - the lowest active listing (0 when nothing is listed), and
//   - the full sale history.
// It is the only login-free source of individual sales.
//
// Things that have bitten this code before, and how this version handles them:
//  - Steam has moved the embedded data twice (inline `line1` array, then
//    `window.SSR.renderContext`, now a `valve-ssr-data` JSON script). A page
//    that cannot be parsed raises SteamFormatError; it is never read as "this
//    item has no sales".
//  - Prices come in the currency of the caller's country. The currency id is
//    returned so the caller can convert or skip; nothing here assumes USD.
//  - A variant with no active listing does not redirect and carries no data,
//    so always ask through a listed variant.
//  - The page is 1.5-4.5 MB and can take 20+ seconds to arrive.

import { SteamFormatError, SteamHttpError, encodeMarketName, steamText } from './http';

const LISTING_URL = 'https://steamcommunity.com/market/listings/730/';

// Steam's id for US dollars.
export const USD_CURRENCY_ID = 1;

// Longest one download may take. Callers that run inside a time limit budget
// for two of these (the request plus its one retry).
export const PAGE_TIMEOUT_MS = 45_000;

export interface SaleBucket {
  // Start of the hour (recent) or day (older) the sales happened in.
  time: number;
  // Median sale price in that period, in whole currency units (e.g. dollars).
  price: number;
  // Number of sales in that period.
  count: number;
}

export interface ListingBucket {
  marketHashName: string;
  // Lowest active listing in the page currency's minor units; 0 = not listed.
  minPriceMinor: number;
}

export interface ListingGroup {
  // False when the page loaded but carried no market data at all, which is what
  // Steam serves for a variant with no active listing.
  hasMarketData: boolean;
  groupId: string | null;
  // Steam currency id of every price on the page; null when it has no prices.
  currencyId: number | null;
  buckets: ListingBucket[];
  histories: Map<string, SaleBucket[]>;
}

interface Query {
  queryKey?: unknown;
  state?: { data?: unknown };
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SteamFormatError(`Listing page: ${what} is not valid JSON`);
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Pull the page's server-rendered state out of the HTML, whichever of the two
// known layouts it uses.
function extractState(html: string): { loaders: unknown[]; queries: Query[] } {
  const script = html.match(/<script[^>]*\bid="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/);
  let renderContext: Record<string, unknown> | null = null;
  let loaders: unknown[] = [];

  if (script) {
    const root = asObject(parseJson(script[1], 'valve-ssr-data'));
    if (!root) throw new SteamFormatError('Listing page: valve-ssr-data is not an object');
    renderContext = asObject(root.renderContext);
    if (Array.isArray(root.loaderData)) {
      loaders = root.loaderData.map((entry) => (typeof entry === 'string' ? parseJson(entry, 'loaderData entry') : entry));
    }
  } else {
    // Layout used until late 2026.
    const legacy = html.match(/window\.SSR\.renderContext\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
    if (!legacy) throw new SteamFormatError('Listing page has no embedded data block');
    const inner = parseJson(`"${legacy[1]}"`, 'renderContext string');
    renderContext = typeof inner === 'string' ? asObject(parseJson(inner, 'renderContext')) : null;
  }

  if (!renderContext || typeof renderContext.queryData !== 'string') {
    throw new SteamFormatError('Listing page: renderContext.queryData is missing');
  }
  const queryData = asObject(parseJson(renderContext.queryData, 'queryData'));
  if (!queryData || !Array.isArray(queryData.queries)) {
    throw new SteamFormatError('Listing page: queryData.queries is missing');
  }
  return { loaders, queries: queryData.queries as Query[] };
}

export function parseListingGroupHtml(html: string): ListingGroup {
  const { loaders, queries } = extractState(html);

  const buckets: ListingBucket[] = [];
  const bucketLoader = loaders.map(asObject).find((loader) => loader && Array.isArray(loader.buckets));
  if (bucketLoader) {
    for (const raw of bucketLoader.buckets as unknown[]) {
      const bucket = asObject(raw);
      const name = bucket?.bucket_id;
      const minPrice = Number(bucket?.min_price);
      if (typeof name !== 'string' || !Number.isFinite(minPrice) || minPrice < 0) {
        throw new SteamFormatError('Listing page: a bucket is missing bucket_id or min_price');
      }
      buckets.push({ marketHashName: name, minPriceMinor: Math.round(minPrice) });
    }
  }

  const histories = new Map<string, SaleBucket[]>();
  const currencies = new Set<number>();

  for (const query of queries) {
    const key = query.queryKey;
    if (!Array.isArray(key)) continue;

    const data = asObject(query.state?.data);
    if (key[0] === 'market' && key[1] === 'orderbook' && data && typeof data.eCurrency === 'number') {
      currencies.add(data.eCurrency);
    }

    if (key[0] !== 'market' || key[1] !== 'pricehistory' || typeof key[3] !== 'string') continue;
    // A history query that has not resolved says nothing about the item.
    if (!data) continue;
    if (typeof data.ecurrency !== 'number' || !Array.isArray(data.prices)) {
      throw new SteamFormatError(`Listing page: price history for "${key[3]}" has an unexpected shape`);
    }
    currencies.add(data.ecurrency);

    const sales: SaleBucket[] = [];
    for (const raw of data.prices as unknown[]) {
      const entry = asObject(raw);
      const time = entry?.time;
      const price = entry?.price_median;
      const count = entry?.purchases;
      if (typeof time !== 'number' || typeof price !== 'number' || typeof count !== 'number') {
        throw new SteamFormatError(`Listing page: a sale of "${key[3]}" has an unexpected shape`);
      }
      if (price > 0 && count > 0) sales.push({ time, price, count });
    }
    histories.set(key[3], sales);
  }

  if (currencies.size > 1) {
    throw new SteamFormatError(`Listing page mixes currencies (${[...currencies].join(', ')})`);
  }

  return {
    hasMarketData: buckets.length > 0 || histories.size > 0,
    groupId: null,
    currencyId: currencies.size === 1 ? [...currencies][0] : null,
    buckets,
    histories,
  };
}

export async function fetchListingGroup(marketHashName: string): Promise<ListingGroup> {
  const request = () =>
    steamText(`${LISTING_URL}${encodeMarketName(marketHashName)}`, { accept: 'html', timeoutMs: PAGE_TIMEOUT_MS });

  let page: { text: string; url: string };
  try {
    page = await request();
  } catch (error) {
    // This page answers HTTP 500 now and then for no visible reason and works
    // on the next attempt, so a server error gets one retry.
    if (!(error instanceof SteamHttpError) || error.status == null || error.status < 500) throw error;
    page = await request();
  }
  const { text, url } = page;
  const group = parseListingGroupHtml(text);
  const lastSegment = url.split('?')[0].split('/').pop() ?? '';
  group.groupId = /^G[0-9A-F]+$/i.test(lastSegment) ? lastSegment : null;
  return group;
}
