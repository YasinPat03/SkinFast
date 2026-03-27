import { NextRequest, NextResponse } from 'next/server';
import { refreshSinglePrice } from '@/lib/prices';
import sql from '@/lib/db';

// At ~3s per request, 50 items ≈ 150s — well within Vercel Pro's 300s limit.
const BATCH_SIZE = parseInt(process.env.LAST_SOLD_BATCH_SIZE ?? '50', 10);

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Auth: verify CRON_SECRET
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Find skin_variants without any price data.
  // Skip items checked in the last 24 hours to avoid re-fetching items Steam has no data for.
  const missing = await sql<{ market_hash_name: string }[]>`
    SELECT sv.market_hash_name
    FROM skin_variants sv
    LEFT JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE p.market_hash_name IS NULL
       OR (p.lowest_price_cents IS NULL AND p.median_price_cents IS NULL
           AND (p.updated_at IS NULL OR p.updated_at < NOW() - INTERVAL '24 hours'))
    LIMIT ${BATCH_SIZE}
  `;

  if (missing.length === 0) {
    return NextResponse.json({ status: 'ok', message: 'No missing prices', fetched: 0 });
  }

  let withPrice = 0;
  let noData = 0;

  for (const { market_hash_name } of missing) {
    try {
      const result = await refreshSinglePrice(market_hash_name);
      if (result && (result.lowest_price_cents !== null || result.median_price_cents !== null)) {
        withPrice++;
      } else {
        noData++;
      }
    } catch {
      noData++;
    }
  }

  return NextResponse.json({
    status: 'ok',
    attempted: missing.length,
    with_price: withPrice,
    no_data: noData,
  });
}
