import type { FastifyPluginAsync } from 'fastify';
import { KnowledgeError } from './domain.js';
import { KnowledgeService, type KnowledgeDeps } from './service.js';
import { mountKnowledgeMcp } from './mcp.js';
import { VERA_MCP_URL } from './vera-mcp.js';
import { answerFromVera } from './vera-answer.js';
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
  app.get('/overview', req => service!.overview(req.user!));
  const vera = () => {
    if (!opts.deps?.veraMcp) throw new KnowledgeError('vera_mcp_unavailable', 'VERA CRM 知识连接尚未配置。', 503);
    return opts.deps.veraMcp;
  };
  app.post('/connections/mcp', (req, reply) => {
    const input = body(req);
    if (input.endpoint === VERA_MCP_URL && opts.deps?.veraMcp) {
      reply.header('Cache-Control', 'no-store');
      return vera().start(req.user!, req.headers.origin, req.headers.host);
    }
    reply.code(201);
    return service!.connectPublicMcp(req.user!, input);
  });
  app.post('/connections/mcp/vera/finish', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return vera().finish(req.user!, body(req));
  });
  app.delete('/connections/mcp/vera', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return vera().disconnect(req.user!);
  });
  app.get('/connections/mcp/vera/catalog', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return vera().catalog(req.user!);
  });
  app.post('/connections/mcp/vera/read', (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return vera().read(req.user!, body(req).uri);
  });
  app.post('/connections/mcp/vera/query', { bodyLimit: 16 * 1024 }, (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = body(req);
    return vera().call(req.user!, input.name, input.arguments);
  });
  app.post('/connections/mcp/vera/ask', { bodyLimit: 8 * 1024 }, (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const gateway = opts.deps?.veraAnswerGateway;
    if (!gateway) throw new KnowledgeError('vera_model_unavailable', '大脑模型尚未配置。', 503);
    return answerFromVera(req.user!, body(req).question, vera(), gateway);
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
  app.post('/analyses', (req, reply) => { reply.code(202); return service!.startAnalysis(req.user!); });
  app.post<{ Params: { id: string } }>('/recommendations/:id/lock', req => service!.editRecommendation(req.user!, req.params.id, body(req)));
  app.post<{ Params: { id: string } }>('/recommendations/:id/delete', req => service!.editRecommendation(req.user!, req.params.id, {}, true));
  app.post<{ Params: { id: string } }>('/recommendations/:id/adopt', req => service!.adoptRecommendation(req.user!, req.params.id));
  app.post<{ Params: { id: string } }>('/plugins/:id', req => { const enabled = body(req).enabled; if (typeof enabled !== 'boolean') throw new KnowledgeError('invalid_input', '插件状态无效。'); return service!.togglePlugin(req.user!, req.params.id, enabled); });
};
