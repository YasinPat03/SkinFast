import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';

test('database failures return a retryable error without exposing database details', async (t) => {
  // postgres.js connects lazily; the mocked query never opens this connection.
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test';
  const { default: sql } = await import('../src/lib/db');
  const { GET } = await import('../src/app/api/search/route');
  t.mock.method(sql, 'unsafe', async () => {
    throw new Error('MaxClientsInSessionMode: sensitive database details');
  });
  const log = t.mock.method(console, 'error', () => {});

  const response = await GET(new NextRequest('http://localhost/api/search?q=redline'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: 'Search is temporarily unavailable. Please try again.',
  });
  assert.equal(log.mock.callCount(), 1);

  // Clearing the query should still work without touching the failed database.
  const empty = await GET(new NextRequest('http://localhost/api/search?q=a'));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
});
