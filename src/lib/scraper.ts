import sql from './db';

// Constants
export const SEARCH_URL = 'https://steamcommunity.com/market/search/render/';
// Steam ignores `count` and returns 10 results per page (verified 2026-09-10).
// We still ask for 100 in case the cap is ever raised; every pagination step
// advances by the number of results actually returned, never by PAGE_SIZE.
export const PAGE_SIZE = 100;
export const MIN_DELAY_MS = 3000;
export const MAX_DELAY_MS = 5000;
export const MAX_RETRIES = 3;
// On a 429 the bulk scraper waits this long and retries ONCE; a second 429
// throws SteamRateLimitError so a serverless caller can return before its time
// limit instead of sleeping through it. (The old 30/60/120 s backoff summed to
// 330 s inside a 300 s Vercel function, which killed the run with its lock set.)
export const RATE_LIMIT_RETRY_MS = 15_000;
// Default wall-clock budget for one scrapeChunk() call. Leaves headroom under
// Vercel Pro's 300 s maxDuration for the final page, one 429 retry and DB writes.
export const DEFAULT_BUDGET_MS = 240_000;

export const STEAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class SteamRateLimitError extends Error {
  constructor(message = 'Steam returned HTTP 429') {
    super(message);
    this.name = 'SteamRateLimitError';
  }
}

// Types
export interface SteamSearchResult {
  hash_name: string;
  sell_price: number;
  sell_price_text: string;
  sell_listings: number;
  name: string;
}

export interface SteamSearchResponse {
  success: boolean;
  start: number;
  pagesize: number;
  total_count: number;
  results: SteamSearchResult[];
}

export interface ScrapeChunkResult {
  pagesScraped: number;
  itemsScraped: number;
  startOffset: number;
  offset: number;
  totalCount: number | null; // null when the very first page was rate-limited
  completed: boolean;
  rateLimited: boolean;
}

// Helpers
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

function normalizeResponse(data: SteamSearchResponse): SteamSearchResponse {
  if (!Array.isArray(data.results)) data.results = [];
  return data;
}

