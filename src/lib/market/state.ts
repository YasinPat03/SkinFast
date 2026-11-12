// Small key/value store (the `scrape_state` table) for scraper progress, locks
// and a health record per background job.

import sql from '../db';

export async function getState(key: string): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`SELECT value FROM scrape_state WHERE key = ${key}`;
  return rows.length > 0 ? rows[0].value : null;
}

export async function getStates(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const rows = await sql<{ key: string; value: string }[]>`
    SELECT key, value FROM scrape_state WHERE key = ANY(${keys})
  `;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export async function setState(key: string, value: string): Promise<void> {
  await sql`
    INSERT INTO scrape_state (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function setStates(values: Record<string, string>): Promise<void> {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value }));
  if (rows.length === 0) return;
  await sql`
    INSERT INTO scrape_state ${sql(rows, 'key', 'value')}
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function getJsonState<T>(key: string): Promise<T | null> {
  const raw = await getState(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Locks ───────────────────────────────────────────────────────────

// Take a lock unless someone else took it less than `ttlMs` ago. The check and
// the write are a single statement, so two overlapping cron invocations cannot
// both win. A holder that is killed never releases; the TTL covers that.
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - ttlMs).toISOString();
  const rows = await sql`
    INSERT INTO scrape_state (key, value) VALUES (${key}, ${now.toISOString()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    WHERE scrape_state.value = '' OR scrape_state.value < ${staleBefore}
    RETURNING key
  `;
  return rows.length > 0;
}

export async function releaseLock(key: string): Promise<void> {
  await setState(key, '');
}

// Run `work` while holding a lock; returns null without running it when another
// run holds the lock. The lock is released on every exit path that reaches us.
export async function withLock<T>(key: string, ttlMs: number, work: () => Promise<T>): Promise<T | null> {
  if (!(await acquireLock(key, ttlMs))) return null;
  try {
    return await work();
  } finally {
    try {
      await releaseLock(key);
    } catch (error) {
      console.error(`[lock] failed to release ${key}: ${error}`);
    }
  }
}

// ── Job health ──────────────────────────────────────────────────────

export type JobName = 'listings' | 'sales' | 'metadata';

export interface JobHealth {
  last_run_at: string | null;
  // Last run that did what it is for (wrote data, or confirmed there was nothing to do).
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  last_summary: Record<string, unknown> | null;
}

const EMPTY_HEALTH: JobHealth = {
  last_run_at: null,
  last_ok_at: null,
  last_error_at: null,
  last_error: null,
  consecutive_failures: 0,
  last_summary: null,
};

const jobKey = (job: JobName) => `job:${job}`;

export async function getJobHealth(job: JobName): Promise<JobHealth> {
  return { ...EMPTY_HEALTH, ...(await getJsonState<Partial<JobHealth>>(jobKey(job))) };
}

// Record how a run went, so a job that has been failing for days is visible on
// the status endpoint instead of only in logs nobody reads.
export async function recordJobRun(
  job: JobName,
  outcome: { ok: boolean; error?: string | null; summary?: Record<string, unknown> },
): Promise<JobHealth> {
  const previous = await getJobHealth(job);
  const now = new Date().toISOString();
  const next: JobHealth = {
    last_run_at: now,
    last_ok_at: outcome.ok ? now : previous.last_ok_at,
    last_error_at: outcome.ok ? previous.last_error_at : now,
    last_error: outcome.ok ? previous.last_error : (outcome.error ?? 'unknown error'),
    consecutive_failures: outcome.ok ? 0 : previous.consecutive_failures + 1,
    last_summary: outcome.summary ?? null,
  };
  await setState(jobKey(job), JSON.stringify(next));
  return next;
}
