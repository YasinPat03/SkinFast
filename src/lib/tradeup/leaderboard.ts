// Every contract made of one listing repeated (10x for a standard contract, 5x
// for a knife/glove one), ranked by expected value.
//
// An input wear covers a range of floats, and an outcome can change wear (and
// price) inside that range. Instead of guessing one float per wear, each input
// wear is cut into pieces within which no outcome changes wear. Every piece is
// an exact statement: "with an average input float between X and Y, these are
// the outcomes and this is the EV". A wear that needs no cutting is reported as
// "any float".

import {
  type Catalog,
  inputVariantsOf,
  outcomesOf,
  poolDisplayName,
  shapesForInputRarity,
} from './catalog';
import { round4, round5 } from './combo';
import { constantWearPieces, outcomeDistribution, priceOutcomes } from './contract';
import { midpoint, outputFloat, wearNormalizedRange, width } from './float';
import type { TradeupLeaderboardEntry, TradeupLeaderboardOutcome, TradeupLeaderboardResult } from './types';

// Pieces narrower than this many float units are not worth listing: nobody can
// reliably buy ten items inside such a sliver.
const MIN_PIECE_FLOAT_WIDTH = 0.005;

export function buildLeaderboard(catalog: Catalog): TradeupLeaderboardEntry[] {
  const entries: TradeupLeaderboardEntry[] = [];

  for (const pool of catalog.pools.values()) {
    if (pool.excluded) continue;

    for (const [inputRarityId, items] of pool.tiers) {
      for (const shape of shapesForInputRarity(inputRarityId, false)) {
        if (outcomesOf(pool, shape).length === 0) continue;
        const chances = outcomeDistribution([[pool, shape.size]], shape);
        if (!chances) continue;

        for (const item of items) {
          const span = item.maxFloat - item.minFloat;

          for (const variant of inputVariantsOf(item, shape)) {
            const wearRange = wearNormalizedRange(variant.wear, item.minFloat, item.maxFloat);
            if (!wearRange || variant.listingCents == null) continue;

            const pieces = constantWearPieces(chances, wearRange);
            pieces.forEach((piece, pieceIndex) => {
              const anyFloat = pieces.length === 1;
              if (!anyFloat && width(piece) * span < MIN_PIECE_FLOAT_WIDTH) return;

              const priced = priceOutcomes(chances, shape, midpoint(piece));
              // Every possible outcome must be actively listed and have a
              // recorded last-5-sold price; anything else is excluded rather
              // than shown with a skewed EV.
              if (priced.hasUnlistedOutcomes || priced.hasUnpricedOutcomes) return;

              const totalCost = variant.listingCents! * shape.size;
              const outcomes: TradeupLeaderboardOutcome[] = priced.outcomes
                .map((outcome) => ({
                  skin_id: outcome.item.primarySkinId,
                  skin_name: outcome.item.name,
                  weapon_name: outcome.item.weaponName,
                  image_url: outcome.item.imageUrl,
                  probability: round4(outcome.probability),
                  float_range: (outcome.item.vanilla
                    ? [0, 0]
                    : [
                        round5(outputFloat(piece.lo, outcome.item.minFloat, outcome.item.maxFloat)),
                        round5(outputFloat(piece.hi, outcome.item.minFloat, outcome.item.maxFloat)),
                      ]) as [number, number],
                  expected_wear: outcome.wear,
                  price_cents: outcome.saleCents!,
                }))
                .sort((a, b) => b.price_cents - a.price_cents);

              const ev = Math.round(priced.expectedReturnCents - totalCost);
              entries.push({
                id: `${shape.kind}:${pool.id}:${variant.marketHashName}:${pieceIndex}`,
                contract_type: shape.kind,
                collection_id: pool.id,
                collection_name: poolDisplayName(pool, shape),
                num_inputs: shape.size,
                input: {
                  skin_id: item.primarySkinId,
                  skin_name: item.name,
                  weapon_name: item.weaponName,
                  image_url: item.imageUrl,
                  wear_name: variant.wear,
                  market_hash_name: variant.marketHashName,
                  price_cents: variant.listingCents!,
                  is_souvenir: variant.isSouvenir,
                  wear_float_range: [
                    round5(item.minFloat + wearRange.lo * span),
                    round5(item.minFloat + wearRange.hi * span),
                  ],
                  required_float_range: [
                    round5(item.minFloat + piece.lo * span),
                    round5(item.minFloat + piece.hi * span),
                  ],
                  any_float: anyFloat,
                },
                total_cost_cents: totalCost,
                expected_return_cents: Math.round(priced.expectedReturnCents),
                ev_cents: ev,
                roi_percent: totalCost > 0 ? Math.round((ev / totalCost) * 10000) / 100 : 0,
                outcome_count: outcomes.length,
                best_outcome_price_cents: outcomes[0]?.price_cents ?? 0,
                outcomes,
              });
            });
          }
        }
      }
    }
  }

  return entries.sort((a, b) => b.ev_cents - a.ev_cents || a.total_cost_cents - b.total_cost_cents);
}

export interface TradeupLeaderboardFilters {
  minCostCents?: number;
  maxCostCents?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export function filterLeaderboard(
  entries: TradeupLeaderboardEntry[],
  { minCostCents = 0, maxCostCents, limit = DEFAULT_LIMIT }: TradeupLeaderboardFilters = {},
): TradeupLeaderboardResult {
  const bounded = Math.max(1, Math.min(limit, MAX_LIMIT));
  const filtered = entries.filter(
    (entry) =>
      entry.total_cost_cents >= minCostCents && (maxCostCents == null || entry.total_cost_cents <= maxCostCents),
  );
  return { entries: filtered.slice(0, bounded), total_matches: filtered.length };
}
