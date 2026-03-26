/**
 * Re-runs the bulk price scraper. Wraps scrape-prices.ts with metadata tracking.
 * Usage:
 *   npx tsx scripts/refresh-prices.ts            # full refresh
 *   npx tsx scripts/refresh-prices.ts --resume    # resume interrupted scrape
 */
import './env';
import postgres from 'postgres';
import { execSync } from 'child_process';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(connectionString);

async function main() {
  // Check last full scrape time
  const rows = await sql`SELECT value FROM scrape_state WHERE key = 'last_full_scrape'`;
  const lastScrape = rows[0];

  if (lastScrape) {
    const elapsed = Date.now() - new Date(lastScrape.value).getTime();
    const hoursAgo = (elapsed / (1000 * 60 * 60)).toFixed(1);
    console.log(`Last full scrape: ${lastScrape.value} (${hoursAgo}h ago)`);
  } else {
    console.log('No previous full scrape recorded.');
  }

  await sql.end();

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
