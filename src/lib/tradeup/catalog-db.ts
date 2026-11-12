// Loads the trade-up catalog from Postgres and keeps it in process memory.
//
// The whole catalog is ~2k skins and ~21k variants, so it is loaded in one go
// (six queries) instead of a query per pool per request. One in-flight load is
// shared by concurrent callers, and a stale copy is served while a refresh runs.

import sql from '../db';
import {
  type Catalog,
  type CatalogRows,
  type CollectionRow,
  type CollectionSkinRow,
  type CrateRow,
  type CrateSkinRow,
  type SkinRow,
  type VariantRow,
  buildCatalog,
} from './catalog';

// Prices move on the scale of the scan cycle (hours), and a write made by this
// process invalidates the copy, so a couple of minutes is plenty fresh.
const CATALOG_TTL_MS = 120_000;

let cached: { catalog: Catalog; expiresAt: number } | null = null;
let inflight: Promise<Catalog> | null = null;

export async function loadCatalogRows(): Promise<CatalogRows> {
  const [skins, collections, collectionSkins, crates, crateSkins, variants] = await Promise.all([
    sql<SkinRow[]>`
      SELECT id, name, weapon_name, rarity_id, rarity_name, min_float, max_float, image_url
      FROM skins
      ORDER BY id
    `,
    sql<CollectionRow[]>`SELECT id, name, image_url FROM collections`,
    sql<CollectionSkinRow[]>`SELECT collection_id, skin_id, rarity_id FROM collection_skins ORDER BY collection_id, skin_id`,
    // Only cases with knives/gloves matter here; souvenir packages and capsules do not.
    sql<CrateRow[]>`
      SELECT id, name, image_url FROM crates
      WHERE id IN (SELECT crate_id FROM crate_skins WHERE is_rare)
    `,
    sql<CrateSkinRow[]>`
      SELECT crate_id, skin_id, is_rare FROM crate_skins
      WHERE crate_id IN (SELECT crate_id FROM crate_skins WHERE is_rare)
      ORDER BY crate_id, skin_id
    `,
    sql<VariantRow[]>`
      SELECT sv.skin_id, sv.market_hash_name, sv.wear_name, sv.is_stattrak, sv.is_souvenir,
             p.lowest_price_cents, p.sell_listings,
             l.avg_last5_cents, l.sample_count, l.last_sale_at
      FROM skin_variants sv
      LEFT JOIN prices p ON p.market_hash_name = sv.market_hash_name
      LEFT JOIN last_sold_avg l ON l.market_hash_name = sv.market_hash_name
    `,
  ]);
  return { skins, collections, collectionSkins, crates, crateSkins, variants };
}

export async function getCatalog(): Promise<Catalog> {
  if (cached && cached.expiresAt > Date.now()) return cached.catalog;

  if (!inflight) {
    inflight = loadCatalogRows()
      .then((rows) => {
        const catalog = buildCatalog(rows);
        cached = { catalog, expiresAt: Date.now() + CATALOG_TTL_MS };
        return catalog;
      })
      .finally(() => {
        inflight = null;
      });
  }

  if (cached) {
    // Serve the stale copy; a failed refresh is logged and retried next call.
    inflight.catch((error) => console.error('[tradeup-catalog] refresh failed', error));
    return cached.catalog;
  }
  return inflight;
}

// Called after prices are written in this process so the next read sees them.
export function invalidateCatalog(): void {
  if (cached) cached.expiresAt = 0;
}
