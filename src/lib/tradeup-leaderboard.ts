import { unstable_cache } from 'next/cache';
import sql from './db';
import { TRADEUP_INPUT_RARITY } from './types';
import { TRADEUP_EXCLUDED_COLLECTION_IDS } from './tradeup-rules';
import {
  calculateOutputFloat,
  calculateTFloat,
  estimateFloat,
  estimateFloatForWearAlignment,
  floatToWear,
  getWearOrderIndex,
} from './tradeup-floats';

interface MembershipRow {
  collection_id: string;
  collection_name: string;
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  image_url: string | null;
  min_float: number;
  max_float: number;
  rarity_id: string;
}

interface CrateMembershipRow extends MembershipRow {
  is_rare: boolean;
}

interface VariantPriceRow {
  skin_id: string;
  wear_name: string;
  market_hash_name: string;
  lowest_price_cents: number | null;
  last_sold_avg_cents: number | null;
}

interface PriceOption {
  wear_name: string;
  market_hash_name: string;
  price_cents: number;
  is_last_sold_price: boolean;
  assumed_float: number;
  t_float: number;
}

interface PriceLookup {
  // wear_name -> last_sold_avg.avg_last5_cents (volume-weighted last 5 sales)
  last_sold_by_wear: Record<string, number>;
  cheapest_last_sold_cents: number | null;
}

interface SkinMeta {
  skin_id: string;
  min_float: number;
  max_float: number;
}

export interface TradeupLeaderboardOutcome {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  image_url: string | null;
  probability: number;
  expected_float: number;
  expected_wear: string;
  price_cents: number | null;
  is_last_sold_price: boolean;
}

export interface TradeupLeaderboardEntry {
  id: string;
  contract_type: 'standard' | 'gold';
  collection_id: string;
  collection_name: string;
  num_inputs: number;
  input: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    image_url: string | null;
    wear_name: string;
    market_hash_name: string;
    price_cents: number;
    is_last_sold_price: boolean;
    expected_float: number;
  };
  total_cost_cents: number;
  expected_return_cents: number;
  ev_cents: number;
  roi_percent: number;
  outcome_count: number;
  best_outcome_price_cents: number | null;
  has_last_sold_prices: boolean;
  outcomes: TradeupLeaderboardOutcome[];
}

export interface TradeupLeaderboardResult {
  entries: TradeupLeaderboardEntry[];
  total_matches: number;
}

export interface TradeupLeaderboardFilters {
  minCostCents?: number;
  maxCostCents?: number;
  limit?: number;
}

const INPUT_TO_OUTPUT_RARITY = Object.fromEntries(
  Object.entries(TRADEUP_INPUT_RARITY).map(([outputRarityId, inputRarityId]) => [inputRarityId, outputRarityId])
) as Record<string, string>;

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

const getCachedTradeupContracts = unstable_cache(
  async () => {
    const [standardRows, crateRows, variantRows] = await Promise.all([
      sql<MembershipRow[]>`
        SELECT
          cs.collection_id,
          c.name AS collection_name,
          s.id AS skin_id,
          s.name AS skin_name,
          s.weapon_name,
          s.image_url,
          s.min_float,
          s.max_float,
          cs.rarity_id
        FROM collection_skins cs
        JOIN collections c ON c.id = cs.collection_id
        JOIN skins s ON s.id = cs.skin_id
        WHERE cs.collection_id NOT IN ${sql(TRADEUP_EXCLUDED_COLLECTION_IDS)}
      `,
      sql<CrateMembershipRow[]>`
        SELECT
          cs.crate_id AS collection_id,
          cr.name AS collection_name,
          s.id AS skin_id,
          s.name AS skin_name,
          s.weapon_name,
          s.image_url,
          s.min_float,
          s.max_float,
          cs.rarity_id,
          cs.is_rare
        FROM crate_skins cs
        JOIN crates cr ON cr.id = cs.crate_id
        JOIN skins s ON s.id = cs.skin_id
      `,
      sql<VariantPriceRow[]>`
        SELECT
          sv.skin_id,
          sv.wear_name,
          sv.market_hash_name,
          p.lowest_price_cents,
          l.avg_last5_cents AS last_sold_avg_cents
        FROM skin_variants sv
        LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
        LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
        WHERE sv.is_stattrak = FALSE
          AND sv.is_souvenir = FALSE
          AND (
            (p.lowest_price_cents IS NOT NULL AND p.lowest_price_cents > 0)
            OR (l.avg_last5_cents IS NOT NULL AND l.avg_last5_cents > 0)
          )
      `,
    ]);

    const skinMeta = buildSkinMetaMap([...standardRows, ...crateRows]);
    const { wearOptionsBySkinId, priceLookupBySkinId } = buildPriceMaps(variantRows, skinMeta);

    const standardContracts = buildStandardContracts(standardRows, wearOptionsBySkinId, priceLookupBySkinId);
    const goldContracts = buildGoldContracts(crateRows, wearOptionsBySkinId, priceLookupBySkinId);

    return [...standardContracts, ...goldContracts].sort((a, b) => {
      if (b.ev_cents !== a.ev_cents) return b.ev_cents - a.ev_cents;
      return a.total_cost_cents - b.total_cost_cents;
    });
  },
  ['tradeup-leaderboard-contracts-v4'],
  { revalidate: 900 }
);

