// Turns an evaluated contract into the wire format shared by the finder and
// the exact-float endpoint, so both describe a contract in the same terms.

import {
  type ContractShape,
  type Item,
  type Pool,
  type Variant,
  poolDisplayName,
} from './catalog';
import { type OutcomeChance, outcomeWearAt, priceOutcomes, spreadOver } from './contract';
import {
  type Interval,
  VANILLA_WEAR,
  clamp,
  contains,
  gap,
  intersect,
  midpoint,
  normalizeFloat,
  wearFloatRange,
  wearNormalizedRange,
  width,
} from './float';
import type {
  FloatFit,
  TradeupCombo,
  TradeupConcreteInput,
  TradeupGroupedInput,
  TradeupOutcomeEvaluation,
} from './types';

const EPSILON = 1e-9;

// When only part of the possible float range lands the request, aim this far
// inside the usable part rather than at its very edge.
const EDGE_MARGIN = 0.15;

export const round4 = (value: number) => Math.round(value * 1e4) / 1e4;
export const round5 = (value: number) => Math.round(value * 1e5) / 1e5;

// The average normalized input float that makes `target` come out in `wear`,
// or null when the item does not exist in that wear.
export function targetWindow(target: Item, wear: string): Interval | null {
  if (target.vanilla) return wear === VANILLA_WEAR ? { lo: 0, hi: 1 } : null;
  if (target.maxFloat <= target.minFloat) {
    // A single possible float: the inputs cannot change the result.
    return outcomeWearAt(target, 0).wear === wear ? { lo: 0, hi: 1 } : null;
  }
  return wearNormalizedRange(wear, target.minFloat, target.maxFloat);
}

export interface Placement {
  fit: FloatFit;
  // The average normalized floats that land the request (null for a miss).
  allowed: Interval | null;
  // The point the contract is priced at.
  point: number;
  // Distance between what the inputs can produce and what the request needs.
  distance: number;
}

export function placeContract(envelope: Interval, target: Item, wear: string): Placement {
  const window = targetWindow(target, wear);
  const center = midpoint(envelope);

  if (width(envelope) <= EPSILON) {
    // Exact floats: there is a single result, so read the wear off it directly.
    const lands = window != null && outcomeWearAt(target, envelope.lo).wear === wear;
    return {
      fit: lands ? 'any' : 'miss',
      allowed: lands ? envelope : null,
      point: envelope.lo,
      distance: lands || !window ? 0 : gap(envelope, window),
    };
  }

  if (!window) return { fit: 'miss', allowed: null, point: center, distance: Infinity };

  const overlap = intersect(envelope, window);
  if (!overlap) {
    // Price the contract at the end of its range nearest the request, nudged
    // inside so it does not sit exactly on a wear boundary.
    const nudge = Math.min(1e-6, width(envelope) / 2);
    const point = envelope.hi <= window.lo + EPSILON ? envelope.hi - nudge : envelope.lo + nudge;
    return { fit: 'miss', allowed: null, point, distance: gap(envelope, window) };
  }

  if (contains(window, envelope)) return { fit: 'any', allowed: envelope, point: center, distance: 0 };

  const margin = width(overlap) * EDGE_MARGIN;
  return {
    fit: 'specific',
    allowed: overlap,
    point: clamp(center, overlap.lo + margin, overlap.hi - margin),
    distance: 0,
  };
}

export interface ComboSlot {
  pool: Pool;
  item: Item;
  variant: Variant;
  // Exact float supplied by the user, or null for "any listing of this wear".
  float: number | null;
  hitsTarget: boolean;
}

// Spread the chosen average across the slots: each slot sits at the same
// relative position inside its own wear range, which averages to `point`.
function slotFloats(slots: ComboSlot[], envelope: Interval, point: number): { float: number; normalized: number }[] {
  const position = width(envelope) > EPSILON ? clamp((point - envelope.lo) / width(envelope), 0, 1) : 0.5;
  return slots.map((slot) => {
    const { item, variant } = slot;
    if (slot.float != null) {
      const float = clamp(slot.float, item.minFloat, item.maxFloat);
      return { float, normalized: normalizeFloat(float, item.minFloat, item.maxFloat) };
    }
    const range = wearNormalizedRange(variant.wear, item.minFloat, item.maxFloat) ?? { lo: 0, hi: 1 };
    const normalized = range.lo + position * (range.hi - range.lo);
    return { float: item.minFloat + normalized * (item.maxFloat - item.minFloat), normalized };
  });
}

