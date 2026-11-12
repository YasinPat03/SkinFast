/**
 * Prints how fresh and complete the market data is, and how each background
 * job last went. The same information is served at /api/status.
 *
 *   npx tsx scripts/data-status.ts
 */
import './env';
import sql from '../src/lib/db';
import { getDataStatus } from '../src/lib/market/status';

async function main() {
  const status = await getDataStatus();
  const { listings, sales, metadata } = status;
  const job = (health: typeof listings.job) =>
    `last ok ${health.last_ok_at ?? 'never'}; ${health.consecutive_failures} failures in a row${health.last_error && health.consecutive_failures > 0 ? ` (${health.last_error})` : ''}`;

  console.log('Listing prices');
  console.log(`  ${listings.listed_variants} of ${listings.tracked_variants} variants listed; ${listings.listed_confirmed_last_24h} of those confirmed in the last 24h (${(status.listings_fresh_share * 100).toFixed(1)}%)${status.listings_stale ? '  << STALE' : ''}`);
  console.log(`  newest update ${listings.newest_update_at ?? 'never'}`);
  console.log(`  last full pass ${listings.last_cycle_completed_at ?? 'never'}; current pass at ${listings.cycle_progress ? `${listings.cycle_progress.offset}/${listings.cycle_progress.total}` : 'n/a'}`);
  console.log(`  job: ${job(listings.job)}`);
  console.log('Sale history (last-5-sold averages)');
  console.log(`  ${sales.variants_read} variants read, ${sales.variants_with_sales} with sales; ${sales.read_last_24h} read in the last 24h`);
  console.log(`  ${sales.outcome_variants_priced} of ${sales.outcome_variants} listed non-souvenir variants have a sale price (${(status.sales_coverage * 100).toFixed(1)}%)${status.sales_incomplete ? '  << INCOMPLETE' : ''}`);
  console.log(`  job: ${job(sales.job)}`);
  console.log('Metadata');
  console.log(`  last import ${metadata.last_import_at ?? 'never'}; job: ${job(metadata.job)}`);
}

main()
  .catch((error) => {
    console.error('Status failed:', error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
