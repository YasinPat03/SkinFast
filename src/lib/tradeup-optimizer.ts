import sql from './db';
import { TRADEUP_INPUT_RARITY } from './types';
import {
  TRADEUP_EXCLUDED_COLLECTION_IDS,
  TRADEUP_EXCLUDED_COLLECTION_REASON,
  hasTradeupExcludedCollection,
  isTradeupExcludedCollectionId,
} from './tradeup-rules';

// ── Knife/Glove Detection ─────────────────────────────────────────

function isKnifeOrGloveSkin(weaponName: string): boolean {
  const lower = weaponName.toLowerCase();
  return lower.includes('knife') || lower.includes('bayonet') || lower.includes('karambit')
    || lower.includes('gloves') || lower.includes('wraps') || lower.includes('daggers') || lower.includes('navaja')
    || lower.includes('stiletto') || lower.includes('talon') || lower.includes('ursus')
    || lower.includes('nomad') || lower.includes('skeleton') || lower.includes('paracord')
    || lower.includes('survival') || lower.includes('classic') || lower.includes('kukri')
    || lower.includes('falchion') || lower.includes('bowie') || lower.includes('huntsman')
    || lower.includes('butterfly') || lower.includes('flip') || lower.includes('gut')
    || lower.includes('m9') || lower.includes('shadow');
}

function isGloveSkin(weaponName: string): boolean {
  const lower = weaponName.toLowerCase();
  return lower.includes('gloves') || lower.includes('wraps');
}

function isKnifeSkin(weaponName: string): boolean {
  return isKnifeOrGloveSkin(weaponName) && !isGloveSkin(weaponName);
}

// ── Float Utilities ───────────────────────────────────────────────

const WEAR_FLOAT_RANGES: Record<string, [number, number]> = {
  'Factory New': [0.00, 0.07],
  'Minimal Wear': [0.07, 0.15],
  'Field-Tested': [0.15, 0.38],
  'Well-Worn': [0.38, 0.45],
  'Battle-Scarred': [0.45, 1.00],
};

const WEAR_ORDER = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];

/** Estimate the actual float for a skin at a given wear, clamped to the skin's float range */
function estimateFloat(wearName: string, skinMinFloat: number, skinMaxFloat: number): number {
  const range = WEAR_FLOAT_RANGES[wearName];
  if (!range) return (skinMinFloat + skinMaxFloat) / 2;
  const clampedMin = Math.max(range[0], skinMinFloat);
  const clampedMax = Math.min(range[1], skinMaxFloat);
  return (clampedMin + clampedMax) / 2;
}

/** Compute normalized trade float: t = (actual - min) / (max - min) */
function calculateTFloat(actualFloat: number, minFloat: number, maxFloat: number): number {
  if (maxFloat <= minFloat) return 0;
  return (actualFloat - minFloat) / (maxFloat - minFloat);
}

/** Compute output float from average trade float */
function calculateOutputFloat(avgTFloat: number, outMinFloat: number, outMaxFloat: number): number {
  return avgTFloat * (outMaxFloat - outMinFloat) + outMinFloat;
}

/** Map a float value to its wear condition */
function floatToWear(f: number): string {
  if (f < 0.07) return 'Factory New';
  if (f < 0.15) return 'Minimal Wear';
  if (f < 0.38) return 'Field-Tested';
  if (f < 0.45) return 'Well-Worn';
  return 'Battle-Scarred';
}

// ── Types ─────────────────────────────────────────────────────────

interface SkinRow {
  id: string;
  name: string;
  weapon_name: string;
  rarity_id: string;
  has_stattrak: boolean;
  image_url: string | null;
  min_float: number;
  max_float: number;
}

interface WearOption {
  wear_name: string;
  market_hash_name: string;
  price_cents: number;
  assumed_float: number;
  t_float: number;
  is_last_sold_price: boolean;
}

interface InputCandidate {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  collection_id: string;
  collection_name: string;
  image_url: string | null;
  min_float: number;
  max_float: number;
  contains_target: boolean;
  wear_options: WearOption[]; // sorted by t_float descending (highest first)
  cheapest_price_cents: number;
  cheapest_wear: string;
}

interface OutputSkin {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  collection_id: string;
  collection_name: string;
  image_url: string | null;
  min_float: number;
  max_float: number;
  prices_by_wear: Record<string, number>; // wear_name -> lowest_price_cents
  last_sold_by_wear: Record<string, number>; // wear_name -> median_price_cents (fallback)
}

type FloatSource = 'wear_assumption' | 'exact';

export interface TradeupConcreteInput {
  slot: number;
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  is_last_sold_price: boolean;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  min_float: number;
  max_float: number;
  input_float: number;
  normalized_float: number;
  float_source: FloatSource;
}

export interface TradeupGroupedInput {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  is_last_sold_price: boolean;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  quantity: number;
}

export interface TradeupOutcomeEvaluation {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  probability: number;
  price_cents: number | null;
  image_url: string | null;
  is_target: boolean;
  is_last_sold_price: boolean;
  expected_float: number;
  expected_wear: string;
}

