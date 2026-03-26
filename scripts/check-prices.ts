import './env';
import sql from '../src/lib/db';

async function main() {
  const [priceCount] = await sql`SELECT COUNT(*) as cnt FROM prices`;
  const [variantCount] = await sql`SELECT COUNT(*) as cnt FROM skin_variants`;
  const [matchCount] = await sql`SELECT COUNT(*) as cnt FROM skin_variants sv JOIN prices p ON sv.market_hash_name = p.market_hash_name`;
  const [noPrice] = await sql`SELECT COUNT(*) as cnt FROM skin_variants sv LEFT JOIN prices p ON sv.market_hash_name = p.market_hash_name WHERE p.market_hash_name IS NULL`;

  console.log('Prices in DB:', priceCount.cnt);
  console.log('Skin variants:', variantCount.cnt);
  console.log('Variants with prices:', matchCount.cnt);
  console.log('Variants WITHOUT prices:', noPrice.cnt);

  // Check scrape state
  const state = await sql`SELECT * FROM scrape_state`;
  console.log('Scrape state:', state);

  // Sample some unmatched variants to see what's going on
  const unmatched = await sql`
    SELECT sv.market_hash_name, sv.wear_name, sv.is_stattrak, sv.is_souvenir, s.name as skin_name
    FROM skin_variants sv
    LEFT JOIN prices p ON sv.market_hash_name = p.market_hash_name
    JOIN skins s ON sv.skin_id = s.id
    WHERE p.market_hash_name IS NULL
    LIMIT 20
  `;
  console.log('\nSample unmatched variants:');
  for (const row of unmatched) {
    console.log(`  ${row.market_hash_name} (${row.skin_name}, ${row.wear_name}, stattrak=${row.is_stattrak}, souvenir=${row.is_souvenir})`);
  }

  // Check if any prices exist that DON'T match skin_variants (scraped but not in our metadata)
  const [orphanPrices] = await sql`SELECT COUNT(*) as cnt FROM prices p LEFT JOIN skin_variants sv ON p.market_hash_name = sv.market_hash_name WHERE sv.market_hash_name IS NULL`;
  console.log('\nOrphan prices (in prices but not in skin_variants):', orphanPrices.cnt);

  // Sample some price entries to see format
  const samplePrices = await sql`SELECT market_hash_name, lowest_price_cents FROM prices LIMIT 5`;
  console.log('\nSample prices:');
  for (const row of samplePrices) {
    console.log(`  ${row.market_hash_name} -> ${row.lowest_price_cents}c`);
  }

  await sql.end();
}

main().catch(console.error);
