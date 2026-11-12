import { NextRequest, NextResponse } from 'next/server';
import { findBestTradeup } from '@/lib/tradeup';
import type { TradeupSort } from '@/lib/tradeup/types';

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const skinId = query.get('skin_id');
  const wear = query.get('wear') ?? 'Field-Tested';
  const statTrak = query.get('stattrak') === 'true';
  const sort: TradeupSort = query.get('sort') === 'ev' ? 'ev' : 'cost_per_hit';

  if (!skinId) return NextResponse.json({ error: 'skin_id is required' }, { status: 400 });

  const result = await findBestTradeup(skinId, wear, statTrak, sort);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
