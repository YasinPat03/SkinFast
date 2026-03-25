import { NextRequest, NextResponse } from 'next/server';
import { initDb } from '@/lib/db';
import { refreshSinglePrice } from '@/lib/prices';

export async function POST(request: NextRequest) {
  const body = await request.json();
  const marketHashNames: string[] = body.market_hash_names;

  if (!Array.isArray(marketHashNames) || marketHashNames.length === 0) {
    return NextResponse.json({ error: 'market_hash_names array required' }, { status: 400 });
  }

  // Limit to 10 items per request to stay within rate limits
  const names = marketHashNames.slice(0, 10);

  initDb();

  const results: Record<string, { lowest_price_cents: number | null; median_price_cents: number | null; volume: number | null } | null> = {};

  for (const name of names) {
    const result = await refreshSinglePrice(name);
    results[name] = result;
  }

  return NextResponse.json({ results });
}