export interface TradeupCombo {
  rank: number;
  inputs: TradeupGroupedInput[];
  concrete_inputs: TradeupConcreteInput[];
  total_cost_cents: number;
  probability: number;
  target_skin_probability: number;
  target_matches_requested_wear: boolean;
  cost_per_attempt_cents: number | null;
  ev_cents: number;
  avg_normalized_float: number;
  float_source: FloatSource;
  all_outcomes: TradeupOutcomeEvaluation[];
  has_last_sold_prices: boolean;
}

export interface ExactTradeupInput {
  skin_id: string;
  collection_id: string;
  market_hash_name: string;
  wear_name: string;
  price_cents: number;
  input_float: number;
}

export interface TradeupFinderResult {
  target: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear: string;
    price_cents: number | null;
    image_url: string | null;
  };
  tradeups: TradeupCombo[];
}

// ── Slot State (for wear optimization) ────────────────────────────

interface SlotState {
  candidate: InputCandidate;
  wearIdx: number;
}

type ResolvedTradeupInput = TradeupConcreteInput;

// ── Main Entry Point ──────────────────────────────────────────────

export async function findBestTradeup(
  targetSkinId: string,
  targetWear: string,
  isStatTrak: boolean
): Promise<TradeupFinderResult | { error: string }> {
  const targetSkinRows = await sql<SkinRow[]>`SELECT * FROM skins WHERE id = ${targetSkinId}`;
  const targetSkin = targetSkinRows[0];
  if (!targetSkin) return { error: 'Target skin not found' };

  const stattrakFilter = isStatTrak;
  const targetPriceRows = await sql<{ lowest_price_cents: number }[]>`
    SELECT p.lowest_price_cents
    FROM skin_variants sv
    JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE sv.skin_id = ${targetSkinId} AND sv.wear_name = ${targetWear} AND sv.is_stattrak = ${stattrakFilter}
  `;
  const targetPrice = targetPriceRows[0];

  const isGold = isKnifeOrGloveSkin(targetSkin.weapon_name);
  const numInputs = isGold ? 5 : 10;
  const inputRarityId = isGold ? 'rarity_ancient_weapon' : TRADEUP_INPUT_RARITY[targetSkin.rarity_id];
  if (!inputRarityId) return { error: 'No valid input rarity for this skin' };

  if (!isGold) {
    const targetCollections = await sql<{ collection_id: string }[]>`
      SELECT collection_id
      FROM collection_skins
      WHERE skin_id = ${targetSkinId}
    `;

    if (hasTradeupExcludedCollection(targetCollections.map((collection) => collection.collection_id))) {
      return { error: TRADEUP_EXCLUDED_COLLECTION_REASON };
    }
  }

  // Gather input candidates with per-wear options
  const { targetCandidates, fillerCandidates, targetCollectionIds } = await gatherInputCandidates(
    targetSkinId, inputRarityId, isGold ? null : targetSkin.rarity_id, stattrakFilter, isGold
  );

  if (targetCandidates.length === 0) {
    return { error: isGold ? 'No Covert inputs found in same cases' : 'No inputs found in same collections' };
  }

  const outputCache = new Map<string, OutputSkin[]>();
  async function getOutputSet(collectionIds: Set<string>): Promise<OutputSkin[]> {
    const key = [...collectionIds].sort().join('|');
    const cached = outputCache.get(key);
    if (cached) return cached;

    const outputs = isGold
      ? await gatherOutputSkinsFromCrates(collectionIds, stattrakFilter)
      : await gatherOutputSkins(targetSkin.rarity_id, collectionIds, stattrakFilter);
    outputCache.set(key, outputs);
    return outputs;
  }

  // Gather output skins with per-wear prices
  const allOutputSkins = await getOutputSet(targetCollectionIds);

  // Generate combos
  const combos: TradeupCombo[] = [];

  // Strategy 1: All slots with cheapest input from target collections
  const cheapestTarget = [...targetCandidates].sort((a, b) => a.cheapest_price_cents - b.cheapest_price_cents)[0];
  generateWearVariants(Array(numInputs).fill(cheapestTarget), targetSkinId, targetWear, allOutputSkins, numInputs, combos);

  // Strategy 2: For each unique input skin, fill all slots
  const uniqueInputs = new Map<string, InputCandidate>();
  for (const c of targetCandidates) {
    if (!uniqueInputs.has(c.skin_id) || c.cheapest_price_cents < uniqueInputs.get(c.skin_id)!.cheapest_price_cents) {
      uniqueInputs.set(c.skin_id, c);
    }
  }
  for (const input of uniqueInputs.values()) {
    generateWearVariants(Array(numInputs).fill(input), targetSkinId, targetWear, allOutputSkins, numInputs, combos);
  }

  // Strategy 3: Mix with fillers
  const topFillers = [...fillerCandidates].sort((a, b) => a.cheapest_price_cents - b.cheapest_price_cents).slice(0, 10);
  const maxFillers = numInputs - 1;
  if (topFillers.length > 0) {
    for (const filler of topFillers) {
      for (let nf = 1; nf <= maxFillers; nf++) {
        const inputs = [
          ...Array(numInputs - nf).fill(cheapestTarget),
          ...Array(nf).fill(filler),
        ];

        const expandedCollIds = new Set([...targetCollectionIds, filler.collection_id]);
        const expandedOutputs = await getOutputSet(expandedCollIds);

        generateWearVariants(inputs, targetSkinId, targetWear, expandedOutputs, numInputs, combos);
      }
    }
  }

  // Deduplicate and rank by EV (most profitable first)
  const seen = new Set<string>();
  const uniqueCombos = combos.filter((c) => {
    const key = c.inputs.map((i) => `${i.skin_id}:${i.wear_name}:${i.quantity}`).sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Prefer combos where estimated wear matches, but fall back to all combos
  // (e.g. Factory New gloves need very low float inputs that midpoint estimates can't capture)
  const wearMatching = uniqueCombos.filter((c) => c.target_matches_requested_wear);
  const ranked = wearMatching.length > 0 ? wearMatching : uniqueCombos;

  ranked.sort((a, b) => b.ev_cents - a.ev_cents);
  const top5 = ranked.slice(0, 5).map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    target: {
      skin_id: targetSkinId,
      skin_name: targetSkin.name,
      weapon_name: targetSkin.weapon_name,
      wear: targetWear,
      price_cents: targetPrice?.lowest_price_cents ?? null,
      image_url: targetSkin.image_url,
    },
    tradeups: top5,
  };
}

// ── Wear Variant Generation ───────────────────────────────────────

export async function evaluateTradeupContract(
  targetSkinId: string,
  targetWear: string,
  isStatTrak: boolean,
  inputs: ExactTradeupInput[]
): Promise<TradeupCombo | { error: string }> {
  if (inputs.length === 0) {
    return { error: 'At least one input is required' };
  }

  const targetSkinRows = await sql<SkinRow[]>`SELECT * FROM skins WHERE id = ${targetSkinId}`;
  const targetSkin = targetSkinRows[0];
  if (!targetSkin) return { error: 'Target skin not found' };

  const isGold = isKnifeOrGloveSkin(targetSkin.weapon_name);
  const numInputs = isGold ? 5 : 10;
  if (inputs.length !== numInputs) {
    return { error: `Expected ${numInputs} inputs for this contract` };
  }

  if (isGold && isStatTrak && !isKnifeSkin(targetSkin.weapon_name)) {
    return { error: 'StatTrak Covert tradeups can only produce knives' };
  }

  const inputRarityId = isGold ? 'rarity_ancient_weapon' : TRADEUP_INPUT_RARITY[targetSkin.rarity_id];
  if (!inputRarityId) return { error: 'No valid input rarity for this skin' };

  const inputSkinIds = [...new Set(inputs.map((input) => input.skin_id))];
  const inputSkinRows = await sql<SkinRow[]>`
    SELECT *
    FROM skins
    WHERE id IN ${sql(inputSkinIds)}
  `;
  const inputSkinMap = new Map(inputSkinRows.map((row) => [row.id, row]));

  const resolvedInputs: ResolvedTradeupInput[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    const skin = inputSkinMap.get(input.skin_id);
    if (!skin) {
      return { error: `Input skin not found: ${input.skin_id}` };
    }

    if (skin.rarity_id !== inputRarityId) {
      return { error: `Invalid input rarity for ${skin.name}` };
    }

    const clampedFloat = Math.min(Math.max(input.input_float, skin.min_float), skin.max_float);
    resolvedInputs.push({
      slot: index + 1,
      skin_id: skin.id,
      skin_name: skin.name,
      weapon_name: skin.weapon_name,
      wear_name: input.wear_name,
      price_cents: input.price_cents,
      is_last_sold_price: false,
      collection_id: input.collection_id,
      collection_name: input.collection_id,
      market_hash_name: input.market_hash_name,
      image_url: skin.image_url,
      min_float: skin.min_float,
      max_float: skin.max_float,
      input_float: clampedFloat,
      normalized_float: calculateTFloat(clampedFloat, skin.min_float, skin.max_float),
      float_source: 'exact',
    });
  }

  const collectionIds = new Set(resolvedInputs.map((input) => input.collection_id));
  const outputSkins = isGold
    ? await gatherOutputSkinsFromCrates(collectionIds, isStatTrak)
    : await gatherOutputSkins(targetSkin.rarity_id, collectionIds, isStatTrak);

  const collectionNameMap = new Map(outputSkins.map((output) => [output.collection_id, output.collection_name]));
  for (const input of resolvedInputs) {
    input.collection_name = collectionNameMap.get(input.collection_id) ?? input.collection_name;
  }

  const combo = evaluateResolvedTradeup(resolvedInputs, targetSkinId, targetWear, outputSkins, numInputs);
  if (!combo) {
    return { error: 'Unable to evaluate this contract against the available outputs' };
  }

  return combo;
}

function generateWearVariants(
  inputSlots: InputCandidate[],
  targetSkinId: string,
  targetWear: string,
  outputSkins: OutputSkin[],
  numInputs: number,
  combos: TradeupCombo[]
): void {
  // Config 1: All cheapest wears (baseline)
  const cheapestConfig = inputSlots.map((slot) => {
    const cheapestIdx = slot.wear_options.reduce(
      (best, opt, idx) => (opt.price_cents < slot.wear_options[best].price_cents ? idx : best), 0
    );
    return { candidate: slot, wearIdx: cheapestIdx };
  });
  const combo1 = buildComboFromSlots(cheapestConfig, targetSkinId, targetWear, outputSkins, numInputs);
  if (combo1) combos.push(combo1);

  // Config 2: All same wear (try each wear condition)
  for (const wearName of WEAR_ORDER) {
    const config = inputSlots.map((slot) => {
      const idx = slot.wear_options.findIndex((w) => w.wear_name === wearName);
      return idx >= 0 ? { candidate: slot, wearIdx: idx } : null;
    });
    if (config.some((s) => s === null)) continue;
    const combo = buildComboFromSlots(config as SlotState[], targetSkinId, targetWear, outputSkins, numInputs);
    if (combo) combos.push(combo);
  }

  // Config 3: Greedy optimization targeting the user's selected wear
  const targetOutput = outputSkins.find((o) => o.skin_id === targetSkinId);
  if (!targetOutput || targetOutput.max_float <= targetOutput.min_float) return;

  const wearRange = WEAR_FLOAT_RANGES[targetWear];
  if (wearRange && wearRange[1] > targetOutput.min_float && wearRange[0] < targetOutput.max_float) {
    const goalOutputFloat = Math.max(wearRange[0], targetOutput.min_float)
      + (Math.min(wearRange[1], targetOutput.max_float) - Math.max(wearRange[0], targetOutput.min_float)) / 2;
    const goalAvgT = (goalOutputFloat - targetOutput.min_float) / (targetOutput.max_float - targetOutput.min_float);

    if (goalAvgT >= 0 && goalAvgT <= 1) {
      const optimized = optimizeForTargetAvgT(inputSlots, goalAvgT);
      if (optimized) {
        const actualOutputFloat = calculateOutputFloat(optimized.avgTFloat, targetOutput.min_float, targetOutput.max_float);
        const actualWear = floatToWear(actualOutputFloat);
        if (actualWear === targetWear) {
          const combo = buildComboFromSlots(optimized.slots, targetSkinId, targetWear, outputSkins, numInputs);
          if (combo) combos.push(combo);
        }
      }
    }
  }
}

// ── Wear Optimization (Greedy) ────────────────────────────────────

function optimizeForTargetAvgT(
  inputSlots: InputCandidate[],
  targetAvgT: number
): { slots: SlotState[]; avgTFloat: number } | null {
  const slots: SlotState[] = inputSlots.map((candidate) => {
    const cheapestIdx = candidate.wear_options.reduce(
      (best, opt, idx) => (opt.price_cents < candidate.wear_options[best].price_cents ? idx : best), 0
    );
    return { candidate, wearIdx: cheapestIdx };
  });

  if (slots.some((s) => s.candidate.wear_options.length === 0)) return null;

  let avgT = calculateAvgTFloat(slots);

  if (avgT <= targetAvgT) return { slots: slots.map((s) => ({ ...s })), avgTFloat: avgT };

  const maxIterations = inputSlots.length * 5;
  for (let iter = 0; iter < maxIterations; iter++) {
    let bestSlotIdx = -1;
    let bestNewWearIdx = -1;
    let bestEfficiency = -Infinity;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const currentWear = slot.candidate.wear_options[slot.wearIdx];

      for (let j = 0; j < slot.candidate.wear_options.length; j++) {
        if (j === slot.wearIdx) continue;
        const newWear = slot.candidate.wear_options[j];
        const deltaT = currentWear.t_float - newWear.t_float;
        if (deltaT <= 0) continue;

        const deltaCost = newWear.price_cents - currentWear.price_cents;

        if (deltaCost <= 0) {
          bestSlotIdx = i;
          bestNewWearIdx = j;
          bestEfficiency = Infinity;
          break;
        }

        const efficiency = deltaT / deltaCost;
        if (efficiency > bestEfficiency) {
          bestEfficiency = efficiency;
          bestSlotIdx = i;
          bestNewWearIdx = j;
        }
      }
      if (bestEfficiency === Infinity) break;
    }

    if (bestSlotIdx === -1) break;

    slots[bestSlotIdx] = { ...slots[bestSlotIdx], wearIdx: bestNewWearIdx };
    avgT = calculateAvgTFloat(slots);

    if (avgT <= targetAvgT) break;
  }

  if (avgT > targetAvgT + 0.02) return null;

  return { slots: slots.map((s) => ({ ...s })), avgTFloat: avgT };
}

