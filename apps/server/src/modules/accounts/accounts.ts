import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SecretStore, SecretVersion } from '../setup/secrets.js';

/**
 * Mail and calendar accounts. Every account has exactly one owner:
 * - an administrator: their own mailbox and calendar, which control Super Agent;
 * - one digital employee: that employee's own mailbox and calendar.
 * Nothing crosses owners: accountAccess() refuses an actor that is not the account's owner.
 */
export type OwnerKind = 'admin' | 'employee';
export type SendRule = 'ask' | 'allow' | 'deny';
export interface Owner { kind: OwnerKind; id: string }
/** Who is about to use an account: Super Agent (for an admin's account) or one digital employee. */
export type Actor = { kind: 'super-agent' } | { kind: 'employee'; id: string };

export interface AccountConnection {
  id: string;
  tenantId: string;
  owner: Owner;
  provider: 'microsoft';
  address: string;
  displayName: string;
  scopes: string;
  mailTrigger: boolean;
  calendarTrigger: boolean;
  sendRule: SendRule;
  status: 'connected' | 'reauthorize';
  grant: SecretVersion | null;
  /** Epoch ms the access token stops working; null when unknown. */
  grantDeadline: number | null;
  connectedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthAttempt {
  stateHash: string;
  tenantId: string;
  userId: string;
  owner: Owner;
  verifier: SecretVersion;
  redirectUri: string;
  expiresAt: number;
}

export interface AccountStore {
  list(tenantId: string, owner: Owner): Promise<AccountConnection[]>;
  get(tenantId: string, id: string): Promise<AccountConnection | null>;
  /** Insert, or replace the row with the same owner, provider and address (keeping its id and settings). */
  save(connection: AccountConnection): Promise<AccountConnection>;
  remove(tenantId: string, id: string): Promise<void>;
  putAttempt(attempt: OAuthAttempt): Promise<void>;
  /** Returns and deletes the attempt: a state is good for one callback. */
  takeAttempt(stateHash: string): Promise<OAuthAttempt | null>;
}

const sameRow = (a: AccountConnection, b: AccountConnection) => a.tenantId === b.tenantId && a.owner.kind === b.owner.kind
  && a.owner.id === b.owner.id && a.provider === b.provider && a.address.toLowerCase() === b.address.toLowerCase();

export class MemoryAccountStore implements AccountStore {
  private rows = new Map<string, AccountConnection>();
  private attempts = new Map<string, OAuthAttempt>();
  async list(tenantId: string, owner: Owner) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId && row.owner.kind === owner.kind && row.owner.id === owner.id).map((row) => ({ ...row }));
  }
  async get(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? { ...row } : null;
  }
  async save(connection: AccountConnection) {
    const existing = [...this.rows.values()].find((row) => sameRow(row, connection));
    const saved = existing && existing.id !== connection.id
      ? { ...connection, id: existing.id, mailTrigger: existing.mailTrigger, calendarTrigger: existing.calendarTrigger, sendRule: existing.sendRule, createdAt: existing.createdAt }
      : connection;
    this.rows.set(saved.id, { ...saved });
    return { ...saved };
  }
  async remove(tenantId: string, id: string) {
    if (this.rows.get(id)?.tenantId === tenantId) this.rows.delete(id);
  }
  async putAttempt(attempt: OAuthAttempt) { this.attempts.set(attempt.stateHash, attempt); }
  async takeAttempt(stateHash: string) {
    const attempt = this.attempts.get(stateHash) ?? null;
    this.attempts.delete(stateHash);
    return attempt;
  }
}

/** What a provider sign-in needs to do: build the sign-in address, redeem the code, refresh, and say whose mailbox. */
export interface AccountProvider {
  readonly id: 'microsoft';
  readonly scopes: string;
  authorizeUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  redeem(input: { code: string; verifier: string; redirectUri: string }): Promise<ProviderTokens>;
  refresh(refreshToken: string): Promise<ProviderTokens>;
  whoAmI(accessToken: string): Promise<{ address: string; displayName: string }>;
}
export interface ProviderTokens { access: string; refresh: string | null; expiresIn: number | null; scope: string }

