/** PostgreSQL company directory: tenants, users (memberships), tenant_invites, tenant_join_requests (migration 0025). */
import type { Role } from '@superagent/shared';
import type { Company, DirectoryStore, Invite, JoinRequest, Member } from './directory.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface CompanyRow { id: string; name: string; entra_tenant_id: string | null; status: string; timezone: string; settings: Company['settings'] | null; created_at: Date | string }
interface MemberRow { tenant_id: string; entra_oid: string; entra_tid: string | null; email: string | null; display_name: string; roles: Role[]; status: string; created_at: Date | string }
interface InviteRow { id: string; tenant_id: string; email: string; roles: Role[]; invited_by: string; created_at: Date | string; accepted_at: Date | string | null; accepted_by: string | null }
interface RequestRow { id: string; tenant_id: string; entra_tid: string; entra_oid: string; email: string | null; display_name: string; status: string; created_at: Date | string; decided_by: string | null; decided_at: Date | string | null }

const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const company = (r: CompanyRow): Company => ({
  id: r.id, name: r.name, entraTenantId: r.entra_tenant_id, status: r.status === 'suspended' ? 'suspended' : 'active',
  timezone: r.timezone, settings: r.settings ?? {}, createdAt: iso(r.created_at)!,
});
const member = (r: MemberRow): Member => ({
  tenantId: r.tenant_id, userId: r.entra_oid, entraTid: r.entra_tid, email: r.email, displayName: r.display_name,
  roles: Array.isArray(r.roles) ? r.roles : [], status: r.status === 'removed' ? 'removed' : 'active', createdAt: iso(r.created_at)!,
});
const invite = (r: InviteRow): Invite => ({
  id: r.id, tenantId: r.tenant_id, email: r.email, roles: Array.isArray(r.roles) ? r.roles : [], invitedBy: r.invited_by,
  createdAt: iso(r.created_at)!, acceptedAt: iso(r.accepted_at), acceptedBy: r.accepted_by,
});
const request = (r: RequestRow): JoinRequest => ({
  id: r.id, tenantId: r.tenant_id, entraTid: r.entra_tid, entraOid: r.entra_oid, email: r.email, displayName: r.display_name,
  status: r.status === 'approved' ? 'approved' : r.status === 'denied' ? 'denied' : 'pending',
  createdAt: iso(r.created_at)!, decidedBy: r.decided_by, decidedAt: iso(r.decided_at),
});

const COMPANY_COLS = 'id::text AS id, name, entra_tenant_id, status, timezone, settings, created_at';
const MEMBER_COLS = 'tenant_id::text AS tenant_id, entra_oid, entra_tid, email, display_name, roles, status, created_at';
const INVITE_COLS = 'id::text AS id, tenant_id::text AS tenant_id, email, roles, invited_by, created_at, accepted_at, accepted_by';
const REQUEST_COLS = 'id::text AS id, tenant_id::text AS tenant_id, entra_tid, entra_oid, email, display_name, status, created_at, decided_by, decided_at';

export class PgDirectoryStore implements DirectoryStore {
  constructor(private db: Queryable) {}

