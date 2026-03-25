import { getDb, initDb, closeDb } from '../src/lib/db';

const SEARCH_URL = 'https://steamcommunity.com/market/search/render/';
const PAGE_SIZE = 10; // Steam caps at 10 results per page regardless of count param
const MIN_DELAY_MS = 3000;
const MAX_DELAY_MS = 5000;
const MAX_RETRIES = 3;
const BACKOFF_DELAYS = [30_000, 60_000, 120_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

interface SteamSearchResult {
  hash_name: string;
  sell_price: number;
  sell_price_text: string;
  sell_listings: number;
  name: string;
}

interface SteamSearchResponse {
  success: boolean;
  start: number;
  pagesize: number;
  total_count: number;
  results: SteamSearchResult[];
}

async function fetchPage(offset: number): Promise<SteamSearchResponse> {
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

async function main() {
  const args = process.argv.slice(2);
  const maxPages = args.includes('--max-pages')
    ? parseInt(args[args.indexOf('--max-pages') + 1], 10)
    : Infinity;
  const resume = !args.includes('--no-resume');

  console.log('=== Steam Market Price Scraper ===\n');

  initDb();
  const db = getDb();

  const upsertPrice = db.prepare(`
    INSERT INTO prices (market_hash_name, lowest_price_cents, median_price_cents, volume, sell_listings, updated_at)
    VALUES (?, ?, NULL, NULL, ?, datetime('now'))
    ON CONFLICT(market_hash_name) DO UPDATE SET
      lowest_price_cents = excluded.lowest_price_cents,
      sell_listings = excluded.sell_listings,
      updated_at = datetime('now')
  `);

  const upsertBatch = db.transaction((results: SteamSearchResult[]) => {
    for (const item of results) {
      if (!item.hash_name || !item.sell_price || item.sell_price === 0) continue;
      upsertPrice.run(item.hash_name, item.sell_price, item.sell_listings ?? 0);
    }
  });

  const saveState = db.prepare(`
    INSERT INTO scrape_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const getState = db.prepare('SELECT value FROM scrape_state WHERE key = ?');

  // Determine starting offset
  let offset = 0;
  if (resume) {
    const saved = getState.get('last_offset') as { value: string } | undefined;
    if (saved) {
      offset = parseInt(saved.value, 10);
      console.log(`Resuming from offset ${offset}`);
    }
  }

  // First request to get total count
  console.log('Fetching first page to get total count...');
  const firstPage = await fetchPage(offset);
  const totalCount = firstPage.total_count;
  console.log(`Total items on Steam Market: ${totalCount}\n`);

  // Process first page
  upsertBatch(firstPage.results);
  saveState.run('last_offset', offset.toString());
  console.log(`Scraped ${offset + firstPage.results.length}/${totalCount} items`);

  offset += PAGE_SIZE;
  let pagesScraped = 1;

  // Paginate through remaining results
  while (offset < totalCount && pagesScraped < maxPages) {
    await sleep(randomDelay());

    try {
      const page = await fetchPage(offset);

      if (page.results.length === 0) {
        console.log('No more results. Done.');
        break;
      }

      upsertBatch(page.results);
      saveState.run('last_offset', offset.toString());
      pagesScraped++;

      console.log(`Scraped ${Math.min(offset + page.results.length, totalCount)}/${totalCount} items (page ${pagesScraped})`);

      offset += PAGE_SIZE;
    } catch (err) {
      console.error(`Error at offset ${offset}:`, err);
      console.log('Progress saved. Re-run to resume.');
      break;
    }
  }

  // Summary
  const priceCount = (db.prepare('SELECT COUNT(*) as count FROM prices').get() as { count: number }).count;
  console.log(`\n=== Done ===`);
  console.log(`Total prices in DB: ${priceCount}`);

  // Clear scrape state on full completion
  if (offset >= totalCount) {
    saveState.run('last_offset', '0');
    saveState.run('last_full_scrape', new Date().toISOString());
    console.log('Full scrape complete. State reset.');
  }

  closeDb();
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  closeDb();
  process.exit(1);
});
