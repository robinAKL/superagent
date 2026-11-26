/**
 * SaaS isolation: two companies on one deployment. Everything company A creates — digital employees, command-room
 * messages and tasks, calendar entries, inbox items — is invisible to company B and cannot be acted on from B, and
 * each company numbers its own tasks from T-1. The company comes from the verified identity, never from the body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ownerA = { 'x-dev-user': `alice|owner||${A}` };
const ownerB = { 'x-dev-user': `bob|owner||${B}` };

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp({ auth: { mode: 'dev', platformTenantId: A } }); });
afterAll(async () => { await app.close(); });

async function employee(headers: Record<string, string>, name: string, ownerUserId: string): Promise<string> {
  const created = await app.inject({ method: 'POST', url: '/api/v1/employees/', headers, payload: { name, duty: `${name}的工作`, prompt: `你是${name}`, ownerUserId } });
  expect(created.statusCode, created.body).toBeLessThan(300);
  return created.json().id as string;
}

describe('two companies on one deployment', () => {
  it('company B sees none of company A’s employees, room, tasks, calendar or inbox, and cannot act on them', async () => {
    await employee(ownerA, '订单专员A', 'alice');
    const posted = await app.inject({ method: 'POST', url: '/api/v1/room/messages', headers: ownerA, payload: { roomId: 'room-1', body: '@订单专员A 核对本周订单', clientMessageId: 'a-1' } });
    expect(posted.statusCode, posted.body).toBe(200);
    const taskA = posted.json().task;
    expect(taskA?.id).toBe('task_1');
    const inboxA = await app.inject({ method: 'POST', url: '/api/v1/work-items/', headers: ownerA, payload: { kind: 'data_check', payload: { note: 'A only' } } });
    expect(inboxA.statusCode, inboxA.body).toBeLessThan(300);

    // B's views are empty.
    expect((await app.inject({ method: 'GET', url: '/api/v1/employees/', headers: ownerB })).json()).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/room/roster', headers: ownerB })).json().employees).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1', headers: ownerB })).json().messages).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/room/tasks?roomId=room-1', headers: ownerB })).json().tasks).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/v1/work-items/', headers: ownerB })).json().items).toEqual([]);
    const calendarB = (await app.inject({ method: 'GET', url: '/api/v1/schedules/', headers: ownerB })).json();
    expect(calendarB.employees).toEqual([]);
    expect(calendarB.schedules).toEqual([]);

    // B cannot act on A's task by its id.
    const reportFromB = await app.inject({ method: 'POST', url: `/api/v1/room/tasks/${taskA.id}/report`, headers: ownerB, payload: { body: '冒充回报', clientMessageId: 'b-r' } });
    expect(reportFromB.statusCode).toBeGreaterThanOrEqual(400);
    const tasksA = (await app.inject({ method: 'GET', url: '/api/v1/room/tasks?roomId=room-1', headers: ownerA })).json().tasks;
    expect(tasksA).toHaveLength(1);
    expect(tasksA[0].status).not.toBe('completed');

    // B's own work is numbered from T-1 and stays in B.
    await employee(ownerB, '客服B', 'bob');
    const postedB = await app.inject({ method: 'POST', url: '/api/v1/room/messages', headers: ownerB, payload: { roomId: 'room-1', body: '@客服B 回复询价', clientMessageId: 'a-1' } });
    expect(postedB.statusCode, postedB.body).toBe(200);
    expect(postedB.json().duplicate).toBeFalsy();
    expect(postedB.json().task?.id).toBe('task_1');
    const messagesA = (await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1', headers: ownerA })).json().messages as Array<{ body: string }>;
    expect(messagesA.some((m) => m.body.includes('客服B'))).toBe(false);
  });

  it('a company named in the request body is ignored', async () => {
    const sent = await app.inject({ method: 'POST', url: '/api/v1/room/messages', headers: ownerB, payload: { roomId: 'room-1', tenantId: A, body: '你好', clientMessageId: 'b-hello' } });
    expect(sent.statusCode, sent.body).toBe(200);
    const messagesA = (await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1', headers: ownerA })).json().messages as Array<{ clientMessageId: string }>;
    expect(messagesA.some((m) => m.clientMessageId === 'b-hello')).toBe(false);
  });
});
