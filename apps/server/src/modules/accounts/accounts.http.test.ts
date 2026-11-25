import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { createCommandRoom, roomState } from '../room/index.js';
import { InMemorySecretStore } from '../setup/secrets.js';
import { AccountError, type AccountProvider, type ProviderTokens } from './accounts.js';
import { accountCallbackRoute, accountsModule, accountsState, bindAccounts } from './index.js';
import { MICROSOFT_SCOPES, microsoftProvider } from './microsoft.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const adminA: UserContext = { tenantId, userId: 'admin-a', roles: ['admin'], projectScopes: [] };
const adminB: UserContext = { tenantId, userId: 'admin-b', roles: ['owner'], projectScopes: [] };
const staff: UserContext = { tenantId, userId: 'staff', roles: ['employee'], projectScopes: [] };

/** A provider that signs in whichever mailbox the code names ("code:ops@x.com"). */
function fakeProvider(log: { refreshes: number; failRefresh?: boolean }): AccountProvider {
  const tokens = (who: string): ProviderTokens => ({ access: 'access:' + who, refresh: 'refresh:' + who, expiresIn: 3600, scope: MICROSOFT_SCOPES });
  return {
    id: 'microsoft', scopes: MICROSOFT_SCOPES,
    authorizeUrl: ({ state, challenge, redirectUri }) => `https://login.example/authorize?state=${state}&challenge=${challenge}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    redeem: async ({ code }) => tokens(code.replace('code:', '')),
    refresh: async (refresh) => {
      log.refreshes += 1;
      if (log.failRefresh) throw new AccountError('reauthorize', 'expired', 401);
      return tokens(refresh.replace('refresh:', '') + '#' + log.refreshes);
    },
    whoAmI: async (access) => {
      const address = access.replace('access:', '').split('#')[0]!;
      return { address, displayName: address.split('@')[0]! };
    },
  };
}

let now = Date.parse('2026-11-25T00:00:00Z');
let log = { refreshes: 0 } as { refreshes: number; failRefresh?: boolean };

async function appFor(user: UserContext) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => { request.user = user; });
  await app.register(accountCallbackRoute);
  await app.register(accountsModule, { prefix: '/accounts' });
  return app;
}

/** Signs a mailbox in for an owner, the way the browser does it: connect, then finish with the state it got back. */
async function connect(user: UserContext, address: string, employeeId?: string) {
  const app = await appFor(user);
  const started = await app.inject({ method: 'POST', url: '/accounts/connect', payload: employeeId ? { employeeId } : {} });
  expect(started.statusCode).toBe(200);
  const state = new URL(started.json().authorizationUrl).searchParams.get('state')!;
  const finished = await app.inject({ method: 'POST', url: '/accounts/finish', payload: { state, code: 'code:' + address } });
  return { app, state, finished };
}

beforeEach(() => {
  now = Date.parse('2026-11-25T00:00:00Z');
  log = { refreshes: 0 };
  roomState.current = createCommandRoom(() => [
    { id: 'emp-ops', name: '运营员工', ownerUserId: 'admin-a', status: 'active' },
    { id: 'emp-sales', name: '销售员工', ownerUserId: 'admin-a', status: 'active' },
  ]);
  bindAccounts({ secrets: new InMemorySecretStore(), provider: fakeProvider(log), now: () => now });
});

it('an admin connects their own mailbox; it is theirs alone, not another admin’s and not an employee’s', async () => {
  const { app, finished } = await connect(adminA, 'robin@innopro.co.nz');
  expect(finished.statusCode).toBe(200);
  const account = finished.json().account;
  expect(account).toMatchObject({ owner: { kind: 'admin', id: 'admin-a' }, address: 'robin@innopro.co.nz', status: 'connected', sendRule: 'ask', mailTrigger: false, calendarTrigger: false });
  expect(JSON.stringify(account)).not.toContain('access:');
  expect((await app.inject({ method: 'GET', url: '/accounts/mine' })).json().accounts).toHaveLength(1);

  const other = await appFor(adminB);
  expect((await other.inject({ method: 'GET', url: '/accounts/mine' })).json().accounts).toEqual([]);
  expect((await other.inject({ method: 'PATCH', url: `/accounts/${account.id}`, payload: { mailTrigger: true } })).statusCode).toBe(404);
  expect((await other.inject({ method: 'DELETE', url: `/accounts/${account.id}` })).statusCode).toBe(404);
  expect((await other.inject({ method: 'GET', url: '/accounts/employees/emp-ops' })).json().accounts).toEqual([]);
});

it('a digital employee’s mailbox belongs to that employee; any admin manages it; it never shows as an admin’s', async () => {
  const { app, finished } = await connect(adminA, 'ops@innopro.co.nz', 'emp-ops');
  expect(finished.json().account.owner).toEqual({ kind: 'employee', id: 'emp-ops' });
  expect((await app.inject({ method: 'GET', url: '/accounts/mine' })).json().accounts).toEqual([]);
  expect((await app.inject({ method: 'GET', url: '/accounts/employees/emp-sales' })).json().accounts).toEqual([]);
  const id = finished.json().account.id;

  const other = await appFor(adminB);
  const changed = await other.inject({ method: 'PATCH', url: `/accounts/${id}`, payload: { mailTrigger: true, calendarTrigger: true, sendRule: 'deny' } });
  expect(changed.json().account).toMatchObject({ mailTrigger: true, calendarTrigger: true, sendRule: 'deny' });
  expect((await other.inject({ method: 'PATCH', url: `/accounts/${id}`, payload: { sendRule: 'always' } })).statusCode).toBe(400);
  expect((await other.inject({ method: 'POST', url: '/accounts/connect', payload: { employeeId: 'emp-unknown' } })).statusCode).toBe(404);

  // Signing the same mailbox in again keeps the account and its settings, with a fresh grant.
  const again = await connect(adminB, 'OPS@innopro.co.nz', 'emp-ops');
  expect(again.finished.json().account).toMatchObject({ id, sendRule: 'deny', mailTrigger: true });
  expect((await other.inject({ method: 'GET', url: '/accounts/employees/emp-ops' })).json().accounts).toHaveLength(1);
});

it('only the person who started a sign-in can finish it, once, within ten minutes', async () => {
  const app = await appFor(adminA);
  const state = () => app.inject({ method: 'POST', url: '/accounts/connect', payload: {} }).then((r) => new URL(r.json().authorizationUrl).searchParams.get('state')!);
  const s1 = await state();
  const other = await appFor(adminB);
  expect((await other.inject({ method: 'POST', url: '/accounts/finish', payload: { state: s1, code: 'code:x@y.z' } })).json().error).toBe('invalid_callback');
  // The state was used up by that attempt, even though it failed.
  expect((await app.inject({ method: 'POST', url: '/accounts/finish', payload: { state: s1, code: 'code:x@y.z' } })).json().error).toBe('invalid_callback');
  const s2 = await state();
  now += 11 * 60_000;
  expect((await app.inject({ method: 'POST', url: '/accounts/finish', payload: { state: s2, code: 'code:x@y.z' } })).json().error).toBe('invalid_callback');
  expect((await app.inject({ method: 'GET', url: '/accounts/mine' })).json().accounts).toEqual([]);
});

it('Super Agent may use only admins’ accounts; an employee only its own; tokens refresh, and a dead grant asks for sign-in', async () => {
  const admin = (await connect(adminA, 'robin@innopro.co.nz')).finished.json().account.id;
  const ops = (await connect(adminA, 'ops@innopro.co.nz', 'emp-ops')).finished.json().account.id;
  const service = accountsState.current;
  expect((await service.accountAccess(tenantId, { kind: 'super-agent' }, admin)).token).toBe('access:robin@innopro.co.nz');
  expect((await service.accountAccess(tenantId, { kind: 'employee', id: 'emp-ops' }, ops)).token).toBe('access:ops@innopro.co.nz');
  for (const [actor, id] of [[{ kind: 'super-agent' }, ops], [{ kind: 'employee', id: 'emp-sales' }, ops], [{ kind: 'employee', id: 'emp-ops' }, admin]] as const) {
    await expect(service.accountAccess(tenantId, actor, id)).rejects.toMatchObject({ code: 'not_owner' });
  }
  await expect(service.accountAccess('22222222-2222-4222-8222-222222222222', { kind: 'super-agent' }, admin)).rejects.toMatchObject({ code: 'not_owner' });

  now += 2 * 3600_000;
  expect((await service.accountAccess(tenantId, { kind: 'super-agent' }, admin)).token).toBe('access:robin@innopro.co.nz#1');
  expect(log.refreshes).toBe(1);
  now += 2 * 3600_000;
  log.failRefresh = true;
  await expect(service.accountAccess(tenantId, { kind: 'super-agent' }, admin)).rejects.toMatchObject({ code: 'reauthorize' });
  const app = await appFor(adminA);
  expect((await app.inject({ method: 'GET', url: '/accounts/mine' })).json().accounts[0].status).toBe('reauthorize');
});

it('disconnecting removes the account and its grant; nobody can use it after', async () => {
  const { app, finished } = await connect(adminA, 'robin@innopro.co.nz');
  const id = finished.json().account.id;
  expect((await app.inject({ method: 'DELETE', url: `/accounts/${id}` })).json()).toEqual({ connected: false });
  expect((await app.inject({ method: 'GET', url: '/accounts/mine' })).json().accounts).toEqual([]);
  await expect(accountsState.current.accountAccess(tenantId, { kind: 'super-agent' }, id)).rejects.toMatchObject({ code: 'not_owner' });
});

it('members who are not administrators cannot connect or list accounts; an unconfigured platform says so', async () => {
  const app = await appFor(staff);
  expect((await app.inject({ method: 'GET', url: '/accounts/mine' })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/accounts/connect', payload: {} })).statusCode).toBe(403);
  bindAccounts({ secrets: new InMemorySecretStore(), provider: null });
  const admin = await appFor(adminA);
  expect((await admin.inject({ method: 'GET', url: '/accounts/config' })).json()).toEqual({ microsoft: false });
  const refused = await admin.inject({ method: 'POST', url: '/accounts/connect', payload: {} });
  expect(refused.statusCode).toBe(503);
  expect(refused.json().error).toBe('not_configured');
});

it('the callback hands state and code to the signed-in page and nothing else', async () => {
  const app = await appFor(adminA);
  const back = await app.inject({ method: 'GET', url: '/accounts/oauth/callback?state=abc&code=xyz&session_state=s&other=1' });
  expect(back.statusCode).toBe(302);
  expect(back.headers.location).toBe('/#settings?acct_state=abc&acct_code=xyz');
  expect(back.headers['cache-control']).toBe('no-store');
});

it('the Microsoft sign-in asks for the mailbox’s own mail and calendar with PKCE, and redeems with the platform secret', async () => {
  const calls: { url: string; body?: string }[] = [];
  const network = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
    return String(url).includes('/token')
      ? new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'Mail.ReadWrite' }), { status: 200 })
      : new Response(JSON.stringify({ displayName: 'Ops', mail: 'ops@innopro.co.nz' }), { status: 200 });
  }) as typeof fetch;
  const provider = microsoftProvider({ clientId: 'client', clientSecret: 'secret' }, network);
  const url = new URL(provider.authorizeUrl({ state: 's', challenge: 'c', redirectUri: 'https://app/accounts/oauth/callback' }));
  expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
  expect(url.searchParams.get('scope')).toContain('Calendars.ReadWrite');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(await provider.redeem({ code: 'code', verifier: 'v', redirectUri: 'https://app/accounts/oauth/callback' })).toMatchObject({ access: 'at', refresh: 'rt', expiresIn: 3599 });
  expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual(({ client_id: 'client', client_secret: 'secret', scope: MICROSOFT_SCOPES, grant_type: 'authorization_code', code: 'code', code_verifier: 'v', redirect_uri: 'https://app/accounts/oauth/callback' }));
  expect(calls[1]?.url).toBeUndefined();
  expect(await provider.whoAmI('at')).toEqual({ address: 'ops@innopro.co.nz', displayName: 'Ops' });
});
