/**
 * Imports skin/collection/crate metadata from ByMykel's CSGO-API.
 *
 * Upsert-only and batched — safe to re-run at any time (see src/lib/import-metadata.ts).
 * The same importer runs daily via /api/cron/import-metadata; use this script to
 * pull a new drop in immediately.
 *
 * Usage: npx tsx scripts/import-metadata.ts
 */
import './env';
import sql from '../src/lib/db';
import { importMetadata } from '../src/lib/import-metadata';

async function main() {
  console.log('=== CS2 Metadata Import ===\n');

  const stats = await importMetadata((msg) => console.log(msg));

  // --- Verification ---
  console.log('\n=== Verification ===');
  const [skinCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM skins`;
  const [variantCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM skin_variants`;
  const [collectionCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM collections`;
  const [collectionSkinCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM collection_skins`;
  const [crateCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM crates`;
  const [crateSkinCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM crate_skins`;
  const [rareSkinCount] = await sql<{ count: number }[]>`SELECT COUNT(*)::int as count FROM crate_skins WHERE is_rare = TRUE`;

  console.log(`  Skins: ${skinCount.count}`);
  console.log(`  Skin variants: ${variantCount.count}`);
  console.log(`  Collections: ${collectionCount.count}`);
  console.log(`  Collection-skin links: ${collectionSkinCount.count}`);
  console.log(`  Crates: ${crateCount.count}`);
  console.log(`  Crate-skin links: ${crateSkinCount.count} (${rareSkinCount.count} rare/knives/gloves)`);
  console.log(`  Import took ${(stats.duration_ms / 1000).toFixed(1)}s`);

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

  // Spot check: newest collections by id (new drops tend to sort last)
  console.log('\n--- Spot check: collections with skins ---');
  const sampleCols = await sql`
    SELECT c.name as collection_name, COUNT(*)::int as skin_count
    FROM collections c
    JOIN collection_skins cs ON c.id = cs.collection_id
    GROUP BY c.id, c.name
    ORDER BY skin_count DESC
    LIMIT 3
  `;
  for (const c of sampleCols) {
    console.log(`  ${c.collection_name}: ${c.skin_count} skins`);
  }

  await sql.end();
  console.log('\nDone!');
}

main().catch(async (err) => {
  console.error('Import failed:', err);
  await sql.end();
  process.exit(1);
});
