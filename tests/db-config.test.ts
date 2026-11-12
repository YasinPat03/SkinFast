import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUNTIME_POOL_OPTIONS, getRuntimeDatabaseUrl } from '../src/lib/db-config';

test('legacy Supabase session URLs use transaction mode without changing credentials or options', () => {
  for (const port of [':5432', '']) {
    const original = new URL(`postgresql://postgres.example:p%40ss%3Aword@aws-0-us-east-1.pooler.supabase.com${port}/postgres?sslmode=require`);
    const actual = new URL(getRuntimeDatabaseUrl(original.toString()));
    assert.equal(actual.port, '6543');
    assert.equal(actual.username, original.username);
    assert.equal(actual.password, original.password);
    assert.equal(actual.hostname, original.hostname);
    assert.equal(actual.pathname, original.pathname);
    assert.equal(actual.search, original.search);
  }
});

test('direct databases, other providers, and configured transaction poolers are unchanged', () => {
  for (const url of [
    'postgres://user:pass@localhost:5432/skins',
    'postgres://user:pass@db.example.supabase.co:5432/postgres',
    'postgres://user:pass@other.example:5432/postgres',
    'postgres://user:pass@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
    'postgres://user:pass@aws-0-us-east-1.pooler.supabase.com:5433/postgres',
    'postgres://user:pass@pooler.supabase.com.example.org:5432/postgres',
  ]) assert.equal(getRuntimeDatabaseUrl(url), url);
});

test('the runtime client is configured for the transaction pooler', () => {
  // Named prepared statements do not exist in transaction mode.
  assert.equal(RUNTIME_POOL_OPTIONS.prepare, false);
  // Pipelined queries stall through the pooler (a page load hung on it), so
  // each connection must carry one query at a time.
  assert.equal(RUNTIME_POOL_OPTIONS.max_pipeline, 0);
  assert.ok(RUNTIME_POOL_OPTIONS.max <= 3);
});