function calculateAvgTFloat(slots: SlotState[]): number {
  let sum = 0;
  for (const slot of slots) {
    sum += slot.candidate.wear_options[slot.wearIdx].t_float;
  }
  return sum / slots.length;
}

// ── Combo Building (Float-Aware) ──────────────────────────────────

function buildComboFromSlots(
  slots: SlotState[],
  targetSkinId: string,
  targetWear: string,
  outputSkins: OutputSkin[],
  numInputs: number
): TradeupCombo | null {
  const resolvedInputs = slots.map<ResolvedTradeupInput>((slot, index) => {
    const wear = slot.candidate.wear_options[slot.wearIdx];
    return {
      slot: index + 1,
      skin_id: slot.candidate.skin_id,
      skin_name: slot.candidate.skin_name,
      weapon_name: slot.candidate.weapon_name,
      wear_name: wear.wear_name,
      price_cents: wear.price_cents,
      is_last_sold_price: wear.is_last_sold_price,
      collection_id: slot.candidate.collection_id,
      collection_name: slot.candidate.collection_name,
      market_hash_name: wear.market_hash_name,
      image_url: slot.candidate.image_url,
      min_float: slot.candidate.min_float,
      max_float: slot.candidate.max_float,
      input_float: wear.assumed_float,
      normalized_float: calculateTFloat(wear.assumed_float, slot.candidate.min_float, slot.candidate.max_float),
      float_source: 'wear_assumption',
    };
  });

  // If estimated midpoint floats don't land in the target wear, adjust input floats
  // to the highest values that still produce the target wear (cheapest possible inputs)
  const targetOutput = outputSkins.find((o) => o.skin_id === targetSkinId);
  if (targetOutput && targetOutput.max_float > targetOutput.min_float) {
    const currentAvgT = resolvedInputs.reduce((sum, i) => sum + i.normalized_float, 0) / numInputs;
    const currentOutputFloat = calculateOutputFloat(currentAvgT, targetOutput.min_float, targetOutput.max_float);

    if (floatToWear(currentOutputFloat) !== targetWear) {
      const wearRange = WEAR_FLOAT_RANGES[targetWear];
      if (wearRange && wearRange[1] > targetOutput.min_float && wearRange[0] < targetOutput.max_float) {
        // Use the midpoint of the target wear range (clamped to skin's float range)
        // instead of the maximum — this produces realistic input float requirements
        const clampedWearMin = Math.max(wearRange[0], targetOutput.min_float);
        const clampedWearMax = Math.min(wearRange[1], targetOutput.max_float);
        const goalOutputFloat = (clampedWearMin + clampedWearMax) / 2;
        const goalAvgT = (goalOutputFloat - targetOutput.min_float) / (targetOutput.max_float - targetOutput.min_float);

        if (goalAvgT >= 0 && goalAvgT <= 1) {
          // Verify each input can hit goalAvgT within a realistic portion of its wear range
          // (not at the extreme edges — require at least 15% into the range)
          let allValid = true;
          for (const input of resolvedInputs) {
            const requiredFloat = goalAvgT * (input.max_float - input.min_float) + input.min_float;
            const wearBounds = WEAR_FLOAT_RANGES[input.wear_name];
            if (!wearBounds) { allValid = false; break; }
            const effectiveMin = Math.max(wearBounds[0], input.min_float);
            const effectiveMax = Math.min(wearBounds[1], input.max_float);
            const rangeSize = effectiveMax - effectiveMin;
            const margin = rangeSize * 0.15;
            if (effectiveMin >= effectiveMax || requiredFloat < effectiveMin + margin || requiredFloat >= effectiveMax - margin) {
              allValid = false;
              break;
            }
          }

          if (allValid) {
            for (const input of resolvedInputs) {
              input.input_float = goalAvgT * (input.max_float - input.min_float) + input.min_float;
              input.normalized_float = goalAvgT;
            }
          }
        }
      }
    }
  }

  const combo = evaluateResolvedTradeup(resolvedInputs, targetSkinId, targetWear, outputSkins, numInputs);
  if (!combo || combo.target_skin_probability <= 0) {
    return null;
  }

  return combo;
}