export function assembleCombo(args: {
  shape: ContractShape;
  target: Item;
  slots: ComboSlot[];
  chances: OutcomeChance[];
  envelope: Interval;
  placement: Placement;
}): TradeupCombo {
  const { shape, target, slots, chances, envelope, placement } = args;
  const lands = placement.fit !== 'miss';
  const exact = slots.every((slot) => slot.float != null);

  const priced = priceOutcomes(chances, shape, placement.point);
  const spread = spreadOver(chances, shape, placement.allowed ?? { lo: placement.point, hi: placement.point });

  let totalCost = 0;
  for (const slot of slots) totalCost += slot.variant.listingCents ?? 0;

  const targetProbability = chances.find((chance) => chance.item.key === target.key)?.probability ?? 0;
  const probability = lands ? targetProbability : 0;

  const floats = slotFloats(slots, envelope, placement.point);
  const concreteInputs: TradeupConcreteInput[] = slots.map((slot, index) => {
    const wearRange = wearFloatRange(slot.variant.wear, slot.item.minFloat, slot.item.maxFloat) ?? {
      lo: slot.item.minFloat,
      hi: slot.item.maxFloat,
    };
    return {
      slot: index + 1,
      skin_id: slot.item.primarySkinId,
      skin_name: slot.item.name,
      weapon_name: slot.item.weaponName,
      wear_name: slot.variant.wear,
      price_cents: slot.variant.listingCents ?? 0,
      is_souvenir: slot.variant.isSouvenir,
      collection_id: slot.pool.id,
      collection_name: poolDisplayName(slot.pool, shape),
      market_hash_name: slot.variant.marketHashName,
      image_url: slot.item.imageUrl,
      min_float: slot.item.minFloat,
      max_float: slot.item.maxFloat,
      wear_float_range: [round5(wearRange.lo), round5(wearRange.hi)],
      input_float: round5(floats[index].float),
      normalized_float: round5(floats[index].normalized),
      float_source: slot.float != null ? 'exact' : 'wear_assumption',
    };
  });

  const grouped = new Map<string, TradeupGroupedInput>();
  for (const slot of slots) {
    const key = `${slot.pool.id}|${slot.variant.marketHashName}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity++;
      continue;
    }
    grouped.set(key, {
      skin_id: slot.item.primarySkinId,
      skin_name: slot.item.name,
      weapon_name: slot.item.weaponName,
      wear_name: slot.variant.wear,
      price_cents: slot.variant.listingCents ?? 0,
      is_souvenir: slot.variant.isSouvenir,
      collection_id: slot.pool.id,
      collection_name: poolDisplayName(slot.pool, shape),
      market_hash_name: slot.variant.marketHashName,
      image_url: slot.item.imageUrl,
      quantity: 1,
      cannot_produce_target: !slot.hitsTarget,
    });
  }

  const outcomes: TradeupOutcomeEvaluation[] = priced.outcomes
    .map((outcome) => {
      const range = spread.byItem.get(outcome.item.key);
      return {
        skin_id: outcome.item.primarySkinId,
        skin_name: outcome.item.name,
        weapon_name: outcome.item.weaponName,
        collection_name: outcome.poolName,
        probability: round4(outcome.probability),
        price_cents: outcome.saleCents,
        last_sale_at: outcome.variant?.lastSaleAt ?? null,
        image_url: outcome.item.imageUrl,
        is_target: outcome.item.key === target.key,
        has_active_listing: outcome.listed,
        expected_float: round5(outcome.float),
        expected_wear: outcome.wear,
        possible_wears: range?.wears ?? [outcome.wear],
        unlisted_wears: range?.unlistedWears ?? (outcome.listed ? [] : [outcome.wear]),
        unpriced_wears: range?.unpricedWears ?? (outcome.saleCents == null ? [outcome.wear] : []),
      };
    })
    .sort((a, b) => b.probability - a.probability || Number(b.is_target) - Number(a.is_target));

  const tolerance =
    placement.fit === 'any'
      ? 1
      : placement.fit === 'specific' && placement.allowed
        ? width(placement.allowed) / width(envelope)
        : 0;

  return {
    rank: 0,
    float_fit: placement.fit,
    inputs: [...grouped.values()],
    concrete_inputs: concreteInputs,
    total_cost_cents: totalCost,
    probability: round4(probability),
    target_skin_probability: round4(targetProbability),
    target_matches_requested_wear: lands,
    cost_per_attempt_cents: probability > 0 ? Math.round(totalCost / probability) : null,
    ev_cents: Math.round(priced.expectedReturnCents - totalCost),
    ev_range_cents: [Math.round(spread.minReturnCents - totalCost), Math.round(spread.maxReturnCents - totalCost)],
    avg_normalized_float: round5(placement.point),
    possible_avg_normalized: [round5(envelope.lo), round5(envelope.hi)],
    required_avg_normalized: placement.allowed ? [round5(placement.allowed.lo), round5(placement.allowed.hi)] : null,
    float_tolerance: round4(tolerance),
    float_source: exact ? 'exact' : 'wear_assumption',
    requires_specific_floats: placement.fit === 'specific',
    all_outcomes: outcomes,
    has_unlisted_outcomes: spread.hasUnlistedOutcomes,
    has_unpriced_outcomes: spread.hasUnpricedOutcomes,
  };
}
