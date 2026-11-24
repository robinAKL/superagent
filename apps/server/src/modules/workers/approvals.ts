import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../runtime/pg-queue.js';
import type { WorkerRecord } from './registry.js';
import { workerKey, workSignal } from './signal.js';
import { roomTaskOfRun } from './room-run.js';

/**
 * Agent permission prompts relayed to the command room (room task T-13).
 *
 * A headless agent (Claude Code, Codex) that needs a person to confirm an action cannot show a dialog. Its Link
 * files the prompt here, a room owner allows or denies it, and the Link's held wait returns the decision so the
 * agent continues. One decision per request, first one wins. Unanswered requests expire and count as denied, so
 * an agent is never stuck waiting forever.
 */
export const APPROVAL_TTL_MS = 10 * 60_000;
export const APPROVAL_WAIT_MAX_MS = 25_000;
const MAX_PENDING_PER_WORKER = 20;
const INPUT_LIMIT = 16_384;

export type StoredApprovalStatus = 'pending' | 'allowed' | 'denied';
export type ApprovalStatus = StoredApprovalStatus | 'expired';

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  workerId: string;
  roomTaskId: string | null;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  status: StoredApprovalStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  expiresAt: number;
  createdAt: number;
}

export interface ApprovalView extends Omit<ApprovalRecord, 'status' | 'tenantId'> {
  status: ApprovalStatus;
}

/** Expiry is computed when read, so nothing has to sweep rows; an expired request reads as a denial. */
export function approvalView(r: ApprovalRecord, now: number): ApprovalView {
  const { tenantId: _tenant, ...rest } = r;
  return { ...rest, status: r.status === 'pending' && now >= r.expiresAt ? 'expired' : r.status };
}

export interface ApprovalStore {
  create(r: ApprovalRecord): Promise<void>;
  get(tenantId: string, id: string): Promise<ApprovalRecord | null>;
  /** Newest first, at most 200. */
  list(tenantId: string): Promise<ApprovalRecord[]>;
  countPending(workerId: string, now: number): Promise<number>;
  /** Only a pending, unexpired request can be decided. Returns null when it was not (already decided, expired, unknown). */
  decide(tenantId: string, id: string, status: 'allowed' | 'denied', by: string, reason: string | null, at: number): Promise<ApprovalRecord | null>;
}

export class MemoryApprovalStore implements ApprovalStore {
  private readonly rows = new Map<string, ApprovalRecord>();

  async create(r: ApprovalRecord): Promise<void> { this.rows.set(r.id, structuredClone(r)); }

  async get(tenantId: string, id: string): Promise<ApprovalRecord | null> {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? structuredClone(r) : null;
  }

  async list(tenantId: string): Promise<ApprovalRecord[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId)
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 200).map((r) => structuredClone(r));
  }

  async countPending(workerId: string, now: number): Promise<number> {
    return [...this.rows.values()].filter((r) => r.workerId === workerId && r.status === 'pending' && r.expiresAt > now).length;
  }

  async decide(tenantId: string, id: string, status: 'allowed' | 'denied', by: string, reason: string | null, at: number): Promise<ApprovalRecord | null> {
    const r = this.rows.get(id);
    if (!r || r.tenantId !== tenantId || r.status !== 'pending' || at >= r.expiresAt) return null;
    Object.assign(r, { status, decidedBy: by, reason, decidedAt: at });
    // The PostgreSQL trigger (migration 0016) does this for the database store.
    workSignal.notify(workerKey(r.workerId));
    return structuredClone(r);
  }
}

const COLUMNS = 'id, tenant_id, worker_id, room_task_id, tool, input, summary, status, reason, decided_by, decided_at, expires_at, created_at';
const ts = (ms: number) => new Date(ms).toISOString();

interface Row {
  id: string; tenant_id: string; worker_id: string; room_task_id: string | null; tool: string; input: Record<string, unknown>;
  summary: string; status: StoredApprovalStatus; reason: string | null; decided_by: string | null;
  decided_at: Date | string | null; expires_at: Date | string; created_at: Date | string;
}

const ms = (v: Date | string) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

function fromRow(r: Row): ApprovalRecord {
  return {
    id: r.id, tenantId: r.tenant_id, workerId: r.worker_id, roomTaskId: r.room_task_id, tool: r.tool, input: r.input ?? {},
    summary: r.summary, status: r.status, reason: r.reason, decidedBy: r.decided_by,
    decidedAt: r.decided_at === null ? null : ms(r.decided_at), expiresAt: ms(r.expires_at), createdAt: ms(r.created_at),
  };
}

