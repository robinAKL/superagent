import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { bindRoomBrain, bindRoomStore, createCommandRoom, roomModule, roomState, superviseRoom } from '../room/index.js';
import type { EmployeeRef } from '../room/room.js';
import { registerWorker, resetWorkers, workerLinkModule, workersState } from './index.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const projectId = 'project-a';
const employeeId = 'employee-a';

it('Super Agent resumes a task whose computer came back: the same task goes to Link again, and its updates count', async () => {
  resetWorkers();
  bindRoomStore(null);
  bindRoomBrain(null);
  const employee: EmployeeRef = { id: employeeId, name: 'Analyst', ownerUserId: 'analyst-user', status: 'active' };
  roomState.current = createCommandRoom(() => [employee]);
  const { worker, token } = await registerWorker(workersState.registry, {
    tenantId, name: 'Link', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId, employeeId }] },
  }, Date.now());
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] }; });
  await app.register(roomModule, { prefix: '/room' });
  await app.register(workerLinkModule, { prefix: '/link' });
  const auth = { authorization: 'Bearer ' + token };
  let cursor = 0;
  const wakes = async () => {
    const events = (await app.inject({ method: 'POST', url: '/link/poll', headers: auth, payload: { since: cursor, waitMs: 0 } })).json().events as { seq: number; payload: Record<string, unknown> }[];
    cursor = events.at(-1)?.seq ?? cursor;
    return events.map((event) => event.payload);
  };
  const progress = (id: string, body: string) => app.inject({ method: 'POST', url: `/link/room-tasks/${id}/progress`, headers: auth, payload: { body } });

  const task = (await app.inject({ method: 'POST', url: '/room/messages', payload: { roomId: 'room-1', body: '@Analyst 检查本地 worker 是否在线', clientMessageId: 'c1' } })).json().task;
  expect(await wakes()).toEqual([{ roomTaskId: task.id, projectId, prompt: '检查本地 worker 是否在线', attempt: 0 }]);
  expect((await progress(task.id, '正在处理任务…')).statusCode).toBe(200);

  // The employee is paused (its computer may still poll): the task waits, and nothing is sent meanwhile.
  employee.status = 'paused';
  await superviseRoom();
  expect(roomState.current.task(task.id, { userId: 'owner', roles: ['owner'], projectScopes: [] }).waitingReason).toBe('等待连接');
  expect(await wakes()).toEqual([]);

  // Back online: Super Agent sends the same task again with the next attempt, without anyone pressing resume.
  employee.status = 'active';
  expect(await superviseRoom()).toBe(1);
  expect(await wakes()).toEqual([{ roomTaskId: task.id, projectId, prompt: '检查本地 worker 是否在线', attempt: 1 }]);
  const messages = (await app.inject({ method: 'GET', url: '/room/messages?roomId=room-1' })).json().messages as { body: string; kind: string }[];
  expect(messages.at(-1)).toMatchObject({ kind: 'resume' });
  expect(messages.at(-1)!.body).toContain('同一个任务，没有新建');

  // The second run's words may repeat the first run's; they are still taken as this run's progress.
  const again = await progress(task.id, '正在处理任务…');
  expect(again.statusCode).toBe(200);
  expect(again.json().duplicate).toBeUndefined();
  expect(roomState.current.task(task.id, { userId: 'owner', roles: ['owner'], projectScopes: [] }).status).toBe('running');
  expect(roomState.current.listTasks({ userId: 'owner', roles: ['owner'], projectScopes: [] })).toHaveLength(1);
  void worker;
});

it('"进行中的任务怎么还没完成" is answered from the board, after Super Agent has acted on it; the model is not asked', async () => {
  resetWorkers();
  bindRoomStore(null);
  let asked = 0;
  bindRoomBrain({ understand: async () => { asked += 1; return { answer: '要我把哪一项推进？' }; } });
  const employee: EmployeeRef = { id: employeeId, name: 'Analyst', ownerUserId: 'analyst-user', status: 'offline' };
  roomState.current = createCommandRoom(() => [employee]);
  await registerWorker(workersState.registry, {
    tenantId, name: 'Link', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId, employeeId }] },
  }, Date.now());
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] }; });
  await app.register(roomModule, { prefix: '/room' });
  const send = async (body: string, id: string) => (await app.inject({ method: 'POST', url: '/room/messages', payload: { roomId: 'room-1', body, clientMessageId: id } })).json();
  await send('@Analyst 检查本地 worker 是否在线', 'c1');
  await send('@Analyst 列出项目文件', 'c2');
  employee.status = 'active';

  const answer = await send('进行中的任务 怎么还没完成', 'c3');
  expect(answer.task).toBeNull();
  expect(answer.reply.body).toContain('看板上还有 2 个未完成');
  expect(answer.reply.body).toContain('等电脑领取'); // both resumed by the pass that ran first
  expect(answer.reply.body).not.toContain('settings.json');
  expect(asked).toBe(0);
  bindRoomBrain(null);
});

