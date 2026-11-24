import { expect, it } from 'vitest';
import { gatewayBrain, readDecision } from './brain.js';
import { CommandRoom, type EmployeeRef, type Viewer } from './room.js';

const employees: EmployeeRef[] = [
  { id: 'emp-ops', name: 'Wholesale Operations', ownerUserId: 'user-ops', status: 'active', duty: '用 CRM 查询订单和客户' },
  { id: 'emp-fin', name: '财务员工', ownerUserId: 'user-fin', status: 'active', duty: '对账' },
];
const owner: Viewer = { userId: 'user-owner', roles: ['owner'], projectScopes: [] };
const ops: Viewer = { userId: 'user-ops', roles: ['employee'], projectScopes: [] };
let n = 0;
const post = (room: CommandRoom, viewer: Viewer, body: string, understood: Parameters<CommandRoom['post']>[0]['understood']) => room.post({
  roomId: 'room-1', tenantId: 't', authorUserId: viewer.userId, authorRoles: viewer.roles, authorProjectScopes: viewer.projectScopes,
  body, clientMessageId: `b-${++n}`, understood,
});

it('reads only a well-formed decision that names a listed employee', () => {
  expect(readDecision('```json\n{"action":"assign","employeeId":"emp-ops","task":"用 CRM 的 MCP 查询订单"}\n```', employees))
    .toEqual({ employeeId: 'emp-ops', work: '用 CRM 的 MCP 查询订单' });
  expect(readDecision('{"action":"assign","employeeId":"emp-x","task":"查询"}', employees)).toBeNull();
  expect(readDecision('{"action":"assign","employeeId":"emp-ops","task":"  "}', employees)).toBeNull();
  expect(readDecision('{"action":"reply","reply":"好的，我们先聊聊目标。"}', employees)).toEqual({ answer: '好的，我们先聊聊目标。' });
  expect(readDecision('not json', employees)).toBeNull();
});

it('a message that names nobody goes to the employee Super Agent picked, as the restated work', () => {
  const room = new CommandRoom(employees);
  const posted = post(room, owner, '我需要数字员工 用crm 的mcp 查询订单', { employeeId: 'emp-ops', work: '用 CRM 的 MCP 查询最近的订单' });
  expect(posted.task).toMatchObject({ employeeId: 'emp-ops', title: '用 CRM 的 MCP 查询最近的订单', status: 'assigned' });
  expect(posted.reply?.body).toBe('已交给 @Wholesale Operations：用 CRM 的 MCP 查询最近的订单');
});

it('conversation gets Super Agent\'s own answer and no task', () => {
  const room = new CommandRoom(employees);
  const posted = post(room, owner, '你觉得售后应该怎么改进？', { answer: '可以先看最近一个月的退货原因。要我让数字员工整理吗？' });
  expect(posted.task).toBeNull();
  expect(posted.reply?.body).toBe('可以先看最近一个月的退货原因。要我让数字员工整理吗？');
});

it('the model cannot hand work to an employee outside the author\'s roster, and the outward-action rule still applies', () => {
  const room = new CommandRoom(employees);
  expect(post(room, ops, '对一下账', { employeeId: 'emp-fin', work: '对账' }).task).toBeNull();
  const outward = post(room, owner, '给客户发邮件', { employeeId: 'emp-ops', work: '发送邮件给客户' });
  expect(outward.task).toBeNull();
  expect(outward.reply?.body).toContain('请先补充具体对象');
});

it('an explicit @mention wins over the model', () => {
  const room = new CommandRoom(employees);
  const posted = post(room, owner, '@财务员工 对一下十月的账', { employeeId: 'emp-ops', work: '别的' });
  expect(posted.task).toMatchObject({ employeeId: 'emp-fin', title: '对一下十月的账' });
});

it('without a configured model the brain stays out of the way', async () => {
  const brain = gatewayBrain({ check: async () => ({ ok: false, code: 'llm_not_configured' }), chat: async () => { throw new Error('no'); } });
  expect(await brain.understand({ tenantId: 't', body: 'x', roster: employees, history: [] })).toBeNull();
});

