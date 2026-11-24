import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { loadRoomRows, saveRoomRows, type Queryable } from './pg-room.js';
import { employeesState } from '../employees/index.js';
import { queueRoomDispatch, resolveRoomDispatch, workersState } from '../workers/index.js';
import { linkMayBeOnline, linkOnline } from '../workers/presence.js';
import type { PlatformSource, RoomBrain, RoomBrainInput } from './brain.js';
import { CommandRoom, roomHooks, type EmployeeRef, type EmployeeSource, type RoomSnapshot, type Viewer } from './room.js';

roomHooks.linkMayBeOnline = (employeeId) => linkMayBeOnline(employeeId, workersState.now());

const ROLES = new Set<Viewer['roles'][number]>(['admin', 'owner', 'employee', 'reviewer']);

/**
 * The room names the digital employees that exist in the employee module, as they are now: the person answering
 * for each one, whether it can take work, and the prompt version it would run with. Nothing here is a sample.
 */
export function registryEmployees(): EmployeeRef[] {
  const registry = employeesState.current;
  return registry.list().map((employee) => ({
    id: employee.id,
    name: employee.name,
    ownerUserId: employee.owner,
    duty: employee.duty,
    // A bound Link computer that is online makes the employee reachable even though the registry never hears from it.
    status: employee.status === 'paused'
      ? 'paused'
      : employee.status === 'online' || employee.status === 'busy' || linkOnline(employee.id, workersState.now())
        ? 'active'
        : employee.status === 'unconnected' ? 'unconnected' : 'offline',
    promptVersion: registry.currentPrompt(employee.id).version,
    modelTier: employee.modelTier,
  }));
}

let employeeSource: EmployeeSource = registryEmployees;

/** A fresh room. Tests pass a fixed list; the running app reads the employee module. */
export function createCommandRoom(employees: EmployeeSource = registryEmployees): CommandRoom {
  employeeSource = employees;
  return new CommandRoom(employees);
}

/** Process-local room. Postgres rows are the restart contract; the JSON file remains a fallback. */
export const roomState = { current: createCommandRoom() };

let roomStore: Queryable | null = null;

/** Super Agent's model reading of messages that name nobody. Without one the room keeps its fixed wording rules. */
let roomBrain: RoomBrain | null = null;

/** The person's own platform sources (live MCP connections) and a read-only lookup through one of them. */
export interface RoomLookups {
  sources(user: NonNullable<import('fastify').FastifyRequest['user']>): Promise<PlatformSource[]>;
  ask(user: NonNullable<import('fastify').FastifyRequest['user']>, sourceId: string, question: string): Promise<{ answer: string }>;
}
let roomLookups: RoomLookups | null = null;

export function bindRoomBrain(brain: RoomBrain | null, lookups: RoomLookups | null = null): void {
  roomBrain = brain;
  roomLookups = lookups;
}

export function bindRoomStore(db: Queryable | null): void {
  roomStore = db;
}

export function reloadRoom(saved: RoomSnapshot): void {
  roomState.current = CommandRoom.restore(employeeSource, saved);
}

