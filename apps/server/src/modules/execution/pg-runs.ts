import { sopEventKey } from '../sop/sop.js';
import type { Execution } from './executor.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

const UPSERT = `
INSERT INTO execution_runs (id, runs, seq) VALUES (true, $1::jsonb, $2)
ON CONFLICT (id) DO UPDATE SET runs = EXCLUDED.runs, seq = EXCLUDED.seq
`.trim();

const LOAD = `SELECT runs, seq FROM execution_runs WHERE id = true`;

export async function saveRuns(db: Queryable, snapshot: { runs: Execution[]; seq: number }): Promise<void> {
  await db.query(UPSERT, [JSON.stringify(snapshot.runs), snapshot.seq]);
}

export async function loadRuns(db: Queryable): Promise<{ runs: Execution[]; seq: number } | null> {
  const result = await db.query<{ runs: Execution[]; seq: number }>(LOAD, []);
  const row = result.rows[0];
  if (!row) return null;
  return { runs: row.runs, seq: Number(row.seq) };
}

const INSERT_RUN = `
INSERT INTO execution_run (id, tenant_id, instance_id, payload)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (tenant_id, instance_id) DO NOTHING
RETURNING id
`.trim();

const UPDATE_RUN = `
UPDATE execution_run SET payload = $4::jsonb
WHERE id = $1 AND tenant_id = $2 AND instance_id = $3
`.trim();

const LOAD_ONE = `SELECT payload FROM execution_run WHERE tenant_id = $1 AND instance_id = $2`;
const LOAD_BY_ID = `SELECT payload FROM execution_run WHERE id = $1`;
const LOAD_CLAIMED = `SELECT payload FROM execution_run`;

/** Insert one claimed run. False means another process already owns this instance. */
export async function insertRun(db: Queryable, run: Execution): Promise<boolean> {
  const result = await db.query<{ id: string }>(INSERT_RUN, [run.id, run.tenantId, run.instanceId, JSON.stringify(run)]);
  return result.rows.length > 0;
}

/** Replace the payload of a run this process already inserted. Does not create a row and does not touch other runs. */
export async function updateRun(db: Queryable, run: Execution): Promise<void> {
  await db.query(UPDATE_RUN, [run.id, run.tenantId, run.instanceId, JSON.stringify(run)]);
}

export async function loadRunByInstance(db: Queryable, tenantId: string, instanceId: string): Promise<Execution | null> {
  const result = await db.query<{ payload: Execution }>(LOAD_ONE, [tenantId, instanceId]);
  return result.rows[0]?.payload ?? null;
}

export async function loadRunById(db: Queryable, id: string): Promise<Execution | null> {
  const result = await db.query<{ payload: Execution }>(LOAD_BY_ID, [id]);
  return result.rows[0]?.payload ?? null;
}

export async function loadClaimedRuns(db: Queryable): Promise<Execution[]> {
  const result = await db.query<{ payload: Execution }>(LOAD_CLAIMED, []);
  return result.rows.map((row) => row.payload);
}

/** Register a manual event, its pinned SOP instance and its run in the same durable statement. */
export async function insertCommandRun(db: Queryable, run: Execution): Promise<boolean> {
  const eventId = Buffer.from(run.eventId).toString('base64url');
  const eventKey = sopEventKey(run.tenantId, 'command', eventId, run.sopId);
  const result = await db.query<{ id: string }>(`
    WITH event AS (
      INSERT INTO sop_events (tenant_id, source, event_id, sop_id, event_key, disposition)
      VALUES ($1, 'command', $2, $3, $4, 'open')
      ON CONFLICT (tenant_id, source, event_id, sop_id) DO NOTHING RETURNING event_key
    ), instance AS (
      INSERT INTO sop_instances (id, tenant_id, sop_id, sop_version_id, version_number, event_key, status)
      SELECT $5, $1, $3, $6, $7, event_key, 'running' FROM event RETURNING id
    )
    INSERT INTO execution_run (id, tenant_id, instance_id, payload)
    SELECT $8, $1, id, $9::jsonb FROM instance RETURNING id
  `, [run.tenantId, eventId, run.sopId, eventKey, run.instanceId, run.versionId, run.versionNumber, run.id, JSON.stringify(run)]);
  return result.rows.length === 1;
}

export async function loadCommandRuns(db: Queryable, tenantId: string, sopId?: string): Promise<Execution[]> {
  const result = await db.query<{ payload: Execution }>(`
    SELECT payload FROM execution_run
    WHERE tenant_id = $1 AND left(id, 8) = 'run_cmd_' AND ($2::text IS NULL OR payload->>'sopId' = $2)
    ORDER BY payload->>'startedAt', id
  `, [tenantId, sopId ?? null]);
  return result.rows.map(row => row.payload);
}

/** Compare the persisted state before a process advances an existing run. */
export async function claimCommandAdvance(db: Queryable, previous: Execution): Promise<boolean> {
  const result = await db.query<{ id: string }>(`
    UPDATE execution_run SET payload = jsonb_set(payload, '{status}', '"running"')
    WHERE id = $1 AND tenant_id = $2 AND payload = $3::jsonb
    RETURNING id
  `, [previous.id, previous.tenantId, JSON.stringify(previous)]);
  return result.rows.length === 1;
}

export async function completeCommandInstance(db: Queryable, run: Execution): Promise<void> {
  if (run.status !== 'completed') return;
  await db.query("UPDATE sop_instances SET status = 'completed' WHERE id = $1 AND tenant_id = $2",
    [run.instanceId, run.tenantId]);
}
