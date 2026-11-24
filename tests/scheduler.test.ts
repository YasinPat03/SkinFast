import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cooldownMs, decideSlice } from '../src/lib/market/scheduler';

const HOUR = 3_600_000;
const now = Date.parse('2026-11-24T12:00:00Z');
const base = { now, cooldownUntil: null, cycleStartedAt: null, lastCycleCompletedAt: null, cycleIntervalHours: 6 };
const hoursAgo = (hours: number) => new Date(now - hours * HOUR).toISOString();

test('an active cooldown sends nothing, whatever is due', () => {
  assert.equal(decideSlice({ ...base, cooldownUntil: now + 60_000, cycleStartedAt: hoursAgo(1) }), 'cooldown');
});

test('an expired cooldown no longer blocks', () => {
  assert.equal(decideSlice({ ...base, cooldownUntil: now - 1, lastCycleCompletedAt: hoursAgo(1) }), 'sales');
});

test('a listing pass in progress is finished first', () => {
  assert.equal(decideSlice({ ...base, cycleStartedAt: hoursAgo(1), lastCycleCompletedAt: hoursAgo(2) }), 'listings');
});

test('with no completed pass on record, listings run', () => {
  assert.equal(decideSlice(base), 'listings');
  assert.equal(decideSlice({ ...base, lastCycleCompletedAt: 'not a date' }), 'listings');
});

test('between passes, sale history gets the slice', () => {
  assert.equal(decideSlice({ ...base, lastCycleCompletedAt: hoursAgo(5.9) }), 'sales');
});

test('a new pass starts once the interval has passed', () => {
  assert.equal(decideSlice({ ...base, lastCycleCompletedAt: hoursAgo(6) }), 'listings');
  assert.equal(decideSlice({ ...base, lastCycleCompletedAt: hoursAgo(30) }), 'listings');
});

test('the 429 back-off doubles from 15 minutes and stops at 2 hours', () => {
  const minutes = [0, 1, 2, 3, 4, 5, 10].map((strikes) => cooldownMs(strikes) / 60_000);
  assert.deepEqual(minutes, [15, 15, 30, 60, 120, 120, 120]);
});
