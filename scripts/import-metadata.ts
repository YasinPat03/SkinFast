import { getDb, initDb, closeDb } from '../src/lib/db';

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

  // Initialize database
  initDb();
  const db = getDb();

  // Clear existing data for clean import
  db.exec('DELETE FROM crate_skins');
  db.exec('DELETE FROM crates');
  db.exec('DELETE FROM collection_skins');
  db.exec('DELETE FROM skin_variants');
  db.exec('DELETE FROM skins');
  db.exec('DELETE FROM collections');

  // --- Import skins ---
  console.log('Importing skins...');
  const insertSkin = db.prepare(`
    INSERT OR REPLACE INTO skins (id, name, weapon_name, pattern_name, rarity_id, rarity_name, min_float, max_float, has_stattrak, has_souvenir, image_url, paint_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSkinsBatch = db.transaction((items: RawSkin[]) => {
    for (const skin of items) {
      insertSkin.run(
        skin.id,
        skin.name,
        skin.weapon?.name ?? '',
        skin.pattern?.name ?? '',
        normalizeRarityId(skin.rarity?.id ?? ''),
        skin.rarity?.name ?? '',
        skin.min_float ?? 0,
        skin.max_float ?? 1,
        skin.stattrak ? 1 : 0,
        skin.souvenir ? 1 : 0,
        skin.image ?? null,
        skin.paint_index ? parseInt(skin.paint_index, 10) : null,
      );
    }
  });
  insertSkinsBatch(skins);
  console.log(`  Inserted ${skins.length} skins`);

  // --- Import collections ---
  console.log('Importing collections...');
  const insertCollection = db.prepare(`
    INSERT OR REPLACE INTO collections (id, name, image_url)
    VALUES (?, ?, ?)
  `);

  // Build a set of valid skin IDs for FK validation
  const validSkinIds = new Set<string>(
    (db.prepare('SELECT id FROM skins').all() as { id: string }[]).map(r => r.id)
  );

  const insertCollectionSkin = db.prepare(`
    INSERT OR REPLACE INTO collection_skins (collection_id, skin_id, rarity_id)
    VALUES (?, ?, ?)
  `);

  const insertCollectionsBatch = db.transaction((items: RawCollection[]) => {
    for (const col of items) {
      insertCollection.run(col.id, col.name, col.image);

      for (const skin of col.contains) {
        // Skip skins not in our skins table (e.g. vanilla/default items)
        if (!validSkinIds.has(skin.id)) continue;
        insertCollectionSkin.run(
          col.id,
          skin.id,
          normalizeRarityId(skin.rarity.id),
        );
      }
    }
  });
  insertCollectionsBatch(collections);

  const totalCollectionSkins = collections.reduce((sum, c) => sum + c.contains.length, 0);
  console.log(`  Inserted ${collections.length} collections with ${totalCollectionSkins} collection-skin links`);

  // --- Import crates ---
  console.log('Importing crates...');
  const insertCrate = db.prepare(`
    INSERT OR REPLACE INTO crates (id, name, image_url)
    VALUES (?, ?, ?)
  `);

  const insertCrateSkin = db.prepare(`
    INSERT OR REPLACE INTO crate_skins (crate_id, skin_id, rarity_id, is_rare)
    VALUES (?, ?, ?, ?)
  `);

  let crateSkinsCount = 0;
  const insertCratesBatch = db.transaction((items: RawCrate[]) => {
    for (const crate of items) {
      insertCrate.run(crate.id, crate.name, crate.image);

      // Regular skins in the crate (contains)
      if (crate.contains) {
        for (const skin of crate.contains) {
          if (!validSkinIds.has(skin.id)) continue;
          insertCrateSkin.run(
            crate.id,
            skin.id,
            normalizeRarityId(skin.rarity.id),
            0,
          );
          crateSkinsCount++;
        }
      }

      // Rare skins in the crate (contains_rare) - knives/gloves
      if (crate.contains_rare) {
        for (const skin of crate.contains_rare) {
          if (!validSkinIds.has(skin.id)) continue;
          insertCrateSkin.run(
            crate.id,
            skin.id,
            normalizeRarityId(skin.rarity.id),
            1,
          );
          crateSkinsCount++;
        }
      }
    }
  });
  insertCratesBatch(crates);
  console.log(`  Inserted ${crates.length} crates with ${crateSkinsCount} crate-skin links`);

  // --- Import skin variants ---
  console.log('Importing skin variants...');
  const insertVariant = db.prepare(`
    INSERT OR REPLACE INTO skin_variants (id, skin_id, market_hash_name, wear_name, is_stattrak, is_souvenir)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let variantCount = 0;
  let skippedCount = 0;
  const insertVariantsBatch = db.transaction((items: RawSkinNotGrouped[]) => {
    for (const variant of items) {
      // Skip variants without market_hash_name or wear (can't be priced/categorized)
      if (!variant.market_hash_name || !variant.wear) {
        skippedCount++;
        continue;
      }
      insertVariant.run(
        null, // autoincrement
        variant.skin_id,
        variant.market_hash_name,
        variant.wear.name,
        variant.stattrak ? 1 : 0,
        variant.souvenir ? 1 : 0,
      );
      variantCount++;
    }
  });
  insertVariantsBatch(skinsNotGrouped);
  console.log(`  Inserted ${variantCount} variants (skipped ${skippedCount} without market_hash_name)`);

  // --- Verification ---
  console.log('\n=== Verification ===');
  const skinCount = (db.prepare('SELECT COUNT(*) as count FROM skins').get() as { count: number }).count;
  const variantCountDb = (db.prepare('SELECT COUNT(*) as count FROM skin_variants').get() as { count: number }).count;
  const collectionCount = (db.prepare('SELECT COUNT(*) as count FROM collections').get() as { count: number }).count;
  const collectionSkinCount = (db.prepare('SELECT COUNT(*) as count FROM collection_skins').get() as { count: number }).count;

  const crateCount = (db.prepare('SELECT COUNT(*) as count FROM crates').get() as { count: number }).count;
  const crateSkinCount = (db.prepare('SELECT COUNT(*) as count FROM crate_skins').get() as { count: number }).count;
  const rareSkinCount = (db.prepare('SELECT COUNT(*) as count FROM crate_skins WHERE is_rare = 1').get() as { count: number }).count;

  console.log(`  Skins: ${skinCount}`);
  console.log(`  Skin variants: ${variantCountDb}`);
  console.log(`  Collections: ${collectionCount}`);
  console.log(`  Collection-skin links: ${collectionSkinCount}`);
  console.log(`  Crates: ${crateCount}`);
  console.log(`  Crate-skin links: ${crateSkinCount} (${rareSkinCount} rare/knives/gloves)`);

  // Spot check: AK-47 skins
  console.log('\n--- Spot check: AK-47 skins ---');
  const ak47Skins = db.prepare("SELECT id, name, rarity_name FROM skins WHERE name LIKE '%AK-47%' LIMIT 5").all();
  for (const s of ak47Skins) {
    console.log(`  ${(s as { name: string }).name} (${(s as { rarity_name: string }).rarity_name})`);
  }

  // Spot check: AK-47 | Redline variants
  console.log('\n--- Spot check: AK-47 | Redline variants ---');
  const redlineVariants = db.prepare(`
    SELECT sv.market_hash_name, sv.wear_name, sv.is_stattrak
    FROM skin_variants sv
    JOIN skins s ON sv.skin_id = s.id
    WHERE s.name = 'AK-47 | Redline'
    ORDER BY sv.is_stattrak, sv.wear_name
  `).all();
  for (const v of redlineVariants) {
    const row = v as { market_hash_name: string; wear_name: string; is_stattrak: number };
    console.log(`  ${row.market_hash_name} ${row.is_stattrak ? '(StatTrak)' : ''}`);
  }

  // Spot check: collection with skins
  console.log('\n--- Spot check: first collection with skins ---');
  const sampleCol = db.prepare(`
    SELECT c.name as collection_name, COUNT(*) as skin_count
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    GROUP BY c.id
    ORDER BY skin_count DESC
    LIMIT 1
  `).get() as { collection_name: string; skin_count: number };
  if (sampleCol) {
    console.log(`  ${sampleCol.collection_name}: ${sampleCol.skin_count} skins`);
  }

  closeDb();
  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Import failed:', err);
  closeDb();
  process.exit(1);
});
