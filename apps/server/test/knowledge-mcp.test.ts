import { expect, it } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { buildApp } from '../src/app.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { hash } from '../src/modules/knowledge/domain.js';

it('serves only confirmed, authorized knowledge over MCP', async () => {
  const knowledgeDeps = { repo: new MemoryKnowledgeRepository() };
  const owner: UserContext = { tenantId: 'mcp-test', userId: 'alice', roles: ['owner'], projectScopes: [] };
  const service = new KnowledgeService(knowledgeDeps);
  const connection = await service.createConnection(owner, { pluginId: 'local-file', name: 'Team handbook' });
  await service.confirmConnection(owner, connection.id);
  await service.upload(owner, { connectionId: connection.id, name: 'policy.md', text: 'Verify invoices before payment.' });
  const [item] = (await knowledgeDeps.repo.read(owner)).source.items;
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: owner.tenantId }, knowledgeDeps });
  const url = '/api/v1/knowledge/mcp';
  const call = (method: string, params: object = {}, user = 'alice|owner|') => app.inject({
    method: 'POST', url, headers: { 'x-dev-user': user, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method, params },
  });
  const search = (user?: string) => call('tools/call', { name: 'search_knowledge', arguments: { query: 'invoices' } }, user);
  const read = (user?: string) => call('tools/call', {
    name: 'read_knowledge', arguments: { sourceId: hash(item!.id), version: item!.version },
  }, user);

  try {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await app.inject({ method: 'POST', url, payload: ping })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url, headers: { origin: 'https://untrusted.example' }, payload: ping })).statusCode).toBe(403);
    expect((await call('initialize', { protocolVersion: '2025-11-25' })).json().result.protocolVersion).toBe('2025-11-25');
    expect((await call('tools/list')).json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(['search_knowledge', 'read_knowledge']);
    expect((await search()).json().result.structuredContent.hits).toEqual([]);
    expect((await read()).json().result.isError).toBe(true);

    await service.confirm(owner, item!.id, item!.version);
    expect((await search()).json().result.structuredContent.hits[0]).toMatchObject({
      sourceId: hash(item!.id), version: item!.version, quote: 'Verify invoices before payment.', locator: 'policy.md#L1',
    });
    expect((await read()).json().result.structuredContent.chunks[0].text).toBe('Verify invoices before payment.');
    expect((await search('bob|owner|')).json().result.structuredContent.hits).toEqual([]);
    expect((await read('bob|owner|')).json().result.isError).toBe(true);

    await service.togglePlugin(owner, 'local-file', false);
    expect((await search()).json().result.structuredContent.hits).toEqual([]);
    expect((await read()).json().result.isError).toBe(true);
  } finally {
    await app.close();
  }
});
