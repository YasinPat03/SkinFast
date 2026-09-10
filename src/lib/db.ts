import postgres from 'postgres';

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
// DATABASE_URL should point at the transaction-mode pooler (port 6543), which is the
// Supabase recommendation for serverless. Transaction mode does not support named
// prepared statements, hence `prepare: false` (harmless in session mode too).
const sql = postgres(connectionString, {
  max: 3,
  idle_timeout: 10,
  max_lifetime: 60 * 10,
  connect_timeout: 10,
  prepare: false,
});

export default sql;
