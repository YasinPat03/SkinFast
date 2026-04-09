/**
 * Incrementally populates the `last_sold_avg` table with the volume-weighted
 * average of the last 5 individual sales for each skin variant. Each run
 * processes one chunk; entries refreshed within `--stale-hours` are skipped,
 * so re-running picks up where the previous run left off.
 *
 * Usage:
 *   npx tsx scripts/scrape-last-sold-avg.ts                       # one chunk
 *   npx tsx scripts/scrape-last-sold-avg.ts --batch-size 100      # custom chunk size
 *   npx tsx scripts/scrape-last-sold-avg.ts --stale-hours 6       # refresh entries older than 6h
 *   npx tsx scripts/scrape-last-sold-avg.ts --loop                # keep processing chunks until none stale
 */
import './env';
import postgres from 'postgres';
import { runLastSoldAvgChunk } from '../src/lib/prices';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(connectionString);

async function main() {
  const args = process.argv.slice(2);
  const batchIdx = args.indexOf('--batch-size');
  const batchSize = batchIdx >= 0 ? parseInt(args[batchIdx + 1], 10) : 50;
  const staleIdx = args.indexOf('--stale-hours');
  const staleHours = staleIdx >= 0 ? parseInt(args[staleIdx + 1], 10) : 24;
  const loop = args.includes('--loop');

  console.log('=== Last-Sold Avg (last 5) Scraper ===');
  console.log(`batch-size=${batchSize}, stale-hours=${staleHours}, loop=${loop}\n`);

  let totalAttempted = 0;
  let totalWithData = 0;
  let totalNoData = 0;
  let chunkNum = 0;

  do {
    chunkNum++;
    const result = await runLastSoldAvgChunk({ batchSize, staleHours });
    totalAttempted += result.attempted;
    totalWithData += result.withData;
    totalNoData += result.noData;

    console.log(
      `[chunk ${chunkNum}] attempted=${result.attempted}, with_data=${result.withData}, no_data=${result.noData}`
    );

    if (!loop || result.attempted === 0) break;
  } while (true);

  console.log(`\n=== Done ===`);
  console.log(`Chunks: ${chunkNum}, attempted: ${totalAttempted}, with data: ${totalWithData}, no data: ${totalNoData}`);

  await sql.end();
}

main().catch(async (err) => {
  console.error('Scraper failed:', err);
  await sql.end();
  process.exit(1);
});
