/**
 * Bulk listing-price scan from the command line (the same code the
 * /api/cron/scrape-prices route runs in slices).
 *
 *   npx tsx scripts/scrape-prices.ts                 # continue the current pass to its end
 *   npx tsx scripts/scrape-prices.ts --max-pages 50  # stop after 50 pages (~500 items)
 *   npx tsx scripts/scrape-prices.ts --restart       # start a new pass from the first item
 *
 * A full pass is ~1,600 pages at one page every ~4 seconds: about 2 hours.
 * Progress is saved after every page, so it can be interrupted and resumed.
 */
import './env';
import sql from '../src/lib/db';
import { runListingsJob } from '../src/lib/market/jobs';
import { LISTINGS_STATE_KEYS } from '../src/lib/market/listings-scan';
import { setStates } from '../src/lib/market/state';
import { sleep } from '../src/lib/steam/http';

// From a home connection a 429 usually clears within a minute.
const RATE_LIMIT_PAUSE_MS = 60_000;
const MAX_RATE_LIMIT_PAUSES = 10;
// The scan runs in slices that each hold the job lock for a few minutes, the
// same way the cron route does, so a long run here and the cron job take turns
// on the shared progress instead of scanning the same pages twice.
const SLICE_MS = 240_000;
const LOCK_WAIT_MS = 30_000;
const MAX_LOCK_WAITS = 12;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const maxPages = argValue('--max-pages') ? Number.parseInt(argValue('--max-pages')!, 10) : Infinity;
  if (process.argv.includes('--restart')) {
    await setStates({ [LISTINGS_STATE_KEYS.offset]: '0', [LISTINGS_STATE_KEYS.cycleStartedAt]: '' });
    console.log('Starting a new pass from the first item.');
  }

  let pagesLeft = maxPages;
  let pauses = 0;
  let lockWaits = 0;
  let pricesWritten = 0;

  while (pagesLeft > 0) {
    const outcome = await runListingsJob({ maxPages: pagesLeft, budgetMs: SLICE_MS, log: (message) => console.log(message) });

    if (outcome.status === 'skipped') {
      if (++lockWaits > MAX_LOCK_WAITS) {
        console.log('Another scan (cron or another terminal) has held the lock for several minutes. Try again later.');
        break;
      }
      console.log('Another scan is running; waiting for it to finish its slice...');
      await sleep(LOCK_WAIT_MS);
      continue;
    }
    lockWaits = 0;
    if (outcome.status === 'crashed') {
      console.error(`Scan crashed: ${outcome.error}`);
      process.exitCode = 1;
      break;
    }

    const { result } = outcome;
    pagesLeft -= result.pagesFetched;
    pricesWritten += result.pricesWritten;

    if (result.completedCycle) {
      console.log(`\nPass complete. ${result.clearedUnlisted} vanished listings cleared.`);
      if (result.sweepSkipped) console.log(`Note: ${result.sweepSkipped}.`);
      break;
    }
    if (result.stoppedBy === 'budget') continue; // slice over; start the next one
    if (result.stoppedBy === 'rate_limited' && pauses < MAX_RATE_LIMIT_PAUSES) {
      pauses++;
      console.log(`Rate limited by Steam. Pausing ${RATE_LIMIT_PAUSE_MS / 1000}s (${pauses}/${MAX_RATE_LIMIT_PAUSES})...`);
      await sleep(RATE_LIMIT_PAUSE_MS);
      continue;
    }
    if (result.stoppedBy !== 'max_pages') {
      console.log(`Stopped: ${result.stoppedBy}${result.error ? ` (${result.error})` : ''}. Run again to continue from offset ${result.offset}.`);
      if (outcome.status === 'failed') process.exitCode = 1;
    }
    break;
  }

  console.log(`\n${pricesWritten} listing prices written this run.`);
}

main()
  .catch((error) => {
    console.error('Scan failed:', error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
