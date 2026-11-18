import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { Role } from '@superagent/shared';
import { buildApp } from '../../app.js';
import { resetRuntime, runtimeState } from '../runtime/index.js';
import { PAIR_TTL_MS } from './pairing.js';
import { resetWorkers, workerLinkModule, workerPairModule, workersModule, workersState } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let clock = 1_000_000;

async function app(): Promise<FastifyInstance> {
  const a = Fastify();
  a.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/v1/worker-link/pair/')) return;
    const raw = typeof req.headers['x-test-user'] === 'string' ? req.headers['x-test-user'] : `admin-1|admin|${TENANT}`;
    const [userId, role, tenantId] = raw.split('|');
    req.user = { userId: userId!, roles: [role as Role], tenantId: tenantId!, projectScopes: [] };
  });
  await a.register(workerPairModule, { prefix: '/api/v1/worker-link' });
  await a.register(workersModule, { prefix: '/api/v1/workers' });
  await a.register(workerLinkModule, { prefix: '/api/v1/worker-link' });
  return a;
}

beforeEach(() => {
  resetRuntime();
  resetWorkers();
  clock = 1_000_000;
  workersState.now = () => clock;
  workersState.sleep = async (ms) => { clock += ms; };
});

async function start(a: FastifyInstance, agents = ['codex']) {
  const res = await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/start', payload: { hostname: 'Robin-PC', agents } });
  expect(res.statusCode).toBe(201);
  return res.json() as { deviceCode: string; userCode: string; verifyPath: string };
}

it('pairs a Link without pasting a token, then the token works on worker-link', async () => {
  const a = await app();
  const started = await start(a);
  expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  expect(started.verifyPath).toBe(`/#connect?code=${encodeURIComponent(started.userCode)}`);
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } })).json().status).toBe('pending');

  const allow = await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow` });
  expect(allow.statusCode).toBe(200);
  expect(allow.json().worker.kind).toBe('link');
  expect(allow.json().worker.capabilities.agents).toEqual(['codex']);
  expect(JSON.stringify(allow.json())).not.toMatch(/saw_/);

  const polled = await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } });
  expect(polled.json().status).toBe('allowed');
  const token = polled.json().token as string;
  expect(token).toMatch(/^saw_/);
  const again = await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } });
  expect(again.json().token).toBeUndefined();

  const hb = await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: { capabilities: { agents: ['codex', 'claude-code'] } } });
  expect(hb.statusCode).toBe(200);
  expect(hb.json().capabilities.agents).toEqual(['codex', 'claude-code']);
});

it('denies a pairing and expires a pending code', async () => {
  const a = await app();
  const denied = await start(a);
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${denied.userCode}/deny` })).json().status).toBe('denied');
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: denied.deviceCode } })).json().status).toBe('denied');

  const expired = await start(a);
  clock += PAIR_TTL_MS;
  expect((await a.inject({ method: 'GET', url: `/api/v1/workers/pair/${expired.userCode}` })).json().status).toBe('expired');
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${expired.userCode}/allow` })).statusCode).toBe(410);
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: expired.deviceCode } })).json().status).toBe('expired');
});

it('isolates pairing across tenants and wakes a poll within 60s of revoke', async () => {
  const a = await app();
  const started = await start(a);
  await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow` });
  const token = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } })).json().token as string;
  const workerId = (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0].id as string;

  expect((await a.inject({ method: 'GET', url: '/api/v1/workers', headers: { 'x-test-user': `admin-2|admin|${OTHER}` } })).json().workers).toHaveLength(0);
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${workerId}/revoke`, headers: { 'x-test-user': `admin-2|admin|${OTHER}` } })).statusCode).toBe(404);

  let steps = 0;
  workersState.sleep = async (ms) => {
    clock += ms;
    if (++steps === 2) await a.inject({ method: 'POST', url: `/api/v1/workers/${workerId}/revoke` });
  };
  const res = await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: { authorization: `Bearer ${token}` }, payload: { waitMs: 20_000 } });
  expect(res.statusCode).toBe(401);
  expect(clock - 1_000_000).toBeLessThan(60_000);
});

it('restricts a paired worker to chosen employees and projects', async () => {
  const a = await app();
  const started = await start(a);
  await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow` });
  const token = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } })).json().token as string;
  const workerId = (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers[0].id as string;

  runtimeState.queue.add({ tenantId: TENANT, kind: 'knowledge.parse', payload: { tenantId: TENANT, itemId: 'other' }, employeeId: 'emp-b', projectId: 'proj-2' });
  runtimeState.queue.add({ tenantId: TENANT, kind: 'knowledge.parse', payload: { tenantId: TENANT, itemId: 'mine' }, employeeId: 'emp-a', projectId: 'proj-1' });

  const patched = await a.inject({ method: 'PATCH', url: `/api/v1/workers/${workerId}`, payload: { allowEmployees: ['emp-a'], allowProjects: ['proj-1'] } });
  expect(patched.json().worker.capabilities.allowEmployees).toEqual(['emp-a']);

  const claimed = await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: { authorization: `Bearer ${token}` }, payload: { waitMs: 0 } });
  expect(claimed.json().task.payload.itemId).toBe('mine');
});

