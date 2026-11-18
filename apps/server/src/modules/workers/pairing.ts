import { randomBytes } from 'node:crypto';
import { WORK_KINDS } from '../runtime/queue.js';
import type { Queryable } from '../runtime/pg-queue.js';
import { registerWorker, type WorkerCapabilities, type WorkerRegistry } from './registry.js';

export const PAIR_TTL_MS = 10 * 60_000;
const USER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type PairStatus = 'pending' | 'allowed' | 'denied';

export interface PairSession {
  deviceCode: string;
  userCode: string;
  hostname: string;
  agents: string[];
  status: PairStatus;
  tenantId: string | null;
  workerId: string | null;
  issuedToken: string | null;
  expiresAt: number;
  createdAt: number;
}

export interface PairStore {
  insert(session: PairSession): Promise<void>;
  byDeviceCode(deviceCode: string): Promise<PairSession | null>;
  byUserCode(userCode: string): Promise<PairSession | null>;
  save(session: PairSession): Promise<void>;
  /** Atomically take a pending unexpired session. Concurrent allow/deny lose. */
  takePending(userCode: string, next: PairStatus, now: number): Promise<PairSession | null>;
  consumeToken(deviceCode: string): Promise<string | null>;
}

export class MemoryPairStore implements PairStore {
  private readonly byDevice = new Map<string, PairSession>();
  private readonly byUser = new Map<string, string>();

  async insert(session: PairSession): Promise<void> {
    this.byDevice.set(session.deviceCode, { ...session, agents: [...session.agents] });
    this.byUser.set(session.userCode, session.deviceCode);
  }

  async byDeviceCode(deviceCode: string): Promise<PairSession | null> {
    const row = this.byDevice.get(deviceCode);
    return row ? clone(row) : null;
  }

  async byUserCode(userCode: string): Promise<PairSession | null> {
    const device = this.byUser.get(normalizeUserCode(userCode));
    return device ? this.byDeviceCode(device) : null;
  }

  async save(session: PairSession): Promise<void> {
    this.byDevice.set(session.deviceCode, clone(session));
    this.byUser.set(session.userCode, session.deviceCode);
  }

  async takePending(userCode: string, next: PairStatus, now: number): Promise<PairSession | null> {
    const device = this.byUser.get(normalizeUserCode(userCode));
    const session = device ? this.byDevice.get(device) : undefined;
    if (!session || session.status !== 'pending' || now >= session.expiresAt) return null;
    session.status = next;
    return clone(session);
  }

  async consumeToken(deviceCode: string): Promise<string | null> {
    const session = await this.byDeviceCode(deviceCode);
    if (!session?.issuedToken) return null;
    const token = session.issuedToken;
    session.issuedToken = null;
    await this.save(session);
    return token;
  }
}

function clone(row: PairSession): PairSession {
  return { ...row, agents: [...row.agents] };
}

export function normalizeUserCode(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

export function formatUserCode(raw: string): string {
  const n = normalizeUserCode(raw);
  return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}

function newUserCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += USER_ALPHABET[b % USER_ALPHABET.length];
  return formatUserCode(out);
}

function newDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

export function publicPairView(session: PairSession, now: number): { userCode: string; hostname: string; status: PairStatus | 'expired'; expiresAt: number; workerId: string | null } {
  const expired = now >= session.expiresAt && session.status === 'pending';
  return {
    userCode: formatUserCode(session.userCode),
    hostname: session.hostname,
    status: expired ? 'expired' : session.status,
    expiresAt: session.expiresAt,
    workerId: session.workerId,
  };
}

export async function startPair(store: PairStore, input: { hostname?: unknown; agents?: unknown }, now: number): Promise<PairSession> {
  const hostname = typeof input.hostname === 'string' && input.hostname.trim() ? input.hostname.trim().slice(0, 80) : 'this computer';
  const agents = Array.isArray(input.agents)
    ? [...new Set(input.agents.filter((v): v is string => typeof v === 'string' && (v === 'codex' || v === 'claude-code')))]
    : [];
  for (let i = 0; i < 8; i++) {
    const session: PairSession = {
      deviceCode: newDeviceCode(),
      userCode: normalizeUserCode(newUserCode()),
      hostname,
      agents,
      status: 'pending',
      tenantId: null,
      workerId: null,
      issuedToken: null,
      expiresAt: now + PAIR_TTL_MS,
      createdAt: now,
    };
    try {
      await store.insert(session);
      return session;
    } catch {
      // unique user_code collision
    }
  }
  throw new Error('pair_start_failed');
}

export async function pollPair(store: PairStore, deviceCode: string, now: number): Promise<{ status: PairStatus | 'expired'; token?: string; workerId?: string }> {
  const session = await store.byDeviceCode(deviceCode);
  if (!session) return { status: 'expired' };
  if (session.status === 'pending' && now >= session.expiresAt) return { status: 'expired' };
  if (session.status !== 'allowed') return { status: session.status === 'pending' ? 'pending' : 'denied' };
  const token = await store.consumeToken(deviceCode);
  return { status: 'allowed', ...(token ? { token, workerId: session.workerId ?? undefined } : { workerId: session.workerId ?? undefined }) };
}

