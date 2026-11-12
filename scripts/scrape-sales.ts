/**
 * Sale-history refresh from the command line (the same code the
 * /api/cron/scrape-sales route runs in slices). Reads the last-5-sold average
 * for every variant of the skins whose figures are oldest.
 *
 *   npx tsx scripts/scrape-sales.ts                    # one slice (4 minutes)
 *   npx tsx scripts/scrape-sales.ts --loop             # keep going until nothing is due
 *   npx tsx scripts/scrape-sales.ts --max 20           # at most 20 skins
 *   npx tsx scripts/scrape-sales.ts --stale-hours 6    # refresh anything older than 6h
 *
 * Works from any country: Steam's page is in the local currency, and prices
 * are converted to USD with Steam's own rate (see src/lib/market/fx.ts).
 * A first pass over every skin is ~1,900 pages and takes several hours.
 */
import './env';
import sql from '../src/lib/db';
import { runSalesJob } from '../src/lib/market/jobs';
import { sleep } from '../src/lib/steam/http';

const RATE_LIMIT_PAUSE_MS = 120_000;
const MAX_RATE_LIMIT_PAUSES = 10;
const LOCK_WAIT_MS = 30_000;
const MAX_LOCK_WAITS = 12;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const loop = process.argv.includes('--loop');
  const staleHours = Number.parseInt(argValue('--stale-hours') ?? '24', 10);
  let remaining = argValue('--max') ? Number.parseInt(argValue('--max')!, 10) : Infinity;
  const totals = { pages: 0, items: 0, sales: 0, failures: 0 };
  let pauses = 0;
  let lockWaits = 0;

  while (remaining > 0) {
    const outcome = await runSalesJob({
      budgetMs: 240_000,
      maxFetches: remaining,
      staleHours,
      log: (message) => console.log(message),
    });

    if (outcome.status === 'skipped') {
      if (++lockWaits > MAX_LOCK_WAITS) {
        console.log('Another sales refresh (cron or another terminal) has held the lock for several minutes. Try again later.');
        break;
      }
      console.log('Another sales refresh is running; waiting for it to finish its slice...');
      await sleep(LOCK_WAIT_MS);
      continue;
    }
    lockWaits = 0;
    if (outcome.status === 'crashed') {
      console.error(`Refresh crashed: ${outcome.error}`);
      process.exitCode = 1;
      break;
    }

    const { result } = outcome;
    totals.pages += result.pagesFetched;
    totals.items += result.itemsUpdated;
    totals.sales += result.salesWritten;
    totals.failures += result.failures;
    remaining -= Math.max(result.pagesFetched, 1);
    console.log(
      `[slice] ${result.itemsUpdated} skins updated (${result.salesWritten} variants), ${result.noData} without data, ` +
        `${result.currencySkipped} unconvertible, ${result.failures} failed`,
    );

    if (result.caughtUp) {
      console.log('Nothing else is due.');
      break;
    }
    if (result.rateLimited) {
      if (!loop || pauses >= MAX_RATE_LIMIT_PAUSES) {
        console.log('Rate limited by Steam. Run again later.');
        break;
      }
      pauses++;
      console.log(`Rate limited by Steam. Pausing ${RATE_LIMIT_PAUSE_MS / 1000}s (${pauses}/${MAX_RATE_LIMIT_PAUSES})...`);
      await sleep(RATE_LIMIT_PAUSE_MS);
      continue;
    }
    if (outcome.status === 'failed') {
      console.error(`Stopping: ${outcome.health.last_error}`);
      process.exitCode = 1;
      break;
    }
    if (!loop) break;
  }

  console.log(`\nDone: ${totals.pages} pages, ${totals.items} skins updated, ${totals.sales} variants written, ${totals.failures} failures.`);
}

main()
  .catch((error) => {
    console.error('Refresh failed:', error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