it('heartbeat does not claim work; one poll plus succeed reports the task', async () => {
  const a = await app();
  const started = await start(a);
  await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow` });
  const token = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } })).json().token as string;
  runtimeState.queue.add({ tenantId: TENANT, kind: 'knowledge.parse', payload: { tenantId: TENANT, itemId: 'job-1' }, employeeId: 'emp-a', projectId: 'proj-1' });
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode).toBe(200);
  const claimed = await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: { authorization: `Bearer ${token}` }, payload: { waitMs: 0 } });
  const task = claimed.json().task;
  expect(task.payload.itemId).toBe('job-1');
  const done = await a.inject({
    method: 'POST',
    url: `/api/v1/worker-link/tasks/${task.id}/succeed`,
    headers: { authorization: `Bearer ${token}` },
    payload: { attempt: task.attempt },
  });
  expect(done.statusCode).toBe(200);
  expect(done.json().status).toBe('reported');
  expect((await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: { authorization: `Bearer ${token}` }, payload: { waitMs: 0 } })).json().task).toBeNull();
});

it('concurrent polls of an allowed code receive the token only once', async () => {
  const a = await app();
  const started = await start(a);
  await a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow` });
  const [one, two] = await Promise.all([
    a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } }),
    a.inject({ method: 'POST', url: '/api/v1/worker-link/pair/poll', payload: { deviceCode: started.deviceCode } }),
  ]);
  const tokens = [one.json().token, two.json().token].filter(Boolean);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toMatch(/^saw_/);
});

it('concurrent allow of the same code only succeeds once', async () => {
  const a = await app();
  const started = await start(a);
  const [one, two] = await Promise.all([
    a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow` }),
    a.inject({ method: 'POST', url: `/api/v1/workers/pair/${started.userCode}/allow`, headers: { 'x-test-user': `admin-2|admin|${OTHER}` } }),
  ]);
  const codes = [one.statusCode, two.statusCode].sort();
  expect(codes).toEqual([200, 409]);
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers).toHaveLength(1);
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers', headers: { 'x-test-user': `admin-2|admin|${OTHER}` } })).json().workers).toHaveLength(0);
});

it('the full app exposes pairing without a user session', async () => {
  const full = await buildApp();
  const startRes = await full.inject({ method: 'POST', url: '/api/v1/worker-link/pair/start', payload: { hostname: 'box' } });
  expect(startRes.statusCode).toBe(201);
  const allow = await full.inject({ method: 'POST', url: `/api/v1/workers/pair/${startRes.json().userCode}/allow` });
  expect([401, 403]).toContain(allow.statusCode);
  await full.close();
});