function evaluateResolvedTradeup(
  resolvedInputs: ResolvedTradeupInput[],
  targetSkinId: string,
  targetWear: string,
  outputSkins: OutputSkin[],
  numInputs: number
): TradeupCombo | null {
  if (resolvedInputs.length !== numInputs) return null;

  const avgNormalizedFloat = resolvedInputs.reduce((sum, input) => sum + input.normalized_float, 0) / numInputs;

  const inputsPerCollection = new Map<string, number>();
  for (const input of resolvedInputs) {
    inputsPerCollection.set(input.collection_id, (inputsPerCollection.get(input.collection_id) ?? 0) + 1);
  }

  const outputsByCollection = new Map<string, OutputSkin[]>();
  for (const output of outputSkins) {
    const existing = outputsByCollection.get(output.collection_id);
    if (existing) {
      existing.push(output);
    } else {
      outputsByCollection.set(output.collection_id, [output]);
    }
  }

  const outcomeProbs = new Map<string, number>();
  for (const [collectionId, count] of inputsPerCollection) {
    const collectionOutputs = outputsByCollection.get(collectionId) ?? [];
    const numOutputs = collectionOutputs.length;
    if (numOutputs === 0) continue;

    const probPerSkin = count / numInputs / numOutputs;
    for (const output of collectionOutputs) {
      outcomeProbs.set(output.skin_id, (outcomeProbs.get(output.skin_id) ?? 0) + probPerSkin);
    }
  }

  const targetSkinProb = outcomeProbs.get(targetSkinId) ?? 0;
  if (targetSkinProb === 0) return null;

  const targetOutput = outputSkins.find((o) => o.skin_id === targetSkinId) ?? null;
  const targetOutputFloat = targetOutput
    ? calculateOutputFloat(avgNormalizedFloat, targetOutput.min_float, targetOutput.max_float)
    : null;
  const targetMatchesRequestedWear = targetOutputFloat != null && floatToWear(targetOutputFloat) === targetWear;
  const requestedTargetProb = targetMatchesRequestedWear ? targetSkinProb : 0;

  const totalCost = resolvedInputs.reduce((sum, input) => sum + input.price_cents, 0);
  const costPerAttempt = requestedTargetProb > 0 ? Math.round(totalCost / requestedTargetProb) : null;

  let ev = -totalCost;
  let anyLastSold = false;
  const allOutcomes: TradeupOutcomeEvaluation[] = [];

  for (const [skinId, prob] of outcomeProbs) {
    const output = outputSkins.find((candidate) => candidate.skin_id === skinId);
    if (!output) continue;

    const outputFloat = calculateOutputFloat(avgNormalizedFloat, output.min_float, output.max_float);
    const outputWear = floatToWear(outputFloat);

    let priceAtWear = output.prices_by_wear[outputWear] ?? null;
    let isLastSold = false;

    if (priceAtWear === null) {
      priceAtWear = output.last_sold_by_wear[outputWear] ?? null;
      if (priceAtWear !== null) isLastSold = true;
    }

    if (priceAtWear === null) {
      const availableListings = Object.values(output.prices_by_wear);
      if (availableListings.length > 0) {
        priceAtWear = Math.min(...availableListings);
      }
    }

    if (priceAtWear === null) {
      const availableLastSold = Object.values(output.last_sold_by_wear);
      if (availableLastSold.length > 0) {
        priceAtWear = Math.min(...availableLastSold);
        isLastSold = true;
      }
    }

    if (priceAtWear != null) {
      ev += priceAtWear * prob;
    }

    if (isLastSold) anyLastSold = true;

    allOutcomes.push({
      skin_id: skinId,
      skin_name: output.skin_name,
      weapon_name: output.weapon_name,
      probability: Math.round(prob * 10000) / 10000,
      price_cents: priceAtWear,
      image_url: output.image_url,
      is_target: skinId === targetSkinId,
      is_last_sold_price: isLastSold,
      expected_float: Math.round(outputFloat * 100000) / 100000,
      expected_wear: outputWear,
    });
  }

  allOutcomes.sort((a, b) => b.probability - a.probability);

  const groupedInputs = new Map<string, TradeupGroupedInput>();
  for (const input of resolvedInputs) {
    const key = `${input.skin_id}:${input.collection_id}:${input.wear_name}:${input.market_hash_name}:${input.price_cents}`;
    const existing = groupedInputs.get(key);
    if (existing) {
      existing.quantity++;
    } else {
      groupedInputs.set(key, {
        skin_id: input.skin_id,
        skin_name: input.skin_name,
        weapon_name: input.weapon_name,
        wear_name: input.wear_name,
        price_cents: input.price_cents,
        is_last_sold_price: input.is_last_sold_price,
        collection_id: input.collection_id,
        collection_name: input.collection_name,
        market_hash_name: input.market_hash_name,
        image_url: input.image_url,
        quantity: 1,
      });
    }
  }

  const floatSource: FloatSource = resolvedInputs.every((input) => input.float_source === 'exact')
    ? 'exact'
    : 'wear_assumption';

  return {
    rank: 0,
    inputs: Array.from(groupedInputs.values()),
    concrete_inputs: resolvedInputs.map((input) => ({
      ...input,
      input_float: Math.round(input.input_float * 100000) / 100000,
      normalized_float: Math.round(input.normalized_float * 100000) / 100000,
    })),
    total_cost_cents: totalCost,
    probability: Math.round(requestedTargetProb * 10000) / 10000,
    target_skin_probability: Math.round(targetSkinProb * 10000) / 10000,
    target_matches_requested_wear: targetMatchesRequestedWear,
    cost_per_attempt_cents: costPerAttempt,
    ev_cents: Math.round(ev),
    avg_normalized_float: Math.round(avgNormalizedFloat * 100000) / 100000,
    float_source: floatSource,
    all_outcomes: allOutcomes,
    has_last_sold_prices: anyLastSold,
  };
}

