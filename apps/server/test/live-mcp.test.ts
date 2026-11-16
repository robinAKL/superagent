import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { LiveMcpKnowledge } from '../src/modules/knowledge/live-mcp.js';
import { MCP_CALLBACK } from '../src/modules/knowledge/mcp-oauth.js';
import { hash } from '../src/modules/knowledge/domain.js';
import { InMemorySecretStore } from '../src/modules/setup/secrets.js';
import { tickKnowledge } from '../src/modules/knowledge/worker.js';
import { GatewayAnalysisModel, type AnalysisGateway } from '../src/modules/analysis/gateway-model.js';
import type { Evidence } from '../src/modules/knowledge/domain.js';

const endpoint = 'https://data.example.com/api/mcp';
const issuer = 'https://authorization.example.com/tenant';
const host = 'superagent.example.com';
const origin = 'https://' + host;
const root = '/api/v1/knowledge';
const connection = root + '/connections/mcp/live/' + hash(endpoint);
const finishPath = root + '/connections/mcp/oauth/finish';
const schemas = { type: 'object', properties: {} };

it('keeps more than one public source and requires opt-in before executing a tool', async () => {
  const first = 'https://handbooks.example.net/mcp', second = 'https://reference.example.org/mcp';
  const network = vi.fn<typeof fetch>(async (input, init) => {
    expect([first, second]).toContain(String(input));
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const req = JSON.parse(String(init.body));
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = req.method === 'initialize'
      ? { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: new URL(String(input)).hostname, version: '1' } }
      : { tools: [{ name: 'lookup', inputSchema: schemas, annotations: { readOnlyHint: true } }] };
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  });
  const repo = new MemoryKnowledgeRepository();
  const live = new LiveMcpKnowledge(repo, new InMemorySecretStore(), network);
  const actor = { tenantId: 'test', userId: 'alice', roles: ['employee'] as const, projectScopes: [] };
  await live.connect({ ...actor, roles: [...actor.roles] }, { endpoint: first });
  const ctx = { ...actor, roles: [...actor.roles] };
  await live.connect(ctx, { endpoint: second, allowTools: true });
  const sources = live.list(await repo.read(ctx), ctx);
  expect(sources.map(({ endpoint }) => endpoint)).toEqual([first, second]);
  expect((await live.catalog(ctx, hash(first))).tools).toEqual([]);
  await expect(live.call(ctx, hash(first), 'lookup', {})).rejects.toMatchObject({ code: 'mcp_query_unavailable' });
  expect((await live.catalog(ctx, hash(second))).tools.map(tool => tool.name)).toEqual(['lookup']);
  const colleague = { ...ctx, userId: 'bob' };
  expect(live.list(await repo.read(colleague), colleague)).toEqual([]);
});

