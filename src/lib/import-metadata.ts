import sql from './db';
import { saveScrapeState } from './scraper';

/**
 * Imports skin/collection/crate metadata from ByMykel's CSGO-API into Postgres.
 *
 * - Upsert-only: every statement has an ON CONFLICT clause, so this is safe to
 *   re-run at any time. Nothing is deleted, the live site never goes empty, and
 *   tables with foreign keys into skin_variants (last_sold_avg) are untouched.
 * - Batched: rows are sent as multi-row INSERTs, so a full run is a few dozen
 *   round trips instead of ~30,000. Fits comfortably in a Vercel cron function.
 *
 * Shared by scripts/import-metadata.ts (CLI) and /api/cron/import-metadata.
 */

export const BYMYKEL_BASE_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';

// Rows per INSERT statement. Postgres allows 65,535 bind params per statement;
// the widest table here (skins) has 12 columns, so 1,000 rows is well inside that.
const BATCH_SIZE = 1000;

export type ImportLogger = (message: string) => void;

export interface ImportStats {
  fetched: { skins: number; variants: number; collections: number; crates: number };
  upserted: {
    skins: number;
    collections: number;
    collection_skins: number;
    crates: number;
    crate_skins: number;
    skin_variants: number;
  };
  skipped: {
    variants_without_market_hash_name: number;
    variants_with_unknown_skin: number;
    duplicate_market_hash_names: number;
    collection_links_with_unknown_skin: number;
    crate_links_with_unknown_skin: number;
  };
  duration_ms: number;
}

// --- Raw shapes from ByMykel ---

interface RawRarity { id: string; name: string; color?: string }

interface RawSkin {
  id: string;
  name: string;
  weapon?: { id: string; name: string };
  pattern?: { id: string; name: string };
  min_float?: number;
  max_float?: number;
  rarity?: RawRarity;
  stattrak?: boolean;
  souvenir?: boolean;
  paint_index?: string | null;
  image?: string;
  collections?: { id: string; name: string }[];
}

interface RawSkinNotGrouped {
  id: string;
  skin_id: string;
  name: string;
  wear?: { id: string; name: string } | null;
  stattrak?: boolean;
  souvenir?: boolean;
  market_hash_name: string | null;
}

interface RawContains {
  id: string;
  name: string;
  rarity: RawRarity;
}

interface RawCollection {
  id: string;
  name: string;
  image: string;
  contains: RawContains[];
}

interface RawCrate {
  id: string;
  name: string;
  image: string;
  contains?: RawContains[];
  contains_rare?: RawContains[];
}

// --- Row shapes we insert ---

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
  paint_index: number | null;
}

interface CollectionRow { id: string; name: string; image_url: string | null }
interface CollectionSkinRow { collection_id: string; skin_id: string; rarity_id: string }
interface CrateRow { id: string; name: string; image_url: string | null }
interface CrateSkinRow { crate_id: string; skin_id: string; rarity_id: string; is_rare: boolean }
interface VariantRow {
  skin_id: string;
  market_hash_name: string;
  wear_name: string;
  is_stattrak: boolean;
  is_souvenir: boolean;
}

// --- Helpers ---

