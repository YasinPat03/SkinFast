import { NextRequest, NextResponse } from 'next/server';
import { scrapeChunk, getScrapeState, saveScrapeState } from '@/lib/scraper';

// Max pages per cron invocation. Steam returns 10 items per page, so 60 pages
// ≈ 600 items ≈ 250 s at 3–5 s spacing; a clean full cycle over ~35k items is
// ~59 runs ≈ 5 h at the */5 cadence. The wall-clock budget below stops a run
// early regardless of page count. Override with SCRAPER_MAX_PAGES_PER_RUN.
const MAX_PAGES_PER_RUN = parseInt(process.env.SCRAPER_MAX_PAGES_PER_RUN ?? '60', 10);
const SCRAPE_BUDGET_MS = 240_000;

// Lock timeout: if a previous run's lock is older than this, assume it was
// killed and proceed. Slightly longer than one run's worst case (budget plus a
// final page and one 15 s 429 retry) so a killed run wastes one tick, not two.
const LOCK_TIMEOUT_MS = 6 * 60 * 1000;

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
    const result = await scrapeChunk(MAX_PAGES_PER_RUN, { budgetMs: SCRAPE_BUDGET_MS });

    return NextResponse.json({
      status: 'ok',
      pages_scraped: result.pagesScraped,
      items_scraped: result.itemsScraped,
      start_offset: result.startOffset,
      end_offset: result.offset,
      total_count: result.totalCount,
      completed_full_cycle: result.completed,
      rate_limited: result.rateLimited,
      last_full_scrape: await getScrapeState('last_full_scrape'),
    });
  } catch (err) {
    return NextResponse.json({
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    }, { status: 500 });
  } finally {
    // Every exit path clears the lock. (A run killed by the platform still
    // can't reach this; the LOCK_TIMEOUT_MS fallback covers that case.)
    try {
      await saveScrapeState('scrape_in_progress', '');
    } catch (err) {
      console.error(`[scrape-prices] failed to clear lock: ${err}`);
    }
  }
}
