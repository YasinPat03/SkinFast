import { NextRequest, NextResponse } from 'next/server';
import { runLastSoldAvgChunk } from '@/lib/prices';

// At ~3s per request, 50 items ≈ 150s — within Vercel Pro's 300s limit.
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
    attempted: result.attempted,
    with_data: result.withData,
    no_data: result.noData,
  });
}
