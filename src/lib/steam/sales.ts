// Turns a sale history into the single figure the site values outcomes at:
// the average price of the most recent individual sales.

import type { SaleBucket } from './listing-page';

export const RECENT_SALES_COUNT = 5;

export interface RecentSales {
  // Average price of the counted sales, in whole currency units.
  averagePrice: number;
  // How many sales went into it (fewer than requested when the item is rare).
  sampleCount: number;
  // When the most recent sale happened (ISO 8601).
  lastSaleAt: string;
}

// Steam reports history as periods (an hour or a day) with a median price and
// a number of purchases. Walk back from the newest period, counting each
// purchase at its period's median, until `count` sales are collected.
export function summarizeRecentSales(history: SaleBucket[], count = RECENT_SALES_COUNT): RecentSales | null {
  const newestFirst = [...history].sort((a, b) => b.time - a.time);

  let collected = 0;
  let sum = 0;
  let lastSaleAt: string | null = null;

  for (const period of newestFirst) {
    if (collected >= count) break;
    if (!(period.price > 0) || !(period.count > 0) || !Number.isFinite(period.time)) continue;
    if (lastSaleAt == null) lastSaleAt = new Date(period.time * 1000).toISOString();
    const take = Math.min(period.count, count - collected);
    sum += period.price * take;
    collected += take;
  }

  if (collected === 0 || lastSaleAt == null) return null;
  return { averagePrice: sum / collected, sampleCount: collected, lastSaleAt };
}
