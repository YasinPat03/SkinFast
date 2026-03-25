/**
 * Re-runs the bulk price scraper. Wraps scrape-prices.ts with metadata tracking.
 * Usage:
 *   npx tsx scripts/refresh-prices.ts            # full refresh
 *   npx tsx scripts/refresh-prices.ts --resume    # resume interrupted scrape
 */
import { getDb, initDb, closeDb } from '../src/lib/db';
import { execSync } from 'child_process';

function main() {
  initDb();
  const db = getDb();

  // Check last full scrape time
  const lastScrape = db.prepare(
    "SELECT value FROM scrape_state WHERE key = 'last_full_scrape'"
  ).get() as { value: string } | undefined;

  if (lastScrape) {
    const elapsed = Date.now() - new Date(lastScrape.value).getTime();
    const hoursAgo = (elapsed / (1000 * 60 * 60)).toFixed(1);
    console.log(`Last full scrape: ${lastScrape.value} (${hoursAgo}h ago)`);
  } else {
    console.log('No previous full scrape recorded.');
  }

  closeDb();

  // Run the scraper
  const args = process.argv.includes('--resume') ? '' : '--no-resume';
  console.log(`\nStarting price scrape${args ? ' (fresh)' : ' (resuming)'}...\n`);

  try {
    execSync(`npx tsx scripts/scrape-prices.ts ${args}`, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch {
    console.error('\nScrape interrupted or failed. Run with --resume to continue.');
    process.exit(1);
  }
}

main();
