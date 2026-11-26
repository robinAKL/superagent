/**
 * The company directory (SaaS step 1b). A company is a customer organisation, recognised by its Microsoft Entra
 * directory id; people belong to it through a membership with roles kept here. Colleagues from the same directory
 * ask to join and an administrator approves (or the company lets them join directly); anyone else is invited by
 * email address. Nothing here trusts a company named by the client: every decision starts from the verified identity.
 */
import { randomUUID } from 'node:crypto';
import { ROLES, type Role, type UserContext } from '@superagent/shared';

export interface Identity {
  /** Entra directory (tenant) id of the account. */
  tid: string;
  /** Object id of the account in that directory; used as the user id everywhere. */
  oid: string;
  email: string | null;
  name: string;
  /** App roles in the token (only honoured for the platform company's own directory). */
  tokenRoles: Role[];
}

export interface Company {
  id: string;
  name: string;
  entraTenantId: string | null;
  status: 'active' | 'suspended';
  timezone: string;
  settings: { autoJoin?: boolean };
  createdAt: string;
}

export interface Member {
  tenantId: string;
  userId: string;
  entraTid: string | null;
  email: string | null;
  displayName: string;
  roles: Role[];
  status: 'active' | 'removed';
  createdAt: string;
}

export interface Invite {
  id: string;
  tenantId: string;
  email: string;
  roles: Role[];
  invitedBy: string;
  createdAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
}

export interface JoinRequest {
  id: string;
  tenantId: string;
  entraTid: string;
  entraOid: string;
  email: string | null;
  displayName: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface DirectoryStore {
  company(id: string): Promise<Company | null>;
  companyByDirectory(tid: string): Promise<Company | null>;
  saveCompany(company: Company, createdBy?: string): Promise<void>;
  /** Active and removed memberships of one account, across companies. */
  membershipsOf(tid: string, oid: string): Promise<Member[]>;
  members(tenantId: string): Promise<Member[]>;
  saveMember(member: Member): Promise<void>;
  invites(tenantId: string): Promise<Invite[]>;
  openInvitesFor(email: string): Promise<Invite[]>;
  invite(id: string): Promise<Invite | null>;
  saveInvite(invite: Invite): Promise<void>;
  deleteInvite(tenantId: string, id: string): Promise<void>;
  joinRequests(tenantId: string): Promise<JoinRequest[]>;
  joinRequestsOf(oid: string): Promise<JoinRequest[]>;
  saveJoinRequest(request: JoinRequest): Promise<void>;
}

export class TenancyError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

const MANAGERS: Role[] = ['owner', 'admin'];
const isManager = (roles: readonly Role[]) => roles.some((r) => MANAGERS.includes(r));
const cleanRoles = (value: unknown): Role[] => Array.isArray(value)
  ? [...new Set(value.filter((r): r is Role => (ROLES as readonly string[]).includes(String(r))))]
  : [];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TenancyOptions {
  /** The single-company deployment's company and its directory: its people keep their token roles. */
  platformTenantId: string;
  platformDirectory?: string | null;
  now?: () => number;
}

export interface MeView {
  identity: { name: string; email: string | null };
  memberships: Array<{ tenantId: string; name: string; roles: Role[] }>;
  /** The company registered for this person's directory, when they are not a member of it. */
  directoryCompany: { id: string; name: string; autoJoin: boolean } | null;
  pendingRequest: { tenantId: string; name: string; createdAt: string } | null;
  invites: Array<{ id: string; tenantId: string; name: string; roles: Role[] }>;
}

export class TenancyService {
  private now: () => number;
  constructor(private store: DirectoryStore, private options: TenancyOptions) {
    this.now = options.now ?? Date.now;
  }

  private stamp(): string { return new Date(this.now()).toISOString(); }