function buildSkinMetaMap(rows: Array<MembershipRow | CrateMembershipRow>): Map<string, SkinMeta> {
  const map = new Map<string, SkinMeta>();

  for (const row of rows) {
    if (map.has(row.skin_id)) continue;

    map.set(row.skin_id, {
      skin_id: row.skin_id,
      min_float: row.min_float,
      max_float: row.max_float,
    });
  }

  return map;
}

function buildPriceMaps(
  variantRows: VariantPriceRow[],
  skinMeta: Map<string, SkinMeta>
): {
  wearOptionsBySkinId: Map<string, PriceOption[]>;
  priceLookupBySkinId: Map<string, PriceLookup>;
} {
  const wearOptionsBySkinId = new Map<string, PriceOption[]>();
  const priceLookupBySkinId = new Map<string, PriceLookup>();

  for (const row of variantRows) {
    const meta = skinMeta.get(row.skin_id);
    if (!meta) continue;

    const hasListing = row.lowest_price_cents != null && row.lowest_price_cents > 0;
    const lastSoldAvg = row.last_sold_avg_cents != null && row.last_sold_avg_cents > 0 ? row.last_sold_avg_cents : null;

    // Inputs are buyable variants — only build a wear option when there's an active listing.
    if (hasListing) {
      const assumedFloat = estimateFloat(row.wear_name, meta.min_float, meta.max_float);
      const wearOption: PriceOption = {
        wear_name: row.wear_name,
        market_hash_name: row.market_hash_name,
        price_cents: row.lowest_price_cents!,
        is_last_sold_price: false,
        assumed_float: assumedFloat,
        t_float: calculateTFloat(assumedFloat, meta.min_float, meta.max_float),
      };

      const options = wearOptionsBySkinId.get(row.skin_id);
      if (options) {
        options.push(wearOption);
      } else {
        wearOptionsBySkinId.set(row.skin_id, [wearOption]);
      }
    }

    // Outputs are valued at the last-5 sold avg (what the user would realistically realize selling).
    if (lastSoldAvg != null) {
      let lookup = priceLookupBySkinId.get(row.skin_id);
      if (!lookup) {
        lookup = {
          last_sold_by_wear: {},
          cheapest_last_sold_cents: null,
        };
        priceLookupBySkinId.set(row.skin_id, lookup);
      }

      lookup.last_sold_by_wear[row.wear_name] = lastSoldAvg;
      lookup.cheapest_last_sold_cents = lookup.cheapest_last_sold_cents == null
        ? lastSoldAvg
        : Math.min(lookup.cheapest_last_sold_cents, lastSoldAvg);
    }
  }

  for (const wearOptions of wearOptionsBySkinId.values()) {
    wearOptions.sort((a, b) => a.price_cents - b.price_cents || a.t_float - b.t_float);
  }

  return { wearOptionsBySkinId, priceLookupBySkinId };
}

function resolveOutputPrice(
  lookup: PriceLookup | undefined,
  wearName: string
): { price_cents: number | null; is_last_sold_price: boolean } {
  if (!lookup) {
    return { price_cents: null, is_last_sold_price: false };
  }

  // Outputs are valued strictly at the last-5 sold avg.
  const lastSoldPrice = lookup.last_sold_by_wear[wearName];
  if (lastSoldPrice != null) {
    return { price_cents: lastSoldPrice, is_last_sold_price: true };
  }

  if (lookup.cheapest_last_sold_cents != null) {
    return { price_cents: lookup.cheapest_last_sold_cents, is_last_sold_price: true };
  }

  return { price_cents: null, is_last_sold_price: false };
}

