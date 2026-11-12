// The three background jobs as the cron routes and CLI scripts run them: take
// the job's lock, do one bounded slice of work, and record how it went.

import { type ImportStats, importMetadata } from '../metadata/import';
import { invalidateCatalog } from '../tradeup/catalog-db';
import { type ListingScanResult, listingScanSucceeded, runListingScan } from './listings-scan';
import { type SalesScanResult, runSalesScan, salesScanError, salesScanSucceeded } from './sales-scan';
import { type JobHealth, recordJobRun, withLock } from './state';

// A run killed by the platform never releases its lock, so each lock expires a
// little after the longest a run is allowed to take.
const LISTINGS_LOCK = { key: 'lock:listings', ttlMs: 6 * 60 * 1000 };
const SALES_LOCK = { key: 'lock:sales', ttlMs: 6 * 60 * 1000 };
const METADATA_LOCK = { key: 'lock:metadata', ttlMs: 10 * 60 * 1000 };

export type JobOutcome<T> =
  | { status: 'skipped'; reason: string }
  | { status: 'ok' | 'failed'; result: T; health: JobHealth }
  | { status: 'crashed'; error: string; health: JobHealth };

const SKIPPED = { status: 'skipped', reason: 'Another run holds the lock' } as const;

export async function runListingsJob(
  options: Parameters<typeof runListingScan>[0] = {},
): Promise<JobOutcome<ListingScanResult>> {
  const outcome = await withLock(LISTINGS_LOCK.key, LISTINGS_LOCK.ttlMs, async (): Promise<JobOutcome<ListingScanResult>> => {
    try {
      const result = await runListingScan(options);
      const ok = listingScanSucceeded(result);
      const health = await recordJobRun('listings', {
        ok,
        error: result.error ?? (result.stoppedBy === 'rate_limited' ? 'Rate limited by Steam' : `Stopped by ${result.stoppedBy}`),
        summary: { ...result },
      });
      if (result.pricesWritten > 0 || result.clearedUnlisted > 0) invalidateCatalog();
      return { status: ok ? 'ok' : 'failed', result, health };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'crashed', error: message, health: await recordJobRun('listings', { ok: false, error: message }) };
    }
  });
  return outcome ?? SKIPPED;
}

export async function runSalesJob(
  options: Parameters<typeof runSalesScan>[0] = {},
): Promise<JobOutcome<SalesScanResult>> {
  const outcome = await withLock(SALES_LOCK.key, SALES_LOCK.ttlMs, async (): Promise<JobOutcome<SalesScanResult>> => {
    try {
      const result = await runSalesScan(options);
      const ok = salesScanSucceeded(result);
      const health = await recordJobRun('sales', { ok, error: salesScanError(result), summary: { ...result } });
      if (result.salesWritten > 0 || result.unlistedMarked > 0) invalidateCatalog();
      return { status: ok ? 'ok' : 'failed', result, health };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'crashed', error: message, health: await recordJobRun('sales', { ok: false, error: message }) };
    }
  });
  return outcome ?? SKIPPED;
}

export async function runMetadataJob(log?: (message: string) => void): Promise<JobOutcome<ImportStats>> {
  const outcome = await withLock(METADATA_LOCK.key, METADATA_LOCK.ttlMs, async (): Promise<JobOutcome<ImportStats>> => {
    try {
      const result = await importMetadata(log);
      const health = await recordJobRun('metadata', {
        ok: true,
        summary: { upserted: result.upserted, pruned: result.pruned, warnings: result.warnings },
      });
      invalidateCatalog();
      return { status: 'ok', result, health };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'crashed', error: message, health: await recordJobRun('metadata', { ok: false, error: message }) };
    }
  });
  return outcome ?? SKIPPED;
}
