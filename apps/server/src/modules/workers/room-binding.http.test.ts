import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { bindRoomStore, createCommandRoom, roomState } from '../room/index.js';
import { registerWorker, resetWorkers, workersModule, workersState } from './index.js';
import { nextRoomAssignments, type WorkerRecord } from './registry.js';

const tenantId = '11111111-1111-4111-8111-111111111111';

async function setup() {
  resetWorkers();
  bindRoomStore(null);
  roomState.current = createCommandRoom([
    { id: 'emp-a', name: 'Analyst', ownerUserId: 'owner', status: 'active' },
    { id: 'emp-b', name: 'Builder', ownerUserId: 'owner', status: 'active' },
  ]);
  const device = async (name: string) => (await registerWorker(workersState.registry, {
    tenantId, name, kind: 'link', createdBy: 'owner',
    capabilities: { projects: [{ id: 'proj-1', name: 'Repo', agent: 'codex' }, { id: 'proj-2', name: 'Docs', agent: 'claude-code' }] },
  }, Date.now())).worker;
  // Slow reads let both concurrent requests read before either writes, as two web processes would.
  const registry = workersState.registry;
  const slow = <A extends unknown[], R>(read: (...args: A) => Promise<R>) => async (...args: A) => {
    const result = await read(...args);
    await new Promise(resolve => setTimeout(resolve, 20));
    return result;
  };
  workersState.registry = Object.assign(Object.create(registry), {
    get: slow(registry.get.bind(registry)), list: slow(registry.list.bind(registry)),
  });
  const app = Fastify();
  app.addHook('preHandler', async request => {
    request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] };
  });
  await app.register(workersModule, { prefix: '/workers' });
  const bind = (id: string, employeeId: string, projectId: string, remove = false) =>
    app.inject({ method: 'POST', url: `/workers/${id}/room-binding`, payload: { employeeId, projectId, remove } });
  return { app, device, bind };
}

it('concurrent binds of two employees to one device keep both', async () => {
  const { app, device, bind } = await setup();
  try {
    const box = await device('box');
    const [a, b] = await Promise.all([bind(box.id, 'emp-a', 'proj-1'), bind(box.id, 'emp-b', 'proj-2')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const stored = await workersState.registry.get(tenantId, box.id);
    expect(stored?.capabilities.roomAssignments).toEqual(expect.arrayContaining([
      { employeeId: 'emp-a', projectId: 'proj-1' }, { employeeId: 'emp-b', projectId: 'proj-2' },
    ]));
    expect(stored?.capabilities.roomAssignments).toHaveLength(2);
    // Heartbeat-style capability patches leave bindings alone.
    await workersState.registry.patchCapabilities(tenantId, box.id, { agents: ['codex'] });
    expect((await workersState.registry.get(tenantId, box.id))?.capabilities.roomAssignments).toHaveLength(2);

    const removed = await bind(box.id, 'emp-a', 'proj-1', true);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().worker.capabilities.roomAssignments).toEqual([{ employeeId: 'emp-b', projectId: 'proj-2' }]);
  } finally {
    await app.close();
  }
});

it('concurrent binds of one employee to two devices let exactly one through', async () => {
  const { app, device, bind } = await setup();
  try {
    const [first, second] = [await device('first'), await device('second')];
    const results = await Promise.all([bind(first.id, 'emp-a', 'proj-1'), bind(second.id, 'emp-a', 'proj-1')]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find(r => r.statusCode === 409)?.json()).toEqual({ error: 'employee_already_bound' });
    const bound = (await workersState.registry.list(tenantId)).filter(w => w.capabilities.roomAssignments?.length);
    expect(bound).toHaveLength(1);

    // Rebinding the same pair is idempotent; unknown employees and revoked devices are refused.
    const owner = bound[0]!;
    expect((await bind(owner.id, 'emp-a', 'proj-1')).statusCode).toBe(200);
    expect((await workersState.registry.get(tenantId, owner.id))?.capabilities.roomAssignments).toHaveLength(1);
    expect((await bind(owner.id, 'emp-x', 'proj-1')).json()).toEqual({ error: 'binding_unavailable' });
    await workersState.registry.revoke(tenantId, owner.id, Date.now());
    expect((await bind(owner.id, 'emp-a', 'proj-1')).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

it('nextRoomAssignments: one place per employee, a limit per device, and removal', () => {
  const record = (id: string, roomAssignments: WorkerRecord['capabilities']['roomAssignments'], extra: Partial<WorkerRecord> = {}): WorkerRecord => ({
    id, tenantId, name: id, kind: 'link', capabilities: { roomAssignments }, tokenHash: id, lastHeartbeatAt: null, busy: false,
    waitingAuthReason: null, revokedAt: null, createdBy: 'owner', createdAt: 0, ...extra,
  });
  const a = record('a', [{ employeeId: 'e1', projectId: 'p1' }]);
  const b = record('b', undefined);
  const add = (employeeId: string, projectId: string) => ({ employeeId, projectId, remove: false });
  expect(nextRoomAssignments([a, b], 'b', add('e1', 'p1'))).toEqual({ error: 'employee_already_bound' });
  expect(nextRoomAssignments([a, b], 'a', add('e1', 'p2'))).toEqual({ error: 'employee_already_bound' });
  expect(nextRoomAssignments([a, b], 'a', add('e1', 'p1'))).toEqual({ assignments: [{ employeeId: 'e1', projectId: 'p1' }] });
  expect(nextRoomAssignments([{ ...a, revokedAt: 1 }, b], 'b', add('e1', 'p1'))).toEqual({ assignments: [{ employeeId: 'e1', projectId: 'p1' }] });
  expect(nextRoomAssignments([a, b], 'a', { employeeId: 'e1', projectId: 'p1', remove: true })).toEqual({ assignments: [] });
  expect(nextRoomAssignments([a, b], 'missing', add('e2', 'p1'))).toEqual({ error: 'not_found' });
  expect(nextRoomAssignments([record('w', [], { kind: 'hosted' })], 'w', add('e2', 'p1'))).toEqual({ error: 'not_found' });
  const full = record('full', Array.from({ length: 32 }, (_, i) => ({ employeeId: `x${i}`, projectId: 'p1' })));
  expect(nextRoomAssignments([full], 'full', add('e2', 'p1'))).toEqual({ error: 'binding_limit' });
});
