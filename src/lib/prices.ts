import sql from './db';
import {
  fetchSearchPage,
  upsertPriceBatch,
  SteamRateLimitError,
  type SteamSearchResult,
} from './scraper';

const MARKET_LISTING_URL = 'https://steamcommunity.com/market/listings/730/';
const MAX_REQUESTS_PER_MINUTE = 20;
const MIN_INTERVAL_MS = (60 / MAX_REQUESTS_PER_MINUTE) * 1000; // 3s between requests

let lastRequestTime = 0;

// Per-instance spacer so every Steam request from this process is ≥3 s apart.
async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
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

// ---------------------------------------------------------------------------
// On-demand refresh of one skin's listing prices via search/render.
//
// Steam's per-item `priceoverview` endpoint answers HTTP 429 to anonymous
// callers (verified 2026-09-10), so on-demand refreshes go through
// `search/render?query=<weapon> <pattern>` instead. One query returns every
// currently listed variant of a skin (all wears, StatTrak, Souvenir) with
// `sell_price` (USD cents) and `sell_listings` — the same fields the bulk
// scraper stores. Steam caps the endpoint at 10 results per page; the largest
// skin has 15 variants, so MAX_QUERY_PAGES × 10 covers a whole skin with room
// for loose-match noise. Vanilla knives (query = weapon only) can exceed that
// and simply come back with `complete: false`.
// ---------------------------------------------------------------------------
const MAX_QUERY_PAGES = 6;

export type SkinRefreshStatus = 'ok' | 'no_results' | 'rate_limited' | 'error' | 'not_found';

export interface SkinRefreshResult {
  status: SkinRefreshStatus;
  query: string;
  requested: string[];   // market_hash_names of this skin_id's variants
  updated: string[];     // names actually upserted with a price (any tracked variant, siblings included)
  missing: string[];     // requested names absent from a COMPLETE result set, now marked as "no listings"
  last_sold_updated: string[]; // last_sold_avg rows refreshed for variants that have no active listing
  complete: boolean;     // true if every result page was fetched (offset >= total_count)
  results: Record<string, { lowest_price_cents: number; sell_listings: number } | null>;
}