it('sends the roster and the message, and gives up when the model is slow', async () => {
  let sent = '';
  const fast = gatewayBrain({
    check: async () => ({ ok: true, model: 'm' }),
    chat: async (_t, _tier, req) => {
      sent = req.messages[1]!.content as string;
      return { text: '{"action":"assign","employeeId":"emp-ops","task":"查询订单"}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end', model: 'm', reservedMicroUsd: 0, costMicroUsd: 0 };
    },
  });
  expect(await fast.understand({ tenantId: 't', body: '查订单', roster: employees, history: [] })).toEqual({ employeeId: 'emp-ops', work: '查询订单' });
  expect(sent).toContain('用 CRM 查询订单和客户');
  const misses: string[] = [];
  const slow = gatewayBrain({ check: async () => ({ ok: true, model: 'm' }), chat: () => new Promise(() => undefined) }, 20, (why) => misses.push(why));
  expect(await slow.understand({ tenantId: 't', body: '查订单', roster: employees, history: [] })).toBeNull();
  // A reasoning model that spent its allowance thinking returns no text: said, not silent.
  const empty = gatewayBrain({
    check: async () => ({ ok: true, model: 'm' }),
    chat: async () => ({ text: '', toolCalls: [], usage: { inputTokens: 1, outputTokens: 3000 }, stopReason: 'length', model: 'm', reservedMicroUsd: 0, costMicroUsd: 0 }),
  }, 1000, (why) => misses.push(why));
  expect(await empty.understand({ tenantId: 't', body: '你能做什么', roster: employees, history: [] })).toBeNull();
  expect(misses).toEqual(['no answer within 20 ms', 'unusable answer (stop: length, 0 chars)']);
});

it('a lookup names one of the platform sources the person has; anything else is not a decision', () => {
  const sources = [{ id: 'src-vera', name: 'VERA CRM', endpoint: 'https://crm.example/api/mcp' }];
  expect(readDecision('{"action":"ask","sourceId":"src-vera","question":"现在 CRM 里一共有多少个订单？"}', employees, sources))
    .toEqual({ ask: { sourceId: 'src-vera', question: '现在 CRM 里一共有多少个订单？' } });
  expect(readDecision('{"action":"ask","sourceId":"src-other","question":"订单数"}', employees, sources)).toBeNull();
  expect(readDecision('{"action":"ask","sourceId":"src-vera","question":"  "}', employees, sources)).toBeNull();
});

it('tells the model which sources the platform itself has, apart from the employees', async () => {
  let sent = '';
  const brain = gatewayBrain({
    check: async () => ({ ok: true, model: 'm' }),
    chat: async (_t, _tier, req) => {
      sent = req.messages[1]!.content as string;
      return { text: '{"action":"ask","sourceId":"src-vera","question":"订单总数"}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end', model: 'm', reservedMicroUsd: 0, costMicroUsd: 0 };
    },
  });
  const sources = [{ id: 'src-vera', name: 'VERA CRM', endpoint: 'https://crm.example/api/mcp' }];
  expect(await brain.understand({ tenantId: 't', body: '我要查询下crm的订单有多少', roster: employees, sources, history: [] }))
    .toEqual({ ask: { sourceId: 'src-vera', question: '订单总数' } });
  expect(JSON.parse(sent).platformSources).toEqual(sources);
});

it('tells the model to hand work to an employee when the person asks for one, even a lookup', async () => {
  let system = '';
  const brain = gatewayBrain({
    check: async () => ({ ok: true, model: 'm' }),
    chat: async (_t, _tier, req) => {
      system = req.messages[0]!.content as string;
      return { text: '{"action":"assign","employeeId":"emp-ops","task":"用 CRM 查询本周新增订单"}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end', model: 'm', reservedMicroUsd: 0, costMicroUsd: 0 };
    },
  });
  const decision = await brain.understand({ tenantId: 't', body: '你让数字员工去查', roster: employees, history: [{ from: 'user', text: 'CRM里本周新增了几个订单？' }] });
  expect(decision).toEqual({ employeeId: 'emp-ops', work: '用 CRM 查询本周新增订单' });
  expect(system).toContain('你让数字员工去查');
  expect(system).toContain('unless the');
});

it('knows the room\'s tasks by number, so "T-5是什么任务" is answered from the list, not guessed', async () => {
  let sent = '';
  let system = '';
  const brain = gatewayBrain({
    check: async () => ({ ok: true, model: 'm' }),
    chat: async (_t, _tier, req) => {
      system = req.messages[0]!.content as string;
      sent = req.messages[1]!.content as string;
      return { text: '{"action":"reply","reply":"T-5 是：检查本地 worker 是否在线，并把结果告诉我。现在等待连接。"}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end', model: 'm', reservedMicroUsd: 0, costMicroUsd: 0 };
    },
  });
  const tasks = [{ code: 'T-5', title: '检查本地 worker 是否在线，并把结果告诉我。', status: 'waiting (等待连接)', employee: 'Wholesale Operations' }];
  const decision = await brain.understand({ tenantId: 't', body: 'T-5是什么任务？', roster: employees, tasks, history: [] });
  expect(decision).toEqual({ answer: 'T-5 是：检查本地 worker 是否在线，并把结果告诉我。现在等待连接。' });
  expect(JSON.parse(sent).tasks).toEqual(tasks);
  expect(system).toContain('from that list only');
});
