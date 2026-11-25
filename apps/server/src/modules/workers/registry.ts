import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Worker presence (T-01 decision, room task T-03).
 *
 * A worker's identity is permanent; whether it can take work right now is derived from its last heartbeat
 * when it is read, so no sweeper has to flip rows to offline and a clock jump cannot leave a stale "live".
 *
 *   registered   heartbeat is fresh, nothing running: wakeable, waiting for work
 *   live         heartbeat is fresh and the worker reports it is running a task
 *   waiting_auth the worker reported that a person must sign in again (CLI login expired, consent, ...)
 *   offline      no heartbeat within OFFLINE_AFTER_MS (device asleep, Link stopped, network down)
 *   revoked      the credential was withdrawn; the worker can no longer poll or report
 *
 * Work that is queued while a worker is offline stays in the task queue; it is claimed on the next poll.
 */
export const WORKER_KINDS = ['hosted', 'link', 'webhook'] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];
export type WorkerStatus = 'registered' | 'live' | 'waiting_auth' | 'offline' | 'revoked';

/** A missed heartbeat window plus slack. Link polls at most every LONG_POLL_MAX_MS, which also counts as a heartbeat. */
export const OFFLINE_AFTER_MS = 60_000;

export interface RoomAssignment {
  employeeId: string;
  projectId: string;
}
export interface LinkProject {
  id: string;
  name: string;
  agent: 'codex' | 'claude-code';
}

/** How freely an employee's local agent may act on this computer (see apps/link/policy.mjs). */
export type PermissionMode = 'strict' | 'standard' | 'full';
export type ToolRule = 'allow' | 'ask' | 'deny';
export interface PermissionPolicy {
  mode: PermissionMode;
  /** Exact tool names ("mcp__vera-crm__approve_order", "Bash") or a whole MCP server ("mcp__vera-crm"). */
  rules?: Record<string, ToolRule>;
  /** In full mode, still ask before sending mail. Default true. */
  askEmail?: boolean;
  /** Tool names this employee's agent has asked about on this computer, for the tool list (newest last). */
  seen?: string[];
}
/** An MCP server Claude Code has on this computer, as `claude mcp list` reports it. */
export interface McpServerInfo { name: string; status: 'connected' | 'needs_auth' | 'failed' | 'unknown'; tools?: string[] }
const MCP_STATUS = new Set(['connected', 'needs_auth', 'failed', 'unknown']);
export const PERMISSION_MODES: readonly PermissionMode[] = ['strict', 'standard', 'full'];
const TOOL_NAME = /^[A-Za-z0-9_.:*-]{1,128}$/;

export function cleanPolicy(value: unknown): PermissionPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!PERMISSION_MODES.includes(raw.mode as PermissionMode)) return null;
  const rules: Record<string, ToolRule> = {};
  if (raw.rules && typeof raw.rules === 'object') {
    for (const [tool, rule] of Object.entries(raw.rules as Record<string, unknown>).slice(0, 200)) {
      if (TOOL_NAME.test(tool) && (rule === 'allow' || rule === 'ask' || rule === 'deny')) rules[tool] = rule;
    }
  }
  const seen = Array.isArray(raw.seen) ? [...new Set(raw.seen.filter((tool): tool is string => typeof tool === 'string' && TOOL_NAME.test(tool)))].slice(-200) : [];
  return {
    mode: raw.mode as PermissionMode,
    ...(Object.keys(rules).length ? { rules } : {}),
    ...(raw.askEmail === false ? { askEmail: false } : {}),
    ...(seen.length ? { seen } : {}),
  };
}

export interface WorkerCapabilities {
  roomAssignments?: RoomAssignment[];
  /** Per bound employee: the authorisation mode and remembered tool rules for its agent on this computer. */
  permissions?: Record<string, PermissionPolicy>;
  /** MCP servers Claude Code has on this computer (reported by Link). */
  mcpServers?: McpServerInfo[];
  /** Queue kinds this worker may claim. Empty or absent: it claims nothing until an admin grants kinds. */
  kinds?: string[];
  /** Agent CLIs the device can start, e.g. ["claude-code", "codex"]. Reported, not trusted for authorisation. */
  agents?: string[];
  /** Project labels reported by Link. Local paths and executable locations stay on the device. */
  projects?: LinkProject[];
  /** Empty or absent: every digital employee on the tenant may run here. */
  allowEmployees?: string[];
  /** Empty or absent: every project on the tenant may run here. */
  allowProjects?: string[];
}

export interface WorkerRecord {
  id: string;
  tenantId: string;
  name: string;
  kind: WorkerKind;
  capabilities: WorkerCapabilities;
  tokenHash: string;
  lastHeartbeatAt: number | null;
  busy: boolean;
  waitingAuthReason: string | null;
  revokedAt: number | null;
  createdBy: string;
  createdAt: number;
}