// "★ Karambit | Doppler" -> "Karambit Doppler"; vanilla "★ Navaja Knife" -> "Navaja Knife".
// Steam returns zero results when '|', '★' or '™' appear in the query.
export function buildSearchQuery(weaponName: string, patternName: string | null): string {
  return [weaponName, patternName]
    .filter((s): s is string => !!s && s.trim() !== '')
    .join(' ')
    .replace(/[|★™]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Record that a tracked variant currently has no Steam listing. Touches only
// lowest_price_cents / sell_listings / updated_at so median_price_cents and
// volume survive, and so isPriceStale() stops flagging the row on every visit.
async function markNoListings(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const rows = names.map((market_hash_name) => ({
    market_hash_name,
    lowest_price_cents: null,
    sell_listings: 0,
  }));
  await sql`
    INSERT INTO prices ${sql(rows, 'market_hash_name', 'lowest_price_cents', 'sell_listings')}
    ON CONFLICT (market_hash_name) DO UPDATE SET
      lowest_price_cents = NULL,
      sell_listings = 0,
      updated_at = NOW()
  `;
}

// The skin page shows the last sold price for a variant with no active
// listing, so a refresh also makes sure that data exists and is recent.
const LAST_SOLD_RECHECK_HOURS = 24;   // matches the scrape-last-sold-avg cron's default
const MAX_LAST_SOLD_FETCHES = 4;      // listing-page requests per refresh, ~3 s each

async function namesWithStaleLastSold(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const fresh = await sql<{ market_hash_name: string }[]>`
    SELECT market_hash_name FROM last_sold_avg
    WHERE market_hash_name = ANY(${names})
      AND updated_at > NOW() - (${LAST_SOLD_RECHECK_HOURS} || ' hours')::INTERVAL
  `;
  const freshSet = new Set(fresh.map((r) => r.market_hash_name));
  return names.filter((n) => !freshSet.has(n));
}

// Refresh last_sold_avg for the requested variants that have no active
// listing. Steam's listing page for a LISTED variant redirects to the skin's
// group page, whose SSR state carries the sale history of every sibling
// variant; an unlisted variant's page carries at most its own history, and a
// never-sold one carries none. So go through a listed sibling first when one
// exists, then fetch anything still uncovered one page at a time.
async function refreshLastSoldForUnlisted(requested: string[], listed: string[]): Promise<string[]> {
  const listedSet = new Set(listed);
  const unlisted = requested.filter((n) => !listedSet.has(n));
  let pending = await namesWithStaleLastSold(unlisted);
  if (pending.length === 0) return [];

  const written = new Set<string>();
  let fetches = 0;

  const anchor = requested.find((n) => listedSet.has(n));
  if (anchor) {
    const { written: w } = await refreshLastSoldAvgGroup(anchor);
    fetches++;
    // A listed anchor always yields at least its own row; an empty result
    // means Steam rate-limited us or answered in a non-USD currency, and
    // further requests would fail the same way.
    if (w.length === 0) return [];
    for (const n of w) written.add(n);
    pending = pending.filter((n) => !written.has(n));
  }

  for (const name of pending) {
    if (fetches >= MAX_LAST_SOLD_FETCHES) break;
    const { written: w } = await refreshLastSoldAvgGroup(name);
    fetches++;
    // Even a never-sold variant yields its own sentinel row, so an empty
    // result again means rate limiting or a non-USD answer: stop here.
    if (w.length === 0) break;
    for (const n of w) written.add(n);
  }

  return [...written];
}

export async function refreshSkinPrices(skinId: string): Promise<SkinRefreshResult> {
  const skinRows = await sql<{ weapon_name: string; pattern_name: string | null }[]>`
    SELECT weapon_name, pattern_name FROM skins WHERE id = ${skinId}
  `;
  const skin = skinRows[0];
  if (!skin) {
    return { status: 'not_found', query: '', requested: [], updated: [], missing: [], last_sold_updated: [], complete: false, results: {} };
  }

  const variantRows = await sql<{ market_hash_name: string }[]>`
    SELECT market_hash_name FROM skin_variants WHERE skin_id = ${skinId}
  `;
  const requested = variantRows.map((r) => r.market_hash_name);
  const query = buildSearchQuery(skin.weapon_name, skin.pattern_name);

  const result: SkinRefreshResult = {
    status: 'ok',
    query,
    requested,
    updated: [],
    missing: [],
    last_sold_updated: [],
    complete: false,
    results: Object.fromEntries(requested.map((name) => [name, null])),
  };

  // Phase 1: paginate the search. On a 429 keep whatever pages already arrived.
  const raw: SteamSearchResult[] = [];
  let start = 0;
  let totalCount: number | null = null;
  try {
    for (let page = 0; page < MAX_QUERY_PAGES; page++) {
      await throttle();
      const res = await fetchSearchPage(query, start);
      raw.push(...res.results);
      start += res.results.length;
      totalCount = res.total_count;
      if (res.results.length === 0 || start >= totalCount) break;
    }
    result.complete = totalCount !== null && start >= totalCount;
  } catch (err) {
    if (err instanceof SteamRateLimitError) {
      result.status = 'rate_limited';
    } else {
      result.status = 'error';
      console.warn(`refreshSkinPrices(${skinId}): query "${query}" failed: ${err}`);
    }
  }

  // Phase 2: write. Search matching is loose ("Karambit Doppler" also returns
  // Gamma Doppler items), so only names that exist in skin_variants are
  // written — but ALL of those, not just this skin_id's, so sibling Doppler
  // phases and same-pattern cousins get a free refresh.
  try {
    const names = [...new Set(raw.map((r) => r.hash_name).filter(Boolean))];
    const tracked = names.length > 0
      ? await sql<{ market_hash_name: string }[]>`
          SELECT market_hash_name FROM skin_variants WHERE market_hash_name = ANY(${names})
        `
      : [];
    const trackedSet = new Set(tracked.map((t) => t.market_hash_name));
    const trackedResults = raw.filter((r) => trackedSet.has(r.hash_name));

    result.updated = await upsertPriceBatch(trackedResults);

    const latest = new Map<string, SteamSearchResult>();
    for (const r of trackedResults) if (r.sell_price) latest.set(r.hash_name, r);
    for (const name of result.updated) {
      const r = latest.get(name);
      if (r) result.results[name] = { lowest_price_cents: r.sell_price, sell_listings: r.sell_listings ?? 0 };
    }

    if (result.status === 'ok') {
      if (result.updated.length === 0) {
        // Nothing tracked came back: either the query matched nothing or Steam
        // matched it differently than we expect. Never null rows on that basis.
        result.status = 'no_results';
      } else if (result.complete) {
        // Every page was fetched and the skin was found, so a requested variant
        // that is absent has no active listing right now.
        const updatedSet = new Set(result.updated);
        const missing = requested.filter((name) => !updatedSet.has(name));
        await markNoListings(missing);
        result.missing = missing;
      }
    }
  } catch (err) {
    result.status = 'error';
    console.warn(`refreshSkinPrices(${skinId}): writing results for "${query}" failed: ${err}`);
  }

  // Phase 3: variants without an active listing fall back to their last sold
  // price on the page, so refresh that for any of them whose data is stale.
  // Skipped when Steam is already rate-limiting or the search itself failed.
  if (result.status === 'ok' || result.status === 'no_results') {
    try {
      result.last_sold_updated = await refreshLastSoldForUnlisted(requested, result.updated);
    } catch (err) {
      console.warn(`refreshSkinPrices(${skinId}): last-sold refresh failed: ${err}`);
    }
  }

  return result;
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

// A row that recorded "no listings" (both prices NULL) is re-checked on a
// slower cadence than a priced row. Previously such rows were treated as stale
// forever, so any skin with an unlisted Souvenir variant fired a refresh on
// every visit that could never succeed.
const NO_LISTING_RECHECK_HOURS = 24;

export function isPriceStale(
  updatedAt: string | Date | null,
  maxAgeHours: number = 6,
  lowestPriceCents: number | null = null,
  medianPriceCents: number | null = null
): boolean {
  if (!updatedAt) return true; // never fetched
  const hasPrice = lowestPriceCents != null || medianPriceCents != null;
  const windowHours = hasPrice ? maxAgeHours : Math.max(maxAgeHours, NO_LISTING_RECHECK_HOURS);
  return Date.now() - new Date(updatedAt).getTime() > windowHours * 60 * 60 * 1000;
}
