import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { UserContext } from '@superagent/shared';
import { flushRoom, roomState } from '../room/index.js';
import { queueRoomDispatch, resolveRoomDispatch } from '../workers/index.js';
import { describeRule, type Occurrence } from './rule.js';
import { MemoryScheduleStore, ScheduleError, ScheduleService, isManager, type EmployeeInfo, type Schedule, type ScheduleStore, type SuggestedSchedule } from './schedules.js';

/** The command room Super Agent posts scheduled starts in (the web app's single room). */
export const SCHEDULE_ROOM_ID = 'room-1';

export const schedulesState = { current: new ScheduleService(new MemoryScheduleStore()) };
export function bindScheduleStore(store: ScheduleStore, now?: () => number): void {
  schedulesState.current = new ScheduleService(store, now);
}

/** Filled at start-up where the knowledge service exists: the schedules analysis found, for this person. */
export const schedulesHooks: { suggestions: ((user: UserContext) => Promise<SuggestedSchedule[]>) | null } = { suggestions: null };

const SYSTEM = { userId: 'super-agent', roles: ['owner' as const], projectScopes: [] as string[] };

function employeesFor(user: Pick<UserContext, 'userId' | 'roles' | 'projectScopes'>): EmployeeInfo[] {
  return roomState.current.roster({ userId: user.userId, roles: user.roles, projectScopes: user.projectScopes })
    .map((employee) => ({ id: employee.id, name: employee.name, ownerUserId: employee.ownerUserId ?? null, status: employee.status }));
}

/**
 * Starts one scheduled run: Super Agent posts it in the command room and hands the workflow to the employee as a
 * task, sent to the employee's computer like any assignment. The task is followed up like every other one.
 */
export async function startScheduledRun(schedule: Schedule, occurrence: Occurrence) {
  const room = roomState.current;
  const employee = room.roster(SYSTEM).find((item) => item.id === schedule.employeeId);
  if (!employee) return { taskId: null, note: '负责的数字员工已不存在，请重新指派。', status: 'no_employee' as const };
  const posted = room.post({
    roomId: SCHEDULE_ROOM_ID, tenantId: schedule.tenantId, authorUserId: SYSTEM.userId, authorRoles: SYSTEM.roles, systemWork: true,
    body: `按日历启动「${schedule.title}」（${describeRule(schedule.rule)}），交给 @${employee.name}。`,
    clientMessageId: `schedule:${schedule.id}:${occurrence.stamp}`,
    understood: { employeeId: employee.id, work: `按日历执行业务流程「${schedule.title}」（${occurrence.stamp.replace('T', ' ')}）：\n${schedule.work}`.slice(0, 4000) },
  });
  const task = posted.task;
  if (task) {
    const target = employee.status !== 'paused' ? await resolveRoomDispatch(task, null) : undefined;
    if (target) task.projectId = target.projectId;
    await flushRoom();
    if (target) await queueRoomDispatch(task, target);
  } else {
    await flushRoom();
  }
  return { taskId: task?.id ?? null, note: task ? '' : (posted.reply?.body ?? '').slice(0, 300) };
}

/** Super Agent checks the calendar every minute (unref: never keeps the process alive). */
export function startScheduleTimer(everyMs = 60_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void schedulesState.current.due(startScheduledRun)
      .catch((error: unknown) => console.warn(`schedule timer failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof ScheduleError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

const DAY = 86_400_000;

/** /api/v1/schedules: the workflow calendar, by employee, filtered by what each role may see. */
export const schedulesModule: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { from?: string; to?: string } }>('/', async (req, reply) => {
    const user = req.user!;
    const from = req.query.from ? Date.parse(req.query.from) : Date.now() - 7 * DAY;
    const to = req.query.to ? Date.parse(req.query.to) : from + 42 * DAY;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 62 * DAY) return reply.code(400).send({ error: 'invalid_range' });
    const manager = isManager(user);
    if (manager && schedulesHooks.suggestions) {
      try { await schedulesState.current.sync(user.tenantId, await schedulesHooks.suggestions(user)); }
      catch (error) { console.warn(`schedule suggestions failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const employees = employeesFor(user);
    const schedules = await schedulesState.current.calendar(user, employees, from, to);
    const visibleEmployees = manager ? employees : employees.filter((item) => item.ownerUserId === user.userId);
    return {
      canManage: manager,
      employees: visibleEmployees.map(({ id, name, status }) => ({ id, name, status })),
      schedules,
    };
  });

  app.post('/', async (req, reply) => {
    try {
      const row = await schedulesState.current.create(req.user!, employeesFor(req.user!), (req.body ?? {}) as Record<string, unknown>);
      return { schedule: schedulesState.current.view(row, employeesFor(req.user!)) };
    } catch (error) { return fail(reply, error); }
  });

  app.post<{ Params: { id: string; action: string } }>('/:id/:action', async (req, reply) => {
    try {
      const employees = employeesFor(req.user!);
      const row = await schedulesState.current.act(req.user!, employees, req.params.id, req.params.action, (req.body ?? {}) as Record<string, unknown>);
      return { schedule: schedulesState.current.view(row, employees) };
    } catch (error) { return fail(reply, error); }
  });

  /** "立即运行": starts one run now, outside the calendar's own times. Managers only. */
  app.post<{ Params: { id: string } }>('/:id/run-now', async (req, reply) => {
    const user = req.user!;
    if (!isManager(user)) return reply.code(403).send({ error: 'forbidden' });
    const row = (await schedulesState.current.listFor(user.tenantId)).find((item) => item.id === req.params.id && item.status !== 'dismissed');
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (!row.employeeId) return reply.code(400).send({ error: 'needs_employee', message: '请先选择由哪位数字员工来做。' });
    const now = new Date();
    const stamp = `now-${now.toISOString().slice(0, 16)}`;
    return startScheduledRun(row, { stamp, at: now.getTime() });
  });
};
