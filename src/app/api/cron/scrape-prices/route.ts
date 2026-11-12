import { NextRequest, NextResponse } from 'next/server';
import { envInt, rejectUnauthorizedCron } from '@/lib/cron-auth';
import { runListingsJob } from '@/lib/market/jobs';

// One slice of the bulk listing-price scan (see src/lib/market/listings-scan.ts).
// Steam serves 10 items per page at roughly one page every 4 seconds, so a
// slice covers ~500 items and a full pass over ~15.8k items takes ~30 slices
// (about 2.5 hours on the every-5-minutes schedule in vercel.json).
export const maxDuration = 300;

// Leaves headroom under maxDuration for the last page and the final writes.
const BUDGET_MS = 240_000;

export async function GET(request: NextRequest) {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;

  const outcome = await runListingsJob({
    budgetMs: BUDGET_MS,
    maxPages: envInt('SCRAPER_MAX_PAGES_PER_RUN', 80),
    log: (message) => console.log(`[scrape-prices] ${message}`),
  });

  // Always 200 for a run that was handled; the body and the health record say
  // how it went. A crash is the only 500.
  return NextResponse.json(outcome, { status: outcome.status === 'crashed' ? 500 : 200 });
}