  async company(id: string) {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<CompanyRow>(`SELECT ${COMPANY_COLS} FROM tenants WHERE id = $1::uuid`, [id]);
    return rows[0] ? company(rows[0]) : null;
  }
  async companyByDirectory(tid: string) {
    const { rows } = await this.db.query<CompanyRow>(`SELECT ${COMPANY_COLS} FROM tenants WHERE entra_tenant_id = $1`, [tid]);
    return rows[0] ? company(rows[0]) : null;
  }
  async saveCompany(c: Company, createdBy?: string) {
    await this.db.query(`
      INSERT INTO tenants (id, name, entra_tenant_id, status, timezone, settings, created_by)
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, timezone = EXCLUDED.timezone, settings = EXCLUDED.settings`,
    [c.id, c.name, c.entraTenantId, c.status, c.timezone, JSON.stringify(c.settings), createdBy ?? null]);
  }
  async membershipsOf(tid: string, oid: string) {
    const { rows } = await this.db.query<MemberRow>(`
      SELECT u.tenant_id::text AS tenant_id, u.entra_oid, u.entra_tid, u.email, u.display_name, u.roles, u.status, u.created_at
      FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.entra_oid = $2 AND (u.entra_tid = $1 OR (u.entra_tid IS NULL AND t.entra_tenant_id = $1))
      ORDER BY u.updated_at DESC`, [tid, oid]);
    return rows.map(member);
  }
  async members(tenantId: string) {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<MemberRow>(`SELECT ${MEMBER_COLS} FROM users WHERE tenant_id = $1::uuid ORDER BY created_at`, [tenantId]);
    return rows.map(member);
  }
  async saveMember(m: Member) {
    if (!UUID.test(m.tenantId)) return;
    await this.db.query(`
      INSERT INTO users (tenant_id, entra_oid, entra_tid, email, display_name, roles, status, updated_at)
      VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, now())
      ON CONFLICT (tenant_id, entra_oid) DO UPDATE SET entra_tid = coalesce(EXCLUDED.entra_tid, users.entra_tid),
        email = coalesce(EXCLUDED.email, users.email), display_name = EXCLUDED.display_name, roles = EXCLUDED.roles,
        status = EXCLUDED.status, updated_at = now()`,
    [m.tenantId, m.userId, m.entraTid, m.email, m.displayName, JSON.stringify(m.roles), m.status]);
  }
  async invites(tenantId: string) {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<InviteRow>(`SELECT ${INVITE_COLS} FROM tenant_invites WHERE tenant_id = $1::uuid ORDER BY created_at DESC`, [tenantId]);
    return rows.map(invite);
  }
  async openInvitesFor(email: string) {
    const { rows } = await this.db.query<InviteRow>(`SELECT ${INVITE_COLS} FROM tenant_invites WHERE lower(email) = lower($1) AND accepted_at IS NULL`, [email]);
    return rows.map(invite);
  }
  async invite(id: string) {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<InviteRow>(`SELECT ${INVITE_COLS} FROM tenant_invites WHERE id = $1::uuid`, [id]);
    return rows[0] ? invite(rows[0]) : null;
  }
  async saveInvite(i: Invite) {
    await this.db.query(`
      INSERT INTO tenant_invites (id, tenant_id, email, roles, invited_by, accepted_at, accepted_by)
      VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7)
      ON CONFLICT (id) DO UPDATE SET roles = EXCLUDED.roles, accepted_at = EXCLUDED.accepted_at, accepted_by = EXCLUDED.accepted_by`,
    [i.id, i.tenantId, i.email, JSON.stringify(i.roles), i.invitedBy, i.acceptedAt, i.acceptedBy]);
  }
  async deleteInvite(tenantId: string, id: string) {
    if (!UUID.test(id) || !UUID.test(tenantId)) return;
    await this.db.query('DELETE FROM tenant_invites WHERE tenant_id = $1::uuid AND id = $2::uuid AND accepted_at IS NULL', [tenantId, id]);
  }
  async joinRequests(tenantId: string) {
    if (!UUID.test(tenantId)) return [];
    const { rows } = await this.db.query<RequestRow>(`SELECT ${REQUEST_COLS} FROM tenant_join_requests WHERE tenant_id = $1::uuid ORDER BY created_at`, [tenantId]);
    return rows.map(request);
  }
  async joinRequestsOf(oid: string) {
    const { rows } = await this.db.query<RequestRow>(`SELECT ${REQUEST_COLS} FROM tenant_join_requests WHERE entra_oid = $1 ORDER BY created_at DESC`, [oid]);
    return rows.map(request);
  }
  async saveJoinRequest(r: JoinRequest) {
    await this.db.query(`
      INSERT INTO tenant_join_requests (id, tenant_id, entra_tid, entra_oid, email, display_name, status, decided_by, decided_at)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, decided_by = EXCLUDED.decided_by, decided_at = EXCLUDED.decided_at`,
    [r.id, r.tenantId, r.entraTid, r.entraOid, r.email, r.displayName, r.status, r.decidedBy, r.decidedAt]);
  }
}
