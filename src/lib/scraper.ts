import sql from './db';

// Constants
export const SEARCH_URL = 'https://steamcommunity.com/market/search/render/';
export const PAGE_SIZE = 100; // Steam allows up to 100 results per page
export const MIN_DELAY_MS = 3000;
export const MAX_DELAY_MS = 5000;
export const MAX_RETRIES = 3;
export const BACKOFF_DELAYS = [30_000, 60_000, 120_000];

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

// Helpers
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// Fetch a single page from Steam's search/render endpoint with retry/backoff
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (res.status === 429) {
      const backoff = BACKOFF_DELAYS[Math.min(attempt, BACKOFF_DELAYS.length - 1)];
      console.warn(`  Rate limited (429). Waiting ${backoff / 1000}s before retry...`);
      await sleep(backoff);
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching offset ${offset}`);
    }

    const data = (await res.json()) as SteamSearchResponse;

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

// Upsert a batch of search results into the prices table
export async function upsertPriceBatch(results: SteamSearchResult[]): Promise<void> {
  const validResults = results.filter(
    (item) => item.hash_name && item.sell_price && item.sell_price !== 0
  );

  if (validResults.length === 0) return;

  // Batch upsert
  for (const item of validResults) {
    await sql`
      INSERT INTO prices (market_hash_name, lowest_price_cents, median_price_cents, volume, sell_listings, updated_at)
      VALUES (${item.hash_name}, ${item.sell_price}, NULL, NULL, ${item.sell_listings ?? 0}, NOW())
      ON CONFLICT (market_hash_name) DO UPDATE SET
        lowest_price_cents = EXCLUDED.lowest_price_cents,
        sell_listings = EXCLUDED.sell_listings,
        updated_at = NOW()
    `;
  }
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

// Run a bounded scrape: fetch up to maxPages pages starting from the current offset.
// Returns progress info. Used by both the CLI script and the cron API route.
export async function scrapeChunk(maxPages: number): Promise<{
  pagesScraped: number;
  itemsScraped: number;
  startOffset: number;
  offset: number;
  totalCount: number;
  completed: boolean;
}> {
  const startOffset = parseInt(await getScrapeState('last_offset') ?? '0', 10);
  let offset = startOffset;

  // First request to get total count
  const firstPage = await fetchPage(offset);
  const totalCount = firstPage.total_count;

  console.log(`[scraper] Starting from offset ${startOffset}/${totalCount} (${maxPages} pages max)`);

  // Process first page
  await upsertPriceBatch(firstPage.results);
  const actualPageSize = firstPage.results.length;
  offset += actualPageSize;
  await saveScrapeState('last_offset', offset.toString());

  let itemsScraped = actualPageSize;
  let pagesScraped = 1;

  if (actualPageSize < PAGE_SIZE) {
    console.log(`[scraper] Note: Steam returned ${actualPageSize} results per page (requested ${PAGE_SIZE})`);
  }

  // Paginate through remaining results — advance by actual results returned, not PAGE_SIZE
  while (offset < totalCount && pagesScraped < maxPages) {
    await sleep(randomDelay());

    const page = await fetchPage(offset);

    if (page.results.length === 0) break;

    await upsertPriceBatch(page.results);
    pagesScraped++;
    itemsScraped += page.results.length;
    offset += page.results.length;
    await saveScrapeState('last_offset', offset.toString());
    console.log(`[scraper] Page ${pagesScraped}/${maxPages} — offset ${offset}/${totalCount} (+${page.results.length} items)`);

  }

  // Check if full scrape completed
  const completed = offset >= totalCount;
  if (completed) {
    await saveScrapeState('last_offset', '0');
    await saveScrapeState('last_full_scrape', new Date().toISOString());
  }

  console.log(`[scraper] Done — scraped ${pagesScraped} pages, ${itemsScraped} items. Offset: ${startOffset} → ${offset}/${totalCount}. Completed cycle: ${completed}`);

  return { pagesScraped, itemsScraped, startOffset, offset, totalCount, completed };
}
