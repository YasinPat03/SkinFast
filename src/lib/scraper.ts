import { getDb } from './db';

// Constants
export const SEARCH_URL = 'https://steamcommunity.com/market/search/render/';
export const PAGE_SIZE = 10; // Steam caps at 10 results per page
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
    const res = await fetch(url);

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
export function upsertPriceBatch(results: SteamSearchResult[]): void {
  const db = getDb();

  const upsert = db.prepare(`
    INSERT INTO prices (market_hash_name, lowest_price_cents, median_price_cents, volume, sell_listings, updated_at)
    VALUES (?, ?, NULL, NULL, ?, datetime('now'))
    ON CONFLICT(market_hash_name) DO UPDATE SET
      lowest_price_cents = excluded.lowest_price_cents,
      sell_listings = excluded.sell_listings,
      updated_at = datetime('now')
  `);

  const batch = db.transaction((items: SteamSearchResult[]) => {
    for (const item of items) {
      if (!item.hash_name || !item.sell_price || item.sell_price === 0) continue;
      upsert.run(item.hash_name, item.sell_price, item.sell_listings ?? 0);
    }
  });

  batch(results);
}

// Scrape state helpers
export function getScrapeState(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM scrape_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function saveScrapeState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO scrape_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

// Run a bounded scrape: fetch up to maxPages pages starting from the current offset.
// Returns progress info. Used by both the CLI script and the cron API route.
export async function scrapeChunk(maxPages: number): Promise<{
  pagesScraped: number;
  itemsScraped: number;
  offset: number;
  totalCount: number;
  completed: boolean;
}> {
  const startOffset = parseInt(getScrapeState('last_offset') ?? '0', 10);
  let offset = startOffset;

  // First request to get total count
  const firstPage = await fetchPage(offset);
  const totalCount = firstPage.total_count;

  // Process first page
  upsertPriceBatch(firstPage.results);
  saveScrapeState('last_offset', offset.toString());

  let itemsScraped = firstPage.results.length;
  offset += PAGE_SIZE;
  let pagesScraped = 1;

  // Paginate through remaining results
  while (offset < totalCount && pagesScraped < maxPages) {
    await sleep(randomDelay());

    const page = await fetchPage(offset);

    if (page.results.length === 0) break;

    upsertPriceBatch(page.results);
    saveScrapeState('last_offset', offset.toString());
    pagesScraped++;
    itemsScraped += page.results.length;
    offset += PAGE_SIZE;
  }

  // Check if full scrape completed
  const completed = offset >= totalCount;
  if (completed) {
    saveScrapeState('last_offset', '0');
    saveScrapeState('last_full_scrape', new Date().toISOString());
  }

  return { pagesScraped, itemsScraped, offset, totalCount, completed };
}
