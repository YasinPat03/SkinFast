import { NextRequest, NextResponse } from 'next/server';
import { runLastSoldAvgChunk } from '@/lib/prices';

// BATCH_SIZE now caps listing-page FETCHES, not variants: one fetch fills every
// sibling variant on the page (~8x rows). At ~3s/fetch, 50 fetches ≈ 150s —
// within Vercel Pro's 300s limit — yet clears several hundred variants per run.
const BATCH_SIZE = parseInt(process.env.LAST_SOLD_AVG_BATCH_SIZE ?? '50', 10);
const STALE_HOURS = parseInt(process.env.LAST_SOLD_AVG_STALE_HOURS ?? '24', 10);

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const result = await runLastSoldAvgChunk({
    batchSize: BATCH_SIZE,
    staleHours: STALE_HOURS,
  });

  return NextResponse.json({
    status: 'ok',
    fetches: result.fetches,
    rows_written: result.rowsWritten,
    with_data: result.withData,
    no_data: result.noData,
  });
}
