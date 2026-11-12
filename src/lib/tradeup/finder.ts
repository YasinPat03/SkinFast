// Finds the best contracts for landing one specific skin in one specific wear.
//
// A listing tells us an input's wear but not its float, so each candidate is
// classified by what its wears can produce (see FloatFit in types.ts) instead
// of guessing a float per wear:
//   any      - the request lands whatever floats the listings have
//   specific - it lands only for some floats; shown separately and labelled
//   miss     - it cannot land; only shown when nothing else exists
//
// Candidates are contracts built from at most two different listings: one
// input repeated, two inputs from the target's own collection(s), or one of
// those plus one cheaper "filler" from another collection. Those are the
// contracts people actually assemble, and the space is small enough to
// evaluate exhaustively and exactly.

import {
  type Catalog,
  type ContractShape,
  type Item,
  type Pool,
  type Variant,
  inputItemsOf,
  inputVariantsOf,
  outcomeVariantOf,
  outcomesOf,
  shapeForTarget,
} from './catalog';
import { type ComboSlot, type Placement, assembleCombo, placeContract, round5, targetWindow } from './combo';
import { type OutcomeChance, constantWearPieces, outcomeDistribution, priceOutcomes } from './contract';
import {
  type Interval,
  midpoint,
  normalizeFloat,
  outputFloat,
  wearFloatRange,
  wearForFloat,
  wearNormalizedRange,
} from './float';
import { EXCLUDED_COLLECTION_REASON, souvenirInputsAllowed } from './rules';
import type { ExactTradeupInput, TradeupCombo, TradeupFinderResult, TradeupSort } from './types';

const MAX_RESULTS = 5;
// Extra float-dependent options shown when they beat every any-float option.
const MAX_SPECIFIC_EXTRAS = 3;
// At most this many results built from the same set of input skins.
const MAX_PER_INPUT_SET = 2;
// Fillers are shortlisted by where their floats sit: the cheapest few in each
// tenth of the normalized range.
const FILLER_BUCKETS = 10;
const FILLERS_PER_BUCKET = 3;
const FILLERS_BY_VALUE = 12;
// A float-dependent option is shown beside any-float options only when it
// lands the request across at least this share of the floats its wears can have.
const MIN_EXTRA_TOLERANCE = 0.1;
// When nothing works with any float, options below this share are slivers:
// cheap on paper, nearly impossible to buy.
const MIN_WORKABLE_TOLERANCE = 0.02;

interface Option {
  pool: Pool;
  item: Item;
  variant: Variant;
  priceCents: number;
  range: Interval;
  hitsTarget: boolean;
}

interface Part {
  option: Option;
  quantity: number;
}

interface PieceSummary {
  range: Interval;
  expectedReturnCents: number;
  fullyListed: boolean;
}

interface Distribution {
  chances: OutcomeChance[];
  targetProbability: number;
  pieces: Interval[];
  summaries: (PieceSummary | undefined)[];
}

interface Draft {
  parts: Part[];
  costCents: number;
  envelope: Interval;
  distribution: Distribution;
  placement: Placement;
  costPerHit: number;
  evCents: number;
  fullyListed: boolean;
}

function gatherOptions(catalog: Catalog, shape: ContractShape, target: Item): Option[] {
  const options: Option[] = [];
  for (const pool of catalog.pools.values()) {
    const inputs = inputItemsOf(pool, shape);
    if (inputs.length === 0) continue;
    const hitsTarget = outcomesOf(pool, shape).includes(target);
    for (const item of inputs) {
      for (const variant of inputVariantsOf(item, shape)) {
        const range = wearNormalizedRange(variant.wear, item.minFloat, item.maxFloat);
        if (!range || variant.listingCents == null) continue;
        options.push({ pool, item, variant, priceCents: variant.listingCents, range, hitsTarget });
      }
    }
  }
  return options;
}