it('"好了吗" is answered from the board, not by the model', async () => {
  resetWorkers();
  bindRoomStore(null);
  let asked = 0;
  bindRoomBrain({ understand: async () => { asked += 1; return { answer: '要我检查 Link 吗？' }; } });
  const employee: EmployeeRef = { id: employeeId, name: 'Analyst', ownerUserId: 'analyst-user', status: 'active' };
  roomState.current = createCommandRoom(() => [employee]);
  await registerWorker(workersState.registry, {
    tenantId, name: 'Link', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId, employeeId }] },
  }, Date.now());
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] }; });
  await app.register(roomModule, { prefix: '/room' });
  const send = async (body: string, id: string) => (await app.inject({ method: 'POST', url: '/room/messages', payload: { roomId: 'room-1', body, clientMessageId: id } })).json();
  await send('@Analyst 列出项目文件', 'c1');
  for (const [i, question] of ['好了吗', '都完成了吗？', '怎么样了'].entries()) {
    expect((await send(question, `q${i}`)).reply.body).toContain('看板上还有 1 个未完成');
  }
  expect(asked).toBe(0);
  bindRoomBrain(null);
});

it('a resumed task made under an old binding goes to the employee’s current binding', async () => {
  resetWorkers();
  bindRoomStore(null);
  bindRoomBrain(null);
  const employee: EmployeeRef = { id: employeeId, name: 'Analyst', ownerUserId: 'analyst-user', status: 'paused' };
  roomState.current = createCommandRoom(() => [employee]);
  const { token } = await registerWorker(workersState.registry, {
    tenantId, name: 'Link', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId: 'project-new', employeeId }] },
  }, Date.now());
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] }; });
  await app.register(roomModule, { prefix: '/room' });
  await app.register(workerLinkModule, { prefix: '/link' });
  const task = (await app.inject({ method: 'POST', url: '/room/messages', payload: { roomId: 'room-1', body: '@Analyst 列出项目文件', clientMessageId: 'c1' } })).json().task;
  roomState.current.listTasks({ userId: 'owner', roles: ['owner'], projectScopes: [] }).find((item) => item.id === task.id)!.projectId = 'project-old';
  employee.status = 'active';
  await superviseRoom();
  const events = (await app.inject({ method: 'POST', url: '/link/poll', headers: { authorization: 'Bearer ' + token }, payload: { waitMs: 0 } })).json().events;
  expect(events.map((event: { payload: Record<string, unknown> }) => event.payload)).toEqual([{ roomTaskId: task.id, projectId: 'project-new', prompt: '列出项目文件', attempt: 1 }]);
});

it('"全部重试" sends every open task again at once and says what happened, task by task', async () => {
  resetWorkers();
  bindRoomStore(null);
  bindRoomBrain(null);
  const employee: EmployeeRef = { id: employeeId, name: 'Analyst', ownerUserId: 'analyst-user', status: 'active' };
  roomState.current = createCommandRoom(() => [employee]);
  const { token } = await registerWorker(workersState.registry, {
    tenantId, name: 'Link', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId, employeeId }] },
  }, Date.now());
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] }; });
  await app.register(roomModule, { prefix: '/room' });
  await app.register(workerLinkModule, { prefix: '/link' });
  const send = async (body: string, id: string) => (await app.inject({ method: 'POST', url: '/room/messages', payload: { roomId: 'room-1', body, clientMessageId: id } })).json();
  const made = (await send('@Analyst 列出项目文件', 'c1')).task;
  const answer = await send('全部重试', 'c2');
  expect(answer.task).toBeNull();
  expect(answer.reply.body).toContain('好的，开始重试 1 个任务');
  expect(answer.reply.body).toContain('已重新派给 @Analyst');
  // The room reads: the person's request, then one answer. No separate "重新派给" lines before or after it.
  const messages = (await app.inject({ method: 'GET', url: '/room/messages?roomId=room-1' })).json().messages as { body: string; kind: string; authorUserId: string }[];
  const at = messages.findIndex((message) => message.body === '全部重试');
  expect(messages.slice(at).map((message) => message.authorUserId)).toEqual(['owner', 'super-agent']);
  expect(messages.filter((message) => message.kind === 'resume')).toEqual([]);
  const wakes = (await app.inject({ method: 'POST', url: '/link/poll', headers: { authorization: 'Bearer ' + token }, payload: { waitMs: 0 } })).json().events
    .map((event: { payload: Record<string, unknown> }) => event.payload);
  expect(wakes).toEqual([
    { roomTaskId: made.id, projectId, prompt: '列出项目文件', attempt: 0 },
    { roomTaskId: made.id, projectId, prompt: '列出项目文件', attempt: 1 },
  ]);
});
