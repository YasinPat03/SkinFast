import { NextRequest, NextResponse } from 'next/server';

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Returns the
// response to send when the caller is not allowed, or null when it is.
//
// With no CRON_SECRET configured the endpoints are open (as they always have
// been); that is logged loudly because anyone could then trigger a scrape.
export function rejectUnauthorizedCron(request: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[cron] CRON_SECRET is not set: cron endpoints are publicly callable');
    }
    return null;
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
