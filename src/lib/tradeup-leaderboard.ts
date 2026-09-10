import { unstable_cache } from 'next/cache';
import sql from './db';
import { TRADEUP_INPUT_RARITY } from './types';
import { TRADEUP_EXCLUDED_COLLECTION_IDS, goldOutcomeKey, groupRows } from './tradeup-rules';
import {
  calculateOutputFloat,
  calculateTFloat,
  estimateFloat,
  floatToWear,
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
  is_souvenir: boolean;
  lowest_price_cents: number | null;
  last_sold_avg_cents: number | null;
}

interface PriceOption {
  wear_name: string;
  market_hash_name: string;
  price_cents: number;
  is_souvenir: boolean;
  assumed_float: number;
  t_float: number;
}

// Output pricing for one exact variant (skin + wear). Outcomes are valued strictly at the
// last-5-sold avg (last_sold_avg.avg_last5_cents) and only shown when actively listed.
interface OutputVariantPricing {
  last_sold_cents: number | null;
  has_active_listing: boolean;
}

interface PriceLookup {
  by_wear: Record<string, OutputVariantPricing>;
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
  // Avg of the last 5 recorded sales for expected_wear; every listed outcome has one.
  price_cents: number;
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
    is_souvenir: boolean;
    expected_float: number;
  };
  total_cost_cents: number;
  expected_return_cents: number;
  ev_cents: number;
  roi_percent: number;
  outcome_count: number;
  best_outcome_price_cents: number;
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
      // Souvenir rows are loaded too: they are legal (non-StatTrak) inputs since May 2026.
      // They are never used for output pricing — see buildPriceMaps.
      sql<VariantPriceRow[]>`
        SELECT
          sv.skin_id,
          sv.wear_name,
          sv.market_hash_name,
          sv.is_souvenir,
          p.lowest_price_cents,
          l.avg_last5_cents AS last_sold_avg_cents
        FROM skin_variants sv
        LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
        LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
        WHERE sv.is_stattrak = FALSE
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
  ['tradeup-leaderboard-contracts-v6'],
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
        is_souvenir: row.is_souvenir,
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

    // Outputs are valued at the last-5 sold avg of the exact wear the contract produces (what
    // the user would realistically realize selling) and must be actively listed to be shown.
    // A contract never produces a souvenir, so only normal variants price outputs.
    if (!row.is_souvenir) {
      let lookup = priceLookupBySkinId.get(row.skin_id);
      if (!lookup) {
        lookup = { by_wear: {} };
        priceLookupBySkinId.set(row.skin_id, lookup);
      }

      lookup.by_wear[row.wear_name] = {
        last_sold_cents: lastSoldAvg,
        has_active_listing: hasListing,
      };
    }
  }

  for (const wearOptions of wearOptionsBySkinId.values()) {
    wearOptions.sort((a, b) => a.price_cents - b.price_cents || a.t_float - b.t_float);
  }

  return { wearOptionsBySkinId, priceLookupBySkinId };
}

function resolveOutputPrice(lookup: PriceLookup | undefined, wearName: string): OutputVariantPricing {
  // Strictly the exact wear: no fallback to a listing price and no fallback to another wear.
  return lookup?.by_wear[wearName] ?? { last_sold_cents: null, has_active_listing: false };
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
    // Doppler-style phases are one loot entry; keep the phase row that carries market data.
    const outputs = groupRows(
      crateRows.filter((row) => row.is_rare),
      (row) => goldOutcomeKey(crateId, row.skin_name)
    ).map((group) => group.find((row) => priceLookupBySkinId.has(row.skin_id)) ?? group[0]);

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
  let expectedReturn = 0;
  let bestOutcomePrice = 0;
  const outcomes: TradeupLeaderboardOutcome[] = [];

  for (const output of outputs) {
    // Output float follows the normalized formula directly. Since the Oct 2025 change an
    // input with a high min_float normalizes low and can legitimately yield a better wear
    // than the input itself, so the output wear is not clamped to the input wear.
    const expectedFloat = calculateOutputFloat(wearOption.t_float, output.min_float, output.max_float);
    const expectedWear = floatToWear(expectedFloat);

    const pricing = resolveOutputPrice(priceLookupBySkinId.get(output.skin_id), expectedWear);

    // Every possible outcome must be actively listed and have a recorded last-5-sold price.
    // Otherwise the contract is dropped from the leaderboard instead of shown with a skewed EV.
    if (!pricing.has_active_listing || pricing.last_sold_cents == null) {
      return null;
    }

    expectedReturn += pricing.last_sold_cents * probability;
    bestOutcomePrice = Math.max(bestOutcomePrice, pricing.last_sold_cents);

    outcomes.push({
      skin_id: output.skin_id,
      skin_name: output.skin_name,
      weapon_name: output.weapon_name,
      image_url: output.image_url,
      probability: Math.round(probability * 10000) / 10000,
      expected_float: Math.round(expectedFloat * 100000) / 100000,
      expected_wear: expectedWear,
      price_cents: pricing.last_sold_cents,
    });
  }

  outcomes.sort((a, b) => b.price_cents - a.price_cents);

  const ev = Math.round(expectedReturn - totalCost);
  const roiPercent = totalCost > 0 ? Math.round((ev / totalCost) * 10000) / 100 : 0;

  return {
    id: `${contractType}:${collectionId}:${inputRow.skin_id}:${wearOption.wear_name}${wearOption.is_souvenir ? ':souvenir' : ''}`,
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
      is_souvenir: wearOption.is_souvenir,
      expected_float: Math.round(wearOption.assumed_float * 100000) / 100000,
    },
    total_cost_cents: totalCost,
    expected_return_cents: Math.round(expectedReturn),
    ev_cents: ev,
    roi_percent: roiPercent,
    outcome_count: outputs.length,
    best_outcome_price_cents: bestOutcomePrice,
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
    if (entry.total_cost_cents < minCostCents) return false;
    if (maxCostCents != null && entry.total_cost_cents > maxCostCents) return false;
    return true;
  });

  return {
    entries: filtered.slice(0, boundedLimit),
    total_matches: filtered.length,
  };
}
