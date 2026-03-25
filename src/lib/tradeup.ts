import { getDb } from './db';
import { RARITY_TIERS, TRADEUP_INPUT_RARITY } from './types';

interface SkinRow {
  id: string;
  name: string;
  weapon_name: string;
  pattern_name: string;
  rarity_id: string;
  rarity_name: string;
  min_float: number;
  max_float: number;
  has_stattrak: number;
  has_souvenir: number;
  image_url: string | null;
}

interface InputSkinRow extends SkinRow {
  collection_id: string;
}

interface OutputSkinRow extends SkinRow {
  collection_id: string;
}

interface CollectionRow {
  id: string;
  name: string;
  image_url: string | null;
}

interface VariantPriceRow {
  skin_id: string;
  market_hash_name: string;
  wear_name: string;
  is_stattrak: number;
  lowest_price_cents: number | null;
}

export interface TradeupEligibility {
  eligible: boolean;
  reason?: string;
  input_rarity_id?: string;
  input_rarity_name?: string;
  input_type?: 'standard' | 'gold';
  num_inputs_required?: number;
  collections?: {
    id: string;
    name: string;
    image_url: string | null;
    input_skins: (SkinRow & { cheapest_price_cents: number | null })[];
    output_skins: (SkinRow & { cheapest_price_cents: number | null })[];
  }[];
}

// Rarity ID to human-readable name
const RARITY_NAMES: Record<string, string> = {
  rarity_common_weapon: 'Consumer Grade',
  rarity_uncommon_weapon: 'Industrial Grade',
  rarity_rare_weapon: 'Mil-Spec Grade',
  rarity_mythical_weapon: 'Restricted',
  rarity_legendary_weapon: 'Classified',
  rarity_ancient_weapon: 'Covert',
};

export function getTradeupEligibility(skinId: string): TradeupEligibility {
  const db = getDb();

  const skin = db.prepare('SELECT * FROM skins WHERE id = ?').get(skinId) as SkinRow | undefined;
  if (!skin) {
    return { eligible: false, reason: 'Skin not found' };
  }

  const rarityTier = RARITY_TIERS[skin.rarity_id];

  // Consumer Grade (tier 1) cannot be a tradeup output
  if (skin.rarity_id === 'rarity_common_weapon') {
    return { eligible: false, reason: 'Consumer Grade skins cannot be obtained via tradeup' };
  }

  // Check if this skin belongs to any collection
  const collections = db.prepare(`
    SELECT c.id, c.name, c.image_url
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    WHERE cs.skin_id = ?
  `).all(skinId) as CollectionRow[];

  if (collections.length === 0) {
    return { eligible: false, reason: 'This skin does not belong to any collection (case-only skins cannot be tradeup outputs)' };
  }

  // Determine input rarity
  const inputRarityId = TRADEUP_INPUT_RARITY[skin.rarity_id];
  if (!inputRarityId) {
    return { eligible: false, reason: 'No valid input rarity for this skin tier' };
  }

  const inputRarityName = RARITY_NAMES[inputRarityId] ?? inputRarityId;
  const targetRarityId = skin.rarity_id;

  // For each collection, find input skins (one tier below) and output skins (same tier as target)
  const collectionIds = collections.map((c) => c.id);
  const placeholders = collectionIds.map(() => '?').join(',');

  // Input skins: same collections, one rarity tier below
  const inputSkins = db.prepare(`
    SELECT DISTINCT s.*, cs.collection_id
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    WHERE cs.collection_id IN (${placeholders})
    AND cs.rarity_id = ?
  `).all(...collectionIds, inputRarityId) as InputSkinRow[];

  // If no input skins exist, tradeup is not possible
  if (inputSkins.length === 0) {
    return { eligible: false, reason: `No ${inputRarityName} skins found in the same collection(s)` };
  }

  // Output skins (competitors): same collections, same rarity as target
  const outputSkins = db.prepare(`
    SELECT DISTINCT s.*, cs.collection_id
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    WHERE cs.collection_id IN (${placeholders})
    AND cs.rarity_id = ?
  `).all(...collectionIds, targetRarityId) as OutputSkinRow[];

  // Get cheapest prices for input and output skins
  const allSkinIds = [...new Set([...inputSkins.map((s) => s.id), ...outputSkins.map((s) => s.id)])];
  const cheapestPrices = getCheapestPrices(allSkinIds);

  // Group by collection
  const collectionData = collections.map((col) => {
    const colInputs = inputSkins
      .filter((s) => s.collection_id === col.id)
      .map((s) => ({
        ...s,
        cheapest_price_cents: cheapestPrices.get(s.id) ?? null,
      }));

    const colOutputs = outputSkins
      .filter((s) => s.collection_id === col.id)
      .map((s) => ({
        ...s,
        cheapest_price_cents: cheapestPrices.get(s.id) ?? null,
      }));

    return {
      id: col.id,
      name: col.name,
      image_url: col.image_url,
      input_skins: colInputs,
      output_skins: colOutputs,
    };
  });

  return {
    eligible: true,
    input_rarity_id: inputRarityId,
    input_rarity_name: inputRarityName,
    input_type: 'standard',
    num_inputs_required: 10,
    collections: collectionData,
  };
}

