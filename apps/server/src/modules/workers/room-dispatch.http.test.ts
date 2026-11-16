import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { bindRoomStore, createCommandRoom, roomModule, roomState } from '../room/index.js';
import { registerWorker, resetWorkers, workerLinkModule, workersState } from './index.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const projectId = 'project-a';
const employeeId = 'employee-a';

it('assigns once to the bound device while offline and accepts only its report', async () => {
  resetWorkers();
  bindRoomStore(null);
  roomState.current = createCommandRoom([{ id: employeeId, name: 'Analyst', ownerUserId: 'analyst-user', status: 'offline' }]);
  const worker = async (tenant: string, project: string) => registerWorker(workersState.registry, {
    tenantId: tenant, name: 'Link', kind: 'link', createdBy: 'owner',
    capabilities: { roomAssignments: [{ projectId: project, employeeId }] },
  }, Date.now());
  const target = await worker(tenantId, projectId);
  const wrongProject = await worker(tenantId, 'project-b');
  const wrongTenant = await worker(otherTenant, projectId);
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] };
  });
  await app.register(roomModule, { prefix: '/room' });
  await app.register(workerLinkModule, { prefix: '/link' });
  const auth = (token: string) => ({ authorization: 'Bearer ' + token });
  try {
    const payload = { roomId: 'room-1', projectId, body: '@Analyst Review the repository', clientMessageId: 'request-1' };
    const first = await app.inject({ method: 'POST', url: '/room/messages', payload });
    expect(first.statusCode).toBe(200);
    const { task } = first.json();
    expect(task.status).toBe('waiting');
    const duplicate = await app.inject({ method: 'POST', url: '/room/messages', payload });
    expect(duplicate.json().duplicate).toBe(true);

    const poll = (token: string) => app.inject({
      method: 'POST', url: '/link/poll', headers: auth(token), payload: { waitMs: 0 },
    });
    expect((await poll(wrongProject.token)).json().events).toEqual([]);
    expect((await poll(wrongTenant.token)).json().events).toEqual([]);
    const received = (await poll(target.token)).json();
    expect(received.events).toHaveLength(1);
    expect(received.events[0]).toMatchObject({
      kind: 'wake', payload: { roomTaskId: task.id, projectId, prompt: 'Review the repository' },
    });

    const progress = await app.inject({
      method: 'POST', url: '/link/room-tasks/' + task.id + '/progress', headers: auth(target.token),
      payload: { body: 'Review started.' },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ kind: 'reply', taskIds: [task.id], body: 'Review started.' });
    const report = (token: string) => app.inject({
      method: 'POST', url: '/link/room-tasks/' + task.id + '/report', headers: auth(token),
      payload: { body: 'Repository review complete.' },
    });
    expect((await report(wrongProject.token)).statusCode).toBe(404);
    expect((await report(wrongTenant.token)).statusCode).toBe(404);
    const result = await report(target.token);
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ kind: 'report', taskIds: [task.id] });
    expect((await report(target.token)).json().id).toBe(result.json().id);
  } finally {
    await app.close();
  }
});