it('discovers fresh documents, templates and tools on different MCP servers during analysis', async () => {
  const handbook = 'https://policies.example.net/mcp';
  const reference = 'https://reference.example.org/mcp';
  const resourceUri = 'policy://travel/current';
  const templateUri = 'reference://guide/returns';
  const used: [string, string, string][] = [];
  const network: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const { id, method, params } = JSON.parse(String(init.body));
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result: unknown;
    switch (method) {
      case 'initialize': result = {
        protocolVersion: params.protocolVersion,
        serverInfo: { name: new URL(url).hostname, version: '1' },
        capabilities: url === handbook ? { resources: {} } : { resources: {}, tools: {} },
      }; break;
      case 'resources/list': result = { resources: url === handbook ? [{ uri: resourceUri, name: 'Travel policy' }] : [] }; break;
      case 'resources/templates/list': result = { resourceTemplates: url === reference ? [{ uriTemplate: 'reference://guide/{topic}', name: 'Guides by topic' }] : [] }; break;
      case 'tools/list': result = { tools: [
        { name: 'fetch_return_policy', inputSchema: schemas, annotations: { readOnlyHint: true } },
        { name: 'change_policy', inputSchema: schemas, annotations: { readOnlyHint: false } },
      ] }; break;
      case 'resources/read':
        used.push([url, method, params.uri]);
        result = { contents: [{ uri: params.uri, text: url === handbook ? 'Manager approval is required before booking.' : 'Log the return before issuing a refund.' }] };
        break;
      case 'tools/call':
        used.push([url, method, params.name]);
        result = { content: [{ type: 'text', text: 'Refunds must use the original payment method.' }] };
        break;
      default: throw new Error(method);
    }
    return Response.json({ jsonrpc: '2.0', id, result });
  };
  const repo = new MemoryKnowledgeRepository();
  const liveMcp = new LiveMcpKnowledge(repo, new InMemorySecretStore(), network);
  const chat = vi.fn<AnalysisGateway['chat']>(async (_tenant, _tier, req) => {
    const input = JSON.parse(req.messages[1]!.content);
    const result = input.catalog
      ? [{ source: 0, uri: templateUri }, { source: 0, name: 'fetch_return_policy', arguments: {} }]
      : [{ kind: 'sop', key: 'approvals', name: 'Approvals guide', description: 'Review approvals and refunds.', evidence: [1, 2, 3] }];
    if (input.catalog) {
      expect(input.catalog[0].tools.map((tool: {name: string}) => tool.name)).toEqual(['fetch_return_policy']);
      expect(input.catalog[0].resourceTemplates).toMatchObject([{ uriTemplate: 'reference://guide/{topic}' }]);
    }
    return { text: JSON.stringify(result), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' };
  });
  const gateway: AnalysisGateway = { check: async () => ({ ok: true, model: 'test' }), chat };
  const knowledgeDeps = { repo, liveMcp, mcpAnswerGateway: gateway, model: new GatewayAnalysisModel(gateway), enqueue: async () => {} };
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 'test' }, knowledgeDeps });
  const actor = { tenantId: 'test', userId: 'alice', roles: ['owner'] as ['owner'], projectScopes: [] };
  const send = (path: string, payload?: object, user = 'alice|owner|') => app.inject({
    method: payload ? 'POST' : 'GET', url: root + path, headers: { 'x-dev-user': user }, payload,
  });
  try {
    await liveMcp.connect(actor, { endpoint: handbook });
    await liveMcp.connect(actor, { endpoint: reference, allowTools: true });
    expect((await send('/overview')).json().items).toEqual([]);
    const selections = { mcpSourceIds: [hash(handbook), hash(reference)] };
    expect((await send('/analyses', selections, 'bob|owner|')).statusCode).toBe(409);
    const queued = await send('/analyses', selections);
    expect(queued.statusCode, queued.body).toBe(202);
    expect(used).toHaveLength(0);
    expect(await tickKnowledge(knowledgeDeps, 'test')).toBe(true);
    expect(used).toHaveLength(3);
    expect(used).toEqual(expect.arrayContaining([
      [handbook, 'resources/read', resourceUri],
      [reference, 'resources/read', templateUri],
      [reference, 'tools/call', 'fetch_return_policy'],
    ]));
    const result = (await send('/overview')).json();
    expect(result.analyses).toMatchObject([{ status: 'completed', mcpSources: ['policies.example.net', 'reference.example.org'] }]);
    expect(result.analyses[0]).not.toHaveProperty('mcpEvidence');
    expect(result.recommendations).toEqual([]);
    const draft = result.mcpRecommendations[0];
    expect(draft.evidence.map(({ quote }: Evidence) => quote)).toEqual([
      'Manager approval is required before booking.',
      'Log the return before issuing a refund.',
      'Refunds must use the original payment method.',
    ]);
    expect(draft.evidence[0]).toMatchObject({ locator: `policies.example.net / ${resourceUri}`, retrievedAt: expect.any(String) });
    expect((await send('/overview', undefined, 'bob|owner|')).json().mcpRecommendations).toEqual([]);
    expect((await send(`/recommendations/${draft.id}/delete`, {}, 'bob|owner|')).statusCode).toBe(404);
    expect((await send('/search?q=refund')).json().hits).toEqual([]);

    expect((await send('/analyses', selections)).statusCode).toBe(202);
    await liveMcp.disconnect(actor, hash(reference));
    await liveMcp.connect(actor, { endpoint: reference, allowTools: true });
    expect(await tickKnowledge(knowledgeDeps, 'test')).toBe(true);
    const afterReconnect = (await send('/overview')).json();
    expect(afterReconnect.analyses.at(-1)).toMatchObject({ status: 'stale', error: 'mcp_analysis_scope_changed' });
    expect(afterReconnect.mcpRecommendations).toEqual([]);
    expect(used).toHaveLength(3);
  } finally { await app.close(); }
});

it('preserves an existing CRM OAuth grant without advertising a default provider', async () => {
  const repo = new MemoryKnowledgeRepository(), secrets = new InMemorySecretStore();
  const live = new LiveMcpKnowledge(repo, secrets);
  const actor = { tenantId: 'test', userId: 'alice', roles: [] as [], projectScopes: [] };
  const secret = await secrets.put('legacy-oauth', JSON.stringify({ access: 'existing-token' }));
  await repo.transact(actor, state => {
    state.veraMcp[hash(actor.userId)] = { grant: { deadline: Date.now() + 100_000, clientId: 'original-client', secret } };
  });
  const [source] = live.list(await repo.read(actor), actor);
  expect(source).toMatchObject({ name: 'VERA CRM', authorization: 'oauth', allowTools: true });
  const colleague = { ...actor, userId: 'bob' };
  expect(live.list(await repo.read(colleague), colleague)).toEqual([]);
  await live.disconnect(actor, source!.id);
  expect(live.list(await repo.read(actor), actor)).toEqual([]);
  expect(secrets.isEnabled(secret)).toBe(false);
});

