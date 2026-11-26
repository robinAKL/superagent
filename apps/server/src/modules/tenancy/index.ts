/**
 * /api/v1/tenancy: the company directory. The first routes work for a verified person who belongs to no company yet
 * (what am I, create my company, ask to join, accept an invitation); the rest manage the signed-in company and are
 * limited to its owners and administrators by TenancyService.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { TenancyError, type Identity, type TenancyService } from './directory.js';

export const tenancyState: { service: TenancyService | null } = { service: null };

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof TenancyError) return reply.code(error.status).send({ error: error.code, message: error.message });
  throw error;
}

export const tenancyModule: FastifyPluginAsync = async (app) => {
  const service = (): TenancyService => {
    if (!tenancyState.service) throw new TenancyError('unavailable', 'company directory is not configured', 503);
    return tenancyState.service;
  };
  const who = (req: FastifyRequest): Identity => req.identity!;
  const company = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) return req.user;
    reply.code(403).send({ error: 'no_company' });
    return null;
  };
  const run = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (error) { return fail(reply, error); }
  };

  app.get('/me', async (req, reply) => run(reply, async () => {
    const me = await service().me(who(req));
    // The company of this request (a development identity names it directly).
    if (req.user && !me.memberships.some((m) => m.tenantId === req.user!.tenantId)) {
      me.memberships.unshift({ tenantId: req.user.tenantId, name: (await service().company(req.user)).name, roles: req.user.roles });
    }
    return { ...me, current: req.user?.tenantId ?? null };
  }));
  app.post('/signup', async (req, reply) => run(reply, async () => ({ company: await service().signUp(who(req), (req.body ?? {}) as Record<string, unknown>) })));
  app.post('/join', async (req, reply) => run(reply, async () => service().requestJoin(who(req))));
  app.post<{ Params: { id: string } }>('/invites/:id/accept', async (req, reply) => run(reply, async () => ({ company: await service().acceptInvite(who(req), req.params.id) })));

  app.get('/company', async (req, reply) => { const user = company(req, reply); if (!user) return reply; return run(reply, async () => ({ company: await service().company(user) })); });
  app.put('/company', async (req, reply) => { const user = company(req, reply); if (!user) return reply; return run(reply, async () => ({ company: await service().updateCompany(user, (req.body ?? {}) as Record<string, unknown>) })); });

  app.get('/members', async (req, reply) => { const user = company(req, reply); if (!user) return reply; return run(reply, async () => ({ members: await service().members(user) })); });
  app.put<{ Params: { userId: string } }>('/members/:userId', async (req, reply) => {
    const user = company(req, reply); if (!user) return reply;
    return run(reply, async () => ({ member: await service().setRoles(user, req.params.userId, (req.body as { roles?: unknown } | undefined)?.roles) }));
  });
  app.delete<{ Params: { userId: string } }>('/members/:userId', async (req, reply) => {
    const user = company(req, reply); if (!user) return reply;
    return run(reply, async () => { await service().removeMember(user, req.params.userId); return { removed: true }; });
  });

  app.get('/invites', async (req, reply) => { const user = company(req, reply); if (!user) return reply; return run(reply, async () => ({ invites: await service().invites(user) })); });
  app.post('/invites', async (req, reply) => { const user = company(req, reply); if (!user) return reply; return run(reply, async () => ({ invite: await service().invite(user, (req.body ?? {}) as Record<string, unknown>) })); });
  app.delete<{ Params: { id: string } }>('/invites/:id', async (req, reply) => {
    const user = company(req, reply); if (!user) return reply;
    return run(reply, async () => { await service().revokeInvite(user, req.params.id); return { revoked: true }; });
  });

  app.get('/join-requests', async (req, reply) => { const user = company(req, reply); if (!user) return reply; return run(reply, async () => ({ requests: await service().joinRequests(user) })); });
  app.post<{ Params: { id: string } }>('/join-requests/:id/approve', async (req, reply) => {
    const user = company(req, reply); if (!user) return reply;
    return run(reply, async () => ({ request: await service().decide(user, req.params.id, true, (req.body as { roles?: unknown } | undefined)?.roles) }));
  });
  app.post<{ Params: { id: string } }>('/join-requests/:id/deny', async (req, reply) => {
    const user = company(req, reply); if (!user) return reply;
    return run(reply, async () => ({ request: await service().decide(user, req.params.id, false) }));
  });
};
