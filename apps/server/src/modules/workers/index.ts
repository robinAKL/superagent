import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { flushRoom, roomState } from '../room/index.js';
import type { RoomTask } from '../room/room.js';
import { runtimeState } from '../runtime/index.js';
import { claimTask, deadLetterTask, heartbeatTask, releaseTask, succeedTask, type Queryable } from '../runtime/pg-queue.js';
import { PgWorkerRegistry, type WorkersDb } from './pg-registry.js';
import { markLinkPresence, resetLinkPresence } from './presence.js';
import { tenantKey, workerKey, workSignal } from './signal.js';
import { MemoryApprovalStore, PgApprovalStore, registerApprovalAdminRoutes, registerApprovalLinkRoutes, type ApprovalDeps, type ApprovalStore } from './approvals.js';
import {
  authenticateWorker,
  cleanCapabilities,
  cleanPolicy,
  PERMISSION_MODES,
  type PermissionMode,
  type ToolRule,
  EVENTS_PAGE,
  MemoryWorkerRegistry,
  WORKER_EVENT_KINDS,
  type WorkerEventKind,
  registerWorker,
  toView,
  WORKER_KINDS,
  workerMayRun,
  workerStatus,
  type WorkerKind,
  type WorkerRecord,
  type WorkerRegistry,
} from './registry.js';
import {
  allowPair,
  denyPair,
  formatUserCode,
  MemoryPairStore,
  PgPairStore,
  pollPair,
  publicPairView,
  startPair,
  type PairStore,
} from './pairing.js';

export * from './registry.js';
export { PgWorkerRegistry } from './pg-registry.js';
export { startPgListener, workSignal } from './signal.js';

/** Under common proxy idle timeouts (Container Apps ingress, corporate proxies), so a held poll is not cut mid-wait. */
export const LONG_POLL_MAX_MS = 25_000;
const POLL_STEP_MS = 1_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rescan period while LISTEN is up: notifications do the waking, this only catches a missed one. */
const NOTIFIED_SCAN_MS = 5_000;

export const workersState: {
  registry: WorkerRegistry;
  approvals: ApprovalStore;
  pairs: PairStore;
  db: Queryable | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollStepMs: number;
  notifiedScanMs: number;
} = {
  registry: memoryRegistry(),
  approvals: new MemoryApprovalStore(),
  pairs: new MemoryPairStore(),
  db: null,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  pollStepMs: POLL_STEP_MS,
  notifiedScanMs: NOTIFIED_SCAN_MS,
};

/** In memory there is no trigger, so the registry signals event appends itself. */
function memoryRegistry(): MemoryWorkerRegistry {
  return new MemoryWorkerRegistry((event) => workSignal.notify(workerKey(event.workerId)));
}

export function bindWorkersDb(db: WorkersDb | null): void {
  workersState.db = db;
  workersState.registry = db ? new PgWorkerRegistry(db) : memoryRegistry();
  workersState.approvals = db ? new PgApprovalStore(db) : new MemoryApprovalStore();
  workersState.pairs = db ? new PgPairStore(db) : new MemoryPairStore();
}

export function resetWorkers(): void {
  workersState.registry = memoryRegistry();
  workersState.approvals = new MemoryApprovalStore();
  workersState.pairs = new MemoryPairStore();
  workersState.db = null;
  workersState.now = () => Date.now();
  workersState.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  workersState.pollStepMs = POLL_STEP_MS;
  workersState.notifiedScanMs = NOTIFIED_SCAN_MS;
  workSignal.listening = false;
  resetLinkPresence(Date.now());
}

/**
 * Change one employee's authorisation on one computer: its mode, one tool rule (null removes it), or whether full mode
 * still asks before mail. The whole permissions map is written back, so other employees' settings are kept.
 */