/** What the API returns. The token hash never leaves the server. */
export interface WorkerView {
  id: string;
  name: string;
  kind: WorkerKind;
  capabilities: WorkerCapabilities;
  status: WorkerStatus;
  lastHeartbeatAt: number | null;
  waitingAuthReason: string | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface RegisterInput {
  tenantId: string;
  name: string;
  kind: WorkerKind;
  capabilities?: WorkerCapabilities;
  createdBy: string;
}

export interface HeartbeatInput {
  busy?: boolean;
  /** A non-empty string puts the worker in waiting_auth; null clears it. Absent leaves it as it was. */
  waitingAuthReason?: string | null;
}

/**
 * Instructions addressed to one worker (wake it for a project, cancel a run, a message from the super agent).
 * Durable and ordered by a monotonic cursor: a worker that was offline reconnects with the last cursor it saw
 * and gets every event after it, so nothing sent while it slept is lost. Delivery is at-least-once; the worker
 * de-duplicates by event id.
 */
export const WORKER_EVENT_KINDS = ['wake', 'cancel', 'message', 'mcp_login'] as const;
export type WorkerEventKind = (typeof WORKER_EVENT_KINDS)[number];
export const EVENTS_PAGE = 100;

export interface WorkerEvent {
  /** The cursor: 1, 2, 3, ... per worker, in commit order, so "after cursor N" never skips a later commit. */
  seq: number;
  workerId: string;
  kind: WorkerEventKind;
  payload: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
}

export interface WorkerRegistry {
  insert(record: WorkerRecord): Promise<void>;
  byTokenHash(tokenHash: string): Promise<WorkerRecord | null>;
  get(tenantId: string, id: string): Promise<WorkerRecord | null>;
  list(tenantId: string): Promise<WorkerRecord[]>;
  heartbeat(id: string, at: number, input: HeartbeatInput): Promise<boolean>;
  revoke(tenantId: string, id: string, at: number): Promise<boolean>;
  patchCapabilities(tenantId: string, id: string, capabilities: WorkerCapabilities): Promise<WorkerRecord | null>;
  /** Adds or removes one room binding atomically against the tenant's other bindings (no lost update, no double binding). */
  bindRoom(tenantId: string, id: string, change: RoomBindingChange): Promise<RoomBindingOutcome>;
  appendEvent(tenantId: string, workerId: string, kind: WorkerEventKind, payload: Record<string, unknown>, createdBy: string, at: number, roomTaskId?: string): Promise<WorkerEvent | null>;
  hasRoomDispatch(tenantId: string, workerId: string, roomTaskId: string): Promise<boolean>;
  /** Forget where a room task was sent, so Super Agent can send the same task again (a retry, never a new task). */
  releaseRoomDispatch(tenantId: string, roomTaskId: string): Promise<void>;
  /** Oldest first, at most `limit`, strictly after `since`. */
  eventsAfter(workerId: string, since: number, limit: number): Promise<WorkerEvent[]>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256 bits, URL-safe. The prefix makes a leaked token recognisable to secret scanners. */
export function newWorkerToken(): string {
  return `saw_${randomBytes(32).toString('base64url')}`;
}

export function workerStatus(w: WorkerRecord, now: number): WorkerStatus {
  if (w.revokedAt !== null) return 'revoked';
  if (w.lastHeartbeatAt === null || now - w.lastHeartbeatAt > OFFLINE_AFTER_MS) return 'offline';
  if (w.waitingAuthReason) return 'waiting_auth';
  return w.busy ? 'live' : 'registered';
}

export function toView(w: WorkerRecord, now: number): WorkerView {
  return {
    id: w.id,
    name: w.name,
    kind: w.kind,
    capabilities: w.capabilities,
    status: workerStatus(w, now),
    lastHeartbeatAt: w.lastHeartbeatAt,
    waitingAuthReason: w.waitingAuthReason,
    revokedAt: w.revokedAt,
    createdAt: w.createdAt,
  };
}

function cleanList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64))].slice(0, 32);
}

