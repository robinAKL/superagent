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
const MIGRATION = ['0013_workers.sql', '0014_room_worker_dispatch.sql'].map((file) =>
  readFileSync(path.resolve(here, '../../../migrations', file), 'utf8').replace(/^GRANT .*$/gm, ''),
).join('\n');

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

    // Events: per-worker cursor, other tenants cannot address the worker.
    expect(await reg.appendEvent(randomUUID(), worker.id, 'wake', {}, 'x', t0)).toBeNull();
    const e1 = await reg.appendEvent(tenant, worker.id, 'wake', { projectId: 'p1' }, 'super-agent', t0);
    expect(e1).toMatchObject({ seq: 1, kind: 'wake', payload: { projectId: 'p1' } });
    // Concurrent appends from separate connections: no duplicate or missing seq.
    const workerId = worker.id;
    await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const c = await pool.connect();
      try {
        await c.query(`SET search_path TO "${SCHEMA}"`);
        const other = new PgWorkerRegistry({ query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await c.query(text, params as unknown[])).rows as T[] }) });
        await other.appendEvent(tenant, workerId, 'message', { i }, 'super-agent', t0 + i);
      } finally {
        c.release();
      }
    }));
    const all = await reg.eventsAfter(worker.id, 0, 100);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect((await reg.eventsAfter(worker.id, 9, 100)).map((e) => e.seq)).toEqual([10, 11]);
    expect(await reg.eventsAfter(worker.id, 11, 100)).toEqual([]);
    const dispatch = await reg.appendEvent(tenant, worker.id, 'wake', { roomTaskId: 'task_1' }, 'super-agent', t0, 'task_1');
    expect(dispatch?.seq).toBe(12);
    expect(await reg.appendEvent(tenant, worker.id, 'wake', {}, 'super-agent', t0, 'task_1')).toBeNull();
    expect(await reg.hasRoomDispatch(tenant, worker.id, 'task_1')).toBe(true);
    expect(await reg.hasRoomDispatch(tenant, randomUUID(), 'task_1')).toBe(false);

    expect(await reg.get(randomUUID(), worker.id)).toBeNull();
    expect(await reg.revoke(randomUUID(), worker.id, t0)).toBe(false);
    expect(await reg.revoke(tenant, worker.id, t0 + 4000)).toBe(true);
    expect(await reg.revoke(tenant, worker.id, t0 + 5000)).toBe(false);
    expect(await reg.heartbeat(worker.id, t0 + 6000, {})).toBe(false);
    expect(await authenticateWorker(reg, token)).toBeNull();
    expect(await reg.appendEvent(tenant, worker.id, 'wake', {}, 'x', t0 + 7000)).toBeNull();
    expect((await reg.list(tenant)).map((w) => workerStatus(w, t0 + 6000))).toEqual(['revoked']);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    client.release();
    await pool.end();
  }
});
