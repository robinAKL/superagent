import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { bindRoomBrain, bindRoomStore, createCommandRoom, roomState } from '../room/index.js';
import type { EmployeeRef } from '../room/room.js';
import { registerWorker, resetWorkers, workerLinkModule, workersState } from '../workers/index.js';
import { describeRule, nextOccurrences, occurrences, parseRule } from './rule.js';
import { bindScheduleStore, schedulesHooks, schedulesModule, schedulesState, startScheduledRun } from './index.js';
import { MemoryScheduleStore, type SuggestedSchedule } from './schedules.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const owner: UserContext = { tenantId, userId: 'owner', roles: ['owner'], projectScopes: [] };
const member: UserContext = { tenantId, userId: 'member', roles: ['employee'], projectScopes: [] };
const zone = 'Pacific/Auckland';

it('rules: weekly, workdays, last day of month, a day past the month’s end, yearly; local time across DST', () => {
  const weekly = parseRule({ freq: 'weekly', weekdays: [1, 3], time: '09:00', timezone: zone })!;
  const from = Date.parse('2026-11-23T00:00:00+13:00'); // Monday, NZDT
  expect(nextOccurrences(weekly, from, 3).map((o) => o.stamp)).toEqual(['2026-11-23T09:00', '2026-11-25T09:00', '2026-11-30T09:00']);
  expect(new Date(nextOccurrences(weekly, from, 1)[0]!.at).toISOString()).toBe('2026-11-22T20:00:00.000Z');
  expect(describeRule(weekly)).toBe('每周一、三 09:00');
  expect(describeRule(parseRule({ freq: 'daily', weekdays: [1, 2, 3, 4, 5], time: '17:30' })!)).toBe('每个工作日 17:30');

  const last = parseRule({ freq: 'monthly', monthDay: -1, time: '17:00', timezone: zone })!;
  expect(nextOccurrences(last, Date.parse('2027-01-15T00:00:00Z'), 3).map((o) => o.stamp)).toEqual(['2027-01-31T17:00', '2027-02-28T17:00', '2027-03-31T17:00']);
  const day31 = parseRule({ freq: 'monthly', monthDay: 31, timezone: zone })!;
  expect(nextOccurrences(day31, Date.parse('2027-04-01T00:00:00Z'), 2).map((o) => o.stamp)).toEqual(['2027-04-30T09:00', '2027-05-31T09:00']);
  const yearly = parseRule({ freq: 'yearly', month: 3, monthDay: 31, time: '08:00', timezone: zone })!;
  expect(describeRule(yearly)).toBe('每年 3 月31 日 08:00');
  // NZ daylight saving ends 4 April 2027: 09:00 local is 20:00Z before and 21:00Z after.
  const daily = parseRule({ freq: 'daily', time: '09:00', timezone: zone })!;
  expect(occurrences(daily, Date.parse('2027-04-02T00:00:00Z'), Date.parse('2027-04-05T00:00:00Z')).map((o) => [o.stamp, new Date(o.at).toISOString()]))
    .toEqual([['2027-04-03T09:00', '2027-04-02T20:00:00.000Z'], ['2027-04-04T09:00', '2027-04-03T21:00:00.000Z'], ['2027-04-05T09:00', '2027-04-04T21:00:00.000Z']]);

  for (const bad of [{ freq: 'weekly' }, { freq: 'monthly' }, { freq: 'hourly' }, { freq: 'daily', time: '25:00' }, { freq: 'weekly', weekdays: [8] }, { freq: 'yearly', monthDay: 1 }]) expect(parseRule(bad)).toBeNull();
});

const ops: EmployeeRef = { id: 'emp-ops', name: '运营员工', ownerUserId: 'member', status: 'active' };
const finance: EmployeeRef = { id: 'emp-fin', name: '财务员工', ownerUserId: 'someone-else', status: 'active' };
let now = Date.parse('2026-11-23T08:00:00+13:00');
let suggestions: SuggestedSchedule[] = [];

const suggestion = (over: Partial<SuggestedSchedule> = {}): SuggestedSchedule => ({
  workflowKey: 'weekly-report', title: '周报汇总', description: '汇总上周订单', work: '1. 拉取上周订单\n2. 写周报',
  rule: parseRule({ freq: 'weekly', weekdays: [1], time: '09:00', timezone: zone })!, employeeId: 'emp-ops', participants: ['emp-fin'],
  evidence: { title: '运营手册', locator: 'p3', quote: '每周一上午 9 点汇总上周订单' }, ...over,
});