function shortlistFillers(fillers: Option[], shape: ContractShape, sort: TradeupSort): Option[] {
  const buckets = new Map<number, Option[]>();
  for (const option of [...fillers].sort((a, b) => a.priceCents - b.priceCents)) {
    const bucket = Math.min(FILLER_BUCKETS - 1, Math.floor(midpoint(option.range) * FILLER_BUCKETS));
    const list = buckets.get(bucket);
    if (!list) buckets.set(bucket, [option]);
    else if (list.length < FILLERS_PER_BUCKET) list.push(option);
  }
  const shortlist = new Set([...buckets.values()].flat());

  if (sort === 'ev') {
    // The cheapest fillers are not the most valuable ones. When ranking by EV,
    // also keep the fillers whose own collection pays best per input.
    const perPool = new Map<Pool, OutcomeChance[] | null>();
    const margin = (option: Option): number => {
      let chances = perPool.get(option.pool);
      if (chances === undefined) {
        chances = outcomeDistribution([[option.pool, 1]], shape);
        perPool.set(option.pool, chances);
      }
      if (!chances) return -Infinity;
      return priceOutcomes(chances, shape, midpoint(option.range)).expectedReturnCents / shape.size - option.priceCents;
    };
    const byMargin = fillers
      .map((option) => ({ option, margin: margin(option) }))
      .sort((a, b) => b.margin - a.margin)
      .slice(0, FILLERS_BY_VALUE);
    for (const { option } of byMargin) shortlist.add(option);
  }

  return [...shortlist];
}

function* enumerateParts(own: Option[], fillers: Option[], size: number): Generator<Part[]> {
  for (const option of own) yield [{ option, quantity: size }];

  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      for (let quantity = 1; quantity < size; quantity++) {
        yield [
          { option: own[i], quantity },
          { option: own[j], quantity: size - quantity },
        ];
      }
    }
  }

  for (const option of own) {
    for (const filler of fillers) {
      for (let quantity = 1; quantity < size; quantity++) {
        yield [
          { option, quantity },
          { option: filler, quantity: size - quantity },
        ];
      }
    }
  }
}

class DistributionCache {
  private readonly cache = new Map<string, Distribution | null>();

  constructor(
    private readonly shape: ContractShape,
    private readonly target: Item,
  ) {}

  get(parts: Part[]): Distribution | null {
    const counts = new Map<Pool, number>();
    for (const part of parts) counts.set(part.option.pool, (counts.get(part.option.pool) ?? 0) + part.quantity);
    const key = [...counts]
      .map(([pool, count]) => `${pool.id}:${count}`)
      .sort()
      .join('|');

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const chances = outcomeDistribution(counts, this.shape);
    const distribution = chances
      ? {
          chances,
          targetProbability: chances.find((chance) => chance.item.key === this.target.key)?.probability ?? 0,
          pieces: constantWearPieces(chances, { lo: 0, hi: 1 }),
          summaries: [],
        }
      : null;
    this.cache.set(key, distribution);
    return distribution;
  }

  // Expected return and listing status of one piece, priced once.
  private summary(distribution: Distribution, index: number): PieceSummary {
    let summary = distribution.summaries[index];
    if (!summary) {
      const range = distribution.pieces[index];
      const priced = priceOutcomes(distribution.chances, this.shape, midpoint(range));
      summary = {
        range,
        expectedReturnCents: priced.expectedReturnCents,
        fullyListed: !priced.hasUnlistedOutcomes,
      };
      distribution.summaries[index] = summary;
    }
    return summary;
  }

  summaryAt(distribution: Distribution, point: number): PieceSummary {
    let index = distribution.pieces.findIndex((piece) => point < piece.hi);
    if (index === -1) index = distribution.pieces.length - 1;
    return this.summary(distribution, index);
  }

  // Whether every outcome is listed for every float in the range, not just at
  // the one float the contract is priced at.
  fullyListedOver(distribution: Distribution, range: Interval): boolean {
    if (range.hi - range.lo <= 1e-9) return this.summaryAt(distribution, range.lo).fullyListed;
    for (let index = 0; index < distribution.pieces.length; index++) {
      const piece = distribution.pieces[index];
      if (piece.hi <= range.lo + 1e-9 || piece.lo >= range.hi - 1e-9) continue;
      if (!this.summary(distribution, index).fullyListed) return false;
    }
    return true;
  }
}

