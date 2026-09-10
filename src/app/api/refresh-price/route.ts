import { NextRequest, NextResponse } from 'next/server';
import { refreshSkinPrices, type SkinRefreshResult } from '@/lib/prices';

// Up to 6 Steam search pages at ~3 s spacing, plus DB round trips.
export const maxDuration = 60;

// Best-effort per-instance guard: a page reloaded in a loop on a rate-limited
// skin must not stack Steam requests. Concurrent callers for the same skin
// share one in-flight promise; callers within the cooldown get the last
// result back unchanged. Serverless instances are recycled, so the client
// keeps its own 5-minute sessionStorage guard as well.
const ATTEMPT_COOLDOWN_MS = 60_000;
const MAX_TRACKED_ATTEMPTS = 500;
const recentAttempts = new Map<string, { at: number; result: Promise<SkinRefreshResult> }>();

function pruneAttempts(now: number): void {
  if (recentAttempts.size < MAX_TRACKED_ATTEMPTS) return;
  for (const [id, entry] of recentAttempts) {
    if (now - entry.at >= ATTEMPT_COOLDOWN_MS) recentAttempts.delete(id);
  }
}

export async function POST(request: NextRequest) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const skinId = body && typeof body === 'object' ? (body as { skin_id?: unknown }).skin_id : undefined;

  if (typeof skinId !== 'string' || skinId.trim() === '') {
    return NextResponse.json({ error: 'skin_id (string) required' }, { status: 400 });
  }

  const now = Date.now();
  let entry = recentAttempts.get(skinId);
  if (!entry || now - entry.at >= ATTEMPT_COOLDOWN_MS) {
    pruneAttempts(now);
    entry = { at: now, result: refreshSkinPrices(skinId) };
    recentAttempts.set(skinId, entry);
  }

  let result: SkinRefreshResult;
  try {
    result = await entry.result;
  } catch (err) {
    // refreshSkinPrices only throws if the initial DB lookups fail; don't cache that.
    recentAttempts.delete(skinId);
    console.warn(`refresh-price ${skinId} failed: ${err}`);
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 });
  }

  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'Skin not found' }, { status: 404 });
  }

  return NextResponse.json(result);
}
