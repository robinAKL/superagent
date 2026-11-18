import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { allowPair, MemoryPairStore, PgPairStore, pollPair, startPair } from './pairing.js';
import { MemoryWorkerRegistry } from './registry.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = [
  readFileSync(path.resolve(here, '../../../migrations/0013_workers.sql'), 'utf8'),
  readFileSync(path.resolve(here, '../../../migrations/0018_worker_pairing.sql'), 'utf8'),
].join('\n').replace(/^GRANT .*$/gm, '');

live('PgPairStore: allow issues a token once and isolates tenants', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const schema = `t30_${randomUUID().replace(/-/g, '')}`;
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";`);
    await client.query(MIGRATION);
    const db = { query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await client.query(text, params as unknown[])).rows as T[] }) };
    const store = new PgPairStore(db);
    const registry = new MemoryWorkerRegistry();
    const now = Date.UTC(2026, 10, 18, 0, 0, 0);
    const tenantA = randomUUID();
    const started = await startPair(store, { hostname: 'A-PC', agents: ['codex'] }, now);
    const allowed = await allowPair(store, registry, started.userCode, { tenantId: tenantA, userId: 'admin' }, now);
    if (typeof allowed === 'string') throw new Error(allowed);
    const first = await pollPair(store, started.deviceCode, now);
    expect(first.status).toBe('allowed');
    expect(first.token).toMatch(/^saw_/);
    expect((await pollPair(store, started.deviceCode, now)).token).toBeUndefined();
    const other = await startPair(store, { hostname: 'B-PC' }, now);
    const stolen = await allowPair(store, registry, other.userCode, { tenantId: randomUUID(), userId: 'b' }, now);
    if (typeof stolen === 'string') throw new Error(stolen);
    expect(stolen.tenantId).not.toBe(tenantA);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    client.release();
    await pool.end();
  }
});

it('MemoryPairStore expire and deny', async () => {
  const store = new MemoryPairStore();
  const now = 1_000;
  const started = await startPair(store, { hostname: 'x' }, now);
  expect((await pollPair(store, started.deviceCode, now + 10 * 60_000)).status).toBe('expired');
});
