import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { flushRoom, roomState } from '../room/index.js';
import type { RoomTask } from '../room/room.js';
import { runtimeState } from '../runtime/index.js';
import { claimTask, deadLetterTask, heartbeatTask, releaseTask, succeedTask, type Queryable } from '../runtime/pg-queue.js';
import { PgWorkerRegistry } from './pg-registry.js';
import {
  authenticateWorker,
  cleanCapabilities,
  EVENTS_PAGE,
  MemoryWorkerRegistry,
  WORKER_EVENT_KINDS,
  type WorkerEventKind,
  registerWorker,
  toView,
  WORKER_KINDS,
  workerStatus,
  type WorkerKind,
  type WorkerRecord,
  type WorkerRegistry,
} from './registry.js';

export * from './registry.js';
export { PgWorkerRegistry } from './pg-registry.js';

/** Under common proxy idle timeouts (Container Apps ingress, corporate proxies), so a held poll is not cut mid-wait. */
export const LONG_POLL_MAX_MS = 25_000;
const POLL_STEP_MS = 1_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const workersState: {
  registry: WorkerRegistry;
  db: Queryable | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollStepMs: number;
} = {
  registry: new MemoryWorkerRegistry(),
  db: null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pollStepMs: POLL_STEP_MS,
};

export function bindWorkersDb(db: Queryable | null): void {
  workersState.db = db;
  workersState.registry = db ? new PgWorkerRegistry(db) : new MemoryWorkerRegistry();
}

export function resetWorkers(): void {
  workersState.registry = new MemoryWorkerRegistry();
  workersState.db = null;
  workersState.now = () => Date.now();
  workersState.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  workersState.pollStepMs = POLL_STEP_MS;
}

/** Granting a project/employee binding is an administrator action. */
export async function queueRoomDispatch(task: RoomTask): Promise<void> {
  if (!task.projectId || task.approval !== 'none' || !['assigned', 'waiting'].includes(task.status) || task.hold) return;
  const workerList = await workersState.registry.list(task.tenantId);
  const targets = workerList.filter((worker) => worker.revokedAt === null && worker.capabilities.roomAssignments?.some(
    (assignment) => assignment.employeeId === task.employeeId && assignment.projectId === task.projectId,
  ));
  if (targets.length !== 1) return;
  await workersState.registry.appendEvent(task.tenantId, targets[0]!.id, 'wake', {
    roomTaskId: task.id,
    projectId: task.projectId,
    prompt: task.title,
  }, 'super-agent', workersState.now(), task.id);
}

/** Admin side, mounted under the signed-in /api/v1/workers prefix (admin/owner only). */
export const workersModule: FastifyPluginAsync = async (app) => {
  app.post('/', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    if (workersState.db && !UUID_RE.test(user.tenantId)) return reply.code(400).send({ error: 'tenant_not_uuid' });
    const body = (req.body ?? {}) as { name?: unknown; kind?: unknown; capabilities?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return reply.code(400).send({ error: 'bad_name' });
    if (!WORKER_KINDS.includes(body.kind as WorkerKind)) return reply.code(400).send({ error: 'bad_kind' });
    const now = workersState.now();
    const { worker, token } = await registerWorker(
      workersState.registry,
      { tenantId: user.tenantId, name, kind: body.kind as WorkerKind, capabilities: cleanCapabilities(body.capabilities), createdBy: user.userId },
      now,
    );
    // The token is shown once. It is not stored and cannot be read back.
    return reply.code(201).send({ worker: toView(worker, now), token });
  });

  app.get('/', async (req, reply) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const now = workersState.now();
    return { workers: (await workersState.registry.list(tenantId)).map((w) => toView(w, now)) };
  });

  /** Address an instruction to one worker. It is delivered on the worker's next poll, however long it was away. */
  app.post('/:id/events', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { kind?: unknown; payload?: unknown };
    if (!WORKER_EVENT_KINDS.includes(body.kind as WorkerEventKind)) return reply.code(400).send({ error: 'bad_kind' });
    const payload = body.payload === undefined ? {} : body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16_384) {
      return reply.code(400).send({ error: 'bad_payload' });
    }
    const event = await workersState.registry.appendEvent(user.tenantId, id, body.kind as WorkerEventKind, payload as Record<string, unknown>, user.userId, workersState.now());
    if (!event) return reply.code(404).send({ error: 'not_found' });
    return reply.code(201).send({ event });
  });

  app.post('/:id/revoke', async (req, reply) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    if (!(await workersState.registry.revoke(tenantId, id, workersState.now()))) return reply.code(404).send({ error: 'not_found' });
    return { id, status: 'revoked' };
  });
};