export async function allowPair(
  store: PairStore,
  registry: WorkerRegistry,
  userCode: string,
  actor: { tenantId: string; userId: string },
  now: number,
): Promise<PairSession | 'missing' | 'expired' | 'taken'> {
  const existing = await store.byUserCode(userCode);
  if (!existing) return 'missing';
  if (existing.status !== 'pending') return 'taken';
  if (now >= existing.expiresAt) return 'expired';
  const session = await store.takePending(userCode, 'allowed', now);
  if (!session) return 'taken';
  const capabilities: WorkerCapabilities = {
    kinds: [...WORK_KINDS],
    ...(session.agents.length ? { agents: session.agents } : {}),
  };
  const { worker, token } = await registerWorker(
    registry,
    { tenantId: actor.tenantId, name: session.hostname, kind: 'link', capabilities, createdBy: actor.userId },
    now,
  );
  session.tenantId = actor.tenantId;
  session.workerId = worker.id;
  session.issuedToken = token;
  await store.save(session);
  return session;
}

export async function denyPair(store: PairStore, userCode: string, now: number): Promise<PairSession | 'missing' | 'taken' | 'expired'> {
  const existing = await store.byUserCode(userCode);
  if (!existing) return 'missing';
  if (existing.status !== 'pending') return 'taken';
  if (now >= existing.expiresAt) return 'expired';
  const session = await store.takePending(userCode, 'denied', now);
  return session ?? 'taken';
}

const COLUMNS = 'device_code, user_code, hostname, agents, status, tenant_id, worker_id, issued_token, extract(epoch from expires_at)*1000 as expires_at, extract(epoch from created_at)*1000 as created_at';

interface PairRow {
  device_code: string;
  user_code: string;
  hostname: string;
  agents: string[] | null;
  status: PairStatus;
  tenant_id: string | null;
  worker_id: string | null;
  issued_token: string | null;
  expires_at: string | number;
  created_at: string | number;
}

function fromRow(r: PairRow): PairSession {
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    hostname: r.hostname,
    agents: r.agents ?? [],
    status: r.status,
    tenantId: r.tenant_id,
    workerId: r.worker_id,
    issuedToken: r.issued_token,
    expiresAt: Number(r.expires_at),
    createdAt: Number(r.created_at),
  };
}

export class PgPairStore implements PairStore {
  constructor(private readonly db: Queryable) {}

  async insert(session: PairSession): Promise<void> {
    await this.db.query(
      `INSERT INTO worker_pair_sessions (device_code, user_code, hostname, agents, status, tenant_id, worker_id, issued_token, expires_at, created_at)
       VALUES ($1,$2,$3,$4::jsonb,'pending',NULL,NULL,NULL,to_timestamp($5::double precision/1000),to_timestamp($6::double precision/1000))`,
      [session.deviceCode, session.userCode, session.hostname, JSON.stringify(session.agents), session.expiresAt, session.createdAt],
    );
  }

  async byDeviceCode(deviceCode: string): Promise<PairSession | null> {
    const { rows } = await this.db.query<PairRow>(`SELECT ${COLUMNS} FROM worker_pair_sessions WHERE device_code = $1`, [deviceCode]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async byUserCode(userCode: string): Promise<PairSession | null> {
    const { rows } = await this.db.query<PairRow>(`SELECT ${COLUMNS} FROM worker_pair_sessions WHERE user_code = $1`, [normalizeUserCode(userCode)]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async save(session: PairSession): Promise<void> {
    await this.db.query(
      `UPDATE worker_pair_sessions SET status=$2, tenant_id=$3::uuid, worker_id=$4::uuid, issued_token=$5, agents=$6::jsonb
       WHERE device_code=$1`,
      [session.deviceCode, session.status, session.tenantId, session.workerId, session.issuedToken, JSON.stringify(session.agents)],
    );
  }

  async takePending(userCode: string, next: PairStatus, now: number): Promise<PairSession | null> {
    const { rows } = await this.db.query<PairRow>(
      `UPDATE worker_pair_sessions SET status = $2
       WHERE user_code = $1 AND status = 'pending' AND expires_at > to_timestamp($3::double precision / 1000)
       RETURNING ${COLUMNS}`,
      [normalizeUserCode(userCode), next, now],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async consumeToken(deviceCode: string): Promise<string | null> {
    const current = await this.byDeviceCode(deviceCode);
    const token = current?.issuedToken;
    if (!token) return null;
    const { rows } = await this.db.query<{ device_code: string }>(
      `UPDATE worker_pair_sessions SET issued_token = NULL
       WHERE device_code = $1 AND issued_token = $2
       RETURNING device_code`,
      [deviceCode, token],
    );
    return rows[0] ? token : null;
  }
}
