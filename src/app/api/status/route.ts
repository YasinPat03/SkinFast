import { NextResponse } from 'next/server';
import { getDataStatus } from '@/lib/market/status';

// Freshness and completeness of the market data, plus the health record of
// each background job. Check this when numbers on the site look wrong.

export async function GET() {
  try {
    return NextResponse.json(await getDataStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[status] failed', error);
    return NextResponse.json({ error: 'Status is temporarily unavailable' }, { status: 503 });
  }
}