declare module 'fastify' {
  interface FastifyRequest {
    worker?: WorkerRecord;
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * The claim attempt the caller holds (T-02 fencing). Required on every task route: a late call from an earlier
 * attempt of the same worker must not renew or report the current one.
 */
function leaseAttempt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

/** The in-process queue does not fence by attempt itself; check it here so both stores behave the same. */
function memoryAttemptMatches(taskId: string, attempt: number): boolean {
  return runtimeState.queue.get(taskId)?.attempt === attempt;
}

async function claimFor(worker: WorkerRecord, now: number) {
  const kinds = worker.capabilities.kinds ?? [];
  if (!kinds.length) return null; // no granted kinds: nothing to claim, but the poll still keeps it present
  if (runtimeState.db) return claimTask(runtimeState.db, worker.id, LEASE_MS, MAX_ATTEMPTS, worker.tenantId, kinds);
  return runtimeState.queue.claim(worker.id, now, kinds, worker.tenantId);
}

/**
 * Worker side: the outbound-only channel a hosted replica or a SuperAgent Link uses.
 * Mounted outside user sign-in; every route needs a worker bearer token. The lease owner is always the
 * worker's own id from the token, never a value in the body, so one worker cannot report for another.
 */
export const workerLinkModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    const worker = await authenticateWorker(workersState.registry, bearer(req));
    if (!worker) return reply.code(401).send({ error: 'bad_worker_token' });
    req.worker = worker;
  });

  app.post('/heartbeat', async (req, reply) => {
    const body = (req.body ?? {}) as { busy?: unknown; waitingAuthReason?: unknown };
    const now = workersState.now();
    const input = {
      ...(typeof body.busy === 'boolean' ? { busy: body.busy } : {}),
      ...(body.waitingAuthReason === null || typeof body.waitingAuthReason === 'string'
        ? { waitingAuthReason: (body.waitingAuthReason as string | null)?.slice(0, 500) ?? null }
        : {}),
    };
    if (!(await workersState.registry.heartbeat(req.worker!.id, now, input))) return reply.code(401).send({ error: 'bad_worker_token' });
    const fresh = await workersState.registry.get(req.worker!.tenantId, req.worker!.id);
    return { status: fresh ? workerStatus(fresh, now) : 'revoked', at: now };
  });

  /**
   * Long poll. Two durable backlogs, both survive the worker being offline:
   *   - events addressed to this worker, after the cursor `since` it sends (0 = from the beginning);
   *   - queue work of its granted kinds, claimed oldest first.
   * Returns as soon as either has something, or { task: null, events: [] } after waitMs. The returned `cursor` is
   * what to send as `since` next time; a worker that was away resends its last cursor and loses nothing.
   * Each poll also counts as a heartbeat.
   */
  app.post('/poll', async (req, reply) => {
    const worker = req.worker!;
    const body = (req.body ?? {}) as { waitMs?: unknown; since?: unknown };
    const waitMs = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? Math.min(Math.max(0, body.waitMs), LONG_POLL_MAX_MS) : LONG_POLL_MAX_MS;
    if (body.since !== undefined && !(typeof body.since === 'number' && Number.isSafeInteger(body.since) && body.since >= 0)) {
      return reply.code(400).send({ error: 'bad_cursor' });
    }
    const since = (body.since as number | undefined) ?? 0;
    let closed = false;
    req.raw.once('close', () => { closed = true; });
    const start = workersState.now();
    for (;;) {
      const now = workersState.now();
      if (!(await workersState.registry.heartbeat(worker.id, now, {}))) return reply.code(401).send({ error: 'bad_worker_token' });
      const events = await workersState.registry.eventsAfter(worker.id, since, EVENTS_PAGE);
      const task = await claimFor(worker, now);
      const cursor = events.length ? events[events.length - 1]!.seq : since;
      if (task || events.length) return { task, events, cursor, ...(task ? { leaseMs: LEASE_MS } : {}) };
      if (closed || now - start >= waitMs) return { task: null, events, cursor, retryAfterMs: 0 };
      await workersState.sleep(Math.min(workersState.pollStepMs, waitMs - (now - start)));
    }
  });

  /**
   * Task routes re-check the worker before touching the lease: a token revoked after the preHandler read it
   * must not renew or report. busy is updated only after the lease operation succeeded, so a stale call
   * cannot clear the status of the run that currently holds the lease.
   */
  async function stillValid(worker: WorkerRecord, now: number): Promise<boolean> {
    return workersState.registry.heartbeat(worker.id, now, {});
  }

  app.post('/room-tasks/:id/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== 'report' && action !== 'progress') return reply.code(404).send({ error: 'not_found' });
    const worker = req.worker!;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string' || !body.trim() || body.length > 65_536) {
      return reply.code(400).send({ error: 'bad_report' });
    }
    if (!(await stillValid(worker, workersState.now()))) return reply.code(401).send({ error: 'bad_worker_token' });
    if (!(await workersState.registry.hasRoomDispatch(worker.tenantId, worker.id, id))) {
      return reply.code(404).send({ error: 'task_not_found' });
    }
    const digest = createHash('sha256').update(body).digest('hex');
    let message;
    try {
      message = roomState.current.updateFromWorker(id, worker.tenantId, body, 'worker-' + action + ':' + id + ':' + digest, action === 'report');
    } catch (error) {
      const reason = (error as Error).message;
      return reply.code(reason === 'task_not_found' ? 404 : 409).send({ error: reason });
    }
    await flushRoom();
    return message;
  });

  app.post('/tasks/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const attempt = leaseAttempt((req.body as { attempt?: unknown } | undefined)?.attempt);
    if (attempt === null) return reply.code(400).send({ error: 'bad_attempt' });
    const worker = req.worker!;
    const now = workersState.now();
    if (!(await stillValid(worker, now))) return reply.code(401).send({ error: 'bad_worker_token' });
    const ok = runtimeState.db
      ? await heartbeatTask(runtimeState.db, id, worker.id, attempt, LEASE_MS)
      : memoryAttemptMatches(id, attempt) && runtimeState.queue.heartbeat(id, worker.id, now);
    if (ok) await workersState.registry.heartbeat(worker.id, now, { busy: true });
    return { ok };
  });

  app.post('/tasks/:id/succeed', async (req, reply) => {
    const { id } = req.params as { id: string };
    const attempt = leaseAttempt((req.body as { attempt?: unknown } | undefined)?.attempt);
    if (attempt === null) return reply.code(400).send({ error: 'bad_attempt' });
    const worker = req.worker!;
    const now = workersState.now();
    if (!(await stillValid(worker, now))) return reply.code(401).send({ error: 'bad_worker_token' });
    if (runtimeState.db) {
      if (!(await succeedTask(runtimeState.db, id, worker.id, attempt))) return reply.code(409).send({ error: 'lease_lost' });
    } else {
      if (!memoryAttemptMatches(id, attempt)) return reply.code(409).send({ error: 'lease_lost' });
      try {
        runtimeState.queue.succeed(id, worker.id, now);
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    }
    await workersState.registry.heartbeat(worker.id, now, { busy: false });
    return { id, status: 'reported' };
  });

  app.post('/tasks/:id/fail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: unknown; attempt?: unknown };
    const reason = typeof body.reason === 'string' && body.reason ? body.reason.slice(0, 500) : null;
    if (!reason) return reply.code(400).send({ error: 'missing_reason' });
    const attempt = leaseAttempt(body.attempt);
    if (attempt === null) return reply.code(400).send({ error: 'bad_attempt' });
    const worker = req.worker!;
    const now = workersState.now();
    if (!(await stillValid(worker, now))) return reply.code(401).send({ error: 'bad_worker_token' });
    let deadLettered: boolean;
    if (runtimeState.db) {
      if (await releaseTask(runtimeState.db, id, worker.id, attempt, MAX_ATTEMPTS)) deadLettered = false;
      else if (await deadLetterTask(runtimeState.db, id, worker.id, attempt, MAX_ATTEMPTS, reason)) deadLettered = true;
      else return reply.code(409).send({ error: 'lease_lost' });
    } else {
      if (!memoryAttemptMatches(id, attempt)) return reply.code(409).send({ error: 'lease_lost' });
      try {
        deadLettered = runtimeState.queue.fail(id, worker.id, now, reason).deadLettered;
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    }
    await workersState.registry.heartbeat(worker.id, now, { busy: false });
    return { deadLettered };
  });
};
