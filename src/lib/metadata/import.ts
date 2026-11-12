// Imports skin / collection / case metadata from ByMykel's CSGO-API.
//
// - Everything is upserted in batches, so a run is a few dozen round trips,
//   safe to repeat, and never leaves the site empty.
// - Rows the source no longer has are pruned afterwards. Trade-up odds are
//   "1 / number of skins at that rarity in the collection", so a stale link
//   left behind by a rename or a moved skin silently skews every probability
//   for that collection.
// - A download that looks truncated aborts before anything is written, and a
//   prune that would remove an implausible share of a table is skipped.

import sql from '../db';
import { setState } from '../market/state';

export const BYMYKEL_BASE_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';

// Postgres allows 65,535 bind parameters per statement; the widest table here
// has 12 columns, so 1,000 rows per statement is well inside that.
const BATCH_SIZE = 1000;

// Fewer rows than this in a download means it is not the real dataset.
const MIN_EXPECTED = { skins: 1500, variants: 15000, collections: 40, crates: 100 };

// A prune removing more than this share of a table's rows is not believed.
const MAX_PRUNE_SHARE = 0.05;

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
  pruned: { collection_skins: number; crate_skins: number; skin_variants: number; skins: number };
  skipped: {
    variants_without_market_hash_name: number;
    variants_with_unknown_skin: number;
    duplicate_market_hash_names: number;
    collection_links_with_unknown_skin: number;
    crate_links_with_unknown_skin: number;
  };
  warnings: string[];
  duration_ms: number;
}

// ── Source shapes ───────────────────────────────────────────────────

interface RawRarity {
  id: string;
  name: string;
}

interface RawSkin {
  id: string;
  name: string;
  weapon?: { name: string } | null;
  pattern?: { name: string } | null;
  min_float?: number | null;
  max_float?: number | null;
  rarity?: RawRarity | null;
  stattrak?: boolean;
  souvenir?: boolean;
  paint_index?: string | null;
  image?: string | null;
}

interface RawVariant {
  skin_id: string;
  wear?: { name: string } | null;
  stattrak?: boolean;
  souvenir?: boolean;
  market_hash_name: string | null;
}

interface RawContains {
  id: string;
  rarity?: RawRarity | null;
}

interface RawCollection {
  id: string;
  name: string;
  image?: string | null;
  contains?: RawContains[];
}

interface RawCrate {
  id: string;
  name: string;
  image?: string | null;
  contains?: RawContains[];
  contains_rare?: RawContains[];
}

// ── Helpers ─────────────────────────────────────────────────────────

async function fetchJson<T>(file: string, log: ImportLogger): Promise<T> {
  const url = `${BYMYKEL_BASE_URL}/${file}`;
  log(`Fetching ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Failed to fetch ${file}: HTTP ${response.status}`);
  const data = (await response.json()) as T;
  if (!Array.isArray(data)) throw new Error(`${file} is not a JSON array`);
  return data;
}

