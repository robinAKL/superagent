import type { Queryable } from '../runtime/pg-queue.js';
import { mergeCapabilities, type HeartbeatInput, type WorkerCapabilities, type WorkerEvent, type WorkerEventKind, type WorkerKind, type WorkerRecord, type WorkerRegistry } from './registry.js';

interface Row {
  id: string;
  tenant_id: string;
  name: string;
  kind: WorkerKind;
  capabilities: WorkerCapabilities | null;
  token_hash: string;
  last_heartbeat_at: Date | string | null;
  busy: boolean;
  waiting_auth_reason: string | null;
  revoked_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
}

const COLUMNS = 'id, tenant_id, name, kind, capabilities, token_hash, last_heartbeat_at, busy, waiting_auth_reason, revoked_at, created_by, created_at';

export const INSERT_WORKER_SQL = `
INSERT INTO workers (id, tenant_id, name, kind, capabilities, token_hash, last_heartbeat_at, busy, waiting_auth_reason, revoked_at, created_by, created_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, NULL, false, NULL, NULL, $7, to_timestamp($8::double precision / 1000));
`.trim();

export const WORKER_BY_TOKEN_SQL = `SELECT ${COLUMNS} FROM workers WHERE token_hash = $1 LIMIT 1;`;
export const WORKER_BY_ID_SQL = `SELECT ${COLUMNS} FROM workers WHERE id = $2::uuid AND tenant_id = $1::uuid LIMIT 1;`;
export const LIST_WORKERS_SQL = `SELECT ${COLUMNS} FROM workers WHERE tenant_id = $1::uuid ORDER BY created_at, id;`;

/** $3 / $4 are "leave as is" when null; $4 = '' clears waiting_auth. A revoked worker cannot heartbeat. */
export const HEARTBEAT_WORKER_SQL = `
UPDATE workers
SET last_heartbeat_at = to_timestamp($2::double precision / 1000),
    busy = coalesce($3::boolean, busy),
    waiting_auth_reason = CASE WHEN $4::text IS NULL THEN waiting_auth_reason ELSE nullif($4::text, '') END
WHERE id = $1::uuid
  AND revoked_at IS NULL
RETURNING id;
`.trim();

export const REVOKE_WORKER_SQL = `
UPDATE workers
SET revoked_at = to_timestamp($3::double precision / 1000)
WHERE id = $2::uuid
  AND tenant_id = $1::uuid
  AND revoked_at IS NULL
RETURNING id;
`.trim();

export const PATCH_CAPABILITIES_SQL = `
UPDATE workers
SET capabilities = $3::jsonb
WHERE id = $2::uuid
  AND tenant_id = $1::uuid
  AND revoked_at IS NULL
RETURNING ${COLUMNS};
`.trim();

/**
 * seq = max + 1 for this worker. A concurrent append that picks the same seq hits the primary key and is retried,
 * so seq order is commit order. Only a live (unrevoked) worker of the same tenant can be addressed.
 */
export const APPEND_EVENT_SQL = `
INSERT INTO worker_events (worker_id, seq, tenant_id, kind, payload, created_by, created_at, room_task_id)
SELECT w.id,
       coalesce((SELECT max(e.seq) FROM worker_events e WHERE e.worker_id = w.id), 0) + 1,
       w.tenant_id, $3, $4::jsonb, $5, to_timestamp($6::double precision / 1000), $7
FROM workers w
WHERE w.id = $2::uuid
  AND w.tenant_id = $1::uuid
  AND w.revoked_at IS NULL
ON CONFLICT (tenant_id, room_task_id) DO NOTHING
RETURNING worker_id, seq, kind, payload, created_by, created_at;
`.trim();

const FIND_ROOM_DISPATCH_SQL = `
SELECT seq FROM worker_events
WHERE tenant_id = $1::uuid AND worker_id = $2::uuid AND room_task_id = $3;
`.trim();

export const EVENTS_AFTER_SQL = `
SELECT worker_id, seq, kind, payload, created_by, created_at
FROM worker_events
WHERE worker_id = $1::uuid
  AND seq > $2::bigint
ORDER BY seq
LIMIT $3;
`.trim();