// Get cheapest non-StatTrak, non-Souvenir price for each skin
function getCheapestPrices(skinIds: string[]): Map<string, number> {
  if (skinIds.length === 0) return new Map();

  const db = getDb();
  const placeholders = skinIds.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT sv.skin_id, MIN(p.lowest_price_cents) as cheapest_price_cents
    FROM skin_variants sv
    JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE sv.skin_id IN (${placeholders})
    AND sv.is_stattrak = 0
    AND sv.is_souvenir = 0
    AND p.lowest_price_cents IS NOT NULL
    GROUP BY sv.skin_id
  `).all(...skinIds) as { skin_id: string; cheapest_price_cents: number }[];

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.skin_id, row.cheapest_price_cents);
  }
  return map;
}

// Calculate probability of landing a specific target skin given a set of inputs
export function calculateTradeupProbability(
  targetSkinId: string,
  inputs: { skinId: string; collectionId: string }[]
): { probability: number; outcomes: { skinId: string; skinName: string; collectionId: string; probability: number }[] } {
  const db = getDb();
  const totalInputs = inputs.length;

  // Count inputs per collection
  const inputsPerCollection = new Map<string, number>();
  for (const input of inputs) {
    inputsPerCollection.set(input.collectionId, (inputsPerCollection.get(input.collectionId) ?? 0) + 1);
  }

  // Get target skin info
  const targetSkin = db.prepare('SELECT * FROM skins WHERE id = ?').get(targetSkinId) as SkinRow;
  const targetRarityId = targetSkin.rarity_id;

  // For each collection that has inputs, find all skins at target rarity
  const outcomes: { skinId: string; skinName: string; collectionId: string; probability: number }[] = [];
  const skinProbabilities = new Map<string, number>();

  for (const [collectionId, inputCount] of inputsPerCollection) {
    // Get all skins at target rarity in this collection
    const outputSkins = db.prepare(`
      SELECT s.id, s.name
      FROM skins s
      JOIN collection_skins cs ON s.id = cs.skin_id
      WHERE cs.collection_id = ?
      AND cs.rarity_id = ?
    `).all(collectionId, targetRarityId) as { id: string; name: string }[];

    const numOutputs = outputSkins.length;
    if (numOutputs === 0) continue;

    const probPerSkin = (inputCount / totalInputs) * (1 / numOutputs);

    for (const skin of outputSkins) {
      const existing = skinProbabilities.get(skin.id) ?? 0;
      skinProbabilities.set(skin.id, existing + probPerSkin);

      // Only add to outcomes if not already there (could appear from multiple collections)
      if (!outcomes.find((o) => o.skinId === skin.id && o.collectionId === collectionId)) {
        outcomes.push({
          skinId: skin.id,
          skinName: skin.name,
          collectionId,
          probability: probPerSkin,
        });
      }
    }
  }

  // Merge outcomes by skin (same skin from different collections)
  const mergedOutcomes = new Map<string, { skinId: string; skinName: string; collectionId: string; probability: number }>();
  for (const outcome of outcomes) {
    const existing = mergedOutcomes.get(outcome.skinId);
    if (existing) {
      existing.probability += outcome.probability;
    } else {
      mergedOutcomes.set(outcome.skinId, { ...outcome });
    }
  }

  const targetProbability = skinProbabilities.get(targetSkinId) ?? 0;

  return {
    probability: targetProbability,
    outcomes: Array.from(mergedOutcomes.values()).sort((a, b) => b.probability - a.probability),
  };
}