  /** Active memberships, the platform directory's people included with their token roles. */
  private async activeMemberships(identity: Identity): Promise<Member[]> {
    const rows = (await this.store.membershipsOf(identity.tid, identity.oid)).filter((m) => m.status === 'active');
    const platform = this.options.platformDirectory && identity.tid === this.options.platformDirectory;
    if (!platform) return rows;
    const existing = rows.find((m) => m.tenantId === this.options.platformTenantId);
    if (existing) {
      // App roles from Microsoft that the membership does not hold yet are recorded, so the member list shows the
      // role the person really has and the last-owner rule counts them.
      const merged = [...new Set([...existing.roles, ...identity.tokenRoles])];
      if (merged.length !== existing.roles.length) await this.store.saveMember({ ...existing, roles: merged, email: existing.email ?? identity.email, displayName: identity.name });
      return rows.map((m) => m === existing ? { ...m, roles: merged } : m);
    }
    // A person of the platform company's own directory: recorded on first sign-in so administrators can see them.
    const removed = (await this.store.membershipsOf(identity.tid, identity.oid)).some((m) => m.tenantId === this.options.platformTenantId);
    if (removed) return rows;
    const member: Member = {
      tenantId: this.options.platformTenantId, userId: identity.oid, entraTid: identity.tid, email: identity.email,
      displayName: identity.name, roles: identity.tokenRoles, status: 'active', createdAt: this.stamp(),
    };
    await this.store.saveMember(member);
    return [...rows, member];
  }

  /** Development identities: the header's company is theirs; recorded once so member lists show who is around. */
  async devMember(user: UserContext, identity: Identity): Promise<void> {
    const rows = await this.store.members(user.tenantId);
    const row = rows.find((m) => m.userId === user.userId);
    if (row && row.status === 'active' && row.roles.join() === user.roles.join()) return;
    if (row?.status === 'removed') return;
    if (!await this.store.company(user.tenantId)) {
      await this.store.saveCompany({ id: user.tenantId, name: user.tenantId === this.options.platformTenantId ? 'INNOPRO' : user.tenantId, entraTenantId: identity.tid, status: 'active', timezone: 'Pacific/Auckland', settings: {}, createdAt: this.stamp() });
    }
    await this.store.saveMember({ tenantId: user.tenantId, userId: user.userId, entraTid: identity.tid, email: identity.email, displayName: identity.name, roles: user.roles, status: 'active', createdAt: row?.createdAt ?? this.stamp() });
  }

  /**
   * The signed-in person in one company: the one they asked for when they belong to it, otherwise their first.
   * Null when they belong to none yet (they are offered sign-up, a join request or their invitations).
   */
  async resolve(identity: Identity, requested?: string | null): Promise<UserContext | null> {
    const rows = await this.activeMemberships(identity);
    const companies = await Promise.all(rows.map(async (m) => ({ m, c: await this.store.company(m.tenantId) })));
    const usable = companies.filter(({ c }) => !c || c.status === 'active').map(({ m }) => m);
    const chosen = usable.find((m) => m.tenantId === requested) ?? usable[0];
    if (!chosen) return null;
    return { tenantId: chosen.tenantId, userId: identity.oid, roles: chosen.roles, projectScopes: [] };
  }

  async me(identity: Identity): Promise<MeView> {
    const rows = await this.activeMemberships(identity);
    const memberships = await Promise.all(rows.map(async (m) => ({ tenantId: m.tenantId, name: (await this.store.company(m.tenantId))?.name ?? 'INNOPRO', roles: m.roles })));
    const own = await this.store.companyByDirectory(identity.tid);
    const directoryCompany = own && !rows.some((m) => m.tenantId === own.id) ? { id: own.id, name: own.name, autoJoin: own.settings.autoJoin === true } : null;
    const pending = (await this.store.joinRequestsOf(identity.oid)).find((r) => r.status === 'pending' && r.entraTid === identity.tid);
    const invites = identity.email ? await this.store.openInvitesFor(identity.email) : [];
    return {
      identity: { name: identity.name, email: identity.email },
      memberships,
      directoryCompany,
      pendingRequest: pending ? { tenantId: pending.tenantId, name: (await this.store.company(pending.tenantId))?.name ?? '', createdAt: pending.createdAt } : null,
      invites: await Promise.all(invites.filter((i) => !rows.some((m) => m.tenantId === i.tenantId))
        .map(async (i) => ({ id: i.id, tenantId: i.tenantId, name: (await this.store.company(i.tenantId))?.name ?? '', roles: i.roles }))),
    };
  }

