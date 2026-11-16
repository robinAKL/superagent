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
    name: 'list_vera_knowledge',
    description: 'Discover live VERA CRM knowledge available through the signed-in user’s connection, including documents, resource templates and read-only queries. Use the returned schemas to select a query.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_vera_knowledge',
    description: 'Read a live CRM document such as an operating guide. Use the URI from list_vera_knowledge or a URI expanded from one of its resource templates.',
    inputSchema: { type: 'object', required: ['uri'], additionalProperties: false, properties: { uri: { type: 'string', maxLength: 1500 } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'query_vera_knowledge',
    description: 'Run a read-only query on VERA CRM for current information such as pricing knowledge or order details. Use the name and input schema from list_vera_knowledge.',
    inputSchema: {
      type: 'object', required: ['name', 'arguments'], additionalProperties: false,
      properties: { name: { type: 'string', maxLength: 128 }, arguments: { type: 'object' } },
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
          const vera = service.deps.veraMcp;
          const connected = vera?.status(await service.deps.repo.read(req.user!), req.user!).connected;
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
            const vera = service.deps.veraMcp;
            if (vera && params?.name === 'list_vera_knowledge') return success(toolResult(await vera.catalog(req.user!)));
            if (vera && params?.name === 'read_vera_knowledge') return success(toolResult(await vera.read(req.user!, args.uri)));
            if (vera && params?.name === 'query_vera_knowledge') return success(toolResult(await vera.call(req.user!, args.name, args.arguments)));
            return fail(-32602, 'Unknown tool');
          } catch (error) {
            if (!(error instanceof KnowledgeError)) {
              return fail(-32603, 'Knowledge request failed');
            }
            const message = error.code === 'version_changed'
              ? 'The source version has changed. Search again for the current version.'
              : error.code === 'vera_reauthorize' ? 'Connect or reauthorize VERA CRM in Knowledge sources.'
                : 'The requested knowledge could not be read.';
            return success({ isError: true, content: [{ type: 'text', text: message }] });
          }
        }
        default: return fail(-32601, 'Method not found');
      }
    },
  });
}
