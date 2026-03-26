import './env';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(connectionString);

const BASE_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';

interface RawSkin {
  id: string;
  name: string;
  weapon: { id: string; name: string };
  category?: { id: string; name: string };
  pattern: { id: string; name: string };
  min_float: number;
  max_float: number;
  rarity: { id: string; name: string; color: string };
  stattrak: boolean;
  souvenir: boolean;
  paint_index: string | null;
  image: string;
  collections: { id: string; name: string }[];
}

interface RawSkinNotGrouped {
  id: string;
  skin_id: string;
  name: string;
  weapon: { id: string; name: string };
  wear: { id: string; name: string };
  stattrak: boolean;
  souvenir: boolean;
  market_hash_name: string | null;
  rarity: { id: string; name: string };
  image: string;
}

interface RawCollection {
  id: string;
  name: string;
  image: string;
  contains: {
    id: string;
    name: string;
    rarity: { id: string; name: string; color: string };
    paint_index: string;
    image: string;
  }[];
}

interface RawCrate {
  id: string;
  name: string;
  image: string;
  contains: {
    id: string;
    name: string;
    rarity: { id: string; name: string; color: string };
    paint_index: string;
    image: string;
  }[];
  contains_rare: {
    id: string;
    name: string;
    rarity: { id: string; name: string; color: string };
    paint_index: string;
    image: string;
  }[];
}

async function fetchJson<T>(file: string): Promise<T> {
  const url = `${BASE_URL}/${file}`;
  console.log(`Fetching ${url}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: ${res.status}`);
  return res.json() as Promise<T>;
}

