import { NextRequest, NextResponse } from 'next/server';
import { scrapeChunk, getScrapeState, saveScrapeState } from '@/lib/scraper';

// Max pages per cron invocation. ~60 pages × 4s = ~240s, fits in Vercel Pro 300s timeout.
// Override with SCRAPER_MAX_PAGES_PER_RUN env var.
const MAX_PAGES_PER_RUN = parseInt(process.env.SCRAPER_MAX_PAGES_PER_RUN ?? '60', 10);

// Lock timeout: if a previous run's lock is older than this, assume it crashed
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const maxDuration = 300; // Vercel Pro max

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
  const lockTime = await getScrapeState('scrape_in_progress');
  if (lockTime) {
    const lockAge = Date.now() - new Date(lockTime).getTime();
    if (lockAge < LOCK_TIMEOUT_MS) {
      return NextResponse.json({
        status: 'skipped',
        reason: 'Another scrape is in progress',
        lock_age_seconds: Math.round(lockAge / 1000),
      });
    }
    // Lock is stale, proceed anyway
  }

  // Set lock
  await saveScrapeState('scrape_in_progress', new Date().toISOString());

  try {
    const result = await scrapeChunk(MAX_PAGES_PER_RUN);

    // Clear lock
    await saveScrapeState('scrape_in_progress', '');

    return NextResponse.json({
      status: 'ok',
      pages_scraped: result.pagesScraped,
      items_scraped: result.itemsScraped,
      offset: result.offset,
      total_count: result.totalCount,
      completed_full_cycle: result.completed,
      last_full_scrape: await getScrapeState('last_full_scrape'),
    });
  } catch (err) {
    // Clear lock on error so next invocation can proceed
    await saveScrapeState('scrape_in_progress', '');

    return NextResponse.json({
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 });
  }
}