function draftOf(parts: Part[], size: number, target: Item, wear: string, cache: DistributionCache): Draft | null {
  const distribution = cache.get(parts);
  if (!distribution || distribution.targetProbability <= 0) return null;

  let costCents = 0;
  let lo = 0;
  let hi = 0;
  for (const { option, quantity } of parts) {
    costCents += option.priceCents * quantity;
    lo += option.range.lo * quantity;
    hi += option.range.hi * quantity;
  }
  const envelope = { lo: lo / size, hi: hi / size };
  const placement = placeContract(envelope, target, wear);
  const summary = cache.summaryAt(distribution, placement.point);

  return {
    parts,
    costCents,
    envelope,
    distribution,
    placement,
    costPerHit: placement.fit === 'miss' ? Infinity : costCents / distribution.targetProbability,
    evCents: summary.expectedReturnCents - costCents,
    fullyListed: placement.allowed ? cache.fullyListedOver(distribution, placement.allowed) : summary.fullyListed,
  };
}

function comparator(sort: TradeupSort): (a: Draft, b: Draft) => number {
  if (sort === 'ev') {
    return (a, b) => b.evCents - a.evCents || a.costPerHit - b.costPerHit || a.costCents - b.costCents;
  }
  return (a, b) => a.costPerHit - b.costPerHit || b.evCents - a.evCents || a.costCents - b.costCents;
}

function inputSetKey(draft: Draft): string {
  return [...new Set(draft.parts.map((part) => part.option.item.key))].sort().join('|');
}

// Share of the floats the chosen wears can have that still lands the request.
function tolerance(draft: Draft): number {
  const { fit, allowed } = draft.placement;
  if (fit === 'any') return 1;
  if (fit === 'miss' || !allowed) return 0;
  const possible = draft.envelope.hi - draft.envelope.lo;
  return possible > 0 ? (allowed.hi - allowed.lo) / possible : 0;
}

// Best drafts first, without letting one pair of skins fill the whole list
// with quantity variations of itself.
function takeDiverse(drafts: Draft[], limit: number): Draft[] {
  const taken: Draft[] = [];
  const perSet = new Map<string, number>();
  for (const draft of drafts) {
    if (taken.length >= limit) break;
    const key = inputSetKey(draft);
    const used = perSet.get(key) ?? 0;
    if (used >= MAX_PER_INPUT_SET) continue;
    perSet.set(key, used + 1);
    taken.push(draft);
  }
  return taken;
}

function comboOf(draft: Draft, shape: ContractShape, target: Item): TradeupCombo {
  const slots: ComboSlot[] = [];
  for (const { option, quantity } of draft.parts) {
    for (let i = 0; i < quantity; i++) {
      slots.push({
        pool: option.pool,
        item: option.item,
        variant: option.variant,
        float: null,
        hitsTarget: option.hitsTarget,
      });
    }
  }
  return assembleCombo({
    shape,
    target,
    slots,
    chances: draft.distribution.chances,
    envelope: draft.envelope,
    placement: draft.placement,
  });
}

function describeWindow(target: Item, wear: string): Pick<TradeupFinderResult['requested_wear'], 'output_float_range' | 'avg_normalized_range'> {
  const window = targetWindow(target, wear);
  if (!window || target.vanilla) return { output_float_range: null, avg_normalized_range: window ? [0, 1] : null };
  return {
    output_float_range: [
      round5(outputFloat(window.lo, target.minFloat, target.maxFloat)),
      round5(outputFloat(window.hi, target.minFloat, target.maxFloat)),
    ],
    avg_normalized_range: [round5(window.lo), round5(window.hi)],
  };
}

