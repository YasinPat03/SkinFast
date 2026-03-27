import sql from './db';
import { TRADEUP_INPUT_RARITY } from './types';
import {
  TRADEUP_EXCLUDED_COLLECTION_IDS,
  TRADEUP_EXCLUDED_COLLECTION_REASON,
  hasTradeupExcludedCollection,
  isTradeupExcludedCollectionId,
} from './tradeup-rules';

interface SkinRow {
  id: string;
  name: string;
  weapon_name: string;
  pattern_name: string;
  rarity_id: string;
  rarity_name: string;
  min_float: number;
  max_float: number;
  has_stattrak: boolean;
  has_souvenir: boolean;
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
    input_skins: (SkinRow & { cheapest_price_cents: number | null; is_last_sold_price: boolean })[];
    output_skins: (SkinRow & { cheapest_price_cents: number | null; is_last_sold_price: boolean })[];
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

// Check if a skin is a knife or glove based on weapon_name
function isKnifeOrGlove(weaponName: string): boolean {
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

function isGlove(weaponName: string): boolean {
  const lower = weaponName.toLowerCase();
  return lower.includes('gloves') || lower.includes('wraps');
}

function isKnife(weaponName: string): boolean {
  return isKnifeOrGlove(weaponName) && !isGlove(weaponName);
}

export async function getTradeupEligibility(skinId: string): Promise<TradeupEligibility> {
  const skinRows = await sql<SkinRow[]>`SELECT * FROM skins WHERE id = ${skinId}`;
  const skin = skinRows[0];
  if (!skin) {
    return { eligible: false, reason: 'Skin not found' };
  }

  // Consumer Grade (tier 1) cannot be a tradeup output
  if (skin.rarity_id === 'rarity_common_weapon') {
    return { eligible: false, reason: 'Consumer Grade skins cannot be obtained via tradeup' };
  }

  // Check if this is a knife/glove — these use gold tradeups via crates
  const skinIsKnifeOrGlove = isKnifeOrGlove(skin.weapon_name);

  if (skinIsKnifeOrGlove) {
    return getGoldTradeupEligibility(skinId);
  }

  // Standard tradeup: check collections
  const collections = await sql<CollectionRow[]>`
    SELECT c.id, c.name, c.image_url
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    WHERE cs.skin_id = ${skinId}
  `;

  if (collections.length === 0) {
    return { eligible: false, reason: 'This skin does not belong to any collection' };
  }

  if (hasTradeupExcludedCollection(collections.map((collection) => collection.id))) {
    return { eligible: false, reason: TRADEUP_EXCLUDED_COLLECTION_REASON };
  }

  // Determine input rarity
  const inputRarityId = TRADEUP_INPUT_RARITY[skin.rarity_id];
  if (!inputRarityId) {
    return { eligible: false, reason: 'No valid input rarity for this skin tier' };
  }

  const inputRarityName = RARITY_NAMES[inputRarityId] ?? inputRarityId;
  const targetRarityId = skin.rarity_id;

  const collectionIds = collections.map((c) => c.id);

  // Input skins: same collections, one rarity tier below
  const inputSkins = await sql<InputSkinRow[]>`
    SELECT DISTINCT s.*, cs.collection_id
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    WHERE cs.collection_id IN ${sql(collectionIds)}
    AND cs.rarity_id = ${inputRarityId}
    AND cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
  `;

  if (inputSkins.length === 0) {
    return { eligible: false, reason: `No ${inputRarityName} skins found in the same collection(s)` };
  }

  // Output skins (competitors): same collections, same rarity as target
  const outputSkins = await sql<OutputSkinRow[]>`
    SELECT DISTINCT s.*, cs.collection_id
    FROM skins s
    JOIN collection_skins cs ON s.id = cs.skin_id
    WHERE cs.collection_id IN ${sql(collectionIds)}
    AND cs.rarity_id = ${targetRarityId}
    AND cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
  `;

  // Get cheapest prices for input and output skins
  const allSkinIds = [...new Set([...inputSkins.map((s) => s.id), ...outputSkins.map((s) => s.id)])];
  const cheapestPrices = await getCheapestPrices(allSkinIds);

  // Group by collection
  const collectionData = collections.map((col) => {
    const colInputs = inputSkins
      .filter((s) => s.collection_id === col.id)
      .map((s) => {
        const priceInfo = cheapestPrices.get(s.id);
        return { ...s, cheapest_price_cents: priceInfo?.price ?? null, is_last_sold_price: priceInfo?.isLastSold ?? false };
      });

    const colOutputs = outputSkins
      .filter((s) => s.collection_id === col.id)
      .map((s) => {
        const priceInfo = cheapestPrices.get(s.id);
        return { ...s, cheapest_price_cents: priceInfo?.price ?? null, is_last_sold_price: priceInfo?.isLastSold ?? false };
      });

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

// Gold tradeup for knives/gloves: 5 Covert inputs from the same crates
async function getGoldTradeupEligibility(skinId: string): Promise<TradeupEligibility> {
  // Find crates that contain this knife/glove (in contains_rare)
  const crates = await sql<CollectionRow[]>`
    SELECT cr.id, cr.name, cr.image_url
    FROM crates cr
    JOIN crate_skins cs ON cr.id = cs.crate_id
    WHERE cs.skin_id = ${skinId}
    AND cs.is_rare = TRUE
  `;

  if (crates.length === 0) {
    return { eligible: false, reason: 'This knife/glove is not found in any cases' };
  }

  const inputRarityId = 'rarity_ancient_weapon'; // Covert
  const inputRarityName = RARITY_NAMES[inputRarityId] ?? 'Covert';

  const crateIds = crates.map((c) => c.id);

  // Input skins: Covert skins from the same crates, NOT knives/gloves (is_rare = false)
  const inputSkins = await sql<InputSkinRow[]>`
    SELECT DISTINCT s.*, cs.crate_id as collection_id
    FROM skins s
    JOIN crate_skins cs ON s.id = cs.skin_id
    WHERE cs.crate_id IN ${sql(crateIds)}
    AND cs.rarity_id = ${inputRarityId}
    AND cs.is_rare = FALSE
  `;

  // Output skins: all knives/gloves (is_rare = true) from the same crates
  const outputSkins = await sql<OutputSkinRow[]>`
    SELECT DISTINCT s.*, cs.crate_id as collection_id
    FROM skins s
    JOIN crate_skins cs ON s.id = cs.skin_id
    WHERE cs.crate_id IN ${sql(crateIds)}
    AND cs.is_rare = TRUE
  `;

  // Get cheapest prices
  const allSkinIds = [...new Set([...inputSkins.map((s) => s.id), ...outputSkins.map((s) => s.id)])];
  const cheapestPrices = await getCheapestPrices(allSkinIds);

  // Group by crate
  const collectionData = crates.map((crate) => {
    const crateInputs = inputSkins
      .filter((s) => s.collection_id === crate.id)
      .map((s) => {
        const priceInfo = cheapestPrices.get(s.id);
        return { ...s, cheapest_price_cents: priceInfo?.price ?? null, is_last_sold_price: priceInfo?.isLastSold ?? false };
      });

    const crateOutputs = outputSkins
      .filter((s) => s.collection_id === crate.id)
      .map((s) => {
        const priceInfo = cheapestPrices.get(s.id);
        return { ...s, cheapest_price_cents: priceInfo?.price ?? null, is_last_sold_price: priceInfo?.isLastSold ?? false };
      });

    return {
      id: crate.id,
      name: crate.name,
      image_url: crate.image_url,
      input_skins: crateInputs,
      output_skins: crateOutputs,
    };
  });

  if (inputSkins.length === 0) {
    return { eligible: false, reason: 'No Covert skins found in the same case(s) for gold tradeup' };
  }

  return {
    eligible: true,
    input_rarity_id: inputRarityId,
    input_rarity_name: inputRarityName,
    input_type: 'gold',
    num_inputs_required: 5,
    collections: collectionData,
  };
}

// Get cheapest non-StatTrak, non-Souvenir price for each skin, falling back to median (last sold) if no listing
async function getCheapestPrices(skinIds: string[]): Promise<Map<string, { price: number; isLastSold: boolean }>> {
  if (skinIds.length === 0) return new Map();

  const rows = await sql<{ skin_id: string; cheapest_listing: number | null; cheapest_last_sold: number | null }[]>`
    SELECT sv.skin_id,
           MIN(p.lowest_price_cents) as cheapest_listing,
           MIN(p.median_price_cents) as cheapest_last_sold
    FROM skin_variants sv
    JOIN prices p ON sv.market_hash_name = p.market_hash_name
    WHERE sv.skin_id IN ${sql(skinIds)}
    AND sv.is_stattrak = FALSE
    AND sv.is_souvenir = FALSE
    GROUP BY sv.skin_id
  `;

  const map = new Map<string, { price: number; isLastSold: boolean }>();
  for (const row of rows) {
    if (row.cheapest_listing != null) {
      map.set(row.skin_id, { price: row.cheapest_listing, isLastSold: false });
    } else if (row.cheapest_last_sold != null) {
      map.set(row.skin_id, { price: row.cheapest_last_sold, isLastSold: true });
    }
  }
  return map;
}

// Calculate probability of landing a specific target skin given a set of inputs
export async function calculateTradeupProbability(
  targetSkinId: string,
  inputs: { skinId: string; collectionId: string }[],
  isGoldTradeup: boolean = false,
  isStatTrakTradeup: boolean = false
): Promise<{ probability: number; outcomes: { skinId: string; skinName: string; collectionId: string; probability: number }[] }> {
  const totalInputs = inputs.length;

  // Count inputs per collection/crate
  const inputsPerCollection = new Map<string, number>();
  for (const input of inputs) {
    inputsPerCollection.set(input.collectionId, (inputsPerCollection.get(input.collectionId) ?? 0) + 1);
  }

  // Get target skin info
  const targetSkinRows = await sql<SkinRow[]>`SELECT * FROM skins WHERE id = ${targetSkinId}`;
  const targetSkin = targetSkinRows[0];
  if (!targetSkin) {
    return { probability: 0, outcomes: [] };
  }
  const targetRarityId = targetSkin.rarity_id;

  if (!isGoldTradeup) {
    const targetCollections = await sql<{ collection_id: string }[]>`
      SELECT collection_id
      FROM collection_skins
      WHERE skin_id = ${targetSkinId}
    `;

    if (hasTradeupExcludedCollection(targetCollections.map((collection) => collection.collection_id))) {
      return { probability: 0, outcomes: [] };
    }
  }

  // For each collection/crate that has inputs, find all possible output skins
  const outcomes: { skinId: string; skinName: string; collectionId: string; probability: number }[] = [];
  const skinProbabilities = new Map<string, number>();

  for (const [collectionId, inputCount] of inputsPerCollection) {
    let outputSkins: { id: string; name: string; weapon_name: string }[];

    if (isGoldTradeup) {
      outputSkins = await sql<{ id: string; name: string; weapon_name: string }[]>`
        SELECT s.id, s.name, s.weapon_name
        FROM skins s
        JOIN crate_skins cs ON s.id = cs.skin_id
        WHERE cs.crate_id = ${collectionId}
        AND cs.is_rare = TRUE
      `;

      if (isStatTrakTradeup) {
        outputSkins = outputSkins.filter((skin) => isKnife(skin.weapon_name));
      }
    } else {
      if (isTradeupExcludedCollectionId(collectionId)) {
        continue;
      }

      outputSkins = await sql<{ id: string; name: string; weapon_name: string }[]>`
        SELECT s.id, s.name, s.weapon_name
        FROM skins s
        JOIN collection_skins cs ON s.id = cs.skin_id
        WHERE cs.collection_id = ${collectionId}
        AND cs.rarity_id = ${targetRarityId}
        AND cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
      `;
    }

    const numOutputs = outputSkins.length;
    if (numOutputs === 0) continue;

    const probPerSkin = (inputCount / totalInputs) * (1 / numOutputs);

    for (const skin of outputSkins) {
      const existing = skinProbabilities.get(skin.id) ?? 0;
      skinProbabilities.set(skin.id, existing + probPerSkin);

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

  // Merge outcomes by skin (same skin from different collections/crates)
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
