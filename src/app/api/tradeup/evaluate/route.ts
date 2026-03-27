import { NextRequest, NextResponse } from 'next/server';
import { evaluateTradeupContract, type ExactTradeupInput } from '@/lib/tradeup-optimizer';

interface EvaluateTradeupBody {
  skin_id?: string;
  wear?: string;
  stattrak?: boolean;
  inputs?: ExactTradeupInput[];
}

export async function POST(request: NextRequest) {
  let body: EvaluateTradeupBody;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const skinId = body.skin_id;
  const wear = body.wear ?? 'Field-Tested';
  const stattrak = body.stattrak === true;
  const inputs = Array.isArray(body.inputs) ? body.inputs : [];

  if (!skinId) {
    return NextResponse.json({ error: 'skin_id is required' }, { status: 400 });
  }

  const result = await evaluateTradeupContract(skinId, wear, stattrak, inputs);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json(result);
}
