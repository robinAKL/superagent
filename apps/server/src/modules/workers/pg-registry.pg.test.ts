import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PgWorkerRegistry } from './pg-registry.js';
import { authenticateWorker, OFFLINE_AFTER_MS, registerWorker, workerStatus } from './registry.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const SCHEMA = `t03_${randomUUID().replace(/-/g, '')}`;
const here = path.dirname(fileURLToPath(import.meta.url));
// The real migration, minus the GRANT (the test role may not have superagent_app).
const MIGRATION = readFileSync(path.resolve(here, '../../../migrations/0013_workers.sql'), 'utf8').replace(/^GRANT .*$/m, '');

live('PgWorkerRegistry: register, authenticate, heartbeat, waiting_auth, offline, revoke against the real migration', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${SCHEMA}"; SET search_path TO "${SCHEMA}";`);
    await client.query(MIGRATION);
    const db = { query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await client.query(text, params as unknown[])).rows as T[] }) };
    const reg = new PgWorkerRegistry(db);
    const tenant = randomUUID();
    const t0 = Date.UTC(2026, 10, 16, 12, 0, 0);

    const { worker, token } = await registerWorker(reg, { tenantId: tenant, name: 'dev box', kind: 'link', capabilities: { kinds: ['knowledge.parse'] }, createdBy: 'u1' }, t0);
    const found = await authenticateWorker(reg, token);
    expect(found?.id).toBe(worker.id);
    expect(found?.capabilities).toEqual({ kinds: ['knowledge.parse'] });
    expect(workerStatus(found!, t0)).toBe('offline');

    expect(await reg.heartbeat(worker.id, t0, {})).toBe(true);
    expect(workerStatus((await reg.get(tenant, worker.id))!, t0)).toBe('registered');
    await reg.heartbeat(worker.id, t0 + 1000, { busy: true });
    expect(workerStatus((await reg.get(tenant, worker.id))!, t0 + 1000)).toBe('live');
    await reg.heartbeat(worker.id, t0 + 2000, { waitingAuthReason: 'claude login expired' });
    const waiting = (await reg.get(tenant, worker.id))!;
    expect(waiting.busy).toBe(true); // absent busy left as it was
    expect(workerStatus(waiting, t0 + 2000)).toBe('waiting_auth');
    await reg.heartbeat(worker.id, t0 + 3000, { waitingAuthReason: null, busy: false });
    expect(workerStatus((await reg.get(tenant, worker.id))!, t0 + 3000 + OFFLINE_AFTER_MS + 1)).toBe('offline');

    expect(await reg.get(randomUUID(), worker.id)).toBeNull();
    expect(await reg.revoke(randomUUID(), worker.id, t0)).toBe(false);
    expect(await reg.revoke(tenant, worker.id, t0 + 4000)).toBe(true);
    expect(await reg.revoke(tenant, worker.id, t0 + 5000)).toBe(false);
    expect(await reg.heartbeat(worker.id, t0 + 6000, {})).toBe(false);
    expect(await authenticateWorker(reg, token)).toBeNull();
    expect((await reg.list(tenant)).map((w) => workerStatus(w, t0 + 6000))).toEqual(['revoked']);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    client.release();
    await pool.end();
  }
});