// ── Data Gathering ────────────────────────────────────────────────

type RawInput = {
  skin_id: string; skin_name: string; weapon_name: string;
  image_url: string | null; min_float: number; max_float: number;
  collection_id: string; collection_name: string;
};

async function gatherInputCandidates(
  targetSkinId: string,
  inputRarityId: string,
  outputRarityId: string | null,
  stattrakFilter: boolean,
  isGold: boolean
): Promise<{
  targetCandidates: InputCandidate[];
  fillerCandidates: InputCandidate[];
  targetCollectionIds: Set<string>;
}> {
  let targetCollectionIds: Set<string>;
  let rawTargetInputs: RawInput[];

  if (isGold) {
    const crates = await sql<{ collection_id: string }[]>`
      SELECT crate_id as collection_id FROM crate_skins WHERE skin_id = ${targetSkinId} AND is_rare = TRUE
    `;
    targetCollectionIds = new Set(crates.map((c) => c.collection_id));
    if (targetCollectionIds.size === 0) return { targetCandidates: [], fillerCandidates: [], targetCollectionIds };

    const ids = [...targetCollectionIds];
    rawTargetInputs = await sql<RawInput[]>`
      SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
             s.min_float, s.max_float,
             cs.crate_id as collection_id, cr.name as collection_name
      FROM skins s
      JOIN crate_skins cs ON s.id = cs.skin_id
      JOIN crates cr ON cs.crate_id = cr.id
      WHERE cs.crate_id IN ${sql(ids)}
      AND cs.rarity_id = ${inputRarityId} AND cs.is_rare = FALSE
      AND EXISTS (
        SELECT 1
        FROM crate_skins cs_out
        WHERE cs_out.crate_id = cs.crate_id
        AND cs_out.is_rare = TRUE
      )
    `;
  } else {
    const cols = await sql<{ collection_id: string }[]>`
      SELECT collection_id FROM collection_skins WHERE skin_id = ${targetSkinId}
    `;
    targetCollectionIds = new Set(
      cols
        .map((c) => c.collection_id)
        .filter((collectionId) => !isTradeupExcludedCollectionId(collectionId))
    );
    if (targetCollectionIds.size === 0) return { targetCandidates: [], fillerCandidates: [], targetCollectionIds };

    const ids = [...targetCollectionIds];
    rawTargetInputs = await sql<RawInput[]>`
      SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
             s.min_float, s.max_float,
             cs.collection_id, c.name as collection_name
      FROM skins s
      JOIN collection_skins cs ON s.id = cs.skin_id
      JOIN collections c ON cs.collection_id = c.id
      WHERE cs.collection_id IN ${sql(ids)}
      AND cs.rarity_id = ${inputRarityId}
      AND cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
      AND EXISTS (
        SELECT 1
        FROM collection_skins cs_out
        WHERE cs_out.collection_id = cs.collection_id
        AND cs_out.rarity_id = ${outputRarityId}
      )
    `;
  }

  const targetCandidates = await buildCandidatesWithWears(rawTargetInputs, stattrakFilter, true);

  // Get fillers from other collections/crates
  let rawFillerInputs: RawInput[];
  const targetIds = [...targetCollectionIds];

  if (isGold) {
    rawFillerInputs = await sql<RawInput[]>`
      SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
             s.min_float, s.max_float,
             cs.crate_id as collection_id, cr.name as collection_name
      FROM skins s
      JOIN crate_skins cs ON s.id = cs.skin_id
      JOIN crates cr ON cs.crate_id = cr.id
      WHERE cs.crate_id NOT IN ${sql(targetIds)}
      AND cs.rarity_id = ${inputRarityId} AND cs.is_rare = FALSE
      AND EXISTS (
        SELECT 1
        FROM crate_skins cs_out
        WHERE cs_out.crate_id = cs.crate_id
        AND cs_out.is_rare = TRUE
      )
    `;
  } else {
    rawFillerInputs = await sql<RawInput[]>`
      SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
             s.min_float, s.max_float,
             cs.collection_id, c.name as collection_name
      FROM skins s
      JOIN collection_skins cs ON s.id = cs.skin_id
      JOIN collections c ON cs.collection_id = c.id
      WHERE cs.collection_id NOT IN ${sql(targetIds)}
      AND cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
      AND cs.rarity_id = ${inputRarityId}
      AND EXISTS (
        SELECT 1
        FROM collection_skins cs_out
        WHERE cs_out.collection_id = cs.collection_id
        AND cs_out.rarity_id = ${outputRarityId}
      )
    `;
  }

  const fillerCandidates = await buildCandidatesWithWears(rawFillerInputs, stattrakFilter, false);

  return { targetCandidates, fillerCandidates, targetCollectionIds };
}