export function findBestTradeups(
  catalog: Catalog,
  targetSkinId: string,
  wear: string,
  statTrak: boolean,
  sort: TradeupSort = 'cost_per_hit',
): TradeupFinderResult | { error: string } {
  const target = catalog.itemBySkinId.get(targetSkinId);
  if (!target) return { error: 'Target skin not found' };

  const shape = shapeForTarget(target, statTrak);
  if ('error' in shape) return shape;

  const homePools = shape.kind === 'gold' ? catalog.rarePoolsByItem.get(target.key) : catalog.poolsByItem.get(target.key);
  if (shape.kind === 'standard' && (homePools ?? []).some((pool) => pool.excluded)) {
    return { error: EXCLUDED_COLLECTION_REASON };
  }

  const targetVariant = outcomeVariantOf(target, shape, wear);
  if (!targetVariant) {
    return { error: `${statTrak ? 'StatTrak ' : ''}${target.name} does not exist in ${wear}` };
  }

  const options = gatherOptions(catalog, shape, target);
  const own = options.filter((option) => option.hitsTarget);
  if (own.length === 0) {
    return {
      error:
        shape.kind === 'gold'
          ? 'No Covert inputs with an active Steam listing found in the same cases'
          : 'No inputs with an active Steam listing found in the same collections',
    };
  }
  const fillers = shortlistFillers(
    options.filter((option) => !option.hitsTarget),
    shape,
    sort,
  );

  const cache = new DistributionCache(shape, target);
  const drafts: Draft[] = [];
  let checked = 0;
  for (const parts of enumerateParts(own, fillers, shape.size)) {
    checked++;
    const draft = draftOf(parts, shape.size, target, wear, cache);
    if (draft) drafts.push(draft);
  }

  const compare = comparator(sort);
  const landing = drafts.filter((draft) => draft.placement.fit !== 'miss');

  // Never show a contract that drags in an outcome with no active listing
  // (typically a filler collection whose outputs are not on the market) when a
  // fully listed alternative of the same kind exists. When the target's own
  // collection has an unlisted outcome every contract carries it, so results
  // come back flagged instead. Applied per kind, so any-float options are
  // never hidden just because some float-dependent option is fully listed.
  const preferListed = (pool: Draft[]) => {
    const listed = pool.filter((draft) => draft.fullyListed);
    return listed.length > 0 ? listed : pool;
  };

  let chosen: Draft[];
  let anyFloatOption = false;
  if (landing.length > 0) {
    const anyFloat = preferListed(landing.filter((draft) => draft.placement.fit === 'any')).sort(compare);
    const specific = preferListed(landing.filter((draft) => draft.placement.fit === 'specific')).sort(compare);
    const atLeast = (share: number) => specific.filter((draft) => tolerance(draft) >= share);
    anyFloatOption = anyFloat.length > 0;

    if (anyFloat.length > 0) {
      const primary = takeDiverse(anyFloat, MAX_RESULTS);
      // Float-dependent options are only worth showing next to any-float ones
      // when they are better on the chosen measure and reasonably easy to buy.
      const better = atLeast(MIN_EXTRA_TOLERANCE).filter((draft) => compare(draft, primary[0]) < 0);
      chosen = [...primary, ...takeDiverse(better, MAX_SPECIFIC_EXTRAS)];
    } else {
      // Every option needs specific floats. Leave out the ones that only land
      // inside a sliver of their float range, unless slivers are all there is.
      const workable = atLeast(MIN_WORKABLE_TOLERANCE);
      chosen = takeDiverse(workable.length > 0 ? workable : specific, MAX_RESULTS);
    }
  } else {
    // Nothing lands the requested wear. Show what gets closest, labelled.
    const nearest = preferListed(drafts).sort(
      (a, b) => a.placement.distance - b.placement.distance || a.costCents - b.costCents,
    );
    chosen = takeDiverse(nearest, MAX_RESULTS);
  }

  return {
    requested_wear: {
      reachable: landing.length > 0,
      any_float_option: anyFloatOption,
      ...describeWindow(target, wear),
    },
    sort,
    target: {
      skin_id: targetSkinId,
      skin_name: target.name,
      weapon_name: target.weaponName,
      wear,
      is_stattrak: statTrak,
      price_cents: targetVariant.listingCents,
      has_active_listing: targetVariant.listingCents != null,
      last_sold_cents: targetVariant.saleCents,
      image_url: target.imageUrl,
    },
    tradeups: chosen.map((draft, index) => ({ ...comboOf(draft, shape, target), rank: index + 1 })),
    combinations_checked: checked,
  };
}

// ── Exact floats ────────────────────────────────────────────────────

