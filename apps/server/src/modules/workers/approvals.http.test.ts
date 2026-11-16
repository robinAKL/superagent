import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { Role } from '@superagent/shared';
import { resetRuntime } from '../runtime/index.js';
import { APPROVAL_TTL_MS } from './approvals.js';
import { registerWorker, resetWorkers, workerLinkModule, workersModule, workersState } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let clock = 1_000_000;

async function app(): Promise<FastifyInstance> {
  const a = Fastify();
  a.addHook('preHandler', async (req) => {
    const raw = typeof req.headers['x-test-user'] === 'string' ? req.headers['x-test-user'] : `robin|owner|${TENANT}`;
    const [userId, role, tenantId] = raw.split('|');
    req.user = { userId: userId!, roles: [role as Role], tenantId: tenantId!, projectScopes: [] };
  });
  await a.register(workersModule, { prefix: '/api/v1/workers' });
  await a.register(workerLinkModule, { prefix: '/api/v1/worker-link' });
  return a;
}

const worker = (tenantId = TENANT) =>
  registerWorker(workersState.registry, { tenantId, name: 'laptop', kind: 'link', createdBy: 'robin' }, clock);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PROMPT = { tool: 'Bash', input: { command: 'npm test' }, summary: 'Run the test suite', roomTaskId: 'task_1' };

const file = (a: FastifyInstance, token: string, payload: object = PROMPT) =>
  a.inject({ method: 'POST', url: '/api/v1/worker-link/approvals', headers: auth(token), payload });
const wait = (a: FastifyInstance, token: string, id: string, waitMs = 0) =>
  a.inject({ method: 'POST', url: `/api/v1/worker-link/approvals/${id}/wait`, headers: auth(token), payload: { waitMs } });
const decide = (a: FastifyInstance, id: string, decision: string, user?: string) =>
  a.inject({ method: 'POST', url: `/api/v1/workers/approvals/${id}/decide`, headers: user ? { 'x-test-user': user } : {}, payload: { decision, reason: 'ok' } });
const list = async (a: FastifyInstance, status = 'pending', user?: string) =>
  (await a.inject({ method: 'GET', url: `/api/v1/workers/approvals?status=${status}`, headers: user ? { 'x-test-user': user } : {} })).json().approvals;

beforeEach(() => {
  resetRuntime();
  resetWorkers();
  clock = 1_000_000;
  workersState.now = () => clock;
  workersState.sleep = async (ms) => { clock += ms; };
});

it('a Link files a prompt; the room sees it pending; allow is returned to the waiting Link', async () => {
  const a = await app();
  const { token } = await worker();
  const created = await file(a, token);
  expect(created.statusCode).toBe(201);
  const { id, status, expiresAt } = created.json().approval;
  expect(status).toBe('pending');
  expect(expiresAt).toBe(clock + APPROVAL_TTL_MS);

  const pending = await list(a);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id, tool: 'Bash', input: { command: 'npm test' }, summary: 'Run the test suite', roomTaskId: 'task_1', status: 'pending' });
  expect(pending[0]).not.toHaveProperty('tenantId');

  expect((await wait(a, token, id)).json().approval.status).toBe('pending');
  const allowed = await decide(a, id, 'allow');
  expect(allowed.json().approval).toMatchObject({ status: 'allowed', decidedBy: 'robin', reason: 'ok' });
  expect((await wait(a, token, id)).json().approval).toMatchObject({ status: 'allowed', decidedBy: 'robin' });
  expect(await list(a)).toHaveLength(0);
  expect(await list(a, 'allowed')).toHaveLength(1);
});

it('deny is returned; a second decision is refused with 409 and the first stands', async () => {
  const a = await app();
  const { token } = await worker();
  const { id } = (await file(a, token)).json().approval;
  expect((await decide(a, id, 'deny')).json().approval.status).toBe('denied');
  const again = await decide(a, id, 'allow');
  expect(again.statusCode).toBe(409);
  expect(again.json().approval.status).toBe('denied');
  expect((await wait(a, token, id)).json().approval.status).toBe('denied');
});