// Fetch a single page of the full-catalogue listing (no query) for the bulk
// scraper. One short retry on 429, up to MAX_RETRIES retries on success=false.
export async function fetchPage(offset: number): Promise<SteamSearchResponse> {
  const params = new URLSearchParams({
    appid: '730',
    norender: '1',
    start: offset.toString(),
    count: PAGE_SIZE.toString(),
    sort_column: 'name',
    sort_dir: 'asc',
  });

  const url = `${SEARCH_URL}?${params}`;
  let rateLimitRetried = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers: STEAM_HEADERS });

    if (res.status === 429) {
      if (rateLimitRetried) {
        throw new SteamRateLimitError(`Rate limited (429) at offset ${offset} after one retry`);
      }
      rateLimitRetried = true;
      console.warn(`  Rate limited (429) at offset ${offset}. Waiting ${RATE_LIMIT_RETRY_MS / 1000}s for one retry...`);
      await sleep(RATE_LIMIT_RETRY_MS);
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching offset ${offset}`);
    }

    const data = normalizeResponse((await res.json()) as SteamSearchResponse);

    if (!data.success) {
      if (attempt < MAX_RETRIES) {
        console.warn(`  success=false at offset ${offset}. Retrying (${attempt + 1}/${MAX_RETRIES})...`);
        await sleep(randomDelay());
        continue;
      }
      throw new Error(`Steam returned success=false after ${MAX_RETRIES} retries at offset ${offset}`);
    }

    return data;
  }

  throw new Error(`Max retries exceeded at offset ${offset}`);
}

// Fetch one page of a keyword search (used by the on-demand skin refresh).
// Never sleeps on its own beyond a single success=false retry, and throws
// SteamRateLimitError immediately on 429 so an interactive caller can report
// "rate limited" instead of hanging. The caller is responsible for spacing
// requests (see throttle() in prices.ts).
//
// `query` must not contain '|', '★' or '™' — Steam returns zero results for
// those; use buildSearchQuery() in prices.ts.
export async function fetchSearchPage(query: string, start: number): Promise<SteamSearchResponse> {
  const params = new URLSearchParams({
    appid: '730',
    norender: '1',
    query,
    start: start.toString(),
    count: PAGE_SIZE.toString(),
    sort_column: 'name',
    sort_dir: 'asc',
  });

  const url = `${SEARCH_URL}?${params}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: STEAM_HEADERS });

    if (res.status === 429) {
      throw new SteamRateLimitError(`Rate limited (429) searching "${query}" at start ${start}`);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} searching "${query}" at start ${start}`);
    }

    const data = normalizeResponse((await res.json()) as SteamSearchResponse);
    if (data.success) return data;

    if (attempt === 0) {
      console.warn(`  success=false searching "${query}" at start ${start}. Retrying once...`);
      await sleep(randomDelay());
    }
  }

  throw new Error(`Steam returned success=false searching "${query}" at start ${start}`);
}

// Upsert a batch of search results into the prices table. Skips unlisted items
// (sell_price 0/undefined). Only lowest_price_cents, sell_listings and
// updated_at are touched on conflict; median_price_cents and volume are kept.
// Returns the market_hash_names that were written.
export async function upsertPriceBatch(results: SteamSearchResult[]): Promise<string[]> {
  // Dedupe by name, keeping the last occurrence: a multi-page fetch can see the
  // same item twice if listings shift between pages, and ON CONFLICT DO UPDATE
  // rejects a key that appears twice in one statement.
  const byName = new Map<string, { market_hash_name: string; lowest_price_cents: number; sell_listings: number }>();
  for (const item of results) {
    if (!item.hash_name || !item.sell_price) continue;
    byName.set(item.hash_name, {
      market_hash_name: item.hash_name,
      lowest_price_cents: item.sell_price,
      sell_listings: item.sell_listings ?? 0,
    });
  }

  const rows = [...byName.values()];
  if (rows.length === 0) return [];

  await sql`
    INSERT INTO prices ${sql(rows, 'market_hash_name', 'lowest_price_cents', 'sell_listings')}
    ON CONFLICT (market_hash_name) DO UPDATE SET
      lowest_price_cents = EXCLUDED.lowest_price_cents,
      sell_listings = EXCLUDED.sell_listings,
      updated_at = NOW()
  `;

  return rows.map((r) => r.market_hash_name);
}

// Scrape state helpers
export async function getScrapeState(key: string): Promise<string | null> {
  const rows = await sql`SELECT value FROM scrape_state WHERE key = ${key}`;
  return rows.length > 0 ? rows[0].value : null;
}

export async function saveScrapeState(key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO scrape_state (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

// Run a bounded scrape: fetch up to maxPages pages starting from the current
// offset, stopping early when the wall-clock budget is nearly spent or Steam
// rate-limits us. Progress is saved to scrape_state after every page, so a
// caller can simply invoke this again to continue. Used by both the CLI script
// (budgetMs: Infinity) and the cron API route (default budget).
//
// With Steam's 10-item pages, 60 pages ≈ 600 items ≈ 250 s at 3–5 s spacing;
// a clean cycle over ~35k items therefore takes ~59 runs (≈5 h at */5).
export async function scrapeChunk(
  maxPages: number,
  opts: { budgetMs?: number } = {}
): Promise<ScrapeChunkResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  const startOffset = parseInt(await getScrapeState('last_offset') ?? '0', 10);
  let offset = startOffset;
  let totalCount: number | null = null;
  let itemsScraped = 0;
  let pagesScraped = 0;
  let rateLimited = false;

  console.log(
    `[scraper] Starting from offset ${startOffset} (${maxPages} pages max, budget ${Number.isFinite(budgetMs) ? `${Math.round(budgetMs / 1000)}s` : 'unlimited'})`
  );

  while (pagesScraped < maxPages) {
    if (pagesScraped > 0) {
      if (totalCount !== null && offset >= totalCount) break;
      if (Date.now() + MAX_DELAY_MS > deadline) {
        console.log(`[scraper] Time budget reached at offset ${offset}; stopping this run.`);
        break;
      }
      await sleep(randomDelay());
    }

    let page: SteamSearchResponse;
    try {
      page = await fetchPage(offset);
    } catch (err) {
      if (err instanceof SteamRateLimitError) {
        console.warn(`[scraper] ${err.message}. Stopping this run; progress is saved.`);
        rateLimited = true;
        break;
      }
      throw err;
    }

    totalCount = page.total_count;

    if (pagesScraped === 0 && page.results.length > 0 && page.results.length < PAGE_SIZE) {
      console.log(`[scraper] Note: Steam returned ${page.results.length} results per page (requested ${PAGE_SIZE})`);
    }

    if (page.results.length === 0) break;

    await upsertPriceBatch(page.results);
    pagesScraped++;
    itemsScraped += page.results.length;
    offset += page.results.length;
    await saveScrapeState('last_offset', offset.toString());
    console.log(`[scraper] Page ${pagesScraped}/${maxPages} — offset ${offset}/${totalCount} (+${page.results.length} items)`);
  }

  // Check if full scrape completed
  const completed = totalCount !== null && offset >= totalCount;
  if (completed) {
    await saveScrapeState('last_offset', '0');
    await saveScrapeState('last_full_scrape', new Date().toISOString());
  }

  console.log(
    `[scraper] Done — scraped ${pagesScraped} pages, ${itemsScraped} items. Offset: ${startOffset} → ${offset}/${totalCount ?? '?'}. Completed cycle: ${completed}. Rate limited: ${rateLimited}`
  );

  return { pagesScraped, itemsScraped, startOffset, offset, totalCount, completed, rateLimited };
}
