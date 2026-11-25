import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modules } from './modules/index.js';
import { createAuthenticate, requireRole, type AuthConfig } from './auth.js';
import type { SetupDeps } from './modules/setup/service.js';
import { KnowledgeService, type KnowledgeDeps } from './modules/knowledge/service.js';
import { longWorkModule, mailWebhook, type LongWorkDeps } from './modules/longwork/http.js';
import { workerLinkModule, workerPairModule } from './modules/workers/index.js';
import { accountCallbackRoute } from './modules/accounts/index.js';
import { schedulesHooks } from './modules/schedules/index.js';
import { MCP_CALLBACK, MCP_CLIENT_DOCUMENT, mcpClientDocument } from './modules/knowledge/mcp-oauth.js';
import { publicMcpEndpoint } from './modules/knowledge/plugins/mcp-public-http.js';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface AppOptions {
  /** Serve the built web app (apps/web/dist) from the same process. */
  serveWeb?: boolean;
  logger?: boolean;
  auth?: AuthConfig;
  setupDeps?: SetupDeps;
  knowledgeDeps?: KnowledgeDeps;
  longWorkDeps?: LongWorkDeps;
  readiness?: ReadinessCheck[];
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Never log request bodies: Setup carries API keys (PRD §7.1).
    disableRequestLogging: true,
  });

  app.get('/healthz', async () => ({ ok: true }));
  // One address that always downloads the newest Link for Windows: the release workflow keeps link-latest current.
  app.get('/download/link', async (_req, reply) => reply
    .header('cache-control', 'no-store')
    .redirect('https://github.com/robinAKL/superagent/releases/download/link-latest/SuperAgentLink-Setup-x64.exe', 302));
  if (opts.knowledgeDeps?.liveMcp) {
    // The SPA completes the exchange using the signed-in user's Super Agent credentials.
    app.get<{ Params: { binding?: string }; Querystring: Record<string, unknown> }>(MCP_CALLBACK + '/:binding?', (req, reply) => {
      const binding = req.params.binding;
      if (binding && !/^[a-f0-9]{32}$/.test(binding)) return reply.code(404).send();
      const fragment = new URLSearchParams();
      for (const key of ['state', 'code', 'iss']) {
        const value = req.query[key];
        if (typeof value === 'string' && value.length <= 2048) fragment.set('mcp_' + key, value);
      }
      fragment.set('mcp_callback', MCP_CALLBACK + (binding ? '/' + binding : ''));
      return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')
        .redirect('/#knowledge?' + fragment.toString());
    });
    app.get<{ Params: { binding?: string } }>(MCP_CLIENT_DOCUMENT + '/:binding?', (req, reply) => {
      const { binding } = req.params;
      if (binding && !/^[a-f0-9]{32}$/.test(binding)) return reply.code(404).send();
      try {
        const origin = publicMcpEndpoint('https://' + (req.headers.host ?? '')).origin;
        return mcpClientDocument(origin, binding);
      } catch { return reply.code(400).send(); }
    });
  }

  // Public sign-in configuration for the browser (no secrets: tenant and client ids are not credentials).
  app.get('/auth/config', async () =>
    authCfgForBrowser.mode === 'entra'
      ? { mode: 'entra', tenantId: authCfgForBrowser.tenantId, clientId: authCfgForBrowser.clientId, scopes: [`api://${authCfgForBrowser.clientId}/access_as_user`] }
      : { mode: 'dev' },
  );
  app.get('/readyz', async (_req, reply) => {
    const results = await Promise.all(
      (opts.readiness ?? []).map(async (c) => ({ name: c.name, ok: await c.check().catch(() => false) })),
    );
    const ok = results.every((r) => r.ok);
    return reply.code(ok ? 200 : 503).send({ ok, role: process.env.APP_ROLE ?? 'web', checks: results });
  });

  // Fail closed: production must come through bootstrap.ts with explicit Entra auth and real stores.
  const production = process.env.NODE_ENV === 'production';
  if (production && (!opts.auth || opts.auth.mode === 'dev')) throw new Error('production requires explicit Entra auth (use createRuntime in bootstrap.ts)');
  if (production && !opts.setupDeps) throw new Error('production requires persistent Setup dependencies (use createRuntime in bootstrap.ts)');
  const auth = opts.auth ?? { mode: 'dev' as const, platformTenantId: 'default' };
  const authCfgForBrowser = auth;
  const authenticate = createAuthenticate(auth);
  const knowledge = opts.knowledgeDeps?.organization ? new KnowledgeService(opts.knowledgeDeps) : undefined;
  // The calendar's suggestions: workflows whose sources state a cadence, with the employee who does them.
  schedulesHooks.suggestions = knowledge ? (user) => knowledge.workflowSchedules(user) : null;
  await app.register(mailWebhook, { deps: opts.longWorkDeps });
  // Microsoft sends a person back here after signing in a mailbox; the signed-in browser finishes it.
  await app.register(accountCallbackRoute);
  // Pairing has no token yet. The worker channel itself uses a revocable bearer token, not a user sign-in.
  await app.register(workerPairModule, { prefix: '/api/v1/worker-link' });
  await app.register(workerLinkModule, { prefix: '/api/v1/worker-link' });

  await app.register(async (api) => {
    api.addHook('preHandler', authenticate);
    await api.register(longWorkModule, { deps: opts.longWorkDeps, prefix: '/api/v1/long-items' });
    // Each module owns a prefix under /api/v1. Owners: see docs/OWNERSHIP.md.
    for (const m of modules) {
      await api.register(async (scoped) => {
        if (m.roles) scoped.addHook('preHandler', requireRole(...m.roles));
        if (knowledge && ['employees', 'room', 'workers', 'executions', 'work-items'].includes(m.prefix)) {
          scoped.addHook('preHandler', async req => {
            if (req.user) await knowledge.refreshConfirmedTeam(req.user.tenantId);
          });
        }
        const deps = m.prefix === 'setup' ? opts.setupDeps : m.prefix === 'knowledge' ? opts.knowledgeDeps : m.prefix === 'work-items' ? opts.longWorkDeps : undefined;
        const workflowTeam = m.prefix === 'executions' && knowledge ? { resolveWorkflowTeam: (tenantId: string) => knowledge.resolveWorkflowTeam(tenantId) } : {};
        await scoped.register(m.plugin, { ...(deps ? { deps } : {}), ...workflowTeam, tenantOf: (req: any) => req.user?.tenantId ?? 'default' });
      }, { prefix: `/api/v1/${m.prefix}` });
    }
  });

  if (opts.serveWeb) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDist = path.resolve(here, '../../web/dist');
    if (fs.existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
        return reply.sendFile('index.html');
      });
    }
  }
  return app;
}
