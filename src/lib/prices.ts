import sql from './db';

const PRICE_OVERVIEW_URL = 'https://steamcommunity.com/market/priceoverview/';
const MARKET_LISTING_URL = 'https://steamcommunity.com/market/listings/730/';
const MAX_REQUESTS_PER_MINUTE = 20;
const MIN_INTERVAL_MS = (60 / MAX_REQUESTS_PER_MINUTE) * 1000; // 3s between requests

let lastRequestTime = 0;

function parsePriceString(priceStr: string): number | null {
  // Handles "$13.07", "€12.50", "£10.00", etc.
  const cleaned = priceStr.replace(/[^0-9.,]/g, '').replace(',', '.');
  const value = parseFloat(cleaned);
  if (isNaN(value)) return null;
  return Math.round(value * 100); // Convert to cents
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

interface PriceOverviewResponse {
  success: boolean;
  lowest_price?: string;
  median_price?: string;
  volume?: string;
}

// Steam's internal currency IDs. 1=USD, 20=CAD, etc. The SSR'd page returns
// prices in the currency Steam geolocates from the request IP; Vercel cron
// hits Steam from US-East, so production sees USD. From a non-US IP, we get
// other currencies and skip the write to avoid polluting the DB.
const STEAM_USD_CURRENCY_ID = 1;

interface PriceHistoryEntry {
  time: number;          // Unix seconds
  price_median: number;  // In the currency's main unit (e.g. dollars), not cents
  purchases: number;     // Number of sales in this bucket
}

interface ParsedPriceHistory {
  ecurrency: number;
  prices: PriceHistoryEntry[];
}

// The post-overhaul listing page embeds React Query's hydration state under
// `window.SSR.renderContext = JSON.parse("…")`. That object contains a
// `queryData` JSON-string with one entry per SSR'd query, including a
// `["market","pricehistory",730,<market_hash_name>]` query whose data has the
// full price history. Crucially, the page renders the wear/StatTrak variant
// selector, so a single fetch contains the pricehistory for ALL sibling
// variants of the skin (e.g. fetching the FT page yields FN/MW/FT/WW/BS plus
// their StatTrak counterparts). This returns every history keyed by
// market_hash_name so one fetch can populate the whole family at once.
function parseAllHistoriesFromHtml(html: string): Map<string, ParsedPriceHistory> {
  const result = new Map<string, ParsedPriceHistory>();
  const match = html.match(/window\.SSR\.renderContext\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
  if (!match) return result;

  // The capture is the inner content of a JS string literal. Re-quoting and
  // running it through JSON.parse unescapes it to the underlying JSON, which
  // we then parse to get the renderContext object.
  let queryData: { queries?: Array<{ queryKey?: unknown[]; state?: { data?: unknown } }> };
  try {
    const renderContextJson = JSON.parse(`"${match[1]}"`) as string;
    const renderContext = JSON.parse(renderContextJson) as { queryData?: string };
    if (!renderContext.queryData) return result;
    queryData = JSON.parse(renderContext.queryData);
  } catch {
    return result;
  }

  for (const query of queryData.queries ?? []) {
    const key = query.queryKey;
    if (
      !Array.isArray(key) ||
      key.length < 4 ||
      key[1] !== 'pricehistory' ||
      typeof key[3] !== 'string'
    ) {
      continue;
    }
    const data = query.state?.data as { ecurrency?: number; prices?: PriceHistoryEntry[] } | null | undefined;
    if (!data || !Array.isArray(data.prices) || typeof data.ecurrency !== 'number') {
      continue;
    }
    result.set(key[3], { ecurrency: data.ecurrency, prices: data.prices });
  }

  return result;
}

function parseHistoryFromHtml(html: string, marketHashName: string): ParsedPriceHistory | null {
  return parseAllHistoriesFromHtml(html).get(marketHashName) ?? null;
}

function parseLatestSaleFromHistoryHtml(html: string, marketHashName: string): number | null {
  const parsed = parseHistoryFromHtml(html, marketHashName);
  if (!parsed || parsed.ecurrency !== STEAM_USD_CURRENCY_ID) return null;
  const latest = parsed.prices[parsed.prices.length - 1];
  if (!latest || !Number.isFinite(latest.price_median)) return null;
  return Math.round(latest.price_median * 100);
}

// Walks the history backward, accumulating sales weighted by their bucket
// `purchases` count, until we have at least 5 sales (or run out). Returns the
// weighted average in cents.
function computeLastFiveAvg(
  history: PriceHistoryEntry[]
): { avg_cents: number; sample_count: number; last_sale_at: string | null } | null {
  let totalSales = 0;
  let weightedSum = 0;
  let lastSaleAt: string | null = null;

  for (let i = history.length - 1; i >= 0 && totalSales < 5; i--) {
    const { time, price_median, purchases } = history[i];
    if (!Number.isFinite(price_median) || !Number.isFinite(purchases) || purchases <= 0) continue;
    if (lastSaleAt === null && Number.isFinite(time)) {
      lastSaleAt = new Date(time * 1000).toISOString();
    }
    const take = Math.min(purchases, 5 - totalSales);
    weightedSum += price_median * take;
    totalSales += take;
  }

  if (totalSales === 0) return null;
  return {
    avg_cents: Math.round((weightedSum / totalSales) * 100),
    sample_count: totalSales,
    last_sale_at: lastSaleAt,
  };
}

async function fetchLatestSaleFromListingPage(marketHashName: string): Promise<number | null> {
  const encodedName = encodeURIComponent(marketHashName);
  const res = await fetch(`${MARKET_LISTING_URL}${encodedName}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    console.warn(`HTTP ${res.status} fetching listing page for ${marketHashName}`);
    return null;
  }

  const html = await res.text();
  return parseLatestSaleFromHistoryHtml(html, marketHashName);
}

export async function refreshSinglePrice(marketHashName: string): Promise<{
  lowest_price_cents: number | null;
  median_price_cents: number | null;
  volume: number | null;
} | null> {
  await throttle();

  const params = new URLSearchParams({
    appid: '730',
    currency: '1', // USD
    market_hash_name: marketHashName,
  });

  const res = await fetch(`${PRICE_OVERVIEW_URL}?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.status === 429) {
    console.warn(`Rate limited fetching price for ${marketHashName}`);
    return null;
  }

  if (!res.ok) {
    console.warn(`HTTP ${res.status} fetching price for ${marketHashName}`);
    return null;
  }

  const text = await res.text();
  let data: PriceOverviewResponse;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`Invalid JSON for ${marketHashName}: ${text.slice(0, 200)}`);
    return null;
  }

  if (!data.success) {
    console.warn(`Steam returned success=false for ${marketHashName}`);
    return null;
  }

  const lowest = data.lowest_price ? parsePriceString(data.lowest_price) : null;
  let median = data.median_price ? parsePriceString(data.median_price) : null;
  const volume = data.volume ? parseInt(data.volume.replace(',', ''), 10) : null;

  // Some rare/unlisted items return success=true with no price fields from priceoverview,
  // but the market listing page still embeds recent sale history we can fall back to.
  if (lowest == null && median == null) {
    median = await fetchLatestSaleFromListingPage(marketHashName);
  }

  // Upsert into database
  await sql`
    INSERT INTO prices (market_hash_name, lowest_price_cents, median_price_cents, volume, sell_listings, updated_at)
    VALUES (${marketHashName}, ${lowest}, ${median}, ${volume}, NULL, NOW())
    ON CONFLICT (market_hash_name) DO UPDATE SET
      lowest_price_cents = EXCLUDED.lowest_price_cents,
      median_price_cents = EXCLUDED.median_price_cents,
      volume = EXCLUDED.volume,
      updated_at = NOW()
  `;

  return { lowest_price_cents: lowest, median_price_cents: median, volume };
}