interface EventRow {
  worker_id: string;
  seq: string | number;
  kind: WorkerEventKind;
  payload: Record<string, unknown> | null;
  created_by: string;
  created_at: Date | string;
}

function fromEventRow(r: EventRow): WorkerEvent {
  return { seq: Number(r.seq), workerId: r.worker_id, kind: r.kind, payload: r.payload ?? {}, createdBy: r.created_by, createdAt: ms(r.created_at)! };
}

function ms(value: Date | string | null): number | null {
  if (value === null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function fromRow(r: Row): WorkerRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    name: r.name,
    kind: r.kind,
    capabilities: r.capabilities ?? {},
    tokenHash: r.token_hash,
    lastHeartbeatAt: ms(r.last_heartbeat_at),
    busy: r.busy,
    waitingAuthReason: r.waiting_auth_reason,
    revokedAt: ms(r.revoked_at),
    createdBy: r.created_by,
    createdAt: ms(r.created_at)!,
  };
}

export class PgWorkerRegistry implements WorkerRegistry {
  constructor(private readonly db: Queryable) {}

  async insert(w: WorkerRecord): Promise<void> {
    await this.db.query(INSERT_WORKER_SQL, [w.id, w.tenantId, w.name, w.kind, JSON.stringify(w.capabilities), w.tokenHash, w.createdBy, w.createdAt]);
  }

  async byTokenHash(tokenHash: string): Promise<WorkerRecord | null> {
    const { rows } = await this.db.query<Row>(WORKER_BY_TOKEN_SQL, [tokenHash]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async get(tenantId: string, id: string): Promise<WorkerRecord | null> {
    const { rows } = await this.db.query<Row>(WORKER_BY_ID_SQL, [tenantId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list(tenantId: string): Promise<WorkerRecord[]> {
    const { rows } = await this.db.query<Row>(LIST_WORKERS_SQL, [tenantId]);
    return rows.map(fromRow);
  }

  async heartbeat(id: string, at: number, input: HeartbeatInput): Promise<boolean> {
    const waiting = input.waitingAuthReason === undefined ? null : (input.waitingAuthReason ?? '');
    const { rows } = await this.db.query<{ id: string }>(HEARTBEAT_WORKER_SQL, [id, at, input.busy ?? null, waiting]);
    return rows.length === 1;
  }

  async revoke(tenantId: string, id: string, at: number): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(REVOKE_WORKER_SQL, [tenantId, id, at]);
    return rows.length === 1;
  }

  async patchCapabilities(tenantId: string, id: string, capabilities: WorkerCapabilities): Promise<WorkerRecord | null> {
    const current = await this.get(tenantId, id);
    if (!current || current.revokedAt !== null) return null;
    const next = mergeCapabilities(current.capabilities, capabilities);
    const { rows } = await this.db.query<Row>(PATCH_CAPABILITIES_SQL, [tenantId, id, JSON.stringify(next)]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async appendEvent(tenantId: string, workerId: string, kind: WorkerEventKind, payload: Record<string, unknown>, createdBy: string, at: number, roomTaskId?: string): Promise<WorkerEvent | null> {
    for (let tries = 0; ; tries++) {
      try {
        const { rows } = await this.db.query<EventRow>(APPEND_EVENT_SQL, [
          tenantId, workerId, kind, JSON.stringify(payload), createdBy, at, roomTaskId ?? null,
        ]);
        return rows[0] ? fromEventRow(rows[0]) : null;
      } catch (error) {
        // 23505 unique_violation: another append took this seq first. Read max again. Each round lets at least
        // one concurrent append through, so N concurrent appends need at most N-1 retries.
        if ((error as { code?: string }).code !== '23505' || tries >= 25) throw error;
      }
    }
  }

  async hasRoomDispatch(tenantId: string, workerId: string, roomTaskId: string): Promise<boolean> {
    const { rows } = await this.db.query(FIND_ROOM_DISPATCH_SQL, [tenantId, workerId, roomTaskId]);
    return rows.length > 0;
  }

  async eventsAfter(workerId: string, since: number, limit: number): Promise<WorkerEvent[]> {
    const { rows } = await this.db.query<EventRow>(EVENTS_AFTER_SQL, [workerId, since, limit]);
    return rows.map(fromEventRow);
  }
}
