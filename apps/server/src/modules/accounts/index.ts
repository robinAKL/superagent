import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { UserContext } from '@superagent/shared';
import { InMemorySecretStore, type SecretStore } from '../setup/secrets.js';
import { roomState } from '../room/index.js';
import { AccountError, AccountService, accountView, MemoryAccountStore, type AccountConnection, type AccountProvider, type AccountStore, type Owner } from './accounts.js';

export const ACCOUNT_CALLBACK = '/accounts/oauth/callback';

/** The service the routes and, later, the mail and calendar triggers use. Rebound at start-up with Key Vault and PG. */
export const accountsState = {
  current: new AccountService({ store: new MemoryAccountStore(), secrets: new InMemorySecretStore(), provider: null }),
};

export function bindAccounts(deps: { store?: AccountStore; secrets: SecretStore; provider: AccountProvider | null; now?: () => number }): void {
  accountsState.current = new AccountService({ store: deps.store ?? new MemoryAccountStore(), secrets: deps.secrets, provider: deps.provider, ...(deps.now ? { now: deps.now } : {}) });
}

const isManager = (user: UserContext) => user.roles.includes('owner') || user.roles.includes('admin');

/** The address Microsoft sends the person back to: this site's own callback, never one a request names. */
export function callbackUrl(req: FastifyRequest): string {
  const origin = process.env.PUBLIC_ORIGIN
    ?? `${process.env.NODE_ENV === 'production' ? 'https' : req.protocol}://${req.headers.host ?? 'localhost'}`;
  return origin.replace(/\/$/, '') + ACCOUNT_CALLBACK;
}

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof AccountError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

/**
 * /api/v1/accounts. An administrator manages their own account (it controls Super Agent) and, as an administrator,
 * the accounts of digital employees. Nobody sees or changes another administrator's own account.
 */
export const accountsModule: FastifyPluginAsync = async (app) => {
  const managerOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !isManager(req.user)) return reply.code(403).send({ error: 'forbidden' });
  };
  const employeeOwner = (user: UserContext, employeeId: unknown): Owner | null => {
    if (typeof employeeId !== 'string' || !employeeId) return null;
    const visible = roomState.current.roster({ userId: user.userId, roles: user.roles, projectScopes: user.projectScopes });
    return visible.some((employee) => employee.id === employeeId) ? { kind: 'employee', id: employeeId } : null;
  };
  /** The owner a person may act for on this row, or null. */
  const mayManage = (user: UserContext, row: AccountConnection) => row.owner.kind === 'admin' ? row.owner.id === user.userId : isManager(user);

  app.get('/config', async () => ({ microsoft: accountsState.current.configured }));

  app.get('/mine', { preHandler: managerOnly }, async (req) => ({
    accounts: (await accountsState.current.list(req.user!.tenantId, { kind: 'admin', id: req.user!.userId })).map(accountView),
  }));

  app.get<{ Params: { employeeId: string } }>('/employees/:employeeId', { preHandler: managerOnly }, async (req, reply) => {
    const owner = employeeOwner(req.user!, req.params.employeeId);
    if (!owner) return reply.code(404).send({ error: 'not_found' });
    return { accounts: (await accountsState.current.list(req.user!.tenantId, owner)).map(accountView) };
  });

  app.post('/connect', { preHandler: managerOnly }, async (req, reply) => {
    const body = (req.body ?? {}) as { employeeId?: unknown };
    const owner: Owner | null = body.employeeId === undefined ? { kind: 'admin', id: req.user!.userId } : employeeOwner(req.user!, body.employeeId);
    if (!owner) return reply.code(404).send({ error: 'not_found' });
    try { return await accountsState.current.start(req.user!.tenantId, req.user!.userId, owner, callbackUrl(req)); }
    catch (error) { return fail(reply, error); }
  });

  app.post('/finish', { preHandler: managerOnly }, async (req, reply) => {
    try {
      const row = await accountsState.current.finish(req.user!.tenantId, req.user!.userId, (req.body ?? {}) as Record<string, unknown>);
      return { account: accountView(row) };
    } catch (error) { return fail(reply, error); }
  });

  app.patch<{ Params: { id: string } }>('/:id', { preHandler: managerOnly }, async (req, reply) => {
    try {
      const row = await accountsState.current.find(req.user!.tenantId, req.params.id);
      if (!row || !mayManage(req.user!, row)) return reply.code(404).send({ error: 'not_found' });
      return { account: accountView(await accountsState.current.update(req.user!.tenantId, row.id, row.owner, (req.body ?? {}) as Record<string, unknown>)) };
    } catch (error) { return fail(reply, error); }
  });

  app.delete<{ Params: { id: string } }>('/:id', { preHandler: managerOnly }, async (req, reply) => {
    try {
      const row = await accountsState.current.find(req.user!.tenantId, req.params.id);
      if (!row || !mayManage(req.user!, row)) return reply.code(404).send({ error: 'not_found' });
      await accountsState.current.disconnect(req.user!.tenantId, row.id, row.owner);
      return { connected: false };
    } catch (error) { return fail(reply, error); }
  });
};

/**
 * Microsoft sends the person back here (outside sign-in). Nothing is redeemed here: the browser carries the state
 * and code to /api/v1/accounts/finish, which only the person who started the sign-in can complete.
 */
export const accountCallbackRoute: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Record<string, unknown> }>(ACCOUNT_CALLBACK, async (req, reply) => {
    const fragment = new URLSearchParams();
    for (const key of ['state', 'code', 'error']) {
      const value = req.query[key];
      if (typeof value === 'string' && value.length <= 4096) fragment.set('acct_' + key, value);
    }
    return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').redirect('/#settings?' + fragment.toString());
  });
};
