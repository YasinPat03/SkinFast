import { NextRequest, NextResponse } from 'next/server';
import { evaluateTradeupContract } from '@/lib/tradeup';
import type { ExactTradeupInput } from '@/lib/tradeup/types';

// Prices a contract spelled out slot by slot with exact floats. Only the
// identity of each input and its float are read from the request; prices are
// looked up on the server.
function parseInputs(value: unknown): ExactTradeupInput[] | null {
  // A contract has 5 or 10 slots; anything longer is not a contract.
  if (!Array.isArray(value) || value.length > 10) return null;
  const inputs: ExactTradeupInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { skin_id, collection_id, market_hash_name, input_float } = entry as Record<string, unknown>;
    if (typeof skin_id !== 'string' || typeof collection_id !== 'string' || typeof market_hash_name !== 'string') {
      return null;
    }
    inputs.push({ skin_id, collection_id, market_hash_name, input_float: Number(input_float) });
  }
  return inputs;
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  const skinId = body.skin_id;
  if (typeof skinId !== 'string' || skinId === '') {
    return NextResponse.json({ error: 'skin_id is required' }, { status: 400 });
  }
  const inputs = parseInputs(body.inputs);
  if (!inputs) return NextResponse.json({ error: 'inputs must be a list of contract slots' }, { status: 400 });

  const wear = typeof body.wear === 'string' ? body.wear : 'Field-Tested';
  const result = await evaluateTradeupContract(skinId, wear, body.stattrak === true, inputs);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json(result);
}
