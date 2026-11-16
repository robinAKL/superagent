import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { Role } from '@superagent/shared';
import { buildApp } from '../../app.js';
import { resetRuntime, runtimeState } from '../runtime/index.js';
import { OFFLINE_AFTER_MS, resetWorkers, workerLinkModule, workersModule, workersState } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let clock = 1_000_000;

async function app(): Promise<FastifyInstance> {
  const a = Fastify();
  a.addHook('preHandler', async (req) => {
    const raw = typeof req.headers['x-test-user'] === 'string' ? req.headers['x-test-user'] : `admin-1|admin|${TENANT}`;
    const [userId, role, tenantId] = raw.split('|');
    req.user = { userId: userId!, roles: [role as Role], tenantId: tenantId!, projectScopes: [] };
  });
  await a.register(workersModule, { prefix: '/api/v1/workers' });
  await a.register(workerLinkModule, { prefix: '/api/v1/worker-link' });
  return a;
}

async function register(a: FastifyInstance, kinds = ['knowledge.parse'], user?: string) {
  const res = await a.inject({
    method: 'POST',
    url: '/api/v1/workers',
    headers: user ? { 'x-test-user': user } : {},
    payload: { name: 'Robin laptop', kind: 'link', capabilities: { kinds, agents: ['claude-code', 'codex'] } },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { worker: { id: string; status: string }; token: string };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function enqueue(itemId: string, tenantId = TENANT) {
  // A distinct runId per item: the queue folds open work with the same kind + tenant + operationId + runId.
  return runtimeState.queue.enqueue('knowledge.parse', { tenantId, connectionId: 'c1', itemId, runId: `run-${itemId}` });
}

beforeEach(() => {
  resetRuntime();
  resetWorkers();
  clock = 1_000_000;
  workersState.now = () => clock;
  // Simulated time: a poll "sleep" advances the clock instead of waiting.
  workersState.sleep = async (ms) => { clock += ms; };
});

it('registers a worker, returns the token once, and never exposes its hash', async () => {
  const a = await app();
  const { worker, token } = await register(a);
  expect(token).toMatch(/^saw_[A-Za-z0-9_-]{43}$/);
  expect(worker.status).toBe('offline'); // no heartbeat yet
  const list = await a.inject({ method: 'GET', url: '/api/v1/workers' });
  expect(JSON.stringify(list.json())).not.toContain('tokenHash');
  expect(JSON.stringify(list.json())).not.toContain(token);
  expect(list.json().workers).toHaveLength(1);
});

it('heartbeat makes a worker registered, busy makes it live, and a missed window turns it offline', async () => {
  const a = await app();
  const { worker, token } = await register(a);
  const status = async () => (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers.find((w: { id: string }) => w.id === worker.id).status;

  const hb = await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: auth(token), payload: {} });
  expect(hb.json().status).toBe('registered');
  await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: auth(token), payload: { busy: true } });
  expect(await status()).toBe('live');

  clock += OFFLINE_AFTER_MS; // exactly at the edge is still present
  expect(await status()).toBe('live');
  clock += 1;
  expect(await status()).toBe('offline');
});

it('waiting_auth is reported by the worker and cleared by it', async () => {
  const a = await app();
  const { token } = await register(a);
  const set = await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: auth(token), payload: { waitingAuthReason: 'codex login expired' } });
  expect(set.json().status).toBe('waiting_auth');
  const cleared = await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: auth(token), payload: { waitingAuthReason: null } });
  expect(cleared.json().status).toBe('registered');
});

it('long poll with nothing queued returns an empty result after the wait, and counts as a heartbeat', async () => {
  const a = await app();
  const { token } = await register(a);
  const started = clock;
  const res = await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 5_000 } });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ task: null, events: [], cursor: 0, retryAfterMs: 0 });
  expect(clock - started).toBe(5_000);
  const list = (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json();
  expect(list.workers[0].status).toBe('registered');
});

it('long poll wait is capped and waitMs 0 returns at once', async () => {
  const a = await app();
  const { token } = await register(a);
  let started = clock;
  await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 10 * 60_000 } });
  expect(clock - started).toBe(25_000);
  started = clock;
  await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } });
  expect(clock - started).toBe(0);
});

it('a held poll returns as soon as work is enqueued', async () => {
  const a = await app();
  const { token } = await register(a);
  let steps = 0;
  workersState.sleep = async (ms) => {
    clock += ms;
    if (++steps === 3) enqueue('item-late');
  };
  const res = await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 20_000 } });
  expect(res.json().task.payload.itemId).toBe('item-late');
  expect(steps).toBe(3);
});

