import type { AccountConnection, AccountStore, OAuthAttempt, Owner } from './accounts.js';

export interface AccountsDb {
  query<T>(text: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface Row {
  id: string; tenant_id: string; owner_kind: Owner['kind']; owner_id: string; provider: 'microsoft'; address: string; display_name: string;
  scopes: string; mail_trigger: boolean; calendar_trigger: boolean; send_rule: AccountConnection['sendRule']; status: AccountConnection['status'];
  grant_ref: AccountConnection['grant']; grant_deadline: Date | string | null; connected_by: string; created_at: Date | string; updated_at: Date | string;
}

const iso = (value: Date | string) => new Date(value).toISOString();
const fromRow = (r: Row): AccountConnection => ({
  id: r.id, tenantId: r.tenant_id, owner: { kind: r.owner_kind, id: r.owner_id }, provider: r.provider, address: r.address, displayName: r.display_name,
  scopes: r.scopes, mailTrigger: r.mail_trigger, calendarTrigger: r.calendar_trigger, sendRule: r.send_rule, status: r.status, grant: r.grant_ref,
  grantDeadline: r.grant_deadline === null ? null : new Date(r.grant_deadline).getTime(), connectedBy: r.connected_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});

export const SAVE_ACCOUNT_SQL = `
INSERT INTO account_connections (id, tenant_id, owner_kind, owner_id, provider, address, display_name, scopes, mail_trigger,
  calendar_trigger, send_rule, status, grant_ref, grant_deadline, connected_by, created_at, updated_at)
VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17)
ON CONFLICT (tenant_id, owner_kind, owner_id, provider, lower(address)) DO UPDATE SET
  display_name = EXCLUDED.display_name, scopes = EXCLUDED.scopes, mail_trigger = EXCLUDED.mail_trigger,
  calendar_trigger = EXCLUDED.calendar_trigger, send_rule = EXCLUDED.send_rule, status = EXCLUDED.status,
  grant_ref = EXCLUDED.grant_ref, grant_deadline = EXCLUDED.grant_deadline, connected_by = EXCLUDED.connected_by,
  updated_at = EXCLUDED.updated_at
RETURNING *`.trim();

export class PgAccountStore implements AccountStore {
  constructor(private readonly db: AccountsDb) {}
  async list(tenantId: string, owner: Owner) {
    const { rows } = await this.db.query<Row>('SELECT * FROM account_connections WHERE tenant_id = $1::uuid AND owner_kind = $2 AND owner_id = $3 ORDER BY created_at', [tenantId, owner.kind, owner.id]);
    return rows.map(fromRow);
  }
  async get(tenantId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { rows } = await this.db.query<Row>('SELECT * FROM account_connections WHERE tenant_id = $1::uuid AND id = $2::uuid', [tenantId, id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
  async save(c: AccountConnection) {
    const { rows } = await this.db.query<Row>(SAVE_ACCOUNT_SQL, [
      c.id, c.tenantId, c.owner.kind, c.owner.id, c.provider, c.address, c.displayName, c.scopes, c.mailTrigger, c.calendarTrigger, c.sendRule,
      c.status, c.grant ? JSON.stringify(c.grant) : null, c.grantDeadline === null ? null : new Date(c.grantDeadline).toISOString(), c.connectedBy, c.createdAt, c.updatedAt,
    ]);
    return fromRow(rows[0]!);
  }
  async remove(tenantId: string, id: string) {
    await this.db.query('DELETE FROM account_connections WHERE tenant_id = $1::uuid AND id = $2::uuid', [tenantId, id]);
  }
  async putAttempt(a: OAuthAttempt) {
    await this.db.query('DELETE FROM account_oauth_attempts WHERE expires_at < now()', []);
    await this.db.query(
      'INSERT INTO account_oauth_attempts (state_hash, tenant_id, user_id, owner_kind, owner_id, verifier_ref, redirect_uri, expires_at) VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, $7, $8)',
      [a.stateHash, a.tenantId, a.userId, a.owner.kind, a.owner.id, JSON.stringify(a.verifier), a.redirectUri, new Date(a.expiresAt).toISOString()],
    );
  }
  async takeAttempt(stateHash: string) {
    const { rows } = await this.db.query<{ state_hash: string; tenant_id: string; user_id: string; owner_kind: Owner['kind']; owner_id: string; verifier_ref: OAuthAttempt['verifier']; redirect_uri: string; expires_at: Date | string }>(
      'DELETE FROM account_oauth_attempts WHERE state_hash = $1 RETURNING *', [stateHash],
    );
    const r = rows[0];
    return r ? { stateHash: r.state_hash, tenantId: r.tenant_id, userId: r.user_id, owner: { kind: r.owner_kind, id: r.owner_id }, verifier: r.verifier_ref, redirectUri: r.redirect_uri, expiresAt: new Date(r.expires_at).getTime() } : null;
  }
}
