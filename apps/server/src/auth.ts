/**
 * Entra ID authentication (PRD §3.9, §7.2). Every request is authorised server-side by role and project scope.
 * AUTH_MODE=dev allows an `x-dev-user` header for local development and tests; it is refused in production.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ROLES, type Role, type UserContext } from '@superagent/shared';
import { enterTenant } from './tenancy.js';
import type { Identity, TenancyService } from './modules/tenancy/directory.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserContext;
    /** The verified person, even before they belong to a company (sign-up, join requests, invitations). */
    identity?: Identity;
  }
}

export interface AuthConfig {
  mode: 'entra' | 'dev';
  tenantId?: string; // Entra directory (tenant) id
  clientId?: string; // API app registration audience
  /** Platform tenant the deployment serves (single-tenant deployment). */
  platformTenantId: string;
  /** Optional lookup of project scopes / extra roles from the users table. */
  resolveUser?: (oid: string, tokenRoles: Role[]) => Promise<Pick<UserContext, 'roles' | 'projectScopes'> | null>;
  /**
   * The company directory. With it, any Microsoft 365 organisation can sign in: the person's company is the one they
   * belong to (the x-tenant header picks among several), and their roles come from the membership. Without it, only
   * the deployment's own directory is accepted, as before.
   */
  directory?: TenancyService;
}

export function authConfigFromEnv(env = process.env): AuthConfig {
  const mode = env.AUTH_MODE === 'dev' ? 'dev' : 'entra';
  if (mode === 'dev' && env.NODE_ENV === 'production') throw new Error('AUTH_MODE=dev is not allowed in production');
  return { mode, tenantId: env.ENTRA_TENANT_ID, clientId: env.ENTRA_CLIENT_ID, platformTenantId: env.PLATFORM_TENANT_ID ?? 'default' };
}

const toRoles = (v: unknown): Role[] => (Array.isArray(v) ? v.filter((r): r is Role => (ROLES as readonly string[]).includes(String(r))) : []);

const header = (req: FastifyRequest, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/**
 * Verifies the caller. `identityOnly` routes (the company directory: sign-up, join requests, invitations) accept a
 * verified person who belongs to no company yet; every other route needs a company and refuses with no_company.
 */
export function createAuthenticate(cfg: AuthConfig, options: { identityOnly?: boolean } = {}): preHandlerHookHandler {
  // One key set serves every directory; the issuer is checked against the token's own directory below.
  const jwks =
    cfg.mode === 'entra' && cfg.tenantId
      ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${cfg.directory ? 'common' : cfg.tenantId}/discovery/v2.0/keys`))
      : null;

  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    if (cfg.mode === 'dev') {
      const raw = req.headers['x-dev-user'];
      if (typeof raw !== 'string') return reply.code(401).send({ error: 'unauthenticated' });
      // user|roles|projectScopes|tenant. The fourth field lets tests act as a second company; it defaults to the platform tenant.
      const [userId, roles = '', scopes = '', tenant = ''] = raw.split('|');
      if (!userId?.trim()) return reply.code(401).send({ error: 'unauthenticated' }); // blank identity is no identity
      req.user = { tenantId: tenant.trim() || cfg.platformTenantId, userId: userId!, roles: toRoles(roles.split(',')), projectScopes: scopes ? scopes.split(',') : [] };
      req.identity = { tid: `dev:${req.user.tenantId}`, oid: userId!, email: `${userId}@example.com`, name: userId!, tokenRoles: req.user.roles };
      if (cfg.directory) await cfg.directory.devMember(req.user, req.identity);
      enterTenant(req.user.tenantId);
      return;
    }
    const bearer = req.headers.authorization;
    if (!jwks || !bearer?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthenticated' });
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearer.slice(7), jwks, {
        // v2 tokens for this API carry the client id; v1-style audiences use the api:// URI. Both name this app only.
        audience: cfg.clientId ? [cfg.clientId, `api://${cfg.clientId}`] : undefined,
      }));
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    const tid = String(payload.tid ?? '');
    // The token must come from the directory it names; without the company directory, only our own directory.
    if (!tid || payload.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) return reply.code(401).send({ error: 'invalid_token' });
    if (!cfg.directory && tid !== cfg.tenantId) return reply.code(401).send({ error: 'invalid_token' });
    const oid = String(payload.oid ?? payload.sub ?? '');
    const tokenRoles = toRoles(payload.roles);
    if (!cfg.directory) {
      const resolved = cfg.resolveUser ? await cfg.resolveUser(oid, tokenRoles) : { roles: tokenRoles, projectScopes: [] };
      if (!resolved) return reply.code(403).send({ error: 'user_not_provisioned' });
      req.user = { tenantId: cfg.platformTenantId, userId: oid, ...resolved };
      enterTenant(req.user.tenantId);
      return;
    }
    const email = [payload.email, payload.preferred_username, payload.upn].find((v): v is string => typeof v === 'string' && v.includes('@')) ?? null;
    const identity: Identity = { tid, oid, email: email?.toLowerCase() ?? null, name: typeof payload.name === 'string' ? payload.name : email ?? oid, tokenRoles };
    req.identity = identity;
    const user = await cfg.directory.resolve(identity, header(req, 'x-tenant'));
    if (user) {
      req.user = user;
      enterTenant(user.tenantId);
      return;
    }
    if (!options.identityOnly) return reply.code(403).send({ error: 'no_company' });
  };
}

export function requireRole(...allowed: Role[]): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
    if (!req.user.roles.some((r) => allowed.includes(r))) return reply.code(403).send({ error: 'forbidden' });
  };
}

/** True if the user may act on an object in `projectId` (empty scope list = no project access granted). */
export function canAccessProject(user: UserContext, projectId: string | null): boolean {
  if (projectId === null) return true;
  return user.roles.includes('owner') || user.roles.includes('admin') || user.projectScopes.includes(projectId);
}