it('after 30 minutes offline, every task queued meanwhile is claimed on reconnect, oldest first, none lost', async () => {
  const a = await app();
  const { worker, token } = await register(a);
  await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: auth(token), payload: {} });

  clock += 30 * 60_000;
  const offline = (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0];
  expect(offline.status).toBe('offline');
  for (const id of ['a', 'b', 'c', 'd', 'e']) enqueue(id);

  const seen: string[] = [];
  for (;;) {
    const res = await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } });
    const task = res.json().task;
    if (!task) break;
    expect(task.leaseOwner).toBe(worker.id);
    seen.push(task.payload.itemId);
    const done = await a.inject({ method: 'POST', url: `/api/v1/worker-link/tasks/${task.id}/succeed`, headers: auth(token), payload: {} });
    expect(done.json().status).toBe('reported');
  }
  expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0].status).toBe('registered');
});

const send = (a: FastifyInstance, id: string, kind: string, payload: unknown = {}, user?: string) =>
  a.inject({ method: 'POST', url: `/api/v1/workers/${id}/events`, headers: user ? { 'x-test-user': user } : {}, payload: { kind, payload } });
const poll = (a: FastifyInstance, token: string, since?: number, waitMs = 0) =>
  a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: since === undefined ? { waitMs } : { since, waitMs } });

it('events sent during 30 minutes offline are all delivered after the cursor on reconnect, in order', async () => {
  const a = await app();
  const { worker, token } = await register(a, []);
  const first = (await poll(a, token)).json();
  expect(first).toMatchObject({ events: [], cursor: 0 });

  clock += 30 * 60_000;
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0].status).toBe('offline');
  for (const n of [1, 2, 3]) expect((await send(a, worker.id, 'wake', { projectId: 'p1', n })).statusCode).toBe(201);

  const back = (await poll(a, token, first.cursor)).json();
  expect(back.events.map((e: { seq: number; payload: { n: number } }) => [e.seq, e.payload.n])).toEqual([[1, 1], [2, 2], [3, 3]]);
  expect(back.cursor).toBe(3);

  // Nothing new after the cursor: an empty, re-callable poll that keeps the cursor.
  expect((await poll(a, token, back.cursor)).json()).toMatchObject({ task: null, events: [], cursor: 3 });
  await send(a, worker.id, 'cancel', { runId: 'r9' });
  const next = (await poll(a, token, 3)).json();
  expect(next.events).toHaveLength(1);
  expect(next.events[0]).toMatchObject({ seq: 4, kind: 'cancel', payload: { runId: 'r9' }, createdBy: 'admin-1' });
  // A worker that lost its acknowledgement resends an older cursor and gets the rest again (at-least-once).
  expect((await poll(a, token, 1)).json().events.map((e: { seq: number }) => e.seq)).toEqual([2, 3, 4]);
});

it('a held poll returns as soon as an event is addressed to the worker', async () => {
  const a = await app();
  const { worker, token } = await register(a, []);
  let steps = 0;
  workersState.sleep = async (ms) => {
    clock += ms;
    if (++steps === 2) await workersState.registry.appendEvent(TENANT, worker.id, 'wake', { projectId: 'p1' }, 'super-agent', clock);
  };
  const res = (await poll(a, token, 0, 20_000)).json();
  expect(res.events[0]).toMatchObject({ seq: 1, kind: 'wake' });
  expect(res.cursor).toBe(1);
  expect(steps).toBe(2);
});

it('events: bad kind, bad payload, bad cursor, another tenant, and a revoked worker are refused', async () => {
  const a = await app();
  const { worker, token } = await register(a, []);
  expect((await send(a, worker.id, 'rm -rf')).statusCode).toBe(400);
  expect((await send(a, worker.id, 'message', ['x'])).statusCode).toBe(400);
  expect((await send(a, worker.id, 'message', { big: 'x'.repeat(20_000) })).statusCode).toBe(400);
  expect((await send(a, worker.id, 'wake', {}, `admin-2|admin|${OTHER}`)).statusCode).toBe(404);
  expect((await poll(a, token, -1)).statusCode).toBe(400);
  await a.inject({ method: 'POST', url: `/api/v1/workers/${worker.id}/revoke` });
  expect((await send(a, worker.id, 'wake')).statusCode).toBe(404);
});

