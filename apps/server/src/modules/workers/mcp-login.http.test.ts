import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { Role } from '@superagent/shared';
import { createCommandRoom, roomState } from '../room/index.js';
import { registerWorker, resetWorkers, workerLinkModule, workersModule, workersState } from './index.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = { userId: 'owner', roles: ['owner' as const], projectScopes: [] as string[] };

async function app(): Promise<FastifyInstance> {
  const a = Fastify();
  a.addHook('preHandler', async (req) => {
    const raw = typeof req.headers['x-test-user'] === 'string' ? req.headers['x-test-user'] : 'owner|owner';
    const [userId, role] = raw.split('|');
    req.user = { userId: userId!, roles: [role as Role], tenantId: TENANT, projectScopes: [] };
  });
  await a.register(workersModule, { prefix: '/api/v1/workers' });
  await a.register(workerLinkModule, { prefix: '/api/v1/worker-link' });
  return a;
}

let a: FastifyInstance;
let id: string;
let token: string;
const heartbeat = (status: string) => a.inject({
  method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: { authorization: 'Bearer ' + token },
  payload: { capabilities: { projects: [{ id: 'p1', name: 'super agent', agent: 'claude-code' }], mcpServers: [{ name: 'vera-crm', status }, { name: 'gmail', status: 'connected' }] } },
});
const roomNotes = () => roomState.current.eventsAfter('room-1', 0, OWNER).map((message) => message.body);
let cursor = 0;
const events = async () => {
  const list = (await a.inject({ method: 'POST', url: '/api/v1/worker-link/poll', headers: { authorization: 'Bearer ' + token }, payload: { since: cursor, waitMs: 0 } })).json().events as { seq: number; kind: string; payload: Record<string, unknown> }[];
  cursor = list.at(-1)?.seq ?? cursor;
  return list;
};

beforeEach(async () => {
  cursor = 0;
  resetWorkers();
  roomState.current = createCommandRoom(() => [{ id: 'emp-wo', name: 'Wholesale Operations', ownerUserId: 'owner', status: 'active' }]);
  ({ worker: { id }, token } = await registerWorker(workersState.registry, {
    tenantId: TENANT, name: 'WIN-RLDG3T479VI', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId: 'p1', employeeId: 'emp-wo' }] },
  }, Date.now()) as unknown as { worker: { id: string }; token: string });
  a = await app();
});

it('when an MCP server on the computer needs signing in, the room is told once, and again when it is back', async () => {
  await heartbeat('connected');
  expect(roomNotes()).toEqual([]);
  await heartbeat('needs_auth');
  await heartbeat('needs_auth');
  expect(roomNotes()).toEqual(['WIN-RLDG3T479VI 上的 vera-crm 需要重新登录，用到它的任务现在做不了。点指挥室上方提示里的「在电脑上打开登录」，按提示完成登录即可。']);
  await heartbeat('connected');
  expect(roomNotes().at(-1)).toBe('WIN-RLDG3T479VI 上的 vera-crm 已重新连上。');
  expect(roomNotes()).toHaveLength(2);
});

