/**
 * The company directory (SaaS step 1b): a company is an organisation, not an email domain. The first person of a
 * directory creates the company and owns it; colleagues from the same directory ask to join and an administrator
 * approves; people from elsewhere are invited by email; roles live in the membership; a company keeps an owner.
 */
import { describe, expect, it } from 'vitest';
import { MemoryDirectoryStore, TenancyService, type Identity } from '../src/modules/tenancy/directory.js';

const PLATFORM = '00000000-0000-4000-8000-000000000001';
const PLATFORM_DIR = 'dir-innopro';
const person = (oid: string, tid: string, email: string, tokenRoles: Identity['tokenRoles'] = []): Identity => ({ oid, tid, email, name: oid, tokenRoles });

function setup() {
  const store = new MemoryDirectoryStore();
  let t = Date.parse('2026-11-26T00:00:00Z');
  const service = new TenancyService(store, { platformTenantId: PLATFORM, platformDirectory: PLATFORM_DIR, now: () => (t += 1000) });
  return { store, service };
}

describe('company directory', () => {
  it('the platform directory keeps working with token roles; other organisations start with no company', async () => {
    const { service } = setup();
    const staff = await service.resolve(person('robin', PLATFORM_DIR, 'robin@innopro.co.nz', ['owner']));
    expect(staff).toMatchObject({ tenantId: PLATFORM, userId: 'robin', roles: ['owner'] });
    expect(await service.resolve(person('ana', 'dir-acme', 'ana@acme.co.nz'))).toBeNull();
    const me = await service.me(person('ana', 'dir-acme', 'ana@acme.co.nz'));
    expect(me.memberships).toEqual([]);
    expect(me.directoryCompany).toBeNull();
  });

  it('the first person creates the company and owns it; one company per directory', async () => {
    const { service } = setup();
    const ana = person('ana', 'dir-acme', 'ana@acme.co.nz');
    const company = await service.signUp(ana, { name: 'Acme Trading' });
    expect(await service.resolve(ana)).toMatchObject({ tenantId: company.id, roles: ['owner'] });
    await expect(service.signUp(person('ben', 'dir-acme', 'ben@acme.co.nz'), { name: 'Acme 2' })).rejects.toMatchObject({ code: 'company_exists' });
    await expect(service.signUp(person('x', 'dir-x', 'x@x.co'), { name: '  ' })).rejects.toMatchObject({ code: 'name_required' });
  });

  it('a colleague asks to join and waits; an administrator approves with a role; auto-join lets the next one straight in', async () => {
    const { service } = setup();
    const ana = person('ana', 'dir-acme', 'ana@acme.co.nz');
    const company = await service.signUp(ana, { name: 'Acme Trading' });
    const owner = (await service.resolve(ana))!;
    const ben = person('ben', 'dir-acme', 'ben@acme.co.nz');
    expect((await service.me(ben)).directoryCompany).toMatchObject({ id: company.id, name: 'Acme Trading' });
    expect(await service.requestJoin(ben)).toEqual({ status: 'pending' });
    expect(await service.requestJoin(ben)).toEqual({ status: 'pending' });
    expect(await service.resolve(ben)).toBeNull();
    expect((await service.me(ben)).pendingRequest).toMatchObject({ tenantId: company.id });
    const [request] = await service.joinRequests(owner);
    expect(request).toMatchObject({ entraOid: 'ben', status: 'pending' });
    await service.decide(owner, request!.id, true, ['admin']);
    expect(await service.resolve(ben)).toMatchObject({ tenantId: company.id, roles: ['admin'] });
    expect(await service.joinRequests(owner)).toEqual([]);

    await service.updateCompany(owner, { autoJoin: true });
    expect(await service.requestJoin(person('cara', 'dir-acme', 'cara@acme.co.nz'))).toEqual({ status: 'joined' });
    expect(await service.resolve(person('cara', 'dir-acme', 'cara@acme.co.nz'))).toMatchObject({ roles: ['employee'] });
  });

  it('an invitation is accepted only by the invited address, from any organisation', async () => {
    const { service } = setup();
    const ana = person('ana', 'dir-acme', 'ana@acme.co.nz');
    const company = await service.signUp(ana, { name: 'Acme Trading' });
    const owner = (await service.resolve(ana))!;
    const invite = await service.invite(owner, { email: 'Dan@Accounting.co.nz', roles: ['reviewer'] });
    await expect(service.acceptInvite(person('eve', 'dir-other', 'eve@other.co'), invite.id)).rejects.toMatchObject({ code: 'invite_not_found' });
    const dan = person('dan', 'dir-accounting', 'dan@accounting.co.nz');
    expect((await service.me(dan)).invites).toEqual([expect.objectContaining({ id: invite.id, name: 'Acme Trading', roles: ['reviewer'] })]);
    await service.acceptInvite(dan, invite.id);
    expect(await service.resolve(dan)).toMatchObject({ tenantId: company.id, roles: ['reviewer'] });
    await expect(service.acceptInvite(dan, invite.id)).rejects.toMatchObject({ code: 'invite_not_found' });
  });

  it('roles are managed by administrators; only an owner grants owner; the last owner stays', async () => {
    const { service } = setup();
    const ana = person('ana', 'dir-acme', 'ana@acme.co.nz');
    await service.signUp(ana, { name: 'Acme Trading' });
    const owner = (await service.resolve(ana))!;
    const ben = person('ben', 'dir-acme', 'ben@acme.co.nz');
    await service.requestJoin(ben);
    await service.decide(owner, (await service.joinRequests(owner))[0]!.id, true, ['employee']);
    const employee = (await service.resolve(ben))!;
    await expect(service.members(employee)).resolves.toHaveLength(2);
    await expect(service.invite(employee, { email: 'z@z.co' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service.setRoles(owner, 'ana', ['admin'])).rejects.toMatchObject({ code: 'last_owner' });
    await expect(service.removeMember(owner, 'ana')).rejects.toMatchObject({ code: 'last_owner' });
    await service.setRoles(owner, 'ben', ['admin']);
    const admin = (await service.resolve(ben))!;
    await expect(service.setRoles(admin, 'ana', ['admin'])).rejects.toMatchObject({ code: 'owner_only' });
    await service.removeMember(owner, 'ben');
    expect(await service.resolve(ben)).toBeNull();
  });

  it('someone in two companies works in the one they pick, and in no other', async () => {
    const { service } = setup();
    const ana = person('ana', 'dir-acme', 'ana@acme.co.nz');
    const acme = await service.signUp(ana, { name: 'Acme Trading' });
    const bob = person('bob', 'dir-bolt', 'bob@bolt.co.nz');
    const bolt = await service.signUp(bob, { name: 'Bolt Builders' });
    const boltOwner = (await service.resolve(bob))!;
    await service.acceptInvite(ana, (await service.invite(boltOwner, { email: 'ana@acme.co.nz', roles: ['employee'] })).id);
    expect(await service.resolve(ana, bolt.id)).toMatchObject({ tenantId: bolt.id, roles: ['employee'] });
    expect(await service.resolve(ana, acme.id)).toMatchObject({ tenantId: acme.id, roles: ['owner'] });
    expect((await service.resolve(ana, 'some-other-company'))?.tenantId).toBe(acme.id);
    expect((await service.me(ana)).memberships.map((m) => m.name).sort()).toEqual(['Acme Trading', 'Bolt Builders']);
  });
});
