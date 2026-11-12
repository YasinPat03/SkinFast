import { NextRequest, NextResponse } from 'next/server';
import { loadSkinDetail } from '@/lib/skins';
import { getTradeupEligibility } from '@/lib/tradeup';

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const detail = await loadSkinDetail(id);
  if (!detail) return NextResponse.json({ error: 'Skin not found' }, { status: 404 });

  return NextResponse.json({ ...detail, tradeup: await getTradeupEligibility(id) });
}