// Prices a contract the user has spelled out slot by slot with real floats.
// Nothing about price is taken from the client: each slot is re-read from the
// catalog, and the wear (hence the listing price) follows from the float.
export function evaluateExactContract(
  catalog: Catalog,
  targetSkinId: string,
  wear: string,
  statTrak: boolean,
  inputs: ExactTradeupInput[],
): TradeupCombo | { error: string } {
  const target = catalog.itemBySkinId.get(targetSkinId);
  if (!target) return { error: 'Target skin not found' };

  const shape = shapeForTarget(target, statTrak);
  if ('error' in shape) return shape;

  if (!Array.isArray(inputs) || inputs.length !== shape.size) {
    return { error: `Expected ${shape.size} inputs for this contract` };
  }

  const slots: ComboSlot[] = [];
  for (const input of inputs) {
    const item = catalog.itemBySkinId.get(input.skin_id);
    if (!item) return { error: `Input skin not found: ${input.skin_id}` };
    if (item.kind !== 'weapon') {
      return { error: `Knives and gloves cannot be used as tradeup inputs (${item.name})` };
    }
    if (item.rarityId !== shape.inputRarityId) return { error: `Invalid input rarity for ${item.name}` };

    const pool = catalog.pools.get(input.collection_id);
    if (!pool || !(pool.tiers.get(shape.inputRarityId) ?? []).includes(item)) {
      return { error: `${item.name} is not part of ${pool?.name ?? input.collection_id}` };
    }
    const outcomes = outcomesOf(pool, shape);
    if (outcomes.length === 0) {
      return {
        error:
          shape.kind === 'gold' && statTrak
            ? `${item.name} comes from a case with no knives; StatTrak Covert contracts can only produce knives`
            : `${item.name}'s ${shape.kind === 'gold' ? 'case' : 'collection'} has no items at the output rarity`,
      };
    }

    const named = item.variants.find((variant) => variant.marketHashName === input.market_hash_name);
    if (!named) return { error: `Unknown market listing for ${item.name}: ${input.market_hash_name}` };
    if (named.isStatTrak !== statTrak) {
      return {
        error: statTrak
          ? `All inputs of a StatTrak contract must be StatTrak (${item.name})`
          : `StatTrak items cannot be mixed into a non-StatTrak contract (${item.name})`,
      };
    }
    if (named.isSouvenir && !souvenirInputsAllowed(statTrak)) {
      return { error: `Souvenir items cannot be used in a StatTrak contract (${item.name})` };
    }

    if (!Number.isFinite(input.input_float)) return { error: `Enter a valid float for ${item.name}` };
    if (input.input_float < item.minFloat - 1e-9 || input.input_float > item.maxFloat + 1e-9) {
      return {
        error: `${item.name} cannot have float ${input.input_float}: its range is ${item.minFloat.toFixed(2)}-${item.maxFloat.toFixed(2)}`,
      };
    }

    // The float decides the wear, and the wear decides which listing is bought.
    const range = wearFloatRange(named.wear, item.minFloat, item.maxFloat);
    const insideNamedWear = range != null && input.input_float >= range.lo - 1e-9 && input.input_float <= range.hi + 1e-9;
    const actualWear = insideNamedWear ? named.wear : wearForFloat(input.input_float);
    const variant = insideNamedWear
      ? named
      : item.variants.find(
          (candidate) =>
            candidate.wear === actualWear &&
            candidate.isStatTrak === named.isStatTrak &&
            candidate.isSouvenir === named.isSouvenir,
        );
    if (!variant) return { error: `${item.name} does not exist in ${actualWear}` };
    if (variant.listingCents == null) {
      return { error: `${variant.marketHashName} has no active Steam listing and cannot be used as an input` };
    }

    slots.push({ pool, item, variant, float: input.input_float, hitsTarget: outcomes.includes(target) });
  }

  const counts = new Map<Pool, number>();
  for (const slot of slots) counts.set(slot.pool, (counts.get(slot.pool) ?? 0) + 1);
  const chances = outcomeDistribution(counts, shape);
  if (!chances) return { error: 'Unable to evaluate this contract against the available outputs' };
  if (!chances.some((chance) => chance.item.key === target.key)) {
    return { error: `None of these inputs can produce ${target.name}` };
  }

  let total = 0;
  for (const slot of slots) total += normalizeFloat(slot.float ?? 0, slot.item.minFloat, slot.item.maxFloat);
  const average = total / slots.length;
  const envelope = { lo: average, hi: average };

  return assembleCombo({
    shape,
    target,
    slots,
    chances,
    envelope,
    placement: placeContract(envelope, target, wear),
  });
}
