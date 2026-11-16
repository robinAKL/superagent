import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import { bindRuntimeDb, resetRuntime, runtimeState } from '../runtime/index.js';
import type { Queryable } from '../runtime/pg-queue.js';
import { CLAIM_TASK_KIND_SQL, DEAD_LETTER_SQL, HEARTBEAT_TASK_SQL, RELEASE_TASK_SQL, SUCCEED_TASK_SQL } from '../runtime/sql.js';
import { registerWorker, resetWorkers, workerLinkModule, workersState } from './index.js';

/** T-04: the worker channel forwards the claim attempt (T-02 fencing) and refuses calls from an older attempt. */

const TENANT = '11111111-1111-4111-8111-111111111111';
let clock = 1_000_000;

async function linkApp(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(workerLinkModule, { prefix: '/api/v1/worker-link' });
  return a;
}

async function newWorker() {
  return registerWorker(workersState.registry, { tenantId: TENANT, name: 'w', kind: 'link', capabilities: { kinds: ['knowledge.parse'] }, createdBy: 'admin' }, clock);
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (a: FastifyInstance, token: string, id: string, path: string, payload: Record<string, unknown>) =>
  a.inject({ method: 'POST', url: `/api/v1/worker-link/tasks/${id}/${path}`, headers: auth(token), payload });

beforeEach(() => {
  resetRuntime();
  resetWorkers();
  clock = 1_000_000;
  workersState.now = () => clock;
  workersState.sleep = async (ms) => { clock += ms; };
});

/**
 * Stand-in for Postgres that applies the T-02 rules for one row: the current attempt is 2 (the same worker
 * claimed it again after attempt 1's lease ran out). Every statement is recorded with its parameters.
 */
function fakeDb(workerId: () => string) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const row = { id: 'task-1', attempt: 2, lease_owner: '', kind: 'knowledge.parse', tenant_id: TENANT, payload: { tenantId: TENANT } };
  const holds = (params: readonly unknown[]) => params[0] === row.id && params[1] === workerId() && params[2] === row.attempt;
  const db: Queryable = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      if (sql === CLAIM_TASK_KIND_SQL) return { rows: [{ ...row, lease_owner: params[0] }] as T[] };
      if ([HEARTBEAT_TASK_SQL, SUCCEED_TASK_SQL, RELEASE_TASK_SQL, DEAD_LETTER_SQL].includes(sql)) {
        return { rows: (holds(params) ? [{ id: row.id, task_id: row.id }] : []) as T[] };
      }
      throw new Error(`unexpected sql: ${sql.slice(0, 40)}`);
    },
  };
  return { db, calls };
}

it('PG: poll returns the attempt; the attempt the worker sends is the one the lease statements check', async () => {
  const a = await linkApp();
  const { worker, token } = await newWorker();
  const { db, calls } = fakeDb(() => worker.id);
  bindRuntimeDb(db);

  const task = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } })).json().task;
  expect(task).toMatchObject({ id: 'task-1', attempt: 2, lease_owner: worker.id });

  expect((await call(a, token, 'task-1', 'heartbeat', { attempt: 2 })).json()).toEqual({ ok: true });
  const hb = calls.find((c) => c.sql === HEARTBEAT_TASK_SQL)!;
  expect(hb.params.slice(0, 3)).toEqual(['task-1', worker.id, 2]);
  expect((await call(a, token, 'task-1', 'succeed', { attempt: 2 })).json()).toEqual({ id: 'task-1', status: 'reported' });
  expect(calls.find((c) => c.sql === SUCCEED_TASK_SQL)!.params).toEqual(['task-1', worker.id, 2]);
});

it('PG: a late call from attempt 1 is refused and does not change busy for attempt 2', async () => {
  const a = await linkApp();
  const { worker, token } = await newWorker();
  bindRuntimeDb(fakeDb(() => worker.id).db);
  await call(a, token, 'task-1', 'heartbeat', { attempt: 2 }); // attempt 2 is running: live
  const status = async () => (await workersState.registry.get(TENANT, worker.id))!.busy;
  expect(await status()).toBe(true);

  expect((await call(a, token, 'task-1', 'heartbeat', { attempt: 1 })).json()).toEqual({ ok: false });
  expect((await call(a, token, 'task-1', 'succeed', { attempt: 1 })).statusCode).toBe(409);
  const fail = await call(a, token, 'task-1', 'fail', { attempt: 1, reason: 'late' });
  expect(fail.statusCode).toBe(409);
  expect(await status()).toBe(true);
});

it('PG: the release / dead-letter statements get the attempt too', async () => {
  const a = await linkApp();
  const { worker, token } = await newWorker();
  const { db, calls } = fakeDb(() => worker.id);
  bindRuntimeDb(db);
  expect((await call(a, token, 'task-1', 'fail', { attempt: 2, reason: 'boom' })).json()).toEqual({ deadLettered: false });
  expect(calls.find((c) => c.sql === RELEASE_TASK_SQL)!.params).toEqual(['task-1', worker.id, 2, 3]);
  await call(a, token, 'task-1', 'fail', { attempt: 1, reason: 'late' });
  expect(calls.filter((c) => c.sql === DEAD_LETTER_SQL).at(-1)!.params).toEqual(['task-1', worker.id, 1, 3, 'late']);
});

it('missing or malformed attempt is a 400 on every task route, before anything is touched', async () => {
  const a = await linkApp();
  const { worker, token } = await newWorker();
  const { db, calls } = fakeDb(() => worker.id);
  bindRuntimeDb(db);
  for (const attempt of [undefined, 0, -1, 1.5, '2', 2 ** 31]) {
    for (const [path, extra] of [['heartbeat', {}], ['succeed', {}], ['fail', { reason: 'x' }]] as const) {
      const res = await call(a, token, 'task-1', path, attempt === undefined ? { ...extra } : { ...extra, attempt });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_attempt');
    }
  }
  expect(calls).toHaveLength(0);
});

it('memory queue: the same fencing — after a re-claim, attempt 1 is refused and attempt 2 works', async () => {
  const a = await linkApp();
  const { token } = await newWorker();
  runtimeState.queue.enqueue('knowledge.parse', { tenantId: TENANT, connectionId: 'c', itemId: 'i', runId: 'r' });
  const first = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } })).json().task;
  expect(first.attempt).toBe(1);
  clock += 61_000; // lease (60s) runs out; the same worker claims it again
  const again = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: auth(token), payload: { waitMs: 0 } })).json().task;
  expect(again).toMatchObject({ id: first.id, attempt: 2 });

  expect((await call(a, token, first.id, 'heartbeat', { attempt: 1 })).json()).toEqual({ ok: false });
  expect((await call(a, token, first.id, 'succeed', { attempt: 1 })).statusCode).toBe(409);
  expect((await call(a, token, first.id, 'fail', { attempt: 1, reason: 'late' })).statusCode).toBe(409);
  expect((await call(a, token, first.id, 'heartbeat', { attempt: 2 })).json()).toEqual({ ok: true });
  expect((await call(a, token, first.id, 'succeed', { attempt: 2 })).json().status).toBe('reported');
});
