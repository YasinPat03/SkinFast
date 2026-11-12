// In-memory model of everything a trade-up calculation needs: items, the pools
// they roll from, and the market quote for every variant. Built from plain rows
// (see catalog-db.ts for the queries) so the whole engine can be exercised in
// tests without a database.

import { VANILLA_WEAR } from './float';
import {
  CONTRACT_SIZE,
  COVERT_RARITY_ID,
  type ContractKind,
  type ItemKind,
  goldOutcomeAllowed,
  isExcludedCollection,
  itemKindOf,
  rarityAbove,
  rarityBelow,
  souvenirInputsAllowed,
} from './rules';

// ── Rows in ─────────────────────────────────────────────────────────

export interface SkinRow {
  id: string;
  name: string;
  weapon_name: string;
  rarity_id: string;
  rarity_name: string;
  min_float: number;
  max_float: number;
  image_url: string | null;
}

export interface CollectionRow {
  id: string;
  name: string;
  image_url: string | null;
}

export interface CollectionSkinRow {
  collection_id: string;
  skin_id: string;
  rarity_id: string;
}

export interface CrateRow {
  id: string;
  name: string;
  image_url: string | null;
}

export interface CrateSkinRow {
  crate_id: string;
  skin_id: string;
  is_rare: boolean;
}

export interface VariantRow {
  skin_id: string;
  market_hash_name: string;
  wear_name: string;
  is_stattrak: boolean;
  is_souvenir: boolean;
  lowest_price_cents: number | null;
  sell_listings: number | null;
  avg_last5_cents: number | null;
  sample_count: number | null;
  last_sale_at: string | null;
}

export interface CatalogRows {
  skins: SkinRow[];
  collections: CollectionRow[];
  collectionSkins: CollectionSkinRow[];
  crates: CrateRow[];
  crateSkins: CrateSkinRow[];
  variants: VariantRow[];
}

// ── Model ───────────────────────────────────────────────────────────

export interface Variant {
  marketHashName: string;
  wear: string;
  isStatTrak: boolean;
  isSouvenir: boolean;
  // Lowest active Steam listing in USD cents; null when nothing is listed.
  listingCents: number | null;
  listingCount: number | null;
  // Average of the last 5 recorded Steam sales in USD cents; null when unknown.
  saleCents: number | null;
  saleSampleCount: number | null;
  lastSaleAt: string | null;
}

// One thing you can own and sell. Finish phases (Doppler, Gamma Doppler) are
// separate skins in the metadata but a single market listing and a single entry
// in a loot pool, so every skin sharing a name is folded into one item.
export interface Item {
  key: string;
  name: string;
  weaponName: string;
  kind: ItemKind;
  rarityId: string;
  rarityName: string;
  minFloat: number;
  maxFloat: number;
  // True for unpainted knives: no exterior, a single "Vanilla" variant per quality.
  vanilla: boolean;
  imageUrl: string | null;
  // The skin id that owns the variants (and therefore the one to link to).
  primarySkinId: string;
  skinIds: string[];
  variants: Variant[];
}

// A collection, plus the knives/gloves of the case that drops it (if any).
export interface Pool {
  id: string;
  name: string;
  imageUrl: string | null;
  excluded: boolean;
  tiers: Map<string, Item[]>;
  rare: Item[];
  caseId: string | null;
  caseName: string | null;
  caseImageUrl: string | null;
}

export interface Catalog {
  items: Map<string, Item>;
  itemBySkinId: Map<string, Item>;
  pools: Map<string, Pool>;
  // Pools an item can roll from as a regular (non knife/glove) outcome.
  poolsByItem: Map<string, Pool[]>;
  // Pools whose case can produce the item as a knife/glove.
  rarePoolsByItem: Map<string, Pool[]>;
}

// ── Build ───────────────────────────────────────────────────────────

function positive(value: number | null | undefined): number | null {
  return value != null && value > 0 ? value : null;
}