async function fetchJson<T>(file: string, log: ImportLogger): Promise<T> {
  const url = `${BYMYKEL_BASE_URL}/${file}`;
  log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

// Gloves/knives use "rarity_ancient" instead of "rarity_ancient_weapon"; normalize
// so the tradeup tier logic only has to know one set of IDs.
export function normalizeRarityId(rarityId: string): string {
  const map: Record<string, string> = {
    rarity_common: 'rarity_common_weapon',
    rarity_uncommon: 'rarity_uncommon_weapon',
    rarity_rare: 'rarity_rare_weapon',
    rarity_mythical: 'rarity_mythical_weapon',
    rarity_legendary: 'rarity_legendary_weapon',
    rarity_ancient: 'rarity_ancient_weapon',
    rarity_contraband: 'rarity_contraband',
  };
  return map[rarityId] ?? rarityId;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// Keep the last row for each key. A multi-row INSERT ... ON CONFLICT DO UPDATE
// fails if the same key appears twice in one statement ("cannot affect row a
// second time"), and ByMykel does repeat market_hash_names (e.g. Doppler phases).
// Last-wins matches the behaviour of the old one-row-at-a-time upserts.
function dedupeBy<T>(rows: T[], key: (row: T) => string): { rows: T[]; duplicates: number } {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return { rows: [...map.values()], duplicates: rows.length - map.size };
}

function parsePaintIndex(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? null : n;
}

// --- Main ---

export async function importMetadata(log: ImportLogger = () => {}): Promise<ImportStats> {
  const started = Date.now();

  const [skins, skinsNotGrouped, collections, crates] = await Promise.all([
    fetchJson<RawSkin[]>('skins.json', log),
    fetchJson<RawSkinNotGrouped[]>('skins_not_grouped.json', log),
    fetchJson<RawCollection[]>('collections.json', log),
    fetchJson<RawCrate[]>('crates.json', log),
  ]);

  log(`Fetched: ${skins.length} skins, ${skinsNotGrouped.length} variants, ${collections.length} collections, ${crates.length} crates`);

  // --- Skins ---
  const skinRows = dedupeBy<SkinRow>(
    skins.map((s) => ({
      id: s.id,
      name: s.name,
      weapon_name: s.weapon?.name ?? '',
      pattern_name: s.pattern?.name ?? '',
      rarity_id: normalizeRarityId(s.rarity?.id ?? ''),
      rarity_name: s.rarity?.name ?? '',
      min_float: s.min_float ?? 0,
      max_float: s.max_float ?? 1,
      has_stattrak: s.stattrak ?? false,
      has_souvenir: s.souvenir ?? false,
      image_url: s.image ?? null,
      paint_index: parsePaintIndex(s.paint_index),
    })),
    (r) => r.id,
  ).rows;

  for (const batch of chunk(skinRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO skins ${sql(batch, 'id', 'name', 'weapon_name', 'pattern_name', 'rarity_id', 'rarity_name', 'min_float', 'max_float', 'has_stattrak', 'has_souvenir', 'image_url', 'paint_index')}
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        weapon_name = EXCLUDED.weapon_name,
        pattern_name = EXCLUDED.pattern_name,
        rarity_id = EXCLUDED.rarity_id,
        rarity_name = EXCLUDED.rarity_name,
        min_float = EXCLUDED.min_float,
        max_float = EXCLUDED.max_float,
        has_stattrak = EXCLUDED.has_stattrak,
        has_souvenir = EXCLUDED.has_souvenir,
        image_url = EXCLUDED.image_url,
        paint_index = EXCLUDED.paint_index
    `;
  }
  log(`Upserted ${skinRows.length} skins`);

  // Every junction row below must point at a skin that exists (FK), so validate
  // against the DB rather than skins.json in case older rows are still around.
  const validSkinRows = await sql<{ id: string }[]>`SELECT id FROM skins`;
  const validSkinIds = new Set(validSkinRows.map((r) => r.id));

  // --- Collections ---
  const collectionRows = dedupeBy<CollectionRow>(
    collections.map((c) => ({ id: c.id, name: c.name, image_url: c.image ?? null })),
    (r) => r.id,
  ).rows;

  for (const batch of chunk(collectionRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO collections ${sql(batch, 'id', 'name', 'image_url')}
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
    `;
  }

  let collectionLinksUnknownSkin = 0;
  const collectionSkinRows = dedupeBy<CollectionSkinRow>(
    collections.flatMap((c) =>
      c.contains.flatMap((item) => {
        if (!validSkinIds.has(item.id)) {
          collectionLinksUnknownSkin++;
          return [];
        }
        return [{ collection_id: c.id, skin_id: item.id, rarity_id: normalizeRarityId(item.rarity.id) }];
      }),
    ),
    (r) => `${r.collection_id} ${r.skin_id}`,
  ).rows;

  for (const batch of chunk(collectionSkinRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO collection_skins ${sql(batch, 'collection_id', 'skin_id', 'rarity_id')}
      ON CONFLICT (collection_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id
    `;
  }
  log(`Upserted ${collectionRows.length} collections with ${collectionSkinRows.length} collection-skin links`);

  // --- Crates ---
  const crateRows = dedupeBy<CrateRow>(
    crates.map((c) => ({ id: c.id, name: c.name, image_url: c.image ?? null })),
    (r) => r.id,
  ).rows;

  for (const batch of chunk(crateRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO crates ${sql(batch, 'id', 'name', 'image_url')}
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
    `;
  }

  // contains_rare comes after contains so that, if a skin appears in both, the
  // rare flag wins (same as the previous sequential upsert order).
  let crateLinksUnknownSkin = 0;
  const crateSkinRows = dedupeBy<CrateSkinRow>(
    crates.flatMap((c) => {
      const toRows = (items: RawContains[] | undefined, isRare: boolean): CrateSkinRow[] =>
        (items ?? []).flatMap((item) => {
          if (!validSkinIds.has(item.id)) {
            crateLinksUnknownSkin++;
            return [];
          }
          return [{ crate_id: c.id, skin_id: item.id, rarity_id: normalizeRarityId(item.rarity.id), is_rare: isRare }];
        });
      return [...toRows(c.contains, false), ...toRows(c.contains_rare, true)];
    }),
    (r) => `${r.crate_id} ${r.skin_id}`,
  ).rows;

  for (const batch of chunk(crateSkinRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO crate_skins ${sql(batch, 'crate_id', 'skin_id', 'rarity_id', 'is_rare')}
      ON CONFLICT (crate_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id, is_rare = EXCLUDED.is_rare
    `;
  }
  log(`Upserted ${crateRows.length} crates with ${crateSkinRows.length} crate-skin links`);

  // --- Skin variants ---
  let variantsNoHashName = 0;
  let variantsUnknownSkin = 0;
  const variantCandidates: VariantRow[] = [];
  for (const v of skinsNotGrouped) {
    if (!v.market_hash_name) {
      variantsNoHashName++;
      continue;
    }
    if (!validSkinIds.has(v.skin_id)) {
      variantsUnknownSkin++;
      continue;
    }
    variantCandidates.push({
      skin_id: v.skin_id,
      market_hash_name: v.market_hash_name,
      // Vanilla knives/gloves have wear: null — treat as a single "Vanilla" variant
      wear_name: v.wear?.name ?? 'Vanilla',
      is_stattrak: v.stattrak ?? false,
      is_souvenir: v.souvenir ?? false,
    });
  }
  const { rows: variantRows, duplicates: duplicateHashNames } = dedupeBy(variantCandidates, (r) => r.market_hash_name);

  for (const batch of chunk(variantRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO skin_variants ${sql(batch, 'skin_id', 'market_hash_name', 'wear_name', 'is_stattrak', 'is_souvenir')}
      ON CONFLICT (market_hash_name) DO UPDATE SET
        skin_id = EXCLUDED.skin_id,
        wear_name = EXCLUDED.wear_name,
        is_stattrak = EXCLUDED.is_stattrak,
        is_souvenir = EXCLUDED.is_souvenir
    `;
  }
  log(`Upserted ${variantRows.length} variants (skipped ${variantsNoHashName} without market_hash_name, ${variantsUnknownSkin} with unknown skin, ${duplicateHashNames} duplicate names)`);

  await saveScrapeState('last_metadata_import', new Date().toISOString());

  const duration_ms = Date.now() - started;
  log(`Done in ${(duration_ms / 1000).toFixed(1)}s`);

  return {
    fetched: {
      skins: skins.length,
      variants: skinsNotGrouped.length,
      collections: collections.length,
      crates: crates.length,
    },
    upserted: {
      skins: skinRows.length,
      collections: collectionRows.length,
      collection_skins: collectionSkinRows.length,
      crates: crateRows.length,
      crate_skins: crateSkinRows.length,
      skin_variants: variantRows.length,
    },
    skipped: {
      variants_without_market_hash_name: variantsNoHashName,
      variants_with_unknown_skin: variantsUnknownSkin,
      duplicate_market_hash_names: duplicateHashNames,
      collection_links_with_unknown_skin: collectionLinksUnknownSkin,
      crate_links_with_unknown_skin: crateLinksUnknownSkin,
    },
    duration_ms,
  };
}
