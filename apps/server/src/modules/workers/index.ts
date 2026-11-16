import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { runtimeState } from '../runtime/index.js';
import { claimTask, deadLetterTask, heartbeatTask, releaseTask, succeedTask, type Queryable } from '../runtime/pg-queue.js';
import { PgWorkerRegistry } from './pg-registry.js';
import {
  authenticateWorker,
  cleanCapabilities,
  MemoryWorkerRegistry,
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
   * Long poll. Returns a claimed task as soon as one is available, or { task: null } after waitMs.
   * The queue itself is the durable backlog: work enqueued while the worker was offline is still there and
   * comes back on the next poll, oldest first. Each poll also counts as a heartbeat.
   */
  app.post('/poll', async (req, reply) => {
    const worker = req.worker!;
    const body = (req.body ?? {}) as { waitMs?: unknown };
    const waitMs = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? Math.min(Math.max(0, body.waitMs), LONG_POLL_MAX_MS) : LONG_POLL_MAX_MS;
    let closed = false;
    req.raw.once('close', () => { closed = true; });
    const start = workersState.now();
    for (;;) {
      const now = workersState.now();
      if (!(await workersState.registry.heartbeat(worker.id, now, {}))) return reply.code(401).send({ error: 'bad_worker_token' });
      const task = await claimFor(worker, now);
      if (task) return { task, leaseMs: LEASE_MS };
      if (closed || now - start >= waitMs) return { task: null, retryAfterMs: 0 };
      await workersState.sleep(Math.min(workersState.pollStepMs, waitMs - (now - start)));
    }
  });

  app.post('/tasks/:id/heartbeat', async (req) => {
    const { id } = req.params as { id: string };
    const worker = req.worker!;
    const now = workersState.now();
    await workersState.registry.heartbeat(worker.id, now, { busy: true });
    if (runtimeState.db) return { ok: await heartbeatTask(runtimeState.db, id, worker.id, LEASE_MS) };
    return { ok: runtimeState.queue.heartbeat(id, worker.id, now) };
  });

  app.post('/tasks/:id/succeed', async (req, reply) => {
    const { id } = req.params as { id: string };
    const worker = req.worker!;
    const now = workersState.now();
    await workersState.registry.heartbeat(worker.id, now, { busy: false });
    if (runtimeState.db) {
      if (!(await succeedTask(runtimeState.db, id, worker.id))) return reply.code(409).send({ error: 'lease_lost' });
      return { id, status: 'reported' };
    }
    try {
      runtimeState.queue.succeed(id, worker.id, now);
      return { id, status: 'reported' };
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.post('/tasks/:id/fail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason ? body.reason.slice(0, 500) : null;
    if (!reason) return reply.code(400).send({ error: 'missing_reason' });
    const worker = req.worker!;
    const now = workersState.now();
    await workersState.registry.heartbeat(worker.id, now, { busy: false });
    if (runtimeState.db) {
      if (await releaseTask(runtimeState.db, id, worker.id, MAX_ATTEMPTS)) return { deadLettered: false };
      if (await deadLetterTask(runtimeState.db, id, worker.id, MAX_ATTEMPTS, reason)) return { deadLettered: true };
      return reply.code(409).send({ error: 'lease_lost' });
    }
    try {
      return { deadLettered: runtimeState.queue.fail(id, worker.id, now, reason).deadLettered };
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
};