async function buildCandidatesWithWears(
  rawInputs: RawInput[],
  stattrakFilter: boolean,
  containsTarget: boolean
): Promise<InputCandidate[]> {
  const candidates: InputCandidate[] = [];
  const seen = new Set<string>();

  for (const row of rawInputs) {
    const key = `${row.skin_id}:${row.collection_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Get all wears with prices for this skin (fall back to last-sold if no active listing)
    const wears = await sql<{ wear_name: string; market_hash_name: string; lowest_price_cents: number | null; median_price_cents: number | null }[]>`
      SELECT sv.wear_name, sv.market_hash_name, p.lowest_price_cents, p.median_price_cents
      FROM skin_variants sv
      JOIN prices p ON sv.market_hash_name = p.market_hash_name
      WHERE sv.skin_id = ${row.skin_id} AND sv.is_stattrak = ${stattrakFilter} AND sv.is_souvenir = FALSE
      AND (
        (p.lowest_price_cents IS NOT NULL AND p.lowest_price_cents > 0)
        OR (p.median_price_cents IS NOT NULL AND p.median_price_cents > 0)
      )
    `;

    if (wears.length === 0) continue;

    const wearOptions: WearOption[] = wears.map((w) => {
      const hasActiveListing = w.lowest_price_cents != null && w.lowest_price_cents > 0;
      const priceToUse = hasActiveListing ? w.lowest_price_cents! : w.median_price_cents!;
      const estFloat = estimateFloat(w.wear_name, row.min_float, row.max_float);
      const tFloat = calculateTFloat(estFloat, row.min_float, row.max_float);
      return {
        wear_name: w.wear_name,
        market_hash_name: w.market_hash_name,
        price_cents: priceToUse,
        assumed_float: estFloat,
        t_float: tFloat,
        is_last_sold_price: !hasActiveListing,
      };
    });

    // Sort by t_float descending (highest first = usually cheapest)
    wearOptions.sort((a, b) => b.t_float - a.t_float);

    const cheapest = [...wearOptions].sort((a, b) => a.price_cents - b.price_cents)[0];

    candidates.push({
      skin_id: row.skin_id,
      skin_name: row.skin_name,
      weapon_name: row.weapon_name,
      collection_id: row.collection_id,
      collection_name: row.collection_name,
      image_url: row.image_url,
      min_float: row.min_float,
      max_float: row.max_float,
      contains_target: containsTarget,
      wear_options: wearOptions,
      cheapest_price_cents: cheapest.price_cents,
      cheapest_wear: cheapest.wear_name,
    });
  }

  return candidates;
}

async function gatherOutputSkins(
  targetRarityId: string,
  collectionIds: Set<string>,
  stattrakFilter: boolean
): Promise<OutputSkin[]> {
  const ids = [...collectionIds];

  const rows = await sql<(OutputSkin & { skin_id: string })[]>`
    SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
           s.min_float, s.max_float,
           cs.collection_id, c.name as collection_name
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    JOIN collections c ON cs.collection_id = c.id
    WHERE cs.collection_id IN ${sql(ids)}
    AND cs.rarity_id = ${targetRarityId}
    AND cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
  `;

  const results: OutputSkin[] = [];
  for (const row of rows) {
    const { prices_by_wear, last_sold_by_wear } = await getWearPrices(row.skin_id, stattrakFilter);
    results.push({
      ...row,
      prices_by_wear,
      last_sold_by_wear,
    });
  }
  return results;
}

async function gatherOutputSkinsFromCrates(
  crateIds: Set<string>,
  stattrakFilter: boolean
): Promise<OutputSkin[]> {
  const ids = [...crateIds];

  const rows = await sql<(OutputSkin & { skin_id: string })[]>`
    SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
           s.min_float, s.max_float,
           cs.crate_id as collection_id, cr.name as collection_name
    FROM skins s
    JOIN crate_skins cs ON s.id = cs.skin_id
    JOIN crates cr ON cs.crate_id = cr.id
    WHERE cs.crate_id IN ${sql(ids)}
    AND cs.is_rare = TRUE
  `;

  const filteredRows = stattrakFilter
    ? rows.filter((row) => isKnifeSkin(row.weapon_name))
    : rows;

  const results: OutputSkin[] = [];
  for (const row of filteredRows) {
    const { prices_by_wear, last_sold_by_wear } = await getWearPrices(row.skin_id, stattrakFilter);
    if (stattrakFilter && Object.keys(prices_by_wear).length === 0 && Object.keys(last_sold_by_wear).length === 0) {
      continue;
    }
    results.push({
      ...row,
      prices_by_wear,
      last_sold_by_wear,
    });
  }
  return results;
}

async function getWearPrices(
  skinId: string,
  stattrakFilter: boolean
): Promise<{ prices_by_wear: Record<string, number>; last_sold_by_wear: Record<string, number> }> {
  const rows = await sql<{ wear_name: string; lowest_price_cents: number | null; median_price_cents: number | null }[]>`
    SELECT sv.wear_name, p.lowest_price_cents, p.median_price_cents
    FROM skin_variants sv
    JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE sv.skin_id = ${skinId} AND sv.is_stattrak = ${stattrakFilter} AND sv.is_souvenir = FALSE
  `;

  const prices: Record<string, number> = {};
  const lastSold: Record<string, number> = {};
  for (const row of rows) {
    if (row.lowest_price_cents != null && row.lowest_price_cents > 0) {
      prices[row.wear_name] = row.lowest_price_cents;
    }
    if (row.median_price_cents != null && row.median_price_cents > 0) {
      lastSold[row.wear_name] = row.median_price_cents;
    }
  }
  return { prices_by_wear: prices, last_sold_by_wear: lastSold };
}