it('an unanswered prompt expires after 10 minutes, reads as expired, and can no longer be decided', async () => {
  const a = await app();
  const { token } = await worker();
  const { id } = (await file(a, token)).json().approval;
  clock += APPROVAL_TTL_MS;
  expect((await wait(a, token, id)).json().approval.status).toBe('expired');
  expect(await list(a, 'expired')).toHaveLength(1);
  expect((await decide(a, id, 'allow')).statusCode).toBe(409);
});

it('a held wait returns as soon as the room decides, not at the end of its wait', async () => {
  // Real timers here: the decision lands 100ms in, the wait would otherwise hold 20s.
  workersState.now = () => Date.now();
  workersState.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  workersState.pollStepMs = 10_000;
  const a = await app();
  const { token } = await worker();
  const { id } = (await file(a, token)).json().approval;
  const started = Date.now();
  const held = wait(a, token, id, 20_000);
  setTimeout(() => { void decide(a, id, 'allow'); }, 100);
  expect((await held).json().approval.status).toBe('allowed');
  expect(Date.now() - started).toBeLessThan(1_500);
});

it('a wait that ends with no decision returns pending and can be re-sent', async () => {
  const a = await app();
  const { token } = await worker();
  const { id } = (await file(a, token)).json().approval;
  const started = clock;
  expect((await wait(a, token, id, 5_000)).json().approval.status).toBe('pending');
  expect(clock - started).toBe(5_000);
  expect((await wait(a, token, id, 10 * 60_000)).json().approval.status).toBe('pending');
  expect(clock - started).toBe(5_000 + 25_000); // capped at 25s
});

it('only the filing worker can wait; other tenants cannot see or decide; employees are refused by the module role', async () => {
  const a = await app();
  const { token } = await worker();
  const { token: sameTenantOther } = await worker();
  const { token: otherTenant } = await worker(OTHER);
  const { id } = (await file(a, token)).json().approval;
  expect((await wait(a, sameTenantOther, id)).statusCode).toBe(404);
  expect((await wait(a, otherTenant, id)).statusCode).toBe(404);
  const outsider = `eve|owner|${OTHER}`;
  expect(await list(a, 'pending', outsider)).toHaveLength(0);
  expect((await decide(a, id, 'allow', outsider)).statusCode).toBe(404);
  expect((await wait(a, token, id)).json().approval.status).toBe('pending');
});

it('validates the prompt and the decision', async () => {
  const a = await app();
  const { token } = await worker();
  for (const bad of [
    { ...PROMPT, tool: '' }, { ...PROMPT, tool: 'x'.repeat(129) }, { ...PROMPT, input: ['a'] }, { ...PROMPT, input: 'cmd' },
    { ...PROMPT, input: { big: 'x'.repeat(17_000) } }, { ...PROMPT, summary: '' }, { ...PROMPT, roomTaskId: 5 },
  ]) expect((await file(a, token, bad)).statusCode).toBe(400);
  const { id } = (await file(a, token)).json().approval;
  expect((await decide(a, id, 'maybe')).statusCode).toBe(400);
  expect((await decide(a, 'not-a-uuid', 'allow')).statusCode).toBe(404);
  expect((await a.inject({ method: 'GET', url: '/api/v1/workers/approvals?status=weird' })).statusCode).toBe(400);
  expect((await wait(a, token, 'not-a-uuid')).statusCode).toBe(404);
});

it('caps open prompts per worker, and a revoked worker cannot file or wait', async () => {
  const a = await app();
  const { worker: w, token } = await worker();
  for (let i = 0; i < 20; i++) expect((await file(a, token)).statusCode).toBe(201);
  expect((await file(a, token)).statusCode).toBe(429);
  const { id } = (await list(a))[0];
  await a.inject({ method: 'POST', url: `/api/v1/workers/${w.id}/revoke` });
  expect((await file(a, token)).statusCode).toBe(401);
  expect((await wait(a, token, id)).statusCode).toBe(401);
});