export function buildCatalog(rows: CatalogRows): Catalog {
  const variantsBySkin = new Map<string, Variant[]>();
  for (const row of rows.variants) {
    const variant: Variant = {
      marketHashName: row.market_hash_name,
      wear: row.wear_name,
      isStatTrak: row.is_stattrak,
      isSouvenir: row.is_souvenir,
      listingCents: positive(row.lowest_price_cents),
      listingCount: row.sell_listings,
      saleCents: positive(row.avg_last5_cents),
      saleSampleCount: row.sample_count,
      lastSaleAt: row.last_sale_at,
    };
    const list = variantsBySkin.get(row.skin_id);
    if (list) list.push(variant);
    else variantsBySkin.set(row.skin_id, [variant]);
  }

  const items = new Map<string, Item>();
  const itemBySkinId = new Map<string, Item>();
  for (const skin of rows.skins) {
    let item = items.get(skin.name);
    if (!item) {
      item = {
        key: skin.name,
        name: skin.name,
        weaponName: skin.weapon_name,
        kind: itemKindOf(skin.name, skin.weapon_name),
        rarityId: skin.rarity_id,
        rarityName: skin.rarity_name,
        minFloat: Number(skin.min_float),
        maxFloat: Number(skin.max_float),
        vanilla: false,
        imageUrl: skin.image_url,
        primarySkinId: skin.id,
        skinIds: [],
        variants: [],
      };
      items.set(skin.name, item);
    }
    item.skinIds.push(skin.id);
    itemBySkinId.set(skin.id, item);

    const variants = variantsBySkin.get(skin.id);
    if (variants && variants.length > 0) {
      // Phases share one set of market names, stored under a single skin id.
      if (item.variants.length === 0) {
        item.primarySkinId = skin.id;
        item.imageUrl = skin.image_url ?? item.imageUrl;
      }
      item.variants.push(...variants);
    }
  }
  for (const item of items.values()) {
    item.vanilla = item.variants.length > 0 && item.variants.every((variant) => variant.wear === VANILLA_WEAR);
  }

  const pools = new Map<string, Pool>();
  for (const collection of rows.collections) {
    pools.set(collection.id, {
      id: collection.id,
      name: collection.name,
      imageUrl: collection.image_url,
      excluded: isExcludedCollection(collection.id),
      tiers: new Map(),
      rare: [],
      caseId: null,
      caseName: null,
      caseImageUrl: null,
    });
  }

  const poolsByItem = new Map<string, Pool[]>();
  const poolBySkinId = new Map<string, Pool[]>();
  for (const link of rows.collectionSkins) {
    const pool = pools.get(link.collection_id);
    const item = itemBySkinId.get(link.skin_id);
    if (!pool || !item) continue;

    const skinPools = poolBySkinId.get(link.skin_id);
    if (skinPools) skinPools.push(pool);
    else poolBySkinId.set(link.skin_id, [pool]);

    // Knives and gloves never sit in a collection tier; they come from `rare`.
    if (item.kind !== 'weapon') continue;

    const tier = pool.tiers.get(link.rarity_id);
    if (!tier) pool.tiers.set(link.rarity_id, [item]);
    else if (!tier.includes(item)) tier.push(item);
    else continue;

    const itemPools = poolsByItem.get(item.key);
    if (!itemPools) poolsByItem.set(item.key, [pool]);
    else if (!itemPools.includes(pool)) itemPools.push(pool);
  }

  // A case's knives/gloves belong to the collection(s) its regular skins come from.
  const crateById = new Map(rows.crates.map((crate) => [crate.id, crate]));
  const rareByCrate = new Map<string, Item[]>();
  const poolsByCrate = new Map<string, Set<Pool>>();
  for (const link of rows.crateSkins) {
    const item = itemBySkinId.get(link.skin_id);
    if (!item) continue;
    if (link.is_rare) {
      const rare = rareByCrate.get(link.crate_id);
      if (!rare) rareByCrate.set(link.crate_id, [item]);
      else if (!rare.includes(item)) rare.push(item);
    } else {
      for (const pool of poolBySkinId.get(link.skin_id) ?? []) {
        const set = poolsByCrate.get(link.crate_id);
        if (set) set.add(pool);
        else poolsByCrate.set(link.crate_id, new Set([pool]));
      }
    }
  }

  const rarePoolsByItem = new Map<string, Pool[]>();
  for (const [crateId, rareItems] of rareByCrate) {
    const crate = crateById.get(crateId);
    for (const pool of poolsByCrate.get(crateId) ?? []) {
      if (pool.caseId == null) {
        pool.caseId = crateId;
        pool.caseName = crate?.name ?? null;
        pool.caseImageUrl = crate?.image_url ?? null;
      }
      for (const item of rareItems) {
        if (item.kind === 'weapon' || pool.rare.includes(item)) continue;
        pool.rare.push(item);
        const itemPools = rarePoolsByItem.get(item.key);
        if (!itemPools) rarePoolsByItem.set(item.key, [pool]);
        else if (!itemPools.includes(pool)) itemPools.push(pool);
      }
    }
  }

  return { items, itemBySkinId, pools, poolsByItem, rarePoolsByItem };
}

