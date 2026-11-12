// Float math for trade-up contracts (normalized formula, in the game since
// 2025-10-22):
//
//   t_i    = (float_i - skin_min_i) / (skin_max_i - skin_min_i)   per input
//   avg_t  = sum(t_i) / n
//   output = out_min + avg_t * (out_max - out_min)                 per outcome
//
// A market listing only tells us an input's wear, not its float, so most of
// this module works with intervals: the range of avg_t a set of input wears can
// produce, and the range of avg_t a requested output wear needs.

export const WEARS = [
  { name: 'Factory New', min: 0, max: 0.07 },
  { name: 'Minimal Wear', min: 0.07, max: 0.15 },
  { name: 'Field-Tested', min: 0.15, max: 0.38 },
  { name: 'Well-Worn', min: 0.38, max: 0.45 },
  { name: 'Battle-Scarred', min: 0.45, max: 1 },
] as const;

export const WEAR_NAMES: readonly string[] = WEARS.map((wear) => wear.name);

// Wear label used for unpainted knives, which have no exterior.
export const VANILLA_WEAR = 'Vanilla';

// The floats where one wear ends and the next begins.
const WEAR_BOUNDARIES = [0.07, 0.15, 0.38, 0.45];

const EPSILON = 1e-9;

export interface Interval {
  lo: number;
  hi: number;
}

export function width(interval: Interval): number {
  return interval.hi - interval.lo;
}

export function midpoint(interval: Interval): number {
  return (interval.lo + interval.hi) / 2;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export function wearForFloat(float: number): string {
  if (float < 0.07) return 'Factory New';
  if (float < 0.15) return 'Minimal Wear';
  if (float < 0.38) return 'Field-Tested';
  if (float < 0.45) return 'Well-Worn';
  return 'Battle-Scarred';
}

export function normalizeFloat(float: number, skinMin: number, skinMax: number): number {
  if (skinMax <= skinMin) return 0;
  return clamp((float - skinMin) / (skinMax - skinMin), 0, 1);
}

export function outputFloat(avgNormalized: number, outMin: number, outMax: number): number {
  return outMin + avgNormalized * (outMax - outMin);
}

// The part of a wear's float range a given skin can actually have, or null when
// the skin does not exist in that wear.
export function wearFloatRange(wearName: string, skinMin: number, skinMax: number): Interval | null {
  const wear = WEARS.find((candidate) => candidate.name === wearName);
  if (!wear) return null;

  if (skinMax <= skinMin) {
    // A skin with a single possible float: it has exactly one wear.
    return wearForFloat(skinMin) === wearName ? { lo: skinMin, hi: skinMin } : null;
  }

  const lo = Math.max(wear.min, skinMin);
  const hi = Math.min(wear.max, skinMax);
  return hi - lo > EPSILON ? { lo, hi } : null;
}

// Same range expressed as normalized floats (the t in the formula above).
export function wearNormalizedRange(wearName: string, skinMin: number, skinMax: number): Interval | null {
  const range = wearFloatRange(wearName, skinMin, skinMax);
  if (!range) return null;
  if (skinMax <= skinMin) return { lo: 0, hi: 0 };
  return {
    lo: normalizeFloat(range.lo, skinMin, skinMax),
    hi: normalizeFloat(range.hi, skinMin, skinMax),
  };
}

// Overlap of two intervals. A zero-width interval (an exact float) overlaps
// when it lies inside the other; two ranges that merely touch do not overlap,
// because a contract cannot be aimed at a single boundary value.
export function intersect(a: Interval, b: Interval): Interval | null {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  const aIsPoint = width(a) <= EPSILON;
  const bIsPoint = width(b) <= EPSILON;

  if (aIsPoint || bIsPoint) {
    const point = aIsPoint ? a.lo : b.lo;
    const other = aIsPoint ? b : a;
    // Wear ranges are closed at the bottom and open at the top, except that
    // nothing lies above the top of the normalized range.
    const insideTop = point < other.hi - EPSILON || (other.hi >= 1 - EPSILON && point <= other.hi + EPSILON);
    return point >= other.lo - EPSILON && insideTop ? { lo: point, hi: point } : null;
  }

  return hi - lo > EPSILON ? { lo, hi } : null;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return inner.lo >= outer.lo - EPSILON && inner.hi <= outer.hi + EPSILON;
}

// Distance between two intervals that do not overlap (0 when they do).
export function gap(a: Interval, b: Interval): number {
  if (a.hi < b.lo) return b.lo - a.hi;
  if (b.hi < a.lo) return a.lo - b.hi;
  return 0;
}

// The normalized floats at which an outcome with this float range changes wear.
export function wearBreakpoints(outMin: number, outMax: number): number[] {
  if (outMax <= outMin) return [];
  const points: number[] = [];
  for (const boundary of WEAR_BOUNDARIES) {
    const t = (boundary - outMin) / (outMax - outMin);
    if (t > EPSILON && t < 1 - EPSILON) points.push(t);
  }
  return points;
}

// Split an interval at the given points. Every returned piece has the same
// outcome wears throughout, so evaluating its midpoint describes all of it.
export function splitAt(interval: Interval, points: number[]): Interval[] {
  if (width(interval) <= EPSILON) return [interval];
  const cuts = [...new Set(points)]
    .filter((point) => point > interval.lo + EPSILON && point < interval.hi - EPSILON)
    .sort((a, b) => a - b);
  const pieces: Interval[] = [];
  let lo = interval.lo;
  for (const cut of cuts) {
    pieces.push({ lo, hi: cut });
    lo = cut;
  }
  pieces.push({ lo, hi: interval.hi });
  return pieces;
}
