// Evaluating one concrete contract: who can come out, with what probability,
// at what float, and what that is worth. Pure functions over the catalog.

import {
  type Catalog,
  type ContractShape,
  type Item,
  type Pool,
  type Variant,
  outcomeVariantOf,
  outcomesOf,
} from './catalog';
import {
  type Interval,
  VANILLA_WEAR,
  normalizeFloat,
  outputFloat,
  splitAt,
  wearBreakpoints,
  wearForFloat,
  wearNormalizedRange,
} from './float';

// One input slot. `float` is the item's exact float when the caller knows it;
// null means "some listing of this wear", i.e. anywhere in the wear's range.
export interface Slot {
  pool: Pool;
  item: Item;
  variant: Variant;
  float: number | null;
}

export interface OutcomeChance {
  item: Item;
  probability: number;
  // Display name of a pool this outcome rolls from (the first one seen).
  poolName: string;
}

// P(outcome) = sum over pools of (inputs from pool / total inputs) / (outcomes in pool).
// Returns null when some input's pool has no possible outcome: the game refuses
// such a contract, so there is nothing to evaluate.
export function outcomeDistribution(
  poolCounts: Iterable<[Pool, number]>,
  shape: ContractShape,
): OutcomeChance[] | null {
  const chances = new Map<string, OutcomeChance>();
  let total = 0;
  const entries = [...poolCounts];
  for (const [, count] of entries) total += count;
  if (total === 0) return null;

  for (const [pool, count] of entries) {
    const outcomes = outcomesOf(pool, shape);
    if (outcomes.length === 0) return null;
    const share = count / total / outcomes.length;
    for (const item of outcomes) {
      const existing = chances.get(item.key);
      if (existing) existing.probability += share;
      else {
        chances.set(item.key, {
          item,
          probability: share,
          poolName: shape.kind === 'gold' ? (pool.caseName ?? pool.name) : pool.name,
        });
      }
    }
  }
  return [...chances.values()];
}

export function countPools(slots: Slot[]): Map<Pool, number> {
  const counts = new Map<Pool, number>();
  for (const slot of slots) counts.set(slot.pool, (counts.get(slot.pool) ?? 0) + 1);
  return counts;
}

// The normalized float a slot contributes: a point when the float is known,
// otherwise the whole range of its wear.
export function slotRange(slot: Slot): Interval {
  const { item, variant } = slot;
  if (slot.float != null) {
    const t = normalizeFloat(slot.float, item.minFloat, item.maxFloat);
    return { lo: t, hi: t };
  }
  return wearNormalizedRange(variant.wear, item.minFloat, item.maxFloat) ?? { lo: 0, hi: 1 };
}

// Every average normalized float the slots can produce.
export function contractEnvelope(slots: Slot[]): Interval {
  let lo = 0;
  let hi = 0;
  for (const slot of slots) {
    const range = slotRange(slot);
    lo += range.lo;
    hi += range.hi;
  }
  return { lo: lo / slots.length, hi: hi / slots.length };
}

// The wear an outcome comes out in for a given average normalized float.
export function outcomeWearAt(item: Item, avgNormalized: number): { float: number; wear: string } {
  // Unpainted knives have no exterior; the game gives them float 0.
  if (item.vanilla) return { float: 0, wear: VANILLA_WEAR };
  const float = outputFloat(avgNormalized, item.minFloat, item.maxFloat);
  return { float, wear: wearForFloat(float) };
}

export interface PricedOutcome {
  item: Item;
  poolName: string;
  probability: number;
  float: number;
  wear: string;
  variant: Variant | null;
  // Average of the last 5 Steam sales of exactly this variant. Never a listing
  // price and never another wear; null when there is no sale on record.
  saleCents: number | null;
  // Whether exactly this variant has an active Steam listing right now.
  listed: boolean;
}

export interface PricedContract {
  avgNormalized: number;
  outcomes: PricedOutcome[];
  // Sum of probability x sale price over priced outcomes (unpriced count as 0).
  expectedReturnCents: number;
  hasUnlistedOutcomes: boolean;
  hasUnpricedOutcomes: boolean;
}

