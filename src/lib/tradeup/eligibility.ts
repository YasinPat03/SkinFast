// What the skin page shows before any search is run: whether the skin can come
// out of a contract at all, and which inputs and competing outcomes exist.

import {
  type Catalog,
  inputItemsOf,
  inputVariantsOf,
  outcomesOf,
  poolDisplayName,
  shapeForTarget,
} from './catalog';
import { EXCLUDED_COLLECTION_REASON, RARITY_NAMES } from './rules';
import type { TradeupEligibility } from './types';

export function describeEligibility(catalog: Catalog, skinId: string): TradeupEligibility {
  const target = catalog.itemBySkinId.get(skinId);
  if (!target) return { eligible: false, reason: 'Skin not found' };

  const shape = shapeForTarget(target, false);
  if ('error' in shape) return { eligible: false, reason: shape.error };

  const gold = shape.kind === 'gold';
  const homePools = (gold ? catalog.rarePoolsByItem.get(target.key) : catalog.poolsByItem.get(target.key)) ?? [];
  if (homePools.length === 0) {
    return {
      eligible: false,
      reason: gold ? 'This knife/glove is not found in any cases' : 'This skin does not belong to any collection',
    };
  }
  if (!gold && homePools.some((pool) => pool.excluded)) {
    return { eligible: false, reason: EXCLUDED_COLLECTION_REASON };
  }

  const inputRarityName = RARITY_NAMES[shape.inputRarityId] ?? shape.inputRarityId;
  const usable = homePools.filter((pool) => inputItemsOf(pool, shape).length > 0);
  if (usable.length === 0) {
    return {
      eligible: false,
      reason: gold
        ? 'No Covert skins found in the same case(s) for gold tradeup'
        : `No ${inputRarityName} skins found in the same collection(s)`,
    };
  }

  return {
    eligible: true,
    input_rarity_id: shape.inputRarityId,
    input_rarity_name: inputRarityName,
    input_type: shape.kind,
    num_inputs_required: shape.size,
    collections: usable.map((pool) => {
      let unlisted = 0;
      const inputSkins: NonNullable<TradeupEligibility['collections']>[number]['input_skins'] = [];
      for (const item of inputItemsOf(pool, shape)) {
        const cheapest = inputVariantsOf(item, shape).sort(
          (a, b) => (a.listingCents ?? Infinity) - (b.listingCents ?? Infinity),
        )[0];
        if (!cheapest || cheapest.listingCents == null) {
          unlisted++;
          continue;
        }
        inputSkins.push({
          id: item.primarySkinId,
          name: item.name,
          image_url: item.imageUrl,
          cheapest_price_cents: cheapest.listingCents,
          cheapest_is_souvenir: cheapest.isSouvenir,
        });
      }

      const outputSkins = outcomesOf(pool, shape).map((item) => {
        const normal = item.variants.filter((variant) => !variant.isStatTrak && !variant.isSouvenir);
        const sales = normal.map((variant) => variant.saleCents).filter((cents): cents is number => cents != null);
        return {
          id: item.primarySkinId,
          name: item.name,
          image_url: item.imageUrl,
          cheapest_price_cents: sales.length > 0 ? Math.min(...sales) : null,
          has_active_listing: normal.some((variant) => variant.listingCents != null),
          alias_ids: item.skinIds,
        };
      });

      return {
        id: pool.id,
        name: poolDisplayName(pool, shape),
        image_url: gold ? (pool.caseImageUrl ?? pool.imageUrl) : pool.imageUrl,
        input_skins: inputSkins,
        unlisted_input_count: unlisted,
        output_skins: outputSkins,
      };
    }),
  };
}