it('"open the sign-in" sends the computer one instruction for that server; strangers and unknown servers are refused', async () => {
  await heartbeat('needs_auth');
  const opened = await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/mcp-login`, payload: { server: 'vera-crm' } });
  expect(opened.json()).toEqual({ opened: true });
  expect((await events()).filter((event) => event.kind === 'mcp_login')).toEqual([expect.objectContaining({ kind: 'mcp_login', payload: { server: 'vera-crm' } })]);
  // A second click within a minute does not pile up instructions.
  await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/mcp-login`, payload: { server: 'vera-crm' } });
  expect((await events()).filter((event) => event.kind === 'mcp_login')).toEqual([]);

  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/mcp-login`, payload: { server: 'not-there' } })).statusCode).toBe(400);
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/mcp-login`, headers: { 'x-test-user': 'someone|employee' }, payload: { server: 'vera-crm' } })).statusCode).toBe(404);
  // Already connected: nothing to open.
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/mcp-login`, payload: { server: 'gmail' } })).json()).toEqual({ opened: false, connected: true });
});

it('the computer reports its local clients; the page can ask it to install, sign in or connect one', async () => {
  await a.inject({
    method: 'POST', url: '/api/v1/worker-link/heartbeat', headers: { authorization: 'Bearer ' + token },
    payload: { capabilities: { clients: [{ agent: 'claude-code', state: 'ready', connected: true }, { agent: 'codex', state: 'missing', connected: false }, { agent: 'gemini', state: 'ready' }, { agent: 'aider', state: 'ready' }] } },
  });
  const listed = (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers.find((worker: { id: string }) => worker.id === id);
  // A supported client is kept (connected only when Link says so); an unknown one is dropped.
  expect(listed.capabilities.clients).toEqual([{ agent: 'claude-code', state: 'ready', connected: true }, { agent: 'codex', state: 'missing', connected: false }, { agent: 'gemini', state: 'ready', connected: false }]);

  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/client-setup`, payload: { agent: 'codex', action: 'install' } })).json()).toEqual({ opened: true });
  expect((await events()).filter((event) => event.kind === 'client_setup')).toEqual([expect.objectContaining({ payload: { agent: 'codex', action: 'install' } })]);
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/client-setup`, payload: { agent: 'aider', action: 'install' } })).statusCode).toBe(400);
  // Every supported client gets the same guided steps.
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/client-setup`, payload: { agent: 'gemini', action: 'login' } })).json()).toEqual({ opened: true });
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/client-setup`, payload: { agent: 'codex', action: 'run' } })).statusCode).toBe(400);
  expect((await a.inject({ method: 'POST', url: `/api/v1/workers/${id}/client-setup`, headers: { 'x-test-user': 'someone|employee' }, payload: { agent: 'codex', action: 'install' } })).statusCode).toBe(404);
});

it('the employees\' browser shows a window by default; the tray and the page can switch it to the background', async () => {
  const link = (path: string, payload: unknown) => a.inject({ method: 'POST', url: `/api/v1/worker-link${path}`, headers: { authorization: 'Bearer ' + token }, payload: payload as object });
  expect((await link('/permissions', {})).json().browser).toBe('visible');
  expect((await link('/browser-mode', { mode: 'background' })).json()).toEqual({ browser: 'background' });
  expect((await link('/permissions', {})).json().browser).toBe('background');
  expect((await link('/browser-mode', { mode: 'fullscreen' })).statusCode).toBe(400);
  const page = (payload: unknown, headers: Record<string, string> = {}) => a.inject({ method: 'POST', url: `/api/v1/workers/${id}/browser-mode`, headers, payload: payload as object });
  expect((await page({ mode: 'visible' })).json()).toEqual({ browser: 'visible' });
  expect((await link('/permissions', {})).json().browser).toBe('visible');
  const listed = (await a.inject({ method: 'GET', url: '/api/v1/workers' })).json().workers.find((worker: { id: string }) => worker.id === id);
  expect(listed.capabilities.browser).toBe('visible');
  expect((await page({ mode: 'nope' })).statusCode).toBe(400);
  expect((await page({ mode: 'background' }, { 'x-test-user': 'someone|employee' })).statusCode).toBe(404);
});

it('the page can open the employees\' browser on the computer for the person there to sign in to websites', async () => {
  const open = (payload: unknown, headers: Record<string, string> = {}) => a.inject({ method: 'POST', url: `/api/v1/workers/${id}/browser-sign-in`, headers, payload: payload as object });
  expect((await open({})).json()).toEqual({ opened: true });
  expect((await events()).filter((event) => event.kind === 'browser_sign_in')).toEqual([expect.objectContaining({ payload: {} })]);
  // A second click within half a minute does not queue another window.
  expect((await open({})).json()).toEqual({ opened: true, again: false });
  // Only web addresses, and only for someone who manages the computer.
  expect((await open({ url: 'file:///C:/Windows/win.ini' })).statusCode).toBe(400);
  expect((await open({ url: 'not a url' })).statusCode).toBe(400);
  expect((await open({}, { 'x-test-user': 'someone|employee' })).statusCode).toBe(404);
});