function alignOutcomeEstimate(
  inputWearName: string,
  outputFloat: number,
  outputMinFloat: number,
  outputMaxFloat: number
): { expected_float: number; expected_wear: string } {
  const estimatedWear = floatToWear(outputFloat);
  const estimatedWearIndex = getWearOrderIndex(estimatedWear);
  const inputWearIndex = getWearOrderIndex(inputWearName);

  if (estimatedWearIndex === -1 || inputWearIndex === -1 || estimatedWearIndex >= inputWearIndex) {
    return {
      expected_float: outputFloat,
      expected_wear: estimatedWear,
    };
  }

  const alignedFloat = estimateFloatForWearAlignment(inputWearName, outputMinFloat, outputMaxFloat);
  return {
    expected_float: alignedFloat,
    expected_wear: floatToWear(alignedFloat),
  };
}

function buildStandardContracts(
  rows: MembershipRow[],
  wearOptionsBySkinId: Map<string, PriceOption[]>,
  priceLookupBySkinId: Map<string, PriceLookup>
): TradeupLeaderboardEntry[] {
  const rowsByCollection = new Map<string, MembershipRow[]>();

  for (const row of rows) {
    const collectionRows = rowsByCollection.get(row.collection_id);
    if (collectionRows) {
      collectionRows.push(row);
    } else {
      rowsByCollection.set(row.collection_id, [row]);
    }
  }

  const entries: TradeupLeaderboardEntry[] = [];

  for (const [collectionId, collectionRows] of rowsByCollection) {
    const rowsByRarity = new Map<string, MembershipRow[]>();

    for (const row of collectionRows) {
      const rarityRows = rowsByRarity.get(row.rarity_id);
      if (rarityRows) {
        rarityRows.push(row);
      } else {
        rowsByRarity.set(row.rarity_id, [row]);
      }
    }

    for (const [inputRarityId, inputRows] of rowsByRarity) {
      const outputRarityId = INPUT_TO_OUTPUT_RARITY[inputRarityId];
      if (!outputRarityId) continue;

      const outputs = rowsByRarity.get(outputRarityId) ?? [];
      if (outputs.length === 0) continue;

      for (const inputRow of inputRows) {
        const wearOptions = wearOptionsBySkinId.get(inputRow.skin_id) ?? [];
        if (wearOptions.length === 0) continue;

        for (const wearOption of wearOptions) {
          const entry = buildContractEntry({
            contractType: 'standard',
            collectionId,
            collectionName: inputRow.collection_name,
            numInputs: 10,
            inputRow,
            wearOption,
            outputs,
            priceLookupBySkinId,
          });

          if (entry) {
            entries.push(entry);
          }
        }
      }
    }
  }

  return entries;
}

function buildGoldContracts(
  rows: CrateMembershipRow[],
  wearOptionsBySkinId: Map<string, PriceOption[]>,
  priceLookupBySkinId: Map<string, PriceLookup>
): TradeupLeaderboardEntry[] {
  const rowsByCrate = new Map<string, CrateMembershipRow[]>();

  for (const row of rows) {
    const crateRows = rowsByCrate.get(row.collection_id);
    if (crateRows) {
      crateRows.push(row);
    } else {
      rowsByCrate.set(row.collection_id, [row]);
    }
  }

  const entries: TradeupLeaderboardEntry[] = [];

  for (const [crateId, crateRows] of rowsByCrate) {
    const inputs = crateRows.filter((row) => row.rarity_id === 'rarity_ancient_weapon' && !row.is_rare);
    const outputs = crateRows.filter((row) => row.is_rare);

    if (inputs.length === 0 || outputs.length === 0) continue;

    for (const inputRow of inputs) {
      const wearOptions = wearOptionsBySkinId.get(inputRow.skin_id) ?? [];
      if (wearOptions.length === 0) continue;

      for (const wearOption of wearOptions) {
        const entry = buildContractEntry({
          contractType: 'gold',
          collectionId: crateId,
          collectionName: inputRow.collection_name,
          numInputs: 5,
          inputRow,
          wearOption,
          outputs,
          priceLookupBySkinId,
        });

        if (entry) {
          entries.push(entry);
        }
      }
    }
  }

  return entries;
}

