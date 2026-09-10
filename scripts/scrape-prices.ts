import './env';
import { scrapeChunk, getScrapeState, saveScrapeState, sleep } from '../src/lib/scraper';

// From a residential IP a 429 usually clears within a minute.
const RATE_LIMIT_PAUSE_MS = 60_000;

async function main() {
  const args = process.argv.slice(2);
  const maxPages = args.includes('--max-pages')
    ? parseInt(args[args.indexOf('--max-pages') + 1], 10)
    : Infinity;
  const resume = !args.includes('--no-resume');

  console.log('=== Steam Market Price Scraper ===\n');

  // Reset offset if not resuming
  if (!resume) {
    await saveScrapeState('last_offset', '0');
  }

  const currentOffset = await getScrapeState('last_offset');
  if (currentOffset && parseInt(currentOffset, 10) > 0) {
    console.log(`Resuming from offset ${currentOffset}`);
  }

  let pagesRemaining = maxPages;
  let totalPages = 0;
  let totalItems = 0;
  let run = 0;
  let completed = false;

  try {
    while (pagesRemaining > 0) {
      run++;
      const result = await scrapeChunk(pagesRemaining, { budgetMs: Infinity });
      totalPages += result.pagesScraped;
      totalItems += result.itemsScraped;
      pagesRemaining -= result.pagesScraped;
      completed = result.completed;

      console.log(
        `[run ${run}] +${result.pagesScraped} pages, +${result.itemsScraped} items → offset ${result.offset}/${result.totalCount ?? '?'}`
      );

      if (completed) break;

      if (result.rateLimited) {
        console.log(`Rate limited by Steam. Pausing ${RATE_LIMIT_PAUSE_MS / 1000}s before resuming...`);
        await sleep(RATE_LIMIT_PAUSE_MS);
        continue;
      }

      // Neither completed nor rate-limited: the page cap was reached, or Steam
      // returned an empty page before total_count. Stop rather than spin.
      break;
    }

    console.log(`\n=== Done ===`);
    console.log(`Pages scraped: ${totalPages}`);
    console.log(`Items scraped: ${totalItems}`);
    console.log(`Progress: ${await getScrapeState('last_offset')}`);

    if (completed) {
      console.log('Full scrape complete. State reset.');
    } else {
      console.log('Partial scrape. Re-run to continue.');
    }
  } catch (err) {
    console.error('Scraper error:', err);
    console.log('Progress saved. Re-run to resume.');
  }
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