interface LastSoldAvgRow {
  market_hash_name: string;
  avg_last5_cents: number | null;
  sample_count: number | null;
  last_sale_at: string | null;
}

// Batched upsert. `updated_at` uses its DEFAULT NOW() on insert and is bumped
// explicitly on conflict, so the staleness filter in runLastSoldAvgChunk works
// for both new and refreshed rows.
async function upsertLastSoldAvg(rows: LastSoldAvgRow[]): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO last_sold_avg ${sql(rows, 'market_hash_name', 'avg_last5_cents', 'sample_count', 'last_sale_at')}
    ON CONFLICT (market_hash_name) DO UPDATE SET
      avg_last5_cents = EXCLUDED.avg_last5_cents,
      sample_count = EXCLUDED.sample_count,
      last_sale_at = EXCLUDED.last_sale_at,
      updated_at = NOW()
  `;
}

// Fetches a single market listing page and upserts the volume-weighted average
// of the last 5 individual sales for EVERY sibling variant embedded in that
// page (all wears + StatTrak), not just `marketHashName`. One fetch therefore
// populates the whole skin family, cutting the request count (the throttled,
// rate-limited bottleneck) by ~8x versus fetching one page per variant.
//
// Returns the set of market_hash_names it wrote (so callers can skip siblings
// already covered) and the computed result for the requested variant.
export async function refreshLastSoldAvgGroup(marketHashName: string): Promise<{
  written: string[];
  requested: { avg_last5_cents: number; sample_count: number; last_sale_at: string | null } | null;
}> {
  await throttle();

  const encodedName = encodeURIComponent(marketHashName);
  const res = await fetch(`${MARKET_LISTING_URL}${encodedName}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Don't write anything on a rate-limit; let the row stay stale and retry next run.
  if (res.status === 429) {
    console.warn(`Rate limited fetching listing page for ${marketHashName}`);
    return { written: [], requested: null };
  }

  if (!res.ok) {
    console.warn(`HTTP ${res.status} fetching listing page for ${marketHashName}`);
    // Sentinel for the requested variant so the cron doesn't hammer it every run.
    await upsertLastSoldAvg([{ market_hash_name: marketHashName, avg_last5_cents: null, sample_count: null, last_sale_at: null }]);
    return { written: [marketHashName], requested: null };
  }

  const html = await res.text();
  const histories = parseAllHistoriesFromHtml(html);

  // Steam geolocates currency from the request IP. From a non-US IP every
  // variant on the page comes back in CAD/EUR/etc., which would corrupt a
  // column the rest of the app treats as USD cents. Skip the whole page and
  // leave the rows stale; the next run from a US IP (Vercel cron) fixes it.
  for (const h of histories.values()) {
    if (h.ecurrency !== STEAM_USD_CURRENCY_ID) {
      console.warn(
        `Skipping page for ${marketHashName}: Steam returned ecurrency=${h.ecurrency} (need ${STEAM_USD_CURRENCY_ID} for USD). Run from a US IP.`
      );
      return { written: [], requested: null };
    }
  }

  // Only write variants we actually track — last_sold_avg has an FK to
  // skin_variants, and the page may list variants we don't store. Always
  // include the requested name so a history-less page still leaves a sentinel.
  const names = [...histories.keys()];
  if (!names.includes(marketHashName)) names.push(marketHashName);
  const tracked = await sql<{ market_hash_name: string }[]>`
    SELECT market_hash_name FROM skin_variants WHERE market_hash_name = ANY(${names})
  `;

  const rows: LastSoldAvgRow[] = [];
  let requested: { avg_last5_cents: number; sample_count: number; last_sale_at: string | null } | null = null;

  for (const { market_hash_name } of tracked) {
    const parsed = histories.get(market_hash_name);
    const result = parsed ? computeLastFiveAvg(parsed.prices) : null;
    rows.push({
      market_hash_name,
      avg_last5_cents: result ? result.avg_cents : null,
      sample_count: result ? result.sample_count : null,
      last_sale_at: result ? result.last_sale_at : null,
    });
    if (market_hash_name === marketHashName && result) {
      requested = { avg_last5_cents: result.avg_cents, sample_count: result.sample_count, last_sale_at: result.last_sale_at };
    }
  }

  await upsertLastSoldAvg(rows);
  return { written: rows.map((r) => r.market_hash_name), requested };
}

