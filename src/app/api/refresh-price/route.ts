import { NextRequest, NextResponse } from 'next/server';
import { type SkinRefreshResult, refreshSkin } from '@/lib/market/skin-refresh';

// A refresh is a few search pages a few seconds apart plus one listing page
// that can take 25 seconds to download.
export const maxDuration = 120;

// Best-effort guard per server instance: a page reloaded in a loop must not
// stack Steam requests. Concurrent callers for one skin share one in-flight
// refresh, and callers within the cooldown get the last result back. Instances
// are recycled, so the browser keeps its own guard as well.
const COOLDOWN_MS = 60_000;
const MAX_TRACKED = 500;
const recent = new Map<string, { at: number; result: Promise<SkinRefreshResult> }>();

function prune(now: number): void {
  if (recent.size < MAX_TRACKED) return;
  for (const [id, entry] of recent) {
    if (now - entry.at >= COOLDOWN_MS) recent.delete(id);
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
  let entry = recent.get(skinId);
  if (!entry || now - entry.at >= COOLDOWN_MS) {
    prune(now);
    entry = { at: now, result: refreshSkin(skinId) };
    recent.set(skinId, entry);
  }

  let result: SkinRefreshResult;
  try {
    result = await entry.result;
  } catch (error) {
    // Only a database failure gets here; do not hand it to the next caller.
    recent.delete(skinId);
    console.warn(`[refresh-price] ${skinId} failed: ${error}`);
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 });
  }

  if (result.status === 'not_found') return NextResponse.json({ error: 'Skin not found' }, { status: 404 });
  return NextResponse.json(result);
}
