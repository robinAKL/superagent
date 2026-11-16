import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SourceError, type ConnectionConfig, type KnowledgeSourcePlugin } from '@superagent/shared';
import type { SecretStore } from '../../setup/secrets.js';
import type { McpResourceScope, SourceResource } from '../sources.js';
import { KnowledgeError } from '../domain.js';
import { publicMcpFetch } from './mcp-public-http.js';
import { textWithLineAnchors } from './local-file.js';

export interface PublicMcpScope extends Record<string, unknown> {
  publicMcpEndpoint: string;
  mcpResources: McpResourceScope['resources'];
}

export function isPublicMcpScope(scope: Record<string, unknown>): scope is PublicMcpScope {
  return typeof scope.publicMcpEndpoint === 'string' && Array.isArray(scope.mcpResources);
}

async function withClient<T>(endpoint: string, networkFetch: typeof fetch, callback: (client: Client) => Promise<T>, authorization?: string): Promise<T> {
  const client = new Client({ name: 'superagent-knowledge', version: '1.0.0' });
  const deadline = AbortSignal.timeout(15_000);
  const headers = authorization ? { Authorization: `Bearer ${authorization}` } : undefined;
  let needsAuthorization = false;
  let endpointNotFound = false;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers, redirect: 'error' },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    fetch: async (url, init) => {
      const response = await networkFetch(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
      if (response.status === 401 || response.status === 403) needsAuthorization = true;
      if (response.status === 404 && init?.method === 'POST' && !client.getServerVersion()) endpointNotFound = true;
      if (!response.body) return response;
      let size = 0;
      const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          size += chunk.byteLength;
          if (size > 1_000_000) throw new SourceError('fatal', 'MCP response exceeded its byte limit.');
          controller.enqueue(chunk);
        },
      }));
      return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
    },
  });
  try {
    await client.connect(transport, { timeout: 15_000 });
    return await callback(client);
  } catch (error) {
    if (error instanceof KnowledgeError) throw error;
    if (needsAuthorization) throw new SourceError('auth', 'This MCP server requires authorization.');
    if (endpointNotFound) throw new KnowledgeError('mcp_endpoint_not_found', '目标服务器返回 404。请检查 MCP 路径，或确认对方已经启用 MCP。', 422);
    throw new SourceError('transient', 'The approved MCP server did not return a readable response.');
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close();
  }
}

function resourcePlugin(
  scopeFor: (config: ConnectionConfig) => { scope: McpResourceScope; audience: string[] },
  networkFetch: typeof fetch,
  secrets?: Pick<SecretStore, 'get'>,
): KnowledgeSourcePlugin {
  async function request<T>(scope: McpResourceScope, callback: (client: Client) => Promise<T>) {
    return withClient(scope.endpoint, networkFetch, callback, scope.secret ? await secrets!.get(scope.secret) : undefined);
  }
  return {
    manifest: { id: 'mcp', version: '1.0.0', name: 'MCP', capabilities: { incremental: false, attachments: false, liveQuery: false, acl: true }, permissions: [] },
    async testConnection(config) {
      const { scope } = scopeFor(config);
      try {
        return { ok: await request(scope, async client => !!client.getServerCapabilities()?.resources) };
      } catch { return { ok: false }; }
    },
    async listItems(config) {
      const { scope } = scopeFor(config);
      return { items: scope.resources.map(entry => ({
        externalId: entry.uri, title: entry.title, locator: entry.uri, version: String(config.scope.mcpScopeHash), change: 'upsert', contentVersion: 'hash',
      })) };
    },
    async getAcl(config, ref) {
      const { scope, audience } = scopeFor(config);
      const readers = Array.isArray(config.scope.audience) ? audience.filter(reader => (config.scope.audience as unknown[]).includes(reader)) : [];
      if (!scope.resources.some(entry => entry.uri === ref.externalId) || !readers.length) return { status: 'unknown', reason: 'MCP resource permission is unavailable.' };
      return { status: 'known', entries: readers.map(principal => ({ principal, access: 'read' })) };
    },
    async readItem(config, ref) {
      const { scope } = scopeFor(config);
      if (!scope.resources.some(entry => entry.uri === ref.externalId)) throw new SourceError('scope', 'MCP resource is outside the approved list.');
      const text = await request(scope, async client => {
        const result = await client.readResource({ uri: ref.externalId }, { timeout: 15_000 });
        return result.contents.flatMap(entry => entry.uri === ref.externalId && 'text' in entry ? [entry.text] : []).join('\n');
      });
      if (!text.trim() || text.length > 200_000) throw new SourceError('fatal', 'The MCP resource did not provide readable text within the size limit.');
      return textWithLineAnchors(text, ref.locator);
    },
  };
}

export function createMcpResourcePlugin(resources: SourceResource[], secrets: Pick<SecretStore, 'get'>): KnowledgeSourcePlugin {
  return resourcePlugin(config => {
    const resource = resources.find(entry => entry.pluginId === 'mcp' && entry.id === config.scope.resourceId);
    if (!resource) throw new SourceError('scope', 'MCP source is outside the approved scope.');
    return { audience: resource.audience, scope: resource.scope as unknown as McpResourceScope };
  }, (url, init) => fetch(url, init), secrets);
}

export function createPublicMcp(networkFetch: typeof fetch = publicMcpFetch) {
  return {
    plugin: resourcePlugin(({ scope }) => {
      if (!isPublicMcpScope(scope) || !Array.isArray(scope.audience)) throw new SourceError('scope', 'The MCP source scope is unavailable.');
      return { audience: scope.audience as string[], scope: { endpoint: scope.publicMcpEndpoint, resources: scope.mcpResources } };
    }, networkFetch),
    async discover(endpoint: string) {
      try {
        return await withClient(endpoint, networkFetch, async client => {
          const resources = new Map<string, string>();
          let cursor: string | undefined;
          if (client.getServerCapabilities()?.resources) {
            for (let page = 0; page < 10; page++) {
              const result = await client.listResources(cursor ? { cursor } : undefined, { timeout: 15_000 });
              for (const resource of result.resources) {
                if (!/^[a-z][a-z0-9+.-]*:[^\s\x00-\x1f]+$/i.test(resource.uri) || resource.uri.length > 1000) continue;
                resources.set(resource.uri, (resource.title || resource.name || resource.uri).slice(0, 180));
                if (resources.size === 100) break;
              }
              cursor = result.nextCursor;
              if (!cursor || resources.size === 100) break;
            }
          }
          if (!resources.size) throw new KnowledgeError('mcp_no_resources', 'MCP 服务器没有公开可导入的资源。', 422);
          const name = client.getServerVersion()?.title || client.getServerVersion()?.name || new URL(endpoint).hostname;
          return { name: name.slice(0, 160), resources: Array.from(resources, ([uri, title]) => ({ uri, title })) };
        });
      } catch (error) {
        if (error instanceof KnowledgeError) throw error;
        if (error instanceof SourceError && error.kind === 'auth') throw new KnowledgeError('mcp_auth_required', '此 MCP 服务器需要授权，请选择已配置凭据的来源。', 422);
        throw new KnowledgeError('mcp_connection_failed', '无法验证 MCP 地址，请检查地址和服务器是否可访问。', 422);
      }
    },
  };
}
