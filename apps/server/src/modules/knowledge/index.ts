import type { FastifyPluginAsync } from 'fastify';
import { KnowledgeError } from './domain.js';
import { KnowledgeService, type KnowledgeDeps } from './service.js';
import { mountKnowledgeMcp } from './mcp.js';
import { answerFromMcp } from './mcp-answer.js';
export const knowledgeModule: FastifyPluginAsync<{ deps?: KnowledgeDeps }> = async (app, opts) => {
  const service = opts.deps ? new KnowledgeService(opts.deps) : null;
  await app.register(async mcp => { mountKnowledgeMcp(mcp, service); });
  app.addHook('preHandler', async (req, reply) => { if (!service && !req.routeOptions.url?.endsWith('/status')) return reply.code(503).send({ error: 'knowledge_unavailable', message: '企业知识存储尚未配置。' }); });
  app.get('/status', async () => ({ module: 'knowledge', implemented: true, configured: !!service }));
  app.setErrorHandler((err, _req, reply) => { if (err instanceof KnowledgeError) return reply.code(err.statusCode).send({ error: err.code, message: err.message }); const code = (err as { statusCode?: number }).statusCode; return reply.code(code && code < 500 ? code : 500).send({ error: 'knowledge_request_failed', message: '请求未完成，请稍后重试。' }); });
  const body = (req: { body: unknown }) => { if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new KnowledgeError('invalid_input', '请求结构无效。'); return req.body as Record<string, unknown>; };
  app.put('/space', req => service!.renameSpace(req.user!, body(req)));
  app.post('/manual-roles', (req, reply) => { reply.code(201); return service!.createManualRole(req.user!, body(req)); });
  app.post<{ Params: { id: string } }>('/plugins/:id/install', req => service!.installPlugin(req.user!, req.params.id));
  app.get<{ Params: { id: string } }>('/connections/:id/preview', req => service!.previewConnection(req.user!, req.params.id));
  app.post<{ Params: { id: string } }>('/connections/:id/import', async (req, reply) => { const result = await service!.importSelection(req.user!, req.params.id, body(req)); return result.error ? reply.code(502).send({ error: 'source_sync_failed', message: result.error }) : result; });
  app.get<{ Params: { id: string }; Querystring: { templateId?: string; revision?: string } }>('/connections/:id/fact-freshness', req => service!.factFreshness(req.user!, req.params.id, req.query.templateId ?? '', req.query.revision ?? ''));
  app.get('/overview', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service!.overview(req.user!);
  });
  app.get('/recommendations', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service!.recommendations(req.user!);
  });
  const mcp = () => {
    if (!opts.deps?.liveMcp) throw new KnowledgeError('mcp_unavailable', 'MCP 知识连接尚未配置。', 503);
    return opts.deps.liveMcp;
  };
  app.post('/connections/mcp', async (req, reply) => {
    const input = body(req);
    if (!opts.deps?.liveMcp) {
      reply.code(201);
      return service!.connectPublicMcp(req.user!, input);
    }
    reply.header('Cache-Control', 'no-store');
    const result = await mcp().connect(req.user!, input, req.headers.origin, req.headers.host);
    if ('authorizationUrl' in result) return { authorizationUrl: result.authorizationUrl };
    const { catalog } = result;
    if (req.user!.roles.some(role => role === 'owner' || role === 'admin')) {
      const resources = catalog.resources.filter(resource => /^[a-z][a-z0-9+.-]*:[^\s\x00-\x1f]+$/i.test(resource.uri) && resource.uri.length <= 1000)
        .map(resource => ({ uri: resource.uri, title: (resource.title || resource.name || resource.uri).slice(0, 180) }));
      if (resources.length) await service!.connectPublicMcp(req.user!, { endpoint: catalog.source }, { name: catalog.name, resources });
    }
    reply.code(201);
    return { ...result.source, status: 'confirmed' };
  });
  app.post('/connections/mcp/oauth/finish', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return mcp().finish(req.user!, body(req));
  });
  app.delete<{ Params: { id: string } }>('/connections/mcp/live/:id', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return mcp().disconnect(req.user!, req.params.id);
  });
  app.get<{ Params: { id: string } }>('/connections/mcp/live/:id/catalog', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return mcp().catalog(req.user!, req.params.id);
  });
  app.post<{ Params: { id: string } }>('/connections/mcp/live/:id/read', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return mcp().read(req.user!, req.params.id, body(req).uri);
  });
  app.post<{ Params: { id: string } }>('/connections/mcp/live/:id/query', { bodyLimit: 16 * 1024 }, (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = body(req);
    return mcp().call(req.user!, req.params.id, input.name, input.arguments);
  });
  app.post<{ Params: { id: string } }>('/connections/mcp/live/:id/ask', { bodyLimit: 8 * 1024 }, (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const gateway = opts.deps?.mcpAnswerGateway;
    if (!gateway) throw new KnowledgeError('mcp_model_unavailable', '大脑模型尚未配置。', 503);
    return answerFromMcp(req.user!, req.params.id, body(req).question, mcp(), gateway);
  });
  app.post('/connections', (req, reply) => { reply.code(201); return service!.createConnection(req.user!, body(req)); });
  app.post<{ Params: { id: string } }>('/connections/:id/confirm', req => service!.confirmConnection(req.user!, req.params.id));
  app.post<{ Params: { id: string } }>('/connections/:id/sync', async (req,reply) => { const result=await service!.sync(req.user!,req.params.id); return result.error ? reply.code(502).send({...result,message:result.error,error:'source_sync_failed'}) : result; });
  app.get<{ Params: { id: string } }>('/connections/:id/templates', req => service!.templates(req.user!, req.params.id));
  app.post<{ Params: { id: string } }>('/connections/:id/templates', req => service!.approveTemplate(req.user!, req.params.id, body(req)));
  app.post<{ Params: { id: string } }>('/connections/:id/query', req => service!.query(req.user!, req.params.id, body(req)));
  app.post('/uploads', async (req,reply) => {const result=await service!.upload(req.user!,body(req));return result.error?reply.code(502).send({...result,message:result.error,error:'source_sync_failed'}):result;});
  app.post('/files', { bodyLimit: 28 * 1024 * 1024 }, req => service!.uploadBinary(req.user!, body(req)));
  app.post('/local-materials', { bodyLimit: 28 * 1024 * 1024 }, req => service!.uploadLocal(req.user!, body(req)));
  app.post('/items/confirm', req => service!.confirmMany(req.user!, body(req)));
  app.post<{ Params: { id: string } }>('/items/:id/profile', req => service!.editProfile(req.user!, req.params.id, body(req)));
  app.post<{ Params: { id: string } }>('/items/:id/confirm', req => service!.confirm(req.user!, req.params.id, String(body(req).version ?? '')));
  app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/items/:id/preview', req => service!.preview(req.user!, req.params.id, req.query.version ?? ''));
  app.get<{ Querystring: { q?: string } }>('/search', req => service!.search(req.user!, req.query.q ?? ''));
  app.post('/analyses', { bodyLimit: 8 * 1024 }, (req, reply) => { reply.code(202); return service!.startAnalysis(req.user!, req.body === undefined ? {} : body(req)); });
  app.post<{ Params: { id: string } }>('/recommendations/:id/lock', req => service!.editRecommendation(req.user!, req.params.id, body(req)));
  app.post<{ Params: { id: string } }>('/recommendations/:id/delete', req => service!.editRecommendation(req.user!, req.params.id, {}, true));
  app.post<{ Params: { id: string } }>('/recommendations/:id/merge', req => service!.mergeRecommendation(req.user!, req.params.id, body(req)));
  app.get('/organization', req => service!.organization(req.user!));
  app.post('/organization/confirm', req => service!.confirmOrganization(req.user!));
  app.post('/organization/plan', { bodyLimit: 4 * 1024 }, req => service!.planTeam(req.user!, body(req)));
  app.post('/organization/plan/adopt', req => service!.adoptTeamPlan(req.user!, body(req)));
  app.post('/organization/plan/discard', req => service!.discardTeamPlan(req.user!));
  app.post<{ Params: { id: string } }>('/recommendations/:id/adopt', req => service!.adoptRecommendation(req.user!, req.params.id));
  app.post<{ Params: { id: string } }>('/plugins/:id', req => { const enabled = body(req).enabled; if (typeof enabled !== 'boolean') throw new KnowledgeError('invalid_input', '插件状态无效。'); return service!.togglePlugin(req.user!, req.params.id, enabled); });
  app.get('/reset/preview', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service!.resetPreview(req.user!);
  });
  app.post('/reset', { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service!.resetKnowledge(req.user!, body(req));
  });
};
