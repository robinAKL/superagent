import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SourceError, type ConnectionConfig, type KnowledgeSourcePlugin } from '@superagent/shared';
import type { SecretStore } from '../../setup/secrets.js';
import type { McpResourceScope, SourceResource } from '../sources.js';
import { textWithLineAnchors } from './local-file.js';

export function createMcpResourcePlugin(resources: SourceResource[], secrets: Pick<SecretStore, 'get'>): KnowledgeSourcePlugin {
  function scopeFor(config: ConnectionConfig) {
    const resource = resources.find(entry => entry.pluginId === 'mcp' && entry.id === config.scope.resourceId);
    if (!resource) throw new SourceError('scope', 'MCP source is outside the approved scope.');
    return { resource, scope: resource.scope as unknown as McpResourceScope };
  }

  async function withClient<T>(scope: McpResourceScope, callback: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: 'superagent-knowledge', version: '1.0.0' });
    const deadline = AbortSignal.timeout(15_000);
    const headers = scope.secret ? { Authorization: `Bearer ${await secrets.get(scope.secret)}` } : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(scope.endpoint), {
      requestInit: { headers, redirect: 'error' },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 0, maxReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      fetch: async (url, init) => {
        const response = await fetch(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
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
    } catch {
      throw new SourceError('transient', 'The approved MCP server did not return a readable response.');
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    }
  }

  return {
    manifest: { id: 'mcp', version: '1.0.0', name: 'MCP', capabilities: { incremental: false, attachments: false, liveQuery: false, acl: true }, permissions: [] },
    async testConnection(config) {
      const { scope } = scopeFor(config);
      try {
        return { ok: await withClient(scope, async client => !!client.getServerCapabilities()?.resources) };
      } catch { return { ok: false }; }
    },
    async listItems(config) {
      const { scope } = scopeFor(config);
      return { items: scope.resources.map(entry => ({
        externalId: entry.uri, title: entry.title, locator: entry.uri, version: String(config.scope.mcpScopeHash), change: 'upsert', contentVersion: 'hash',
      })) };
    },
    async getAcl(config, ref) {
      const { scope, resource } = scopeFor(config);
      const readers = Array.isArray(config.scope.audience) ? resource.audience.filter(reader => (config.scope.audience as unknown[]).includes(reader)) : [];
      if (!scope.resources.some(entry => entry.uri === ref.externalId) || !readers.length) return { status: 'unknown', reason: 'MCP resource permission is unavailable.' };
      return { status: 'known', entries: readers.map(principal => ({ principal, access: 'read' })) };
    },
    async readItem(config, ref) {
      const { scope } = scopeFor(config);
      if (!scope.resources.some(entry => entry.uri === ref.externalId)) throw new SourceError('scope', 'MCP resource is outside the approved list.');
      const text = await withClient(scope, async client => {
        const result = await client.readResource({ uri: ref.externalId }, { timeout: 15_000 });
        return result.contents.flatMap(entry => entry.uri === ref.externalId && 'text' in entry ? [entry.text] : []).join('\n');
      });
      if (!text.trim() || text.length > 200_000) throw new SourceError('fatal', 'The MCP resource did not provide readable text within the size limit.');
      return textWithLineAnchors(text, ref.locator);
    },
  };
}
