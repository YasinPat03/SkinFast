import { getDb } from './db';
import { TRADEUP_INPUT_RARITY } from './types';

interface SkinRow {
  id: string;
  name: string;
  weapon_name: string;
  rarity_id: string;
  has_stattrak: number;
  image_url: string | null;
}

interface InputCandidate {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  collection_id: string;
  collection_name: string;
  cheapest_price_cents: number;
  cheapest_wear: string;
  market_hash_name: string;
  image_url: string | null;
  contains_target: boolean; // whether this skin's collection contains the target
}

interface OutputSkin {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  collection_id: string;
  collection_name: string;
  price_cents: number | null;
  image_url: string | null;
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
  all_outcomes: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    probability: number;
    price_cents: number | null;
    image_url: string | null;
    is_target: boolean;
  }[];
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

export function findBestTradeup(
  targetSkinId: string,
  targetWear: string,
  isStatTrak: boolean
): TradeupFinderResult | { error: string } {
  const db = getDb();

  // Get target skin
  const targetSkin = db.prepare('SELECT * FROM skins WHERE id = ?').get(targetSkinId) as SkinRow | undefined;
  if (!targetSkin) return { error: 'Target skin not found' };

  // Get target price for the specific wear
  const stattrakFilter = isStatTrak ? 1 : 0;
  const targetPrice = db.prepare(`
    SELECT p.lowest_price_cents
    FROM skin_variants sv
    JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE sv.skin_id = ? AND sv.wear_name = ? AND sv.is_stattrak = ?
  `).get(targetSkinId, targetWear, stattrakFilter) as { lowest_price_cents: number } | undefined;

  // Get input rarity
  const inputRarityId = TRADEUP_INPUT_RARITY[targetSkin.rarity_id];
  if (!inputRarityId) return { error: 'No valid input rarity for this skin' };

  // Get collections that contain the target skin
  const targetCollections = db.prepare(`
    SELECT cs.collection_id FROM collection_skins cs WHERE cs.skin_id = ?
  `).all(targetSkinId) as { collection_id: string }[];

  if (targetCollections.length === 0) return { error: 'Skin not in any collection' };

  const targetCollectionIds = new Set(targetCollections.map((c) => c.collection_id));

  // Get ALL input-rarity skins from target collections (these can contribute to landing the target)
  const targetColPlaceholders = [...targetCollectionIds].map(() => '?').join(',');
  const inputSkinsFromTargetCols = db.prepare(`
    SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
           cs.collection_id,
           c.name as collection_name
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    JOIN collections c ON cs.collection_id = c.id
    WHERE cs.collection_id IN (${targetColPlaceholders})
    AND cs.rarity_id = ?
    AND s.has_souvenir = 0
  `).all(...targetCollectionIds, inputRarityId) as (InputCandidate & { collection_id: string; collection_name: string })[];

  // Get cheapest price for each input skin (non-stattrak or stattrak depending on mode)
  const inputCandidates: InputCandidate[] = [];
  const seenSkinCollection = new Set<string>();

  for (const row of inputSkinsFromTargetCols) {
    const key = `${row.skin_id}:${row.collection_id}`;
    if (seenSkinCollection.has(key)) continue;
    seenSkinCollection.add(key);

    const cheapest = db.prepare(`
      SELECT sv.wear_name, sv.market_hash_name, p.lowest_price_cents
      FROM skin_variants sv
      JOIN prices p ON sv.market_hash_name = p.market_hash_name
      WHERE sv.skin_id = ? AND sv.is_stattrak = ? AND sv.is_souvenir = 0
      AND p.lowest_price_cents IS NOT NULL AND p.lowest_price_cents > 0
      ORDER BY p.lowest_price_cents ASC
      LIMIT 1
    `).get(row.skin_id, stattrakFilter) as { wear_name: string; market_hash_name: string; lowest_price_cents: number } | undefined;

    if (!cheapest) continue;

    inputCandidates.push({
      skin_id: row.skin_id,
      skin_name: row.skin_name,
      weapon_name: row.weapon_name,
      collection_id: row.collection_id,
      collection_name: row.collection_name,
      cheapest_price_cents: cheapest.lowest_price_cents,
      cheapest_wear: cheapest.wear_name,
      market_hash_name: cheapest.market_hash_name,
      image_url: row.image_url,
      contains_target: targetCollectionIds.has(row.collection_id),
    });
  }

  // Also get filler skins from other collections at the same rarity (cheaper but reduce probability)
  const fillerSkins = db.prepare(`
    SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
           cs.collection_id, c.name as collection_name
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    JOIN collections c ON cs.collection_id = c.id
    WHERE cs.collection_id NOT IN (${targetColPlaceholders})
    AND cs.rarity_id = ?
    AND s.has_souvenir = 0
  `).all(...targetCollectionIds, inputRarityId) as (InputCandidate & { collection_id: string; collection_name: string })[];

  // Get cheapest fillers (limit to top 20 cheapest to keep it manageable)
  const fillerCandidates: InputCandidate[] = [];
  const seenFiller = new Set<string>();

  for (const row of fillerSkins) {
    if (seenFiller.has(row.skin_id)) continue;
    seenFiller.add(row.skin_id);

    const cheapest = db.prepare(`
      SELECT sv.wear_name, sv.market_hash_name, p.lowest_price_cents
      FROM skin_variants sv
      JOIN prices p ON sv.market_hash_name = p.market_hash_name
      WHERE sv.skin_id = ? AND sv.is_stattrak = ? AND sv.is_souvenir = 0
      AND p.lowest_price_cents IS NOT NULL AND p.lowest_price_cents > 0
      ORDER BY p.lowest_price_cents ASC
      LIMIT 1
    `).get(row.skin_id, stattrakFilter) as { wear_name: string; market_hash_name: string; lowest_price_cents: number } | undefined;

    if (!cheapest) continue;

    fillerCandidates.push({
      skin_id: row.skin_id,
      skin_name: row.skin_name,
      weapon_name: row.weapon_name,
      collection_id: row.collection_id,
      collection_name: row.collection_name,
      cheapest_price_cents: cheapest.lowest_price_cents,
      cheapest_wear: cheapest.wear_name,
      market_hash_name: cheapest.market_hash_name,
      image_url: row.image_url,
      contains_target: false,
    });
  }

  fillerCandidates.sort((a, b) => a.cheapest_price_cents - b.cheapest_price_cents);
  const topFillers = fillerCandidates.slice(0, 20);

  // Get all output skins at target rarity from all involved collections
  const allOutputSkins = getOutputSkins(db, targetSkin.rarity_id, targetCollectionIds, stattrakFilter);

  // Generate candidate tradeup combinations
  const combos: TradeupCombo[] = [];

  // Strategy 1: Fill all 10 slots with cheapest input from target collections
  if (inputCandidates.length > 0) {
    const cheapestInput = [...inputCandidates].sort((a, b) => a.cheapest_price_cents - b.cheapest_price_cents)[0];
    const combo = buildCombo(Array(10).fill(cheapestInput), targetSkinId, targetSkin, allOutputSkins, targetCollectionIds, db);
    if (combo) combos.push(combo);
  }

  // Strategy 2: For each unique input skin from target collections, fill all 10 slots
  const uniqueInputs = new Map<string, InputCandidate>();
  for (const c of inputCandidates) {
    if (!uniqueInputs.has(c.skin_id) || c.cheapest_price_cents < uniqueInputs.get(c.skin_id)!.cheapest_price_cents) {
      uniqueInputs.set(c.skin_id, c);
    }
  }

  for (const input of uniqueInputs.values()) {
    const combo = buildCombo(Array(10).fill(input), targetSkinId, targetSkin, allOutputSkins, targetCollectionIds, db);
    if (combo) combos.push(combo);
  }

  // Strategy 3: Mix target-collection skins with fillers (try 1-9 fillers)
  if (topFillers.length > 0 && inputCandidates.length > 0) {
    const cheapestTarget = [...inputCandidates].sort((a, b) => a.cheapest_price_cents - b.cheapest_price_cents)[0];
    const cheapestFiller = topFillers[0];

    for (let numFillers = 1; numFillers <= 7; numFillers += 2) {
      const inputs = [
        ...Array(10 - numFillers).fill(cheapestTarget),
        ...Array(numFillers).fill(cheapestFiller),
      ];

      // Need to get output skins from filler collections too
      const allCollectionIds = new Set([...targetCollectionIds, cheapestFiller.collection_id]);
      const expandedOutputs = getOutputSkins(db, targetSkin.rarity_id, allCollectionIds, stattrakFilter);

      const combo = buildCombo(inputs, targetSkinId, targetSkin, expandedOutputs, targetCollectionIds, db);
      if (combo) combos.push(combo);
    }
  }

  // Deduplicate and rank by cost_per_attempt
  const seen = new Set<string>();
  const uniqueCombos = combos.filter((c) => {
    const key = c.inputs.map((i) => `${i.skin_id}:${i.quantity}`).sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  uniqueCombos.sort((a, b) => a.cost_per_attempt_cents - b.cost_per_attempt_cents);
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

function buildCombo(
  inputs: InputCandidate[],
  targetSkinId: string,
  targetSkin: SkinRow,
  outputSkins: OutputSkin[],
  targetCollectionIds: Set<string>,
  db: ReturnType<typeof getDb>
): TradeupCombo | null {
  const totalInputs = inputs.length;

  // Count inputs per collection
  const inputsPerCollection = new Map<string, number>();
  for (const input of inputs) {
    inputsPerCollection.set(input.collection_id, (inputsPerCollection.get(input.collection_id) ?? 0) + 1);
  }

  // Calculate probabilities for each outcome
  const outcomeProbs = new Map<string, number>();
  for (const [collectionId, count] of inputsPerCollection) {
    const collectionOutputs = outputSkins.filter((o) => o.collection_id === collectionId);
    const numOutputs = collectionOutputs.length;
    if (numOutputs === 0) continue;

    const probPerSkin = (count / totalInputs) * (1 / numOutputs);
    for (const output of collectionOutputs) {
      outcomeProbs.set(output.skin_id, (outcomeProbs.get(output.skin_id) ?? 0) + probPerSkin);
    }
  }

  const targetProb = outcomeProbs.get(targetSkinId) ?? 0;
  if (targetProb === 0) return null;

  const totalCost = inputs.reduce((sum, i) => sum + i.cheapest_price_cents, 0);
  const costPerAttempt = Math.round(totalCost / targetProb);

  // Calculate EV
  let ev = -totalCost;
  for (const [skinId, prob] of outcomeProbs) {
    const output = outputSkins.find((o) => o.skin_id === skinId);
    if (output?.price_cents) {
      ev += output.price_cents * prob;
    }
  }

  // Aggregate inputs by skin
  const inputMap = new Map<string, typeof inputs[0] & { quantity: number }>();
  for (const input of inputs) {
    const key = input.skin_id;
    const existing = inputMap.get(key);
    if (existing) {
      existing.quantity++;
    } else {
      inputMap.set(key, { ...input, quantity: 1 });
    }
  }

  // Build all_outcomes
  const allOutcomes = Array.from(outcomeProbs.entries())
    .map(([skinId, prob]) => {
      const output = outputSkins.find((o) => o.skin_id === skinId);
      return {
        skin_id: skinId,
        skin_name: output?.skin_name ?? 'Unknown',
        weapon_name: output?.weapon_name ?? '',
        probability: Math.round(prob * 10000) / 10000,
        price_cents: output?.price_cents ?? null,
        image_url: output?.image_url ?? null,
        is_target: skinId === targetSkinId,
      };
    })
    .sort((a, b) => b.probability - a.probability);

  return {
    rank: 0,
    inputs: Array.from(inputMap.values()).map((i) => ({
      skin_id: i.skin_id,
      skin_name: i.skin_name,
      weapon_name: i.weapon_name,
      wear_name: i.cheapest_wear,
      price_cents: i.cheapest_price_cents,
      collection_id: i.collection_id,
      collection_name: i.collection_name,
      market_hash_name: i.market_hash_name,
      image_url: i.image_url,
      quantity: i.quantity,
    })),
    total_cost_cents: totalCost,
    probability: Math.round(targetProb * 10000) / 10000,
    cost_per_attempt_cents: costPerAttempt,
    ev_cents: Math.round(ev),
    all_outcomes: allOutcomes,
  };
}

function getOutputSkins(
  db: ReturnType<typeof getDb>,
  targetRarityId: string,
  collectionIds: Set<string>,
  stattrakFilter: number
): OutputSkin[] {
  const ids = [...collectionIds];
  const placeholders = ids.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT DISTINCT s.id as skin_id, s.name as skin_name, s.weapon_name, s.image_url,
           cs.collection_id, c.name as collection_name
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    JOIN collections c ON cs.collection_id = c.id
    WHERE cs.collection_id IN (${placeholders})
    AND cs.rarity_id = ?
  `).all(...ids, targetRarityId) as (OutputSkin & { skin_id: string })[];

  // Get cheapest price for each output skin at the target stattrak level
  return rows.map((row) => {
    const price = db.prepare(`
      SELECT MIN(p.lowest_price_cents) as price
      FROM skin_variants sv
      JOIN prices p ON sv.market_hash_name = p.market_hash_name
      WHERE sv.skin_id = ? AND sv.is_stattrak = ? AND sv.is_souvenir = 0
      AND p.lowest_price_cents IS NOT NULL
    `).get(row.skin_id, stattrakFilter) as { price: number | null } | undefined;

    return {
      ...row,
      price_cents: price?.price ?? null,
    };
  });
}
