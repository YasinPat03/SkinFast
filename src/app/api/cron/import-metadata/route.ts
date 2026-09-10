import { NextRequest, NextResponse } from 'next/server';
import { importMetadata } from '@/lib/import-metadata';
import { getScrapeState, saveScrapeState } from '@/lib/scraper';

// Pulls new skins/collections/crates from ByMykel's CSGO-API so that new drops
// (e.g. Armory collections) appear on the site without a manual import.
// Scheduled daily in vercel.json. Upsert-only, so it is safe to run at any time.

const LOCK_KEY = 'metadata_import_in_progress';

// If a previous run's lock is older than this, assume it crashed and proceed.
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

// A batched run takes well under a minute, but the four JSON files total ~50MB
// and GitHub can be slow, so allow the full Vercel Pro window.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Auth: verify CRON_SECRET (Vercel sends Authorization: Bearer <secret>)
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Check lock to prevent overlapping runs
  const lockTime = await getScrapeState(LOCK_KEY);
  if (lockTime) {
    const lockAge = Date.now() - new Date(lockTime).getTime();
    if (lockAge < LOCK_TIMEOUT_MS) {
      return NextResponse.json({
        status: 'skipped',
        reason: 'Another metadata import is in progress',
        lock_age_seconds: Math.round(lockAge / 1000),
      });
    }
    // Lock is stale, proceed anyway
  }

  await saveScrapeState(LOCK_KEY, new Date().toISOString());

  try {
    const stats = await importMetadata((msg) => console.log(`[import-metadata] ${msg}`));

    await saveScrapeState(LOCK_KEY, '');

    return NextResponse.json({
      status: 'ok',
      ...stats,
      last_metadata_import: await getScrapeState('last_metadata_import'),
    });
  } catch (err) {
    await saveScrapeState(LOCK_KEY, '');

    return NextResponse.json({
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 });
  }
}