it('a token revoked after the preHandler read it cannot renew, report, or fail a lease', async () => {
  const a = await app();
  const { worker, token } = await register(a);
  enqueue('race');
  const task = (await poll(a, token)).json().task;
  // The preHandler sees the pre-revoke record; the revoke lands before the handler runs.
  const stale = (await workersState.registry.get(TENANT, worker.id))!;
  await a.inject({ method: 'POST', url: `/api/v1/workers/${worker.id}/revoke` });
  workersState.registry.byTokenHash = async () => ({ ...stale });
  for (const [path, payload] of [['heartbeat', {}], ['succeed', {}], ['fail', { reason: 'x' }]] as const) {
    const res = await a.inject({ method: 'POST', url: `/api/v1/worker-link/tasks/${task.id}/${path}`, headers: auth(token), payload });
    expect(res.statusCode).toBe(401);
  }
  // The lease is untouched: it is still held and running.
  expect(runtimeState.queue.heartbeat(task.id, worker.id, clock)).toBe(true);
});

it('a stale task call does not clear busy for the run that holds the lease', async () => {
  const a = await app();
  const { token } = await register(a);
  enqueue('one');
  const task = (await poll(a, token)).json().task;
  expect((await a.inject({ method: 'POST', url: `/api/v1/worker-link/tasks/${task.id}/heartbeat`, headers: auth(token), payload: {} })).json().ok).toBe(true);
  const status = async () => (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0].status;
  expect(await status()).toBe('live');
  const stale = await a.inject({ method: 'POST', url: '/api/v1/worker-link/tasks/not-mine/succeed', headers: auth(token), payload: {} });
  expect(stale.statusCode).toBe(409);
  const staleFail = await a.inject({ method: 'POST', url: '/api/v1/worker-link/tasks/not-mine/fail', headers: auth(token), payload: { reason: 'x' } });
  expect(staleFail.statusCode).toBe(409);
  expect(await status()).toBe('live');
});

it('a worker only claims its own tenant and its granted kinds', async () => {
  const a = await app();
  const { token } = await register(a);
  const { token: none } = await register(a, []);
  enqueue('other-tenant', OTHER);
  runtimeState.queue.enqueue('analysis.run', { tenantId: TENANT, runId: 'r1' });
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } })).json().task).toBeNull();
  enqueue('mine');
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(none), payload: { waitMs: 0 } })).json().task).toBeNull();
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } })).json().task.payload.itemId).toBe('mine');
});

it('one worker cannot report another worker\'s lease', async () => {
  const a = await app();
  const { token: t1 } = await register(a);
  const { token: t2 } = await register(a);
  enqueue('x');
  const task = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(t1), payload: { waitMs: 0 } })).json().task;
  const stolen = await a.inject({ method: 'POST', url: `/api/v1/worker-link/tasks/${task.id}/succeed`, headers: auth(t2), payload: { workerId: task.leaseOwner } });
  expect(stolen.statusCode).toBe(409);
  const hb = await a.inject({ method: 'POST', url: `/api/v1/worker-link/tasks/${task.id}/heartbeat`, headers: auth(t2), payload: {} });
  expect(hb.json().ok).toBe(false);
});

it('a revoked token is refused everywhere; other tenants cannot see or revoke the worker', async () => {
  const a = await app();
  const { worker, token } = await register(a);
  const outsider = `admin-2|admin|${OTHER}`;
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers', headers: { 'x-test-user': outsider } })).json().workers).toHaveLength(0);
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${worker.id}/revoke`, headers: { 'x-test-user': outsider } })).statusCode).toBe(404);

  const revoked = await a.inject({ method: 'POST', url: `/api/v1/workers/${worker.id}/revoke` });
  expect(revoked.json().status).toBe('revoked');
  for (const url of ['/api/v1/worker-link/heartbeat', '/api/v1/worker-link/poll']) {
    const res = await a.inject({ method: 'POST', url, headers: auth(token), payload: { waitMs: 0 } });
    expect(res.statusCode).toBe(401);
  }
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0].status).toBe('revoked');
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${worker.id}/revoke` })).statusCode).toBe(404);
});

it('bad or missing tokens are refused', async () => {
  const a = await app();
  await register(a);
  for (const headers of [{}, { authorization: 'Bearer saw_nope' }, { authorization: 'Basic abc' }]) {
    const res = await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers, payload: {} });
    expect(res.statusCode).toBe(401);
  }
});

it('in the full app, the worker channel needs no user sign-in and the registry needs admin', async () => {
  const full = await buildApp();
  const link = await full.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', payload: {} });
  expect(link.statusCode).toBe(401);
  expect(link.json().error).toBe('bad_worker_token');
  const anon = await full.inject({ method: 'GET', url: '/api/v1/workers' });
  expect([401, 403]).toContain(anon.statusCode);
  await full.close();
});