export async function updatePermission(tenantId: string, workerId: string, employeeId: string,
  change: { mode?: PermissionMode; tool?: string; rule?: ToolRule | null; askEmail?: boolean }): Promise<WorkerRecord | null> {
  const device = await workersState.registry.get(tenantId, workerId);
  if (!device || device.revokedAt !== null) return null;
  const all = { ...(device.capabilities.permissions ?? {}) };
  const current = all[employeeId] ?? { mode: 'standard' as PermissionMode };
  const rules = { ...(current.rules ?? {}) };
  if (change.tool) {
    if (change.rule) rules[change.tool] = change.rule;
    else delete rules[change.tool];
  }
  const next = cleanPolicy({ mode: change.mode ?? current.mode, rules, askEmail: change.askEmail ?? current.askEmail });
  if (!next) return null;
  all[employeeId] = next;
  return workersState.registry.patchCapabilities(tenantId, workerId, { permissions: all });
}

/** Approval routes read state through these, so tests can swap the clock and store like the rest of the module. */
const approvalDeps: ApprovalDeps = {
  store: () => workersState.approvals,
  now: () => workersState.now(),
  // Always-allow: the tool is allowed from now on for the employee whose task asked, on the computer that asked.
  remember: async (tenantId, record) => {
    if (!record.roomTaskId || record.tool.startsWith('codex.')) return;
    const task = roomState.current.listTasks({ userId: 'system', roles: ['owner'], projectScopes: [] }).find((item) => item.id === record.roomTaskId);
    if (task?.employeeId) await updatePermission(tenantId, record.workerId, task.employeeId, { tool: record.tool, rule: 'allow' });
  },
  sleep: (ms) => workersState.sleep(ms),
  stepMs: () => (workSignal.listening ? workersState.notifiedScanMs : workersState.pollStepMs),
};

/** A room message can use a single unambiguous, administrator-granted binding. */
export async function resolveRoomDispatch(task: RoomTask, projectScopes: readonly string[] | null) {
  if (task.approval !== 'none' || !['assigned', 'waiting'].includes(task.status) || task.hold) return;
  const workerList = await workersState.registry.list(task.tenantId);
  const targets = workerList.flatMap(worker => {
    if (worker.revokedAt !== null) return [];
    const projects = new Set(worker.capabilities.roomAssignments?.filter(assignment =>
      assignment.employeeId === task.employeeId &&
      (!task.projectId || assignment.projectId === task.projectId) &&
      (!worker.capabilities.projects || worker.capabilities.projects.some(project => project.id === assignment.projectId)) &&
      (!projectScopes || projectScopes.includes(assignment.projectId)) &&
      workerMayRun(worker, assignment),
    ).map(assignment => assignment.projectId));
    return [...projects].map(projectId => ({ workerId: worker.id, projectId }));
  });
  if (targets.length === 1) return targets[0];
}

/**
 * Sends every open, undispatched room task of this employee to its now-bound computer. A task already dispatched
 * keeps its device: appendEvent refuses a second dispatch for the same room task.
 */
const lastRedispatch = new Map<string, number>();

export async function dispatchWaitingRoomTasks(tenantId: string, employeeId: string): Promise<number> {
  let sent = 0;
  for (const task of roomState.current.dispatchableTasks(tenantId, employeeId)) {
    const target = await resolveRoomDispatch(task, null);
    if (!target) continue;
    task.projectId = target.projectId;
    await flushRoom();
    if (await workersState.registry.appendEvent(task.tenantId, target.workerId, 'wake', {
      roomTaskId: task.id, projectId: target.projectId, prompt: task.title,
    }, 'super-agent', workersState.now(), task.id)) sent++;
  }
  return sent;
}

export async function queueRoomDispatch(task: RoomTask, target: { workerId: string; projectId: string }): Promise<void> {
  await workersState.registry.appendEvent(task.tenantId, target.workerId, 'wake', {
    roomTaskId: task.id,
    projectId: target.projectId,
    prompt: task.title,
  }, 'super-agent', workersState.now(), task.id);
}

const isManager = (roles: readonly string[]) => roles.includes('owner') || roles.includes('admin');
/** Self-service routes let any signed-in member act on their own computer; everything else stays admin/owner. */
const SELF = { config: { selfService: true } } as const;

/**
 * Mounted under the signed-in /api/v1/workers prefix. Admin/owner by default. Employees install Link themselves,
 * so pairing, listing, binding and revoking are self-service, limited to computers the member paired.
 */
