/**
 * Imports skin / collection / case metadata from ByMykel's CSGO-API. The same
 * importer runs daily via /api/cron/import-metadata; use this to pull a new
 * drop in immediately. Safe to re-run at any time.
 *
 *   npx tsx scripts/import-metadata.ts
 */
import './env';
import sql from '../src/lib/db';
import { runMetadataJob } from '../src/lib/market/jobs';

async function main() {
  const outcome = await runMetadataJob((message) => console.log(message));
  if (outcome.status === 'skipped') {
    console.log('Another import is running. Try again in a few minutes.');
    return;
  }
  if (outcome.status === 'crashed') {
    console.error(`Import failed: ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  const [counts] = await sql<{ skins: number; variants: number; collections: number; collection_links: number; crates: number; crate_links: number; rare_links: number }[]>`
    SELECT (SELECT COUNT(*)::int FROM skins) AS skins,
           (SELECT COUNT(*)::int FROM skin_variants) AS variants,
           (SELECT COUNT(*)::int FROM collections) AS collections,
           (SELECT COUNT(*)::int FROM collection_skins) AS collection_links,
           (SELECT COUNT(*)::int FROM crates) AS crates,
           (SELECT COUNT(*)::int FROM crate_skins) AS crate_links,
           (SELECT COUNT(*)::int FROM crate_skins WHERE is_rare) AS rare_links
  `;
  console.log('\nDatabase now holds:');
  console.log(`  ${counts.skins} skins, ${counts.variants} variants`);
  console.log(`  ${counts.collections} collections (${counts.collection_links} links)`);
  console.log(`  ${counts.crates} crates (${counts.crate_links} links, ${counts.rare_links} knives/gloves)`);

  const { pruned, warnings } = outcome.result;
  console.log(`Pruned: ${pruned.collection_skins} collection links, ${pruned.crate_skins} crate links, ${pruned.skin_variants} variants, ${pruned.skins} skins`);
  for (const warning of warnings) console.log(`WARNING: ${warning}`);
}

main()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
