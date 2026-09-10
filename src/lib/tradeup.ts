import sql from './db';
import { TRADEUP_INPUT_RARITY } from './types';
import {
  TRADEUP_EXCLUDED_COLLECTION_IDS,
  TRADEUP_EXCLUDED_COLLECTION_REASON,
  goldOutcomeKey,
  groupRows,
  hasTradeupExcludedCollection,
  isKnifeOrGloveWeapon,
  isKnifeWeapon,
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
    // Only skins with an active Steam listing: unlisted skins are never used as inputs.
    input_skins: (SkinRow & {
      cheapest_price_cents: number;
      cheapest_is_souvenir: boolean;
    })[];
    // Input-rarity skins in this collection hidden because they have no active listing.
    unlisted_input_count: number;
    output_skins: (SkinRow & {
      // Cheapest last-5-sold avg across normal wears; outcomes are never priced from listings.
      cheapest_price_cents: number | null;
      // False when no normal (non-souvenir) wear of this skin is actively listed.
      has_active_listing: boolean;
      // Skin ids merged into this outcome (Doppler phases share one loot entry).
      alias_ids: string[];
    })[];
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
  const skinIsKnifeOrGlove = isKnifeOrGloveWeapon(skin.weapon_name);

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

  // Group by collection. Inputs are priced at the current listing (must be buyable);
  // outputs are priced at the last-5 sold avg (what the user would realize selling).
  const collectionData = collections.map((col) => {
    const { listed: colInputs, unlistedCount } = buildListedInputs(
      inputSkins.filter((s) => s.collection_id === col.id),
      cheapestPrices
    );

    const colOutputs = outputSkins
      .filter((s) => s.collection_id === col.id)
      .map((s) => {
        const priceInfo = cheapestPrices.get(s.id);
        return {
          ...s,
          cheapest_price_cents: priceInfo?.lastSold ?? null,
          has_active_listing: priceInfo?.normalListing != null,
          alias_ids: [s.id],
        };
      });

    return {
      id: col.id,
      name: col.name,
      image_url: col.image_url,
      input_skins: colInputs,
      unlisted_input_count: unlistedCount,
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
  const outputSkinRows = await sql<OutputSkinRow[]>`
    SELECT DISTINCT s.*, cs.crate_id as collection_id
    FROM skins s
    JOIN crate_skins cs ON s.id = cs.skin_id
    WHERE cs.crate_id IN ${sql(crateIds)}
    AND cs.is_rare = TRUE
  `;

  // Get cheapest prices
  const allSkinIds = [...new Set([...inputSkins.map((s) => s.id), ...outputSkinRows.map((s) => s.id)])];
  const cheapestPrices = await getCheapestPrices(allSkinIds);

  // Doppler-style phases are one loot entry: collapse them, keeping the phase row that
  // actually carries market data (all phases share one listing) as the representative.
  const outputSkins = groupRows(outputSkinRows, (row) => goldOutcomeKey(row.collection_id, row.name))
    .map((group) => {
      const priced = group.filter((row) => cheapestPrices.get(row.id)?.lastSold != null);
      const representative = priced[0] ?? group[0];
      const lastSold = priced.reduce<number | null>((min, row) => {
        const value = cheapestPrices.get(row.id)!.lastSold!;
        return min == null || value < min ? value : min;
      }, null);
      const hasListing = group.some((row) => cheapestPrices.get(row.id)?.normalListing != null);
      return {
        ...representative,
        collapsed_last_sold: lastSold,
        collapsed_has_listing: hasListing,
        alias_ids: group.map((row) => row.id),
      };
    });

  // Group by crate. Same split as standard: inputs from listings, outputs from last-5 avg.
  const collectionData = crates.map((crate) => {
    const { listed: crateInputs, unlistedCount } = buildListedInputs(
      inputSkins.filter((s) => s.collection_id === crate.id),
      cheapestPrices
    );

    const crateOutputs = outputSkins
      .filter((s) => s.collection_id === crate.id)
      .map(({ collapsed_last_sold, collapsed_has_listing, ...s }) => ({
        ...s,
        cheapest_price_cents: collapsed_last_sold,
        has_active_listing: collapsed_has_listing,
      }));

    return {
      id: crate.id,
      name: crate.name,
      image_url: crate.image_url,
      input_skins: crateInputs,
      unlisted_input_count: unlistedCount,
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

interface CheapestPriceInfo {
  // Cheapest active listing across normal and souvenir wears (both are legal inputs).
  listing: number | null;
  listingIsSouvenir: boolean;
  // Cheapest active listing across normal wears only (an output is never a souvenir).
  normalListing: number | null;
  lastSold: number | null;
}

// Inputs must be buyable right now: skins without an active listing (normal or souvenir) are
// dropped and only counted, so the UI can say how many were hidden.
function buildListedInputs(
  rows: InputSkinRow[],
  cheapestPrices: Map<string, CheapestPriceInfo>
): {
  listed: (InputSkinRow & { cheapest_price_cents: number; cheapest_is_souvenir: boolean })[];
  unlistedCount: number;
} {
  const listed: (InputSkinRow & { cheapest_price_cents: number; cheapest_is_souvenir: boolean })[] = [];
  let unlistedCount = 0;

  for (const row of rows) {
    const priceInfo = cheapestPrices.get(row.id);
    if (priceInfo?.listing == null) {
      unlistedCount++;
      continue;
    }
    listed.push({
      ...row,
      cheapest_price_cents: priceInfo.listing,
      cheapest_is_souvenir: priceInfo.listingIsSouvenir,
    });
  }

  return { listed, unlistedCount };
}

// For each non-StatTrak skin, return the cheapest current listing for input pricing
// (normal or souvenir — both are legal inputs) and the cheapest last-5-sold avg for
// output pricing (normal variants only, since a contract never produces a souvenir).
async function getCheapestPrices(skinIds: string[]): Promise<Map<string, CheapestPriceInfo>> {
  if (skinIds.length === 0) return new Map();

  const rows = await sql<{
    skin_id: string;
    is_souvenir: boolean;
    lowest_price_cents: number | null;
    avg_last5_cents: number | null;
  }[]>`
    SELECT sv.skin_id, sv.is_souvenir, p.lowest_price_cents, l.avg_last5_cents
    FROM skin_variants sv
    LEFT JOIN prices p ON sv.market_hash_name = p.market_hash_name
    LEFT JOIN last_sold_avg l ON sv.market_hash_name = l.market_hash_name
    WHERE sv.skin_id IN ${sql(skinIds)}
    AND sv.is_stattrak = FALSE
  `;

  const map = new Map<string, CheapestPriceInfo>();
  for (const row of rows) {
    const info = map.get(row.skin_id) ?? { listing: null, listingIsSouvenir: false, normalListing: null, lastSold: null };

    if (row.lowest_price_cents != null && row.lowest_price_cents > 0) {
      if (info.listing == null || row.lowest_price_cents < info.listing) {
        info.listing = row.lowest_price_cents;
        info.listingIsSouvenir = row.is_souvenir;
      }
      if (!row.is_souvenir && (info.normalListing == null || row.lowest_price_cents < info.normalListing)) {
        info.normalListing = row.lowest_price_cents;
      }
    }

    if (!row.is_souvenir && row.avg_last5_cents != null && row.avg_last5_cents > 0
      && (info.lastSold == null || row.avg_last5_cents < info.lastSold)) {
      info.lastSold = row.avg_last5_cents;
    }

    map.set(row.skin_id, info);
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
  // Doppler phases collapse into a single outcome; remember which id represents the target.
  let resolvedTargetId = targetSkinId;

  for (const [collectionId, inputCount] of inputsPerCollection) {
    let outputSkins: { id: string; name: string; weapon_name: string }[];

    if (isGoldTradeup) {
      const rareRows = await sql<{ id: string; name: string; weapon_name: string }[]>`
        SELECT s.id, s.name, s.weapon_name
        FROM skins s
        JOIN crate_skins cs ON s.id = cs.skin_id
        WHERE cs.crate_id = ${collectionId}
        AND cs.is_rare = TRUE
      `;

      const eligibleRows = isStatTrakTradeup
        ? rareRows.filter((skin) => isKnifeWeapon(skin.weapon_name))
        : rareRows;

      outputSkins = groupRows(eligibleRows, (row) => goldOutcomeKey(collectionId, row.name)).map((group) => {
        if (group.some((row) => row.id === targetSkinId)) {
          resolvedTargetId = group[0].id;
        }
        return group[0];
      });
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

  const targetProbability = skinProbabilities.get(resolvedTargetId) ?? 0;

  return {
    probability: targetProbability,
    outcomes: Array.from(mergedOutcomes.values()).sort((a, b) => b.probability - a.probability),
  };
}