// Knives and gloves use "rarity_ancient" where weapons use
// "rarity_ancient_weapon"; store one spelling so tier logic has one set of ids.
export function normalizeRarityId(rarityId: string): string {
  const map: Record<string, string> = {
    rarity_common: 'rarity_common_weapon',
    rarity_uncommon: 'rarity_uncommon_weapon',
    rarity_rare: 'rarity_rare_weapon',
    rarity_mythical: 'rarity_mythical_weapon',
    rarity_legendary: 'rarity_legendary_weapon',
    rarity_ancient: 'rarity_ancient_weapon',
  };
  return map[rarityId] ?? rarityId;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// Keep the last row per key: a multi-row upsert cannot touch one key twice,
// and the source repeats market names (finish phases share them).
function dedupeBy<T>(rows: T[], key: (row: T) => string): { rows: T[]; duplicates: number } {
  const map = new Map<string, T>();
  for (const row of rows) map.set(key(row), row);
  return { rows: [...map.values()], duplicates: rows.length - map.size };
}

function parsePaintIndex(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// Decide whether a prune is believable. Returns the reason it is not, if any.
function pruneProblem(table: string, stale: number, existing: number): string | null {
  if (stale === 0) return null;
  if (stale > Math.max(10, existing * MAX_PRUNE_SHARE)) {
    return `Not pruning ${table}: ${stale} of ${existing} rows are missing from the import, which is too many to be real`;
  }
  return null;
}

// ── Import ──────────────────────────────────────────────────────────

export async function importMetadata(log: ImportLogger = () => {}): Promise<ImportStats> {
  const started = Date.now();
  const warnings: string[] = [];

  const [skins, variants, collections, crates] = await Promise.all([
    fetchJson<RawSkin[]>('skins.json', log),
    fetchJson<RawVariant[]>('skins_not_grouped.json', log),
    fetchJson<RawCollection[]>('collections.json', log),
    fetchJson<RawCrate[]>('crates.json', log),
  ]);
  log(`Fetched ${skins.length} skins, ${variants.length} variants, ${collections.length} collections, ${crates.length} crates`);

  const fetched = { skins: skins.length, variants: variants.length, collections: collections.length, crates: crates.length };
  for (const [name, minimum] of Object.entries(MIN_EXPECTED) as [keyof typeof MIN_EXPECTED, number][]) {
    if (fetched[name] < minimum) {
      throw new Error(`Import aborted: only ${fetched[name]} ${name} downloaded (expected at least ${minimum})`);
    }
  }

  // ── Skins ──
  const skinRows = dedupeBy(
    skins.map((skin) => ({
      id: skin.id,
      name: skin.name,
      weapon_name: skin.weapon?.name ?? '',
      pattern_name: skin.pattern?.name ?? '',
      rarity_id: normalizeRarityId(skin.rarity?.id ?? ''),
      rarity_name: skin.rarity?.name ?? '',
      // Unpainted knives have no float range in the source.
      min_float: skin.min_float ?? 0,
      max_float: skin.max_float ?? 1,
      has_stattrak: skin.stattrak ?? false,
      has_souvenir: skin.souvenir ?? false,
      image_url: skin.image ?? null,
      paint_index: parsePaintIndex(skin.paint_index),
    })),
    (row) => row.id,
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
  const importedSkinIds = new Set(skinRows.map((row) => row.id));

  // ── Collections ──
  const collectionRows = dedupeBy(
    collections.map((collection) => ({ id: collection.id, name: collection.name, image_url: collection.image ?? null })),
    (row) => row.id,
  ).rows;
  for (const batch of chunk(collectionRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO collections ${sql(batch, 'id', 'name', 'image_url')}
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
    `;
  }

  let collectionLinksUnknownSkin = 0;
  const collectionSkinRows = dedupeBy(
    collections.flatMap((collection) =>
      (collection.contains ?? []).flatMap((entry) => {
        if (!importedSkinIds.has(entry.id)) {
          collectionLinksUnknownSkin++;
          return [];
        }
        return [{ collection_id: collection.id, skin_id: entry.id, rarity_id: normalizeRarityId(entry.rarity?.id ?? '') }];
      }),
    ),
    (row) => `${row.collection_id} ${row.skin_id}`,
  ).rows;
  for (const batch of chunk(collectionSkinRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO collection_skins ${sql(batch, 'collection_id', 'skin_id', 'rarity_id')}
      ON CONFLICT (collection_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id
    `;
  }
  log(`Upserted ${collectionRows.length} collections with ${collectionSkinRows.length} links`);

  // ── Crates ──
  const crateRows = dedupeBy(
    crates.map((crate) => ({ id: crate.id, name: crate.name, image_url: crate.image ?? null })),
    (row) => row.id,
  ).rows;
  for (const batch of chunk(crateRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO crates ${sql(batch, 'id', 'name', 'image_url')}
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
    `;
  }

  let crateLinksUnknownSkin = 0;
  const crateSkinRows = dedupeBy(
    crates.flatMap((crate) => {
      const toRows = (entries: RawContains[] | undefined, isRare: boolean) =>
        (entries ?? []).flatMap((entry) => {
          if (!importedSkinIds.has(entry.id)) {
            crateLinksUnknownSkin++;
            return [];
          }
          return [{ crate_id: crate.id, skin_id: entry.id, rarity_id: normalizeRarityId(entry.rarity?.id ?? ''), is_rare: isRare }];
        });
      // Rare entries last, so the rare flag wins if a skin is listed in both.
      return [...toRows(crate.contains, false), ...toRows(crate.contains_rare, true)];
    }),
    (row) => `${row.crate_id} ${row.skin_id}`,
  ).rows;
  for (const batch of chunk(crateSkinRows, BATCH_SIZE)) {
    await sql`
      INSERT INTO crate_skins ${sql(batch, 'crate_id', 'skin_id', 'rarity_id', 'is_rare')}
      ON CONFLICT (crate_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id, is_rare = EXCLUDED.is_rare
    `;
  }
  log(`Upserted ${crateRows.length} crates with ${crateSkinRows.length} links`);

  // ── Variants ──
  let variantsNoHashName = 0;
  let variantsUnknownSkin = 0;
  const variantCandidates = [];
  for (const variant of variants) {
    if (!variant.market_hash_name) {
      variantsNoHashName++;
      continue;
    }
    if (!importedSkinIds.has(variant.skin_id)) {
      variantsUnknownSkin++;
      continue;
    }
    variantCandidates.push({
      skin_id: variant.skin_id,
      market_hash_name: variant.market_hash_name,
      // Unpainted knives have no wear.
      wear_name: variant.wear?.name ?? 'Vanilla',
      is_stattrak: variant.stattrak ?? false,
      is_souvenir: variant.souvenir ?? false,
    });
  }
  const { rows: variantRows, duplicates: duplicateHashNames } = dedupeBy(variantCandidates, (row) => row.market_hash_name);
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
  log(`Upserted ${variantRows.length} variants`);

  // ── Prune what the source no longer has ──
  const pruned = { collection_skins: 0, crate_skins: 0, skin_variants: 0, skins: 0 };

  const importedCollectionLinks = new Set(collectionSkinRows.map((row) => `${row.collection_id} ${row.skin_id}`));
  const existingCollectionLinks = await sql<{ collection_id: string; skin_id: string }[]>`
    SELECT collection_id, skin_id FROM collection_skins
  `;
  const staleCollectionLinks = existingCollectionLinks.filter(
    (row) => !importedCollectionLinks.has(`${row.collection_id} ${row.skin_id}`),
  );
  let problem = pruneProblem('collection_skins', staleCollectionLinks.length, existingCollectionLinks.length);
  if (problem) warnings.push(problem);
  else {
    for (const row of staleCollectionLinks) {
      await sql`DELETE FROM collection_skins WHERE collection_id = ${row.collection_id} AND skin_id = ${row.skin_id}`;
    }
    pruned.collection_skins = staleCollectionLinks.length;
  }

  const importedCrateLinks = new Set(crateSkinRows.map((row) => `${row.crate_id} ${row.skin_id}`));
  const existingCrateLinks = await sql<{ crate_id: string; skin_id: string }[]>`SELECT crate_id, skin_id FROM crate_skins`;
  const staleCrateLinks = existingCrateLinks.filter((row) => !importedCrateLinks.has(`${row.crate_id} ${row.skin_id}`));
  problem = pruneProblem('crate_skins', staleCrateLinks.length, existingCrateLinks.length);
  if (problem) warnings.push(problem);
  else {
    for (const row of staleCrateLinks) {
      await sql`DELETE FROM crate_skins WHERE crate_id = ${row.crate_id} AND skin_id = ${row.skin_id}`;
    }
    pruned.crate_skins = staleCrateLinks.length;
  }

  const importedNames = new Set(variantRows.map((row) => row.market_hash_name));
  const existingNames = await sql<{ market_hash_name: string }[]>`SELECT market_hash_name FROM skin_variants`;
  const staleNames = existingNames.map((row) => row.market_hash_name).filter((name) => !importedNames.has(name));
  problem = pruneProblem('skin_variants', staleNames.length, existingNames.length);
  if (problem) warnings.push(problem);
  else if (staleNames.length > 0) {
    // last_sold_avg references skin_variants; removing both in one statement
    // keeps it atomic, and the foreign key is checked when the statement ends.
    await sql`
      WITH gone AS (DELETE FROM last_sold_avg WHERE market_hash_name = ANY(${staleNames}))
      DELETE FROM skin_variants WHERE market_hash_name = ANY(${staleNames})
    `;
    pruned.skin_variants = staleNames.length;
  }

  // A skin the source dropped is removed once nothing points at it any more.
  const existingSkins = await sql<{ id: string }[]>`SELECT id FROM skins`;
  const staleSkinIds = existingSkins.map((row) => row.id).filter((id) => !importedSkinIds.has(id));
  problem = pruneProblem('skins', staleSkinIds.length, existingSkins.length);
  if (problem) warnings.push(problem);
  else if (staleSkinIds.length > 0) {
    const removed = await sql`
      DELETE FROM skins s
      WHERE s.id = ANY(${staleSkinIds})
        AND NOT EXISTS (SELECT 1 FROM skin_variants sv WHERE sv.skin_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM collection_skins cs WHERE cs.skin_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM crate_skins cs WHERE cs.skin_id = s.id)
      RETURNING s.id
    `;
    pruned.skins = removed.length;
  }

  if (Object.values(pruned).some((count) => count > 0)) {
    log(`Pruned ${pruned.collection_skins} collection links, ${pruned.crate_skins} crate links, ${pruned.skin_variants} variants, ${pruned.skins} skins`);
  }
  for (const warning of warnings) log(`WARNING: ${warning}`);

  await setState('last_metadata_import', new Date().toISOString());

  const duration_ms = Date.now() - started;
  log(`Done in ${(duration_ms / 1000).toFixed(1)}s`);

  return {
    fetched,
    upserted: {
      skins: skinRows.length,
      collections: collectionRows.length,
      collection_skins: collectionSkinRows.length,
      crates: crateRows.length,
      crate_skins: crateSkinRows.length,
      skin_variants: variantRows.length,
    },
    pruned,
    skipped: {
      variants_without_market_hash_name: variantsNoHashName,
      variants_with_unknown_skin: variantsUnknownSkin,
      duplicate_market_hash_names: duplicateHashNames,
      collection_links_with_unknown_skin: collectionLinksUnknownSkin,
      crate_links_with_unknown_skin: crateLinksUnknownSkin,
    },
    warnings,
    duration_ms,
  };
}