beforeEach(() => {
  now = Date.parse('2026-11-23T08:00:00+13:00');
  suggestions = [suggestion()];
  resetWorkers();
  bindRoomStore(null);
  bindRoomBrain(null);
  roomState.current = createCommandRoom(() => [ops, finance]);
  bindScheduleStore(new MemoryScheduleStore(), () => now);
  schedulesHooks.suggestions = async () => suggestions;
});

async function appFor(user: UserContext) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = user; });
  await app.register(schedulesModule, { prefix: '/schedules' });
  await app.register(workerLinkModule, { prefix: '/link' });
  return app;
}
const range = '?from=2026-11-22T00:00:00Z&to=2026-12-06T00:00:00Z';

it('analysis suggestions arrive as suggestions with their employee and source; nothing runs until a manager turns one on', async () => {
  const app = await appFor(owner);
  const body = (await app.inject({ method: 'GET', url: '/schedules' + range })).json();
  expect(body.canManage).toBe(true);
  expect(body.schedules).toHaveLength(1);
  const s = body.schedules[0];
  expect(s).toMatchObject({ title: '周报汇总', status: 'suggested', employeeId: 'emp-ops', employeeName: '运营员工', ruleText: '每周一 09:00', evidence: { title: '运营手册' } });
  expect(s.participants).toEqual([{ id: 'emp-fin', name: '财务员工' }]);
  expect(s.occurrences.map((o: { stamp: string; state: string }) => [o.stamp, o.state])).toEqual([['2026-11-23T09:00', 'suggested'], ['2026-11-30T09:00', 'suggested']]);

  now = Date.parse('2026-11-23T09:01:00+13:00');
  expect(await schedulesState.current.due(startScheduledRun)).toEqual([]);

  // Turning one on needs an employee; the analysis one is kept.
  suggestions = [suggestion({ employeeId: null })];
  const fresh = (await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0];
  expect(fresh.employeeId).toBeNull();
  expect((await app.inject({ method: 'POST', url: `/schedules/${fresh.id}/enable`, payload: {} })).json().error).toBe('needs_employee');
  const on = (await app.inject({ method: 'POST', url: `/schedules/${fresh.id}/enable`, payload: { employeeId: 'emp-ops' } })).json().schedule;
  expect(on).toMatchObject({ status: 'active', employeeId: 'emp-ops' });
  // A later analysis does not overwrite what a manager decided.
  suggestions = [suggestion({ title: '新名字', employeeId: 'emp-fin' })];
  expect((await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0]).toMatchObject({ title: '周报汇总', employeeId: 'emp-ops', status: 'active' });
});

it('at its time Super Agent hands the workflow to the employee as a task, sent to its computer, once; a skipped run is not started', async () => {
  const { token } = await registerWorker(workersState.registry, {
    tenantId, name: 'Link', kind: 'link', createdBy: 'owner', capabilities: { roomAssignments: [{ projectId: 'p1', employeeId: 'emp-ops' }] },
  }, Date.now());
  const app = await appFor(owner);
  const id = (await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0].id;
  await app.inject({ method: 'POST', url: `/schedules/${id}/enable`, payload: {} });
  await app.inject({ method: 'POST', url: `/schedules/${id}/skip`, payload: { stamp: '2026-11-30T09:00' } });

  now = Date.parse('2026-11-23T09:00:30+13:00');
  const runs = await schedulesState.current.due(startScheduledRun);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ stamp: '2026-11-23T09:00', status: 'started' });
  const tasks = roomState.current.listTasks({ userId: 'owner', roles: ['owner'], projectScopes: [] });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({ employeeId: 'emp-ops', id: runs[0]!.taskId });
  // The employee gets the schedule's work, not Super Agent's note about it (which names the employee).
  expect(tasks[0]!.title).toMatch(/^按日历执行业务流程「周报汇总」/);
  expect(tasks[0]!.title).toContain('1. 拉取上周订单');
  expect(tasks[0]!.title).not.toContain('交给');
  const messages = roomState.current.eventsAfter('room-1', 0, { userId: 'owner', roles: ['owner'], projectScopes: [] });
  expect(messages[0]!.body).toBe('按日历启动「周报汇总」（每周一 09:00），交给 @运营员工。');
  const wakes = (await app.inject({ method: 'POST', url: '/link/poll', headers: { authorization: 'Bearer ' + token }, payload: { waitMs: 0 } })).json().events;
  expect(wakes.map((event: { payload: { roomTaskId: string } }) => event.payload.roomTaskId)).toEqual([tasks[0]!.id]);

  // The next minute, and another process, find nothing to start again.
  now += 60_000;
  expect(await schedulesState.current.due(startScheduledRun)).toEqual([]);
  // The skipped Monday is recorded as skipped and makes no task.
  now = Date.parse('2026-11-30T09:00:30+13:00');
  expect((await schedulesState.current.due(startScheduledRun)).map((run) => run.status)).toEqual(['skipped']);
  expect(roomState.current.listTasks({ userId: 'owner', roles: ['owner'], projectScopes: [] })).toHaveLength(1);
  const view = (await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0];
  expect(view.occurrences.map((o: { state: string }) => o.state)).toEqual(['ran', 'skipped']);
});