  /** The first person of an organisation creates its company and becomes its owner. One company per directory. */
  async signUp(identity: Identity, input: { name?: unknown; timezone?: unknown }): Promise<Company> {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
    if (!name) throw new TenancyError('name_required', '请填写公司名称。');
    if (await this.store.companyByDirectory(identity.tid)) throw new TenancyError('company_exists', '你所在的组织已经注册了公司，请申请加入。', 409);
    const company: Company = {
      id: randomUUID(), name, entraTenantId: identity.tid, status: 'active',
      timezone: typeof input.timezone === 'string' && input.timezone ? input.timezone.slice(0, 64) : 'Pacific/Auckland',
      settings: { autoJoin: false }, createdAt: this.stamp(),
    };
    await this.store.saveCompany(company, identity.oid);
    await this.store.saveMember({ tenantId: company.id, userId: identity.oid, entraTid: identity.tid, email: identity.email, displayName: identity.name, roles: ['owner'], status: 'active', createdAt: this.stamp() });
    return company;
  }

  /** A colleague from the company's own directory asks to join; with auto-join on they are in at once. */
  async requestJoin(identity: Identity): Promise<{ status: 'joined' | 'pending' }> {
    const company = await this.store.companyByDirectory(identity.tid);
    if (!company || company.status !== 'active') throw new TenancyError('no_company', '你所在的组织还没有注册公司。', 404);
    const rows = await this.store.membershipsOf(identity.tid, identity.oid);
    const membership = rows.find((m) => m.tenantId === company.id);
    if (membership?.status === 'active') return { status: 'joined' };
    if (company.settings.autoJoin) {
      await this.store.saveMember({ tenantId: company.id, userId: identity.oid, entraTid: identity.tid, email: identity.email, displayName: identity.name, roles: ['employee'], status: 'active', createdAt: this.stamp() });
      return { status: 'joined' };
    }
    const pending = (await this.store.joinRequests(company.id)).find((r) => r.status === 'pending' && r.entraOid === identity.oid);
    if (!pending) {
      await this.store.saveJoinRequest({ id: randomUUID(), tenantId: company.id, entraTid: identity.tid, entraOid: identity.oid, email: identity.email, displayName: identity.name, status: 'pending', createdAt: this.stamp(), decidedBy: null, decidedAt: null });
    }
    return { status: 'pending' };
  }

  /** An invitation is accepted by the person signed in with the invited address, from any organisation. */
  async acceptInvite(identity: Identity, inviteId: string): Promise<Company> {
    const invite = await this.store.invite(inviteId);
    if (!invite || invite.acceptedAt || !identity.email || invite.email.toLowerCase() !== identity.email.toLowerCase()) {
      throw new TenancyError('invite_not_found', '找不到这份邀请，或者它不是发给你的。', 404);
    }
    const company = await this.store.company(invite.tenantId);
    if (!company || company.status !== 'active') throw new TenancyError('invite_not_found', '邀请的公司已停用。', 404);
    await this.store.saveMember({ tenantId: company.id, userId: identity.oid, entraTid: identity.tid, email: identity.email, displayName: identity.name, roles: invite.roles, status: 'active', createdAt: this.stamp() });
    await this.store.saveInvite({ ...invite, acceptedAt: this.stamp(), acceptedBy: identity.oid });
    return company;
  }

  // ----- company administration (owner and admin) -----

