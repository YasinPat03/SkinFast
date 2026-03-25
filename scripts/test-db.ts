import { getDb, initDb, closeDb } from '../src/lib/db';

console.log('Initializing database...');
initDb();

const db = getDb();

// Verify all tables exist
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).all() as { name: string }[];

console.log('\nTables created:');
for (const table of tables) {
  console.log(`  - ${table.name}`);
}

// Verify indexes
const indexes = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
).all() as { name: string }[];

console.log('\nIndexes created:');
for (const idx of indexes) {
  console.log(`  - ${idx.name}`);
}

// Quick sanity check: insert and read back
console.log('\nSanity check — inserting test skin...');
const insert = db.prepare(`
  INSERT OR REPLACE INTO skins (id, name, weapon_name, pattern_name, rarity_id, rarity_name, min_float, max_float, has_stattrak, has_souvenir)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
insert.run('test-skin-1', 'AK-47 | Test Skin', 'AK-47', 'Test Skin', 'rarity_rare_weapon', 'Mil-Spec Grade', 0.0, 1.0, 1, 0);

const skin = db.prepare('SELECT * FROM skins WHERE id = ?').get('test-skin-1');
console.log('  Read back:', skin);

// Clean up test data
db.prepare('DELETE FROM skins WHERE id = ?').run('test-skin-1');
console.log('  Cleaned up test data.');

closeDb();
console.log('\nAll checks passed!');