/** Gap-fill cursor. Missing means the start of the room. A bad value must not look like an empty catch-up. */
export function messageCursor(value: string | undefined): number | null {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function flushRoom(): Promise<void> {
  if (roomStore) await saveRoomRows(roomStore, roomState.current.snapshot());
}

/** Replaces the process-local room when the database already has messages or tasks. */
export async function hydrateRoom(): Promise<void> {
  if (!roomStore) return;
  const saved = await loadRoomRows(roomStore);
  if (saved.messages.length === 0 && saved.tasks.length === 0) return;
  reloadRoom(saved);
}

export function saveRoom(file: string): void {
  fs.writeFileSync(file, JSON.stringify(roomState.current.snapshot()));
}

export function loadRoom(file: string): void {
  reloadRoom(JSON.parse(fs.readFileSync(file, 'utf8')) as RoomSnapshot);
}

function header(headers: Record<string, unknown>, name: string): string {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * Who is acting. Under /api/v1 the auth hook has verified the user (Entra or dev identity) and that identity is
 * always used; client-supplied x-user-id / x-roles headers are ignored. The header form exists only for unit tests
 * that mount this plugin without the auth hook, and is refused in production.
 */
export function viewerFrom(headers: Record<string, unknown>, user?: { userId: string; roles: readonly string[]; projectScopes: readonly string[] }): Viewer {
  if (user) {
    const roles = user.roles.filter((r): r is Viewer['roles'][number] => ROLES.has(r as Viewer['roles'][number]));
    return { userId: user.userId, roles, projectScopes: [...user.projectScopes] };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('unauthenticated');
  const roles = header(headers, 'x-roles')
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is Viewer['roles'][number] => ROLES.has(role as Viewer['roles'][number]));
  return {
    userId: header(headers, 'x-user-id') || 'user-owner',
    roles: roles.length > 0 ? roles : ['owner'],
    projectScopes: header(headers, 'x-projects').split(',').map((scope) => scope.trim()).filter(Boolean),
  };
}

interface MessageBody {
  roomId?: string;
  tenantId?: string;
  projectId?: string | null;
  body?: string;
  clientMessageId?: string;
  followupTo?: string | null;
}

const STATUS: Record<string, number> = {
  task_not_found: 404,
  forbidden: 403,
  not_assignee: 403,
  task_closed: 409,
  task_reported: 409,
  not_reported: 409,
  evidence_failed: 409,
  empty_supplement: 400,
  empty_report: 400,
  not_held: 409,
  hold_not_satisfied: 409,
  missing_tool: 400,
  not_waiting: 409,
  employee_offline: 409,
  run_already_linked: 409,
  contract_unchanged: 409,
  invalid_contract: 400,
};

function refusal(error: unknown): { code: number; body: { error: string } } {
  const name = error instanceof Error ? error.message : 'forbidden';
  return { code: STATUS[name] ?? 403, body: { error: STATUS[name] ? name : 'forbidden' } };
}

/** Command room HTTP surface (PRD §5.6). Under /api/v1 the caller is always the signed-in user. */
export const roomModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'room', implemented: true }));

  // An employee paused or disconnected in the employee module holds its open tasks before anything is read or done.
  app.addHook('preHandler', async () => {
    if (roomState.current.holdDisconnected().length > 0) await flushRoom();
  });

  app.post('/messages', async (req, reply) => {
    const body = (req.body ?? {}) as MessageBody;
    if (!body.roomId || !body.body || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    const viewer = viewerFrom(req.headers, req.user);
    const tenantId = req.user?.tenantId ?? body.tenantId ?? 't';
    const room = roomState.current;
    // A question about a numbered task is answered from the task, not read by the model.
    const aboutTask = !body.followupTo && !room.namesEmployee(body.body) ? room.answerAboutTask(body.body, viewer, body.roomId) : null;
    const think = aboutTask === null && roomBrain !== null && !body.followupTo && !room.hasClientMessage(body.roomId, body.clientMessageId) && !room.namesEmployee(body.body);

    /** Send a task Super Agent created to the employee's computer, as an @mention would. */
    const dispatch = async (task: import('./room.js').RoomTask | null) => {
      const scopes = viewer.roles.includes('owner') || viewer.roles.includes('admin') ? null : viewer.projectScopes;
      const target = req.user && task && task.tenantId === req.user.tenantId && task.createdByUserId === viewer.userId
        && roomState.current.roster(viewer).some((employee) => employee.id === task.employeeId && employee.status !== 'paused')
        ? await resolveRoomDispatch(task, scopes)
        : undefined;
      if (task && target) task.projectId = target.projectId;
      await flushRoom();
      if (task && target) await queueRoomDispatch(task, target);
    };

    const posted = room.post({
      roomId: body.roomId,
      // The signed-in user's tenant wins; the body value is only read where no auth hook is mounted (unit tests).
      tenantId,
      projectId: body.projectId ?? null,
      authorUserId: viewer.userId,
      authorRoles: viewer.roles,
      authorProjectScopes: viewer.projectScopes,
      modelAvailable: header(req.headers, 'x-model-available') === 'false' ? false : undefined,
      body: body.body,
      clientMessageId: body.clientMessageId,
      followupTo: typeof body.followupTo === 'string' && body.followupTo ? body.followupTo : null,
      // Super Agent may take a while (a model call, perhaps a lookup): the message is stored and confirmed now.
      defer: think,
      ...(aboutTask ? { understood: { answer: aboutTask } } : {}),
    });
    if (!think || posted.duplicate) {
      await dispatch(posted.task);
      return posted;
    }
    await flushRoom();

    // Reports and progress from a computer are posted under the employee's owner; they are the employee speaking.
    const history: RoomBrainInput['history'] = room.eventsAfter(body.roomId, 0, viewer).filter((message) => message.id !== posted.message.id).slice(-12).map((message) => ({
      from: message.authorUserId === 'super-agent' ? 'super-agent'
        : message.kind === 'report' || message.clientMessageId.startsWith('worker-') || message.authorUserId !== viewer.userId ? 'employee' : 'user',
      text: message.body.slice(0, 1500),
    }));
    const text = body.body;
    void (async () => {
      let understood: import('./brain.js').Understood | null = null;
      try {
        const sources = req.user && roomLookups ? await roomLookups.sources(req.user).catch(() => []) : [];
        const roster = room.roster(viewer);
        const tasks = room.listTasks(viewer, body.roomId).map((task) => ({
          code: `T-${/(\d+)$/.exec(task.id)?.[1] ?? task.id}`,
          title: task.title.slice(0, 200),
          status: task.waitingReason ? `${task.status} (${task.waitingReason})` : task.status,
          employee: roster.find((employee) => employee.id === task.employeeId)?.name ?? '',
        }));
        const decision = await roomBrain!.understand({ tenantId, body: text, roster, sources, tasks, history });
        if (decision && 'ask' in decision) {
          // Super Agent looks it up itself through the person's own connection, then answers in the room.
          const source = sources.find((item) => item.id === decision.ask.sourceId);
          try {
            const found = await roomLookups!.ask(req.user!, decision.ask.sourceId, decision.ask.question);
            understood = { answer: found.answer.trim()
              ? `${found.answer.trim()}

（来自 ${source?.name ?? 'MCP'}）`
              : `我查了 ${source?.name ?? 'MCP'}，没有找到能回答这个问题的数据。` };
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const code = (error as { code?: unknown } | null)?.code;
            console.warn(`room lookup failed (${typeof code === 'string' ? code : 'error'}): ${reason}`);
            understood = { answer: `我去 ${source?.name ?? 'MCP'} 查了，但这次没有拿到结果（${reason.slice(0, 120)}）。可以再问一次，或到「企业知识 → 知识来源」检查连接。` };
          }
        } else {
          understood = decision;
        }
      } catch (error) {
        console.warn(`room brain failed; using fixed rules: ${error instanceof Error ? error.message : String(error)}`);
      }
      // The room in effect now (it may have been reloaded meanwhile) gives the answer, with the same checks as ever.
      const answered = roomState.current.answerDeferred(posted.message.id, understood);
      if (answered) await dispatch(answered.task);
    })().catch((error: unknown) => console.error(`room deferred answer failed: ${error instanceof Error ? error.message : String(error)}`));
    return { ...posted, awaiting: true };
  });

  /** Who is looking, and which digital employees they may name. Read from the employee module on every call. */
  app.get('/roster', async (req) => {
    const viewer = viewerFrom(req.headers, req.user);
    return {
      viewer: { userId: viewer.userId, roles: viewer.roles, owner: viewer.roles.includes('owner') || viewer.roles.includes('admin') },
      employees: roomState.current.roster(viewer).map((employee) => ({
        id: employee.id,
        name: employee.name,
        duty: employee.duty ?? '',
        status: employee.status,
        ownerUserId: employee.ownerUserId,
      })),
    };
  });

  app.get('/messages', async (req, reply) => {
    const query = req.query as { roomId?: string; after?: string };
    const after = messageCursor(query.after);
    if (after === null) return reply.code(400).send({ error: 'bad_cursor' });
    return { messages: roomState.current.eventsAfter(query.roomId ?? 'room-1', after, viewerFrom(req.headers, req.user)) };
  });

  app.get('/stream', async (req, reply) => {
    const query = req.query as { roomId?: string; after?: string };
    const after = messageCursor(query.after);
    if (after === null) return reply.code(400).send({ error: 'bad_cursor' });
    const messages = roomState.current.eventsAfter(query.roomId ?? 'room-1', after, viewerFrom(req.headers, req.user));
    const payload = messages.map((message) => `id: ${message.seq}\ndata: ${JSON.stringify(message)}\n\n`).join('');
    return reply.type('text/event-stream').send(payload);
  });

  app.get('/tasks', async (req) => {
    const query = req.query as { roomId?: string };
    return { tasks: roomState.current.listTasks(viewerFrom(req.headers, req.user), query.roomId || undefined) };
  });

  app.get('/summary', async (req) => {
    const view = roomState.current.summary(viewerFrom(req.headers, req.user));
    return {
      label: view.label,
      tasks: view.tasks.map((task) => ({ id: task.id, title: task.title, messageId: task.messageId, employeeId: task.employeeId })),
    };
  });

  app.post('/tasks/:id/report', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { body?: string; clientMessageId?: string };
    if (!body.body || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const message = roomState.current.report(params.id, viewerFrom(req.headers, req.user).userId, body.body, body.clientMessageId);
      await flushRoom();
      return message;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  /** Link the execution run that carries this task's external action. The run must exist for this tenant. */
  app.post('/tasks/:id/run', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { runId?: string };
    if (typeof body.runId !== 'string' || !body.runId) return reply.code(400).send({ error: 'missing_fields' });
    const viewer = viewerFrom(req.headers, req.user);
    try {
      const task = roomState.current.task(params.id, viewer);
      const { findRun } = await import('./outcome.js');
      const run = findRun(task.tenantId, body.runId);
      // Someone else's run reads as missing: linking it would expose its event and results through this task.
      const owner = viewer.roles.includes('owner') || viewer.roles.includes('admin');
      if (!run || (!owner && run.startedBy !== viewer.userId)) return reply.code(404).send({ error: 'run_not_found' });
      const linked = roomState.current.linkRun(params.id, viewer, body.runId);
      await flushRoom();
      return linked;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  /** Set or revise the acceptance contract. A revision retires the linked run's approvals; it never re-executes. */
  app.post('/tasks/:id/contract', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { criteria?: string; clientMessageId?: string };
    if (typeof body.criteria !== 'string' || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const result = roomState.current.reviseContract(params.id, viewerFrom(req.headers, req.user), body.criteria, body.clientMessageId);
      let retired: string[] = [];
      if (result.revised && result.task.runId) {
        const { retireApprovals } = await import('./outcome.js');
        retired = await retireApprovals(result.task.tenantId, result.task.runId);
      }
      await flushRoom();
      return { message: result.message, task: result.task, retiredApprovals: retired };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  /** The linked run's state, approvals and external attempts, for whoever can see the task. */
  app.get('/tasks/:id/outcome', async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const task = roomState.current.task(params.id, viewerFrom(req.headers, req.user));
      const { outcomeOf } = await import('./outcome.js');
      return { contract: task.contract, outcome: task.runId ? outcomeOf(task.tenantId, task.runId) : null };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  for (const action of ['cancel', 'review', 'resume'] as const) {
    app.post(`/tasks/:id/${action}`, async (req, reply) => {
      const params = req.params as { id: string };
      const body = (req.body ?? {}) as { clientMessageId?: string };
      if (!body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
      try {
        const message = roomState.current[action](params.id, viewerFrom(req.headers, req.user), body.clientMessageId);
        await flushRoom();
        return message;
      } catch (error) {
        const refused = refusal(error);
        return reply.code(refused.code).send(refused.body);
      }
    });
  }

  app.post<{ Params: { id: string } }>('/tasks/:id/verify', async (req, reply) => {
    try {
      const viewer = viewerFrom(req.headers, req.user);
      const current = roomState.current.task(req.params.id, viewer);
      let mismatch = false;
      if (current.runId) {
        const { readbackMismatch } = await import('./outcome.js');
        mismatch = readbackMismatch(current.tenantId, current.runId);
      }
      const task = roomState.current.verifyEvidence(req.params.id, viewer, { readbackMismatch: mismatch });
      await flushRoom();
      return { task, overview: roomState.current.overview(task.id, viewer) };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/ask-input', async (req, reply) => {
    try {
      const task = roomState.current.askInput(req.params.id, viewerFrom(req.headers, req.user));
      await flushRoom();
      return { task };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string }; Body: { text?: string; clientMessageId?: string } }>('/tasks/:id/supplement', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.text !== 'string' || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const result = roomState.current.supplement(req.params.id, viewerFrom(req.headers, req.user), body.text, body.clientMessageId);
      await flushRoom();
      return result;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string }; Body: { toolId?: string } }>('/tasks/:id/hold', async (req, reply) => {
    const toolId = req.body?.toolId;
    if (!toolId?.trim()) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const task = roomState.current.holdForPermission(req.params.id, viewerFrom(req.headers, req.user), toolId);
      await flushRoom();
      return { task };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string }; Body: { clientMessageId?: string } }>('/tasks/:id/release-hold', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const viewer = viewerFrom(req.headers, req.user);
      const current = roomState.current.task(req.params.id, viewer);
      const { toolsState } = await import('../tools/index.js');
      const toolUsable = !!current.hold && toolsState.current.callable(current.employeeId).some((row) => row.toolId === current.hold?.toolId);
      const result = roomState.current.releaseHold(req.params.id, viewer, body.clientMessageId, { toolUsable });
      await flushRoom();
      return result;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });
};