export class AccountError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

export interface AccountServiceDeps {
  store: AccountStore;
  secrets: SecretStore;
  provider: AccountProvider | null;
  now?: () => number;
}

/** The parts of an account a person may see: never the grant. */
export function accountView(row: AccountConnection) {
  return {
    id: row.id, owner: row.owner, provider: row.provider, address: row.address, displayName: row.displayName,
    mailTrigger: row.mailTrigger, calendarTrigger: row.calendarTrigger, sendRule: row.sendRule, status: row.status,
    connectedAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export class AccountService {
  private readonly now: () => number;
  constructor(private readonly deps: AccountServiceDeps) { this.now = deps.now ?? Date.now; }

  get configured() { return this.deps.provider !== null; }

  list(tenantId: string, owner: Owner) { return this.deps.store.list(tenantId, owner); }

  find(tenantId: string, id: string) { return this.deps.store.get(tenantId, id); }

  /** Starts a sign-in for this owner. The person comes back through finish() with the same state. */
  async start(tenantId: string, userId: string, owner: Owner, redirectUri: string): Promise<{ authorizationUrl: string }> {
    const provider = this.requireProvider();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const secret = await this.deps.secrets.put(this.secretName('pkce', tenantId, hashState(state)), verifier);
    await this.deps.store.putAttempt({ stateHash: hashState(state), tenantId, userId, owner, verifier: secret, redirectUri, expiresAt: this.now() + 10 * 60_000 });
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { authorizationUrl: provider.authorizeUrl({ state, challenge, redirectUri }) };
  }

  /** Completes a sign-in. Only the person who started it, in the same tenant, can finish it. */
  async finish(tenantId: string, userId: string, input: { state?: unknown; code?: unknown }): Promise<AccountConnection> {
    const provider = this.requireProvider();
    if (typeof input.state !== 'string' || !/^[\w-]{43}$/.test(input.state) || typeof input.code !== 'string' || !input.code || input.code.length > 4096) {
      throw new AccountError('invalid_callback', '登录回调无效，请重新连接。');
    }
    const attempt = await this.deps.store.takeAttempt(hashState(input.state));
    if (!attempt || attempt.tenantId !== tenantId || attempt.userId !== userId) throw new AccountError('invalid_callback', '登录回调无效，请重新连接。');
    let verifier: string;
    try {
      if (attempt.expiresAt <= this.now()) throw new AccountError('invalid_callback', '登录已超时，请重新连接。');
      verifier = await this.deps.secrets.get(attempt.verifier);
    } finally { await this.disable(attempt.verifier); }
    const tokens = await provider.redeem({ code: input.code, verifier, redirectUri: attempt.redirectUri });
    const who = await provider.whoAmI(tokens.access);
    const at = new Date(this.now()).toISOString();
    const existing = (await this.deps.store.list(tenantId, attempt.owner)).find((row) => row.provider === provider.id && row.address.toLowerCase() === who.address.toLowerCase());
    const grant = await this.deps.secrets.put(this.secretName('tokens', tenantId, existing?.id ?? randomUUID()), JSON.stringify(tokens));
    const saved = await this.deps.store.save({
      id: existing?.id ?? randomUUID(), tenantId, owner: attempt.owner, provider: provider.id, address: who.address, displayName: who.displayName,
      scopes: tokens.scope, mailTrigger: existing?.mailTrigger ?? false, calendarTrigger: existing?.calendarTrigger ?? false,
      sendRule: existing?.sendRule ?? 'ask', status: 'connected', grant, grantDeadline: tokens.expiresIn ? this.now() + tokens.expiresIn * 1000 : null,
      connectedBy: userId, createdAt: existing?.createdAt ?? at, updatedAt: at,
    });
    if (existing?.grant) await this.disable(existing.grant);
    return saved;
  }

  async update(tenantId: string, id: string, owner: Owner, patch: { mailTrigger?: unknown; calendarTrigger?: unknown; sendRule?: unknown }) {
    const row = await this.owned(tenantId, id, owner);
    if (patch.mailTrigger !== undefined && typeof patch.mailTrigger !== 'boolean') throw new AccountError('invalid_input', '设置无效。');
    if (patch.calendarTrigger !== undefined && typeof patch.calendarTrigger !== 'boolean') throw new AccountError('invalid_input', '设置无效。');
    if (patch.sendRule !== undefined && !['ask', 'allow', 'deny'].includes(patch.sendRule as string)) throw new AccountError('invalid_input', '设置无效。');
    return this.deps.store.save({
      ...row,
      ...(typeof patch.mailTrigger === 'boolean' ? { mailTrigger: patch.mailTrigger } : {}),
      ...(typeof patch.calendarTrigger === 'boolean' ? { calendarTrigger: patch.calendarTrigger } : {}),
      ...(patch.sendRule !== undefined ? { sendRule: patch.sendRule as SendRule } : {}),
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  async disconnect(tenantId: string, id: string, owner: Owner) {
    const row = await this.owned(tenantId, id, owner);
    await this.deps.store.remove(tenantId, id);
    if (row.grant) await this.disable(row.grant);
  }

  /**
   * An access token for an actor to use this account, refreshed when needed. Super Agent may use only administrators'
   * accounts; a digital employee only its own. Anything else is refused, whatever the caller asks for.
   */
  async accountAccess(tenantId: string, actor: Actor, id: string): Promise<{ connection: AccountConnection; token: string }> {
    const row = await this.deps.store.get(tenantId, id);
    if (!row || !mayUse(actor, row.owner)) throw new AccountError('not_owner', '这个账号不属于当前执行者。', 403);
    if (row.status !== 'connected' || !row.grant) throw new AccountError('reauthorize', '这个账号需要重新登录授权。', 401);
    let tokens: ProviderTokens;
    try { tokens = JSON.parse(await this.deps.secrets.get(row.grant)) as ProviderTokens; } catch { return this.needsSignIn(row); }
    if (row.grantDeadline === null || row.grantDeadline > this.now() + 60_000) return { connection: row, token: tokens.access };
    if (!tokens.refresh) return this.needsSignIn(row);
    let fresh: ProviderTokens;
    try { fresh = await this.requireProvider().refresh(tokens.refresh); } catch { return this.needsSignIn(row); }
    const grant = await this.deps.secrets.put(this.secretName('tokens', tenantId, row.id), JSON.stringify({ ...fresh, refresh: fresh.refresh ?? tokens.refresh }));
    const saved = await this.deps.store.save({ ...row, grant, grantDeadline: fresh.expiresIn ? this.now() + fresh.expiresIn * 1000 : null, updatedAt: new Date(this.now()).toISOString() });
    await this.disable(row.grant);
    return { connection: saved, token: fresh.access };
  }

  private async needsSignIn(row: AccountConnection): Promise<never> {
    await this.deps.store.save({ ...row, status: 'reauthorize', updatedAt: new Date(this.now()).toISOString() });
    throw new AccountError('reauthorize', '这个账号需要重新登录授权。', 401);
  }

  private async owned(tenantId: string, id: string, owner: Owner) {
    const row = await this.deps.store.get(tenantId, id);
    if (!row || row.owner.kind !== owner.kind || row.owner.id !== owner.id) throw new AccountError('not_found', '找不到这个账号。', 404);
    return row;
  }

  private requireProvider() {
    if (!this.deps.provider) throw new AccountError('not_configured', 'Microsoft 365 接入还没有配置，请联系平台管理员。', 503);
    return this.deps.provider;
  }

  private secretName(kind: string, tenantId: string, id: string) {
    return 'account-' + kind + '-' + createHash('sha256').update(JSON.stringify([tenantId, id])).digest('hex').slice(0, 40);
  }

  private async disable(ref: SecretVersion) { await this.deps.secrets.disable(ref).catch(() => undefined); }
}

export function mayUse(actor: Actor, owner: Owner): boolean {
  return actor.kind === 'super-agent' ? owner.kind === 'admin' : owner.kind === 'employee' && owner.id === actor.id;
}
