import { NextRequest, NextResponse } from 'next/server';
import { envInt, rejectUnauthorizedCron } from '@/lib/cron-auth';
import { type JobOutcome, runListingsJob, runSalesJob } from '@/lib/market/jobs';
import { LISTINGS_STATE_KEYS, type ListingScanResult } from '@/lib/market/listings-scan';
import type { SalesScanResult } from '@/lib/market/sales-scan';
import { decideSlice } from '@/lib/market/scheduler';
import { getStates, withLock } from '@/lib/market/state';
import { getSteamCooldown, noteRateLimited, noteSteamOk } from '@/lib/market/steam-guard';

// The only cron that talks to Steam. Each run takes `lock:steam`, so at most
// one invocation sends requests at a time, and spends one slice on either the
// listing scan or sale history (see src/lib/market/scheduler.ts). Two crons on
// the same schedule used to double the request rate and get rate-limited.
export const maxDuration = 300;

// Leaves headroom under maxDuration for the last request and the final writes.
const BUDGET_MS = 270_000;
// A run killed by the platform never releases the lock; it expires after this.
const STEAM_LOCK = { key: 'lock:steam', ttlMs: 6 * 60 * 1000 };
// Sale history is only worth starting with enough time for a few pages.
const MIN_SALES_BUDGET_MS = 60_000;

const log = (message: string) => console.log(`[scrape-steam] ${message}`);

type ListingsOutcome = JobOutcome<ListingScanResult>;
type SalesOutcome = JobOutcome<SalesScanResult>;

interface SliceReport {
  choice: 'cooldown' | 'listings' | 'sales';
  cooldown_until?: string;
  listings?: ListingsOutcome;
  sales?: SalesOutcome;
  rate_limited?: boolean;
}

const listingsRateLimited = (outcome: ListingsOutcome) =>
  'result' in outcome && outcome.result.stoppedBy === 'rate_limited';
const salesRateLimited = (outcome: SalesOutcome) => 'result' in outcome && outcome.result.rateLimited;
// Whether the slice actually got answers from Steam (so a 429 streak is over).
const listingsReachedSteam = (outcome: ListingsOutcome) => 'result' in outcome && outcome.result.pagesFetched > 0;
const salesReachedSteam = (outcome: SalesOutcome) => 'result' in outcome && outcome.result.pagesFetched > 0;

async function runSlice(): Promise<SliceReport> {
  const deadline = Date.now() + BUDGET_MS;
  const [cooldown, state] = await Promise.all([
    getSteamCooldown(),
    getStates([LISTINGS_STATE_KEYS.cycleStartedAt, LISTINGS_STATE_KEYS.lastCycleCompletedAt]),
  ]);

  const choice = decideSlice({
    now: Date.now(),
    cooldownUntil: cooldown.until?.getTime() ?? null,
    cycleStartedAt: state[LISTINGS_STATE_KEYS.cycleStartedAt] || null,
    lastCycleCompletedAt: state[LISTINGS_STATE_KEYS.lastCycleCompletedAt] || null,
    cycleIntervalHours: envInt('LISTINGS_CYCLE_INTERVAL_HOURS', 6),
  });

  if (choice === 'cooldown') {
    log(`Steam cooldown until ${cooldown.until?.toISOString()}; not sending requests`);
    return { choice, cooldown_until: cooldown.until?.toISOString() };
  }

  const report: SliceReport = { choice };
  let reachedSteam = false;

  if (choice === 'listings') {
    report.listings = await runListingsJob({
      budgetMs: deadline - Date.now(),
      maxPages: envInt('SCRAPER_MAX_PAGES_PER_RUN', 80),
      log,
    });
    reachedSteam = listingsReachedSteam(report.listings);
    if (listingsRateLimited(report.listings)) report.rate_limited = true;
  }

  // Sale history gets the slice when no listing pass is due, and whatever is
  // left of a slice that finished a pass.
  const passFinished =
    report.listings && 'result' in report.listings && report.listings.result.completedCycle;
  const salesBudget = deadline - Date.now();
  if (!report.rate_limited && (choice === 'sales' || passFinished) && salesBudget >= MIN_SALES_BUDGET_MS) {
    report.sales = await runSalesJob({
      budgetMs: salesBudget,
      staleHours: envInt('SALES_STALE_HOURS', 24),
      concurrency: envInt('SALES_SCAN_CONCURRENCY', 2),
      log,
    });
    reachedSteam ||= salesReachedSteam(report.sales);
    if (salesRateLimited(report.sales)) report.rate_limited = true;
  }

  if (report.rate_limited) {
    const until = await noteRateLimited();
    report.cooldown_until = until.toISOString();
    log(`Rate limited by Steam; backing off until ${report.cooldown_until}`);
  } else if (reachedSteam) {
    await noteSteamOk();
  }
  return report;
}

export async function GET(request: NextRequest) {
  const rejected = rejectUnauthorizedCron(request);
  if (rejected) return rejected;

  const report = await withLock(STEAM_LOCK.key, STEAM_LOCK.ttlMs, runSlice);
  if (!report) return NextResponse.json({ status: 'skipped', reason: 'Another run holds lock:steam' });

  // Always 200 for a slice that was handled; the body and each job's health
  // record say how it went. A crash is the only 500.
  const crashed = report.listings?.status === 'crashed' || report.sales?.status === 'crashed';
  return NextResponse.json(report, { status: crashed ? 500 : 200 });
}
