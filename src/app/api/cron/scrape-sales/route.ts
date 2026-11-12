import { NextRequest, NextResponse } from 'next/server';
import { envInt, rejectUnauthorizedCron } from '@/lib/cron-auth';
import { runSalesJob } from '@/lib/market/jobs';

// One slice of the sale-history refresh (see src/lib/market/sales-scan.ts):
// reads the last-5-sold average of every variant of the skins whose figures
// are oldest. Each skin is one 1.5-4.5 MB page that takes 5-25 s to download.
export const maxDuration = 300;

// New downloads stop early enough for the last one (and its retry) to finish.
const BUDGET_MS = 270_000;

export async function GET(request: NextRequest) {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;

  const outcome = await runSalesJob({
    budgetMs: BUDGET_MS,
    staleHours: envInt('SALES_STALE_HOURS', 24),
    concurrency: envInt('SALES_SCAN_CONCURRENCY', 2),
    log: (message) => console.log(`[scrape-sales] ${message}`),
  });

  return NextResponse.json(outcome, { status: outcome.status === 'crashed' ? 500 : 200 });
}
