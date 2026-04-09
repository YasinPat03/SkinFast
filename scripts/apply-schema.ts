/**
 * Applies src/lib/schema.sql to the database in DATABASE_URL.
 * Safe to re-run — every statement uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 *
 * Usage: npx tsx scripts/apply-schema.ts
 */
import './env';
import { readFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(connectionString);

async function main() {
  const schemaPath = join(process.cwd(), 'src/lib/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  console.log(`Applying ${schemaPath}...`);
  await sql.unsafe(schema);
  console.log('Schema applied.');
  await sql.end();
}

main().catch(async (err) => {
  console.error('Failed:', err);
  await sql.end();
  process.exit(1);
});
