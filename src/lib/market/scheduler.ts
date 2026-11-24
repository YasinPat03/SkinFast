// Decides what one cron slice spends its Steam requests on, and how long to
// back off after a 429. Pure functions over state read elsewhere, so the
// policy is testable without a database.
//
// Why one decision per slice: Steam limits by request rate per IP, and a
// per-process pacer cannot see other invocations. When the listing scan and the
// sale-history scan ran as two crons on the same schedule, they doubled the
// rate, drew 429s, and kept extending the ban. Now one cron does both, one
// at a time.

export type SliceChoice = 'cooldown' | 'listings' | 'sales';

export interface SliceInput {
  now: number;
  // When the current 429 back-off ends (ms since epoch), or null.
  cooldownUntil: number | null;
  // `listings:cycle_started_at`: non-empty while a pass is part-way through.
  cycleStartedAt: string | null;
  // `listings:last_cycle_completed_at`.
  lastCycleCompletedAt: string | null;
  // How long after one listing pass finishes the next one starts.
  cycleIntervalHours: number;
}

// Listings come first because they carry the freshness promise (every listed
// price confirmed within 24 hours). A pass takes about 2 hours of request time;
// between passes, sale history gets all the time.
export function decideSlice(input: SliceInput): SliceChoice {
  if (input.cooldownUntil != null && input.cooldownUntil > input.now) return 'cooldown';
  if (input.cycleStartedAt) return 'listings';
  if (!input.lastCycleCompletedAt) return 'listings';
  const completedAt = new Date(input.lastCycleCompletedAt).getTime();
  if (!Number.isFinite(completedAt)) return 'listings';
  return input.now - completedAt >= input.cycleIntervalHours * 3_600_000 ? 'listings' : 'sales';
}

const BASE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_MS = 2 * 60 * 60 * 1000;

// Back-off after the `strikes`-th 429 in a row: 15, 30, 60, then 120 minutes.
export function cooldownMs(strikes: number): number {
  const n = Math.max(1, Math.floor(strikes));
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (n - 1));
}