// Normalize rarity IDs: gloves/knives use "rarity_ancient" instead of "rarity_ancient_weapon"
function normalizeRarityId(rarityId: string): string {
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

async function main() {
  console.log('=== CS2 Metadata Import ===\n');

  // Fetch all data in parallel
  const [skins, skinsNotGrouped, collections, crates] = await Promise.all([
    fetchJson<RawSkin[]>('skins.json'),
    fetchJson<RawSkinNotGrouped[]>('skins_not_grouped.json'),
    fetchJson<RawCollection[]>('collections.json'),
    fetchJson<RawCrate[]>('crates.json'),
  ]);

  console.log(`\nFetched: ${skins.length} skins, ${skinsNotGrouped.length} variants, ${collections.length} collections, ${crates.length} crates\n`);

  // Clear existing data for clean import
  await sql`DELETE FROM crate_skins`;
  await sql`DELETE FROM crates`;
  await sql`DELETE FROM collection_skins`;
  await sql`DELETE FROM skin_variants`;
  await sql`DELETE FROM skins`;
  await sql`DELETE FROM collections`;

  // --- Import skins ---
  console.log('Importing skins...');
  for (const skin of skins) {
    await sql`
      INSERT INTO skins (id, name, weapon_name, pattern_name, rarity_id, rarity_name, min_float, max_float, has_stattrak, has_souvenir, image_url, paint_index)
      VALUES (
        ${skin.id},
        ${skin.name},
        ${skin.weapon?.name ?? ''},
        ${skin.pattern?.name ?? ''},
        ${normalizeRarityId(skin.rarity?.id ?? '')},
        ${skin.rarity?.name ?? ''},
        ${skin.min_float ?? 0},
        ${skin.max_float ?? 1},
        ${skin.stattrak ?? false},
        ${skin.souvenir ?? false},
        ${skin.image ?? null},
        ${skin.paint_index ? parseInt(skin.paint_index, 10) : null}
      )
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
  console.log(`  Inserted ${skins.length} skins`);

  // Build a set of valid skin IDs for FK validation
  const validSkinRows = await sql<{ id: string }[]>`SELECT id FROM skins`;
  const validSkinIds = new Set<string>(validSkinRows.map(r => r.id));

  // --- Import collections ---
  console.log('Importing collections...');
  for (const col of collections) {
    await sql`
      INSERT INTO collections (id, name, image_url)
      VALUES (${col.id}, ${col.name}, ${col.image})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
    `;

    for (const skin of col.contains) {
      if (!validSkinIds.has(skin.id)) continue;
      await sql`
        INSERT INTO collection_skins (collection_id, skin_id, rarity_id)
        VALUES (${col.id}, ${skin.id}, ${normalizeRarityId(skin.rarity.id)})
        ON CONFLICT (collection_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id
      `;
    }
  }

  const totalCollectionSkins = collections.reduce((sum, c) => sum + c.contains.length, 0);
  console.log(`  Inserted ${collections.length} collections with ${totalCollectionSkins} collection-skin links`);

  // --- Import crates ---
  console.log('Importing crates...');
  let crateSkinsCount = 0;
  for (const crate of crates) {
    await sql`
      INSERT INTO crates (id, name, image_url)
      VALUES (${crate.id}, ${crate.name}, ${crate.image})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
    `;

    if (crate.contains) {
      for (const skin of crate.contains) {
        if (!validSkinIds.has(skin.id)) continue;
        await sql`
          INSERT INTO crate_skins (crate_id, skin_id, rarity_id, is_rare)
          VALUES (${crate.id}, ${skin.id}, ${normalizeRarityId(skin.rarity.id)}, FALSE)
          ON CONFLICT (crate_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id, is_rare = EXCLUDED.is_rare
        `;
        crateSkinsCount++;
      }
    }

    if (crate.contains_rare) {
      for (const skin of crate.contains_rare) {
        if (!validSkinIds.has(skin.id)) continue;
        await sql`
          INSERT INTO crate_skins (crate_id, skin_id, rarity_id, is_rare)
          VALUES (${crate.id}, ${skin.id}, ${normalizeRarityId(skin.rarity.id)}, TRUE)
          ON CONFLICT (crate_id, skin_id) DO UPDATE SET rarity_id = EXCLUDED.rarity_id, is_rare = EXCLUDED.is_rare
        `;
        crateSkinsCount++;
      }
    }
  }
  console.log(`  Inserted ${crates.length} crates with ${crateSkinsCount} crate-skin links`);

  // --- Import skin variants ---
  console.log('Importing skin variants...');
  let variantCount = 0;
  let skippedCount = 0;
  for (const variant of skinsNotGrouped) {
    if (!variant.market_hash_name || !variant.wear) {
      skippedCount++;
      continue;
    }
    await sql`
      INSERT INTO skin_variants (skin_id, market_hash_name, wear_name, is_stattrak, is_souvenir)
      VALUES (
        ${variant.skin_id},
        ${variant.market_hash_name},
        ${variant.wear.name},
        ${variant.stattrak ?? false},
        ${variant.souvenir ?? false}
      )
      ON CONFLICT (market_hash_name) DO UPDATE SET
        skin_id = EXCLUDED.skin_id,
        wear_name = EXCLUDED.wear_name,
        is_stattrak = EXCLUDED.is_stattrak,
        is_souvenir = EXCLUDED.is_souvenir
    `;
    variantCount++;
  }
  console.log(`  Inserted ${variantCount} variants (skipped ${skippedCount} without market_hash_name)`);

  // --- Verification ---
  console.log('\n=== Verification ===');
  const [skinCount] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM skins`;
  const [variantCountDb] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM skin_variants`;
  const [collectionCount] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM collections`;
  const [collectionSkinCount] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM collection_skins`;
  const [crateCount] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM crates`;
  const [crateSkinCount] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM crate_skins`;
  const [rareSkinCount] = await sql<{ count: number }[]>`SELECT COUNT(*) as count FROM crate_skins WHERE is_rare = TRUE`;

  console.log(`  Skins: ${skinCount.count}`);
  console.log(`  Skin variants: ${variantCountDb.count}`);
  console.log(`  Collections: ${collectionCount.count}`);
  console.log(`  Collection-skin links: ${collectionSkinCount.count}`);
  console.log(`  Crates: ${crateCount.count}`);
  console.log(`  Crate-skin links: ${crateSkinCount.count} (${rareSkinCount.count} rare/knives/gloves)`);

  // Spot check: AK-47 skins
  console.log('\n--- Spot check: AK-47 skins ---');
  const ak47Skins = await sql`SELECT id, name, rarity_name FROM skins WHERE name LIKE '%AK-47%' LIMIT 5`;
  for (const s of ak47Skins) {
    console.log(`  ${s.name} (${s.rarity_name})`);
  }

  // Spot check: AK-47 | Redline variants
  console.log('\n--- Spot check: AK-47 | Redline variants ---');
  const redlineVariants = await sql`
    SELECT sv.market_hash_name, sv.wear_name, sv.is_stattrak
    FROM skin_variants sv
    JOIN skins s ON sv.skin_id = s.id
    WHERE s.name = 'AK-47 | Redline'
    ORDER BY sv.is_stattrak, sv.wear_name
  `;
  for (const v of redlineVariants) {
    console.log(`  ${v.market_hash_name} ${v.is_stattrak ? '(StatTrak)' : ''}`);
  }

  // Spot check: collection with skins
  console.log('\n--- Spot check: first collection with skins ---');
  const sampleCols = await sql`
    SELECT c.name as collection_name, COUNT(*) as skin_count
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    GROUP BY c.id, c.name
    ORDER BY skin_count DESC
    LIMIT 1
  `;
  if (sampleCols.length > 0) {
    console.log(`  ${sampleCols[0].collection_name}: ${sampleCols[0].skin_count} skins`);
  }

  await sql.end();
  console.log('\nDone!');
}

main().catch(async (err) => {
  console.error('Import failed:', err);
  await sql.end();
  process.exit(1);
});