// Backward-compatible single-variant wrapper. Fetches the page (which also
// fills the variant's siblings) and returns just the requested variant's result.
export async function refreshLastSoldAvg(marketHashName: string): Promise<{
  avg_last5_cents: number;
  sample_count: number;
  last_sale_at: string | null;
} | null> {
  const { requested } = await refreshLastSoldAvgGroup(marketHashName);
  return requested;
}

// Process one chunk of variants needing a last-sold-avg refresh. Shared by the
// CLI script and the Vercel cron route so both follow the same incremental
// pattern. Because one listing-page fetch fills every sibling variant, we cap
// work by number of FETCHES (the rate-limited resource), over-selecting
// candidates and skipping any variant a prior fetch in this run already wrote.
export async function runLastSoldAvgChunk(opts: {
  batchSize: number;
  staleHours: number;
}): Promise<{ fetches: number; rowsWritten: number; withData: number; noData: number }> {
  const { batchSize, staleHours } = opts;

  // One fetch clears up to ~10 sibling variants, so pull well beyond batchSize
  // candidates to keep `batchSize` distinct pages worth of work available.
  const candidates = await sql<{ market_hash_name: string }[]>`
    SELECT sv.market_hash_name
    FROM skin_variants sv
    LEFT JOIN last_sold_avg l ON sv.market_hash_name = l.market_hash_name
    WHERE l.market_hash_name IS NULL
       OR l.updated_at < NOW() - (${staleHours} || ' hours')::INTERVAL
    ORDER BY l.updated_at NULLS FIRST, sv.market_hash_name
    LIMIT ${batchSize * 15}
  `;

  const processed = new Set<string>();
  let fetches = 0;
  let rowsWritten = 0;
  let withData = 0;
  let noData = 0;

  for (const { market_hash_name } of candidates) {
    if (fetches >= batchSize) break;
    if (processed.has(market_hash_name)) continue;

    try {
      const { written, requested } = await refreshLastSoldAvgGroup(market_hash_name);
      fetches++;
      rowsWritten += written.length;
      for (const w of written) processed.add(w);
      processed.add(market_hash_name);
      if (requested) withData++;
      else noData++;
    } catch (err) {
      noData++;
      processed.add(market_hash_name);
      console.warn(`error on ${market_hash_name}: ${err}`);
    }
  }

  return { fetches, rowsWritten, withData, noData };
}

// Treat variants with no listing and no last-sold price as stale so they can be retried immediately.
export function isPriceStale(
  updatedAt: string | null,
  maxAgeHours: number = 6,
  lowestPriceCents: number | null = null,
  medianPriceCents: number | null = null
): boolean {
  if (lowestPriceCents == null && medianPriceCents == null) return true;
  if (!updatedAt) return true;
  const updated = new Date(updatedAt).getTime();
  const now = Date.now();
  return now - updated > maxAgeHours * 60 * 60 * 1000;
}