export const workersModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    if (isManager(req.user.roles) || req.routeOptions.config.selfService === true) return;
    return reply.code(403).send({ error: 'forbidden' });
  });
  const mayManage = (user: { userId: string; roles: readonly string[] }, device: WorkerRecord) =>
    isManager(user.roles) || device.createdBy === user.userId;

  app.get('/pair/:userCode', SELF, async (req, reply) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { userCode } = req.params as { userCode: string };
    const session = await workersState.pairs.byUserCode(userCode);
    if (!session) return reply.code(404).send({ error: 'not_found' });
    return publicPairView(session, workersState.now());
  });

  app.post('/pair/:userCode/allow', SELF, async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { userCode } = req.params as { userCode: string };
    const result = await allowPair(workersState.pairs, workersState.registry, userCode, { tenantId: user.tenantId, userId: user.userId }, workersState.now());
    if (result === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (result === 'expired') return reply.code(410).send({ error: 'expired' });
    if (result === 'taken') return reply.code(409).send({ error: 'taken' });
    const now = workersState.now();
    const worker = result.workerId ? await workersState.registry.get(user.tenantId, result.workerId) : null;
    return { pair: publicPairView(result, now), worker: worker ? toView(worker, now) : null };
  });

  app.post('/pair/:userCode/deny', SELF, async (req, reply) => {
    if (!req.user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { userCode } = req.params as { userCode: string };
    const result = await denyPair(workersState.pairs, userCode, workersState.now());
    if (result === 'missing') return reply.code(404).send({ error: 'not_found' });
    if (result === 'expired') return reply.code(410).send({ error: 'expired' });
    if (result === 'taken') return reply.code(409).send({ error: 'taken' });
    return publicPairView(result, workersState.now());
  });

  app.post('/', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    if (workersState.db && !UUID_RE.test(user.tenantId)) return reply.code(400).send({ error: 'tenant_not_uuid' });
    const body = (req.body ?? {}) as { name?: unknown; kind?: unknown; capabilities?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return reply.code(400).send({ error: 'bad_name' });
    if (!WORKER_KINDS.includes(body.kind as WorkerKind)) return reply.code(400).send({ error: 'bad_kind' });
    const now = workersState.now();
    const { worker, token } = await registerWorker(
      workersState.registry,
      { tenantId: user.tenantId, name, kind: body.kind as WorkerKind, capabilities: cleanCapabilities(body.capabilities), createdBy: user.userId },
      now,
    );
    // The token is shown once. It is not stored and cannot be read back.
    return reply.code(201).send({ worker: toView(worker, now), token });
  });

  app.get('/', SELF, async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const now = workersState.now();
    const workers = (await workersState.registry.list(user.tenantId)).filter(worker => mayManage(user, worker));
    return { workers: workers.map((w) => toView(w, now)) };
  });

  /** Address an instruction to one worker. It is delivered on the worker's next poll, however long it was away. */
  app.post('/:id/events', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { kind?: unknown; payload?: unknown };
    if (!WORKER_EVENT_KINDS.includes(body.kind as WorkerEventKind)) return reply.code(400).send({ error: 'bad_kind' });
    const payload = body.payload === undefined ? {} : body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || JSON.stringify(payload).length > 16_384) {
      return reply.code(400).send({ error: 'bad_payload' });
    }
    if (body.kind === 'wake' && Object.hasOwn(payload, 'roomTaskId')) {
      return reply.code(400).send({ error: 'reserved_room_dispatch' });
    }
    const event = await workersState.registry.appendEvent(user.tenantId, id, body.kind as WorkerEventKind, payload as Record<string, unknown>, user.userId, workersState.now());
    if (!event) return reply.code(404).send({ error: 'not_found' });
    return reply.code(201).send({ event });
  });

  app.patch('/:id', async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const body = (req.body ?? {}) as { allowEmployees?: unknown; allowProjects?: unknown; roomAssignments?: unknown };
    const patch = cleanCapabilities({ allowEmployees: body.allowEmployees, allowProjects: body.allowProjects, roomAssignments: body.roomAssignments });
    const worker = await workersState.registry.patchCapabilities(user.tenantId, id, patch);
    if (!worker) return reply.code(404).send({ error: 'not_found' });
    return { worker: toView(worker, workersState.now()) };
  });

  app.post('/:id/room-binding', SELF, async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    const { employeeId, projectId, remove } = (req.body ?? {}) as { employeeId?: unknown; projectId?: unknown; remove?: boolean };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    if (typeof employeeId !== 'string' || !employeeId || employeeId.length > 128
      || typeof projectId !== 'string' || !projectId || projectId.length > 128) return reply.code(400).send({ error: 'invalid_binding' });
    const registry = workersState.registry;
    const device = await registry.get(user.tenantId, id);
    if (!device || device.kind !== 'link' || device.revokedAt !== null || !mayManage(user, device)) return reply.code(404).send({ error: 'not_found' });
    const pair = { employeeId, projectId };
    if (remove !== true) {
      // A member binds only digital employees they own; an admin/owner may bind any of the team.
      const roster = roomState.current.roster(isManager(user.roles)
        ? { userId: user.userId, roles: ['owner'], projectScopes: [] }
        : { userId: user.userId, roles: user.roles, projectScopes: user.projectScopes });
      if (!roster.some(employee => employee.id === employeeId) || !device.capabilities.projects?.some(project => project.id === projectId)
        || !workerMayRun(device, pair)) return reply.code(409).send({ error: 'binding_unavailable' });
      if (workersState.db) {
        const confirmed = await workersState.db.query(`SELECT 1 FROM knowledge_tenants k
          CROSS JOIN LATERAL jsonb_each(k.doc->'organization'->'employees') e
          WHERE k.tenant_id = $1 AND e.value->>'employeeId' = $2 LIMIT 1`, [user.tenantId, employeeId]);
        if (!confirmed.rows.length) return reply.code(409).send({ error: 'binding_unavailable' });
      }
    }
    // The uniqueness and limit checks and the write happen together, so concurrent binds cannot lose one another
    // or bind one employee twice.
    const outcome = await registry.bindRoom(user.tenantId, id, { ...pair, remove: remove === true });
    if (!outcome.ok) return reply.code(outcome.error === 'not_found' ? 404 : 409).send({ error: outcome.error });
    const updated = outcome.worker;
    // Work asked for before this employee had a computer would otherwise wait forever: dispatch happens on post.
    if (remove !== true) {
      // A computer that is online right now makes the employee reachable at once, not at its next heartbeat.
      if (workerStatus(updated, workersState.now()) !== 'offline') markLinkPresence([employeeId], workersState.now());
      await dispatchWaitingRoomTasks(user.tenantId, employeeId);
    }
    return { worker: toView(updated, workersState.now()) };
  });

  /** An employee's authorisation on this computer: mode (strict | standard | full), a tool rule, or mail in full mode. */
  app.post('/:id/permissions', SELF, async (req, reply) => {
    const user = req.user;
    if (!user?.tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { employeeId?: unknown; mode?: unknown; tool?: unknown; rule?: unknown; askEmail?: unknown };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    if (typeof body.employeeId !== 'string' || !body.employeeId || body.employeeId.length > 128) return reply.code(400).send({ error: 'invalid_employee' });
    if (body.mode !== undefined && !PERMISSION_MODES.includes(body.mode as PermissionMode)) return reply.code(400).send({ error: 'invalid_mode' });
    if (body.tool !== undefined && (typeof body.tool !== 'string' || !/^[A-Za-z0-9_.:*-]{1,128}$/.test(body.tool))) return reply.code(400).send({ error: 'invalid_tool' });
    if (body.rule !== undefined && body.rule !== null && body.rule !== 'allow' && body.rule !== 'ask' && body.rule !== 'deny') return reply.code(400).send({ error: 'invalid_rule' });
    if (body.askEmail !== undefined && typeof body.askEmail !== 'boolean') return reply.code(400).send({ error: 'invalid_ask_email' });
    const device = await workersState.registry.get(user.tenantId, id);
    if (!device || device.kind !== 'link' || device.revokedAt !== null || !mayManage(user, device)) return reply.code(404).send({ error: 'not_found' });
    if (!device.capabilities.roomAssignments?.some((binding) => binding.employeeId === body.employeeId)) return reply.code(409).send({ error: 'not_bound_here' });
    const updated = await updatePermission(user.tenantId, id, body.employeeId, {
      ...(body.mode !== undefined ? { mode: body.mode as PermissionMode } : {}),
      ...(typeof body.tool === 'string' ? { tool: body.tool, rule: (body.rule ?? null) as ToolRule | null } : {}),
      ...(typeof body.askEmail === 'boolean' ? { askEmail: body.askEmail } : {}),
    });
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return { worker: toView(updated, workersState.now()) };
  });

  app.post('/:id/revoke', SELF, async (req, reply) => {
    const user = req.user;
    const tenantId = user?.tenantId;
    if (!user || !tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(404).send({ error: 'not_found' });
    const device = await workersState.registry.get(tenantId, id);
    if (!device || !mayManage(user, device)) return reply.code(404).send({ error: 'not_found' });
    if (!(await workersState.registry.revoke(tenantId, id, workersState.now()))) return reply.code(404).send({ error: 'not_found' });
    workSignal.notify(workerKey(id));
    return { id, status: 'revoked' };
  });

  registerApprovalAdminRoutes(app, approvalDeps);
};

declare module 'fastify' {
  interface FastifyContextConfig {
    /** workersModule: open to any signed-in member, who may act only on computers they paired. */
    selfService?: boolean;
  }
  interface FastifyRequest {
    worker?: WorkerRecord;
  }
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * The claim attempt the caller holds (T-02 fencing). Required on every task route: a late call from an earlier
 * attempt of the same worker must not renew or report the current one.
 */
function leaseAttempt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}

/** The in-process queue does not fence by attempt itself; check it here so both stores behave the same. */
function memoryAttemptMatches(taskId: string, attempt: number): boolean {
  return runtimeState.queue.get(taskId)?.attempt === attempt;
}

async function claimFor(worker: WorkerRecord, now: number) {
  const kinds = worker.capabilities.kinds ?? [];
  if (!kinds.length) return null; // no granted kinds: nothing to claim, but the poll still keeps it present
  const matches = (task: { employeeId?: string | null; projectId?: string | null }) => workerMayRun(worker, task);
  if (runtimeState.db) {
    const employees = worker.capabilities.allowEmployees;
    const projects = worker.capabilities.allowProjects;
    const scope = employees?.length || projects?.length ? { employees, projects } : undefined;
    return claimTask(runtimeState.db, worker.id, LEASE_MS, MAX_ATTEMPTS, worker.tenantId, kinds, scope);
  }
  return runtimeState.queue.claim(worker.id, now, kinds, worker.tenantId, (task) => matches(task));
}

/**
 * Worker side: the outbound-only channel a hosted replica or a SuperAgent Link uses.
 * Mounted outside user sign-in; every route needs a worker bearer token. The lease owner is always the
 * worker's own id from the token, never a value in the body, so one worker cannot report for another.
 */
/** Unauthenticated device-code pairing. Mounted next to worker-link, before the bearer hook. */
export const workerPairModule: FastifyPluginAsync = async (app) => {
  app.post('/pair/start', async (req, reply) => {
    const session = await startPair(workersState.pairs, (req.body ?? {}) as { hostname?: unknown; agents?: unknown }, workersState.now());
    return reply.code(201).send({
      deviceCode: session.deviceCode,
      userCode: formatUserCode(session.userCode),
      expiresAt: session.expiresAt,
      verifyPath: `/#connect?code=${encodeURIComponent(formatUserCode(session.userCode))}`,
    });
  });

  app.post('/pair/poll', async (req, reply) => {
    const deviceCode = typeof (req.body as { deviceCode?: unknown } | undefined)?.deviceCode === 'string'
      ? (req.body as { deviceCode: string }).deviceCode
      : '';
    if (!deviceCode) return reply.code(400).send({ error: 'bad_device_code' });
    return pollPair(workersState.pairs, deviceCode, workersState.now());
  });
};

export const workerLinkModule: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    const worker = await authenticateWorker(workersState.registry, bearer(req));
    if (!worker) return reply.code(401).send({ error: 'bad_worker_token' });
    req.worker = worker;
  });

  registerApprovalLinkRoutes(app, approvalDeps);

  /** The policy for each project this computer runs, read by Link at the start of every task. */
  app.post('/permissions', async (req) => {
    const worker = req.worker!;
    const fresh = await workersState.registry.get(worker.tenantId, worker.id);
    const policies: Record<string, unknown> = {};
    const modes: Record<string, PermissionMode> = {};
    for (const binding of fresh?.capabilities.roomAssignments ?? []) {
      const policy = fresh?.capabilities.permissions?.[binding.employeeId] ?? { mode: 'standard' as PermissionMode };
      policies[binding.projectId] = policy;
      modes[binding.employeeId] = policy.mode;
    }
    return { policies, modes };
  });

  /** Tool names the agent asked about during a task, so the tool list can show them with a switch each. */
  app.post('/permissions/seen', async (req, reply) => {
    const worker = req.worker!;
    const { projectId, tools } = (req.body ?? {}) as { projectId?: unknown; tools?: unknown };
    if (typeof projectId !== 'string' || !Array.isArray(tools)) return reply.code(400).send({ error: 'invalid_seen' });
    const fresh = await workersState.registry.get(worker.tenantId, worker.id);
    const binding = fresh?.capabilities.roomAssignments?.find((item) => item.projectId === projectId);
    if (!fresh || !binding) return reply.code(404).send({ error: 'not_bound_here' });
    const all = { ...(fresh.capabilities.permissions ?? {}) };
    const current = all[binding.employeeId] ?? { mode: 'standard' as PermissionMode };
    const named = tools.filter((tool): tool is string => typeof tool === 'string').slice(0, 100);
    const next = cleanPolicy({ ...current, seen: [...(current.seen ?? []).filter((tool) => !named.includes(tool)), ...named] });
    if (next) {
      all[binding.employeeId] = next;
      await workersState.registry.patchCapabilities(worker.tenantId, worker.id, { permissions: all });
    }
    return { ok: true };
  });

  /** The tray's one-click switch: the same mode for every employee bound to this computer. */
  app.post('/permissions/mode', async (req, reply) => {
    const worker = req.worker!;
    const { mode } = (req.body ?? {}) as { mode?: unknown };
    if (!PERMISSION_MODES.includes(mode as PermissionMode)) return reply.code(400).send({ error: 'invalid_mode' });
    const fresh = await workersState.registry.get(worker.tenantId, worker.id);
    for (const employeeId of new Set((fresh?.capabilities.roomAssignments ?? []).map((binding) => binding.employeeId))) {
      await updatePermission(worker.tenantId, worker.id, employeeId, { mode: mode as PermissionMode });
    }
    return { mode };
  });

  app.post('/heartbeat', async (req, reply) => {
    const body = (req.body ?? {}) as { busy?: unknown; waitingAuthReason?: unknown; capabilities?: unknown };
    const now = workersState.now();
    const input = {
      ...(typeof body.busy === 'boolean' ? { busy: body.busy } : {}),
      ...(body.waitingAuthReason === null || typeof body.waitingAuthReason === 'string'
        ? { waitingAuthReason: (body.waitingAuthReason as string | null)?.slice(0, 500) ?? null }
        : {}),
    };
    const worker = req.worker!;
    if (body.capabilities && typeof body.capabilities === 'object') {
      const { agents, projects, mcpServers } = cleanCapabilities(body.capabilities);
      if (agents || (projects && worker.kind === 'link') || (mcpServers && worker.kind === 'link')) {
        await workersState.registry.patchCapabilities(worker.tenantId, worker.id, {
          ...(agents ? { agents } : {}), ...(worker.kind === 'link' && projects ? { projects } : {}),
          ...(worker.kind === 'link' && mcpServers ? { mcpServers } : {}),
        });
      }
    }
    if (!(await workersState.registry.heartbeat(worker.id, now, input))) return reply.code(401).send({ error: 'bad_worker_token' });
    const fresh = await workersState.registry.get(worker.tenantId, worker.id);
    // The employees bound to this computer are reachable now (shown as online in the command room).
    if (fresh && fresh.revokedAt === null) {
      const employeeIds = [...new Set((fresh.capabilities.roomAssignments ?? []).map(binding => binding.employeeId))];
      markLinkPresence(employeeIds, now);
      // Tasks that waited for this employee's computer (made while it was offline, or sent to one revoked since)
      // go out now. At most once a minute per employee; a task already with this computer is not sent twice.
      for (const employeeId of employeeIds) {
        const key = `${fresh.tenantId}:${employeeId}`;
        if ((lastRedispatch.get(key) ?? 0) > now - 60_000) continue;
        lastRedispatch.set(key, now);
        void dispatchWaitingRoomTasks(fresh.tenantId, employeeId).catch((error: unknown) => req.log.warn({ err: error }, 'room re-dispatch failed'));
      }
    }
    return { status: fresh ? workerStatus(fresh, now) : 'revoked', at: now, capabilities: fresh?.capabilities ?? worker.capabilities };
  });

  /**
   * Long poll. Two durable backlogs, both survive the worker being offline:
   *   - events addressed to this worker, after the cursor `since` it sends (0 = from the beginning);
   *   - queue work of its granted kinds, claimed oldest first.
   * Returns as soon as either has something, or { task: null, events: [] } after waitMs. The returned `cursor` is
   * what to send as `since` next time; a worker that was away resends its last cursor and loses nothing.
   * Each poll also counts as a heartbeat.
   */
  app.post('/poll', async (req, reply) => {
    const worker = req.worker!;
    const body = (req.body ?? {}) as { waitMs?: unknown; since?: unknown; eventsOnly?: unknown };
    const waitMs = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? Math.min(Math.max(0, body.waitMs), LONG_POLL_MAX_MS) : LONG_POLL_MAX_MS;
    if (body.since !== undefined && !(typeof body.since === 'number' && Number.isSafeInteger(body.since) && body.since >= 0)) {
      return reply.code(400).send({ error: 'bad_cursor' });
    }
    const since = (body.since as number | undefined) ?? 0;
    let closed = false;
    reply.raw.once('close', () => { closed = true; });
    const start = workersState.now();
    const keys = [tenantKey(worker.tenantId), workerKey(worker.id)];
    for (;;) {
      // Register before reading, so a commit that lands between the read and the wait still wakes this poll.
      const woken = workSignal.waitFor(keys);
      try {
        const now = workersState.now();
        if (!(await workersState.registry.heartbeat(worker.id, now, {}))) return reply.code(401).send({ error: 'bad_worker_token' });
        const events = await workersState.registry.eventsAfter(worker.id, since, EVENTS_PAGE);
        const task = body.eventsOnly === true ? null : await claimFor(worker, now);
        const cursor = events.length ? events[events.length - 1]!.seq : since;
        if (task || events.length) return { task, events, cursor, ...(task ? { leaseMs: LEASE_MS } : {}) };
        if (closed || now - start >= waitMs) return { task: null, events, cursor, retryAfterMs: 0 };
        // With LISTEN up, a notification wakes us at once and the timer is only the safety-net rescan.
        const step = workSignal.listening ? workersState.notifiedScanMs : workersState.pollStepMs;
        await Promise.race([workersState.sleep(Math.min(step, waitMs - (now - start))), woken.promise]);
      } finally {
        woken.cancel();
      }
    }
  });

  /**
   * Task routes re-check the worker before touching the lease: a token revoked after the preHandler read it
   * must not renew or report. busy is updated only after the lease operation succeeded, so a stale call
   * cannot clear the status of the run that currently holds the lease.
   */
  async function stillValid(worker: WorkerRecord, now: number): Promise<boolean> {
    return workersState.registry.heartbeat(worker.id, now, {});
  }

  app.post('/room-tasks/:id/:action', async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== 'report' && action !== 'progress') return reply.code(404).send({ error: 'not_found' });
    const worker = req.worker!;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string' || !body.trim() || body.length > 65_536) {
      return reply.code(400).send({ error: 'bad_report' });
    }
    if (!(await stillValid(worker, workersState.now()))) return reply.code(401).send({ error: 'bad_worker_token' });
    if (!(await workersState.registry.hasRoomDispatch(worker.tenantId, worker.id, id))) {
      return reply.code(404).send({ error: 'task_not_found' });
    }
    const digest = createHash('sha256').update(body).digest('hex');
    let message;
    try {
      message = roomState.current.updateFromWorker(
        id, worker.tenantId, body, 'worker-' + action + ':' + id + ':' + digest, action === 'report',
        task => workerMayRun(worker, task) && !!worker.capabilities.roomAssignments?.some(assignment =>
          assignment.employeeId === task.employeeId && assignment.projectId === task.projectId,
        ),
      );
    } catch (error) {
      const reason = (error as Error).message;
      return reply.code(reason === 'task_not_found' ? 404 : 409).send({ error: reason });
    }
    await flushRoom();
    return message;
  });

  app.post('/tasks/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const attempt = leaseAttempt((req.body as { attempt?: unknown } | undefined)?.attempt);
    if (attempt === null) return reply.code(400).send({ error: 'bad_attempt' });
    const worker = req.worker!;
    const now = workersState.now();
    if (!(await stillValid(worker, now))) return reply.code(401).send({ error: 'bad_worker_token' });
    const ok = runtimeState.db
      ? await heartbeatTask(runtimeState.db, id, worker.id, attempt, LEASE_MS)
      : memoryAttemptMatches(id, attempt) && runtimeState.queue.heartbeat(id, worker.id, now);
    if (ok) await workersState.registry.heartbeat(worker.id, now, { busy: true });
    return { ok };
  });

  app.post('/tasks/:id/succeed', async (req, reply) => {
    const { id } = req.params as { id: string };
    const attempt = leaseAttempt((req.body as { attempt?: unknown } | undefined)?.attempt);
    if (attempt === null) return reply.code(400).send({ error: 'bad_attempt' });
    const worker = req.worker!;
    const now = workersState.now();
    if (!(await stillValid(worker, now))) return reply.code(401).send({ error: 'bad_worker_token' });
    if (runtimeState.db) {
      if (!(await succeedTask(runtimeState.db, id, worker.id, attempt))) return reply.code(409).send({ error: 'lease_lost' });
    } else {
      if (!memoryAttemptMatches(id, attempt)) return reply.code(409).send({ error: 'lease_lost' });
      try {
        runtimeState.queue.succeed(id, worker.id, now);
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    }
    await workersState.registry.heartbeat(worker.id, now, { busy: false });
    return { id, status: 'reported' };
  });

  app.post('/tasks/:id/fail', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: unknown; attempt?: unknown };
    const reason = typeof body.reason === 'string' && body.reason ? body.reason.slice(0, 500) : null;
    if (!reason) return reply.code(400).send({ error: 'missing_reason' });
    const attempt = leaseAttempt(body.attempt);
    if (attempt === null) return reply.code(400).send({ error: 'bad_attempt' });
    const worker = req.worker!;
    const now = workersState.now();
    if (!(await stillValid(worker, now))) return reply.code(401).send({ error: 'bad_worker_token' });
    let deadLettered: boolean;
    if (runtimeState.db) {
      if (await releaseTask(runtimeState.db, id, worker.id, attempt, MAX_ATTEMPTS)) deadLettered = false;
      else if (await deadLetterTask(runtimeState.db, id, worker.id, attempt, MAX_ATTEMPTS, reason)) deadLettered = true;
      else return reply.code(409).send({ error: 'lease_lost' });
    } else {
      if (!memoryAttemptMatches(id, attempt)) return reply.code(409).send({ error: 'lease_lost' });
      try {
        deadLettered = runtimeState.queue.fail(id, worker.id, now, reason).deadLettered;
      } catch (error) {
        return reply.code(409).send({ error: (error as Error).message });
      }
    }
    await workersState.registry.heartbeat(worker.id, now, { busy: false });
    return { deadLettered };
  });
};