  private requireManager(user: UserContext): void {
    if (!isManager(user.roles)) throw new TenancyError('forbidden', '只有管理员可以管理成员。', 403);
  }

  async company(user: UserContext): Promise<Company> {
    const company = await this.store.company(user.tenantId);
    if (company) return company;
    return { id: user.tenantId, name: 'INNOPRO', entraTenantId: null, status: 'active', timezone: 'Pacific/Auckland', settings: {}, createdAt: this.stamp() };
  }

  async updateCompany(user: UserContext, input: { name?: unknown; autoJoin?: unknown }): Promise<Company> {
    this.requireManager(user);
    const company = await this.company(user);
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 120) : company.name;
    const next: Company = { ...company, name, settings: { ...company.settings, ...(typeof input.autoJoin === 'boolean' ? { autoJoin: input.autoJoin } : {}) } };
    await this.store.saveCompany(next);
    return next;
  }

  async members(user: UserContext): Promise<Member[]> {
    return (await this.store.members(user.tenantId)).filter((m) => m.status === 'active');
  }

  async setRoles(user: UserContext, userId: string, rolesInput: unknown): Promise<Member> {
    this.requireManager(user);
    const roles = cleanRoles(rolesInput);
    const members = await this.members(user);
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new TenancyError('member_not_found', '找不到这位成员。', 404);
    const grantsOwner = roles.includes('owner') !== target.roles.includes('owner');
    if (grantsOwner && !user.roles.includes('owner')) throw new TenancyError('owner_only', '只有所有者可以设置或取消所有者。', 403);
    if (target.roles.includes('owner') && !roles.includes('owner') && members.filter((m) => m.roles.includes('owner')).length <= 1) {
      throw new TenancyError('last_owner', '公司至少要保留一位所有者。', 409);
    }
    const next = { ...target, roles };
    await this.store.saveMember(next);
    return next;
  }

  async removeMember(user: UserContext, userId: string): Promise<void> {
    if (userId !== user.userId) this.requireManager(user);
    const members = await this.members(user);
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new TenancyError('member_not_found', '找不到这位成员。', 404);
    if (target.roles.includes('owner') && members.filter((m) => m.roles.includes('owner')).length <= 1) {
      throw new TenancyError('last_owner', '公司至少要保留一位所有者。', 409);
    }
    if (target.roles.includes('owner') && userId !== user.userId && !user.roles.includes('owner')) throw new TenancyError('owner_only', '只有所有者可以移除所有者。', 403);
    await this.store.saveMember({ ...target, status: 'removed' });
  }

  async invites(user: UserContext): Promise<Invite[]> {
    this.requireManager(user);
    return (await this.store.invites(user.tenantId)).filter((i) => !i.acceptedAt);
  }

  async invite(user: UserContext, input: { email?: unknown; roles?: unknown }): Promise<Invite> {
    this.requireManager(user);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new TenancyError('bad_email', '请填写有效的邮箱地址。');
    const roles = cleanRoles(input.roles ?? ['employee']);
    if (!roles.length) throw new TenancyError('roles_required', '请至少选择一个角色。');
    if (roles.includes('owner') && !user.roles.includes('owner')) throw new TenancyError('owner_only', '只有所有者可以邀请所有者。', 403);
    if ((await this.members(user)).some((m) => m.email?.toLowerCase() === email)) throw new TenancyError('already_member', '这位已经是公司成员。', 409);
    const open = (await this.store.invites(user.tenantId)).find((i) => !i.acceptedAt && i.email === email);
    const invite: Invite = open ? { ...open, roles } : { id: randomUUID(), tenantId: user.tenantId, email, roles, invitedBy: user.userId, createdAt: this.stamp(), acceptedAt: null, acceptedBy: null };
    await this.store.saveInvite(invite);
    return invite;
  }

  async revokeInvite(user: UserContext, id: string): Promise<void> {
    this.requireManager(user);
    await this.store.deleteInvite(user.tenantId, id);
  }

