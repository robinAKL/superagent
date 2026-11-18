import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { startPgListener, tenantKey, WorkSignal, workerKey } from './signal.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const SCHEMA = `t07_${randomUUID().replace(/-/g, '')}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (file: string) => readFileSync(path.resolve(here, '../../../migrations', file), 'utf8').replace(/^GRANT .*$/gm, '');

// Only the tasks columns the trigger reads; the real table has more.
const TASKS_DDL = `
CREATE TABLE tasks (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, status text NOT NULL, lease_owner text,
  dead_letter boolean NOT NULL DEFAULT false, not_before timestamptz
);`;

live('migration 0015 triggers NOTIFY on commit, and the listener wakes the matching poll keys', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const setup = await pool.connect();
  const signal = new WorkSignal();
  const listener = startPgListener(() => pool.connect(), { signal, log: () => undefined, minMs: 50 });
  try {
    await setup.query(`CREATE SCHEMA "${SCHEMA}"; SET search_path TO "${SCHEMA}";`);
    await setup.query(TASKS_DDL);
    await setup.query(migration('0013_workers.sql'));
    await setup.query(migration('0014_room_worker_dispatch.sql'));
    await setup.query(migration('0015_worker_notify.sql'));
    for (let i = 0; i < 100 && !signal.listening; i++) await new Promise((r) => setTimeout(r, 20));
    expect(signal.listening).toBe(true);

    const tenant = randomUUID();
    const workerId = randomUUID();
    await setup.query(`INSERT INTO workers (id, tenant_id, name, kind, token_hash, created_by) VALUES ($1, $2, 'w', 'link', $3, 'u')`, [workerId, tenant, randomUUID()]);

    // An event for this worker wakes its key, and only after commit.
    const eventWake = signal.waitFor([workerKey(workerId)]);
    let eventWoke = false;
    void eventWake.promise.then(() => { eventWoke = true; });
    await setup.query('BEGIN');
    await setup.query(`INSERT INTO worker_events (worker_id, seq, tenant_id, kind, created_by) VALUES ($1, 1, $2, 'wake', 'super-agent')`, [workerId, tenant]);
    await new Promise((r) => setTimeout(r, 200));
    expect(eventWoke).toBe(false); // not before commit
    await setup.query('COMMIT');
    await eventWake.promise;

    // Claimable queue work wakes the tenant key.
    const workWake = signal.waitFor([tenantKey(tenant)]);
    await setup.query(`INSERT INTO tasks (id, tenant_id, status) VALUES ($1, $2, 'assigned')`, [randomUUID(), tenant]);
    await workWake.promise;

    // A leased row is not claimable: no notification for it.
    const other = randomUUID();
    const leased = signal.waitFor([tenantKey(other)]);
    let leasedWoke = false;
    void leased.promise.then(() => { leasedWoke = true; });
    await setup.query(`INSERT INTO tasks (id, tenant_id, status, lease_owner) VALUES ($1, $2, 'running', 'w')`, [randomUUID(), other]);
    await new Promise((r) => setTimeout(r, 300));
    expect(leasedWoke).toBe(false);
    leased.cancel();
  } finally {
    await listener.stop();
    await setup.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    setup.release();
    await pool.end();
  }
}, 20_000);
