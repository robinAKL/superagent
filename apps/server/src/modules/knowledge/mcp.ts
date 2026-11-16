import type { FastifyInstance } from 'fastify';
import { hash, KnowledgeError } from './domain.js';
import type { KnowledgeService } from './service.js';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const tools = [
  {
    name: 'search_knowledge',
    description: 'Search confirmed enterprise knowledge and return excerpts with source IDs, versions, and citations.',
    inputSchema: {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_knowledge',
    description: 'Read a confirmed source using the sourceId and version returned by search_knowledge.',
    inputSchema: {
      type: 'object', required: ['sourceId', 'version'], additionalProperties: false,
      properties: { sourceId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, version: { type: 'string', minLength: 1, maxLength: 500 } },
    },
    annotations: { readOnlyHint: true },
  },
];
const liveTools = [
  {
    name: 'list_mcp_sources',
    description: 'List the signed-in user’s connected MCP knowledge sources and their IDs.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_mcp_knowledge',
    description: 'Discover documents, resource templates and enabled read-only queries from a connected MCP source.',
    inputSchema: { type: 'object', required: ['sourceId'], additionalProperties: false, properties: { sourceId: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_mcp_knowledge',
    description: 'Read a live document using its URI or an expanded resource template from list_mcp_knowledge.',
    inputSchema: { type: 'object', required: ['sourceId', 'uri'], additionalProperties: false, properties: { sourceId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, uri: { type: 'string', maxLength: 1500 } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'query_mcp_knowledge',
    description: 'Run an enabled read-only query on a connected MCP source. Use the name and input schema from list_mcp_knowledge.',
    inputSchema: {
      type: 'object', required: ['sourceId', 'name', 'arguments'], additionalProperties: false,
      properties: { sourceId: { type: 'string', pattern: '^[a-f0-9]{64}$' }, name: { type: 'string', maxLength: 128 }, arguments: { type: 'object' } },
    },
    annotations: { readOnlyHint: true },
  },
];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolResult(data: object): object {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function mountKnowledgeMcp(app: FastifyInstance, service: KnowledgeService | null): void {
  app.route({
    method: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    url: '/mcp',
    bodyLimit: 16 * 1024,
    onRequest: async (req, reply) => {
      // This endpoint accepts server/native clients using explicit credentials.
      if (req.headers.origin !== undefined) return reply.code(403).send();
    },
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (req.method !== 'POST') return reply.header('Allow', 'POST').code(405).send();
      const message = record(req.body);
      const id = message?.id;
      const hasId = id === null || typeof id === 'number' || typeof id === 'string';
      const fail = (code: number, text: string, status = 200) =>
        reply.code(status).send({ jsonrpc: '2.0', id: hasId ? id : null, error: { code, message: text } });

      const protocol = req.headers['mcp-protocol-version'];
      if (protocol !== undefined && (typeof protocol !== 'string' || !versions.includes(protocol))) {
        return fail(-32600, 'Unsupported MCP protocol version', 400);
      }
      if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' || (id !== undefined && !hasId)) {
        return fail(-32600, 'Invalid Request', 400);
      }
      if (id === undefined) return reply.code(202).send();
      if (!service) return fail(-32603, 'Knowledge is unavailable', 503);

      const params = record(message.params);
      const success = (result: object) => ({ jsonrpc: '2.0', id, result });
      switch (message.method) {
        case 'initialize': {
          const requested = params?.protocolVersion;
          if (typeof requested !== 'string') return fail(-32602, 'protocolVersion is required');
          return success({
            protocolVersion: versions.includes(requested) ? requested : versions[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'superagent-knowledge', version: '0.1.0' },
          });
        }
        case 'ping': return success({});
        case 'tools/list': {
          const live = service.deps.liveMcp;
          const connected = live?.list(await service.deps.repo.read(req.user!), req.user!).some(source => source.enabled);
          return success({ tools: connected ? [...tools, ...liveTools] : tools });
        }
        case 'tools/call': {
          const args = record(params?.arguments);
          if (!args) return fail(-32602, 'Tool arguments are required');
          try {
            if (params?.name === 'search_knowledge') {
              const { query } = args;
              if (typeof query !== 'string' || !query.trim() || query.length > 200) return fail(-32602, 'query must contain 1–200 characters');
              const { hits } = await service.search(req.user!, query, { checkSourceAccess: true });
              return success(toolResult({ hits: hits.map(hit => ({ ...hit, sourceId: hash(hit.sourceId) })) }));
            }
            if (params?.name === 'read_knowledge') {
              const { sourceId, version } = args;
              if (typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId) || typeof version !== 'string' || !version || version.length > 500) {
                return fail(-32602, 'A valid sourceId and version are required');
              }
              return success(toolResult(await service.preview(req.user!, sourceId, version, { confirmedOnly: true })));
            }
            const live = service.deps.liveMcp;
            if (live && params?.name === 'list_mcp_sources') return success(toolResult({ sources: live.list(await service.deps.repo.read(req.user!), req.user!).filter(source => source.enabled) }));
            if (live && params?.name === 'list_mcp_knowledge') return success(toolResult(await live.catalog(req.user!, args.sourceId)));
            if (live && params?.name === 'read_mcp_knowledge') return success(toolResult(await live.read(req.user!, args.sourceId, args.uri)));
            if (live && params?.name === 'query_mcp_knowledge') return success(toolResult(await live.call(req.user!, args.sourceId, args.name, args.arguments)));
            return fail(-32602, 'Unknown tool');
          } catch (error) {
            if (!(error instanceof KnowledgeError)) {
              return fail(-32603, 'Knowledge request failed');
            }
            const message = error.code === 'version_changed'
              ? 'The source version has changed. Search again for the current version.'
              : error.code === 'mcp_reauthorize' ? 'Reauthorize this MCP source in Knowledge sources.'
                : 'The requested knowledge could not be read.';
            return success({ isError: true, content: [{ type: 'text', text: message }] });
          }
        }
        default: return fail(-32601, 'Method not found');
      }
    },
  });
}