  async joinRequests(user: UserContext): Promise<JoinRequest[]> {
    this.requireManager(user);
    return (await this.store.joinRequests(user.tenantId)).filter((r) => r.status === 'pending');
  }

  async decide(user: UserContext, id: string, approve: boolean, rolesInput?: unknown): Promise<JoinRequest> {
    this.requireManager(user);
    const request = (await this.store.joinRequests(user.tenantId)).find((r) => r.id === id && r.status === 'pending');
    if (!request) throw new TenancyError('request_not_found', '找不到这条加入申请。', 404);
    const decided: JoinRequest = { ...request, status: approve ? 'approved' : 'denied', decidedBy: user.userId, decidedAt: this.stamp() };
    if (approve) {
      const roles = cleanRoles(rolesInput ?? ['employee']);
      if (roles.includes('owner') && !user.roles.includes('owner')) throw new TenancyError('owner_only', '只有所有者可以设置所有者。', 403);
      await this.store.saveMember({ tenantId: user.tenantId, userId: request.entraOid, entraTid: request.entraTid, email: request.email, displayName: request.displayName, roles: roles.length ? roles : ['employee'], status: 'active', createdAt: this.stamp() });
    }
    await this.store.saveJoinRequest(decided);
    return decided;
  }
}

/** In-process directory for development and tests. */
export class MemoryDirectoryStore implements DirectoryStore {
  companies = new Map<string, Company>();
  memberRows: Member[] = [];
  inviteRows: Invite[] = [];
  requestRows: JoinRequest[] = [];
  async company(id: string) { return this.companies.get(id) ?? null; }
  async companyByDirectory(tid: string) { return [...this.companies.values()].find((c) => c.entraTenantId === tid) ?? null; }
  async saveCompany(company: Company) { this.companies.set(company.id, structuredClone(company)); }
  async membershipsOf(tid: string, oid: string) {
    return this.memberRows.filter((m) => m.userId === oid && (m.entraTid === tid || (m.entraTid === null && this.companies.get(m.tenantId)?.entraTenantId === tid))).map((m) => structuredClone(m));
  }
  async members(tenantId: string) { return this.memberRows.filter((m) => m.tenantId === tenantId).map((m) => structuredClone(m)); }
  async saveMember(member: Member) {
    const i = this.memberRows.findIndex((m) => m.tenantId === member.tenantId && m.userId === member.userId);
    if (i >= 0) this.memberRows[i] = structuredClone(member); else this.memberRows.push(structuredClone(member));
  }
  async invites(tenantId: string) { return this.inviteRows.filter((i) => i.tenantId === tenantId).map((i) => structuredClone(i)); }
  async openInvitesFor(email: string) { return this.inviteRows.filter((i) => !i.acceptedAt && i.email === email.toLowerCase()).map((i) => structuredClone(i)); }
  async invite(id: string) { const row = this.inviteRows.find((i) => i.id === id); return row ? structuredClone(row) : null; }
  async saveInvite(invite: Invite) {
    const i = this.inviteRows.findIndex((row) => row.id === invite.id);
    if (i >= 0) this.inviteRows[i] = structuredClone(invite); else this.inviteRows.push(structuredClone(invite));
  }
  async deleteInvite(tenantId: string, id: string) { this.inviteRows = this.inviteRows.filter((i) => !(i.tenantId === tenantId && i.id === id)); }
  async joinRequests(tenantId: string) { return this.requestRows.filter((r) => r.tenantId === tenantId).map((r) => structuredClone(r)); }
  async joinRequestsOf(oid: string) { return this.requestRows.filter((r) => r.entraOid === oid).map((r) => structuredClone(r)); }
  async saveJoinRequest(request: JoinRequest) {
    const i = this.requestRows.findIndex((r) => r.id === request.id);
    if (i >= 0) this.requestRows[i] = structuredClone(request); else this.requestRows.push(structuredClone(request));
  }
}
