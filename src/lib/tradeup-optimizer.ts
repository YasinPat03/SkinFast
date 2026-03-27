import sql from './db';
import { TRADEUP_INPUT_RARITY } from './types';

// ── Knife/Glove Detection ─────────────────────────────────────────

function isKnifeOrGloveSkin(weaponName: string): boolean {
  const lower = weaponName.toLowerCase();
  return lower.includes('knife') || lower.includes('bayonet') || lower.includes('karambit')
    || lower.includes('gloves') || lower.includes('daggers') || lower.includes('navaja')
    || lower.includes('stiletto') || lower.includes('talon') || lower.includes('ursus')
    || lower.includes('nomad') || lower.includes('skeleton') || lower.includes('paracord')
    || lower.includes('survival') || lower.includes('classic') || lower.includes('kukri')
    || lower.includes('falchion') || lower.includes('bowie') || lower.includes('huntsman')
    || lower.includes('butterfly') || lower.includes('flip') || lower.includes('gut')
    || lower.includes('m9') || lower.includes('shadow');
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
  estimated_float: number;
  t_float: number;
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

export interface TradeupCombo {
  rank: number;
  inputs: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear_name: string;
    price_cents: number;
    collection_id: string;
    collection_name: string;
    market_hash_name: string;
    image_url: string | null;
    quantity: number;
  }[];
  total_cost_cents: number;
  probability: number;
  cost_per_attempt_cents: number;
  ev_cents: number;
  expected_avg_float: number;
  all_outcomes: {
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
  }[];
  has_last_sold_prices: boolean;
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

  // Gather input candidates with per-wear options
  const { targetCandidates, fillerCandidates, targetCollectionIds } = await gatherInputCandidates(
    targetSkinId, inputRarityId, stattrakFilter, isGold
  );

  if (targetCandidates.length === 0) {
    return { error: isGold ? 'No Covert inputs found in same cases' : 'No inputs found in same collections' };
  }

  // Gather output skins with per-wear prices
  const allOutputSkins = isGold
    ? await gatherOutputSkinsFromCrates(targetCollectionIds, stattrakFilter)
    : await gatherOutputSkins(targetSkin.rarity_id, targetCollectionIds, stattrakFilter);

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
  const maxFillers = isGold ? 3 : 7;
  if (topFillers.length > 0) {
    const cheapestFiller = topFillers[0];
    for (let nf = 1; nf <= maxFillers; nf += (isGold ? 1 : 2)) {
      const inputs = [
        ...Array(numInputs - nf).fill(cheapestTarget),
        ...Array(nf).fill(cheapestFiller),
      ];

      const expandedCollIds = new Set([...targetCollectionIds, cheapestFiller.collection_id]);
      const expandedOutputs = isGold
        ? await gatherOutputSkinsFromCrates(expandedCollIds, stattrakFilter)
        : await gatherOutputSkins(targetSkin.rarity_id, expandedCollIds, stattrakFilter);

      generateWearVariants(inputs, targetSkinId, targetWear, expandedOutputs, numInputs, combos);
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

  uniqueCombos.sort((a, b) => b.ev_cents - a.ev_cents);
  const top5 = uniqueCombos.slice(0, 5).map((c, i) => ({ ...c, rank: i + 1 }));

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
  const avgTFloat = calculateAvgTFloat(slots);

  // Check that the target skin's output float lands in the requested wear
  const targetOutput = outputSkins.find((o) => o.skin_id === targetSkinId);
  if (targetOutput) {
    const targetOutputFloat = calculateOutputFloat(avgTFloat, targetOutput.min_float, targetOutput.max_float);
    const resultingWear = floatToWear(targetOutputFloat);
    if (resultingWear !== targetWear) return null;
  }

  const inputsPerCollection = new Map<string, number>();
  for (const slot of slots) {
    const colId = slot.candidate.collection_id;
    inputsPerCollection.set(colId, (inputsPerCollection.get(colId) ?? 0) + 1);
  }

  const outcomeProbs = new Map<string, number>();
  for (const [collectionId, count] of inputsPerCollection) {
    const collectionOutputs = outputSkins.filter((o) => o.collection_id === collectionId);
    const numOutputs = collectionOutputs.length;
    if (numOutputs === 0) continue;

    const probPerSkin = count / numInputs / numOutputs;
    for (const output of collectionOutputs) {
      outcomeProbs.set(output.skin_id, (outcomeProbs.get(output.skin_id) ?? 0) + probPerSkin);
    }
  }

  const targetProb = outcomeProbs.get(targetSkinId) ?? 0;
  if (targetProb === 0) return null;

  const totalCost = slots.reduce((sum, s) => sum + s.candidate.wear_options[s.wearIdx].price_cents, 0);
  const costPerAttempt = Math.round(totalCost / targetProb);

  let ev = -totalCost;
  let anyLastSold = false;
  const allOutcomes: TradeupCombo['all_outcomes'] = [];

  for (const [skinId, prob] of outcomeProbs) {
    const output = outputSkins.find((o) => o.skin_id === skinId);
    if (!output) continue;

    const outputFloat = calculateOutputFloat(avgTFloat, output.min_float, output.max_float);
    const outputWear = floatToWear(outputFloat);

    let priceAtWear = output.prices_by_wear[outputWear] ?? null;
    let isLastSold = false;

    if (priceAtWear === null) {
      // Fallback 1: last sold price for the exact wear
      priceAtWear = output.last_sold_by_wear[outputWear] ?? null;
      if (priceAtWear !== null) isLastSold = true;
    }

    if (priceAtWear === null) {
      // Fallback 2: cheapest listing price across any wear
      const availableListings = Object.entries(output.prices_by_wear);
      if (availableListings.length > 0) {
        priceAtWear = Math.min(...availableListings.map(([, p]) => p));
      }
    }

    if (priceAtWear === null) {
      // Fallback 3: cheapest last sold across any wear
      const availableLastSold = Object.entries(output.last_sold_by_wear);
      if (availableLastSold.length > 0) {
        priceAtWear = Math.min(...availableLastSold.map(([, p]) => p));
        isLastSold = true;
      }
    }

    if (priceAtWear) {
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

  const inputMap = new Map<string, TradeupCombo['inputs'][0]>();
  for (const slot of slots) {
    const wear = slot.candidate.wear_options[slot.wearIdx];
    const key = `${slot.candidate.skin_id}:${wear.wear_name}`;
    const existing = inputMap.get(key);
    if (existing) {
      existing.quantity++;
    } else {
      inputMap.set(key, {
        skin_id: slot.candidate.skin_id,
        skin_name: slot.candidate.skin_name,
        weapon_name: slot.candidate.weapon_name,
        wear_name: wear.wear_name,
        price_cents: wear.price_cents,
        collection_id: slot.candidate.collection_id,
        collection_name: slot.candidate.collection_name,
        market_hash_name: wear.market_hash_name,
        image_url: slot.candidate.image_url,
        quantity: 1,
      });
    }
  }

  return {
    rank: 0,
    inputs: Array.from(inputMap.values()),
    total_cost_cents: totalCost,
    probability: Math.round(targetProb * 10000) / 10000,
    cost_per_attempt_cents: costPerAttempt,
    ev_cents: Math.round(ev),
    expected_avg_float: Math.round(avgTFloat * 100000) / 100000,
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
      AND cs.rarity_id = ${inputRarityId} AND cs.is_rare = FALSE AND s.has_souvenir = FALSE
    `;
  } else {
    const cols = await sql<{ collection_id: string }[]>`
      SELECT collection_id FROM collection_skins WHERE skin_id = ${targetSkinId}
    `;
    targetCollectionIds = new Set(cols.map((c) => c.collection_id));
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
      AND cs.rarity_id = ${inputRarityId} AND s.has_souvenir = FALSE
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
      AND cs.rarity_id = ${inputRarityId} AND cs.is_rare = FALSE AND s.has_souvenir = FALSE
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
      AND cs.rarity_id = ${inputRarityId} AND s.has_souvenir = FALSE
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

    // Get all wears with prices for this skin
    const wears = await sql<{ wear_name: string; market_hash_name: string; lowest_price_cents: number }[]>`
      SELECT sv.wear_name, sv.market_hash_name, p.lowest_price_cents
      FROM skin_variants sv
      JOIN prices p ON sv.market_hash_name = p.market_hash_name
      WHERE sv.skin_id = ${row.skin_id} AND sv.is_stattrak = ${stattrakFilter} AND sv.is_souvenir = FALSE
      AND p.lowest_price_cents IS NOT NULL AND p.lowest_price_cents > 0
    `;

    if (wears.length === 0) continue;

    const wearOptions: WearOption[] = wears.map((w) => {
      const estFloat = estimateFloat(w.wear_name, row.min_float, row.max_float);
      const tFloat = calculateTFloat(estFloat, row.min_float, row.max_float);
      return {
        wear_name: w.wear_name,
        market_hash_name: w.market_hash_name,
        price_cents: w.lowest_price_cents,
        estimated_float: estFloat,
        t_float: tFloat,
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
