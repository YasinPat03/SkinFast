import postgres from 'postgres';
import { RUNTIME_POOL_OPTIONS, getRuntimeDatabaseUrl } from './db-config';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

// This app runs as short-lived serverless functions (Vercel) plus cron scrapers, all
// sharing one Supabase pooler. Keep the per-process footprint small: the Supabase
// pooler in session mode caps the whole project at `pool_size` clients (15 by default)
// and a saturated pool makes every query fail with EMAXCONNSESSION, which takes down
// search, skin pages and the tradeup leaderboard at once.
//
// Normalize legacy shared-pooler URLs to transaction mode (port 6543); lowering
// `max` alone still lets separate serverless instances exhaust the session pool.
// Direct database URLs and other providers keep their configured endpoint.
const runtimeUrl = getRuntimeDatabaseUrl(connectionString);
const databaseGlobal = globalThis as typeof globalThis & {
  skinfastDatabase?: { url: string; sql: ReturnType<typeof postgres> };
};

const sql = databaseGlobal.skinfastDatabase?.url === runtimeUrl
  ? databaseGlobal.skinfastDatabase.sql
  : postgres(runtimeUrl, { ...RUNTIME_POOL_OPTIONS });

// Reuse the client when development hot reloads re-evaluate this module.
databaseGlobal.skinfastDatabase = { url: runtimeUrl, sql };

export default sql;