it('a run missed by more than 30 minutes (the server was down) is not started late', async () => {
  const app = await appFor(owner);
  const id = (await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0].id;
  await app.inject({ method: 'POST', url: `/schedules/${id}/enable`, payload: {} });
  now = Date.parse('2026-11-23T09:45:00+13:00');
  expect(await schedulesState.current.due(startScheduledRun)).toEqual([]);
  expect((await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0].occurrences[0].state).toBe('missed');
});

it('a member sees only the schedules of employees they are responsible for, never suggestions, and may only skip', async () => {
  const admin = await appFor(owner);
  const opsId = (await admin.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0].id;
  await admin.inject({ method: 'POST', url: '/schedules', payload: { title: '月结对账', rule: { freq: 'monthly', monthDay: -1, time: '17:00', timezone: zone }, employeeId: 'emp-fin' } });

  const app = await appFor(member);
  let seen = (await app.inject({ method: 'GET', url: '/schedules' + range })).json();
  expect(seen.canManage).toBe(false);
  expect(seen.schedules).toEqual([]); // the ops schedule is still a suggestion; the finance one is someone else's
  expect(seen.employees.map((e: { id: string }) => e.id)).toEqual(['emp-ops']);
  await admin.inject({ method: 'POST', url: `/schedules/${opsId}/enable`, payload: {} });
  seen = (await app.inject({ method: 'GET', url: '/schedules' + range })).json();
  expect(seen.schedules.map((s: { title: string }) => s.title)).toEqual(['周报汇总']);
  expect((await app.inject({ method: 'POST', url: `/schedules/${opsId}/pause`, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: `/schedules/${opsId}/run-now`, payload: {} })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/schedules', payload: { title: 'x', rule: { freq: 'daily' }, employeeId: 'emp-ops' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: `/schedules/${opsId}/skip`, payload: { stamp: '2026-11-30T09:00' } })).json().schedule.skips).toEqual(['2026-11-30T09:00']);
});

it('managers add, change, pause and dismiss schedules; "run now" starts one run at once', async () => {
  const app = await appFor(owner);
  const made = (await app.inject({ method: 'POST', url: '/schedules', payload: { title: '月结对账', work: '核对本月应收', rule: { freq: 'monthly', monthDay: 1, time: '10:00', timezone: zone }, employeeId: 'emp-fin' } })).json().schedule;
  expect(made).toMatchObject({ status: 'active', origin: 'manual', ruleText: '每月1 日 10:00', employeeName: '财务员工' });
  const changed = (await app.inject({ method: 'POST', url: `/schedules/${made.id}/update`, payload: { rule: { freq: 'weekly', weekdays: [5], time: '16:00' } } })).json().schedule;
  expect(changed.ruleText).toBe('每周五 16:00');
  expect(changed.rule.timezone).toBe(zone);
  expect((await app.inject({ method: 'POST', url: `/schedules/${made.id}/update`, payload: { rule: { freq: 'weekly' } } })).json().error).toBe('invalid_rule');
  expect((await app.inject({ method: 'POST', url: `/schedules/${made.id}/pause`, payload: {} })).json().schedule.status).toBe('paused');
  const ran = (await app.inject({ method: 'POST', url: `/schedules/${made.id}/run-now`, payload: {} })).json();
  expect(ran.taskId).toBeTruthy();
  expect(roomState.current.listTasks({ userId: 'owner', roles: ['owner'], projectScopes: [] })[0]!.employeeId).toBe('emp-fin');
  await app.inject({ method: 'POST', url: `/schedules/${made.id}/dismiss`, payload: {} });
  const left = (await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules.map((s: { title: string }) => s.title);
  expect(left).toEqual(['周报汇总']);
});

it('a suggestion the latest analysis no longer makes goes away; a dismissed one does not come back', async () => {
  const app = await appFor(owner);
  const id = (await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules[0].id;
  await app.inject({ method: 'POST', url: `/schedules/${id}/dismiss`, payload: {} });
  expect((await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules).toEqual([]);
  suggestions = [suggestion({ workflowKey: 'month-end', title: '月结' })];
  expect((await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules.map((s: { title: string }) => s.title)).toEqual(['月结']);
  suggestions = [];
  expect((await app.inject({ method: 'GET', url: '/schedules' + range })).json().schedules).toEqual([]);
});