function buildContractEntry({
  contractType,
  collectionId,
  collectionName,
  numInputs,
  inputRow,
  wearOption,
  outputs,
  priceLookupBySkinId,
}: {
  contractType: 'standard' | 'gold';
  collectionId: string;
  collectionName: string;
  numInputs: number;
  inputRow: MembershipRow | CrateMembershipRow;
  wearOption: PriceOption;
  outputs: Array<MembershipRow | CrateMembershipRow>;
  priceLookupBySkinId: Map<string, PriceLookup>;
}): TradeupLeaderboardEntry | null {
  if (outputs.length === 0) return null;

  const probability = 1 / outputs.length;
  const totalCost = wearOption.price_cents * numInputs;
  const inputWearIndex = getWearOrderIndex(wearOption.wear_name);
  let expectedReturn = 0;
  let hasLastSoldPrices = wearOption.is_last_sold_price;
  let bestOutcomePrice: number | null = null;
  const outcomes: TradeupLeaderboardOutcome[] = [];

  for (const output of outputs) {
    const outputFloat = calculateOutputFloat(wearOption.t_float, output.min_float, output.max_float);
    const alignedOutcome = alignOutcomeEstimate(
      wearOption.wear_name,
      outputFloat,
      output.min_float,
      output.max_float
    );
    const alignedWearIndex = getWearOrderIndex(alignedOutcome.expected_wear);
    if (inputWearIndex !== -1 && alignedWearIndex !== -1 && alignedWearIndex < inputWearIndex) {
      return null;
    }

    const resolvedPrice = resolveOutputPrice(priceLookupBySkinId.get(output.skin_id), alignedOutcome.expected_wear);

    if (resolvedPrice.price_cents != null) {
      expectedReturn += resolvedPrice.price_cents * probability;
      bestOutcomePrice = bestOutcomePrice == null
        ? resolvedPrice.price_cents
        : Math.max(bestOutcomePrice, resolvedPrice.price_cents);
    }

    if (resolvedPrice.is_last_sold_price) {
      hasLastSoldPrices = true;
    }

    outcomes.push({
      skin_id: output.skin_id,
      skin_name: output.skin_name,
      weapon_name: output.weapon_name,
      image_url: output.image_url,
      probability: Math.round(probability * 10000) / 10000,
      expected_float: Math.round(alignedOutcome.expected_float * 100000) / 100000,
      expected_wear: alignedOutcome.expected_wear,
      price_cents: resolvedPrice.price_cents,
      is_last_sold_price: resolvedPrice.is_last_sold_price,
    });
  }

  outcomes.sort((a, b) => {
    const priceA = a.price_cents ?? -1;
    const priceB = b.price_cents ?? -1;
    return priceB - priceA;
  });

  const ev = Math.round(expectedReturn - totalCost);
  const roiPercent = totalCost > 0 ? Math.round((ev / totalCost) * 10000) / 100 : 0;

  return {
    id: `${contractType}:${collectionId}:${inputRow.skin_id}:${wearOption.wear_name}`,
    contract_type: contractType,
    collection_id: collectionId,
    collection_name: collectionName,
    num_inputs: numInputs,
    input: {
      skin_id: inputRow.skin_id,
      skin_name: inputRow.skin_name,
      weapon_name: inputRow.weapon_name,
      image_url: inputRow.image_url,
      wear_name: wearOption.wear_name,
      market_hash_name: wearOption.market_hash_name,
      price_cents: wearOption.price_cents,
      is_last_sold_price: wearOption.is_last_sold_price,
      expected_float: Math.round(wearOption.assumed_float * 100000) / 100000,
    },
    total_cost_cents: totalCost,
    expected_return_cents: Math.round(expectedReturn),
    ev_cents: ev,
    roi_percent: roiPercent,
    outcome_count: outputs.length,
    best_outcome_price_cents: bestOutcomePrice,
    has_last_sold_prices: hasLastSoldPrices,
    outcomes,
  };
}

export async function getTradeupLeaderboard({
  minCostCents = 0,
  maxCostCents,
  limit = DEFAULT_LIMIT,
}: TradeupLeaderboardFilters = {}): Promise<TradeupLeaderboardResult> {
  const boundedLimit = Math.max(1, Math.min(limit, MAX_LIMIT));
  const allEntries = await getCachedTradeupContracts();

  const filtered = allEntries.filter((entry) => {
    if (entry.input.is_last_sold_price) return false;
    if (entry.total_cost_cents < minCostCents) return false;
    if (maxCostCents != null && entry.total_cost_cents > maxCostCents) return false;
    return true;
  });

  return {
    entries: filtered.slice(0, boundedLimit),
    total_matches: filtered.length,
  };
}
