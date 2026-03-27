/**
 * Fetches prices via Steam's priceoverview endpoint for skins that are missing
 * price data (no listing or no median/last-sold price).
 *
 * The bulk scraper (search/render) only provides lowest listing prices.
 * This script uses the single-item priceoverview endpoint which also returns
 * median_price (last sold) — useful for skins with no active listings.
 *
 * Usage:
 *   npx tsx scripts/scrape-last-sold.ts               # fetch all missing
 *   npx tsx scripts/scrape-last-sold.ts --limit 100   # fetch up to 100
 */
import './env';
import postgres from 'postgres';
import { refreshSinglePrice } from '../src/lib/prices';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(connectionString);

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 500;

  console.log('=== Last Sold Price Scraper ===\n');

  // Find skin_variants that either:
  // 1. Have no entry in prices table at all
  // 2. Have NULL lowest_price_cents AND NULL median_price_cents
  const missing = await sql<{ market_hash_name: string }[]>`
    SELECT sv.market_hash_name
    FROM skin_variants sv
    LEFT JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE p.market_hash_name IS NULL
       OR (p.lowest_price_cents IS NULL AND p.median_price_cents IS NULL)
    LIMIT ${limit}
  `;

  console.log(`Found ${missing.length} variants without price data (limit: ${limit})\n`);

  if (missing.length === 0) {
    console.log('Nothing to fetch.');
    await sql.end();
    return;
  }

  let fetched = 0;
  let withPrice = 0;
  let noData = 0;

  for (const { market_hash_name } of missing) {
    fetched++;
    console.log(`[${fetched}/${missing.length}] ${market_hash_name}`);

    try {
      const result = await refreshSinglePrice(market_hash_name);
      if (result && (result.lowest_price_cents !== null || result.median_price_cents !== null)) {
        const listing = result.lowest_price_cents ? `$${(result.lowest_price_cents / 100).toFixed(2)}` : 'none';
        const lastSold = result.median_price_cents ? `$${(result.median_price_cents / 100).toFixed(2)}` : 'none';
        console.log(`  → listing: ${listing}, last sold: ${lastSold}`);
        withPrice++;
      } else {
        console.log(`  → no data available`);
        noData++;
      }
    } catch (err) {
      console.error(`  → error: ${err}`);
      noData++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`Fetched: ${fetched}, with price: ${withPrice}, no data: ${noData}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('Scraper failed:', err);
  await sql.end();
  process.exit(1);
});