it('discovers OAuth on a different host and lets the Brain read knowledge under the same user’s grant', async () => {
  let challenge = '';
  let accessToken = 'short-lived-access';
  const scope = 'knowledge.read';
  const usedTools: string[] = [];
  let refreshes = 0;
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: endpoint, authorization_servers: [issuer] });
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({
      issuer, registration_endpoint: issuer + '/register', authorization_endpoint: issuer + '/authorize',
      token_endpoint: issuer + '/token', code_challenge_methods_supported: ['S256'],
      scopes_supported: [scope, 'knowledge.write'],
      response_types_supported: ['code'], authorization_response_iss_parameter_supported: true,
    });
    if (url.href === issuer + '/register') {
      expect(JSON.parse(String(init?.body))).toMatchObject({ redirect_uris: [origin + MCP_CALLBACK], scope, token_endpoint_auth_method: 'none' });
      return Response.json({ client_id: 'test-client' }, { status: 201 });
    }
    if (url.href === issuer + '/token') {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_id')).toBe('test-client');
      expect(body.get('resource')).toBe(endpoint);
      if (body.get('grant_type') === 'authorization_code') {
        expect(body.get('code')).toBe('test-code');
        expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(challenge);
        return Response.json({ access_token: accessToken, refresh_token: 'first-refresh', scope, expires_in: 15 });
      }
      expect(body.get('refresh_token')).toBe('first-refresh');
      refreshes++;
      accessToken = 'rotated-access';
      return Response.json({ access_token: accessToken, refresh_token: 'rotated-refresh', scope, expires_in: 900 });
    }
    expect(url.href).toBe(endpoint);
    const authorization = new Headers(init?.headers).get('authorization');
    if (!authorization) return new Response(null, { status: 401, headers: {
      'WWW-Authenticate': `Bearer resource_metadata="https://data.example.com/.well-known/oauth-protected-resource/api/mcp", scope="${scope}"`,
    } });
    expect(authorization).toBe('Bearer ' + accessToken);
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const req = JSON.parse(String(init.body));
    let result: unknown;
    switch (req.method) {
      case 'notifications/initialized': return new Response(null, { status: 202 });
      case 'initialize': result = {
        protocolVersion: req.params.protocolVersion, serverInfo: { name: 'VERA CRM', version: 'test' }, capabilities: { tools: {}, resources: {} },
      }; break;
      case 'resources/list': result = { resources: [{ uri: 'crm://reference/handbook', name: 'Handbook' }] }; break;
      case 'resources/templates/list': result = { resourceTemplates: [{ uriTemplate: 'crm://guide/{chapter}', name: 'Guide' }] }; break;
      case 'resources/read': result = { contents: [{ uri: req.params.uri, text: 'Verify receipt before recording a deposit.' }] }; break;
      case 'tools/list': result = {
        tools: [
          { name: 'get_crm_guide', inputSchema: schemas, annotations: { readOnlyHint: true } },
          { name: 'get_pricing_knowledge', inputSchema: schemas, annotations: { readOnlyHint: true } },
          { name: 'approve_order', inputSchema: schemas, annotations: { readOnlyHint: false } },
        ],
      }; break;
      case 'tools/call':
        usedTools.push(req.params.name);
        result = { content: [], structuredContent: { guide: 'Verify receipt before recording a deposit.' } };
        break;
      default: throw Error('Unexpected CRM request');
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  });
  const repo = new MemoryKnowledgeRepository();
  const liveMcp = new LiveMcpKnowledge(repo, new InMemorySecretStore(), network);
  const chat = vi.fn<AnalysisGateway['chat']>().mockResolvedValueOnce({ text: '[{"name":"get_crm_guide","arguments":{}}]', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' })
    .mockResolvedValueOnce({ text: 'Verify receipt first. [1]', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' });
  const gateway: AnalysisGateway = { check: async () => ({ ok: true, model: 'test' }), chat };
  const knowledgeDeps = { repo, liveMcp, mcpAnswerGateway: gateway, model: new GatewayAnalysisModel(gateway), enqueue: async () => {} };
  const app = await buildApp({
    auth: { mode: 'dev', platformTenantId: 'test' },
    knowledgeDeps,
  });
  const send = (path: string, payload?: object, user = 'alice|employee|') => app.inject({
    method: payload ? 'POST' : 'GET', url: path, headers: { 'x-dev-user': user, host, ...(path.endsWith('/connections/mcp') ? { origin } : {}) }, payload,
  });
  try {
    expect((await send(root + '/overview')).json().mcpConnections).toEqual([]);
    const start = await send(root + '/connections/mcp', { endpoint, allowTools: true });
    expect(start.statusCode, start.body).toBe(200);
    const authorization = new URL(start.json().authorizationUrl);
    expect(authorization.searchParams.get('scope')).toBe(scope);
    expect(authorization.searchParams.get('redirect_uri')).toBe(origin + MCP_CALLBACK);
    challenge = authorization.searchParams.get('code_challenge')!;
    const callbackData = { state: authorization.searchParams.get('state')!, code: 'test-code', iss: issuer, callbackPath: MCP_CALLBACK };
    const callback = await app.inject(MCP_CALLBACK + '?' + new URLSearchParams(callbackData));
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toContain('/#knowledge?mcp_state=');
    expect(callback.headers['cache-control']).toBe('no-store');
    expect((await send(finishPath, callbackData, 'bob|employee|')).statusCode).toBe(400);
    const finish = await send(finishPath, callbackData);
    expect(finish.statusCode, finish.body).toBe(200);
    expect(finish.json().id).toBe(hash(endpoint));
    expect((await send(finishPath, callbackData)).statusCode).toBe(400);
    expect((await send(connection + '/catalog', undefined, 'bob|employee|')).statusCode).toBe(404);

    const [guide, catalog] = await Promise.all([
      send(connection + '/read', { uri: 'crm://guide/deposit' }), send(connection + '/catalog'),
    ]);
    expect(guide.statusCode, guide.body).toBe(200);
    expect(guide.json().contents[0].text).toContain('Verify receipt');
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(refreshes).toBe(1);
    expect((await send(connection + '/read', { uri: 'crm://other/private' })).statusCode).toBe(404);
    expect((await send(connection + '/query', { name: 'approve_order', arguments: {} })).statusCode).toBe(403);

    const ask = await send(connection + '/ask', { question: 'How do I record a deposit?' });
    expect(ask.statusCode, ask.body).toBe(200);
    expect(ask.json()).toMatchObject({ answer: 'Verify receipt first. [1]', sources: [{ number: 1, locator: 'get_crm_guide' }] });
    expect(chat.mock.calls[1]?.[2].messages[1].content).toContain('Verify receipt before recording a deposit');
    expect(usedTools).toEqual(['get_crm_guide']);
    const mcp = await send(root + '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(mcp.json().result.tools).toContainEqual(expect.objectContaining({ name: 'read_mcp_knowledge' }));

    const state = JSON.stringify(await repo.read({ tenantId: 'test', userId: 'alice', roles: ['employee'], projectScopes: [] }));
    for (const value of ['rotated-access', 'rotated-refresh', 'first-refresh', 'Verify receipt']) expect(state).not.toContain(value);

    chat.mockImplementation(async (_tenant, _tier, req) => {
      const input = JSON.parse(req.messages[1]!.content);
      expect(input.focus).toBe('Deposit procedure');
      const result = input.catalog
        ? [{ source: 0, name: 'get_crm_guide', arguments: {} }]
        : [{ kind: 'sop', key: 'deposit', name: 'Record a deposit', description: 'Verify the receipt first.', evidence: [1] }];
      return { text: JSON.stringify(result), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end' };
    });
    const analysis = await send(root + '/analyses', { mcpSourceIds: [hash(endpoint)], focus: 'Deposit procedure' }, 'alice|owner|');
    expect(analysis.statusCode, analysis.body).toBe(202);
    expect(await tickKnowledge(knowledgeDeps, 'test')).toBe(true);
    const overview = (await send(root + '/overview', undefined, 'alice|owner|')).json();
    expect(overview.analyses[0]).toMatchObject({ status: 'completed' });
    expect(overview.mcpRecommendations[0].evidence[0]).toMatchObject({
      locator: 'VERA CRM / get_crm_guide', quote: expect.stringContaining('Verify receipt before recording a deposit.'),
    });
    expect(usedTools).toEqual(['get_crm_guide', 'get_crm_guide']);

    await app.inject({ method: 'DELETE', url: connection, headers: { 'x-dev-user': 'alice|employee|' } });
    expect((await send(connection + '/catalog')).statusCode).toBe(404);
  } finally { await app.close(); }
});
