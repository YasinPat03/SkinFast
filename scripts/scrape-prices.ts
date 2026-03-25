import { initDb, closeDb } from '../src/lib/db';
import { scrapeChunk, getScrapeState, saveScrapeState } from '../src/lib/scraper';

async function main() {
  const args = process.argv.slice(2);
  const maxPages = args.includes('--max-pages')
    ? parseInt(args[args.indexOf('--max-pages') + 1], 10)
    : Infinity;
  const resume = !args.includes('--no-resume');

  console.log('=== Steam Market Price Scraper ===\n');

  initDb();

  // Reset offset if not resuming
  if (!resume) {
    saveScrapeState('last_offset', '0');
  }

  const currentOffset = getScrapeState('last_offset');
  if (currentOffset && parseInt(currentOffset, 10) > 0) {
    console.log(`Resuming from offset ${currentOffset}`);
  }

  try {
    const result = await scrapeChunk(maxPages);

    console.log(`\n=== Done ===`);
    console.log(`Pages scraped: ${result.pagesScraped}`);
    console.log(`Items scraped: ${result.itemsScraped}`);
    console.log(`Progress: ${result.offset}/${result.totalCount}`);

    if (result.completed) {
      console.log('Full scrape complete. State reset.');
    } else {
      console.log('Partial scrape. Re-run to continue.');
    }
  } catch (err) {
    console.error('Scraper error:', err);
    console.log('Progress saved. Re-run to resume.');
  }

  closeDb();
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  closeDb();
  process.exit(1);
});