export function cleanCapabilities(value: unknown): WorkerCapabilities {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const out: WorkerCapabilities = {};
  const kinds = cleanList(raw.kinds);
  const agents = cleanList(raw.agents);
  const allowEmployees = cleanList(raw.allowEmployees);
  const allowProjects = cleanList(raw.allowProjects);
  if (Array.isArray(raw.projects)) {
    const projects = new Map<string, LinkProject>();
    for (const entry of raw.projects.slice(0, 32)) {
      if (!entry || typeof entry !== 'object') continue;
      const { id, name, agent } = entry as Partial<LinkProject>;
      if (typeof id !== 'string' || !id || id.length > 128 || typeof name !== 'string' || !name
        || name.length > 128 || (agent !== 'codex' && agent !== 'claude-code')) continue;
      projects.set(id, { id, name, agent });
    }
    out.projects = [...projects.values()];
  }
  if (Array.isArray(raw.roomAssignments)) {
    out.roomAssignments = raw.roomAssignments.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return [];
      const { employeeId, projectId } = entry as Partial<RoomAssignment>;
      return [employeeId, projectId].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 128)
        ? [{ employeeId: employeeId!, projectId: projectId! }]
        : [];
    }).slice(0, 32);
  }
  if (raw.permissions && typeof raw.permissions === 'object') {
    const permissions: Record<string, PermissionPolicy> = {};
    for (const [employeeId, policy] of Object.entries(raw.permissions as Record<string, unknown>).slice(0, 32)) {
      const clean = cleanPolicy(policy);
      if (clean && employeeId.length > 0 && employeeId.length <= 128) permissions[employeeId] = clean;
    }
    out.permissions = permissions;
  }
  if (Array.isArray(raw.mcpServers)) {
    out.mcpServers = raw.mcpServers.flatMap((entry: unknown) => {
      const { name, status, tools } = (entry && typeof entry === 'object' ? entry : {}) as Partial<McpServerInfo>;
      const names = Array.isArray(tools) ? [...new Set(tools.filter((tool): tool is string => typeof tool === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(tool)))].slice(0, 200) : null;
      return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(name) && MCP_STATUS.has(String(status))
        ? [{ name, status: status as McpServerInfo['status'], ...(names ? { tools: names } : {}) }] : [];
    }).slice(0, 32);
  }
  if (kinds) out.kinds = kinds;
  if (agents) out.agents = agents;
  if (allowEmployees) out.allowEmployees = allowEmployees;
  if (allowProjects) out.allowProjects = allowProjects;
  return out;
}

export const ROOM_BINDINGS_MAX = 32;

export interface RoomBindingChange extends RoomAssignment {
  remove: boolean;
}
export type RoomBindingError = 'not_found' | 'employee_already_bound' | 'binding_limit';
export type RoomBindingOutcome = { ok: true; worker: WorkerRecord } | { ok: false; error: RoomBindingError };

/**
 * The room assignments device `id` should hold after `change`, judged against every device of the tenant.
 * An employee is bound to one place: one live device and one project. Callers must read `devices` and write the
 * result without another binding change in between (see WorkerRegistry.bindRoom).
 */
export function nextRoomAssignments(devices: readonly WorkerRecord[], id: string, change: RoomBindingChange):
  { assignments: RoomAssignment[] } | { error: RoomBindingError } {
  const device = devices.find(other => other.id === id);
  if (!device || device.kind !== 'link' || device.revokedAt !== null) return { error: 'not_found' };
  const { employeeId, projectId } = change;
  const assignments = (device.capabilities.roomAssignments ?? [])
    .filter(binding => binding.employeeId !== employeeId || binding.projectId !== projectId);
  if (change.remove) return { assignments };
  if (devices.some(other => other.revokedAt === null && other.capabilities.roomAssignments?.some(binding =>
    binding.employeeId === employeeId && (other.id !== id || binding.projectId !== projectId),
  ))) return { error: 'employee_already_bound' };
  if (assignments.length >= ROOM_BINDINGS_MAX) return { error: 'binding_limit' };
  return { assignments: [...assignments, { employeeId, projectId }] };
}

export function mergeCapabilities(current: WorkerCapabilities, patch: WorkerCapabilities): WorkerCapabilities {
  return cleanCapabilities({ ...current, ...patch });
}

/** Default: the worker may run any employee/project. A non-empty allow-list is exclusive. */
export function workerMayRun(worker: WorkerRecord, task: { employeeId?: string | null; projectId?: string | null }): boolean {
  const employees = worker.capabilities.allowEmployees;
  if (employees?.length && (!task.employeeId || !employees.includes(task.employeeId))) return false;
  const projects = worker.capabilities.allowProjects;
  if (projects?.length && (!task.projectId || !projects.includes(task.projectId))) return false;
  return true;
}

/** Creates the record and returns the plaintext token once. Only its hash is stored. */
export async function registerWorker(registry: WorkerRegistry, input: RegisterInput, now: number): Promise<{ worker: WorkerRecord; token: string }> {
  const token = newWorkerToken();
  const worker: WorkerRecord = {
    id: randomUUID(),
    tenantId: input.tenantId,
    name: input.name,
    kind: input.kind,
    capabilities: cleanCapabilities(input.capabilities),
    tokenHash: hashToken(token),
    lastHeartbeatAt: null,
    busy: false,
    waitingAuthReason: null,
    revokedAt: null,
    createdBy: input.createdBy,
    createdAt: now,
  };
  await registry.insert(worker);
  return { worker, token };
}