export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly db: Queryable) {}

  async create(r: ApprovalRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO worker_approvals (id, tenant_id, worker_id, room_task_id, tool, input, summary, status, expires_at, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, 'pending', $8::timestamptz, $9::timestamptz)`,
      [r.id, r.tenantId, r.workerId, r.roomTaskId, r.tool, JSON.stringify(r.input), r.summary, ts(r.expiresAt), ts(r.createdAt)],
    );
  }

  async get(tenantId: string, id: string): Promise<ApprovalRecord | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM worker_approvals WHERE id = $2::uuid AND tenant_id = $1::uuid`, [tenantId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async list(tenantId: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM worker_approvals WHERE tenant_id = $1::uuid ORDER BY created_at DESC, id LIMIT 200`, [tenantId]);
    return rows.map(fromRow);
  }

  async countPending(workerId: string, now: number): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM worker_approvals WHERE worker_id = $1::uuid AND status = 'pending' AND expires_at > $2::timestamptz`,
      [workerId, ts(now)],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async decide(tenantId: string, id: string, status: 'allowed' | 'denied', by: string, reason: string | null, at: number): Promise<ApprovalRecord | null> {
    const { rows } = await this.db.query<Row>(
      `UPDATE worker_approvals
       SET status = $3, decided_by = $4, reason = $5, decided_at = $6::timestamptz
       WHERE id = $2::uuid AND tenant_id = $1::uuid AND status = 'pending' AND expires_at > $6::timestamptz
       RETURNING ${COLUMNS}`,
      [tenantId, id, status, by, reason, ts(at)],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTERS = new Set<ApprovalStatus | 'all'>(['pending', 'allowed', 'denied', 'expired', 'all']);

export interface ApprovalDeps {
  /** Always-allow: remember the allowed tool for the employee and computer that asked. */
  remember?: (tenantId: string, record: ApprovalRecord) => Promise<void>;
  store: () => ApprovalStore;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Rescan period for a held wait; a decision normally wakes it at once through the signal. */
  stepMs: () => number;
}

/** Command-room side, inside the signed-in admin/owner /api/v1/workers plugin. */
export function registerApprovalAdminRoutes(app: FastifyInstance, deps: ApprovalDeps): void {
  app.get('/approvals', async (req, reply) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const filter = (req.query as { status?: string }).status ?? 'pending';
    if (!FILTERS.has(filter as ApprovalStatus)) return reply.code(400).send({ error: 'bad_status' });
    const now = deps.now();
    const views = (await deps.store().list(tenantId)).map((r) => approvalView(r, now));
    return { approvals: filter === 'all' ? views : views.filter((v) => v.status === filter) };
  });

  app.post('/approvals/:id/decide', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { decision?: unknown; reason?: unknown; remember?: unknown };
    if (body.decision !== 'allow' && body.decision !== 'deny') return reply.code(400).send({ error: 'bad_decision' });
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 500)) return reply.code(400).send({ error: 'bad_reason' });
    const store = deps.store();
    const now = deps.now();
    const decided = await store.decide(user.tenantId, id, body.decision === 'allow' ? 'allowed' : 'denied', user.userId, (body.reason as string | undefined) || null, now);
    if (decided) {
      if (body.decision === 'allow' && body.remember === true) await deps.remember?.(user.tenantId, decided).catch(() => undefined);
      return { approval: approvalView(decided, now) };
    }
    const current = await store.get(user.tenantId, id);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    // Already decided, or expired: the first outcome stands.
    return reply.code(409).send({ error: 'already_decided', approval: approvalView(current, now) });
  });
}

function badInput(body: { tool?: unknown; input?: unknown; summary?: unknown; roomTaskId?: unknown }): string | null {
  if (typeof body.tool !== 'string' || !body.tool.trim() || body.tool.length > 128) return 'bad_tool';
  if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input) || JSON.stringify(body.input).length > INPUT_LIMIT) return 'bad_input';
  if (typeof body.summary !== 'string' || !body.summary.trim() || body.summary.length > 2_000) return 'bad_summary';
  if (body.roomTaskId !== undefined && body.roomTaskId !== null && (typeof body.roomTaskId !== 'string' || !body.roomTaskId || body.roomTaskId.length > 128)) return 'bad_room_task';
  return null;
}

/** Link side, inside the worker-token /api/v1/worker-link plugin (req.worker is set by its preHandler). */
export function registerApprovalLinkRoutes(app: FastifyInstance, deps: ApprovalDeps): void {
  app.post('/approvals', async (req: FastifyRequest, reply: FastifyReply) => {
    const worker = req.worker as WorkerRecord;
    const body = (req.body ?? {}) as { tool?: unknown; input?: unknown; summary?: unknown; roomTaskId?: unknown };
    const invalid = badInput(body);
    if (invalid) return reply.code(400).send({ error: invalid });
    const now = deps.now();
    const store = deps.store();
    if ((await store.countPending(worker.id, now)) >= MAX_PENDING_PER_WORKER) return reply.code(429).send({ error: 'too_many_pending' });
    const record: ApprovalRecord = {
      id: randomUUID(), tenantId: worker.tenantId, workerId: worker.id, roomTaskId: typeof body.roomTaskId === 'string' ? roomTaskOfRun(body.roomTaskId) : null,
      tool: (body.tool as string).trim(), input: body.input as Record<string, unknown>, summary: (body.summary as string).trim(),
      status: 'pending', reason: null, decidedBy: null, decidedAt: null, expiresAt: now + APPROVAL_TTL_MS, createdAt: now,
    };
    await store.create(record);
    return reply.code(201).send({ approval: { id: record.id, status: 'pending', expiresAt: record.expiresAt } });
  });

  app.post('/approvals/:id/wait', async (req, reply) => {
    const worker = req.worker as WorkerRecord;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { waitMs?: unknown };
    const waitMs = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? Math.min(Math.max(0, body.waitMs), APPROVAL_WAIT_MAX_MS) : APPROVAL_WAIT_MAX_MS;
    let closed = false;
    req.raw.once('close', () => { closed = true; });
    const start = deps.now();
    for (;;) {
      const woken = workSignal.waitFor([workerKey(worker.id)]); // registered before the read, as in /poll
      try {
        const now = deps.now();
        const r = await deps.store().get(worker.tenantId, id);
        // Only the worker that filed the request may wait on it; anyone else sees nothing.
        if (!r || r.workerId !== worker.id) return reply.code(404).send({ error: 'not_found' });
        const view = approvalView(r, now);
        const { id: vid, status, reason, decidedBy, decidedAt, expiresAt } = view;
        if (status !== 'pending' || closed || now - start >= waitMs) return { approval: { id: vid, status, reason, decidedBy, decidedAt, expiresAt } };
        const step = Math.min(deps.stepMs(), waitMs - (now - start), Math.max(1, r.expiresAt - now));
        await Promise.race([deps.sleep(step), woken.promise]);
      } finally {
        woken.cancel();
      }
    }
  });
}
