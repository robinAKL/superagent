import { EventEmitter } from 'node:events';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetRuntime } from '../runtime/index.js';
import { registerWorker, resetWorkers, workerLinkModule, workersState } from './index.js';
import { MemoryWorkerRegistry } from './registry.js';
import { startPgListener, tenantKey, WORK_CHANNEL, WORKER_EVENT_CHANNEL, WorkSignal, workerKey, workSignal, type ListenClient } from './signal.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

async function linkApp(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(workerLinkModule, { prefix: '/api/v1/worker-link' });
  return a;
}

async function newWorker() {
  return registerWorker(workersState.registry, { tenantId: TENANT, name: 'w', kind: 'link', createdBy: 'admin' }, Date.now());
}

const poll = (a: FastifyInstance, token: string, waitMs: number) =>
  a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: { authorization: `Bearer ${token}` }, payload: { since: 0, waitMs } });

beforeEach(() => { resetRuntime(); resetWorkers(); });
afterEach(() => { resetWorkers(); });

it('with LISTEN up, a notification wakes a held poll within one step, long before the rescan', async () => {
  const a = await linkApp();
  const { worker, token } = await newWorker();
  workSignal.listening = true;
  workersState.notifiedScanMs = 10_000; // the rescan would take 10s
  const started = Date.now();
  const pending = poll(a, token, 20_000);
  setTimeout(() => { void workersState.registry.appendEvent(TENANT, worker.id, 'wake', { n: 1 }, 'super-agent', Date.now()); }, 100);
  const res = (await pending).json();
  const elapsed = Date.now() - started;
  expect(res.events).toHaveLength(1);
  expect(elapsed).toBeLessThan(1_500);
});

it('when the notification is lost, the rescan still returns the work within one scan period', async () => {
  const a = await linkApp();
  // A registry that does NOT signal: the event lands silently, as if the NOTIFY was dropped.
  workersState.registry = new MemoryWorkerRegistry();
  const { worker, token } = await newWorker();
  workSignal.listening = true;
  workersState.notifiedScanMs = 400;
  const started = Date.now();
  const pending = poll(a, token, 20_000);
  setTimeout(() => { void workersState.registry.appendEvent(TENANT, worker.id, 'wake', {}, 'super-agent', Date.now()); }, 50);
  const res = (await pending).json();
  const elapsed = Date.now() - started;
  expect(res.events).toHaveLength(1);
  expect(elapsed).toBeGreaterThanOrEqual(350); // it was not woken early: only the rescan found it
  expect(elapsed).toBeLessThan(1_500);
});

it('a notification for another tenant or worker does not wake the poll', async () => {
  const a = await linkApp();
  const { token } = await newWorker();
  workSignal.listening = true;
  workersState.notifiedScanMs = 10_000;
  const started = Date.now();
  const pending = poll(a, token, 600);
  setTimeout(() => {
    workSignal.notify(tenantKey('22222222-2222-4222-8222-222222222222'));
    workSignal.notify(workerKey('someone-else'));
  }, 50);
  expect((await pending).json()).toMatchObject({ task: null, events: [] });
  expect(Date.now() - started).toBeGreaterThanOrEqual(550); // held for its full wait
});

it('routes notifications by channel, ignores unknown channels and empty payloads', async () => {
  const s = new WorkSignal();
  const tenant = s.waitFor([tenantKey('t1')]);
  const worker = s.waitFor([workerKey('w1')]);
  let woke = '';
  void tenant.promise.then(() => { woke += 'T'; });
  void worker.promise.then(() => { woke += 'W'; });
  s.onNotification('other', 't1');
  s.onNotification(WORK_CHANNEL, undefined);
  await Promise.resolve();
  expect(woke).toBe('');
  s.onNotification(WORK_CHANNEL, 't1');
  s.onNotification(WORKER_EVENT_CHANNEL, 'w1');
  await new Promise((r) => setTimeout(r, 0));
  expect(woke).toBe('TW');
});

class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  released = 0;
  async query(sql: string) { this.queries.push(sql); }
  release() { this.released++; }
}

it('listener: LISTENs on both channels, delivers notifications, and reconnects after the connection drops', async () => {
  const s = new WorkSignal();
  const clients: FakeClient[] = [];
  const delays: number[] = [];
  const listener = startPgListener(async () => { const c = new FakeClient(); clients.push(c); return c; }, {
    signal: s, log: () => undefined, minMs: 10, maxMs: 40,
    delay: async (ms) => { delays.push(ms); await new Promise((r) => setTimeout(r, 1)); },
  });
  await new Promise((r) => setTimeout(r, 5));
  expect(clients).toHaveLength(1);
  expect(clients[0]!.queries).toEqual([`LISTEN ${WORK_CHANNEL}`, `LISTEN ${WORKER_EVENT_CHANNEL}`]);
  expect(s.listening).toBe(true);

  const w = s.waitFor([workerKey('w1')]);
  clients[0]!.emit('notification', { channel: WORKER_EVENT_CHANNEL, payload: 'w1' });
  await w.promise; // resolves, or the test times out

  // The connection drops: held polls are woken to rescan, listening turns off, and a new connection is made.
  const held = s.waitFor([tenantKey('t1')]);
  clients[0]!.emit('error', new Error('connection reset'));
  await held.promise;
  await new Promise((r) => setTimeout(r, 20));
  expect(clients[0]!.released).toBe(1);
  expect(clients).toHaveLength(2);
  expect(s.listening).toBe(true);
  expect(delays[0]).toBe(10);

  await listener.stop();
  expect(s.listening).toBe(false);
});

it('listener: a failing connect backs off (doubling, capped) and recovers', async () => {
  const s = new WorkSignal();
  let attempts = 0;
  const delays: number[] = [];
  const listener = startPgListener(async () => {
    attempts++;
    if (attempts <= 3) throw new Error('database unavailable');
    return new FakeClient();
  }, { signal: s, log: () => undefined, minMs: 10, maxMs: 25, delay: async (ms) => { delays.push(ms); } });
  for (let i = 0; i < 20 && !s.listening; i++) await new Promise((r) => setTimeout(r, 1));
  expect(attempts).toBe(4);
  expect(delays).toEqual([10, 20, 25]);
  expect(s.listening).toBe(true);
  await listener.stop();
});
