import { NextRequest, NextResponse } from 'next/server';
import { findBestTradeup } from '@/lib/tradeup-optimizer';

export async function GET(request: NextRequest) {
  const skinId = request.nextUrl.searchParams.get('skin_id');
  const wear = request.nextUrl.searchParams.get('wear') ?? 'Field-Tested';
  const stattrak = request.nextUrl.searchParams.get('stattrak') === 'true';

  if (!skinId) {
    return NextResponse.json({ error: 'skin_id is required' }, { status: 400 });
  }

  const result = await findBestTradeup(skinId, wear, stattrak);

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