export function priceOutcomes(
  chances: OutcomeChance[],
  shape: ContractShape,
  avgNormalized: number,
): PricedContract {
  let expectedReturnCents = 0;
  let hasUnlistedOutcomes = false;
  let hasUnpricedOutcomes = false;
  const outcomes: PricedOutcome[] = [];

  for (const chance of chances) {
    const { float, wear } = outcomeWearAt(chance.item, avgNormalized);
    const variant = outcomeVariantOf(chance.item, shape, wear);
    const saleCents = variant?.saleCents ?? null;
    const listed = variant?.listingCents != null;

    if (saleCents != null) expectedReturnCents += saleCents * chance.probability;
    else hasUnpricedOutcomes = true;
    if (!listed) hasUnlistedOutcomes = true;

    outcomes.push({
      item: chance.item,
      poolName: chance.poolName,
      probability: chance.probability,
      float,
      wear,
      variant,
      saleCents,
      listed,
    });
  }

  return { avgNormalized, outcomes, expectedReturnCents, hasUnlistedOutcomes, hasUnpricedOutcomes };
}

// Split a range of average normalized floats into pieces within which no
// outcome changes wear. Pricing the midpoint of a piece prices all of it.
export function constantWearPieces(chances: OutcomeChance[], range: Interval): Interval[] {
  const points: number[] = [];
  for (const chance of chances) {
    if (chance.item.vanilla) continue;
    points.push(...wearBreakpoints(chance.item.minFloat, chance.item.maxFloat));
  }
  return splitAt(range, points);
}

export interface OutcomeSpread {
  // Every wear the outcome can come out in across the range.
  wears: string[];
  // Those of them with no active listing / no sale on record.
  unlistedWears: string[];
  unpricedWears: string[];
}

export interface Spread {
  minReturnCents: number;
  maxReturnCents: number;
  byItem: Map<string, OutcomeSpread>;
  hasUnlistedOutcomes: boolean;
  hasUnpricedOutcomes: boolean;
}

// How much the result can move while staying inside `range`: the lowest and
// highest expected return, and which wears each outcome can take. A contract
// only counts as fully listed when that holds for every float in the range,
// not just for the one float it happens to be priced at.
export function spreadOver(chances: OutcomeChance[], shape: ContractShape, range: Interval): Spread {
  let minReturnCents = Infinity;
  let maxReturnCents = -Infinity;
  let hasUnlistedOutcomes = false;
  let hasUnpricedOutcomes = false;
  const byItem = new Map<string, OutcomeSpread>();

  for (const piece of constantWearPieces(chances, range)) {
    const priced = priceOutcomes(chances, shape, (piece.lo + piece.hi) / 2);
    minReturnCents = Math.min(minReturnCents, priced.expectedReturnCents);
    maxReturnCents = Math.max(maxReturnCents, priced.expectedReturnCents);
    hasUnlistedOutcomes ||= priced.hasUnlistedOutcomes;
    hasUnpricedOutcomes ||= priced.hasUnpricedOutcomes;

    for (const outcome of priced.outcomes) {
      let spread = byItem.get(outcome.item.key);
      if (!spread) {
        spread = { wears: [], unlistedWears: [], unpricedWears: [] };
        byItem.set(outcome.item.key, spread);
      }
      if (spread.wears.includes(outcome.wear)) continue;
      spread.wears.push(outcome.wear);
      if (!outcome.listed) spread.unlistedWears.push(outcome.wear);
      if (outcome.saleCents == null) spread.unpricedWears.push(outcome.wear);
    }
  }

  return { minReturnCents, maxReturnCents, byItem, hasUnlistedOutcomes, hasUnpricedOutcomes };
}

export function totalCostCents(slots: Slot[]): number {
  let total = 0;
  for (const slot of slots) total += slot.variant.listingCents ?? 0;
  return total;
}

export function findPool(catalog: Catalog, poolId: string): Pool | null {
  return catalog.pools.get(poolId) ?? null;
}
