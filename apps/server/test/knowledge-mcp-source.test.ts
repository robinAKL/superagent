import { afterEach, expect, it, vi } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { managedSourcePlugins, parseSourceResources } from '../src/modules/knowledge/sources.js';
import { createPublicMcp } from '../src/modules/knowledge/plugins/mcp-resources.js';
import { isPublicMcpAddress, publicMcpEndpoint, publicMcpFetch } from '../src/modules/knowledge/plugins/mcp-public-http.js';

const actor: UserContext = { tenantId: 'mcp-source-test', userId: 'alice', roles: ['owner'], projectScopes: ['policy'] };
const endpoint = 'https://approved.example/mcp';
vi.mock('node:dns', async original => ({
  ...await original<typeof import('node:dns')>(),
  lookup: (_host: string, _options: unknown, callback: (error: Error | null, addresses: { address: string; family: number }[]) => void) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  },
}));
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

it('validates a public MCP URL, discovers resources, and connects before explicit selection', async () => {
  const readUris: string[] = [];
  const network = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(endpoint);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const req = JSON.parse(String(init.body));
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown;
    if (req.method === 'initialize') result = { protocolVersion: req.params.protocolVersion, serverInfo: { name: 'Public policies', version: '1' }, capabilities: { resources: {} } };
    else if (req.method === 'resources/list') result = req.params?.cursor
      ? { resources: [{ uri: 'policy://handbook', name: 'Handbook' }] }
      : { resources: [{ uri: 'policy://guide', name: 'Guide' }], nextCursor: 'next' };
    else {
      expect(req.method).toBe('resources/read');
      readUris.push(req.params.uri);
      result = { contents: [{ uri: req.params.uri, text: 'Public travel policy' }] };
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  });
  const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository(), publicMcp: createPublicMcp(network) });
  await expect(service.connectPublicMcp(actor, { endpoint: 'https://[::ffff:7f00:1]/mcp' })).rejects.toMatchObject({ code: 'mcp_invalid_url' });
  await expect(service.connectPublicMcp({ ...actor, roles: [] }, { endpoint })).rejects.toMatchObject({ statusCode: 403 });
  expect(network).not.toHaveBeenCalled();

  const connection = await service.connectPublicMcp(actor, { endpoint });
  expect(connection).toMatchObject({ status: 'confirmed', name: 'Public policies' });
  expect(readUris).toEqual([]);
  expect((await service.overview({ ...actor, userId: 'bob' })).connections).toEqual([]);
  const preview = await service.previewConnection(actor, connection.id);
  expect(preview.items.map(item => item.title)).toEqual(['Guide', 'Handbook']);
  await service.importSelection(actor, connection.id, { ids: [preview.items[1]!.id] });
  expect(readUris).toEqual(['policy://handbook']);
  const saved = (await service.overview(actor)).items[0]!;
  expect(saved.profile).toMatchObject({ origin: 'rules' });
  await service.confirm(actor, saved.id, saved.version);
  expect((await service.search(actor, 'travel')).hits).toHaveLength(1);
  expect(await service.connectPublicMcp(actor, { endpoint })).toMatchObject({ id: connection.id });
  expect((await service.previewConnection(actor, connection.id)).items[1]!.selected).toBe(true);
});

it('leaves no connection when a public MCP endpoint requires authorization', async () => {
  const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository(), publicMcp: createPublicMcp(async () => new Response(null, { status: 401 })) });
  await expect(service.connectPublicMcp(actor, { endpoint })).rejects.toMatchObject({ code: 'mcp_auth_required' });
  expect((await service.overview(actor)).connections).toEqual([]);
});

it('reports a missing MCP route when the initialization request returns 404', async () => {
  const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository(), publicMcp: createPublicMcp(async () => Response.json({ detail: 'Not Found' }, { status: 404 })) });
  await expect(service.connectPublicMcp(actor, { endpoint })).rejects.toMatchObject({ code: 'mcp_endpoint_not_found' });
  expect((await service.overview(actor)).connections).toEqual([]);
});

it('rejects local, reserved, encoded and infrastructure destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '168.63.129.16', '100.64.0.1', '::ffff:a00:1', 'fd00::1', '2001:db8::1']) {
    expect(isPublicMcpAddress(address)).toBe(false);
  }
  for (const url of ['https://2130706433/mcp', 'https://[::ffff:7f00:1]/mcp', 'https://localhost/mcp', 'http://example.com/mcp', 'https://user:pass@example.com/mcp', 'https://example.com/mcp?token=secret']) {
    expect(() => publicMcpEndpoint(url)).toThrow();
  }
  expect(isPublicMcpAddress('8.8.8.8')).toBe(true);
});

it('refuses an otherwise public-looking host if its connection-time DNS points at localhost', async () => {
  await expect(publicMcpFetch(endpoint)).rejects.toMatchObject({
    cause: expect.objectContaining({ message: 'MCP DNS must resolve to public addresses.' }),
  });
});