// ── Contract shape ──────────────────────────────────────────────────

export interface ContractShape {
  kind: ContractKind;
  statTrak: boolean;
  size: number;
  inputRarityId: string;
  // Null for gold contracts, whose outcomes are a pool's knives/gloves.
  outputRarityId: string | null;
}

// The contract that produces a given item, or null with the reason it cannot
// come out of any contract.
export function shapeForTarget(item: Item, statTrak: boolean): ContractShape | { error: string } {
  if (item.kind !== 'weapon') {
    if (!goldOutcomeAllowed(item.kind, statTrak)) {
      return { error: 'StatTrak Covert tradeups can only produce knives' };
    }
    return {
      kind: 'gold',
      statTrak,
      size: CONTRACT_SIZE.gold,
      inputRarityId: COVERT_RARITY_ID,
      outputRarityId: null,
    };
  }

  const inputRarityId = rarityBelow(item.rarityId);
  if (!inputRarityId) {
    return {
      error:
        item.rarityId === 'rarity_common_weapon'
          ? 'Consumer Grade skins cannot be obtained via tradeup'
          : `${item.rarityName} skins cannot be obtained via tradeup`,
    };
  }
  return {
    kind: 'standard',
    statTrak,
    size: CONTRACT_SIZE.standard,
    inputRarityId,
    outputRarityId: item.rarityId,
  };
}

// The contract a given input rarity feeds, for enumerating every contract.
export function shapesForInputRarity(inputRarityId: string, statTrak: boolean): ContractShape[] {
  const shapes: ContractShape[] = [];
  const outputRarityId = rarityAbove(inputRarityId);
  if (outputRarityId) {
    shapes.push({ kind: 'standard', statTrak, size: CONTRACT_SIZE.standard, inputRarityId, outputRarityId });
  }
  if (inputRarityId === COVERT_RARITY_ID) {
    shapes.push({ kind: 'gold', statTrak, size: CONTRACT_SIZE.gold, inputRarityId, outputRarityId: null });
  }
  return shapes;
}

// Everything one input from this pool can turn into under the given contract.
export function outcomesOf(pool: Pool, shape: ContractShape): Item[] {
  if (pool.excluded) return [];
  if (shape.kind === 'gold') {
    return pool.rare.filter((item) => goldOutcomeAllowed(item.kind, shape.statTrak));
  }
  return shape.outputRarityId ? (pool.tiers.get(shape.outputRarityId) ?? []) : [];
}

// The items of this pool the game accepts as inputs: the right rarity, in a
// pool that has at least one possible outcome.
export function inputItemsOf(pool: Pool, shape: ContractShape): Item[] {
  if (outcomesOf(pool, shape).length === 0) return [];
  return pool.tiers.get(shape.inputRarityId) ?? [];
}

// Variants of an item that may be put into the contract and can be bought now.
export function inputVariantsOf(item: Item, shape: ContractShape): Variant[] {
  return item.variants.filter(
    (variant) =>
      variant.isStatTrak === shape.statTrak &&
      (!variant.isSouvenir || souvenirInputsAllowed(shape.statTrak)) &&
      variant.wear !== VANILLA_WEAR &&
      variant.listingCents != null,
  );
}

// The variant a contract hands back for an outcome at a given wear: never a
// souvenir, StatTrak exactly when the contract is.
export function outcomeVariantOf(item: Item, shape: ContractShape, wear: string): Variant | null {
  return (
    item.variants.find(
      (variant) => variant.wear === wear && variant.isStatTrak === shape.statTrak && !variant.isSouvenir,
    ) ?? null
  );
}

export function poolDisplayName(pool: Pool, shape: ContractShape): string {
  return shape.kind === 'gold' ? (pool.caseName ?? pool.name) : pool.name;
}