/** A revoked worker is treated exactly like an unknown token. */
export async function authenticateWorker(registry: WorkerRegistry, token: string | undefined): Promise<WorkerRecord | null> {
  if (!token || !token.startsWith('saw_')) return null;
  const worker = await registry.byTokenHash(hashToken(token));
  if (!worker || worker.revokedAt !== null) return null;
  return worker;
}

export class MemoryWorkerRegistry implements WorkerRegistry {
  private readonly rows = new Map<string, WorkerRecord>();
  private readonly events: WorkerEvent[] = [];
  private readonly roomDispatches = new Map<string, WorkerEvent>();

  /** onAppend stands in for the PostgreSQL trigger's NOTIFY (migration 0015). */
  constructor(private readonly onAppend?: (event: WorkerEvent) => void) {}

  async hasRoomDispatch(tenantId: string, workerId: string, roomTaskId: string): Promise<boolean> {
    return this.roomDispatches.get(JSON.stringify([tenantId, roomTaskId]))?.workerId === workerId;
  }

  async releaseRoomDispatch(tenantId: string, roomTaskId: string): Promise<void> {
    this.roomDispatches.delete(JSON.stringify([tenantId, roomTaskId]));
  }

  async appendEvent(tenantId: string, workerId: string, kind: WorkerEventKind, payload: Record<string, unknown>, createdBy: string, at: number, roomTaskId?: string): Promise<WorkerEvent | null> {
    const row = this.rows.get(workerId);
    if (!row || row.tenantId !== tenantId || row.revokedAt !== null) return null;
    const dispatchKey = roomTaskId ? JSON.stringify([tenantId, roomTaskId]) : null;
    const earlier = dispatchKey ? this.roomDispatches.get(dispatchKey) : undefined;
    // A dispatch to a computer revoked since never ran there: the current computer may take the task.
    if (earlier && this.rows.get(earlier.workerId)?.revokedAt !== null) this.roomDispatches.delete(dispatchKey!);
    if (dispatchKey && this.roomDispatches.has(dispatchKey)) return null;
    const seq = this.events.filter((e) => e.workerId === workerId).length + 1;
    const event: WorkerEvent = { seq, workerId, kind, payload: structuredClone(payload), createdBy, createdAt: at };
    this.events.push(event);
    if (dispatchKey) this.roomDispatches.set(dispatchKey, event);
    this.onAppend?.(structuredClone(event));
    return structuredClone(event);
  }

  async eventsAfter(workerId: string, since: number, limit: number): Promise<WorkerEvent[]> {
    return this.events.filter((e) => e.workerId === workerId && e.seq > since).slice(0, limit).map((e) => structuredClone(e));
  }

  async insert(record: WorkerRecord): Promise<void> {
    this.rows.set(record.id, { ...record });
  }

  async byTokenHash(tokenHash: string): Promise<WorkerRecord | null> {
    for (const row of this.rows.values()) if (row.tokenHash === tokenHash) return { ...row };
    return null;
  }

  async get(tenantId: string, id: string): Promise<WorkerRecord | null> {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }

  async list(tenantId: string): Promise<WorkerRecord[]> {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId).sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ ...r }));
  }

  async heartbeat(id: string, at: number, input: HeartbeatInput): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.revokedAt !== null) return false;
    row.lastHeartbeatAt = at;
    if (input.busy !== undefined) row.busy = input.busy;
    if (input.waitingAuthReason !== undefined) row.waitingAuthReason = input.waitingAuthReason || null;
    return true;
  }

  async revoke(tenantId: string, id: string, at: number): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId || row.revokedAt !== null) return false;
    row.revokedAt = at;
    return true;
  }

  async patchCapabilities(tenantId: string, id: string, capabilities: WorkerCapabilities): Promise<WorkerRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId || row.revokedAt !== null) return null;
    row.capabilities = mergeCapabilities(row.capabilities, capabilities);
    return { ...row };
  }

  // No await between the read and the write, so concurrent calls cannot interleave.
  async bindRoom(tenantId: string, id: string, change: RoomBindingChange): Promise<RoomBindingOutcome> {
    const devices = [...this.rows.values()].filter(row => row.tenantId === tenantId);
    const next = nextRoomAssignments(devices, id, change);
    if ('error' in next) return { ok: false, error: next.error };
    const row = this.rows.get(id)!;
    row.capabilities = mergeCapabilities(row.capabilities, { roomAssignments: next.assignments });
    return { ok: true, worker: { ...row } };
  }
}
