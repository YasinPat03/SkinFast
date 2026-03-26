import './env';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(connectionString);

async function main() {
  console.log('Testing Supabase connection...\n');

  // Verify all tables exist
  const tables = await sql`
    SELECT table_name as name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `;

  console.log('Tables found:');
  for (const table of tables) {
    console.log(`  - ${table.name}`);
  }

  // Quick sanity check: insert and read back
  console.log('\nSanity check — inserting test skin...');
  await sql`
    INSERT INTO skins (id, name, weapon_name, pattern_name, rarity_id, rarity_name, min_float, max_float, has_stattrak, has_souvenir)
    VALUES ('test-skin-1', 'AK-47 | Test Skin', 'AK-47', 'Test Skin', 'rarity_rare_weapon', 'Mil-Spec Grade', 0.0, 1.0, TRUE, FALSE)
    ON CONFLICT (id) DO NOTHING
  `;

  const rows = await sql`SELECT * FROM skins WHERE id = 'test-skin-1'`;
  console.log('  Read back:', rows[0]);

  // Clean up test data
  await sql`DELETE FROM skins WHERE id = 'test-skin-1'`;
  console.log('  Cleaned up test data.');

  await sql.end();
  console.log('\nAll checks passed!');
}

main().catch(async (err) => {
  console.error('Test failed:', err);
  await sql.end();
  process.exit(1);
});
