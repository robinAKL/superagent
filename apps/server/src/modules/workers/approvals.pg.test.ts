import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { approvalView, PgApprovalStore, type ApprovalRecord } from './approvals.js';
import { startPgListener, WorkSignal, workerKey } from './signal.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const SCHEMA = `t13_${randomUUID().replace(/-/g, '')}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (file: string) => readFileSync(path.resolve(here, '../../../migrations', file), 'utf8').replace(/^GRANT .*$/gm, '');

live('PgApprovalStore against migration 0016: create, list, decide once, expiry, and the decision NOTIFY', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const client = await pool.connect();
  const signal = new WorkSignal();
  const listener = startPgListener(() => pool.connect(), { signal, log: () => undefined, minMs: 50 });
  try {
    await client.query(`CREATE SCHEMA "${SCHEMA}"; SET search_path TO "${SCHEMA}";`);
    await client.query(migration('0013_workers.sql'));
    await client.query(migration('0016_worker_approvals.sql'));
    const db = { query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await client.query(text, params as unknown[])).rows as T[] }) };
    const store = new PgApprovalStore(db);
    const tenant = randomUUID();
    const workerId = randomUUID();
    await client.query(`INSERT INTO workers (id, tenant_id, name, kind, token_hash, created_by) VALUES ($1, $2, 'w', 'link', $3, 'u')`, [workerId, tenant, randomUUID()]);
    for (let i = 0; i < 100 && !signal.listening; i++) await new Promise((r) => setTimeout(r, 20));

    const t0 = Date.now();
    const base = { tenantId: tenant, workerId, roomTaskId: 'task_1', tool: 'Bash', input: { command: 'npm test' }, summary: 'Run tests', status: 'pending' as const, reason: null, decidedBy: null, decidedAt: null };
    const a: ApprovalRecord = { ...base, id: randomUUID(), expiresAt: t0 + 600_000, createdAt: t0 };
    const old: ApprovalRecord = { ...base, id: randomUUID(), expiresAt: t0 - 1, createdAt: t0 - 700_000 };
    await store.create(a);
    await store.create(old);

    expect(await store.countPending(workerId, t0)).toBe(1);
    const listed = await store.list(tenant);
    expect(listed.map((r) => r.id)).toEqual([a.id, old.id]);
    expect(listed[0]).toMatchObject({ tool: 'Bash', input: { command: 'npm test' }, roomTaskId: 'task_1', status: 'pending' });
    expect(approvalView(listed[1]!, t0).status).toBe('expired');
    expect(await store.get(randomUUID(), a.id)).toBeNull();

    // The decision commits and NOTIFYs the worker key.
    const woke = signal.waitFor([workerKey(workerId)]);
    const decided = await store.decide(tenant, a.id, 'allowed', 'robin', 'ok', t0 + 1_000);
    expect(decided).toMatchObject({ status: 'allowed', decidedBy: 'robin', reason: 'ok' });
    await woke.promise;

    expect(await store.decide(tenant, a.id, 'denied', 'eve', null, t0 + 2_000)).toBeNull(); // first one stands
    expect(await store.decide(tenant, old.id, 'allowed', 'robin', null, t0)).toBeNull(); // expired
    expect(await store.decide(randomUUID(), a.id, 'denied', 'x', null, t0)).toBeNull(); // other tenant
    expect((await store.get(tenant, a.id))?.status).toBe('allowed');
    expect(await store.countPending(workerId, t0)).toBe(0);
  } finally {
    await listener.stop();
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    client.release();
    await pool.end();
  }
}, 20_000);
