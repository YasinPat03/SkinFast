// The shared Supabase pooler uses the same credentials and host for both modes.
// Web requests must use transaction mode so idle serverless instances do not
// reserve the project's limited session connections.
export function getRuntimeDatabaseUrl(connectionString: string): string {
  const url = new URL(connectionString);
  if (
    url.hostname.endsWith('.pooler.supabase.com') &&
    (url.port === '' || url.port === '5432')
  ) {
    url.port = '6543';
    return url.toString();
  }
  return connectionString;
}

// Options for the runtime Postgres client, shaped by what the Supabase
// transaction pooler (port 6543) can and cannot do:
//  - prepare: false. Transaction mode has no named prepared statements.
//  - max_pipeline: 0. The driver normally writes a connection's next query
//    before the previous one has answered. Through the transaction pooler that
//    stalls: with a dozen queries in flight (one page load) some never return,
//    and their eventual cancellation is delivered to an unrelated query.
//    Reproduced 2026-11-11; with pipelining off the same load always completes.
//  - max: 3. Every serverless instance has its own pool and they all share the
//    pooler's limits, so each one stays small.
export const RUNTIME_POOL_OPTIONS = {
  max: 3,
  idle_timeout: 10,
  max_lifetime: 60 * 10,
  connect_timeout: 10,
  prepare: false,
  max_pipeline: 0,
} as const;
