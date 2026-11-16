import { afterEach, expect, it, vi } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { managedSourcePlugins, parseSourceResources } from '../src/modules/knowledge/sources.js';

const actor: UserContext = { tenantId: 'mcp-source-test', userId: 'alice', roles: ['owner'], projectScopes: ['policy'] };
const endpoint = 'https://approved.example/mcp';
const resource = {
  id: 'policies', name: 'Policy library', pluginId: 'mcp', audience: ['alice'], projectIds: ['policy'],
  scope: { endpoint, secret: { name: 'mcp-read-token', version: 'v1' }, resources: [{ uri: 'policy://guide', title: 'Guide' }, { uri: 'policy://guide/att/handbook', title: 'Handbook' }] },
};
afterEach(() => vi.unstubAllGlobals());

it('imports only selected MCP text resources and gates their current version on confirmation', async () => {
  const readUris: string[] = [];
  let remoteText = 'Current onboarding checklist';
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
    expect(String(_url)).toBe(endpoint);
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-only-credential');
    if (init.method !== 'POST') return new Response(null, { status: 405 });
    const req = JSON.parse(String(init.body));
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (req.method === 'initialize') return Response.json({
      jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params.protocolVersion, serverInfo: { name: 'mock', version: '1' }, capabilities: { resources: {} } },
    });
    expect(req.method).toBe('resources/read');
    readUris.push(req.params.uri);
    return Response.json({ jsonrpc: '2.0', id: req.id, result: { contents: [{ uri: req.params.uri, text: remoteText }] } });
  }));

  const sourceResources = parseSourceResources(JSON.stringify([resource]));
  const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository(), sourceResources, plugins: managedSourcePlugins(sourceResources, { get: async () => 'test-only-credential' }) });
  expect((await service.overview(actor)).sourceResources[0]!.scope).toEqual({ mcpResourceCount: 2 });
  await service.installPlugin(actor, 'mcp');
  const input = { name: 'External policies', pluginId: 'mcp', scope: { resourceId: 'policies' }, readOnlyAcknowledged: true };
  await expect(service.createConnection({ ...actor, projectScopes: [] }, input)).rejects.toMatchObject({ code: 'source_denied' });
  await expect(service.createConnection(actor, { ...input, scope: { ...input.scope, endpoint: 'https://unapproved.example' } })).rejects.toMatchObject({ code: 'invalid_scope' });
  const connection = await service.createConnection(actor, input);
  await service.confirmConnection(actor, connection.id);
  const preview = await service.previewConnection(actor, connection.id);
  expect(readUris).toEqual([]);
  expect(await service.importSelection(actor, connection.id, { ids: [preview.items[0]!.id] })).toMatchObject({ applied: 1 });
  expect(readUris).toEqual(['policy://guide']);
  const first = (await service.overview(actor)).items[0]!;
  expect(first).toMatchObject({ title: 'Guide', confirmed: false });
  await service.confirm(actor, first.id, first.version);
  expect((await service.search(actor, 'onboarding')).hits).toHaveLength(1);

  remoteText = 'Updated onboarding instructions';
  await service.sync(actor, connection.id);
  expect((await service.overview(actor)).items[0]).toMatchObject({ confirmed: false });
  expect((await service.search(actor, 'onboarding')).hits).toEqual([]);
  const newResources = parseSourceResources(JSON.stringify([{ ...resource, scope: { ...resource.scope, resources: [resource.scope.resources[1]] } }]));
  const revised = new KnowledgeService({ ...service.deps, sourceResources: newResources });
  expect((await revised.overview(actor)).connections).toEqual([]);
});
